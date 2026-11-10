/**
 * Hardware that backends share, handed between them: whose turn a card is, clearing neighbours off it
 * before a load, residents that yield and come back, and holds an app keeps on a card while it is in use.
 */
import type { BackendConfig } from "../config/backends.js";
import type { HearthConfig } from "../config/config.js";
import type { Logger } from "../observe/log.js";
import { send } from "../wire/upstream.js";
import type { BackendSlot } from "./pool.js";
import { ResourceArbiter } from "./resources.js";

/** How long a resident is asked to stay off the card; renewed by every later turn, released by /resume. */
const RESIDENT_YIELD_S = 3600;
/** The card must stay free this long before residents come back, so a burst of turns yields once. */
export const RESIDENT_RESUME_MS = 30_000;

/** The budget for a whole clear-the-card sequence, which may unload several neighbours. */
const EVICT_BUDGET_MS = 45_000;

/** How often a backend with a `hold` has its activity path read. */
const HOLD_POLL_MS = 2_000;

/** How long a hold outlasts its seat's load: time for the app to answer its activity path for the first time. */
const SEAT_READY_GRACE_MS = 15_000;

export class Hardware {
  /** Whose turn each shared resource is; inert without `resources`. */
  readonly arbiter = new ResourceArbiter();
  /** Residents asked to yield and not yet resumed. */
  private readonly yielded = new Set<BackendSlot>();
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reads the activity path of every backend with a `hold`, and what each read last decided. */
  private holdTimer: ReturnType<typeof setInterval> | null = null;
  private readonly holdWas = new Map<BackendSlot, boolean>();
  /** The last twenty handoffs, so a card changing hands shows on the status page. */
  private readonly evicted: { t: number; backend: string; for: string; resources: string[] }[] = [];

  constructor(
    private readonly cfg: HearthConfig,
    private readonly log: Logger,
    /** The pool's backends, in order; the pool adds to it as it builds them. */
    private readonly slots: readonly BackendSlot[],
    private readonly resumeAfterMs = RESIDENT_RESUME_MS,
  ) {
    this.arbiter.onRelease(() => this.scheduleResume());
  }

  /** A backend's arbitrated resources: shared ones are filtered out here, but still drawn. */
  arbitrated(names: readonly string[]): string[] {
    return names.filter((n) => !this.cfg.resources[n]?.shared);
  }

  /**
   * Clear every other backend off the hardware `b` just took, one at a time and within
   * EVICT_BUDGET_MS. Anything still resident afterwards, from a refusal, an unreachable
   * unload or a spent budget, fails the job rather than loading on top of it.
   */
  async evictFor(b: BackendConfig): Promise<void> {
    // Shared hardware never causes an eviction: that is the whole hazard this
    // exists to remove. Six sidecars on one CPU must not unload each other.
    const mine = this.arbitrated(b.resources);
    const overlap = this.slots.filter(
      (s) => s.name !== b.name && this.arbitrated(s.cfg.resources).some((r) => mine.includes(r)),
    );
    // Residents first and together: they are small, and their memory is what the load needs.
    await Promise.all(overlap.filter((s) => s.cfg.resident?.yield).map((s) => this.residentCall(s, "yield", b.name)));
    // A model still loading holds the card as surely as a loaded one.
    const onCard = (s: BackendSlot) => s.state.resident() !== null || s.state.loading().length > 0;
    const deadline = Date.now() + EVICT_BUDGET_MS;
    for (const s of overlap) {
      if (s.cfg.resident || !onCard(s)) continue;
      if (Date.now() >= deadline) {
        this.log.warn("pool.evict_budget", {
          for: b.name, resources: mine, skipped: s.name, budgetMs: EVICT_BUDGET_MS,
        });
        break;
      }
      this.log.info("pool.evict", { backend: s.name, for: b.name, resources: mine });
      this.evicted.push({ t: Date.now(), backend: s.name, for: b.name, resources: [...mine] });
      while (this.evicted.length > 20) this.evicted.shift();
      await s.state.unload();
    }
    const left = overlap.filter((s) => !s.cfg.resident && onCard(s)).map((s) => s.name);
    if (left.length > 0) {
      throw new Error(`${left.join(", ")} still loaded on ${mine.join(", ")}: not loading ${b.name} on top`);
    }
  }

  /** POST a resident's yield or resume path. Best-effort: a resident that does not answer never holds up a turn. */
  private async residentCall(s: BackendSlot, what: "yield" | "resume", forName?: string): Promise<void> {
    const path = s.cfg.resident![what];
    if (path === null) return;
    try {
      const res = await send(`${s.cfg.url}${path}`, {
        method: "POST",
        json: what === "yield" ? { seconds: RESIDENT_YIELD_S } : {},
        headersTimeoutMs: 30_000,
      });
      res.body.resume();
      if (!res.ok) throw new Error(`answered ${res.status}`);
      if (what === "yield") this.yielded.add(s);
      else this.yielded.delete(s);
      this.log.info(`pool.${what}`, { backend: s.name, ...(forName ? { for: forName } : {}) });
    } catch (e) {
      this.log.warn(`pool.${what}_failed`, { backend: s.name, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /** After a release: once the card has stayed free for resumeAfterMs, give yielded residents it back. */
  private scheduleResume(): void {
    if (this.yielded.size === 0) return;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      const held = new Set(this.arbiter.snapshot().map(([r]) => r));
      for (const s of [...this.yielded]) {
        // Still taken by someone's turn: their release schedules this again.
        if (this.arbitrated(s.cfg.resources).some((r) => held.has(r))) continue;
        void this.residentCall(s, "resume");
      }
    }, this.resumeAfterMs);
    this.resumeTimer.unref?.();
  }

  /** Is `lane` kept off `b`'s hardware right now by another backend's hold? */
  heldOff(b: BackendConfig, lane: string): boolean {
    const mine = this.arbitrated(b.resources);
    if (mine.length === 0) return false;
    for (const s of this.slots) {
      const h = s.cfg.hold;
      if (h === null || s.name === b.name || !h.lanes.includes(lane)) continue;
      if (!s.cfg.resources.some((r) => mine.includes(r))) continue;
      if (this.holdActive(s)) return true;
    }
    return false;
  }

  /** Does another backend's app hold `b`'s hardware right now, whatever the lane? */
  appHolds(b: BackendConfig): boolean {
    const mine = this.arbitrated(b.resources);
    return this.slots.some((s) =>
      s.cfg.hold !== null && s.name !== b.name && s.cfg.resources.some((r) => mine.includes(r)) && this.holdActive(s));
  }

  /** Is this backend's hold in force: its app in use, or its seat loading (or only just loaded)? */
  private holdActive(s: BackendSlot): boolean {
    const h = s.cfg.hold!;
    const loader = h.seat === null ? undefined : this.slots.find((o) => o.cfg.serves.includes(h.seat!));
    if (loader !== undefined) {
      if (loader.state.sinceLoading(h.seat!) < SEAT_READY_GRACE_MS) return true;
      // A seat its swapper says is gone holds nothing, whatever the app last reported.
      if (loader.state.knowsWarm() && !loader.state.isWarm(h.seat!)) return false;
    }
    return s.state.holding(h.idleMs);
  }

  /**
   * Read a backend's activity path, unless that would start its app: a seat's own path goes
   * through its swapper, which loads whatever it is asked for.
   */
  sampleActivity(s: BackendSlot): Promise<void> {
    if (s.cfg.activity === null) return Promise.resolve();
    const seat = s.cfg.hold?.seat ?? null;
    if (seat !== null && s.cfg.serves.includes(seat) && !s.state.isWarm(seat)) return Promise.resolve();
    return s.state.sampleActivity(s.cfg.activity);
  }

  /** Every declared hold and whether it is in force, for status surfaces and clients that plan around it. */
  holds(): { backend: string; resources: string[]; lanes: string[]; idleMs: number; active: boolean; quietMs: number | null }[] {
    return this.slots.filter((s) => s.cfg.hold !== null).map((s) => ({
      backend: s.name,
      resources: this.arbitrated(s.cfg.resources),
      lanes: [...s.cfg.hold!.lanes],
      idleMs: s.cfg.hold!.idleMs,
      active: this.holdActive(s),
      quietMs: s.state.quietMs(),
    }));
  }

  /** Read each holding backend's activity path, and wake the queues when a hold starts or ends. */
  private async sampleHolds(): Promise<void> {
    const holders = this.slots.filter((s) => s.cfg.hold !== null);
    await Promise.all(holders.map((s) => this.sampleActivity(s)));
    let changed = false;
    for (const s of holders) {
      const now = this.holdActive(s);
      if (now === (this.holdWas.get(s) ?? false)) continue;
      this.holdWas.set(s, now);
      changed = true;
      this.log.info(now ? "pool.hold" : "pool.hold_end", { backend: s.name, lanes: s.cfg.hold!.lanes, resources: this.arbitrated(s.cfg.resources) });
    }
    if (changed) for (const s of this.slots) s.scheduler.kick();
  }

  /** Recent handoffs, oldest first. See `evicted`. */
  evictions(): readonly { t: number; backend: string; for: string; resources: string[] }[] {
    return [...this.evicted];
  }

  /** Declared hardware, who is running on it, and who competes for it. `holder` is running, not resident. */
  resources(): { name: string; kind: "gpu" | "cpu" | "other"; shared: boolean; holder: string | null; backends: string[] }[] {
    const held = new Map(this.arbiter.snapshot());
    const names = [...new Set(this.slots.flatMap((s) => s.cfg.resources))].sort();
    return names.map((name) => {
      // An undeclared name is an exclusive gpu: that is what every config
      // written before declarations existed meant by it, and what the arbiter
      // has always done with it.
      const decl = this.cfg.resources[name] ?? { kind: "gpu" as const, shared: false };
      return {
        name,
        kind: decl.kind,
        shared: decl.shared,
        // Map the holder back to a backend name; a shared resource never has one.
        holder: decl.shared
          ? null
          : this.slots.find((s) => held.get(name) === s.scheduler)?.name ?? null,
        backends: this.slots.filter((s) => s.cfg.resources.includes(name)).map((s) => s.name),
      };
    });
  }

  /** Start reading the activity paths of backends with a `hold`. */
  start(): void {
    if (!this.slots.some((s) => s.cfg.hold !== null)) return;
    this.holdTimer = setInterval(() => void this.sampleHolds(), HOLD_POLL_MS);
    this.holdTimer.unref?.();
    void this.sampleHolds();
  }

  stop(): void {
    if (this.holdTimer) clearInterval(this.holdTimer);
    this.holdTimer = null;
  }
}
