/**
 * Pipeline: what runs on a request, in the order it runs. One list, stage by stage, with hearth's own
 * steps between the stages; picking a router turns the list into that router's chain. Status shows only
 * when something is wrong. Plugins are set in hearth.yaml and read at startup; the page pauses one live.
 */
import { AlertTriangle, Ban, ChevronDown, ChevronRight, CircleDashed, Lock, Pause, PenLine, Search, X, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { PluginStage, PluginView, StageNumbers } from "./types.js";
import { AddPlugin } from "./AddPlugin.js";
import { go, pausePlugin, useStore } from "./store.js";
import { Button, Card, cx, mono, Switch } from "./ui.js";

const KINDS: { id: string; label: string }[] = [
  { id: "chat", label: "Chat" }, { id: "embeddings", label: "Embeddings" }, { id: "rerank", label: "Rerank" },
  { id: "image", label: "Images" }, { id: "video", label: "Video" }, { id: "speech", label: "Speech" },
  { id: "transcription", label: "Transcription" }, { id: "other", label: "Other" },
];

/** The spine, in run order: plugin stages and hearth's own steps between them. */
const SPINE: ({ stage: PluginStage; label: string; note?: string } | { step: string; says: string })[] = [
  { stage: "request", label: "Before routing" },
  { step: "Route", says: "picks the router, the rule and the model" },
  { stage: "routed", label: "After routing" },
  { step: "Queue and call the model", says: "waits for a slot, then runs it here or on a peer" },
  { stage: "parallel", label: "Beside the model" },
  { stage: "stream", label: "While streaming" },
  { stage: "response", label: "On the reply", note: "may change it" },
  { step: "Return the reply", says: "sends the answer to the caller" },
  { stage: "log", label: "After the reply", note: "observe only" },
  { stage: "error", label: "On error", note: "when any step above fails" },
];
const STAGE_LABEL = Object.fromEntries(SPINE.flatMap((s) => ("stage" in s ? [[s.stage, s.label]] : []))) as Record<PluginStage, string>;
/** Stages where a plugin can hold up or change the request, so its failure policy matters. */
const BLOCKING: PluginStage[] = ["request", "routed", "parallel", "response"];

/** Router and caller names as the Topology and Routing pages say them. */
const routerName = (r: string) => (r === "default" ? "default router" : r);
const whoUses = (callers: string[]) => (callers.length ? callers.map((c) => (c === "*" ? "everyone else" : c)).join(", ") : "nobody uses it yet");

const ms = (n: number) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
const pct = (n: StageNumbers) => (n.calls ? `${((n.errors / n.calls) * 100).toFixed(1)}% err` : "");
/** The quiet numbers on a healthy row: errors only when there are some. */
const quiet = (n: StageNumbers) => `p50 ${ms(n.p50)}${n.errors ? ` · ${pct(n)}` : ""} · ${n.calls} call${n.calls === 1 ? "" : "s"}`;

type Health = { tone: "bad" | "warn"; icon: typeof XCircle; word: string; detail?: string } | null;

/** Something wrong with a plugin at one stage; null when nothing is. */
function healthOf(p: PluginView, n: StageNumbers | undefined, stage: PluginStage | null): Health {
  if (p.state === "failed") return { tone: "bad", icon: XCircle, word: "Did not start", detail: p.error ?? undefined };
  if (p.pausedUntil > Date.now()) return { tone: "bad", icon: XCircle, word: "Resting after failures", detail: `back in ${Math.ceil((p.pausedUntil - Date.now()) / 1000)} s` };
  if (n && n.calls >= 5 && n.errors / n.calls >= 0.1) return { tone: "warn", icon: AlertTriangle, word: "Erroring", detail: pct(n) };
  if (n && stage && BLOCKING.includes(stage) && n.calls > 0 && n.p95 >= p.timeoutMs * 0.8) return { tone: "warn", icon: AlertTriangle, word: "Slow", detail: `p95 ${ms(n.p95)} of ${ms(p.timeoutMs)}` };
  return null;
}

/** Why a row will not run in this view, in grey; null when it runs. */
function mutedBy(p: PluginView, router: string | null, overrides: Record<string, "off" | "own">, live: boolean): { icon: typeof Pause; word: string } | null {
  if (!live) return { icon: CircleDashed, word: "Declared · not run by this version" };
  if (p.state === "off") return { icon: Pause, word: "Off: started with --no-plugins" };
  if (p.paused) return { icon: Pause, word: "Paused" };
  if (router && overrides[p.name] === "off") return { icon: Ban, word: `Off for ${routerName(router)}` };
  return null;
}

function Tier({ p }: { p: PluginView }) {
  return p.trust === "code"
    ? <span title="runs inside hearth, with hearth's own access" className="shrink-0 text-[11px] text-warn">in-process</span>
    : <span title="a service hearth calls; it is sent only what it reads" className="shrink-0 text-[11px] text-dim">HTTP</span>;
}

/** One row of the spine: a plugin at one stage. */
function Row({ p, stage, n, num, muted, own, changes, router, live, open, onOpen }: {
  p: PluginView; stage: PluginStage; n: StageNumbers | undefined; num: number | null; muted: ReturnType<typeof mutedBy>;
  own: boolean; /** The settings this router's entry changes, by name. */ changes: string[]; router: string | null; live: boolean; open: boolean; onOpen: () => void;
}) {
  const h = muted ? null : healthOf(p, n, stage);
  const kinds = Object.keys(p.declared);
  const liveKinds = useStore((s) => s.data?.pipeline?.liveKinds ?? []);
  const [busy, setBusy] = useState(false);
  return (
    <div className={cx("relative flex items-center gap-3 border-t border-line/60 py-2 pl-3 pr-3 first:border-t-0", open && "bg-muted/60", own && !muted && "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded before:bg-accent")}>
      <span className="tabular w-5 shrink-0 text-right text-[12px] text-dim">{num ?? ""}</span>
      <button onClick={onOpen} className="flex min-w-0 flex-1 flex-col text-left max-sm:gap-0.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="flex min-w-0 items-center gap-2 sm:w-44 sm:shrink-0">
          <span className={cx("truncate font-medium", muted && "text-dim")}>{p.name}</span>
          {p.locked && <span title="locked: no router can turn it off" className="flex shrink-0 items-center gap-1 text-[11px] text-dim"><Lock size={11} />Locked</span>}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[12px] text-dim">
          <Tier p={p} />
          <span className="flex shrink-0 gap-1">
            {kinds.slice(0, 2).map((k) => (
              <span key={k} className={cx("rounded border px-1 text-[10px]", p.kinds[k] && liveKinds.includes(k) ? "border-line" : "border-dashed border-line/80 opacity-70")}
                    title={!p.kinds[k] ? "declared; this config does not run it" : liveKinds.includes(k) ? undefined : "declared; this version of hearth does not run it yet"}>{k}</span>
            ))}
            {kinds.length > 2 && <span className="text-[10px]">+{kinds.length - 2}</span>}
          </span>
          <span className="ml-auto flex min-w-0 items-center gap-2">
            {h ? (
              <span className={cx("flex min-w-0 items-center gap-1", h.tone === "bad" ? "text-bad" : "text-warn")}>
                <h.icon size={13} className="shrink-0" /><b className="shrink-0 font-medium">{h.word}</b>{h.detail && <span className="truncate">· {h.detail}</span>}
              </span>
            ) : muted ? (
              <span className="flex items-center gap-1"><muted.icon size={12} />{muted.word}</span>
            ) : own ? (
              <span className="flex min-w-0 items-center gap-1 text-accent" title={changes.length ? `${router} sets ${changes.join(", ")} differently` : `${router} repeats the global settings`}>
                <PenLine size={12} className="shrink-0" /><span className="truncate">Own settings · {changes.length ? `changes ${changes.join(", ")}` : "same values"}</span>
              </span>
            ) : null}
            {!h && !muted && <span className="tabular shrink-0" title="since hearth started">{n?.calls ? quiet(n) : "no calls yet"}</span>}
            {muted && <span className="shrink-0" title="it did not run">—</span>}
          </span>
          <span className="w-28 shrink-0 text-right max-md:hidden" title="what happens when it cannot answer">{BLOCKING.includes(stage) ? `if it fails: ${p.onError === "skip" ? "continue" : "block"}` : ""}</span>
        </span>
      </button>
      <span className="w-9 shrink-0">
        {/* Pausing is global, so it is offered only in the global view. */}
        {p.state === "running" && live && !p.locked && router === null && (
          <span title={p.paused ? "resume everywhere" : "pause everywhere until restart"}>
            <Switch label={`${p.paused ? "Resume" : "Pause"} ${p.name}`} on={!p.paused} disabled={busy}
                    onChange={(on) => { setBusy(true); void pausePlugin(p.name, !on).finally(() => setBusy(false)); }} />
          </span>
        )}
      </span>
    </div>
  );
}

/** hearth's own step on the spine: fixed, never a plugin. */
function Step({ name, says }: { name: string; says: string }) {
  return (
    <div className="flex items-center gap-3 border-t border-line/60 bg-muted/30 py-1.5 pl-3 pr-3 text-[12px] text-dim">
      <span className="flex w-5 shrink-0 justify-end"><Lock size={11} aria-label="hearth's own step" /></span>
      <span className="font-medium text-fg/80">{name}</span>
      <span className="truncate max-sm:hidden">— {says}</span>
    </div>
  );
}

function Section({ n, label, note, rollup, count, runs, open, onToggle, children }: {
  n: number | null; label: string; note?: string; rollup: Health; count: number; /** How many of them run in this view, when not all do. */ runs?: number; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <section>
      <button onClick={onToggle} aria-expanded={open} className="sticky top-0 z-[1] flex w-full items-center gap-2 border-t border-line bg-panel px-3 py-2 text-left first:border-t-0">
        {open ? <ChevronDown size={14} className="text-dim" /> : <ChevronRight size={14} className="text-dim" />}
        {n !== null && <span className="tabular text-[11px] text-dim">{n}</span>}
        <span className="text-[12px] font-semibold uppercase tracking-wide">{label}</span>
        {note && <span className="text-[12px] text-dim max-sm:hidden">({note})</span>}
        <span className="ml-auto flex items-center gap-2 text-[12px] text-dim">
          {rollup && <span className={cx("flex items-center gap-1", rollup.tone === "bad" ? "text-bad" : "text-warn")}><rollup.icon size={13} />{rollup.word}</span>}
          {count} plugin{count === 1 ? "" : "s"}{runs !== undefined && runs < count ? ` · ${runs} run${runs === 1 ? "s" : ""}` : ""}
        </span>
      </button>
      {open && <div className="border-t border-line/60">{children}</div>}
    </section>
  );
}

/** A locked plugin that is skipped when it cannot answer: no router can turn it off, but an outage can. */
export function LockedOpen() {
  return (
    <div className="flex gap-2 rounded-md border border-warn/50 px-3 py-2 text-warn">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span>Locked, but requests carry on without it when it can't answer. If it is a check that must always hold, set <code className={mono}>onError: refuse</code> so they are blocked instead.</span>
    </div>
  );
}

/* ----------------------------------------------------------------- drawer */

const TABS = ["Overview", "Where it runs", "Routers", "Settings"] as const;

function Drawer({ p, routers, liveKinds, liveStages, onClose }: {
  p: PluginView; routers: Record<string, { plugins: Record<string, "off" | "own">; changes: Record<string, string[]>; callers: string[] }>; liveKinds: string[]; liveStages: PluginStage[]; onClose: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const h = healthOf(p, undefined, null);
  const kinds = KINDS.filter((k) => p.declared[k.id]);
  const stages = SPINE.flatMap((s) => ("stage" in s && (liveStages.includes(s.stage) || kinds.some((k) => p.declared[k.id]!.includes(s.stage))) ? [s.stage] : []));
  const rows = Object.entries(routers);
  const off = rows.filter(([, r]) => r.plugins[p.name] === "off").length;
  const own = rows.filter(([, r]) => r.plugins[p.name] === "own").length;
  const when = p.when ? Object.entries(p.when).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : Object.entries(v).map(([hd, vs]) => `${hd}${vs.length ? `=${vs.join("|")}` : ""}`).join(", ")}`) : [];
  return (
    <aside className="ml-4 flex w-[28rem] shrink-0 flex-col self-start overflow-hidden rounded-xl border border-line bg-panel max-lg:fixed max-lg:inset-0 max-lg:z-30 max-lg:self-stretch max-lg:ml-0 max-lg:w-full max-lg:rounded-none">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="font-semibold">{p.name}</span>
        <Tier p={p} />
        {p.locked && <span className="flex items-center gap-1 text-[11px] text-dim"><Lock size={11} />Locked</span>}
        <button className="ml-auto text-dim hover:text-fg" aria-label="close" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="flex gap-1 border-b border-line px-3" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                  className={cx("-mb-px flex items-center gap-1 border-b-2 px-2 py-2 text-[12px]", tab === t ? "border-accent text-fg" : "border-transparent text-dim hover:text-fg")}>
            {t}{t === "Overview" && h && <XCircle size={11} className="text-bad" aria-label="has a problem" />}
          </button>
        ))}
      </div>
      <div className="max-h-[70vh] overflow-auto px-4 py-3 text-[12px] max-lg:max-h-none max-lg:flex-1">
        {tab === "Overview" && (
          <div className="flex flex-col gap-3">
            {h && <div className="rounded-md border border-bad/40 px-3 py-2 text-bad"><b>{h.word}</b>{h.detail && <div className="mt-0.5 break-words">{h.detail}</div>}{p.state === "failed" && <div className="mt-1 text-dim">hearth tries again when it restarts.</div>}</div>}
            {p.locked && p.onError === "skip" && <LockedOpen />}
            <p className="text-dim">{p.trust === "code"
              ? "In-process: its code runs inside hearth with all of hearth's access. Install only code you have read."
              : `HTTP: a service hearth calls at each stage it hooks. It is sent the request's facts${p.reads.length ? ` and its ${p.reads.join(", ")}` : ""}, nothing else.`}</p>
            <div><div className="text-dim">source</div><div className={cx(mono, "break-all")}>{p.use}</div></div>
            <table className="w-full text-left">
              <thead className="text-[10px] uppercase tracking-wide text-dim">
                <tr><th className="py-1 font-medium">stage</th><th className="font-medium">calls</th><th className="font-medium">errors</th><th className="font-medium">said no</th><th className="font-medium">skipped</th><th className="font-medium">p50</th><th className="font-medium">p95</th></tr>
              </thead>
              <tbody className="tabular">
                {Object.entries(p.stages).map(([s, n]) => (
                  <tr key={s} className="border-t border-line/60">
                    <td className="py-1">{STAGE_LABEL[s as PluginStage] ?? s}</td><td>{n!.calls}</td><td className={n!.errors ? "text-bad" : undefined}>{n!.errors}</td>
                    <td>{n!.refused + n!.flagged}</td><td>{n!.skipped}</td><td>{ms(n!.p50)}</td><td>{ms(n!.p95)}</td>
                  </tr>
                ))}
                {Object.keys(p.stages).length === 0 && <tr><td colSpan={7} className="py-2 text-dim">No calls since hearth started.</td></tr>}
              </tbody>
            </table>
            <p className="text-dim">Counted since hearth started. Carried on without it {p.failOpens} time{p.failOpens === 1 ? "" : "s"} when it could not answer.</p>
          </div>
        )}
        {tab === "Where it runs" && (
          <div className="flex flex-col gap-2">
            <p className="text-dim">Filled: runs there. Dashed: declared, but not run — the reason is under the grid.</p>
            <div className="overflow-x-auto">
              <table className="text-center">
                <thead className="text-[10px] text-dim"><tr><th />{stages.map((s) => <th key={s} className="px-1.5 align-bottom font-medium">{STAGE_LABEL[s]}</th>)}</tr></thead>
                <tbody>
                  {kinds.map((k) => (
                    <tr key={k.id} className="border-t border-line/60">
                      <td className="py-1.5 pr-2 text-left">{k.label}</td>
                      {stages.map((s) => {
                        const decl = p.declared[k.id]?.includes(s);
                        const runs = decl && p.kinds[k.id]?.includes(s) && liveKinds.includes(k.id) && liveStages.includes(s);
                        return <td key={s}>{decl && <span className={cx("inline-block size-3 rounded-full", runs ? "bg-accent" : "border border-dashed border-dim")} aria-label={runs ? "runs" : "declared, not run"} />}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {kinds.length === 0 && <p className="text-dim">It did not start, so what it handles is unknown.</p>}
            {kinds.some((k) => !liveKinds.includes(k.id)) && <p className="text-dim">This version of hearth runs plugins on {liveKinds.join(", ")} only.</p>}
            {stages.some((s) => !liveStages.includes(s)) && <p className="text-dim">This version does not call {stages.filter((s) => !liveStages.includes(s)).map((s) => STAGE_LABEL[s].toLowerCase()).join(", ")} yet.</p>}
            {kinds.some((k) => (p.declared[k.id] ?? []).some((s) => !(p.kinds[k.id] ?? []).includes(s))) && <p className="text-dim">Its entry in hearth.yaml narrows <code className={mono}>kinds</code>, so some of what it declares is left out.</p>}
          </div>
        )}
        {tab === "Routers" && (
          <div className="flex flex-col gap-2">
            <p className="text-dim">Used by {rows.length} router{rows.length === 1 ? "" : "s"}{off ? ` · off in ${off}` : ""}{own ? ` · own settings in ${own}` : ""}. A router's entry replaces the global one{p.locked ? "; this plugin is locked, so none can turn it off" : ""}. Set them under <code className={mono}>routers.&lt;name&gt;.plugins</code>.</p>
            <table className="w-full text-left">
              <thead className="text-[10px] uppercase tracking-wide text-dim"><tr><th className="py-1 font-medium">router</th><th className="font-medium">here</th><th className="font-medium">used by</th></tr></thead>
              <tbody>
                {rows.map(([name, r]) => {
                  const o = r.plugins[p.name];
                  return (
                    <tr key={name} className="border-t border-line/60">
                      <td className="py-1.5">{routerName(name)}</td>
                      <td>{o === "off" ? <span className="flex items-center gap-1"><Ban size={11} />Off</span> : o === "own" ? <span className="flex items-center gap-1 text-accent" title="the names only; values stay in hearth.yaml"><PenLine size={11} />{r.changes[p.name]?.length ? `Changes ${r.changes[p.name]!.join(", ")}` : "Own settings, same values"}</span> : <span className="text-dim">Inherits global</span>}</td>
                      <td className="text-dim">{whoUses(r.callers)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {tab === "Settings" && (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-2 gap-y-1.5">
              <dt className="text-dim">when</dt><dd>{when.length ? when.map((w) => <div key={w} className={mono}>{w}</div>) : "every request it handles"}</dd>
              <dt className="text-dim">timeout</dt><dd>{ms(p.timeoutMs)}</dd>
              <dt className="text-dim">if it can't answer</dt><dd>{p.onError === "skip" ? "continue without it" : "block the request"}</dd>
              <dt className="text-dim">if it says no</dt><dd>{p.onFail === "refuse" ? "block the request" : "let it through, flagged"}</dd>
              <dt className="text-dim">locked</dt><dd>{p.locked ? "yes: no router can turn it off" : "no"}</dd>
              <dt className="text-dim">required</dt><dd>{p.required ? "yes: hearth will not start without it" : "no"}</dd>
            </dl>
            <p className="text-dim">Set under <code className={mono}>plugins.{p.name}</code> in hearth.yaml; read at startup.</p>
            <button className="self-start text-accent underline" onClick={() => go("config")}>Open Config</button>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------- page */

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const steps = ["Before routing", "Route", "After routing", "Model", "After the reply"];
  return (
    <Card className="mx-auto max-w-2xl p-6 text-center">
      <div className="text-base font-semibold">Plugins run your code or call your services at fixed points in every request.</div>
      <div className="mx-auto mt-4 flex flex-wrap items-center justify-center gap-1.5 text-[12px]">
        {steps.map((s, i) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cx("rounded-full border px-2 py-0.5", i % 2 === 0 ? "border-accent/60 text-accent" : "border-line text-dim")}>{s}</span>
            {i < steps.length - 1 && <ChevronRight size={12} className="text-dim" />}
          </span>
        ))}
      </div>
      <p className="mx-auto mt-4 max-w-lg text-dim">A service is sent only what you choose. Code that runs inside hearth gets all of hearth's access, so it is added in hearth.yaml by hand.</p>
      <div className="mt-4 flex items-center justify-center gap-3 text-[12px]">
        <Button tone="primary" onClick={onAdd}>Add plugin</Button>
        <a className="text-dim underline" href="https://github.com/Vcvzgbzz/hearth/blob/main/docs/plugins.md" target="_blank" rel="noopener">How plugins work</a>
      </div>
    </Card>
  );
}

type Filter = "all" | "attention" | "overridden" | "paused";

export function Pipeline() {
  const pl = useStore((s) => s.data?.pipeline);

  const [kind, setKind] = useState("chat");
  const [router, setRouter] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);

  if (!pl) return <Card className="p-6 text-center text-dim">This hearth does not report plugins.</Card>;
  if (pl.plugins.length === 0) return <><EmptyState onAdd={() => setAdding(true)} />{adding && <AddPlugin onClose={() => setAdding(false)} />}</>;

  const overrides = router ? pl.routers[router]?.plugins ?? {} : {};
  const live = pl.liveKinds.includes(kind);
  const failed = pl.plugins.filter((p) => p.state === "failed");
  const onKind = pl.plugins.filter((p) => p.declared[kind] !== undefined && p.state !== "failed");
  const total = pl.plugins.length;
  const attention = (p: PluginView) => p.state === "failed" || p.pausedUntil > Date.now() || Object.entries(p.stages).some(([s, n]) => healthOf(p, n, s as PluginStage) !== null);
  const counts = {
    attention: pl.plugins.filter(attention).length,
    overridden: Object.keys(overrides).length,
    paused: pl.plugins.filter((p) => p.paused).length,
  };
  const keep = (p: PluginView) => (!q || p.name.includes(q.toLowerCase()))
    && (filter === "all" || (filter === "attention" ? attention(p) : filter === "overridden" ? overrides[p.name] !== undefined : p.paused));
  const liveStage = (s: PluginStage) => live && pl.liveStages.includes(s);

  // Rows numbered in run order, counting only those that run; `log` and `error` go in reverse of config order.
  let num = 0;
  const spine = SPINE.map((s) => {
    if (!("stage" in s)) return s;
    const here = onKind.filter((p) => p.declared[kind]!.includes(s.stage));
    const rows = (s.stage === "log" || s.stage === "error" ? [...here].reverse() : here).map((p) => {
      const isLive = liveStage(s.stage) && !!p.kinds[kind]?.includes(s.stage);
      const muted = mutedBy(p, router, overrides, isLive);
      return { p, muted, live: isLive, num: muted ? null : ++num };
    });
    return { ...s, rows };
  });
  // A stage the runtime does not call yet goes in the closing section, never as a section of its own.
  const inSpine = (s: PluginStage) => pl.liveStages.includes(s);
  const later = spine.flatMap((s) => ("rows" in s && !inSpine(s.stage) ? s.rows.map((r) => ({ ...r, stage: s.stage, label: s.label })) : []));
  const sel = pl.plugins.find((p) => p.name === picked) ?? null;
  const running = pl.plugins.filter((p) => p.state === "running" && !p.paused).length;
  const toggle = (key: string, open: boolean) => setClosed({ ...closed, [key]: open });
  let sn = 0;

  return (
    <div className="flex items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <label className="flex items-center gap-2 text-dim max-sm:w-full">
            Viewing as
            <select value={router ?? ""} onChange={(e) => setRouter(e.target.value || null)} className="h-8 rounded-md border border-line bg-bg px-2 text-fg max-sm:flex-1">
              <option value="">All callers (global)</option>
              {Object.keys(pl.routers).map((n) => <option key={n} value={n}>{routerName(n)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-dim max-sm:w-full">
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-8 rounded-md border border-line bg-bg px-2 text-fg max-sm:flex-1">
              {KINDS.map((k) => {
                const c = pl.plugins.filter((p) => p.declared[k.id] !== undefined).length;
                return <option key={k.id} value={k.id}>{k.label} · {pl.liveKinds.includes(k.id) ? c : c ? `${c}, not run yet` : "not run yet"}</option>;
              })}
            </select>
          </label>
          {total >= 8 && (
            <label className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-bg px-2 max-sm:w-full">
              <Search size={13} className="text-dim" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search plugins" aria-label="search plugins" className="min-w-0 flex-1 bg-transparent outline-none" />
            </label>
          )}
          <span className="ml-auto text-dim max-sm:hidden">{total} plugin{total === 1 ? "" : "s"} · {running} running{failed.length ? ` · ${failed.length} failed` : ""}{counts.paused ? ` · ${counts.paused} paused` : ""}</span>
          <Button tone="primary" onClick={() => setAdding(true)}>Add plugin</Button>
        </div>
        {adding && <AddPlugin onClose={() => setAdding(false)} />}

        {counts.attention + counts.overridden + counts.paused > 0 && (
          <div className="flex gap-1.5 overflow-x-auto text-[12px]" role="group" aria-label="filter">
            {([["all", "All", total], ["attention", "Needs attention", counts.attention], ["overridden", `Changed by ${router ? routerName(router) : "a router"}`, counts.overridden], ["paused", "Paused", counts.paused]] as const)
              .filter(([id, , c]) => id === "all" || c > 0)
              .map(([id, label, c]) => (
                <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}
                        className={cx("h-7 shrink-0 rounded-full border px-3", filter === id ? "border-accent bg-panel text-accent" : "border-line bg-panel hover:bg-muted")}>
                  {label} <span className="tabular opacity-70">{c}</span>
                </button>
              ))}
          </div>
        )}

        {router && (
          <div className="rounded-md border border-line bg-panel px-3 py-2 text-[12px]">
            Showing what runs for the <b>{routerName(router)}</b>{router === "default" ? "" : " router"} ({whoUses(pl.routers[router]!.callers)})
            {counts.overridden ? ` · ${counts.overridden} difference${counts.overridden === 1 ? "" : "s"} from global` : " · same as global"}.
            <span className="text-dim"> Pausing applies to every router, so it is offered under All callers.</span>
          </div>
        )}
        {!live && (
          <div className="flex items-start gap-2 rounded-md border border-dashed border-line bg-panel px-3 py-2 text-[12px]">
            <CircleDashed size={14} className="mt-0.5 shrink-0 text-dim" />
            <span>This version runs plugins on {pl.liveKinds.join(", ")} requests only. {onKind.length ? `The plugins below declare ${kind} and will start running when support ships.` : `No plugin declares ${kind}; these requests go straight to routing and the model.`}</span>
          </div>
        )}

        <Card className="overflow-clip">
          {pl.pending.length > 0 && (
            <Section n={null} label="Waiting for a restart" note="in hearth.yaml, not loaded yet" count={pl.pending.length} rollup={null}
                     open={!closed.pending} onToggle={() => toggle("pending", !closed.pending)}>
              {pl.pending.map((c) => (
                <div key={c.name} className="flex items-center gap-3 border-t border-line/60 py-2 pl-11 pr-3 text-[12px] first:border-t-0">
                  <span className={cx("font-medium", c.change === "removed" && "line-through")}>{c.name}</span>
                  <span className={c.change === "added" ? "text-ok" : c.change === "removed" ? "text-bad" : "text-warn"}>{c.change}</span>
                  <span className="text-dim">{c.change === "added" ? "starts when hearth restarts" : c.change === "removed" ? "keeps running until hearth restarts" : "runs with its old settings until hearth restarts"}</span>
                </div>
              ))}
            </Section>
          )}
          {failed.filter(keep).length > 0 && (
            <Section n={null} label="Did not start" note="runs on nothing" count={failed.length} rollup={{ tone: "bad", icon: XCircle, word: `${failed.length} failed` }}
                     open={!closed.failed} onToggle={() => toggle("failed", !closed.failed)}>
              {failed.filter(keep).map((p) => (
                <button key={p.name} onClick={() => setPicked(p.name)} className={cx("flex w-full items-center gap-3 border-t border-line/60 py-2 pl-11 pr-3 text-left first:border-t-0", picked === p.name && "bg-muted/60")}>
                  <span className="font-medium">{p.name}</span><Tier p={p} />
                  <span className="flex min-w-0 items-center gap-1 text-[12px] text-bad"><XCircle size={13} className="shrink-0" /><span className="truncate">{p.error}</span></span>
                </button>
              ))}
            </Section>
          )}
          {spine.map((s, i) => {
            if (!("stage" in s)) return <Step key={i} name={s.step} says={s.says} />;
            if (!inSpine(s.stage)) return null;
            const rows = s.rows.filter((r) => keep(r.p));
            const healths = rows.map((r) => (r.muted ? null : healthOf(r.p, r.p.stages[s.stage], s.stage)));
            const roll = healths.find((h) => h?.tone === "bad") ?? healths.find((h) => h) ?? null;
            const open = closed[s.stage] === undefined ? !(total >= 20 && !roll) : !closed[s.stage];
            return (
              <Section key={s.stage} n={++sn} label={s.label} note={s.note} count={s.rows.length} runs={s.rows.filter((r) => !r.muted).length} rollup={roll}
                       open={open} onToggle={() => toggle(s.stage, open)}>
                {rows.length
                  ? rows.map((r) => (
                      <Row key={r.p.name} p={r.p} stage={s.stage} n={r.p.stages[s.stage]} num={r.num} muted={r.muted} own={overrides[r.p.name] === "own"} changes={pl.routers[router ?? ""]?.changes[r.p.name] ?? []}
                           router={router} live={r.live} open={picked === r.p.name} onOpen={() => setPicked(picked === r.p.name ? null : r.p.name)} />
                    ))
                  : <div className="py-2 pl-11 text-[12px] text-dim">{s.rows.length ? "None match the filter." : "Nothing runs here."}</div>}
              </Section>
            );
          })}
          {later.length > 0 && (
            <Section n={null} label="Declared stages not run yet" note="this version does not call them" count={later.length} rollup={null}
                     open={closed.later === false} onToggle={() => toggle("later", closed.later === false)}>
              {later.filter((r) => keep(r.p)).map((r) => (
                <button key={`${r.stage}:${r.p.name}`} onClick={() => setPicked(r.p.name)} className="flex w-full items-center gap-3 border-t border-line/60 py-2 pl-11 pr-3 text-left text-[12px] text-dim first:border-t-0">
                  <CircleDashed size={12} /><span className="font-medium">{r.p.name}</span>{r.label}
                </button>
              ))}
            </Section>
          )}
        </Card>
        <p className="text-[12px] text-dim">
          In-process plugins run with hearth's own access; HTTP plugins are sent only what they read. A router's settings replace the global ones, and a locked plugin can't be turned off.
          The switch pauses a plugin everywhere until resumed or restarted; the rest is set in hearth.yaml.
        </p>
      </div>
      {sel && <Drawer p={sel} routers={pl.routers} liveKinds={pl.liveKinds} liveStages={pl.liveStages} onClose={() => setPicked(null)} />}
    </div>
  );
}
