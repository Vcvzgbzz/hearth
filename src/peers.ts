/**
 * Peer health and capacity.
 *
 * Two rules, both learned the expensive way.
 *
 * First: poll. Never infer health from an open socket. A TCP forwarder happily
 * keeps listening after the far end dies and just closes each connection, which
 * looks perfectly healthy to anything that only checks whether it can connect.
 * Ask a question, require an answer.
 *
 * Second: fail closed. Unknown, stale and unreachable all mean unavailable. The
 * cheap mistake is running something locally that could have gone to a peer.
 * The expensive one is handing work to a box that can't take it.
 *
 * Two strikes before we call a peer down, so one dropped packet or a restart on
 * their side doesn't bounce every job home and back again.
 */
import type { HearthConfig, PeerConfig } from "./config.js";
import { Controls } from "./controls.js";
import type { Logger } from "./log.js";
import { cleanStats, type ModelStats } from "./stats.js";
import { UpstreamError, getJson } from "./upstream.js";

/** What a peer says about itself: Scheduler.capacity(), plus what it has loaded
 *  and what it'll serve. All of it rides on /peer/state so one probe answers
 *  both "can you take work" and "what's warm over there". That leaves
 *  /peer/hello as a pure handshake, nothing the hot path needs. */
/**
 * A peer answered, and answered with a refusal.
 *
 * Carries the status rather than folding it into a message, because the STATUS
 * CLASS is the part a caller acts on and a 4xx and a 5xx call for opposite
 * behaviour. Flattening both to 502 is not a cosmetic loss:
 *
 * A borrowing client retries 5xx on purpose — that is how a turn survives a
 * model swap — and does not retry 4xx. Report a peer's 429 as a 502 and every
 * client politely backing off instead turns a rate limit into a retry storm
 * aimed at someone else's GPU. Observed exactly that on 2026-08-15: three
 * subagents hit a peer's batch-lane cap, and the 502 mapping turned three
 * rejections into six requests.
 *
 * Same lesson the warm route already learned about QueueFullError, one path
 * over. If a third path ever forwards to a peer, it uses this too.
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
  /**
   * Protocol 2: capacity per shared model, in their ids.
   *
   * The fields above describe a whole node, which was a complete answer only
   * while a node meant one backend and one queue. A node fronting several
   * backends has several independent queues, and "is the node busy" stops
   * predicting whether YOUR model can start — the embedder can be idle while
   * the GPU is four deep.
   *
   * Absent from a protocol-1 peer, in which case the aggregate is all there is
   * and routing falls back to it. Both are sent, so an old borrower keeps
   * working against a new host.
   */
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

/**
 * How long to leave a peer alone after it tells us we're asking too often.
 *
 * Without this the poller just carries on at its usual rate, burning a budget
 * it already exhausted and getting refused every time. The lockout then feeds
 * itself for as long as both sides stay up. Backing off is what lets their
 * hourly window actually drain.
 */
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

  /**
   * Usable right now?
   *
   * Staleness gets checked here and not just in the poller, so a wedged poll
   * loop can't leave a peer looking healthy forever.
   */
  isUp(name: string): boolean {
    const s = this.status.get(name);
    if (!s || !s.up || s.lastOkAt === null) return false;
    return Date.now() - s.lastOkAt <= this.cfg.peerStaleMs;
  }

  /**
   * What one model would cost on a peer, in their terms.
   *
   * Prefers the protocol-2 per-model reading and falls back to the node-level
   * one, so an old peer is scored exactly as it was before rather than being
   * dropped for speaking the old protocol.
   */
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

  /**
   * What a peer says one of their models can take, or null if they have not
   * said.
   *
   * Only the per-model reading answers this: the node-level fallback describes
   * a whole box and there is no such thing as a box's context window. A
   * protocol-1 peer therefore reports nothing here, which is correct — we know
   * nothing about their limits and must not invent any.
   */
  statsFor(peer: string, theirModel: string): ModelStats | null {
    return this.status.get(peer)?.capacity?.models?.[theirModel]?.stats ?? null;
  }

  /** Their id for one of our models, if they've agreed to serve it. */
  theirModelId(peer: string, model: string): string | undefined {
    return this.byName.get(peer)?.models[model];
  }

  /** Peers that are up and map this model, in preference order. */
  candidates(model: string, preferred: string[]): string[] {
    // Borrowing paused: nobody is a candidate. Done here rather than in decide()
    // because every policy path already handles an empty candidate list —
    // including honouring fallbackLocal, which is the case that matters and the
    // one a new branch would most likely get wrong.
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
      // Any 2xx JSON used to be enough to mark a peer up. A port typo pointing
      // at some other service then left routing reading fields that weren't
      // there, and `fastest` 502'd the end user on Object.values(undefined).
      // An answer we don't recognise is unknown, and unknown means unavailable.
      // Throwing puts it through the normal strikes path.
      if (
        typeof cap?.free !== "number" ||
        typeof cap?.slots !== "number" ||
        typeof cap?.queued !== "object" ||
        cap.queued === null
      ) {
        throw new UpstreamError(`peer ${name} answered /peer/state with something that is not capacity`);
      }
      // Past the three fields above, everything else a peer sends is taken on
      // trust and used as the type it claims to be. `serves` arriving as a
      // string meant `theirServes.map is not a function` inside networkView,
      // which is a 500 on /network AND /ui/data for as long as that peer is up
      // — one peer taking out the whole status page.
      //
      // Coerced on ingest rather than guarded at each use: there are several
      // uses, they are in different files, and the next one added would not
      // know to guard. Anything unrecognisable becomes empty, which is what an
      // answer we cannot read should mean.
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
   * Make sure every peer's reading is current enough to route on, asking only
   * where it isn't.
   *
   * This is the real mechanism now, and the timer is just a floor under it.
   * Routing is the only thing that consumes peer state, and something needed
   * only when asked should be fetched when asked. A timer spends requests
   * whether or not anyone's using it, and still hands the decision a reading up
   * to a whole interval old.
   *
   * Three guards stop this being worse than the timer it replaced:
   *
   *   fresh    a good reading inside peerFreshMs gets reused as-is
   *   failed   a bad one is remembered for peerDownMs, so an outage doesn't
   *            make every local request pay the probe timeout
   *   single   concurrent callers join one in-flight probe per peer, so cost
   *            tracks the window and not traffic. Without it an agent loop at
   *            50 requests a minute blows the control-plane budget and gets
   *            itself rate-limited out.
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

  /**
   * Ask everyone right now, in parallel, and don't wait long.
   *
   * For questions someone is sitting there waiting on. A cache can't go stale if
   * you don't use one, and the cost is a single round trip, which over an
   * overlay network is tens of milliseconds.
   */
  async probeAll(): Promise<void> {
    await Promise.all([...this.byName.keys()].map((n) => this.probe(n)));
  }

  /**
   * Identity handshake, once, at startup.
   *
   * There's really only one reason to call this: checking that the models you
   * mapped are ones they actually offer. A mapping that points at nothing is a
   * typo, and otherwise it surfaces as a 404 from someone else's machine at
   * whatever hour it first gets used.
   */
  /** Does this peer advertise a capability? False until a hello has landed,
   *  which is the safe answer: we would rather not offer a feature than send a
   *  request that fails in a way we have to guess about. */
  supports(name: string, cap: string): boolean {
    return this.caps.get(name)?.has(cap) === true;
  }

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
      // What this peer can do beyond serving chat. Absent on an older node,
      // which is the whole point: capability is ASKED FOR, not inferred from
      // how a missing route happens to fail. In the field an older peer answers
      // 401 rather than 404 — the unknown path falls through to a passthrough
      // that only trusts local callers — so a status-code heuristic would have
      // read "no such feature" as "bad credentials".
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
