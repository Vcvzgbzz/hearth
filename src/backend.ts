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
  private streaming = false;
  private stopped = false;
  private attempt = 0;
  private abort: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly kind: WarmSource,
    private readonly log: Logger,
  ) {
    this.useEvents = kind === "llama-swap";
    this.warmIsKnown = kind !== "none";
  }

  private useEvents: boolean;

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

  /** Recent enough to act on? */
  fresh(): boolean {
    return this.lastUpdateAt > 0 && Date.now() - this.lastUpdateAt <= STALE_MS;
  }

  private apply(models: ModelStatus[]): void {
    this.catalogIds = models.map((m) => m.id);
    this.loadedIds = models.filter((m) => m.state === READY).map((m) => m.id);
    this.lastUpdateAt = Date.now();
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
      this.loadedIds = [...this.catalogIds];
    } else if (warm.status === "fulfilled") {
      this.loadedIds = warm.value;
    } else {
      // Missing warm endpoint isn't an error, it just means we never know
      // anything is warm, so the bonus never fires and readyNow stays empty.
      this.loadedIds = [];
    }

    this.lastUpdateAt = Date.now();
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
