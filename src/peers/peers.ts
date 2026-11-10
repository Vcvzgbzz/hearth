/**
 * Peer health and capacity. Health is polled, never inferred from an open socket; unknown,
 * stale and unreachable all mean unavailable; a peer is down after two failed polls.
 */
import type { HearthConfig } from "../config/config.js";
import { peersMapping, type PeerConfig } from "../config/peers.js";
import { Controls } from "./controls.js";
import type { Logger } from "../observe/log.js";
import { cleanStats } from "../routing/stats.js";
import type { ModelStats } from "../config/models.js";
import { UpstreamError, getJson } from "../wire/upstream.js";

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
    /** What they hold us to on that model, and how much of today we have used. Absent from a peer that predates it. */
    terms?: LentTerms;
  }>;
}

/** One model's limits as the lender states them to the borrower; 0 tokens a day is no limit. */
export interface LentTerms { tokensPerDay: number; maxConcurrent: number; rateLimit: number; usedToday: number }

/** Their terms if every field is a sane number, else none: half a claim would be shown as if it were whole. */
function cleanTerms(v: unknown): LentTerms | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const keys = ["tokensPerDay", "maxConcurrent", "rateLimit", "usedToday"] as const;
  if (!keys.every((k) => typeof r[k] === "number" && Number.isFinite(r[k]) && (r[k] as number) >= 0)) return undefined;
  return Object.fromEntries(keys.map((k) => [k, r[k]])) as unknown as LentTerms;
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
/** How long to stop sending a peer one model after it rate-limits a request for it, when it gives no Retry-After. */
const REQUEST_CAP_BACKOFF_MS = 60_000;
/** Bounds on a peer's Retry-After, so a missing or absurd value can neither hammer it nor lock it out for good. */
const RETRY_AFTER_MIN_MS = 5_000;
const RETRY_AFTER_MAX_MS = 10 * 60_000;

/** Everything known about one peer at one address. Replaced whole when its url or token changes. */
interface PeerEntry {
  cfg: PeerConfig;
  status: PeerStatus;
  /** When the reading in `status.capacity` was asked for. */
  readAt: number;
  /** When it last answered one of our requests. */
  servedAt: number;
  /** Their model id -> until when requests for it stay home: it rate-limited one. */
  capped: Map<string, number>;
  /** Our requests to it still open, with when they were sent. */
  open: Set<{ theirModel: string; at: number }>;
  /** Advertised capabilities, from /peer/hello; empty until one lands. */
  caps: Set<string>;
  /** The probe in flight, which late callers join. */
  inFlight: Promise<void> | null;
}

export class PeerRegistry {
  /** One entry per peer, so forgetting a peer or its old address is a single delete. */
  private readonly peers = new Map<string, PeerEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly cfg: HearthConfig,
    private readonly log: Logger,
    /** Defaulted so every existing caller and test keeps working: a registry
     *  built without controls behaves exactly as it always did, both directions
     *  on. */
    private readonly controls: Controls = new Controls(),
  ) {
    for (const p of cfg.peers) this.track(p);
  }

  /** Start a peer from nothing: down, unread, until a probe says otherwise. */
  private track(p: PeerConfig): void {
    this.peers.set(p.name, {
      cfg: p,
      status: {
        name: p.name,
        url: p.url,
        up: false,
        capacity: null,
        lastOkAt: null,
        lastError: null,
        consecutiveFailures: 0,
        backoffUntil: null,
        lastFailAt: null,
      },
      readAt: 0,
      servedAt: 0,
      capped: new Map(),
      open: new Set(),
      caps: new Set(),
      inFlight: null,
    });
  }

  /**
   * Match `cfg.peers` after a live edit. A new peer starts down and is probed; a removed one is
   * forgotten, its requests in flight left to finish; one whose url or token changed starts over,
   * since nothing read from the old address says anything about the new one. Model maps alone
   * keep the peer's state.
   */
  sync(): void {
    const next = new Map(this.cfg.peers.map((p) => [p.name, p]));
    for (const name of [...this.peers.keys()]) if (!next.has(name)) this.peers.delete(name);
    for (const [name, p] of next) {
      const was = this.peers.get(name);
      if (was && was.cfg.url === p.url && was.cfg.token === p.token) {
        was.cfg = p;
        continue;
      }
      // A fresh entry: a probe still out to the old address lands on the old one and is ignored.
      this.track(p);
      if (this.started) void this.probe(name);
    }
    // Only a node that had no peers to poll has no timer yet; one already polling picks the edit up as it goes.
    if (this.started && this.timer === null) this.start();
  }

  config(name: string): PeerConfig | undefined {
    return this.peers.get(name)?.cfg;
  }

  all(): PeerStatus[] {
    return [...this.peers.values()].map((e) => ({ ...e.status, up: this.isUp(e.status.name) }));
  }

  get(name: string): PeerStatus | undefined {
    const s = this.peers.get(name)?.status;
    return s ? { ...s, up: this.isUp(name) } : undefined;
  }

  /** Usable right now? Staleness is checked here too, so a wedged poller cannot leave a peer up.
   *  An answer to one of our requests is as recent a sign of life as a reading. */
  isUp(name: string): boolean {
    const e = this.peers.get(name);
    if (!e || !e.status.up || e.status.lastOkAt === null) return false;
    const last = Math.max(e.status.lastOkAt, e.servedAt);
    return Date.now() - last <= this.cfg.peerStaleMs;
  }

  /** A request is on its way to a peer; call what this returns once it is over. Until the
   *  next reading, loadFor counts it, so a burst between readings does not all land on one peer. */
  sent(name: string, theirModel: string): () => void {
    const open = this.peers.get(name)?.open;
    if (!open) return () => {};
    const entry = { theirModel, at: Date.now() };
    open.add(entry);
    return () => void open.delete(entry);
  }

  /** A peer answered one of our requests: it is up, whatever its last poll said. */
  served(name: string): void {
    const e = this.peers.get(name);
    if (!e) return;
    e.servedAt = Date.now();
    e.status.consecutiveFailures = 0;
  }

  /** What one model would cost on a peer: its per-model reading, else the node-level one,
   *  with our requests sent since that reading added on. */
  loadFor(peer: string, theirModel: string): PeerModelLoad | null {
    const e = this.peers.get(peer);
    const cap = e?.status.capacity;
    if (!e || !cap) return null;
    const per = cap.models?.[theirModel];
    const load = per ?? {
      slots: cap.slots,
      free: cap.free,
      queued: Object.values(cap.queued).reduce((a, b) => a + b, 0),
      warm: (cap.loaded ?? []).includes(theirModel),
    };
    let unseen = 0;
    for (const r of e.open) if (r.at >= e.readAt && (!per || r.theirModel === theirModel)) unseen++;
    if (unseen === 0) return load;
    const took = Math.min(unseen, load.free);
    return { ...load, free: load.free - took, queued: load.queued + unseen - took };
  }

  /** What a peer says one of its models can take, or null; only per-model readings answer this. */
  statsFor(peer: string, theirModel: string): ModelStats | null {
    return this.peers.get(peer)?.status.capacity?.models?.[theirModel]?.stats ?? null;
  }

  /** Their id for one of our models, if they've agreed to serve it. */
  theirModelId(peer: string, model: string): string | undefined {
    return this.peers.get(peer)?.cfg.models[model];
  }

  /** Peers that are up, map this model and are not rate-limiting it, in preference order. */
  candidates(model: string, preferred: string[]): string[] {
    // Borrowing paused: no candidates, and every policy path already handles that.
    if (!this.controls.borrowingOn) return [];
    return peersMapping(model, preferred, [...this.peers.values()].map((e) => e.cfg)).filter((n) => this.isUp(n) && this.cappedFor(n, this.theirModelId(n, model) ?? "") === 0);
  }

  /** A peer refused one of our requests with 429: stop sending it that model for a while, so every
   *  request in the meantime goes straight to the fallback instead of being refused first. */
  rateCapped(name: string, theirModel: string, retryAfter?: string | string[]): void {
    const secs = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
    const ms = Number.isFinite(secs) && secs > 0 ? Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, secs * 1000)) : REQUEST_CAP_BACKOFF_MS;
    const capped = this.peers.get(name)?.capped;
    if (!capped) return;
    const already = this.cappedFor(name, theirModel) > 0;
    capped.set(theirModel, Date.now() + ms);
    if (!already) this.log.warn("peer.request_rate_capped", { peer: name, model: theirModel, backoffSec: Math.round(ms / 1000) });
  }

  /** How long until this peer takes this model again, in ms; 0 when it is not rate-limiting it. */
  cappedFor(name: string, theirModel: string): number {
    const capped = this.peers.get(name)?.capped;
    const until = capped?.get(theirModel);
    if (until === undefined) return 0;
    if (Date.now() >= until) { capped!.delete(theirModel); return 0; }
    return until - Date.now();
  }

  async pollOnce(name: string, timeoutMs = POLL_HEADERS_TIMEOUT_MS): Promise<void> {
    const entry = this.peers.get(name);
    if (!entry) return;
    const { cfg: peer, status: s } = entry;
    // Respected even for on-demand probes. Asking again inside a back-off is
    // exactly what caused the lockout to begin with.
    if (s.backoffUntil !== null && Date.now() < s.backoffUntil) return;

    const askedAt = Date.now();
    try {
      const cap = await getJson<PeerCapacity>(`${peer.url}/peer/state`, {
        headers: { Authorization: `Bearer ${peer.token}` },
        headersTimeoutMs: timeoutMs,
      });
      // The peer was removed or changed while this was asked: the answer is about something gone.
      if (this.peers.get(name) !== entry) return;
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
          if (entry && typeof entry === "object") {
            entry.stats = cleanStats(entry.stats);
            entry.terms = cleanTerms(entry.terms);
          }
        }
      }

      const was = s.up;
      s.capacity = cap;
      entry.readAt = askedAt;
      if (!was) void this.helloOnce(name);
      s.lastOkAt = Date.now();
      s.lastError = null;
      s.consecutiveFailures = 0;
      s.backoffUntil = null;
      s.lastFailAt = null;
      s.up = true;
      if (!was) this.log.info("peer.up", { peer: name });
    } catch (e) {
      if (this.peers.get(name) !== entry) return;
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
    await Promise.all([...this.peers.keys()].map((n) => this.probe(n)));
  }

  /**
   * Make every peer's reading fresh enough to route on, probing only where needed: a good
   * reading is reused for peerFreshMs, a failure for peerDownMs, and concurrent callers share
   * one probe per peer.
   */
  async ensureFresh(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      [...this.peers].map(([name, { status: s }]) => {
        if (s.backoffUntil !== null && now < s.backoffUntil) return undefined;
        if (s.lastOkAt !== null && now - s.lastOkAt <= this.cfg.peerFreshMs) return undefined;
        if (s.lastFailAt !== null && now - s.lastFailAt <= this.cfg.peerDownMs) return undefined;
        return this.probe(name);
      }),
    );
  }

  /** One probe per peer at a time. Late callers join the one in flight. */
  private probe(name: string): Promise<void> {
    const e = this.peers.get(name);
    if (!e) return Promise.resolve();
    if (e.inFlight) return e.inFlight;
    const p = this.pollOnce(name, PROBE_HEADERS_TIMEOUT_MS).finally(() => {
      e.inFlight = null;
    });
    e.inFlight = p;
    return p;
  }

  /** Probe every peer now, in parallel, with a short deadline. */
  async probeAll(): Promise<void> {
    await Promise.all([...this.peers.keys()].map((n) => this.probe(n)));
  }

  /** Does this peer advertise a capability? False until a hello has landed. */
  supports(name: string, cap: string): boolean {
    return this.peers.get(name)?.caps.has(cap) === true;
  }

  /** Handshake at startup; mainly checks that the models we map are ones they offer. */
  async helloOnce(name: string): Promise<void> {
    const e = this.peers.get(name);
    if (!e) return;
    const peer = e.cfg;
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
      e.caps = new Set(hi.capabilities ?? []);
    } catch {
      // Not fatal. A peer that's down at startup gets checked again when it next
      // comes up, and routing won't touch it before then anyway.
    }
  }

  start(): void {
    // Remembered, so a peer added later by a live edit starts the poll a node with none skipped.
    this.started = true;
    if (this.timer || this.peers.size === 0) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.cfg.peerPollMs);
    // Don't hold the process open just for a poll loop.
    this.timer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
