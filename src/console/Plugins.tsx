/**
 * Plugins: every plugin this node has, what it handles, the models wired into its slots, the lines it
 * runs on and how it is doing, with a panel to wire its models and pause it. Where a plugin runs is
 * decided on the Routing map, where it is a block on a line; this page links to each.
 */
import { AlertTriangle, CircleDashed, Lock, Pause, ShieldAlert, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { AddPlugin } from "./AddPlugin.js";
import { Review, type File, type Plan } from "./config.js";
import { showRouter } from "./editStore.js";
import { modelsOfKind } from "./flowNodes.js";
import type { PluginStage, PluginView, PluginsView } from "./types.js";
import { go, openYaml, pausePlugin, refresh, request, toast, useStore } from "./store.js";
import { Button, Card, cx, mono, Switch } from "./ui.js";

const NO_MODELS: string[] = [];
const STAGE_LABEL: Record<string, string> = {
  request: "Before routing", routed: "On its line", parallel: "Beside the model", stream: "While streaming",
  response: "On the reply", log: "After the reply", error: "On error",
};
/** Stages where a plugin can hold up or change the request, so its failure policy matters. */
const BLOCKING: PluginStage[] = ["request", "routed", "parallel", "response"];

const ms = (n: number) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
const routerName = (r: string) => (r === "default" ? "default router" : r);
const CHIP = "rounded border px-1.5 text-[11px]";

type Status = { tone: "bad" | "warn" | "dim" | "ok"; word: string };

/** A plugin that only serves an API: it hooks nothing, so lines, kinds and stages say nothing about it. */
export const servesOnly = (p: PluginView): boolean => (p.serves !== null || p.run !== null) && Object.keys(p.declared).length === 0;

/** Where a plugin that serves is reached, and for an MCP server where its endpoint is. */
export const servedAt = (p: PluginView): string => `/plugins/${p.name}${p.mcp ? p.mcp.path : "/"}`;

/** The one thing to say about a plugin in its row: a problem when there is one, else how fast it answers. */
function statusOf(p: PluginView, pv: PluginsView): Status {
  if (p.state === "failed") return { tone: "bad", word: "did not start" };
  if (p.state === "off") return { tone: "dim", word: "off (--no-plugins)" };
  if (p.pausedUntil > Date.now()) return { tone: "bad", word: "resting after failures" };
  const all = Object.values(p.stages);
  const calls = all.reduce((a, n) => a + n!.calls, 0);
  const errors = all.reduce((a, n) => a + n!.errors, 0);
  if (calls >= 5 && errors / calls >= 0.1) return { tone: "warn", word: `${Math.round((errors / calls) * 100)}% errors` };
  for (const [stage, n] of Object.entries(p.stages)) {
    if (BLOCKING.includes(stage as PluginStage) && n!.calls > 0 && n!.p95 >= p.timeoutMs * 0.8) return { tone: "warn", word: "slow" };
  }
  if (p.paused) return { tone: "dim", word: "paused" };
  if (servesOnly(p)) {
    if (p.mcp?.error) return { tone: p.mcp.error === "starting" || p.mcp.error === "checking" ? "dim" : "warn", word: p.mcp.error === "starting" || p.mcp.error === "checking" ? `MCP ${p.mcp.error}` : "MCP not answering" };
    const { calls, errors } = p.served;
    if (calls >= 5 && errors / calls >= 0.1) return { tone: "warn", word: `${Math.round((errors / calls) * 100)}% errors` };
    const tools = p.mcp?.tools != null ? `${p.mcp.tools} tools` : null;
    return { tone: "ok", word: [tools, calls ? `${calls} served` : tools ? null : "no calls yet"].filter(Boolean).join(" · ") };
  }
  if (!p.everyLine && !pv.placed.some((x) => x.plugin === p.name)) return { tone: "dim", word: "on no line" };
  if (emptySlots(p, pv).length) return { tone: "warn", word: "needs a model" };
  const fast = p.stages.routed ?? p.stages.request ?? p.stages.log;
  return { tone: "ok", word: fast?.calls ? `p50 ${ms(fast.p50)}` : "no calls yet" };
}

/** Required slots left empty on some line it is placed on, or on the plugin itself when it runs on every line. */
function emptySlots(p: PluginView, pv: PluginsView): string[] {
  const wirings = p.everyLine ? [{}] : pv.placed.filter((x) => x.plugin === p.name).map((x) => x.models);
  return Object.entries(p.needs).filter(([slot, n]) => !n.optional && wirings.some((w) => !(w[slot] ?? p.models[slot]))).map(([slot]) => slot);
}

const TONE: Record<Status["tone"], string> = { bad: "text-bad", warn: "text-warn", dim: "text-dim", ok: "text-dim" };

function Tier({ p }: { p: PluginView }) {
  return p.trust === "code"
    ? <span title="runs inside hearth, with hearth's own access" className="text-warn">in-process</span>
    : <span title="a service hearth calls; it is sent only what it reads" className="text-dim">HTTP</span>;
}

function Kinds({ p, live }: { p: PluginView; live: string[] }) {
  if (servesOnly(p)) return p.mcp ? <span className={cx(CHIP, "border-line")} title="an MCP server: callers list and call its tools at its /mcp">MCP</span> : <span className={cx(CHIP, "border-line")} title="it serves its own API and changes no requests">API</span>;
  const kinds = Object.keys(p.declared);
  if (!kinds.length) return <span className="text-dim">unknown</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {kinds.map((k) => {
        const runs = !!p.kinds[k] && live.includes(k);
        return <span key={k} className={cx(CHIP, runs ? "border-line" : "border-dashed border-line text-dim")} title={runs ? undefined : p.kinds[k] ? "declared; this version of hearth does not run it yet" : "declared; its entry in hearth.yaml leaves it out"}>{k}</span>;
      })}
    </span>
  );
}

/** Where a plugin runs, said in a few words. */
function usedOn(p: PluginView, pv: PluginsView): string {
  if (servesOnly(p)) return servedAt(p);
  if (p.everyLine) return "every line";
  const n = pv.placed.filter((x) => x.plugin === p.name).length;
  return n === 0 ? "on no line" : `${n} line${n === 1 ? "" : "s"}`;
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

const H = "text-[11px] font-medium uppercase tracking-wide text-dim";

/** Show a line on the Routing map, in the rules of the router it belongs to. */
const showLine = (router: string) => { go("routing"); showRouter(router === "default" ? null : router); };

/** One plugin: what it is, where it runs, its model slots, what it is sent, how it fails, its numbers. */
function Panel({ p, pv, onClose, onWire, onFallback }: { p: PluginView; pv: PluginsView; onClose: () => void; onWire: (slot: string, model: string | null) => void; onFallback: (to: { plugin: string; adapt: string | null } | null) => void }) {
  // A fallback is another plugin that serves an API other than MCP.
  const others = pv.plugins.filter((x) => x.name !== p.name && x.serves !== null && x.mcp === null).map((x) => x.name);
  const catalog = useStore((s) => s.data?.catalog) ?? NO_MODELS;
  const [busy, setBusy] = useState(false);
  const lines = pv.placed.filter((x) => x.plugin === p.name);
  const offFor = Object.entries(pv.routers).filter(([, r]) => r.plugins[p.name] === "off").map(([n]) => routerName(n));
  const st = statusOf(p, pv);
  return (
    <aside className="flex w-[26rem] shrink-0 flex-col self-start overflow-hidden rounded-xl border border-line bg-panel max-lg:fixed max-lg:inset-0 max-lg:z-30 max-lg:w-full max-lg:self-stretch max-lg:rounded-none">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-[15px] font-semibold">{p.name}</span>
        <span className="text-[11px]"><Tier p={p} /></span>
        {p.locked && <span className="flex items-center gap-1 text-[11px] text-dim"><Lock size={11} />locked</span>}
        <span className="ml-auto" />
        {p.state === "running" && !p.locked && (
          <span className="flex items-center gap-1.5 text-[12px] text-dim" title="pauses it everywhere until resumed or restarted">
            {p.paused ? "paused" : "running"}
            <Switch label={`${p.paused ? "Resume" : "Pause"} ${p.name}`} on={!p.paused} disabled={busy} onChange={(on) => { setBusy(true); void pausePlugin(p.name, !on).finally(() => setBusy(false)); }} />
          </span>
        )}
        <button className="text-dim hover:text-fg" aria-label="close" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="flex max-h-[75vh] flex-col gap-4 overflow-auto px-4 py-3 text-[12px] max-lg:max-h-none max-lg:flex-1">
        {!servesOnly(p) && <div className={cx(mono, "break-all text-dim")}>{p.use}</div>}
        {p.state === "failed" && <div className="rounded-md border border-bad/40 px-3 py-2 text-bad"><b>Did not start.</b> {p.error}<div className="mt-1 text-dim">hearth tries again when it restarts.</div></div>}
        {st.tone !== "ok" && p.state !== "failed" && <div className={cx("rounded-md border px-3 py-2", st.tone === "bad" ? "border-bad/40 text-bad" : st.tone === "warn" ? "border-warn/50 text-warn" : "border-line text-dim")}>{st.word}</div>}
        {p.locked && p.onError === "skip" && <LockedOpen />}

        {p.run !== null && (
          <section className="flex flex-col gap-1.5">
            <div className={H}>Runs</div>
            <code className={cx(mono, "break-all")}>{p.run}</code>
            <span className="text-dim">hearth starts this program and speaks MCP to it over its stdin and stdout; callers reach it at <code className={mono}>{servedAt(p)}</code>. It runs with hearth's own access.</span>
          </section>
        )}
        {p.mcp && (
          <section className="flex flex-col gap-1.5">
            <div className={H}>MCP</div>
            {p.mcp.error ? <span className={p.mcp.error === "starting" || p.mcp.error === "checking" ? "text-dim" : "text-warn"}>{p.mcp.error}</span>
              : <span>{p.mcp.server ?? "an MCP server"} · <span className="tabular">{p.mcp.tools ?? 0}</span> tool{p.mcp.tools === 1 ? "" : "s"}</span>}
            {p.mcp.checkedAt > 0 && <span className="text-dim">{p.mcp.transport === "http" ? "Asked again every minute" : "Asked when it started"}; last at {new Date(p.mcp.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</span>}
          </section>
        )}
        {(p.serves !== null || p.run !== null) && (
          <section className="flex flex-col gap-1.5">
            <div className={H}>Serves</div>
            {p.serves !== null ? <span><code className={mono}>/plugins/{p.name}/…</code> goes to <code className={cx(mono, "break-all")}>{p.serves}/…</code></span>
              : <span><code className={mono}>{servedAt(p)}</code> goes to the program above.</span>}
            <span className="text-dim">For this machine and api keys, not peers or keys limited to models. The caller's key stays here; {p.trust === "http" ? "the plugin's own key is sent instead, with who is calling." : ""}</span>
            <span className="text-dim tabular">{p.served.calls} request{p.served.calls === 1 ? "" : "s"} since hearth started{p.served.errors ? <>, <span className="text-bad">{p.served.errors} it could not answer</span></> : ""}.</span>
          </section>
        )}
        {p.serves !== null && p.mcp === null && (
          <section className="flex flex-col gap-1.5">
            <div className={H}>Falls back to</div>
            <select value={p.fallback?.plugin ?? ""} onChange={(e) => onFallback(e.target.value ? { plugin: e.target.value, adapt: p.fallback?.adapt ?? null } : null)} aria-label={`plugin that answers when ${p.name} cannot`}
                    className="h-8 min-w-0 rounded-md border border-line bg-bg px-2">
              <option value="">nobody: the caller is told it failed</option>
              {others.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            {p.fallback && (
              <select value={p.fallback.adapt ?? ""} onChange={(e) => onFallback({ plugin: p.fallback!.plugin, adapt: e.target.value || null })} aria-label="how the request is carried over"
                      className="h-8 min-w-0 rounded-md border border-line bg-bg px-2">
                <option value="">the same request: it speaks the same API</option>
                {(pv.adapters ?? []).map((a) => <option key={a.name} value={a.name}>{a.name}: {a.desc}</option>)}
              </select>
            )}
            <span className="text-dim">Asked when {p.name} cannot be reached, answers 5xx or 429, or is paused. One hop: its own fallback is not followed.{others.length === 0 ? " No other plugin serves an API yet." : ""}</span>
          </section>
        )}

        {!servesOnly(p) && <>
        <section className="flex flex-col gap-1.5">
          <div className={H}>Handles</div>
          <Kinds p={p} live={pv.liveKinds} />
          {Object.keys(p.declared).some((k) => !pv.liveKinds.includes(k)) && <span className="text-dim">Dashed: this version of hearth runs plugins on {pv.liveKinds.join(", ")} only.</span>}
        </section>

        <section className="flex flex-col gap-1.5">
          <div className={H}>Runs on</div>
          {p.everyLine ? (
            <span>Every line, before routing and after{offFor.length ? `, except for the ${offFor.join(", ")}` : ""}. It shows as a badge on the router, not a block.</span>
          ) : lines.length ? (
            lines.map((x) => (
              <div key={`${x.router}/${x.flow}/${x.step}`} className="flex items-center justify-between gap-2">
                <span>{routerName(x.router)} › <span className={mono}>{x.flow}</span> · line {x.step + 1}</span>
                <button className="shrink-0 text-accent underline" onClick={() => showLine(x.router)}>show on Routing</button>
              </div>
            ))
          ) : (
            <span className="text-dim">On no line, so it runs on nothing. Put it on one from the line's ⋯ menu on the <button className="text-accent underline" onClick={() => go("routing")}>Routing map</button>.</span>
          )}
        </section>

        {Object.keys(p.needs).length > 0 && (
          <section className="flex flex-col gap-2">
            <div className={H}>Model slots</div>
            {Object.entries(p.needs).map(([slot, n]) => {
              const options = modelsOfKind(pv, catalog, n.kind);
              const here = lines.filter((x) => x.models[slot]);
              return (
                <div key={slot} className="flex flex-col gap-1">
                  <label className="flex items-center gap-2">
                    <span className="w-24 shrink-0">{slot} <span className="text-dim">· {n.kind}</span></span>
                    <select value={p.models[slot] ?? ""} onChange={(e) => onWire(slot, e.target.value || null)} aria-label={`model for the ${slot} slot`}
                            className={cx("h-8 min-w-0 flex-1 rounded-md border bg-bg px-2", !p.models[slot] && !n.optional ? "border-warn" : "border-line")}>
                      <option value="">{n.optional ? "none (optional)" : "pick a model"}</option>
                      {options.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                  {options.length === 0 && <span className="text-warn">No {n.kind} model yet: give one <code className={mono}>kind: {n.kind}</code> under Models.</span>}
                  {here.map((x) => <span key={`${x.flow}/${x.step}`} className="pl-26 text-dim">{routerName(x.router)} › {x.flow} line {x.step + 1} wires its own: <span className={mono}>{x.models[slot]}</span></span>)}
                </div>
              );
            })}
            <span className="text-dim">Wired here, a model is the default on every line; a line can wire its own from its block. Changes here apply after a restart.</span>
          </section>
        )}

        <section className="flex flex-col gap-1">
          <div className={H}>Is sent</div>
          <span>{p.trust === "code" ? "Everything: it runs inside hearth." : ["the request's facts", ...p.reads].join(", ")}</span>
        </section>

        <section className="flex flex-col gap-1">
          <div className={H}>When it fails</div>
          <span>Can't answer: {p.onError === "skip" ? "continue without it" : "block the request"} · says no: {p.onFail === "refuse" ? "block the request" : "let it through, flagged"} · timeout {ms(p.timeoutMs)}</span>
          <span className="text-dim">Carried on without it {p.failOpens} time{p.failOpens === 1 ? "" : "s"} since hearth started.</span>
        </section>

        <section className="flex flex-col gap-1">
          <div className={H}>Numbers since hearth started</div>
          <table className="w-full text-left">
            <thead className="text-[10px] uppercase tracking-wide text-dim">
              <tr><th className="py-1 font-medium">when</th><th className="font-medium">calls</th><th className="font-medium">errors</th><th className="font-medium">said no</th><th className="font-medium">p50</th><th className="font-medium">p95</th></tr>
            </thead>
            <tbody className="tabular">
              {Object.entries(p.stages).map(([s, n]) => (
                <tr key={s} className="border-t border-line/60">
                  <td className="py-1">{STAGE_LABEL[s] ?? s}</td><td>{n!.calls}</td><td className={n!.errors ? "text-bad" : undefined}>{n!.errors}</td><td>{n!.refused + n!.flagged}</td><td>{ms(n!.p50)}</td><td>{ms(n!.p95)}</td>
                </tr>
              ))}
              {Object.keys(p.stages).length === 0 && <tr><td colSpan={6} className="py-2 text-dim">No calls yet.</td></tr>}
            </tbody>
          </table>
        </section>
        </>}

        <section className="flex flex-col gap-1">
          <div className={H}>Its own settings</div>
          <span className="text-dim">Under <code className={mono}>plugins.{p.name}.config</code> in hearth.yaml, read at startup.</span>
          <button className="self-start text-accent underline" onClick={() => openYaml(["plugins", p.name])}>Open in hearth.yaml</button>
        </section>
      </div>
    </aside>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Card className="mx-auto max-w-2xl p-6 text-center">
      <div className="text-base font-semibold">Plugins read or change requests on their way to a model.</div>
      <p className="mx-auto mt-2 max-w-lg text-dim">Add one here, then put it on a line on the Routing map: the request goes in, the changed request comes out and carries on to the model. A plugin that needs models of its own, like an embedder, has slots you wire.</p>
      <div className="mx-auto mt-4 flex flex-wrap items-center justify-center gap-1.5 text-[12px]">
        <span className="rounded-full border border-line px-2 py-0.5 text-dim">type</span><span className="text-dim">→</span>
        <span className="rounded-full border border-line px-2 py-0.5 text-dim">rule</span><span className="text-dim">→</span>
        <span className="rounded-full border border-accent/70 px-2 py-0.5 text-accent">plugin</span><span className="text-dim">→</span>
        <span className="rounded-full border border-line px-2 py-0.5 text-dim">model</span>
      </div>
      <p className="mx-auto mt-4 max-w-lg text-dim">A service is sent only what you choose. Code that runs inside hearth gets all of hearth's access, so it is added in hearth.yaml by hand.</p>
      <div className="mt-4 flex items-center justify-center gap-3 text-[12px]">
        <Button tone="primary" onClick={onAdd}>Add plugin</Button>
        <a className="text-dim underline" href="https://github.com/Vcvzgbzz/hearth/blob/main/docs/plugins.md" target="_blank" rel="noopener">How plugins work</a>
      </div>
    </Card>
  );
}

export function Plugins() {
  const pv = useStore((s) => s.data?.plugins);
  const picked = useStore((s) => s.plugin);
  const [adding, setAdding] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  useEffect(() => () => useStore.setState({ plugin: null }), []);
  const pick = (name: string | null) => useStore.setState({ plugin: name });

  if (!pv) return <Card className="p-6 text-center text-dim">This hearth does not report plugins.</Card>;
  if (pv.plugins.length === 0 && pv.pending.length === 0) return <><EmptyState onAdd={() => setAdding(true)} />{adding && <AddPlugin onClose={() => setAdding(false)} />}</>;

  /** Write a plugin's slot wiring through the usual review. */
  const wire = (name: string, slot: string, model: string | null) =>
    propose([{ path: ["plugins", name, "models", slot], ...(model === null ? { delete: true } : { value: model }) }], "wire it",
      model === null ? `empties ${name}'s ${slot} slot` : `wires ${model} into ${name}'s ${slot} slot, the default on every line it runs on`);

  /** Write the plugin that answers for this one when it cannot, through the usual review. */
  const fallBack = (name: string, to: { plugin: string; adapt: string | null } | null) =>
    propose([{ path: ["plugins", name, "fallback"], ...(to === null ? { delete: true } : { value: to.adapt === null ? to.plugin : to }) }], "save it",
      to === null ? `${name} gets no fallback: when it cannot answer, the caller is told so` : `when ${name} cannot answer, ${to.plugin} does${to.adapt ? `, through the ${to.adapt} adapter` : ", sent the same request"}`);

  /** Show a config change in the usual review, and write it if it is kept. */
  const propose = (ops: unknown[], verb: string, line: string) => void (async () => {
    try {
      const file = await request<File>("GET", "/config");
      const body = { baseHash: file.hash, ops };
      const dry = await request<{ text: string; restartPending: string[] }>("PATCH", "/config", { ...body, dryRun: true });
      setPlan({
        before: file.text, after: dry.text, restartPending: dry.restartPending, verb,
        summary: [line],
        commit: async () => {
          try {
            await request("PATCH", "/config", body);
            toast("ok", "saved — restart hearth to apply it");
            await refresh();
          } catch (e) {
            toast("bad", e instanceof Error ? e.message : String(e));
          }
          setPlan(null);
        },
      });
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
    }
  })();

  const sel = pv.plugins.find((p) => p.name === picked) ?? null;
  const running = pv.plugins.filter((p) => p.state === "running" && !p.paused).length;
  const failed = pv.plugins.filter((p) => p.state === "failed").length;
  const cols = "grid grid-cols-[minmax(0,1.2fr)_88px_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1fr)] items-center gap-3 max-md:grid-cols-[minmax(0,1fr)_auto]";

  return (
    <div className="flex items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[15px] font-semibold">Plugins</h1>
          <span className="text-[12px] text-dim">{pv.plugins.length} installed · {running} running{failed ? ` · ${failed} did not start` : ""}</span>
          <span className="ml-auto" />
          <Button tone="primary" onClick={() => setAdding(true)}>Add plugin</Button>
        </div>

        {pv.pending.length > 0 && (
          <Card className="px-4 py-3 text-[12px]">
            <div className={H}>Waiting for a restart</div>
            {pv.pending.map((c) => (
              <div key={c.name} className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className={cx("font-medium", c.change === "removed" && "line-through")}>{c.name}</span>
                <span className={c.change === "added" ? "text-ok" : c.change === "removed" ? "text-bad" : "text-warn"}>{c.change}</span>
                <span className="text-dim">{c.change === "added" ? "starts when hearth restarts" : c.change === "removed" ? "keeps running until hearth restarts" : "runs with its old settings until hearth restarts"}</span>
              </div>
            ))}
          </Card>
        )}

        <Card className="overflow-hidden">
          <div className={cx(cols, "border-b border-line px-4 py-2 text-[11px] uppercase tracking-wide text-dim")}>
            <span>Plugin</span><span className="max-md:hidden">Runs as</span><span className="max-md:hidden">Handles</span><span className="max-md:hidden">Needs</span><span className="max-md:hidden">Runs on</span><span className="max-md:text-right">Status</span>
          </div>
          {pv.plugins.map((p) => {
            const st = statusOf(p, pv);
            const needs = Object.entries(p.needs);
            return (
              <button key={p.name} onClick={() => pick(sel?.name === p.name ? null : p.name)} aria-pressed={sel?.name === p.name}
                      className={cx(cols, "relative w-full border-b border-line/60 px-4 py-2.5 text-left text-[12px] last:border-0 hover:bg-muted/50", sel?.name === p.name && "bg-muted/60 before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded before:bg-accent")}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium">{p.name}</span>
                  {p.locked && <Lock size={11} className="shrink-0 text-dim" aria-label="locked" />}
                  {p.trust === "code" && <ShieldAlert size={11} className="shrink-0 text-warn md:hidden" aria-label="in-process" />}
                </span>
                <span className="max-md:hidden"><Tier p={p} /></span>
                <span className="max-md:hidden"><Kinds p={p} live={pv.liveKinds} /></span>
                <span className="min-w-0 truncate max-md:hidden">
                  {needs.length === 0 ? <span className="text-dim">no models</span> : needs.map(([slot, n], i) => (
                    <span key={slot} className={p.models[slot] ? "text-fg" : n.optional ? "text-dim" : "text-warn"}>{i ? " · " : ""}{slot} → {p.models[slot] ?? (n.optional ? "none" : "pick one")}</span>
                  ))}
                </span>
                <span className={cx("max-md:hidden", usedOn(p, pv) === "on no line" && "text-dim", servesOnly(p) && cx(mono, "truncate"))}>{usedOn(p, pv)}</span>
                <span className={cx("flex min-w-0 items-center gap-1 max-md:justify-end", TONE[st.tone])}>
                  {st.tone === "bad" ? <XCircle size={12} className="shrink-0" /> : st.tone === "warn" ? <AlertTriangle size={12} className="shrink-0" /> : st.word === "paused" ? <Pause size={12} className="shrink-0" /> : st.word === "on no line" ? <CircleDashed size={12} className="shrink-0" /> : null}
                  <span className="truncate">{st.word}</span>
                </span>
              </button>
            );
          })}
        </Card>
        <p className="text-[12px] text-dim">A plugin runs where it is placed: on a line of the Routing map, or on every line. In-process plugins run with hearth's own access; HTTP plugins are sent only what they read.</p>
      </div>
      {sel && <Panel p={sel} pv={pv} onClose={() => pick(null)} onWire={(slot, model) => wire(sel.name, slot, model)} onFallback={(to) => fallBack(sel.name, to)} />}
      {adding && <AddPlugin onClose={() => setAdding(false)} />}
      {plan && <Review plan={plan} onClose={() => setPlan(null)} />}
    </div>
  );
}
