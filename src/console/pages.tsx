/** The pages beside the topology, and the inspector sheet that opens over it. */
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import type { UiData } from "./types.js";
import { control, select, useStore } from "./store.js";
import { ago, Card, cx, Empty, mono, Pill, Switch, type Tone } from "./ui.js";

const selfOf = (d: UiData) => d.net.nodes.find((n) => n.self)!;

/* ------------------------------------------------------------- inspector */

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="w-24 shrink-0 text-dim">{k}</div>
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

/* ------------------------------------------------- canary: seats that answer
   with nothing */

/**
 * The one failure the topology cannot draw.
 *
 * A seat returning 200 and `!!!!` is up, loaded, holding its card, and every
 * number on every page is green. So when the canary has a model out of
 * rotation this says so on every page,
 * rather than sitting somewhere an operator has to think to look.
 */
export function CanaryAlert() {
  const d = useStore((s) => s.data)!;
  const down = Object.entries(d.canary?.models ?? {}).filter(([, m]) => m.health === "degraded");
  if (down.length === 0) return null;
  return (
    <div className="border-b border-bad bg-muted px-5 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="bad">{down.length === 1 ? "1 model degraded" : `${down.length} models degraded`}</Pill>
        <span className="text-dim">
          answering, but not with an answer. New requests get 503 until a clean canary probe.
        </span>
      </div>
      {down.map(([id, m]) => (
        <div key={id} className="mt-1 flex flex-wrap items-baseline gap-2">
          <span className={cx(mono, "font-medium")}>{id}</span>
          <span className="text-dim">{m.backend}</span>
          <span className="text-bad">{m.reason ?? "degraded"}</span>
          <span className="text-dim">
            {m.since ? `out for ${ago(m.since)}` : "out"} · {m.failures} failed
            {m.reloadPending ? " · dropped, awaiting a reload" : ""}
          </span>
          {m.sample ? <span className={cx(mono, "break-all text-dim")}>{JSON.stringify(m.sample.slice(0, 40))}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function Inspector() {
  const d = useStore((s) => s.data)!;
  const sel = useStore((s) => s.sel);
  if (!sel) return null;
  const self = selfOf(d);
  let title = sel.id;
  let body: React.ReactNode = null;

  if (sel.kind === "self") {
    body = (
      <>
        <Row k="lending"><Switch label="lending" on={d.controls.lending} onChange={(on) => void control({ lending: on }, on ? "lending resumed" : "lending paused")} /></Row>
        <Row k="borrowing"><Switch label="borrowing" on={d.controls.borrowing} onChange={(on) => void control({ borrowing: on }, on ? "borrowing resumed" : "borrowing paused")} /></Row>
        <p className="mt-2 text-[11px] text-dim">Pausing applies at once and is not written to the config; a restart clears it.</p>
        <Row k="lent">{d.share.length ? d.share.join(", ") : "nothing"}</Row>
      </>
    );
  } else if (sel.kind === "backend") {
    const b = (self.backends ?? []).find((x) => x.name === sel.id);
    if (b) body = (
      <>
        <Row k="kind">{b.kind}{b.evicts ? " · swaps models" : ""}</Row>
        <Row k="address"><span className={mono}>{b.url}</span></Row>
        <Row k="slots"><span className="tabular">{(b.slots ?? 0) - (b.free ?? 0)} of {b.slots ?? 0} busy · {b.queued ?? 0} queued</span></Row>
        <Row k="hardware">{(b.resources ?? []).join(", ") || "none declared"}</Row>
        <Row k="loaded">{(b.loaded ?? []).join(", ") || (b.knowsWarm === false ? "cannot tell" : "nothing")}</Row>
        {(b.routes ?? []).length > 0 && <Row k="paths">{b.routes!.map((r) => <div key={r.path} className={mono}>{r.path}</div>)}</Row>}
        <Row k="serves">{(b.serves ?? []).join(", ")}</Row>
      </>
    );
  } else if (sel.kind === "peer") {
    const p = d.net.nodes.find((n) => n.name === sel.id);
    if (p) body = (
      <>
        <Row k="status">{p.up ? <Pill tone="ok">up</Pill> : <Pill tone="bad">down</Pill>}</Row>
        {!p.up && p.lastError && <Row k="last error"><span className="text-bad">{p.lastError}</span></Row>}
        <Row k="capacity"><span className="tabular">{p.free ?? "?"} of {p.slots ?? "?"} free · {p.queued ?? "?"} queued</span></Row>
        <Row k="links">
          {Object.entries(p.map ?? {}).length === 0 ? "nothing borrowed" : Object.entries(p.map ?? {}).map(([mine, theirs]) => (
            <div key={mine} className="flex items-center gap-2">
              <span className={mono}>{mine}{theirs !== mine ? ` → ${theirs}` : ""}</span>
              <button className="ml-auto text-dim hover:text-bad" aria-label={`unlink ${mine}`}
                      onClick={() => void control({ unlink: { peer: p.name, mine } }, `unlinked ${mine}`)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </Row>
        {(p.unmapped ?? []).length > 0 && (
          <Row k="also serves">
            {p.unmapped!.map((m) => (
              <div key={m} className="flex items-center gap-2">
                <span className={mono}>{m}</span>
                <button className="ml-auto text-[11px] text-accent hover:underline"
                        onClick={() => void control({ link: { peer: p.name, mine: m, theirs: m } }, `linked ${m}`)}>link</button>
              </div>
            ))}
          </Row>
        )}
      </>
    );
  } else {
    const r = (d.net.resources ?? []).find((x) => x.name === sel.id);
    if (r) body = (
      <>
        <Row k="kind">{r.kind ?? "gpu"}{r.shared ? " · shared, not arbitrated" : ""}</Row>
        <Row k="holder">{r.holder ?? "free"}</Row>
        <Row k="backends">{r.backends.join(", ")}</Row>
      </>
    );
    title = sel.id;
  }

  return (
    <aside className="absolute inset-y-3 right-3 z-10 w-[340px] overflow-auto rounded-xl border border-line bg-panel p-4 shadow-xl">
      <div className="mb-2 flex items-center">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-dim">{sel.kind === "self" ? "this node" : sel.kind}</div>
          <div className="text-base font-semibold">{title}</div>
        </div>
        <button className="ml-auto text-dim hover:text-fg" aria-label="close" onClick={() => select(null)}><X size={16} /></button>
      </div>
      {body ?? <Empty>gone</Empty>}
    </aside>
  );
}

/* ---------------------------------------------------------------- models */

function NoteCell({ model, note }: { model: string; note: string }) {
  const [draft, setDraft] = useState(note);
  useEffect(() => setDraft(note), [note]);
  const commit = () => {
    if (draft.trim() === note.trim()) return;
    void control({ notes: { [model]: draft.trim() === "" ? null : draft } }, "note saved");
  };
  return (
    <input
      value={draft} placeholder="add a note peers will see"
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setDraft(note); }}
      className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12px] hover:border-line focus:border-accent focus:outline-none"
    />
  );
}

export function Models() {
  const d = useStore((s) => s.data)!;
  const self = selfOf(d);
  const local = new Set(d.catalog);
  const ids = [...new Set([...d.catalog, ...d.net.available])].sort();
  const where = (m: string) => {
    const out: string[] = [];
    for (const b of self.backends ?? []) if ((b.serves ?? []).includes(m)) out.push(b.name);
    for (const p of d.net.nodes) if (!p.self && (p.serves ?? []).includes(m)) out.push(`${p.name} (peer)`);
    return out;
  };
  const state = (m: string): [Tone, string] =>
    d.net.readyNow.includes(m) ? ["ok", "warm"] : (d.net.unknownWarm ?? []).includes(m) ? ["dim", "unknown"] : ["info", "cold"];
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left">
        <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
          <tr>
            <th className="px-4 py-2 font-medium">model</th>
            <th className="px-2 py-2 font-medium">state</th>
            <th className="px-2 py-2 font-medium">served by</th>
            <th className="px-2 py-2 font-medium">context</th>
            <th className="px-2 py-2 font-medium">lent</th>
            <th className="w-[34%] px-2 py-2 font-medium">note</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((m) => {
            const [tone, word] = state(m);
            const stats = self.stats?.[m];
            const lent = d.configuredShare.includes(m);
            return (
              <tr key={m} className="border-b border-line/60 last:border-0 hover:bg-muted/40">
                <td className={cx("px-4 py-2", mono)}>{m}</td>
                <td className="px-2 py-2"><Pill tone={tone}>{word}</Pill></td>
                <td className="px-2 py-2 text-dim">{where(m).join(", ")}</td>
                <td className="tabular px-2 py-2 text-dim">{stats?.context ? `${Math.round(stats.context / 1024)}k` : "—"}</td>
                <td className="px-2 py-2">
                  {local.has(m)
                    ? <Switch label={`lend ${m}`} on={lent} onChange={(on) => void control({ share: { [m]: on } }, on ? `lending ${m}` : `holding ${m}`)} />
                    : <span className="text-dim">—</span>}
                </td>
                <td className="px-2 py-1">{local.has(m) ? <NoteCell model={m} note={stats?.note ?? ""} /> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {ids.length === 0 && <Empty>No models yet — backends report theirs once reachable.</Empty>}
    </Card>
  );
}

/* ----------------------------------------------------------------- queue */

export function Queue() {
  const jobs = useStore((s) => s.data!.q.jobs);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const rows = [...jobs].sort((a, b) => (a.state === b.state ? a.since - b.since : a.state === "running" ? -1 : 1));
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left">
        <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
          <tr>{["state", "model", "lane", "caller", "where", "time"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((j) => (
            <tr key={j.id} className="border-b border-line/60 last:border-0">
              <td className="px-4 py-2">{j.state === "running" ? <Pill tone="accent" pulse>running</Pill> : <Pill tone="dim">#{j.position + 1} queued</Pill>}</td>
              <td className={cx("px-4 py-2", mono)}>{j.model}</td>
              <td className="px-4 py-2">{j.lane}</td>
              <td className="px-4 py-2 text-dim">{j.caller}</td>
              <td className="px-4 py-2 text-dim">{j.offbox ? `${j.peer} (peer)` : j.backend}</td>
              <td className="tabular px-4 py-2 text-dim">{ago(j.since)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <Empty>Nothing queued or running.</Empty>}
    </Card>
  );
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);

type Call = NonNullable<UiData["calls"]>[number];
type Day = { calls: Call[]; minutes: { t: number; queued: number }[] };

/** A day of calls and queue depth, refetched every minute while shown. */
function useDay(on: boolean): Day | null {
  const [day, setDay] = useState<Day | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = async () => {
      try {
        const r = await fetch("/ui/history", { cache: "no-store" });
        if (r.ok && live) setDay((await r.json()) as Day);
      } catch { /* the header already says when the node is unreachable */ }
    };
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { live = false; clearInterval(id); };
  }, [on]);
  return day;
}

const BUCKET_MS = 15 * 60_000;

/** The day in 15-minute bars: finished requests (failures on top, in red) over the deepest queue. */
function DayChart({ day }: { day: Day }) {
  const now = Date.now();
  const start = now - 96 * BUCKET_MS;
  const ok = new Array<number>(96).fill(0);
  const bad = new Array<number>(96).fill(0);
  const deep = new Array<number>(96).fill(0);
  const at = (t: number) => Math.min(95, Math.floor((t - start) / BUCKET_MS));
  for (const c of day.calls) if (c.t >= start) (c.ok ? ok : bad)[at(c.t)]!++;
  for (const m of day.minutes) if (m.t >= start) deep[at(m.t)] = Math.max(deep[at(m.t)]!, m.queued);
  const top = Math.max(1, ...ok.map((n, i) => n + bad[i]!));
  const qtop = Math.max(4, ...deep);
  const W = 960;
  const H = 64;
  const bw = W / 96;
  const hours = [24, 18, 12, 6, 0];
  return (
    <div className="px-4 pt-3">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-16 w-full" aria-label="requests per 15 minutes over the last day">
        {deep.map((q, i) => q > 0 && <rect key={`q${i}`} x={i * bw} y={H - (q / qtop) * H} width={bw} height={(q / qtop) * H} fill="var(--warn)" opacity={0.12} />)}
        {ok.map((n, i) => {
          const h = ((n + bad[i]!) / top) * (H - 4);
          const hb = (bad[i]! / top) * (H - 4);
          return h > 0 && (
            <g key={i}>
              <rect x={i * bw + 1} y={H - h} width={bw - 2} height={h - hb} rx={1} fill="var(--ok)" opacity={0.75} />
              {hb > 0 && <rect x={i * bw + 1} y={H - hb} width={bw - 2} height={hb} fill="var(--bad)" />}
            </g>
          );
        })}
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--border)" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-dim">{hours.map((h) => <span key={h}>{h ? `${h}h ago` : "now"}</span>)}</div>
    </div>
  );
}

/** Finished requests per model over the last ten minutes or the last day: how many, how long they waited and ran. */
export function History() {
  const [range, setRange] = useState<"10m" | "24h">("10m");
  const live = useStore((s) => s.data!.calls ?? []);
  const day = useDay(range === "24h");
  const calls = range === "24h" ? day?.calls ?? [] : live;
  const by = new Map<string, Call[]>();
  for (const c of calls) by.set(c.model, [...(by.get(c.model) ?? []), c]);
  const rows = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  const longest = Math.max(1, ...rows.map(([, cs]) => pct(cs.map((c) => c.waitedMs + c.ms), 95)));
  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="mr-auto">
          <div className="font-medium">Recent requests</div>
          <div className="text-[11px] text-dim">Per model. The bar is p95 time: waiting, then running.</div>
        </div>
        <div role="group" aria-label="range" className="flex rounded-lg border border-line p-0.5 text-[12px]">
          {(["10m", "24h"] as const).map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}
                    className={cx("rounded-md px-2.5 py-1", range === r ? "bg-muted font-medium" : "text-dim hover:text-fg")}>
              {r === "10m" ? "10 min" : "24 h"}
            </button>
          ))}
        </div>
      </div>
      {range === "24h" && day && <DayChart day={day} />}
      <table className="w-full text-left">
        <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
          <tr>{["model", "requests", "failed", "wait p50", "run p50", "run p95", ""].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(([m, cs]) => {
            const wait95 = pct(cs.map((c) => c.waitedMs), 95);
            const run95 = pct(cs.map((c) => c.ms), 95);
            const failed = cs.filter((c) => !c.ok).length;
            return (
              <tr key={m} className="border-b border-line/60 last:border-0">
                <td className={cx("px-4 py-2", mono)}>{m}</td>
                <td className="tabular px-4 py-2">{cs.length}</td>
                <td className={cx("tabular px-4 py-2", failed ? "text-bad" : "text-dim")}>{failed}</td>
                <td className="tabular px-4 py-2 text-dim">{secs(pct(cs.map((c) => c.waitedMs), 50))}</td>
                <td className="tabular px-4 py-2">{secs(pct(cs.map((c) => c.ms), 50))}</td>
                <td className="tabular px-4 py-2">{secs(run95)}</td>
                <td className="w-1/4 px-4 py-2">
                  <div className="flex h-1.5 overflow-hidden rounded-full bg-line">
                    <span className="bg-warn" style={{ width: `${(wait95 / longest) * 100}%` }} />
                    <span className="bg-accent" style={{ width: `${(run95 / longest) * 100}%` }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <Empty>{range === "24h" && !day ? "loading…" : "No requests finished in this window."}</Empty>}
    </Card>
  );
}
