/**
 * Admission control in front of one backend. Order is one score, lowest first: lane
 * priority, minus a warm bonus, minus aging. No preemption: a running job always finishes.
 *
 * A model's declared slot count overrides the backend's `concurrency` either way; a raise
 * above it only admits more of the model already running, so a swap stays serialized.
 * `offbox` jobs hold no slot but still count against the caller's cap.
 */
import { randomUUID } from "node:crypto";

import type { ResourceArbiter } from "./resources.js";

export interface LaneConfig {
  /** Lower goes first. Put interactive lanes near zero. */
  priority: number;
}

export interface SchedulerOptions {
  /** Lanes and their base priority. */
  lanes: Record<string, LaneConfig>;
  /** Jobs allowed to hold the backend at once. One per GPU is the honest
   *  answer. Raise it only if your backend really does serve in parallel. */
  concurrency?: number;
  /** Priority earned per second of waiting. Also the starvation bound: lanes
   *  100 apart at a weight of 1 means the low one overtakes after 100s. */
  agePerSecond?: number;
  /** Discount for a job whose model is already loaded. Too high and one popular
   *  model starves the rest, too low and the backend thrashes. */
  warmBonus?: number;
  /** Refuse work rather than take an unbounded backlog. Someone told "full" can
   *  retry. Someone queued behind 400 jobs just waits for a timeout. */
  maxPerLane?: number;
  /** What's loaded right now, for display in capacity(). Return null if you
   *  don't know. */
  resident?: () => string | null;
  /** Is this model warm? A predicate, since ollama keeps a whole set resident. */
  warm?: (model: string) => boolean;
  /** Jobs this one model may hold at once, above or below the backend's `concurrency`; null defers to it. */
  slots?: (model: string) => number | null;
  /** Tokens this model's running jobs may hold between them (summed `tokens`), or null for no limit. */
  pool?: (model: string) => number | null;
  /** The id a model occupies the backend under, so aliases of one resident model batch together. */
  wire?: (model: string) => string;
  /** Several models run side by side (ollama), so a model's ceiling counts only its own jobs. */
  coresident?: boolean;
  /** Fires whenever the job list changes, for status surfaces. */
  onChange?: (jobs: JobView[]) => void;
  /** Hardware this backend consumes and the arbiter it competes in; both or neither. Held per backend, not per job. */
  resources?: readonly string[];
  arbiter?: ResourceArbiter;
  /** Clear neighbours' weights off the hardware once acquired, before the first job runs. A rejection fails the job. */
  evict?: () => Promise<void>;
}

export interface JobSpec {
  lane: string;
  model: string;
  /** Who's asking: an api key id, an account, a peer name. Caps are per caller
   *  per lane. */
  caller: string;
  /** Caller's own id, if it has one, so a client polling by it can match up. */
  id?: string;
  /** Reject once this caller has this many queued-or-running in the lane. */
  maxPerCaller?: number;
  /** Context this job holds while it runs, counted against the model's pool. */
  tokens?: number;
  /** No slot needed, this one runs off-box. */
  offbox?: boolean;
  /** Which peer is running it, for off-box jobs. Only used by status surfaces,
   *  which otherwise cannot tell you WHERE the work went. */
  peer?: string;
  /** Client went away. Drops a queued job. Once it's running, we assume the
   *  caller wired the same signal into its upstream call. */
  signal?: AbortSignal;
  /** Live position while waiting. 0 means next. */
  onPosition?: (position: number) => void;
}

/** How a status surface sees a job. */
export interface JobView {
  id: string;
  lane: string;
  model: string;
  caller: string;
  state: "queued" | "running";
  /** 0 for anything running, off-box included. */
  position: number;
  /** Queued jobs clock their wait, running jobs clock their run. */
  since: number;
  offbox: boolean;
  /** Set only on off-box jobs. */
  peer?: string;
}

export class QueueFullError extends Error {
  constructor(
    public readonly reason: "caller_cap" | "lane_full",
    public readonly lane: string,
  ) {
    super(
      reason === "caller_cap"
        ? `too many concurrent jobs in the ${lane} lane`
        : `the ${lane} queue is full`,
    );
    this.name = "QueueFullError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

interface Job<T = unknown> {
  id: string;
  lane: string;
  model: string;
  caller: string;
  offbox: boolean;
  peer?: string;
  tokens: number;
  enqueuedAt: number;
  startedAt: number | null;
  state: "queued" | "running";
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  onPosition?: (position: number) => void;
  lastPosition: number;
  detach?: () => void;
}

const DEFAULTS = {
  concurrency: 1,
  agePerSecond: 1,
  warmBonus: 40,
  maxPerLane: 100,
};

export class Scheduler {
  private readonly lanes: Record<string, LaneConfig>;
  private readonly concurrency: number;
  private readonly agePerSecond: number;
  private readonly warmBonusValue: number;
  private readonly maxPerLane: number;
  private readonly resident: () => string | null;
  private readonly isWarm: (model: string) => boolean;
  private readonly slotsOf: (model: string) => number | null;
  private readonly poolOf: (model: string) => number | null;
  private readonly wireOf: (model: string) => string;
  private readonly coresident: boolean;
  private readonly onChange?: (jobs: JobView[]) => void;
  private readonly resources: readonly string[];
  private readonly arbiter?: ResourceArbiter;
  private readonly evict?: () => Promise<void>;

  private readonly queued: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly offbox = new Set<Job>();
  /** Whether we hold our declared hardware, kept across gaps between our own jobs. */
  private holding = false;
  /** The eviction for the current hold, which every job admitted in that hold awaits. */
  private preparing: Promise<void> | null = null;

  constructor(opts: SchedulerOptions) {
    this.lanes = opts.lanes;
    this.concurrency = opts.concurrency ?? DEFAULTS.concurrency;
    this.agePerSecond = opts.agePerSecond ?? DEFAULTS.agePerSecond;
    this.warmBonusValue = opts.warmBonus ?? DEFAULTS.warmBonus;
    this.maxPerLane = opts.maxPerLane ?? DEFAULTS.maxPerLane;
    this.resident = opts.resident ?? (() => null);
    this.isWarm = opts.warm ?? ((m) => m === this.resident());
    this.slotsOf = opts.slots ?? (() => null);
    this.poolOf = opts.pool ?? (() => null);
    this.wireOf = opts.wire ?? ((m) => m);
    this.coresident = opts.coresident ?? false;
    this.onChange = opts.onChange;
    // Arbitrate only with both resources and an arbiter; config validation catches half a pair.
    this.resources = opts.arbiter ? (opts.resources ?? []) : [];
    this.arbiter = this.resources.length > 0 ? opts.arbiter : undefined;
    this.evict = opts.evict;
    // A queue blocked on someone else's hardware wakes when it is released.
    this.arbiter?.onRelease(() => this.pump());
  }

  /** Lane priority, or something large for an unknown lane, so a typo sorts to
   *  the back where you'll notice instead of quietly jumping the queue. */
  private lanePriority(lane: string): number {
    return this.lanes[lane]?.priority ?? 1000;
  }

  private score(job: Job, now: number, _resident: string | null): number {
    let s = this.lanePriority(job.lane);
    if (this.isWarm(job.model)) s -= this.warmBonusValue;
    s -= ((now - job.enqueuedAt) / 1000) * this.agePerSecond;
    return s;
  }

  /** How many go before this one: everything running, plus anything queued that
   *  outranks it. */
  private positionOf(job: Job, now: number, resident: string | null): number {
    const mine = this.score(job, now, resident);
    let ahead = this.running.size;
    for (const j of this.queued) {
      if (j !== job && this.score(j, now, resident) < mine) ahead++;
    }
    return ahead;
  }

  /** Queued-or-running for one caller in one lane, counting off-box. */
  countFor(caller: string, lane: string): number {
    let n = 0;
    for (const j of this.queued) if (j.caller === caller && j.lane === lane) n++;
    for (const j of this.running) if (j.caller === caller && j.lane === lane) n++;
    for (const j of this.offbox) if (j.caller === caller && j.lane === lane) n++;
    return n;
  }

  /** Everything in flight. Feeds /queue and /peer/state. */
  view(): JobView[] {
    const now = Date.now();
    const resident = this.resident();
    const out: JobView[] = [];
    const running = (j: Job): JobView => ({
      id: j.id,
      lane: j.lane,
      model: j.model,
      caller: j.caller,
      state: "running",
      position: 0,
      since: j.startedAt ?? j.enqueuedAt,
      offbox: j.offbox,
      ...(j.peer ? { peer: j.peer } : {}),
    });
    for (const j of this.running) out.push(running(j));
    for (const j of this.offbox) out.push(running(j));
    for (const j of this.queued) {
      out.push({
        id: j.id,
        lane: j.lane,
        model: j.model,
        caller: j.caller,
        state: "queued",
        position: this.positionOf(j, now, resident),
        since: j.enqueuedAt,
        offbox: false,
      });
    }
    return out;
  }

  /** A model's ceiling: its declared slot count, else the backend's concurrency. */
  private limitFor(model: string): number {
    return this.slotsOf(model) ?? this.concurrency;
  }

  /** Jobs counted against one model's ceiling; by wire id, so aliases share slots. */
  private heldBy(model: string): number {
    if (!this.coresident) return this.running.size;
    const wire = this.wireOf(model);
    let n = 0;
    for (const j of this.running) if (this.wireOf(j.model) === wire) n++;
    return n;
  }

  /** False only while ANOTHER backend holds a resource this one declared. */
  private hardwareFree(): boolean {
    if (!this.arbiter) return true;
    // Once our turn is up and a neighbour waits, stop admitting so the card can be handed over.
    if (this.holding) return !this.arbiter.owed(this.resources, this);
    return this.arbiter.mayTake(this.resources, this);
  }

  /** Publish our oldest blocked job's enqueue time as our claim, or clear it. */
  private updateClaim(): void {
    if (!this.arbiter) return;
    if (this.holding || this.queued.length === 0) {
      this.arbiter.claim(this, this.resources, null);
      return;
    }
    let oldest = Infinity;
    for (const j of this.queued) if (j.enqueuedAt < oldest) oldest = j.enqueuedAt;
    this.arbiter.claim(this, this.resources, oldest);
  }

  /** Let the hardware go, and forget the eviction that belonged to that turn. */
  private dropHold(): void {
    if (!this.holding) return;
    this.holding = false;
    this.preparing = null;
    this.arbiter?.release(this);
  }

  /** Nothing is running: keep the hardware while we have work, unless our turn is up and someone waits. */
  private settleHold(): void {
    if (!this.arbiter || !this.holding) return;
    if (this.queued.length === 0 || this.arbiter.owed(this.resources, this)) this.dropHold();
  }

  /** Would this job overflow its model's shared pool? A job alone always fits. */
  private overPool(job: Job): boolean {
    const pool = this.poolOf(job.model);
    if (pool === null) return false;
    const wire = this.wireOf(job.model);
    let used = 0;
    let sharing = false;
    for (const j of this.running) {
      if (this.wireOf(j.model) !== wire) continue;
      used += j.tokens;
      sharing = true;
    }
    return sharing && used + job.tokens > pool;
  }

  /**
   * May this job start now? Its model's ceiling first, then the backend's; above
   * `concurrency` only alongside jobs of the same model.
   */
  private canAdmit(job: Job): boolean {
    // Hardware first; our own hold never blocks us.
    if (!this.hardwareFree()) return false;
    if (this.heldBy(job.model) >= this.limitFor(job.model)) return false;
    if (this.overPool(job)) return false;
    if (this.running.size < this.concurrency) return true;
    const wire = this.wireOf(job.model);
    for (const j of this.running) if (this.wireOf(j.model) !== wire) return false;
    return true;
  }

  /**
   * Capacity for one model, as a peer asks it. A raised ceiling applies only while the backend
   * is idle or busy with that same model; a lower one always applies.
   */
  capacityFor(model: string): ReturnType<Scheduler["capacity"]> {
    const cap = this.slotCapacityFor(model);
    return cap.free > 0 && this.poolFull(model) ? { ...cap, free: 0 } : cap;
  }

  /** Is less than an even share of this model's pool left? Free slots behind it would only queue. */
  private poolFull(model: string): boolean {
    const pool = this.poolOf(model);
    if (pool === null) return false;
    const wire = this.wireOf(model);
    let used = 0;
    for (const j of this.running) if (this.wireOf(j.model) === wire) used += j.tokens;
    return pool - used < pool / this.limitFor(model);
  }

  private slotCapacityFor(model: string): ReturnType<Scheduler["capacity"]> {
    const base = this.capacity();
    const limit = this.limitFor(model);
    if (limit === this.concurrency) return base;
    if (limit > this.concurrency) {
      const wire = this.wireOf(model);
      for (const j of this.running) if (this.wireOf(j.model) !== wire) return base;
    }
    // Counted the way admission counts it.
    const held = this.heldBy(model);
    const spare = Math.max(0, limit - held);
    return {
      ...base,
      // Never fewer slots than jobs in flight, same guard capacity() carries:
      // a model can be told it has 2 while 3 of its jobs are still running, if
      // its number arrived (or shrank) after they started.
      slots: Math.max(limit, held),
      // Zero while the card is somebody else's; side by side, also bounded by
      // the backend's free slots unless the ceiling is raised.
      free: !this.hardwareFree()
        ? 0
        : this.coresident && limit < this.concurrency
          ? Math.min(spare, base.free)
          : spare,
    };
  }

  /** Depth per lane and free slots. This is what a peer polls for. */
  capacity(): {
    slots: number;
    free: number;
    running: number;
    offbox: number;
    queued: Record<string, number>;
    resident: string | null;
  } {
    const queued: Record<string, number> = {};
    for (const lane of Object.keys(this.lanes)) queued[lane] = 0;
    for (const j of this.queued) queued[j.lane] = (queued[j.lane] ?? 0) + 1;
    // No free slots while another backend holds our hardware: peers score us on this number.
    const free = this.hardwareFree() ? Math.max(0, this.concurrency - this.running.size) : 0;
    return {
      // Never fewer slots than there are jobs holding them. A batching model
      // runs above `concurrency` on purpose, and a status page that reported
      // "4 busy of 1" would read as a bug in the queue rather than the feature.
      slots: Math.max(this.concurrency, this.running.size),
      free,
      running: this.running.size,
      offbox: this.offbox.size,
      queued,
      resident: this.resident(),
    };
  }

  private notify(): void {
    if (!this.onChange) return;
    this.onChange(this.view());
  }

  /** Tell waiters whose place in line moved, then broadcast. */
  private sync(): void {
    const now = Date.now();
    const resident = this.resident();
    for (const j of this.queued) {
      const pos = this.positionOf(j, now, resident);
      if (pos !== j.lastPosition) {
        j.lastPosition = pos;
        j.onPosition?.(pos);
      }
    }
    this.notify();
  }

  private remove(job: Job): void {
    const i = this.queued.indexOf(job);
    if (i >= 0) this.queued.splice(i, 1);
  }

  /** Run a job and settle its caller; release comes before resolve, so the caller's count is accurate. */
  private execute(job: Job, release: () => void): void {
    // Captured synchronously: every job of a hold awaits that hold's eviction.
    const prepared = this.preparing;
    void Promise.resolve()
      .then(() => prepared ?? undefined)
      .then(() => job.run())
      .then(
        (v) => {
          job.detach?.();
          release();
          job.resolve(v);
          this.pump();
        },
        (e) => {
          job.detach?.();
          release();
          job.reject(e);
          this.pump();
        },
      );
  }

  /**
   * The best-scoring job if it can start, else null. On a coresident backend a job blocked
   * only by its own model's ceiling is passed over.
   */
  private next(): Job | null {
    const now = Date.now();
    const resident = this.resident();
    const passed = new Set<Job>();
    for (;;) {
      let best: Job | null = null;
      let bestScore = Infinity;
      for (const j of this.queued) {
        if (passed.has(j)) continue;
        const s = this.score(j, now, resident);
        if (s < bestScore) {
          bestScore = s;
          best = j;
        }
      }
      if (!best) return null;
      if (this.canAdmit(best)) return best;
      if (!this.coresident || this.heldBy(best.model) < this.limitFor(best.model)) return null;
      passed.add(best);
    }
  }

  private pump(): void {
    // File our claim BEFORE asking whether we may start, or the arbiter reads
    // us as having only just turned up and hands the hardware to whoever
    // claimed first — including on the tick where we are the longest waiter.
    this.updateClaim();
    while (this.queued.length > 0) {
      const job = this.next();
      if (!job) break;
      this.remove(job);
      job.state = "running";
      job.startedAt = Date.now();
      // Taking the hardware and clearing the neighbours off it happen once per
      // TURN, not once per job: a backend that already holds its resources had
      // them cleared when it took them.
      if (this.arbiter !== undefined && !this.holding) {
        // canAdmit proved this free; if acquire still fails, leave the job queued.
        if (!this.arbiter.acquire(this.resources, this)) {
          // Put it back exactly as it was. It has not been added to `running`
          // yet, so restoring the queue and the two fields is the whole undo.
          this.queued.unshift(job);
          job.state = "queued";
          job.startedAt = null;
          break;
        }
        this.holding = true;
        this.beginPrepare();
      }
      this.running.add(job);
      this.execute(job, () => {
        this.running.delete(job);
        // Last one out. Letting go while a sibling still runs would let a
        // competing backend load on top of live work.
        if (this.running.size === 0) this.settleHold();
        this.sync();
      });
    }
    this.updateClaim();
    this.sync();
  }

  /**
   * Clear neighbours off hardware we just took. Stored, not awaited, so `pump` stays sync;
   * a failure drops the hold so the next attempt evicts again.
   */
  private beginPrepare(): void {
    if (!this.evict) {
      this.preparing = null;
      return;
    }
    const p = this.evict();
    this.preparing = p;
    p.catch(() => {
      if (this.preparing !== p) return;
      this.dropHold();
    });
  }

  /** Admit a job; `run` is invoked only when it is scheduled. */
  submit<T>(spec: JobSpec, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = {
        id: spec.id ?? randomUUID(),
        lane: spec.lane,
        model: spec.model,
        caller: spec.caller,
        offbox: spec.offbox === true,
        ...(spec.peer ? { peer: spec.peer } : {}),
        tokens: spec.tokens ?? 0,
        enqueuedAt: Date.now(),
        startedAt: null,
        state: "queued",
        run,
        resolve,
        reject,
        onPosition: spec.onPosition,
        lastPosition: -1,
      };

      if (spec.signal) {
        if (spec.signal.aborted) {
          reject(new AbortedError());
          return;
        }
        const onAbort = () => {
          // Queued jobs only. Once it's running, the caller's signal is already
          // wired into its upstream call and rejects run() for us.
          if (job.state !== "queued") return;
          this.remove(job as Job);
          job.detach?.();
          reject(new AbortedError());
          // The queue may have just emptied, and a hold is kept only for work
          // we still have. Without this, cancelling the last waiting job leaves
          // the card ours until the next one arrives.
          this.updateClaim();
          if (this.running.size === 0) this.settleHold();
          this.sync();
        };
        spec.signal.addEventListener("abort", onAbort, { once: true });
        job.detach = () => spec.signal?.removeEventListener("abort", onAbort);
      }

      // Cap check and push happen in one tick with no await between them, so a
      // burst of concurrent submits serializes properly: first one lands, rest
      // see it. Any check the caller did earlier is just a fast path.
      if (
        spec.maxPerCaller != null &&
        this.countFor(job.caller, job.lane) >= spec.maxPerCaller
      ) {
        job.detach?.();
        reject(new QueueFullError("caller_cap", job.lane));
        return;
      }

      if (job.offbox) {
        // Off-box jobs are capped per lane too, counting only off-box work.
        let offboxDepth = 0;
        for (const j of this.offbox) if (j.lane === job.lane) offboxDepth++;
        if (offboxDepth >= this.maxPerLane) {
          job.detach?.();
          reject(new QueueFullError("lane_full", job.lane));
          return;
        }
        job.state = "running";
        job.startedAt = Date.now();
        this.offbox.add(job as Job);
        this.notify();
        this.execute(job as Job, () => {
          this.offbox.delete(job as Job);
          this.notify();
        });
        return;
      }

      const depth = this.queued.filter((j) => j.lane === job.lane).length;
      if (depth >= this.maxPerLane) {
        job.detach?.();
        reject(new QueueFullError("lane_full", job.lane));
        return;
      }

      this.queued.push(job as Job);
      this.pump();
    });
  }
}
