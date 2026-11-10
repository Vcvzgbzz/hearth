/** What the Logs page keeps and how it keys its rows; no React, so tests can import it. */
export interface LogEntry {
  t: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields: Record<string, unknown>;
}

/** A request that did not succeed reads as a warning whatever level it was logged at. */
export const failed = (e: LogEntry): boolean => e.msg === "request" && e.fields.ok === false;

/** Whether `e` passes the level filter: warnings and errors take failed requests, errors do not. */
export const passes = (e: LogEntry, level: "all" | "warn" | "error"): boolean =>
  level === "all" || (level === "warn" ? e.level !== "info" && e.level !== "debug" || failed(e) : e.level === "error");

/** A key per entry that survives lines arriving and the ring rotating: time, message and fields, with a repeat count only among identical lines. */
export function keysOf(entries: LogEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const base = `${e.t}|${e.msg}|${JSON.stringify(e.fields)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}|${n}`;
  });
}
