/** The Usage page's arithmetic: `GET /usage` rolled up by caller or model, and by day for the chart. */

/** One caller's use of one model on one day, as `/usage` answers it; the server's own copy pulls in node, which the page cannot. */
export interface Row { requests: number; failed: number; in: number; out: number; cached?: number }
/** day -> caller -> model -> row. */
export type UsageSnapshot = Record<string, Record<string, Record<string, Row>>>;

export type Prices = Record<string, { in: number; out: number; cached?: number }>;
export type By = "caller" | "model";
export interface Entry { name: string; requests: number; failed: number; in: number; out: number; cached: number; cost: number }
export interface Group extends Entry { parts: Entry[] }
export interface Bar { day: string; failed: number; total: number; parts: Record<string, number>; others: number }

const DAY_MS = 86_400_000;
export const tokens = (e: { in: number; out: number }): number => e.in + e.out;

/** A caller id as the Keys page names it. */
export const callerName = (id: string): string => (id === "local" ? "this machine, no key" : id.startsWith("peer:") ? `peer ${id.slice(5)}` : id.startsWith("key:") ? id.slice(4) : id);

/** Dollars for one row of one model, at the price it carries now. */
export function costOf(model: string, row: Row, prices: Prices): number {
  const p = prices[model];
  if (!p) return 0;
  const cached = Math.min(row.cached ?? 0, row.in);
  return ((row.in - cached) * p.in + cached * (p.cached ?? p.in) + row.out * p.out) / 1_000_000;
}

const blank = (name: string): Entry => ({ name, requests: 0, failed: 0, in: 0, out: 0, cached: 0, cost: 0 });
function add(e: Entry, model: string, row: Row, prices: Prices): void {
  e.requests += row.requests; e.failed += row.failed; e.in += row.in; e.out += row.out; e.cached += row.cached ?? 0;
  e.cost += costOf(model, row, prices);
}
const biggest = (a: Entry, b: Entry): number => tokens(b) - tokens(a) || b.requests - a.requests || a.name.localeCompare(b.name);

/** Every (caller, model, row) in the snapshot, summed over its days. */
function pairs(usage: UsageSnapshot): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const callers of Object.values(usage)) {
    for (const [caller, models] of Object.entries(callers)) {
      for (const [model, row] of Object.entries(models)) {
        const k = `${caller}\n${model}`;
        const o = out.get(k) ?? { requests: 0, failed: 0, in: 0, out: 0, cached: 0 };
        out.set(k, { requests: o.requests + row.requests, failed: o.failed + row.failed, in: o.in + row.in, out: o.out + row.out, cached: (o.cached ?? 0) + (row.cached ?? 0) });
      }
    }
  }
  return out;
}

/** One group per caller (or model), biggest first, each with its breakdown by the other dimension. */
export function totalsBy(usage: UsageSnapshot, prices: Prices, by: By): Group[] {
  const groups = new Map<string, Group & { sub: Map<string, Entry> }>();
  for (const [k, row] of pairs(usage)) {
    const [caller, model] = k.split("\n") as [string, string];
    const [name, other] = by === "caller" ? [caller, model] : [model, caller];
    const g = groups.get(name) ?? { ...blank(name), parts: [], sub: new Map() };
    groups.set(name, g);
    add(g, model, row, prices);
    const s = g.sub.get(other) ?? blank(other);
    g.sub.set(other, s);
    add(s, model, row, prices);
  }
  return [...groups.values()].map(({ sub, ...g }) => ({ ...g, parts: [...sub.values()].sort(biggest) })).sort(biggest);
}

/** The names of the `n` biggest groups. */
export const topN = (groups: Entry[], n: number): string[] => groups.slice(0, n).map((g) => g.name);

/** The UTC days of a range ending at `now`, oldest first. */
export const daysEnding = (n: number, now: number): string[] =>
  Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));

/** One bar per day: tokens by each of `names`, the rest as `others`. */
export function byDay(usage: UsageSnapshot, by: By, names: string[], days: string[]): Bar[] {
  return days.map((day) => {
    const bar: Bar = { day, failed: 0, total: 0, parts: Object.fromEntries(names.map((n) => [n, 0])), others: 0 };
    for (const [caller, models] of Object.entries(usage[day] ?? {})) {
      for (const [model, row] of Object.entries(models)) {
        const name = by === "caller" ? caller : model;
        const t = row.in + row.out;
        bar.total += t;
        bar.failed += row.failed;
        if (name in bar.parts) bar.parts[name] = (bar.parts[name] ?? 0) + t;
        else bar.others += t;
      }
    }
    return bar;
  });
}
