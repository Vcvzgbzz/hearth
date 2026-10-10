/**
 * Tracks what the local backend has loaded and could load: llama-swap's /api/events SSE where
 * available (safe on a local link, never across peers), falling back to polling /running
 * when the stream goes quiet for STALE_MS.
 */
import type { ActivityDecl } from "./config.js";
import { KINDS, readingFromStatus, type Kind, type KindName, type ModelStatus, type Placement } from "./kinds.js";
import type { Logger } from "./log.js";
import { known, type ModelStats } from "./stats.js";
import { getJson, send } from "./upstream.js";

/** How often an activity path is read, and its timeout; sampled while a page is open, or always for a backend with a `hold`. */
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

/**
 * How long an app may go unread and still count as up, for a `hold`: longer than the status
 * staleness above, so a slow answer in the middle of a job does not hand its card away.
 */
const HOLD_GAP_MS = 30_000;

/** How long we'll trust a quiet stream before going and asking. */
const STALE_MS = 60_000;

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export class BackendState {
  private loadedIds: string[] = [];
  private loadingIds: string[] = [];
  private readonly loadEndedAt = new Map<string, number>();
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
  /** The first event-stream attempt has settled, so silence before it is not yet evidence. */
  private probed = false;
  private stopped = false;
  private attempt = 0;
  private abort: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  /** Model stats learned once loaded, per wire id; dropped when the model is seen loaded again. */
  private statsCache = new Map<string, ModelStats>();
  /** The stats key: a `single` backend has one answer whatever id it is asked under. */
  private key(wire: string): string {
    return this.k.single ? "" : wire;
  }
  /** Per-wire in-flight learnContext, so concurrent callers dedupe. */
  private contextInFlight = new Map<string, Promise<void>>();

  /** The last activity reading that came back; null until the first. */
  private activityReading: { running: number; queued: number | null; at: number } | null = null;
  private activityAt = 0;
  private activityInFlight: Promise<void> | null = null;
  /** When the app last answered its activity path, when it last had work, and when it began answering. */
  private seenAt = 0;
  private busyAt = 0;
  private upAt = 0;

  private readonly k: Kind;

  constructor(
    private readonly url: string,
    kind: KindName,
    private readonly log: Logger,
    /**
     * Which of the ids this URL reports are this backend's. Two backends on one URL split
     * what it serves, so a sidecar pinned beside a swapping model is nobody's resident but its own.
     */
    private readonly mine: (id: string) => boolean = () => true,
  ) {
    this.k = KINDS[kind];
    this.useEvents = this.k.events;
    this.warmIsKnown = this.k.knowsWarm;
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
          const queued = decl.queued ? countField(body, decl.queued) : null;
          const now = Date.now();
          this.activityReading = { running, queued, at: now };
          // Only work counts as use: an idle app answering again, or for the first time, says nothing of who wants it.
          if (running > 0 || (queued ?? 0) > 0) this.busyAt = now;
          if (now - this.seenAt > HOLD_GAP_MS) this.upAt = now;
          this.seenAt = now;
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

  /** Is the app up, and was it in use within `idleMs`? False once it stops answering for HOLD_GAP_MS. */
  holding(idleMs: number): boolean {
    const now = Date.now();
    return this.seenAt > 0 && now - this.seenAt <= HOLD_GAP_MS && now - this.busyAt < idleMs;
  }

  /** How long the app has reported nothing to do, counted from when it began answering if it has had no work since; null when it is not answering. */
  quietMs(): number | null {
    const now = Date.now();
    return this.seenAt > 0 && now - this.seenAt <= HOLD_GAP_MS ? now - Math.max(this.busyAt, this.upAt) : null;
  }

  private useEvents: boolean;

  /** Can this kind clear the card for a neighbour? */
  canUnload(): boolean {
    return this.k.unload !== undefined;
  }

  /**
   * Clear the card for another backend; a no-op for a kind that cannot. A down backend is a
   * no-op; a refusal throws so the job does not load on top.
   */
  async unload(): Promise<void> {
    if (!this.k.unload || !(await this.k.unload(this.url, this.log))) return;
    // The event stream may take a moment to say so; scoring the next job against an evicted model is worse.
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

  /** True where we hold an event stream, the only place silence from a backend means anything; never before the first attempt settles. */
  watched(): boolean {
    return this.useEvents && (this.streaming || this.probed);
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
      const stats = await this.k.stats(this.url, wire, this.loadedIds);
      // Only when something came back: a cached {} would read as "asked and got nothing" and never re-ask.
      if (known(stats)) this.statsCache.set(this.key(wire), stats);
    } catch (e) {
      this.log.debug("backend.context_learn_failed", {
        wire,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Recent enough to act on? */
  fresh(): boolean {
    return this.lastUpdateAt > 0 && Date.now() - this.lastUpdateAt <= STALE_MS;
  }

  private apply(models: ModelStatus[]): void {
    const r = readingFromStatus(models.filter((m) => this.mine(m.id)));
    this.catalogIds = r.catalog;
    this.setLoading(r.loading);
    this.setLoaded(r.loaded);
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
    const catalogRead = getJson<{ data?: { id?: string }[] }>(`${this.url}/v1/models`, {
      headersTimeoutMs: 3_000,
    }).then((c) => (c.data ?? []).map((m) => m.id ?? "").filter((m) => m !== ""));
    // A kind may answer warm state from the catalogue, so it is handed the fresh one when it arrives.
    const [catalog, warm] = await Promise.allSettled([
      catalogRead,
      catalogRead.catch(() => this.catalogIds).then((ids) => this.k.readWarm(this.url, ids)),
    ]);

    if (catalog.status === "fulfilled") this.catalogIds = catalog.value.filter((m) => this.mine(m));

    if (warm.status === "fulfilled" && warm.value !== null) {
      this.setLoaded(warm.value.loaded.filter((m) => this.mine(m)));
      this.setLoading(warm.value.loading.filter((m) => this.mine(m)));
      if (warm.value.placements) this.placements = warm.value.placements;
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
    if (!this.k.placement) return;
    const key = [...this.loadedIds].sort().join("\u0000");
    if (key === this.placementFor) return;
    this.placementFor = key;
    if (this.loadedIds.length === 0) {
      this.placements.clear();
      return;
    }
    try {
      this.placements = await this.k.placement(this.url);
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

  private setLoading(ids: string[]): void {
    const now = Date.now();
    for (const id of this.loadingIds) if (!ids.includes(id)) this.loadEndedAt.set(id, now);
    this.loadingIds = ids;
  }

  /** How long since `id` was last seen loading: 0 while it is, Infinity if it never was. */
  sinceLoading(id: string): number {
    if (this.loadingIds.includes(id)) return 0;
    return Date.now() - (this.loadEndedAt.get(id) ?? -Infinity);
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
      this.probed = true;
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
