/**
 * Scheduler readings and finished calls: 10 minutes of 5s samples for the live view, and a day
 * of calls and per-minute queue depth for the history view. `snapshot`/`restore` carry the day
 * across a restart when `historyFile` is set.
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

/** The deepest queue seen in one minute. */
export interface Minute {
  t: number;
  queued: number;
}

/** Every 5s for 10 minutes. Small enough to ignore, long enough to show a swap. */
export const SAMPLE_MS = 5_000;
export const KEEP = 120;
/** The history view's window. */
export const DAY_MS = 86_400_000;
/** Calls are small; this is a ceiling, the day window is the real bound. */
export const KEEP_CALLS = 20_000;

/** What `historyFile` holds. */
export interface HistorySnapshot {
  calls: Call[];
  minutes: Minute[];
}

export class History {
  private readonly samples: Sample[] = [];
  private finished: Call[] = [];
  private minutes: Minute[] = [];
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
    const cutoff = Date.now() - DAY_MS;
    while (this.finished.length > this.keepCalls || (this.finished[0] && this.finished[0].t < cutoff)) this.finished.shift();
  }

  /** Calls that ended inside the same window the samples cover, oldest first. */
  calls(): Call[] {
    return this.since(this.everyMs * this.keep).calls;
  }

  /** Calls and per-minute queue depth over the last `ms`, oldest first. */
  since(ms: number): HistorySnapshot {
    const cutoff = Date.now() - ms;
    return { calls: this.finished.filter((c) => c.t >= cutoff), minutes: this.minutes.filter((m) => m.t >= cutoff) };
  }

  snapshot(): HistorySnapshot {
    return this.since(DAY_MS);
  }

  /** Load a saved day; entries older than a day, or malformed, are dropped. */
  restore(saved: unknown): void {
    if (typeof saved !== "object" || saved === null) return;
    const cutoff = Date.now() - DAY_MS;
    const { calls, minutes } = saved as Partial<HistorySnapshot>;
    const isCall = (c: unknown): c is Call => typeof c === "object" && c !== null && typeof (c as Call).t === "number"
      && typeof (c as Call).model === "string" && typeof (c as Call).ms === "number";
    const isMinute = (m: unknown): m is Minute => typeof m === "object" && m !== null
      && typeof (m as Minute).t === "number" && typeof (m as Minute).queued === "number";
    if (Array.isArray(calls)) this.finished = [...calls.filter(isCall).filter((c) => c.t >= cutoff), ...this.finished].slice(-this.keepCalls);
    if (Array.isArray(minutes)) this.minutes = [...minutes.filter(isMinute).filter((m) => m.t >= cutoff), ...this.minutes];
  }

  /** Take a reading now. Public so a test does not have to wait 5s for one. */
  sample(): void {
    const { queued, residents, perBackend, active = [] } = this.read();
    const t = Date.now();
    this.samples.push({ t, queued, residents, active, backends: perBackend });
    // Ring, not a growing array: this runs for the life of the process.
    while (this.samples.length > this.keep) this.samples.shift();
    const minute = t - (t % 60_000);
    const last = this.minutes[this.minutes.length - 1];
    if (last && last.t === minute) last.queued = Math.max(last.queued, queued);
    else this.minutes.push({ t: minute, queued });
    while (this.minutes[0] && this.minutes[0].t < t - DAY_MS) this.minutes.shift();
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
