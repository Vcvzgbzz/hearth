/**
 * Who used what: requests and tokens per caller per model per day, for a month. The counts are
 * read off answers on their way to the caller, never by holding or altering one.
 */
import type { ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** What one answer cost. `est` marks an output count that was inferred because the answer carried no `usage`. */
export interface Counted {
  in: number;
  out: number;
  est: boolean;
}

/** How much of an answer's end is kept to find its `usage` in. */
const TAIL = 4096;

/**
 * Reads token counts off an answer as it is written. A backend's `usage` object is taken where the
 * answer carries one; a stream without one is counted by its events, one token a piece, which is
 * what a backend sends. Never throws into the write it watches.
 */
export class Meter {
  private tail = "";
  private carry = "";
  private events = 0;
  private started = false;

  feed(chunk: unknown): void {
    try {
      const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("latin1") : "";
      if (text === "") return;
      // An event starts a line. Its first bytes can end one chunk and the rest start the next: count across the join.
      const joined = this.carry + text;
      if (!this.started && joined.startsWith("data:")) this.events++;
      this.started = true;
      for (let at = joined.indexOf("\ndata:"); at !== -1; at = joined.indexOf("\ndata:", at + 6)) this.events++;
      this.carry = joined.slice(-5);
      this.tail = (this.tail + text).slice(-TAIL);
    } catch {
      // Counting must never be able to break the answer.
    }
  }

  /** What the answer cost; `fallbackIn` is the size the request was judged to be, used when the answer does not say. */
  read(fallbackIn = 0): Counted | null {
    if (this.tail === "") return null;
    const at = this.tail.lastIndexOf('"usage"');
    const said = at === -1 ? "" : this.tail.slice(at);
    const num = (key: string): number | null => {
      const m = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(said);
      return m ? Number(m[1]) : null;
    };
    const [i, o] = [num("prompt_tokens"), num("completion_tokens")];
    if (i !== null && o !== null) return { in: i, out: o, est: false };
    // The first event names the role and the last says it is done; what is between is the answer.
    return { in: fallbackIn, out: Math.max(0, this.events - 2), est: true };
  }
}

/** Watch everything written to `res` from here on. */
export function meter(res: ServerResponse): Meter {
  const m = new Meter();
  const { write, end } = res;
  res.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
    m.feed(chunk);
    return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof res.write;
  res.end = function (this: ServerResponse, chunk?: unknown, ...rest: unknown[]) {
    if (typeof chunk !== "function") m.feed(chunk);
    return (end as (...a: unknown[]) => ServerResponse).call(this, chunk, ...rest);
  } as typeof res.end;
  return m;
}

/**
 * A stream with the event that only reports usage taken out and handed to `m`: for an answer whose
 * usage this node asked for and its caller did not. Every other event goes on whole, as it completes.
 */
export function withoutUsage(m: Meter): Transform {
  const text = new StringDecoder("utf8");
  let held = "";
  const pass = (t: Transform, upTo: number): void => {
    const event = held.slice(0, upTo);
    held = held.slice(upTo);
    if (/"choices"\s*:\s*\[\s*\]/.test(event) && event.includes('"usage"')) m.feed(event);
    else t.push(event);
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      held += text.write(chunk);
      for (let end = /\r?\n\r?\n/.exec(held); end; end = /\r?\n\r?\n/.exec(held)) pass(this, end.index + end[0].length);
      done();
    },
    flush(done) {
      held += text.end();
      if (held !== "") pass(this, held.length);
      done();
    },
  });
}

/** One caller's use of one model on one day. */
export interface Row {
  requests: number;
  failed: number;
  in: number;
  out: number;
}

const blank = (): Row => ({ requests: 0, failed: 0, in: 0, out: 0 });
const plus = (a: Row, b: Row): Row => ({ requests: a.requests + b.requests, failed: a.failed + b.failed, in: a.in + b.in, out: a.out + b.out });

/** How many days are kept. */
export const KEEP_DAYS = 31;
const DAY_MS = 86_400_000;
/** The UTC day a moment falls in, as `YYYY-MM-DD`. */
export const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** day -> caller -> model -> row. */
export type UsageSnapshot = Record<string, Record<string, Record<string, Row>>>;

export class Usage {
  private days: UsageSnapshot = {};

  constructor(private readonly now: () => number = Date.now) {}

  add(caller: string, model: string, ok: boolean, used: Counted | null): void {
    const day = dayOf(this.now());
    const row = (((this.days[day] ??= {})[caller] ??= {})[model] ??= blank());
    row.requests++;
    if (!ok) row.failed++;
    row.in += used?.in ?? 0;
    row.out += used?.out ?? 0;
    this.prune();
  }

  private prune(): void {
    const oldest = dayOf(this.now() - (KEEP_DAYS - 1) * DAY_MS);
    for (const day of Object.keys(this.days)) if (day < oldest) delete this.days[day];
  }

  /** One caller's total over the last `days` days, today included. */
  total(caller: string, days = 1): Row {
    const from = dayOf(this.now() - (days - 1) * DAY_MS);
    let sum = blank();
    for (const [day, callers] of Object.entries(this.days)) {
      if (day < from) continue;
      for (const row of Object.values(callers[caller] ?? {})) sum = plus(sum, row);
    }
    return sum;
  }

  /** One caller's totals per model over the last `days` days, today included. */
  byModel(caller: string, days = 1): Record<string, Row> {
    const from = dayOf(this.now() - (days - 1) * DAY_MS);
    const out: Record<string, Row> = {};
    for (const [day, callers] of Object.entries(this.days)) {
      if (day < from) continue;
      for (const [model, row] of Object.entries(callers[caller] ?? {})) out[model] = plus(out[model] ?? blank(), row);
    }
    return out;
  }

  /** Every caller seen in the last `days` days. */
  callers(days = KEEP_DAYS): string[] {
    const from = dayOf(this.now() - (days - 1) * DAY_MS);
    return [...new Set(Object.entries(this.days).filter(([day]) => day >= from).flatMap(([, c]) => Object.keys(c)))].sort();
  }

  /** The last `days` days as they are kept, oldest first. */
  since(days = KEEP_DAYS): UsageSnapshot {
    this.prune();
    const from = dayOf(this.now() - (days - 1) * DAY_MS);
    return Object.fromEntries(Object.entries(this.days).filter(([day]) => day >= from).sort(([a], [b]) => a.localeCompare(b)));
  }

  snapshot(): UsageSnapshot {
    return this.since();
  }

  /** Load what was saved; anything malformed is dropped. */
  restore(saved: unknown): void {
    if (typeof saved !== "object" || saved === null) return;
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    for (const [day, callers] of Object.entries(saved)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof callers !== "object" || callers === null) continue;
      for (const [caller, models] of Object.entries(callers as object)) {
        if (typeof models !== "object" || models === null) continue;
        for (const [model, row] of Object.entries(models as object)) {
          if (typeof row !== "object" || row === null) continue;
          const r = row as Partial<Row>;
          const into = (((this.days[day] ??= {})[caller] ??= {})[model] ??= blank());
          Object.assign(into, plus(into, { requests: n(r.requests), failed: n(r.failed), in: n(r.in), out: n(r.out) }));
        }
      }
    }
    this.prune();
  }
}
