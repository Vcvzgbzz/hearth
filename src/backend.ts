/**
 * Tracks what the local backend has loaded and what it could load.
 *
 * llama-swap serves /api/events as SSE and pushes a `modelStatus` payload on
 * every state change, plus a full snapshot when you connect. Better than
 * polling: no interval to be stale inside, no round trip on the hot path.
 *
 * Push is only safe here, though, and nowhere else in this codebase. This is a
 * process on the same box, usually over loopback, so a dead connection shows up
 * immediately and reconnecting is free. Doing the same across a peer link would
 * be a mistake, since a half-open connection there looks exactly like a quiet
 * one. Peers get polled. See peers.ts for why.
 *
 * We don't fully trust silence either: no events for STALE_MS and we go back to
 * polling /running, so a stream that's open but no longer delivering can't pin
 * our picture of the world forever.
 */
import type { WarmSource } from "./config.js";
import type { Logger } from "./log.js";
import { known, statsFromProps, type ModelStats } from "./stats.js";
import { getJson, send } from "./upstream.js";

/** llama-swap only counts a model as loaded once it's ready to serve. */
const READY = "ready";

/** How long we'll trust a quiet stream before going and asking. */
const STALE_MS = 60_000;

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface ModelStatus {
  id: string;
  state: string;
  unlisted?: boolean;
}

export class BackendState {
  private loadedIds: string[] = [];
  private catalogIds: string[] = [];
  /** False for `kind: none`, where an empty warm set means "we cannot see",
   *  not "nothing is warm". Callers must not turn one into the other. */
  private warmIsKnown = true;
  private lastUpdateAt = 0;
  /**
   * Last time anything was successfully READ from this backend.
   *
   * Deliberately NOT lastUpdateAt. That one is stamped at the END of refresh()
   * whatever happened, including when both requests failed — which is right for
   * its job (it means "we asked recently, do not ask again"), and useless as a
   * health signal: an unreachable backend keeps reporting itself fresh. Two
   * identically-dead backends were drawing differently on the status page
   * because of it, depending on which had been re-polled.
   *
   * Status surfaces only. Nothing schedules off this.
   */
  private lastOkAt = 0;
  private streaming = false;
  private stopped = false;
  private attempt = 0;
  private abort: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Per-wire-id model stats, learned from the backend once a model is loaded.
   *
   * None of it changes while the backend process lives, so the cache persists
   * across an unload. It is dropped the moment the model is seen loaded AGAIN
   * (setLoaded), because the operator may have relaunched the seat with a
   * different -c in between, and a stale window here is the exact thing this
   * cache exists to prevent. Unknown is an absent entry, not an empty object:
   * learnContext retries a model it has learned nothing about.
   */
  private statsCache = new Map<string, ModelStats>();
  /**
   * The cache key for a wire id.
   *
   * A `single` backend is one llama-server pinned to one file: its /props
   * describes whatever it loaded, whatever id the caller asks under. Those ids
   * rarely match — a bare llama-server reports the gguf PATH as its model id
   * while `serves` advertises `guard` — so keying by wire id filed the stats
   * under a name nothing would ever look up, and every sidecar reported an
   * unknown window forever. One backend, one answer, one key.
   */
  private key(wire: string): string {
    return this.kind === "single" ? "" : wire;
  }
  /** Per-wire in-flight learnContext, so concurrent callers dedupe. */
  private contextInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly url: string,
    private readonly kind: WarmSource,
    private readonly log: Logger,
  ) {
    this.useEvents = kind === "llama-swap";
    this.warmIsKnown = kind !== "none";
  }

  private useEvents: boolean;

  /**
   * Drop whatever is loaded, so someone else can have the hardware.
   *
   * Only llama-swap can be asked: it is the one that both holds a model
   * resident on our behalf and offers a way to say stop. Ollama expires on its
   * own keep_alive and `single` has nothing to unload by definition, so for
   * those this is honestly a no-op rather than a pretend one.
   *
   * Never throws. The caller is trying to free a card before using it, and a
   * backend that is already down — the common case, since down is exactly when
   * nothing is loaded — has given us what we wanted. Failing the job over it
   * would turn a successful outcome into an error.
   */
  async unload(): Promise<void> {
    if (this.kind !== "llama-swap") return;
    try {
      const res = await send(`${this.url}/unload`, { method: "POST", headersTimeoutMs: 30_000 });
      res.body.resume();
      // Warm state is now stale in a way the event stream may take a moment to
      // tell us. Say so ourselves rather than scoring the next job against a
      // model we just evicted.
      this.loadedIds = [];
      this.lastUpdateAt = Date.now();
    } catch (e) {
      this.log.warn("backend.unload_failed", {
        url: this.url,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Can this backend tell us what is loaded at all? */
  knowsWarm(): boolean {
    return this.warmIsKnown;
  }

  /**
   * Is this model warm here?
   *
   * A predicate rather than a single "resident" name, because ollama keeps a
   * SET of models resident under keep_alive and serves them together. Asking
   * "which one model is loaded" has no answer there, and the first of the set
   * would collect a warm bonus the others deserve just as much.
   */
  isWarm(model: string): boolean {
    return this.loadedIds.includes(model);
  }

  /** Ready to serve right now, no load tax. */
  loaded(): string[] {
    return [...this.loadedIds];
  }

  /** Everything it could serve, loaded or not. */
  catalog(): string[] {
    return [...this.catalogIds];
  }

  /** First loaded model, for the warm bonus. null just means we don't know, and
   *  the bonus quietly doesn't apply. */
  resident(): string | null {
    return this.loadedIds[0] ?? null;
  }

  /** Are we on the push path or polling? Diagnostic only. Freshness decides
   *  whether we re-ask, not transport. */
  streamingNow(): boolean {
    return this.streaming;
  }

  /**
   * The context window for a model we have learned about, or null if unknown.
   *
   * Read-only; learnContext fills the cache. A null is not a failure — it
   * means the model has not been loaded yet, and we never probe a cold model.
   */
  contextLength(wire: string): number | null {
    return this.statsFor(wire)?.context ?? null;
  }

  /** Everything we have learned about a loaded model, or null if nothing.
   *  Same contract as contextLength: absent means unasked, not unlimited. */
  statsFor(wire: string): ModelStats | null {
    return this.statsCache.get(this.key(wire)) ?? null;
  }

  /**
   * The one way loadedIds changes.
   *
   * A wire id that was not loaded a moment ago and is now has just been (re)
   * loaded, and whatever window we knew for it may describe a previous launch
   * of the seat. Forget it; the caller's learnContext pass fetches it fresh.
   * Anything still loaded keeps its number, and an unload keeps it too.
   */
  private setLoaded(next: string[]): void {
    for (const wire of next) {
      if (!this.loadedIds.includes(wire)) this.statsCache.delete(this.key(wire));
    }
    this.loadedIds = next;
  }

  /**
   * Learn the context window for a loaded model, once.
   *
   * For llama-swap this may only be called for a wire id that is actually in
   * loaded(): /upstream/<id>/props loads the model to answer, which would swap
   * the GPU out from under someone else. The caller — refresh() — guarantees
   * that by only passing loaded ids. For single and ollama there is no such
   * cost: single always has its one model loaded, and ollama's /api/show does
   * not load anything.
   *
   * Deduped per wire so a burst of /v1/models does not flood the backend.
   * Fire-and-forget: /v1/models never blocks waiting for this, so the first
   * models list after a load may not yet carry context_length. Never throws.
   */
  async learnContext(wire: string): Promise<void> {
    if (this.statsCache.has(this.key(wire))) return;
    const existing = this.contextInFlight.get(wire);
    if (existing) { await existing; return; }
    const p = this.fetchStats(wire).then(() => {
      this.contextInFlight.delete(wire);
    }).catch(() => {
      this.contextInFlight.delete(wire);
    });
    this.contextInFlight.set(wire, p);
    return p;
  }

  private async fetchStats(wire: string): Promise<void> {
    try {
      let stats: ModelStats = {};
      if (this.kind === "llama-swap") {
        if (!this.loadedIds.includes(wire)) return;
        stats = statsFromProps(await getJson<unknown>(
          `${this.url}/upstream/${encodeURIComponent(wire)}/props`,
          { headersTimeoutMs: 2_000, totalTimeoutMs: 2_000 },
        ));
      } else if (this.kind === "single") {
        stats = statsFromProps(await getJson<unknown>(
          `${this.url}/props`,
          { headersTimeoutMs: 2_000, totalTimeoutMs: 2_000 },
        ));
      } else if (this.kind === "ollama") {
        const n = await this.ollamaContext(wire);
        if (n !== null) stats = { context: n };
      }
      // Only when something came back. An empty object cached here would mean
      // "asked and got nothing", which is indistinguishable from "asked and got
      // an answer with no fields" — and would stop us ever asking again.
      if (known(stats)) {
        this.statsCache.set(this.key(wire), stats);
      }
    } catch (e) {
      this.log.debug("backend.context_learn_failed", {
        wire,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async ollamaContext(wire: string): Promise<number | null> {
    // /api/show does not load the model, so it is safe to ask for any id.
    const show = await send(`${this.url}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      json: { name: wire },
      headersTimeoutMs: 2_000,
    });
    const text = await show.text();
    if (!show.ok) {
      throw new Error(`ollama /api/show returned ${show.status}: ${text.slice(0, 200)}`);
    }
    let parsed: { model_info?: Record<string, unknown>; parameters?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`ollama /api/show did not return JSON: ${text.slice(0, 200)}`);
    }
    // Look for a key ending in .context_length (e.g. "qwen3.context_length").
    let maxCtx: number | null = null;
    if (parsed.model_info) {
      for (const k of Object.keys(parsed.model_info)) {
        if (k.endsWith(".context_length")) {
          const v = parsed.model_info[k];
          if (typeof v === "number") { maxCtx = v; break; }
        }
      }
    }
    if (!maxCtx) return null;
    // A `num_ctx` in parameters overrides the model's maximum.
    if (parsed.parameters) {
      const m = /num_ctx\s+(\d+)/.exec(parsed.parameters);
      if (m) {
        const n = parseInt(m[1]!, 10);
        if (n > 0 && n <= maxCtx) return n;
      }
    }
    return maxCtx;
  }

  /** Recent enough to act on? */
  fresh(): boolean {
    return this.lastUpdateAt > 0 && Date.now() - this.lastUpdateAt <= STALE_MS;
  }

  private apply(models: ModelStatus[]): void {
    this.catalogIds = models.map((m) => m.id);
    this.setLoaded(models.filter((m) => m.state === READY).map((m) => m.id));
    this.lastUpdateAt = Date.now();
    this.lastOkAt = this.lastUpdateAt;
  }

  /**
   * Just ask. Used for backends with no event stream, and as the safety net when
   * a stream goes quiet.
   *
   * Two calls, because they answer different questions. /running tells you
   * what's loaded and nothing about what could be; /v1/models gives the catalog
   * and is served by anything OpenAI-shaped. So the catalog half still works
   * against a backend with no concept of a loaded model.
   */
  async refresh(): Promise<void> {
    // The catalogue always comes from /v1/models, which anything OpenAI-shaped
    // serves. Warm state depends on who we are talking to, so that half is
    // asked differently per kind, or not at all.
    const [warm, catalog] = await Promise.allSettled([
      this.readWarm(),
      getJson<{ data?: { id?: string }[] }>(`${this.url}/v1/models`, {
        headersTimeoutMs: 3_000,
      }),
    ]);

    if (catalog.status === "fulfilled") {
      this.catalogIds = (catalog.value.data ?? [])
        .map((m) => m.id ?? "")
        .filter((m) => m !== "");
    }

    if (this.kind === "single") {
      // One always-resident model, so whatever it lists is by definition warm.
      // Reading the catalogue is the only question worth asking such a server.
      this.setLoaded([...this.catalogIds]);
    } else if (warm.status === "fulfilled") {
      this.setLoaded(warm.value);
    } else {
      // Missing warm endpoint isn't an error, it just means we never know
      // anything is warm, so the bonus never fires and readyNow stays empty.
      this.loadedIds = [];
    }

    this.lastUpdateAt = Date.now();
    // Only if something actually came back. Both halves rejecting means the
    // backend told us nothing, and stamping that as a reading is how a box that
    // has been down for an hour reads as idle.
    if (catalog.status === "fulfilled" || warm.status === "fulfilled") {
      this.lastOkAt = this.lastUpdateAt;
    }
    // Learn the context window for anything that just became loaded.
    // Fire-and-forget: /v1/models does not wait for this, so the first models
    // list after a load may not yet carry context_length — the next one does.
    for (const wire of this.loadedIds) {
      void this.learnContext(wire);
    }
  }

  /**
   * Has anything come back from this backend lately?
   *
   * For the status page, and only meaningful where knowsWarm() is true: a
   * `kind: none` backend is never read at all, so silence from one says
   * nothing. Not a health check — hearth does not probe backends it is not
   * using — but "we have not heard from this in a minute" is a fact, and it is
   * the difference between a backend that is idle and one that is gone.
   */
  answering(): boolean {
    return this.lastOkAt > 0 && Date.now() - this.lastOkAt <= STALE_MS;
  }

  /** Whatever this kind of backend calls "what is loaded right now". */
  private async readWarm(): Promise<string[]> {
    if (this.kind === "ollama") {
      // Ollama's /api/ps is the direct equivalent of llama-swap's /running. It
      // returns a SET: several models resident at once, each with its own
      // keep_alive TTL, all servable together. No eviction, so no thrash.
      const ps = await getJson<{ models?: { model?: string; name?: string }[] }>(
        `${this.url}/api/ps`,
        { headersTimeoutMs: 3_000 },
      );
      return (ps.models ?? [])
        .map((m) => m.model ?? m.name ?? "")
        .filter((m) => m !== "");
    }
    if (this.kind === "llama-swap") {
      const running = await getJson<{ running?: { model?: string; state?: string }[] }>(
        `${this.url}/running`,
        { headersTimeoutMs: 3_000 },
      );
      return (running.running ?? [])
        .filter((m) => (m.state ?? READY) === READY)
        .map((m) => m.model ?? "")
        .filter((m) => m !== "");
    }
    // "single" is answered from the catalogue above; "none" has no answer.
    return [];
  }

  /** Refresh only if we have to. This is what the hot path calls. */
  async ensureFresh(): Promise<void> {
    // Just fresh(), not `streaming && fresh()`. `streaming` is only true on the
    // SSE path, so a polled backend never hit the cache and paid two extra
    // round trips before every single generation.
    if (this.fresh()) return;
    // Dedupe, or a burst of cold requests each kicks off its own refresh.
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async consume(): Promise<void> {
    const ctrl = new AbortController();
    this.abort = ctrl;
    const res = await send(`${this.url}/api/events`, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
      // Deadline on the handshake only. The stream is supposed to go quiet for
      // long stretches.
      headersTimeoutMs: 10_000,
    });
    if (res.status === 404 || res.status === 501) {
      // Not an outage, just a backend with no event stream. ollama, vLLM and a
      // bare llama-server all answer like this, and events default to on, so
      // retrying meant a warning every 30s forever. Give up on events, say so
      // once, poll from here on.
      this.useEvents = false;
      this.log.info("backend.events_unsupported", {
        url: this.url,
        status: res.status,
        detail: "backend has no /api/events; using /running and /v1/models instead",
      });
      await this.refresh();
      return;
    }
    if (!res.ok) throw new Error(`events returned ${res.status}`);

    this.streaming = true;
    this.attempt = 0;
    this.log.info("backend.events_connected", { url: this.url });

    let buffer = "";
    // TextDecoder with {stream:true}, because String(chunk) mangles a multi-byte
    // character that lands across a chunk boundary.
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      // Normalise CRLF. The SSE spec allows it, and splitting on "\n\n" alone
      // parses nothing while the buffer grows forever.
      buffer += decoder.decode(chunk as Uint8Array, { stream: true }).replace(/\r\n/g, "\n");
      // Frames are blank-line delimited. Hang on to the trailing partial.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        // Data lines get joined with newlines. It's not just the first one.
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data === "") continue;
        try {
          const env = JSON.parse(data) as { type?: string; data?: string };
          if (env.type !== "modelStatus" || typeof env.data !== "string") continue;
          // `data` is itself a JSON string, not an object. Double-encoded, yes.
          this.apply(JSON.parse(env.data) as ModelStatus[]);
          // A model just became loaded (or the snapshot arrived). Learn the
          // context window for anything loaded; learnContext dedupes and is
          // safe to call repeatedly. Only loaded models for llama-swap: its
          // /props endpoint loads the model to answer, so we never ask for a
          // cold one (see learnContext docs).
          for (const wire of this.loadedIds) {
            void this.learnContext(wire);
          }
        } catch {
          // One bad frame isn't worth dropping the connection over.
        }
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.consume();
      } catch (e) {
        if (this.stopped) return;
        this.log.warn("backend.events_lost", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      this.streaming = false;
      if (this.stopped || !this.useEvents) return;
      const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
      this.attempt++;
      // Held and unref'd. stop() used to leave this armed, so close() resolved
      // and then the process sat there for up to another 30s.
      await new Promise<void>((r) => {
        this.backoffTimer = setTimeout(r, wait);
        this.backoffTimer.unref?.();
      });
    }
  }

  start(): void {
    if (!this.useEvents) {
      void this.refresh();
      return;
    }
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
    this.abort?.abort();
  }
}
