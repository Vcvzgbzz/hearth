/**
 * Admission control in front of one inference backend.
 *
 * A GPU fits one model at a time, so unserialized requests thrash: each evicts
 * the other's weights and pays the load tax again. This runs work N at a time,
 * N=1 unless you've got memory to spare, and favours interactive lanes without
 * starving the slow ones.
 *
 * One priority score decides order, lowest first, folding together:
 *
 *   - lane priority     a chat turn beats a batch render
 *   - warm preference   drain the loaded model before swapping
 *   - aging             a second of waiting buys a point of priority
 *
 * No preemption. A running job always finishes, and priority only matters at
 * dispatch. Killing a half-done render to start a chat throws away every
 * GPU-second already spent on it.
 *
 * How many jobs one model may hold is the model's own number when it declares
 * one, and the backend's `concurrency` when it does not — in EITHER direction.
 * vLLM behind llama-swap serves 32 sequences at once and says 32; a llama.cpp
 * entry on the same seat started with `--parallel 2` says 2, and gets 2 even
 * where the backend's number is higher. One port, one GPU, different real
 * ceilings depending on what is loaded.
 *
 * Above `concurrency` the raise applies only to the SAME model: extra jobs go
 * to what is already resident, never to a second model. That is the whole
 * safety property — batching is free once weights are loaded, and a swap is
 * exactly as expensive as it always was.
 *
 * `offbox` jobs dispatch immediately and never hold a slot, since they run on
 * someone else's hardware and the local GPU isn't what they're waiting for.
 * They still count against the caller's cap, otherwise sending work to a peer
 * would be a free way around it.
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
  /**
   * Is this model warm? Defaults to comparing against `resident`.
   *
   * A predicate because "the one resident model" is a llama-swap idea. Ollama
   * keeps a set resident under keep_alive and serves them together, so there is
   * no single name to compare against and every member deserves the bonus.
   */
  warm?: (model: string) => boolean;
  /**
   * Jobs this ONE model may hold at once — its real slot count, whether that is
   * above the backend's `concurrency` or below it.
   *
   * Above: vLLM through llama-swap answers 32 requests in about the time it
   * takes to answer one, so serializing them wastes the reason it is there.
   * Below: llama.cpp entries on one swapping seat get their own `--parallel`,
   * and a model with 2 slots behind a backend that says 4 has the extra two
   * queue INSIDE llama.cpp, where this scheduler counts them as running.
   *
   * null (the default) means "the backend's concurrency", which is every model
   * that has not been told otherwise.
   */
  slots?: (model: string) => number | null;
  /**
   * The id a model actually occupies the backend under, for the ONE question
   * this scheduler asks about model identity: would running these two together
   * force a swap?
   *
   * Identity by default, and identity is right for every id that means its own
   * model. It is wrong for several advertised ids fronting one resident model
   * (`as`/`params`), where a job on `seat-low` and a job on `seat-off` are the
   * same weights and can batch — read as different models they never do, and
   * the model's own slot count above `concurrency` is unreachable.
   */
  wire?: (model: string) => string;
  /** Fires whenever the job list changes, for status surfaces. */
  onChange?: (jobs: JobView[]) => void;
  /**
   * Hardware this backend consumes, and the arbiter it competes in.
   *
   * Both or neither. With them, a job is admitted only once every named
   * resource is free of OTHER backends, and they are held until this backend
   * has nothing running. Without them — the default, and every config that
   * predates the feature — admission is exactly what it was.
   *
   * Note the grain: the holder is the backend, not the job. `concurrency`
   * already says how much work may run here at once, and a second job must not
   * have to re-acquire what the first is already holding.
   */
  resources?: readonly string[];
  arbiter?: ResourceArbiter;
  /**
   * Make the resources actually usable, once acquired and before the first job
   * runs.
   *
   * Winning the arbitration means no other backend is RUNNING on this hardware.
   * It does not mean the hardware is free: a swapping backend that finished a
   * minute ago still has its weights resident, and on a card sized for one
   * model that is the whole of it. So something has to tell the neighbours to
   * let go, and only the caller knows how to ask.
   *
   * Awaited, so eviction happens before the load rather than racing it. Costly
   * — an unload plus the next cold load — which is exactly why it is gated on
   * winning the arbitration rather than done speculatively. If it rejects, the
   * job fails instead of running on hardware that was never actually freed.
   */
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
  private readonly wireOf: (model: string) => string;
  private readonly onChange?: (jobs: JobView[]) => void;
  private readonly resources: readonly string[];
  private readonly arbiter?: ResourceArbiter;
  private readonly evict?: () => Promise<void>;

  private readonly queued: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly offbox = new Set<Job>();

  constructor(opts: SchedulerOptions) {
    this.lanes = opts.lanes;
    this.concurrency = opts.concurrency ?? DEFAULTS.concurrency;
    this.agePerSecond = opts.agePerSecond ?? DEFAULTS.agePerSecond;
    this.warmBonusValue = opts.warmBonus ?? DEFAULTS.warmBonus;
    this.maxPerLane = opts.maxPerLane ?? DEFAULTS.maxPerLane;
    this.resident = opts.resident ?? (() => null);
    this.isWarm = opts.warm ?? ((m) => m === this.resident());
    this.slotsOf = opts.slots ?? (() => null);
    this.wireOf = opts.wire ?? ((m) => m);
    this.onChange = opts.onChange;
    // Only arbitrate when there is both something to hold and somewhere to hold
    // it. Half of the pair is a config that meant to exclude and silently does
    // not, so treat it as neither and let config validation be the place that
    // complains.
    this.resources = opts.arbiter ? (opts.resources ?? []) : [];
    this.arbiter = this.resources.length > 0 ? opts.arbiter : undefined;
    this.evict = opts.evict;
    // A queue blocked on hardware someone else holds has nothing of its own to
    // finish, so its usual triggers — a submission, a completion — never fire.
    // Subscribing here rather than leaving it to whoever built us means the
    // wake-up cannot be forgotten at a call site.
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

  /**
   * The ceiling for one model: the slot count it declares, else the backend's
   * own concurrency. A declared number wins in both directions — that is the
   * point of it, since the backend's number cannot be right for every model on
   * a seat whose entries were started with different `--parallel`.
   */
  private limitFor(model: string): number {
    return this.slotsOf(model) ?? this.concurrency;
  }

  /**
   * May this job start right now?
   *
   * The model's own ceiling is checked FIRST, because it can be lower than
   * `concurrency`: asking "below the backend's number?" first would wave
   * through a third job for a model that only has two slots. Under both
   * numbers it always may, which is the old rule untouched. Above
   * `concurrency`, only a batching model may go, and only alongside its own
   * kind: one foreign job running means the next admission would force a swap,
   * and a swap under load is the thrash this queue exists to prevent.
   */
  /**
   * Could this backend take work at all right now, hardware included?
   *
   * False only while ANOTHER backend holds a resource this one declared. What
   * we hold ourselves does not block us — that is what `concurrency` is for.
   */
  private hardwareFree(): boolean {
    return !this.arbiter || this.arbiter.available(this.resources, this);
  }

  private canAdmit(job: Job): boolean {
    // Before this backend's own ceilings, because they are about how much work
    // it may run and this is about whether it may run at all. `available`
    // ignores what we already hold, so a backend with a job in flight is not
    // blocked by itself.
    if (!this.hardwareFree()) return false;
    if (this.running.size >= this.limitFor(job.model)) return false;
    if (this.running.size < this.concurrency) return true;
    const wire = this.wireOf(job.model);
    for (const j of this.running) if (this.wireOf(j.model) !== wire) return false;
    return true;
  }

  /**
   * Capacity as it applies to ONE model, which is what a peer scoring its own
   * copy actually asked. Identical to `capacity()` for anything unbatched.
   *
   * A batching model reports its own ceiling, but only while the backend is
   * idle or already busy with that same model. With something else running, the
   * honest answer is the backend's plain concurrency: this job cannot batch
   * with what is loaded, it has to wait for it.
   *
   * A model whose ceiling is LOWER reports it unconditionally. There is no
   * arrangement of the backend that gives it more slots than it has, so the
   * peer asking must never be told the backend's larger number — that is the
   * over-commit this exists to stop.
   */
  capacityFor(model: string): ReturnType<Scheduler["capacity"]> {
    const base = this.capacity();
    const limit = this.limitFor(model);
    if (limit === this.concurrency) return base;
    if (limit > this.concurrency) {
      const wire = this.wireOf(model);
      for (const j of this.running) if (this.wireOf(j.model) !== wire) return base;
    }
    return {
      ...base,
      // Never fewer slots than jobs in flight, same guard capacity() carries:
      // a model can be told it has 2 while 3 of its jobs are still running, if
      // its number arrived (or shrank) after they started.
      slots: Math.max(limit, this.running.size),
      // Same rule as capacity(): a model's own ceiling is still zero while the
      // card is somebody else's.
      free: this.hardwareFree() ? Math.max(0, limit - this.running.size) : 0,
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
    // A backend waiting on hardware someone else holds has NO free slots, and
    // saying otherwise is not a display quirk — this number is what a peer
    // scores us on. Reporting 16 free while the card is held sends us work that
    // then sits in the queue, which is the over-commit the whole thing exists to
    // prevent. `slots` still says what this backend is, `free` says what it can
    // do this second.
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

  /**
   * Run a job, settle its caller.
   *
   * Release comes before resolve, so a caller that turns around and schedules
   * again sees an accurate count. The other order leaves a finished job counting
   * against its own caller for a microtask. Invisible over a network, very
   * visible in a test.
   */
  private execute(job: Job, release: () => void, prepare?: () => Promise<void>): void {
    void Promise.resolve()
      .then(() => prepare?.())
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

  private pump(): void {
    while (this.queued.length > 0) {
      const now = Date.now();
      const resident = this.resident();
      let best: Job | null = null;
      let bestScore = Infinity;
      for (const j of this.queued) {
        const s = this.score(j, now, resident);
        if (s < bestScore) {
          bestScore = s;
          best = j;
        }
      }
      // Strictly the best-scoring job, even when a lower-ranked one could batch
      // with what is running. Letting it jump would invert priority: the batched
      // model already gets the warm bonus, so if something still outranks it,
      // that something genuinely should go next.
      if (!best || !this.canAdmit(best)) break;
      const job = best;
      this.remove(job);
      job.state = "running";
      job.startedAt = Date.now();
      // Taking the hardware and evicting off it happen on the idle->busy edge
      // only. A backend already running holds its resources, and its
      // neighbours were already cleared off them.
      const takingHold = this.arbiter !== undefined && this.running.size === 0;
      this.running.add(job);
      if (takingHold) this.arbiter?.acquire(this.resources, this);
      this.execute(
        job,
        () => {
          this.running.delete(job);
          // Last one out. Releasing while a sibling still runs would let a
          // competing backend load on top of it.
          if (this.running.size === 0) this.arbiter?.release(this);
          this.sync();
        },
        takingHold ? this.evict : undefined,
      );
    }
    this.sync();
  }

  /**
   * Admit a job, resolve with `run`'s result once it's had its turn.
   *
   * `run` is the caller's upstream call as-is, and it only gets invoked when
   * scheduled, so nothing reaches the backend out of turn.
   */
  submit<T>(spec: JobSpec, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = {
        id: spec.id ?? randomUUID(),
        lane: spec.lane,
        model: spec.model,
        caller: spec.caller,
        offbox: spec.offbox === true,
        ...(spec.peer ? { peer: spec.peer } : {}),
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
        // Off-box work needs a ceiling too. It holds no slot and skipped the
        // check below, so with maxPerCaller off (the default when there are no
        // apiKeys) outstanding peer requests were unbounded and a caller could
        // just keep opening sockets. Count only off-box jobs here, so a peer
        // failing over to runLocal never gets refused by the depth its own
        // off-box job added.
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
