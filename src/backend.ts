/**
 * Tracks what the local backend has loaded and could load: llama-swap's /api/events SSE where
 * available (safe on a local link, never across peers), falling back to polling /running
 * when the stream goes quiet for STALE_MS.
 */
import type { ActivityDecl, WarmSource } from "./config.js";
import type { Logger } from "./log.js";
import { known, statsFromModels, statsFromProps, type ModelStats } from "./stats.js";
import { getJson, send } from "./upstream.js";

/** llama-swap only counts a model as loaded once it's ready to serve. */
const READY = "ready";

/** How often an activity path is read, and its timeout; sampled only while a page is open. */
const ACTIVITY_POLL_MS = 2_000;
const ACTIVITY_TIMEOUT_MS = 2_000;

/** How old the last good activity reading may be before it reports "cannot tell"; one failed read is absorbed. */
const ACTIVITY_STALE_MS = 3 * ACTIVITY_POLL_MS;

/** A declared field as a count (array length or number), else null; dotted paths never throw. */
function countField(body: unknown, field: string): number | null {
  const v = field.split(".").reduce<unknown>(
    (cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined),
    body,
  );
  if (Array.isArray(v)) return v.length;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** llama-swap's state for a model loading off the disk. */
const STARTING = "starting";

/** How long we'll trust a quiet stream before going and asking. */
const STALE_MS = 60_000;

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface ModelStatus {
  id: string;
  state: string;
  unlisted?: boolean;
}

/**
 * Where a resident model's weights were assigned when not all fit on the card, read off its
 * launch command (nothing else reports it). Says "on the host", not whether RAM or disk serves them.
 */
export interface Placement {
  /** Layers whose experts are computed on the CPU, from `--n-cpu-moe`. */
  cpuLayers: number | null;
  /** Every layer of MoE experts, from `--cpu-moe` with no number. */
  cpuExpertsAll: boolean;
  /** The whole model runs on the CPU: `-ngl 0`, and no card is involved. */
  cpuOnly: boolean;
}

/** Placement from a llama-server command line: only `--n-cpu-moe N`, `--cpu-moe` and `-ngl 0`, which stand alone. */
export function parsePlacement(cmd: string): Placement | null {
  const flag = (...names: string[]): string | null => {
    for (const n of names) {
      const m = new RegExp(`(?:^|\\s)${n}(?:[=\\s]+)(\\S+)`).exec(cmd);
      if (m) return m[1]!;
    }
    return null;
  };
  const has = (...names: string[]): boolean =>
    names.some((n) => new RegExp(`(?:^|\\s)${n}(?:\\s|$)`).test(cmd));

  const moe = flag("--n-cpu-moe", "-ncmoe");
  const cpuLayers = moe !== null && /^\d+$/.test(moe) ? Number(moe) : null;
  const cpuExpertsAll = has("--cpu-moe");
  const ngl = flag("--n-gpu-layers", "-ngl");
  const cpuOnly = ngl === "0";

  if (cpuLayers === null && !cpuExpertsAll && !cpuOnly) return null;
  return { cpuLayers, cpuExpertsAll, cpuOnly };
}

export class BackendState {
  private loadedIds: string[] = [];
  private loadingIds: string[] = [];
  private placements = new Map<string, Placement>();
  private placementFor: string = "";
  private catalogIds: string[] = [];
  /** False for `kind: none`, where an empty warm set means "we cannot see",
   *  not "nothing is warm". Callers must not turn one into the other. */
  private warmIsKnown = true;
  private lastUpdateAt = 0;
  /** Last successful read from this backend, for status surfaces; unlike lastUpdateAt, failures do not stamp it. */
  private lastOkAt = 0;
  private streaming = false;
  private stopped = false;
  private attempt = 0;
  private abort: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  /** Model stats learned once loaded, per wire id; dropped when the model is seen loaded again. */
  private statsCache = new Map<string, ModelStats>();
  /** The stats key: a `single` backend has one answer whatever id it is asked under. */
  private key(wire: string): string {
    return this.kind === "single" ? "" : wire;
  }
  /** Per-wire in-flight learnContext, so concurrent callers dedupe. */
  private contextInFlight = new Map<string, Promise<void>>();

  /** The last activity reading that came back; null until the first. */
  private activityReading: { running: number; queued: number | null; at: number } | null = null;
  private activityAt = 0;
  private activityInFlight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly kind: WarmSource,
    private readonly log: Logger,
  ) {
    this.useEvents = kind === "llama-swap";
    this.warmIsKnown = kind !== "none";
  }

  /** Read the backend's own busy signal off its declared path, only while a page is open; rate-limited and deduped. */
  sampleActivity(decl: ActivityDecl): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.activityInFlight) return this.activityInFlight;
    if (Date.now() - this.activityAt < ACTIVITY_POLL_MS) return Promise.resolve();
    const done = (async () => {
      try {
        const body = await getJson<unknown>(`${this.url}${decl.path}`, {
          totalTimeoutMs: ACTIVITY_TIMEOUT_MS,
        });
        const running = countField(body, decl.running);
        // A missing running field is the operator's field name being wrong, or
        // the app changing shape — not zero, and not a reading. Leave the last
        // good one to age out, exactly as a failed read does.
        if (running !== null) {
          this.activityReading = {
            running,
            queued: decl.queued ? countField(body, decl.queued) : null,
            at: Date.now(),
          };
        }
      } catch {
        // Unreachable, timed out, or not JSON: cannot tell, never idle. The last
        // good reading stands until ACTIVITY_STALE_MS retires it.
      } finally {
        // Stamped when the read settles, so a hung backend is not polled back-to-back.
        this.activityAt = Date.now();
        this.activityInFlight = null;
      }
    })();
    this.activityInFlight = done;
    return done;
  }

  /** The last activity reading, or "cannot tell" if none yet or it is stale. */
  activity(): { running: number; queued?: number; ok: boolean } {
    const a = this.activityReading;
    if (!a || Date.now() - a.at > ACTIVITY_STALE_MS) return { running: 0, ok: false };
    return a.queued === null
      ? { running: a.running, ok: true }
      : { running: a.running, queued: a.queued, ok: true };
  }

  private useEvents: boolean;

  /**
   * Unload whatever llama-swap holds so another backend can have the hardware; a no-op for
   * other kinds. A down backend is a no-op; a refusal throws so the job does not load on top.
   */
  async unload(): Promise<void> {
    if (this.kind !== "llama-swap") return;
    const url = `${this.url}/api/models/unload`;
    let res;
    try {
      res = await send(url, { method: "POST", headersTimeoutMs: 30_000 });
    } catch (e) {
      this.log.warn("backend.unload_failed", {
        url,
        detail: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    res.body.resume();
    if (!res.ok) {
      this.log.warn("backend.unload_refused", { url, status: res.status });
      throw new Error(`${url} answered ${res.status}: the card was not cleared`);
    }
    // Warm state is now stale in a way the event stream may take a moment to
    // tell us. Say so ourselves rather than scoring the next job against a
    // model we just evicted.
    this.loadedIds = [];
    this.lastUpdateAt = Date.now();
  }

  /** Can this backend tell us what is loaded at all? */
  knowsWarm(): boolean {
    return this.warmIsKnown;
  }

  /** Is this model warm here? A predicate, since ollama keeps a set resident. */
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

  /** True where we hold an event stream, the only place silence from a backend means anything. */
  watched(): boolean {
    return this.useEvents;
  }

  /** The learned context window for a model, or null if not loaded yet. */
  contextLength(wire: string): number | null {
    return this.statsFor(wire)?.context ?? null;
  }

  /** Everything we have learned about a loaded model, or null if nothing.
   *  Same contract as contextLength: absent means unasked, not unlimited. */
  statsFor(wire: string): ModelStats | null {
    return this.statsCache.get(this.key(wire)) ?? null;
  }

  /** Update loadedIds; a newly loaded model forgets its old stats, which may describe a previous launch. */
  private setLoaded(next: string[]): void {
    for (const wire of next) {
      if (!this.loadedIds.includes(wire)) this.statsCache.delete(this.key(wire));
    }
    this.loadedIds = next;
  }

  /**
   * Learn a loaded model's stats once, deduped per wire. For llama-swap only loaded ids are
   * asked, since probing a cold model loads it. Never throws.
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
      if (this.kind === "llama-swap" || this.kind === "single") {
        if (this.kind === "llama-swap" && !this.loadedIds.includes(wire)) return;
        const base = this.kind === "llama-swap" ? `${this.url}/upstream/${encodeURIComponent(wire)}` : this.url;
        const opts = { headersTimeoutMs: 2_000, totalTimeoutMs: 2_000 };
        // llama-server answers /props; vLLM has none and reports max_model_len on /v1/models.
        stats = await getJson<unknown>(`${base}/props`, opts).then(statsFromProps, () => ({}));
        if (!known(stats)) stats = statsFromModels(await getJson<unknown>(`${base}/v1/models`, opts));
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
    this.loadingIds = models.filter((m) => m.state === STARTING).map((m) => m.id);
    this.setLoaded(models.filter((m) => m.state === READY).map((m) => m.id));
    // Placement is fetched from /running when the resident set changes, never on a timer.
    void this.learnPlacement();
    this.lastUpdateAt = Date.now();
    this.lastOkAt = this.lastUpdateAt;
  }

  /** Poll: /running for what is loaded and /v1/models for the catalog. */
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

  /** Has anything come back lately? An open event stream counts. For the status page, not a health check. */
  answering(): boolean {
    if (this.streaming) return true;
    return this.lastOkAt > 0 && Date.now() - this.lastOkAt <= STALE_MS;
  }

  /** Placement per resident model, only where its command line says something; empty means nothing to say. */
  placement(): Map<string, Placement> {
    return new Map(this.placements);
  }

  /** Read resident models' launch commands from /running, once per change in the resident set. */
  private async learnPlacement(): Promise<void> {
    if (this.kind !== "llama-swap") return;
    const key = [...this.loadedIds].sort().join("\u0000");
    if (key === this.placementFor) return;
    this.placementFor = key;
    if (this.loadedIds.length === 0) {
      this.placements.clear();
      return;
    }
    try {
      const running = await getJson<{ running?: { model?: string; cmd?: string }[] }>(
        `${this.url}/running`,
        { headersTimeoutMs: 3_000 },
      );
      const next = new Map<string, Placement>();
      for (const r of running.running ?? []) {
        if (!r.model || !r.cmd) continue;
        const p = parsePlacement(r.cmd);
        if (p) next.set(r.model, p);
      }
      this.placements = next;
    } catch {
      // Placement is a nicety. Failing to read it must not disturb warm state,
      // which is what this backend is actually for.
      this.placementFor = "";
    }
  }

  /** Models loading off the disk now; empty also where the backend cannot tell. */
  loading(): string[] {
    return [...this.loadingIds];
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
      const running = await getJson<{ running?: { model?: string; state?: string; cmd?: string }[] }>(
        `${this.url}/running`,
        { headersTimeoutMs: 3_000 },
      );
      // The poll already has the payload the SSE path has to go and ask for,
      // so it reads placement straight out of it.
      const next = new Map<string, Placement>();
      for (const r of running.running ?? []) {
        const p = r.model && r.cmd ? parsePlacement(r.cmd) : null;
        if (p && r.model) next.set(r.model, p);
      }
      this.placements = next;
      // The poll is the fallback for a backend with no event stream, and it
      // reports the same states — so it must learn the same thing, or a load
      // would be visible on one transport and invisible on the other.
      this.loadingIds = (running.running ?? [])
        .filter((m) => m.state === STARTING)
        .map((m) => m.model ?? "")
        .filter((m) => m !== "");
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
      // No event stream here (ollama, vLLM, bare llama-server): say so once and poll.
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
          // Learn stats for loaded models only; probing a cold one would load it.
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
