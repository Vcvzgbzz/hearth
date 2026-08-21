/**
 * One-line JSON on stdout. That's what journald wants, and it's what
 * `journalctl -o cat | jq` can read without any help.
 *
 * No log files and no rotation, because whatever supervises the process
 * already does that better than we would.
 */
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
