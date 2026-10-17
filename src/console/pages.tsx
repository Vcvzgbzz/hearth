/** The pages beside the topology, and the inspector sheet that opens over it. */
import { ChevronRight, Trash2, X } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import type { UiData, Used } from "./types.js";
import { Refs, refsOf, Value } from "./config.js";
import { draftView, isObj, obj, put } from "./draft.js";
import { change, useEdit } from "./editStore.js";
import { control, doneWithKey, evict, go, mintKey, revokeKey, rotateKey, select, useStore, warm } from "./store.js";
import { ago, Button, Card, cx, Dialog, Empty, mono, Pill, Switch, type Tone } from "./ui.js";

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

/** Where each kind of thing on the topology is kept in the file. */
const KEPT: Record<string, string> = { backend: "backends", resource: "resources", machine: "servers" };

export function Inspector() {
  const live = useStore((s) => s.data)!;
  const sel = useStore((s) => s.sel);
  const draft = useEdit((s) => s.draft);
  const err = useEdit((s) => s.err);
  const editable = draft !== null;
  if (!sel) return null;
  // What is drawn is the draft where there is one, so something added or moved can be opened before it is published.
  const d = draft ? draftView(draft, live) : live;
  const section = KEPT[sel.kind];
  const entry = draft && section ? obj(draft[section])[sel.id] : undefined;
  const self = selfOf(d);
  let title = sel.id;
  let body: React.ReactNode = null;

  if (sel.kind === "self") {
    body = (
      <>
        <Row k="lending"><Switch label="lending" on={d.controls.lending} onChange={(on) => void control({ lending: on }, on ? "lending resumed" : "lending paused")} /></Row>
        <Row k="borrowing"><Switch label="borrowing" on={d.controls.borrowing} onChange={(on) => void control({ borrowing: on }, on ? "borrowing resumed" : "borrowing paused")} /></Row>
        <p className="mt-2 text-[11px] text-dim">Pausing applies at once and is not written to the config; a restart clears it.</p>
        <Row k="lent">{[...d.share, ...(live.controls.lending ? live.catalog.flatMap((m) => { const to = lentOnlyTo(live, m); return to.length ? [`${m} (to ${to.join(", ")})`] : []; }) : [])].join(", ") || "nothing"}</Row>
      </>
    );
  } else if (sel.kind === "backend") {
    const b = (self.backends ?? []).find((x) => x.name === sel.id);
    // Where it sits and what it uses are read off the draft, so a move shows before it is saved.
    const entry = draft ? (draft.backends as Record<string, { server?: string; resources?: string[] }> | undefined)?.[sel.id] : undefined;
    const drafted = entry ? { server: entry.server ?? "", resources: entry.resources ?? [] } : null;
    if (b) body = (
      <>
        <Row k="kind">{b.kind ?? "not said yet"}{b.evicts ? " · swaps models" : ""}</Row>
        <Row k="address"><span className={mono}>{b.url}</span></Row>
        <Row k="runs on">{drafted ? `${drafted.server || "this machine"}${(drafted.server || "") !== (b.server ?? "") ? " (unsaved)" : ""}` : b.server ?? "this machine"}</Row>
        <Row k="slots"><span className="tabular">{(b.slots ?? 0) - (b.free ?? 0)} of {b.slots ?? 0} busy · {b.queued ?? 0} queued</span></Row>
        <Row k="hardware">{drafted ? `${drafted.resources.join(", ") || "none"}${drafted.resources.join() !== (b.resources ?? []).join() ? " (unsaved)" : ""}` : (b.resources ?? []).join(", ") || "none declared"}</Row>
        <Row k="loaded">{(b.loaded ?? []).join(", ") || (b.knowsWarm === false ? "cannot tell" : "nothing")}</Row>
        {(b.routes ?? []).length > 0 && <Row k="paths">{b.routes!.map((r) => <div key={r.path} className={mono}>{r.path}</div>)}</Row>}
        <Row k="serves">{(b.serves ?? []).join(", ")}</Row>
      </>
    );
  } else if (sel.kind === "peer") {
    const p = d.net.nodes.find((n) => n.name === sel.id);
    const owed = (live.ledger ?? []).find((l) => l.peer === sel.id);
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
        {owed && (
          <>
            <Row k="lent"><span className="tabular"><UsedCell used={owed.lent.month} /></span></Row>
            <Row k="borrowed"><span className="tabular"><UsedCell used={owed.borrowed.month} /></span></Row>
            {owed.closed !== undefined && <Row k="lending to it">{owed.closed === null ? <Pill tone="ok">open</Pill> : <span className="text-warn">closed: {owed.closed}</span>}</Row>}
          </>
        )}
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
  } else if (sel.kind === "machine") {
    const on = (self.backends ?? []).filter((b) => (b.server ?? "") === sel.id).map((b) => b.name);
    body = <Row k="backends">{on.join(", ") || "nothing on it yet"}</Row>;
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
    <aside className={cx("shrink-0 overflow-auto border-l border-line bg-panel p-4 max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-10", isObj(entry) ? "w-[440px]" : "w-[340px]")}>
      <div className="mb-2 flex items-center">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-dim">{sel.kind === "self" ? "this node" : sel.kind === "resource" ? "hardware" : sel.kind}</div>
          <div className="text-base font-semibold">{title}</div>
        </div>
        {/* What it is doing is here; what it is set to is the same node's settings. */}
        {editable && sel.kind === "peer" && (
          <button className="ml-auto rounded-md border border-line px-2 py-1 text-[11px] hover:bg-muted" onClick={() => go("config")}>settings</button>
        )}
        {isObj(entry) && <button className="ml-auto text-dim hover:text-bad" aria-label={`delete ${sel.id}`} title="take this out of the draft" onClick={() => { change((x) => put(x, section!, sel.id, undefined)); select(null); }}><Trash2 size={15} /></button>}
        <button className={cx("text-dim hover:text-fg", !(isObj(entry) || (editable && sel.kind === "peer")) && "ml-auto")} aria-label="close" onClick={() => select(null)}><X size={16} /></button>
      </div>
      {body ?? <Empty>gone</Empty>}
      {/* What is above is what runs now; what is below is the file, which may be ahead of it. */}
      {section && live.config.restartPending.includes(section) && (
        <div className="mt-3 rounded-md border border-warn/50 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">Published changes to {section} are not running yet: what is shown above is what runs now, and restarting hearth applies the settings below.</div>
      )}
      {/* Its settings, as the Config page has them, changing the same draft. */}
      {isObj(entry) && draft && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-dim">settings</div>
          <div className="mb-2 text-[11px] text-dim">Changes join the draft. Most of these apply only after a restart, which the review says before anything is written.</div>
          <Refs.Provider value={refsOf(draft, d.catalog ?? [])}>
            <Value name={sel.id} v={entry} path={[section!, sel.id]} err={err} compact onChange={(n) => change((x) => put(x, section!, sel.id, n))} />
          </Refs.Provider>
        </div>
      )}
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
  // A name a flow takes is not a model: a rule decides what answers it. A provider's model is never loaded or unloaded here.
  const types = new Set(Object.values(d.flows ?? {}).flatMap((f) => f.inputs));
  const hosted = new Set((self.backends ?? []).filter((b) => b.cloud).flatMap((b) => b.serves ?? []));
  const state = (m: string): [Tone, string] =>
    types.has(m) ? ["accent", "type"] : hosted.has(m) ? ["dim", "hosted"]
    : d.net.readyNow.includes(m) ? ["ok", "warm"] : (d.net.unknownWarm ?? []).includes(m) ? ["dim", "unknown"] : ["info", "cold"];
  const [busy, setBusy] = useState<string | null>(null);
  const act = (k: string, fn: () => Promise<void>): void => {
    if (busy !== null) return;
    setBusy(k);
    void fn().finally(() => setBusy(null));
  };
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left">
        <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
          <tr>
            <th className="px-4 py-2 font-medium">model</th>
            <th className="px-2 py-2 font-medium">state</th>
            <th className="px-2 py-2 font-medium">actions</th>
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
                <td className="px-2 py-2">
                  {local.has(m) && !types.has(m) && !hosted.has(m) ? (
                    <button disabled={busy !== null}
                            onClick={() => {
                              if (word === "warm" && !confirm(`Evict ${m}? It leaves the card and the next request for it pays the reload.`)) return;
                              act(word === "warm" ? `evict:${m}` : `warm:${m}`, word === "warm" ? () => evict(m) : () => warm(m));
                            }}
                            className={cx("h-6 rounded-md border border-line px-2 text-[12px] hover:bg-muted hover:text-fg disabled:opacity-40", word === "warm" ? "text-dim" : "text-accent")}>
                      {word === "warm" ? "evict" : "warm"}
                    </button>
                  ) : <span className="text-dim">—</span>}
                </td>
                <td className="px-2 py-2 text-dim">{types.has(m) ? "a routing rule" : where(m).join(", ")}</td>
                <td className="tabular px-2 py-2 text-dim">{stats?.context ? `${Math.round(stats.context / 1024)}k` : "—"}</td>
                <td className="px-2 py-2">
                  {local.has(m) && !hosted.has(m)
                    ? <span className="flex items-center gap-2">
                        <Switch label={`lend ${m}`} on={lent} onChange={(on) => void control({ share: { [m]: on } }, on ? `lending ${m}` : `holding ${m}`)} />
                        {lentOnlyTo(d, m).length > 0 && <span className="text-[12px] text-dim" title="lent by that peer's own list, on the Lending page">to {lentOnlyTo(d, m).join(", ")}</span>}
                      </span>
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

/* ----------------------------------------------------------------- keys */

/**
 * The keys that open /v1 here: who holds one, what it may run, when it last spoke. The
 * secrets live in hearth.yaml and never come back into this page — a mint hands its
 * plaintext over once, and after that only the label and a hash are shown, the way the
 * config page does.
 */
/** The peers lent `model` by a list of their own where the node's list holds it back. */
const lentOnlyTo = (d: UiData, model: string): string[] =>
  d.configuredShare.includes(model) ? [] : (d.ledger ?? []).filter((l) => l.own?.includes("models") && !l.terms?.off && l.terms?.models.includes(model)).map((l) => l.peer);

/** A count as a person reads it: 950, 12.4k, 3.1M. */
export const short = (n: number): string => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`);

/** Dollars as a person reads them: cents for small sums, whole dollars for large ones. */
const money = (n: number): string => `$${n < 10 ? n.toFixed(2) : n < 1000 ? n.toFixed(0) : short(Math.round(n))}`;

/** Requests and tokens over some days, as one cell. */
function UsedCell({ used }: { used?: Used }) {
  if (!used || used.requests === 0) return <span className="text-dim">—</span>;
  return (
    <span title={`${used.requests} requests, ${used.failed} failed · ${used.in} tokens in${used.cached ? ` (${used.cached} read from cache)` : ""}, ${used.out} out`}>
      {short(used.requests)} <span className="text-dim">req ·</span> {short(used.in)} <span className="text-dim">in /</span> {short(used.out)} <span className="text-dim">out</span>
      {(used.cost ?? 0) > 0 && <span title="at the prices the models carry now"> <span className="text-dim">·</span> {money(used.cost!)}</span>}
      {used.failed > 0 && <span className="text-bad"> · {short(used.failed)} failed</span>}
    </span>
  );
}

type Rule = NonNullable<NonNullable<UiData["keys"]>[number]["rule"]>;

/** What bounds a key, in a few words; red once it has run out or run past its day. */
function limitsOf(rule: Rule | null | undefined, today?: Used) {
  if (!rule) return "—";
  const gone = rule.expires !== null && Date.now() >= rule.expires;
  const spent = (rule.tokensPerDay > 0 && (today?.in ?? 0) + (today?.out ?? 0) >= rule.tokensPerDay) || ((rule.dollarsPerDay ?? 0) > 0 && (today?.cost ?? 0) >= rule.dollarsPerDay!);
  const parts = [
    rule.requestsPerMinute > 0 ? `${short(rule.requestsPerMinute)} req/min` : null,
    rule.tokensPerDay > 0 ? `${short(rule.tokensPerDay)} tokens/day` : null,
    (rule.dollarsPerDay ?? 0) > 0 ? `${money(rule.dollarsPerDay!)}/day` : null,
    // The last day it works, as the file has it.
    rule.expires !== null ? `${gone ? "expired" : "until"} ${new Date(rule.expires - 1).toISOString().slice(0, 10)}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return "—";
  return <span className={gone || spent ? "text-bad" : undefined} title={spent ? "today's allowance is used up; it works again at midnight UTC" : undefined}>{parts.join(" · ")}</span>;
}

/** A key just minted or rotated, shown once over whichever page made it. The keys page shows it in place instead. */
export function KeyOnce() {
  const shown = useStore((s) => s.fresh);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [shown]);
  if (shown === null) return null;
  return (
    <Dialog firm title={`${shown.rotated ? "New key" : "Key"} for ${shown.label}`} onClose={doneWithKey}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[12px] text-dim">Shown once: after this it exists only in hearth.yaml.{shown.rotated ? " The old key has stopped working." : ""}</p>
        <code className={cx("select-all overflow-x-auto whitespace-nowrap rounded-md border border-line bg-bg px-3 py-2", mono)}>{shown.key}</code>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
        {/* A page served over plain http off this machine has no clipboard; the text is selectable either way. */}
        {navigator.clipboard && <Button onClick={() => void navigator.clipboard.writeText(shown.key).then(() => setCopied(true), () => {})}>{copied ? "copied" : "copy"}</Button>}
        <Button tone="primary" onClick={doneWithKey}>done</Button>
      </div>
    </Dialog>
  );
}

export function Keys() {
  const keys = useStore((s) => s.data!.keys ?? []);
  const others = useStore((s) => s.data!.others ?? []);
  const catalog = useStore((s) => s.data!.catalog);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState("");
  const [expires, setExpires] = useState("");
  const [perMinute, setPerMinute] = useState("");
  const [perDay, setPerDay] = useState("");
  const [dollars, setDollars] = useState("");
  const shown = useStore((s) => s.fresh);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const mint = async () => {
    const l = label.trim();
    if (l === "" || busy) return;
    setBusy(true);
    const models = scope.split(",").map((s) => s.trim()).filter(Boolean);
    const limits = { ...(Number(perMinute) > 0 ? { requestsPerMinute: Math.floor(Number(perMinute)) } : {}), ...(Number(perDay) > 0 ? { tokensPerDay: Math.floor(Number(perDay)) } : {}), ...(Number(dollars) > 0 ? { dollarsPerDay: Number(dollars) } : {}) };
    const key = await mintKey(l, models.length > 0 ? models : null, { ...(expires ? { expires } : {}), ...(Object.keys(limits).length ? { limits } : {}) });
    setBusy(false);
    if (key !== null) {
      setCopied(false);
      setLabel("");
      setScope("");
      setExpires("");
      setPerMinute("");
      setPerDay("");
      setDollars("");
    }
  };
  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the text stays selectable either way */ }
  };
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-2.5">
        <div className="font-medium">Keys</div>
        <div className="text-[11px] text-dim">Bearer keys for /v1 on this node. They live in hearth.yaml and a change takes effect at once; what is shown here is a label and a hash, never the secret. Days are UTC; tokens are the backend&rsquo;s own count where its answer carries one, and an estimate where it does not.</div>
      </div>
      <table className="w-full text-left">
        <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
          <tr>
            <th className="px-4 py-2 font-medium">label</th>
            <th className="px-4 py-2 font-medium">id</th>
            <th className="px-4 py-2 font-medium">may run</th>
            <th className="px-4 py-2 font-medium">limits</th>
            <th className="px-4 py-2 font-medium">today</th>
            <th className="px-4 py-2 font-medium">31 days</th>
            <th className="px-4 py-2 text-right font-medium">last seen</th>
            <th className="w-20" />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.label || k.id} className="border-b border-line/60 last:border-0">
              <td className="px-4 py-2">{k.label !== "" ? k.label : <span className="text-dim">unlabeled</span>}</td>
              <td className={cx("px-4 py-2 text-dim", mono)}>{k.id}</td>
              <td className="px-4 py-2 text-dim">{k.models === null || k.models.length === 0 ? "everything" : k.models.join(", ")}</td>
              <td className="px-4 py-2 text-dim">{limitsOf(k.rule, k.today)}</td>
              <td className="tabular px-4 py-2"><UsedCell used={k.today} /></td>
              <td className="tabular px-4 py-2"><UsedCell used={k.month} /></td>
              <td className={cx("tabular px-4 py-2 text-right", k.lastSeen === null ? "text-dim" : "text-fg")}>{k.lastSeen === null ? "never" : ago(k.lastSeen)}</td>
              <td className="px-4 py-2 text-right">
                <button disabled={busy || k.label === ""} title={k.label === "" ? "a key with no label is changed in the config file" : "a new secret for this key, shown once; the old one stops working straight away"}
                        onClick={() => { if (confirm(`Rotate ${k.label}? Whatever uses the old key stops working until it is given the new one.`)) void rotateKey(k.label); }}
                        className="mr-3 text-[12px] text-dim hover:text-fg hover:underline disabled:opacity-40">
                  rotate
                </button>
                <button disabled={busy || k.label === ""} title={k.label === "" ? "a key with no label is removed in the config file" : undefined}
                        onClick={() => { if (confirm(`Revoke ${k.label}? It stops working straight away.`)) void revokeKey(k.label); }}
                        className="text-[12px] text-bad hover:underline disabled:opacity-40">
                  revoke
                </button>
              </td>
            </tr>
          ))}
          {/* Whoever else used the node: this machine with no key, and peers. */}
          {others.map((o) => (
            <tr key={o.caller} className="border-b border-line/60 last:border-0">
              <td className="px-4 py-2 text-dim">{o.caller === "local" ? "this machine, no key" : o.caller.startsWith("peer:") ? `peer ${o.caller.slice(5)}` : o.caller}</td>
              <td className="px-4 py-2 text-dim">—</td>
              <td className="px-4 py-2 text-dim">—</td>
              <td className="px-4 py-2 text-dim">—</td>
              <td className="tabular px-4 py-2"><UsedCell used={o.today} /></td>
              <td className="tabular px-4 py-2"><UsedCell used={o.month} /></td>
              <td className="px-4 py-2 text-right text-dim">—</td><td />
            </tr>
          ))}
        </tbody>
      </table>
      {keys.length === 0 && <Empty>No keys yet. Without any, only this machine may call /v1.</Empty>}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" maxLength={40}
               className="h-8 w-40 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />
        <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="models, comma-separated (blank = everything)"
               className="h-8 w-72 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />
        <input value={perMinute} onChange={(e) => setPerMinute(e.target.value)} type="number" min={0} placeholder="req / min" aria-label="requests a minute, blank for no limit"
               className="h-8 w-24 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />
        <input value={perDay} onChange={(e) => setPerDay(e.target.value)} type="number" min={0} placeholder="tokens / day" aria-label="tokens a day, blank for no limit"
               className="h-8 w-28 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />
        <input value={dollars} onChange={(e) => setDollars(e.target.value)} type="number" min={0} placeholder="$ / day" aria-label="dollars a day, blank for no limit" step="any"
               className="h-8 w-28 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />
        <label className="flex items-center gap-1.5 text-[11px] text-dim">expires
          <input value={expires} onChange={(e) => setExpires(e.target.value)} type="date" aria-label="the last day it works, blank for never"
                 className="h-8 rounded-md border border-line bg-bg px-2 text-[12px] text-fg focus:border-accent focus:outline-none" />
        </label>
        <button disabled={busy || label.trim() === ""} onClick={() => void mint()}
                className="h-8 rounded-md bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40">
          {busy ? "minting…" : "mint a key"}
        </button>
        {catalog.length > 0 && <span className="text-[11px] text-dim">here: {catalog.join(", ")}</span>}
      </div>
      {shown !== null && (
        <div className="border-t border-line bg-muted/40 px-4 py-3">
          <div className="text-[12px] text-dim">The {shown.rotated ? "new key" : "key"} for <b className="text-fg">{shown.label}</b> — shown once; after this it exists only in hearth.yaml.</div>
          <div className="mt-1.5 flex items-center gap-2">
            <code className={cx("flex-1 select-all overflow-x-auto whitespace-nowrap rounded-md border border-line bg-bg px-3 py-2", mono)}>{shown.key}</code>
            {navigator.clipboard && <button onClick={() => void copy(shown.key)} className="h-8 rounded-md border border-line px-3 text-[12px] hover:bg-muted">{copied ? "copied" : "copy"}</button>}
            <button onClick={doneWithKey} className="h-8 rounded-md px-2 text-[12px] text-dim hover:text-fg">done</button>
          </div>
        </div>
      )}
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

/**
 * The individual calls behind a model's row: newest first, capped, and the
 * wait-vs-run split each one actually spent. Only the timing is kept here —
 * prompts and replies never pass through hearth, so there is nothing to show.
 */
function CallsPanel({ calls }: { calls: Call[] }) {
  const shown: Call[] = [];
  for (let i = calls.length - 1; i >= 0 && shown.length < 40; i--) shown.push(calls[i]!);
  if (shown.length === 0) return <p className="text-[12px] text-dim">No calls in this window.</p>;
  const max = Math.max(1, ...shown.map((c) => c.waitedMs + c.ms));
  return (
    <div className="max-h-80 overflow-y-auto pr-1">
      <div className="sticky top-0 grid grid-cols-[88px_56px_1fr_70px] gap-2 bg-bg pb-1 text-[10px] uppercase text-dim">
        <span>time</span>
        <span>result</span>
        <span>waited, then ran</span>
        <span className="text-right">total</span>
      </div>
      {shown.map((c, i) => {
        const total = c.waitedMs + c.ms;
        return (
          <div key={`${c.t}-${i}`} className="grid grid-cols-[88px_56px_1fr_70px] items-center gap-2 py-0.5 text-[12px]">
            <span className="tabular text-dim">{new Date(c.t).toLocaleTimeString()}</span>
            <span className={c.ok ? "text-ok" : "text-bad"}>{c.ok ? "ok" : "failed"}</span>
            <span className="flex h-[7px] overflow-hidden rounded-full bg-line/40"
                  title={c.backend !== null ? `waited ${secs(c.waitedMs)} in ${c.backend}'s queue, ran ${secs(c.ms)} on ${c.backend}` : `waited ${secs(c.waitedMs)}, ran ${secs(c.ms)}`}>
              <span className="h-full bg-line" style={{ width: `${(c.waitedMs / max) * 100}%` }} />
              <span className={c.ok ? "h-full bg-accent" : "h-full bg-bad"} style={{ width: `${(c.ms / max) * 100}%` }} />
            </span>
            <span className="tabular text-right text-dim">{secs(total)}</span>
          </div>
        );
      })}
      <p className="pt-1 text-[10px] text-dim">newest first, up to 40 · only the timing is kept; prompts and replies never pass through hearth</p>
    </div>
  );
}

/** Finished requests per model over the last ten minutes or the last day: how many, how long they waited and ran. */
export function History() {
  const [range, setRange] = useState<"10m" | "24h">("10m");
  const [open, setOpen] = useState<string | null>(null);
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
              <Fragment key={m}>
                <tr className={cx("border-b border-line/60 last:border-0", open === m && "bg-muted/40")}>
                  <td className={cx("px-4 py-2", mono)}>
                    <span className="flex items-center gap-1.5">
                      <button type="button" onClick={() => setOpen(open === m ? null : m)} aria-label={`the individual calls for ${m}`}
                              className="rounded p-0.5 text-dim hover:bg-line/70 hover:text-fg">
                        <ChevronRight size={12} className={cx("transition-transform", open === m && "rotate-90")} />
                      </button>
                      {m}
                    </span>
                  </td>
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
                {open === m && (
                  <tr className="border-b border-line/60 bg-bg/70">
                    <td colSpan={7} className="px-4 py-2.5">
                      <CallsPanel calls={cs} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <Empty>{range === "24h" && !day ? "loading…" : "No requests finished in this window."}</Empty>}
    </Card>
  );
}
