/**
 * A rolling in-memory window of scheduler readings, gone on restart. Its main use is the
 * resident model over time, which shows a GPU thrashing between two models.
 */

/** One backend's share of a reading. */
export interface BackendSample {
  name: string;
  queued: number;
  /** null when nothing is loaded there, or we cannot tell. */
  resident: string | null;
}

/** One reading. `residents` is a list: a node fronting several backends has several models warm. */
export interface Sample {
  t: number;
  /** Across every backend. Per-backend depth is in `backends`. */
  queued: number;
  residents: string[];
  /** Models with a job running at the instant of the reading, as opposed to merely loaded. */
  active: string[];
  backends: BackendSample[];
}

/** One request that ran on a local backend, recorded when it ended; catches calls shorter than a sample. */
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
