/** One-line JSON on stdout for journald; the supervisor owns files and rotation. */
export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

export const LEVELS = Object.keys(ORDER) as Level[];

export function createLogger(level: Level = "info"): Logger {
  // `??` because an unknown level leaves `min` undefined, and `n < undefined`
  // is false for every n. --log=verbose used to quietly turn on debug.
  const min = ORDER[level] ?? ORDER.info;
  const emit = (lvl: Level) => (msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    process.stdout.write(
      JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields }) + "\n",
    );
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** For tests, and anything that shouldn't print. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** One log line as the console's Logs page reads it. */
export interface LogEntry {
  t: string;
  level: Level;
  msg: string;
  fields: Record<string, unknown>;
}

/** The most recent log lines, for the console; journald stays the full record. */
export class LogRing {
  private entries: LogEntry[] = [];

  constructor(private readonly keep: number = 5_000) {}

  push(e: LogEntry): void {
    this.entries.push(e);
    if (this.entries.length > this.keep) this.entries.splice(0, this.entries.length - this.keep);
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  /** Load saved lines ahead of any written since startup; malformed ones are dropped. */
  restore(saved: unknown): void {
    if (!Array.isArray(saved)) return;
    const ok = saved.filter((e): e is LogEntry => typeof e === "object" && e !== null
      && typeof (e as LogEntry).t === "string" && typeof (e as LogEntry).msg === "string" && (e as LogEntry).level in ORDER);
    this.entries = [...ok, ...this.entries].slice(-this.keep);
  }

  /** `log`, with every line at info or above also kept here. */
  tap(log: Logger): Logger {
    const wrap = (lvl: Level) => (msg: string, fields?: Record<string, unknown>) => {
      log[lvl](msg, fields);
      if (ORDER[lvl] >= ORDER.info) this.push({ t: new Date().toISOString(), level: lvl, msg, fields: fields ?? {} });
    };
    return { debug: log.debug, info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
  }
}
