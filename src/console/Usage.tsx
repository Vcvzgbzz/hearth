/** The Usage page: what the node has counted per day, caller and model, from `GET /usage`. */
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { money, short } from "./pages.js";
import { request } from "./store.js";
import { byDay, callerName, daysEnding, tokens, topN, totalsBy, type Bar, type By, type Entry, type Prices, type UsageSnapshot } from "./tally.js";
import { Card, cx, Empty, mono } from "./ui.js";

interface Loaded { usage: UsageSnapshot; prices: Prices }

const COLORS = ["var(--accent)", "var(--info)", "var(--ok)", "var(--warn)", "var(--peer)"];
const OTHERS = "var(--dim)";

function useUsage(days: number): Loaded | null {
  const [data, setData] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await request<Loaded>("GET", `/usage?days=${days}`);
        if (live) setData({ usage: r.usage ?? {}, prices: r.prices ?? {} });
      } catch { /* the header already says when the node is unreachable */ }
    };
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { live = false; clearInterval(id); };
  }, [days]);
  return data;
}

const label = (by: By, name: string): string => (by === "caller" ? callerName(name) : name);

function Segmented<T extends string | number>({ name, value, options, onChange }: { name: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={name} className="flex rounded-lg border border-line p-0.5 text-[12px]">
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
                className={cx("rounded-md px-2.5 py-1", value === v ? "bg-muted font-medium" : "text-dim hover:text-fg")}>{text}</button>
      ))}
    </div>
  );
}

/** Tokens per UTC day, stacked by the top names; one bar per day. */
function Chart({ bars, names, by }: { bars: Bar[]; names: string[]; by: By }) {
  const W = 1000, H = 160;
  const max = Math.max(1, ...bars.map((b) => b.total));
  const w = W / bars.length;
  return (
    <div className="px-4 pt-3">
      <svg role="img" aria-label="tokens per day" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full">
        {bars.map((b, i) => {
          let y = H;
          const seg = [...names.map((n, k) => [n, b.parts[n] ?? 0, COLORS[k] ?? OTHERS] as const), ["others", b.others, OTHERS] as const];
          return (
            <g key={b.day}>
              <title>{`${b.day} (UTC): ${short(b.total)} tokens${b.failed > 0 ? `, ${b.failed} failed` : ""}${seg.filter((s) => s[1] > 0).map((s) => `\n${s[0] === "others" ? "others" : label(by, s[0])}: ${short(s[1])}`).join("")}`}</title>
              <rect x={i * w} y={0} width={w} height={H} fill="transparent" />
              {seg.map(([n, v, color]) => {
                const h = (v / max) * (H - 4);
                y -= h;
                return h > 0 ? <rect key={n} x={i * w + w * 0.12} y={y} width={w * 0.76} height={h} fill={color} /> : null;
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-dim"><span>{bars[0]?.day}</span><span>{bars[bars.length - 1]?.day}</span></div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 py-2 text-[12px]">
        {[...names.map((n, k) => [n, COLORS[k] ?? OTHERS] as const), ["others", OTHERS] as const].map(([n, c]) => (
          <span key={n} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: c }} />{n === "others" ? "others" : label(by, n)}</span>
        ))}
      </div>
    </div>
  );
}

function Cells({ e, total }: { e: Entry; total: number }) {
  const share = total > 0 ? tokens(e) / total : 0;
  return (
    <>
      <td className="tabular px-4 py-2 text-right">{short(e.requests)}</td>
      <td className={cx("tabular px-4 py-2 text-right", e.failed > 0 ? "text-bad" : "text-dim")}>{e.failed > 0 ? short(e.failed) : "—"}</td>
      <td className="tabular px-4 py-2 text-right">{short(e.in)}</td>
      <td className="tabular px-4 py-2 text-right">{short(e.out)}</td>
      <td className="tabular px-4 py-2 text-right text-dim">{e.cached > 0 ? short(e.cached) : "—"}</td>
      <td className="tabular px-4 py-2 text-right">{e.cost > 0 ? money(e.cost) : <span className="text-dim">—</span>}</td>
      <td className="w-32 px-4 py-2" title={`${(share * 100).toFixed(1)}% of tokens`}>
        <div className="h-1.5 rounded-full bg-muted"><div className="h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} /></div>
      </td>
    </>
  );
}

export function Usage() {
  const [days, setDays] = useState(7);
  const [by, setBy] = useState<By>("caller");
  const [open, setOpen] = useState<string | null>(null);
  const data = useUsage(days);
  const groups = data ? totalsBy(data.usage, data.prices, by) : [];
  const other: By = by === "caller" ? "model" : "caller";
  const names = topN(groups, 5);
  const total = groups.reduce((a, g) => a + tokens(g), 0);
  const sum = groups.reduce((a, g) => ({ requests: a.requests + g.requests, failed: a.failed + g.failed, in: a.in + g.in, out: a.out + g.out, cost: a.cost + g.cost }), { requests: 0, failed: 0, in: 0, out: 0, cost: 0 });
  const heads = ["requests", "failed", "tokens in", "tokens out", "cached", "cost", "share"];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-[15px] font-semibold">Usage</h1>
        <Segmented name="range" value={days} options={[[7, "7 days"], [31, "31 days"]]} onChange={(d) => setDays(d)} />
        <Segmented name="group by" value={by} options={[["caller", "by caller"], ["model", "by model"]]} onChange={(b) => { setBy(b); setOpen(null); }} />
      </div>
      <Card className="overflow-hidden">
        {!data ? <Empty>Loading.</Empty> : groups.length === 0 ? <Empty>Nothing has been recorded yet.</Empty> : (
          <>
            <Chart bars={byDay(data.usage, by, names, daysEnding(days, Date.now()))} names={names} by={by} />
            <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-line px-4 py-2 text-[12px]">
              <span><b className="tabular">{short(sum.requests)}</b> <span className="text-dim">requests</span></span>
              <span><b className="tabular">{short(sum.in)}</b> <span className="text-dim">tokens in</span> · <b className="tabular">{short(sum.out)}</b> <span className="text-dim">out</span></span>
              {sum.cost > 0 && <span><b className="tabular">{money(sum.cost)}</b> <span className="text-dim">cost</span></span>}
              <span className={sum.failed > 0 ? "text-bad" : "text-dim"}>{sum.requests > 0 ? `${((sum.failed / sum.requests) * 100).toFixed(1)}%` : "0%"} failed</span>
            </div>
            <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left">
              <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
                <tr>
                  <th className="px-4 py-2 font-medium">{by}</th>
                  {heads.map((h) => <th key={h} className={cx("px-4 py-2 font-medium", h !== "share" && "text-right")}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const isOpen = open === g.name;
                  return (
                    <Fragment key={g.name}>
                      <tr onClick={() => setOpen(isOpen ? null : g.name)} className="cursor-pointer border-b border-line/60 hover:bg-muted/40">
                        <td className={cx("px-4 py-2", by === "model" && mono)}>
                          <button type="button" aria-expanded={isOpen} className="inline-flex items-center gap-1.5 focus-visible:outline-2 focus-visible:outline-accent">
                            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{label(by, g.name)}
                          </button>
                        </td>
                        <Cells e={g} total={total} />
                      </tr>
                      {isOpen && g.parts.map((p) => (
                        <tr key={p.name} className="border-b border-line/40 bg-accent/[0.03] text-[12px]">
                          <td className={cx("py-1.5 pl-10 pr-4", other === "model" && mono)}>{label(other, p.name)}</td>
                          <Cells e={p} total={total} />
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table></div>
          </>
        )}
      </Card>
      <p className="text-[11px] text-dim">Days are UTC. Cost is at the prices the models carry now.</p>
    </div>
  );
}
