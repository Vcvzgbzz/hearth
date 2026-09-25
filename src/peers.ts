/**
 * Peer health and capacity. Health is polled, never inferred from an open socket; unknown,
 * stale and unreachable all mean unavailable; a peer is down after two failed polls.
 */
import type { HearthConfig, PeerConfig } from "./config.js";
import { Controls } from "./controls.js";
import type { Logger } from "./log.js";
import { cleanStats, type ModelStats } from "./stats.js";
import { UpstreamError, getJson } from "./upstream.js";

/**
 * A peer's refusal, with its status kept: callers retry a 5xx and must not retry a 4xx, so a
 * peer's 429 reported as 502 turns a rate limit into a retry storm.
 */
export class PeerStatusError extends Error {
  constructor(
    readonly peer: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`peer ${peer} returned ${status}: ${detail}`);
    this.name = "PeerStatusError";
  }

  /** True when the peer refused the REQUEST rather than failing to serve it.
   *  Passed through to our caller unchanged: a refusal is theirs to explain,
   *  and re-badging it as our failure loses what the caller should do next. */
  get isRefusal(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/** What a peer reports on /peer/state: its capacity, what it has loaded and what it serves. */
export interface PeerCapacity {
  slots: number;
  free: number;
  running: number;
  offbox: number;
  queued: Record<string, number>;
  resident: string | null;
  /** Ready to serve right now, in their ids. */
  loaded?: string[];
  /** Everything they offer, in their ids. */
  serves?: string[];
  /** Protocol 2: capacity per shared model, in their ids. Absent from a protocol-1 peer. */
  models?: Record<string, {
    slots: number; free: number; queued: number; warm: boolean;
    /** What that model can take. Absent from a peer that has never loaded it,
     *  or one that predates this field — both mean "no claim", never "no
     *  limit". See unfit(). */
    stats?: ModelStats;
  }>;
}

/** What routing needs to score one model. Per-model where the peer offers it,
 *  node-level where it does not. */
export interface PeerModelLoad {
  slots: number;
  free: number;
  queued: number;
  warm: boolean;
}

export interface PeerStatus {
  name: string;
  url: string;
  up: boolean;
  /** null until a poll succeeds. */
  capacity: PeerCapacity | null;
  lastOkAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Set when a peer rate-limits us. We stop polling until it passes. */
  backoffUntil: number | null;
  /** When the last probe failed, for negative caching. */
  lastFailAt: number | null;
}

/** A capacity check nobody answers promptly is a peer to route around, not wait
 *  for. Nothing to do with generation, which gets no deadline at all. */
const POLL_HEADERS_TIMEOUT_MS = 5_000;
/** Tighter, for probes someone is actually waiting on. One slow peer shouldn't
 *  hold up the answer about all the others. */
const PROBE_HEADERS_TIMEOUT_MS = 1_500;
const STRIKES_BEFORE_DOWN = 2;

/** How long to leave a peer alone after it rate-limits our polling. */
const RATE_CAP_BACKOFF_MS = 5 * 60_000;

export class PeerRegistry {
  private readonly status = new Map<string, PeerStatus>();
  private readonly byName = new Map<string, PeerConfig>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Advertised capabilities per peer, from /peer/hello. */
  private readonly caps = new Map<string, Set<string>>();

  constructor(
    private readonly cfg: HearthConfig,
    private readonly log: Logger,
    /** Defaulted so every existing caller and test keeps working: a registry
     *  built without controls behaves exactly as it always did, both directions
     *  on. */
    private readonly controls: Controls = new Controls(),
  ) {
    for (const p of cfg.peers) {
      this.byName.set(p.name, p);
      this.status.set(p.name, {
        name: p.name,
        url: p.url,
        up: false,
        capacity: null,
        lastOkAt: null,
        lastError: null,
        consecutiveFailures: 0,
        backoffUntil: null,
        lastFailAt: null,
      });
    }
  }

  config(name: string): PeerConfig | undefined {
    return this.byName.get(name);
  }

  all(): PeerStatus[] {
    return [...this.status.values()].map((s) => ({ ...s, up: this.isUp(s.name) }));
  }

  get(name: string): PeerStatus | undefined {
    const s = this.status.get(name);
    return s ? { ...s, up: this.isUp(name) } : undefined;
  }

  /** Usable right now? Staleness is checked here too, so a wedged poller cannot leave a peer up. */
  isUp(name: string): boolean {
    const s = this.status.get(name);
    if (!s || !s.up || s.lastOkAt === null) return false;
    return Date.now() - s.lastOkAt <= this.cfg.peerStaleMs;
  }

  /** What one model would cost on a peer: its per-model reading, else the node-level one. */
  loadFor(peer: string, theirModel: string): PeerModelLoad | null {
    const cap = this.status.get(peer)?.capacity;
    if (!cap) return null;
    const per = cap.models?.[theirModel];
    if (per) return per;
    return {
      slots: cap.slots,
      free: cap.free,
      queued: Object.values(cap.queued).reduce((a, b) => a + b, 0),
      warm: (cap.loaded ?? []).includes(theirModel),
    };
  }

  /** What a peer says one of its models can take, or null; only per-model readings answer this. */
  statsFor(peer: string, theirModel: string): ModelStats | null {
    return this.status.get(peer)?.capacity?.models?.[theirModel]?.stats ?? null;
  }

  /** Their id for one of our models, if they've agreed to serve it. */
  theirModelId(peer: string, model: string): string | undefined {
    return this.byName.get(peer)?.models[model];
  }

  /** Peers that are up and map this model, in preference order. */
  candidates(model: string, preferred: string[]): string[] {
    // Borrowing paused: no candidates, and every policy path already handles that.
    if (!this.controls.borrowingOn) return [];
    const order = preferred.length > 0 ? preferred : [...this.byName.keys()];
    return order.filter((n) => this.theirModelId(n, model) !== undefined && this.isUp(n));
  }

  async pollOnce(name: string, timeoutMs = POLL_HEADERS_TIMEOUT_MS): Promise<void> {
    const peer = this.byName.get(name);
    const s = this.status.get(name);
    if (!peer || !s) return;
    // Respected even for on-demand probes. Asking again inside a back-off is
    // exactly what caused the lockout to begin with.
    if (s.backoffUntil !== null && Date.now() < s.backoffUntil) return;

    try {
      const cap = await getJson<PeerCapacity>(`${peer.url}/peer/state`, {
        headers: { Authorization: `Bearer ${peer.token}` },
        headersTimeoutMs: timeoutMs,
      });
      // An answer we do not recognise is unknown, which means unavailable.
      if (
        typeof cap?.free !== "number" ||
        typeof cap?.slots !== "number" ||
        typeof cap?.queued !== "object" ||
        cap.queued === null
      ) {
        throw new UpstreamError(`peer ${name} answered /peer/state with something that is not capacity`);
      }
      // Everything else is coerced on ingest; anything unrecognisable becomes empty.
      const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      cap.serves = strings(cap.serves);
      cap.loaded = strings(cap.loaded);
      if (typeof cap.models !== "object" || cap.models === null || Array.isArray(cap.models)) {
        cap.models = undefined;
      } else {
        // Same reasoning as the coercion above, one level down. A `context`
        // arriving as a string would be compared against a number and silently
        // decide where somebody's prompt runs.
        for (const entry of Object.values(cap.models)) {
          if (entry && typeof entry === "object") entry.stats = cleanStats(entry.stats);
        }
      }

      const was = s.up;
      s.capacity = cap;
      if (!was) void this.helloOnce(name);
      s.lastOkAt = Date.now();
      s.lastError = null;
      s.consecutiveFailures = 0;
      s.backoffUntil = null;
      s.lastFailAt = null;
      s.up = true;
      if (!was) this.log.info("peer.up", { peer: name });
    } catch (e) {
      s.consecutiveFailures++;
      s.lastFailAt = Date.now();
      s.lastError = e instanceof Error ? e.message : String(e);

      if (e instanceof UpstreamError && e.status === 429) {
        // Their control plane refusing us says nothing about whether they could
        // serve a request. But we can't see their state either way, and unknown
        // means unavailable. Mark them down, stop asking for a bit.
        s.backoffUntil = Date.now() + RATE_CAP_BACKOFF_MS;
        s.up = false;
        this.log.warn("peer.rate_capped", {
          peer: name,
          backoffSec: RATE_CAP_BACKOFF_MS / 1000,
          hint: "their peerRateLimit is lower than our poll rate; raise it or raise peerPollMs",
        });
        return;
      }

      if (s.up && s.consecutiveFailures >= STRIKES_BEFORE_DOWN) {
        s.up = false;
        this.log.warn("peer.down", { peer: name, error: s.lastError });
      }
    }
  }

  /** The background floor. Goes through `probe` so it can't stack a second
   *  request on one already in flight. */
  async pollAll(): Promise<void> {
    await Promise.all([...this.byName.keys()].map((n) => this.probe(n)));
  }

  /**
   * Make every peer's reading fresh enough to route on, probing only where needed: a good
   * reading is reused for peerFreshMs, a failure for peerDownMs, and concurrent callers share
   * one probe per peer.
   */
  async ensureFresh(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      [...this.byName.keys()].map((name) => {
        const s = this.status.get(name);
        if (!s) return undefined;
        if (s.backoffUntil !== null && now < s.backoffUntil) return undefined;
        if (s.lastOkAt !== null && now - s.lastOkAt <= this.cfg.peerFreshMs) return undefined;
        if (s.lastFailAt !== null && now - s.lastFailAt <= this.cfg.peerDownMs) return undefined;
        return this.probe(name);
      }),
    );
  }

  /** One probe per peer at a time. Late callers join the one in flight. */
  private probe(name: string): Promise<void> {
    const existing = this.inFlight.get(name);
    if (existing) return existing;
    const p = this.pollOnce(name, PROBE_HEADERS_TIMEOUT_MS).finally(() => {
      this.inFlight.delete(name);
    });
    this.inFlight.set(name, p);
    return p;
  }

  /** Probe every peer now, in parallel, with a short deadline. */
  async probeAll(): Promise<void> {
    await Promise.all([...this.byName.keys()].map((n) => this.probe(n)));
  }

  /** Does this peer advertise a capability? False until a hello has landed. */
  supports(name: string, cap: string): boolean {
    return this.caps.get(name)?.has(cap) === true;
  }

  /** Handshake at startup; mainly checks that the models we map are ones they offer. */
  async helloOnce(name: string): Promise<void> {
    const peer = this.byName.get(name);
    if (!peer) return;
    try {
      const hi = await getJson<{
        name?: string; protocol?: number; models?: string[]; capabilities?: string[];
      }>(
        `${peer.url}/peer/hello`,
        {
          headers: { Authorization: `Bearer ${peer.token}` },
          headersTimeoutMs: POLL_HEADERS_TIMEOUT_MS,
        },
      );
      const offered = new Set(hi.models ?? []);
      const dangling = Object.entries(peer.models)
        .filter(([, theirs]) => !offered.has(theirs))
        .map(([mine, theirs]) => `${mine} -> ${theirs}`);
      if (dangling.length > 0) {
        this.log.warn("peer.mapping_drift", {
          peer: name,
          dangling,
          theyOffer: [...offered],
          hint: "these mappings point at models the peer does not share; requests using them will fail",
        });
      }
      // 1 and 2 both work: 2 adds per-model capacity and keeps the aggregate,
      // so the pair degrades to node-level scoring without anyone failing.
      if (hi.protocol !== undefined && hi.protocol !== 1 && hi.protocol !== 2) {
        this.log.warn("peer.protocol", { peer: name, theirs: hi.protocol, ours: 2 });
      }
      // Capabilities are asked for, never inferred from how a missing route fails.
      this.caps.set(name, new Set(hi.capabilities ?? []));
    } catch {
      // Not fatal. A peer that's down at startup gets checked again when it next
      // comes up, and routing won't touch it before then anyway.
    }
  }

  start(): void {
    if (this.timer || this.byName.size === 0) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.cfg.peerPollMs);
    // Don't hold the process open just for a poll loop.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
