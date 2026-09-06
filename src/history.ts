/**
 * A rolling window of what the scheduler has been doing.
 *
 * hearth keeps no time series and this does not change that. It is a fixed
 * ring of samples in memory, the same as the queue itself, and it dies with
 * the process. That is the honest trade: a graph worth looking at costs about
 * 120 small objects, and anything that survives a restart means picking a
 * storage engine, which is a much bigger decision than "draw me a line".
 *
 * The one thing worth reading off it is the resident model over time. A GPU
 * that flips between two models is paying the load tax over and over, and that
 * is exactly the thrash the scheduler exists to prevent — but you cannot see it
 * in an instantaneous reading, only in a window.
 */

/** One backend's share of a reading. */
export interface BackendSample {
  name: string;
  queued: number;
  /** null when nothing is loaded there, or we cannot tell. */
  resident: string | null;
}

/**
 * One reading.
 *
 * `residents` is a list, not one name: a node fronting several backends has
 * several models warm at the same time, and collapsing that to one would draw a
 * thrash pattern that never happened.
 */
export interface Sample {
  t: number;
  /** Across every backend. Per-backend depth is in `backends`. */
  queued: number;
  residents: string[];
  /**
   * Models with a job RUNNING on a local backend at the instant of the reading.
   * Residency says what is loaded; this says what is being used. A model can
   * sit warm for an hour and never appear here.
   */
  active: string[];
  backends: BackendSample[];
}

/**
 * One request that ran on a local backend, recorded when it ENDED.
 *
 * The samples above cannot see a call that starts and finishes between two
 * readings, and cannot place a boundary more finely than 5s. This can: it is
 * the same record llama-swap's activity page keeps, made here so it exists for
 * every backend kind and for exactly the traffic that went through the queue.
 */
export interface Call {
  /** When it finished. Start is `t - ms`. */
  t: number;
  model: string;
  backend: string;
  /** Run time, once it had a slot. */
  ms: number;
  /** Time spent queued before that. */
  waitedMs: number;
  ok: boolean;
}

/** Every 5s for 10 minutes. Small enough to ignore, long enough to show a swap. */
export const SAMPLE_MS = 5_000;
export const KEEP = 120;
/** Calls are small; this is a ceiling, the window below is the real bound. */
export const KEEP_CALLS = 1_000;

export class History {
  private readonly samples: Sample[] = [];
  private readonly finished: Call[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly read: () => {
      queued: number;
      residents: string[];
      perBackend: BackendSample[];
      /** Optional so a reader that only knows residency still works. */
      active?: string[];
    },
    private readonly everyMs: number = SAMPLE_MS,
    private readonly keep: number = KEEP,
    private readonly keepCalls: number = KEEP_CALLS,
  ) {}

  /** A request finished on a local backend. */
  record(c: Call): void {
    this.finished.push(c);
    while (this.finished.length > this.keepCalls) this.finished.shift();
  }

  /** Calls that ended inside the same window the samples cover, oldest first. */
  calls(): Call[] {
    const cutoff = Date.now() - this.everyMs * this.keep;
    return this.finished.filter((c) => c.t >= cutoff);
  }

  /** Take a reading now. Public so a test does not have to wait 5s for one. */
  sample(): void {
    const { queued, residents, perBackend, active = [] } = this.read();
    this.samples.push({ t: Date.now(), queued, residents, active, backends: perBackend });
    // Ring, not a growing array: this runs for the life of the process.
    while (this.samples.length > this.keep) this.samples.shift();
  }

  all(): Sample[] {
    return [...this.samples];
  }

  start(): void {
    if (this.timer) return;
    this.sample(); // so the graph has a point immediately, not in 5s
    this.timer = setInterval(() => this.sample(), this.everyMs);
    // Never hold the process open just to keep drawing a chart.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
