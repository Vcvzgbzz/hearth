/**
 * The Requests page: the node's recent finished requests, and the trace of one: how long it waited
 * and ran, the rule lines that decided it, and the way to see that path lit on the Routing map.
 */
import { Map as MapIcon, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { Flow, RequestTrace } from "../observe/uidata.js";
import { REQUESTS_KEPT } from "../observe/requests.js";
import { isObj, obj } from "./draft.js";
import { loadDraft, replay, useEdit } from "./editStore.js";
import { sentence } from "./flowNodes.js";
import { goLink, toast, useLink, useStore } from "./store.js";
import { attemptsOf, hops, routerOf, secs, verdict, where } from "./trace.js";
import { Button, Card, cx, Empty, mono } from "./ui.js";

const KEEP = 1000;

/** Open one request's trace on the Requests page. */
export const openTrace = (id: string) => goLink("requests", id);
/** The Routing page with this request's path lit. */
export const showOnMap = (t: RequestTrace) => { useEdit.setState({ replay: t, trial: null, tried: null, sel: null, opened: null }); goLink("routing", t.router ?? "default", `req:${t.id}`); };

const fetchTrace = async (id: string): Promise<RequestTrace | null> => {
  try {
    const r = await fetch(`/ui/requests/${encodeURIComponent(id)}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as RequestTrace) : null;
  } catch {
    return null;
  }
};

/** Replay the request with this id on the map, reading it from the node when it is not the one already shown. */
export async function replayId(id: string): Promise<void> {
  const shown = useEdit.getState().replay;
  const t = shown?.id === id ? shown : await fetchTrace(id);
  if (t) replay(t);
  else toast("bad", `that request is no longer kept: the node keeps the last ${REQUESTS_KEPT.toLocaleString()}`);
}

const clock = (t: number) => new Date(t).toLocaleTimeString();

/** The slim strip above the Routing map, under the edit bar, while a request is replayed on it. */
export function Replay() {
  const t = useEdit((s) => (s.trial ? null : s.replay));
  if (!t) return null;
  return (
    <div className="mx-3 mt-2 flex items-center gap-2 rounded-xl border border-accent/50 bg-panel px-3 py-1.5 text-[12px] shadow-sm">
      <span className="min-w-0 truncate">Replaying <span className={mono}>{t.asked}</span> from {t.caller}, {clock(t.t)} — {verdict(t)}</span>
      <button type="button" className="shrink-0 text-accent hover:underline" onClick={() => openTrace(t.id)}>open trace</button>
      <button type="button" aria-label="stop replaying" title="stop replaying" className="shrink-0 text-dim hover:text-fg" onClick={() => replay(null)}><X size={13} /></button>
    </div>
  );
}

/** Waited, then ran: the bar the Scheduler's history draws. */
function Bar({ t, max }: { t: RequestTrace; max: number }) {
  return (
    <span className="flex h-[7px] overflow-hidden rounded-full bg-line/40" title={`waited ${secs(t.waitedMs)}, ran ${secs(t.runMs)}`}>
      <span className="h-full bg-line" style={{ width: `${(t.waitedMs / max) * 100}%` }} />
      <span className={t.ok ? "h-full bg-accent" : "h-full bg-bad"} style={{ width: `${(t.runMs / max) * 100}%` }} />
    </span>
  );
}

/** Waited | to first byte | rest of the run, each labelled, and what it cost in tokens. */
function Timeline({ t }: { t: RequestTrace }) {
  const total = Math.max(1, t.waitedMs + t.runMs);
  const first = t.firstByteMs;
  const parts = [
    { label: "waited", ms: t.waitedMs, cls: "bg-line" },
    ...(first !== undefined ? [{ label: "to first byte", ms: first, cls: "bg-info" }, { label: "rest of run", ms: Math.max(0, t.runMs - first), cls: t.ok ? "bg-accent" : "bg-bad" }]
      : [{ label: "ran", ms: t.runMs, cls: t.ok ? "bg-accent" : "bg-bad" }]),
  ];
  const genMs = first !== undefined ? t.runMs - first : t.runMs;
  const tps = t.tokensOut !== undefined && genMs > 0 ? Math.round(t.tokensOut / (genMs / 1000)) : null;
  const est = t.tokensEstimated ? "~" : "";
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-line/40">
        {parts.map((p) => <span key={p.label} className={cx("h-full", p.cls)} style={{ width: `${(p.ms / total) * 100}%` }} />)}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-dim">
        {parts.map((p) => <span key={p.label}>{p.label} <b className="tabular font-medium text-fg">{secs(p.ms)}</b></span>)}
      </div>
      {(t.tokensIn !== undefined || t.tokensOut !== undefined) && (
        <div className="mt-1 text-[11px] text-dim">
          tokens in <b className="tabular text-fg">{est}{t.tokensIn ?? "?"}</b> · out <b className="tabular text-fg">{est}{t.tokensOut ?? "?"}</b>
          {t.tokensCached ? <> · cached <b className="tabular text-fg">{t.tokensCached}</b></> : null}
          {tps !== null && <> · <b className="tabular text-fg">{est}{tps}</b> tokens/s</>}
        </div>
      )}
    </div>
  );
}

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="flex gap-2 text-[12px]"><span className="w-24 shrink-0 text-dim">{k}</span><span className="min-w-0 break-words">{children}</span></div>
);

/** One attempt: what became of it and why. */
function Attempt({ t, flows }: { t: RequestTrace; flows: Record<string, Pick<Flow, "steps">> | undefined }) {
  const h = hops(t, flows);
  const before = t.router === undefined && (t.target === "refused" || t.target === "unavailable");
  return (
    <div className="flex flex-col gap-3">
      <div className={cx("text-[14px] font-medium", !t.ok && "text-bad")}>{verdict(t)}</div>
      <Timeline t={t} />
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-dim">How it was decided</div>
        {h.length === 0 ? <p className="text-[12px] text-dim">{before ? "turned away before any rule saw it" : "no rule: it ran as itself"}</p> : (
          <ol className="flex flex-col gap-1">
            {h.map((x, i) => (
              <li key={i} className="rounded-md border border-line px-2 py-1 text-[12px]">
                <span className="font-medium">rule <span className={mono}>{x.flow}</span>, {x.line}</span>
                {x.gone ? <span className="text-warn"> · this rule has changed since</span>
                  : <span className="text-dim"> · {sentence(x.when) || "it can take it"} → {x.sends}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {t.reason && <Row k="reason">{t.reason}</Row>}
        {t.router && <Row k="router">{t.router}</Row>}
        {t.lane && <Row k="lane">{t.lane}</Row>}
        {t.actions.length > 0 && <Row k="actions">{t.actions.join(", ")}</Row>}
        {(t.plugins ?? []).length > 0 && <Row k="plugins">{t.plugins!.join(", ")}</Row>}
        {t.headers && <Row k="headers"><span className={mono}>{Object.entries(t.headers).map(([k, v]) => `${k}: ${v}`).join("; ")}</span></Row>}
        {t.fallbackFrom && <Row k="fell back">from {t.fallbackFrom}</Row>}
        {t.error && <Row k="error"><span className="text-bad">{t.error}{t.status ? ` (${t.status})` : ""}</span></Row>}
        <Row k="id"><span className={mono}>{t.id}</span></Row>
      </div>
    </div>
  );
}

/** The trace of one request: each attempt with that id, first one first. */
function Trace({ id, kept }: { id: string; kept: RequestTrace[] }) {
  const data = useStore((s) => s.data)!;
  const doc = useEdit((s) => s.file?.doc);
  const inList = attemptsOf(kept, id);
  const [fetched, setFetched] = useState<{ id: string; t: RequestTrace | null } | null>(null);
  useEffect(() => {
    if (inList.length > 0 || fetched?.id === id) return;
    let live = true;
    void fetchTrace(id).then((t) => { if (live) setFetched({ id, t }); });
    return () => { live = false; };
  }, [id, inList.length]);
  const attempts = inList.length > 0 ? inList : fetched?.id === id && fetched.t ? [fetched.t] : [];
  if (attempts.length === 0) {
    return <Empty>{fetched?.id === id ? `No longer kept: the node keeps the last ${REQUESTS_KEPT.toLocaleString()}.` : "loading…"}</Empty>;
  }
  const last = attempts.at(-1)!;
  // The rules as they stand now: the default rulebook from the node, a router's from hearth.yaml.
  const r = routerOf(last);
  const flowsFor = (t: RequestTrace) => {
    const at = routerOf(t);
    if (at === null) return data.flows;
    const f = obj(obj(obj(doc?.routers)[at]).flows);
    return isObj(doc) ? (f as Record<string, Pick<Flow, "steps">>) : undefined;
  };
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-dim">{new Date(last.t).toLocaleString()} · from {last.caller}{r ? ` · router ${r}` : ""}</span>
        <span className="ml-auto"><Button onClick={() => showOnMap(last)}><MapIcon size={13} />show on the map</Button></span>
      </div>
      {attempts.length === 1 ? <Attempt t={last} flows={flowsFor(last)} /> : attempts.map((t, i) => (
        <div key={t.t} className="border-t border-line pt-3 first:border-0 first:pt-0">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-dim">step {i + 1} of {attempts.length}</div>
          <Attempt t={t} flows={flowsFor(t)} />
        </div>
      ))}
    </div>
  );
}

export function Requests() {
  const [kept, setKept] = useState<RequestTrace[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [model, setModel] = useState("");
  const [caller, setCaller] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  useLink(sel ? [sel] : [], kept !== null, ([id]) => setSel(id ?? null));
  // A router's rules are read from hearth.yaml, as the Routing page reads them.
  useEffect(() => { if (!useEdit.getState().file) void loadDraft(); }, []);
  useEffect(() => {
    let live = true;
    let newest: number | undefined;
    const load = async () => {
      try {
        const r = await fetch(`/ui/requests?limit=${KEEP}${newest !== undefined ? `&after=${newest}` : ""}`, { cache: "no-store" });
        if (!r.ok || !live) return;
        const d = (await r.json()) as { requests: RequestTrace[] };
        if (!live) return;
        if (d.requests.length) newest = d.requests[0]!.t;
        setKept((was) => [...d.requests, ...(was ?? [])].slice(0, KEEP));
      } catch { /* the header already says when the node is unreachable */ }
    };
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 3000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const all = kept ?? [];
  const models = [...new Set(all.flatMap((r) => [r.asked, r.model]).filter(Boolean))].sort();
  const callers = [...new Set(all.map((r) => r.caller))].sort();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((r) => (model === "" || r.asked === model || r.model === model) && (caller === "" || r.caller === caller) && (!failedOnly || !r.ok)
    && words.every((w) => [r.id, r.asked, r.model, r.caller, where(r), r.error ?? "", r.reason ?? ""].join(" ").toLowerCase().includes(w)));
  const max = Math.max(1, ...shown.map((r) => r.waitedMs + r.runMs));
  const field = "h-8 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none";

  return (
    <Card className="flex min-h-0 flex-1 overflow-hidden max-lg:flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-line max-lg:border-r-0 max-lg:border-b">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <div className="mr-auto">
            <div className="font-medium">Requests</div>
            <div className="text-[11px] text-dim">Finished requests, newest first. Click one for what happened to it.</div>
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" aria-label="search requests" className={cx(field, "w-40")} />
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="model" className={cx(field, "max-w-40")}>
            <option value="">all models</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={caller} onChange={(e) => setCaller(e.target.value)} aria-label="caller" className={cx(field, "max-w-36")}>
            <option value="">all callers</option>
            {callers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-[12px] text-dim">
            <input type="checkbox" className="accent-accent" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />failed only
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {kept === null ? <Empty>loading…</Empty> : shown.length === 0 ? <Empty>{all.length ? "Nothing matches." : "Nothing recorded yet. Requests show here as they finish."}</Empty> : (
            <ul>
              {shown.map((r) => (
                <li key={`${r.id}:${r.t}`}>
                  <button type="button" onClick={() => setSel(r.id)} aria-current={sel === r.id ? "true" : undefined}
                          className={cx("grid w-full grid-cols-[72px_minmax(0,1fr)_minmax(0,90px)_minmax(0,100px)_80px_52px_44px] items-center gap-2 border-b border-line/50 px-4 py-1.5 text-left text-[12px] hover:bg-muted/40", sel === r.id && "bg-muted")}>
                    <span className="tabular text-dim">{clock(r.t)}</span>
                    <span className={cx(mono, "truncate")}>{r.asked}{r.model && r.model !== r.asked ? <span className="text-dim"> → {r.model}</span> : null}</span>
                    <span className="truncate text-dim">{r.caller}</span>
                    <span className="truncate">{where(r)}</span>
                    <Bar t={r} max={max} />
                    <span className="tabular text-right text-dim">{secs(r.waitedMs + r.runMs)}</span>
                    <span className={r.ok ? "text-ok" : "text-bad"}>{r.ok ? "ok" : "failed"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="min-h-0 w-[440px] shrink-0 overflow-auto max-lg:w-full">
        {sel === null ? <Empty>Pick a request to see its trace.</Empty> : <Trace id={sel} kept={all} />}
      </div>
    </Card>
  );
}
