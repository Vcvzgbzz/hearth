/** The Keys page: who may call this node, the router and lane each goes by, and what each is held to. */
import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { Fragment, useState } from "react";

import { Menu } from "./editor.js";
import { choose } from "./editStore.js";
import { Num, Today } from "./Lending.js";
import { money, short, UsedCell } from "./pages.js";
import { doneWithKey, go, mintKey, revokeKey, rotateKey, updateKey, useLink, useStore } from "./store.js";
import type { KeyModelRule, KeyRow, ReachEnd, Used } from "../observe/uidata.js";
import { ago, Card, cx, Empty, mono } from "./ui.js";

type Rule = NonNullable<KeyRow["rule"]>;

const NO_RULE: Rule = { expires: null, requestsPerMinute: 0, tokensPerDay: 0 };

/** What bounds a key, in a few words; red once it has run out or run past its day. */
function limitsOf(k: KeyRow) {
  const rule = k.rule;
  if (!rule) return "—";
  const gone = rule.expires !== null && Date.now() >= rule.expires;
  const spent = (rule.tokensPerDay > 0 && (k.today?.in ?? 0) + (k.today?.out ?? 0) >= rule.tokensPerDay) || ((rule.dollarsPerDay ?? 0) > 0 && (k.today?.cost ?? 0) >= rule.dollarsPerDay!);
  const own = Object.keys(rule.models ?? {}).length;
  const parts = [
    (rule.maxConcurrent ?? 0) > 0 ? `${rule.maxConcurrent} jobs at once` : null,
    rule.requestsPerMinute > 0 ? `${short(rule.requestsPerMinute)} req/min` : null,
    rule.tokensPerDay > 0 ? `${short(rule.tokensPerDay)} tokens/day` : null,
    (rule.dollarsPerDay ?? 0) > 0 ? `${money(rule.dollarsPerDay!)}/day` : null,
    // The last day it works, as the file has it.
    rule.expires !== null ? `${gone ? "expired" : "until"} ${new Date(rule.expires - 1).toISOString().slice(0, 10)}` : null,
    own > 0 ? `${own} ${own === 1 ? "model" : "models"} with their own` : null,
  ].filter(Boolean);
  if (parts.length === 0 && k.lane === null) return "—";
  return (
    <span className={gone || spent ? "text-bad" : undefined} title={spent ? "today's allowance is used up; it works again at midnight UTC" : undefined}>
      {k.lane !== null && <span className="mr-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px]">{k.lane}</span>}
      {parts.join(" · ")}
    </span>
  );
}

/** Dollars can be fractions, so this saves as Num does but takes any number. */
function Dollars({ value, label, onSave }: { value: number; label: string; onSave: (n: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const n = text.trim() === "" ? 0 : Number(text);
    setText(null);
    if (Number.isFinite(n) && n >= 0 && n !== value) onSave(n);
  };
  return (
    <input aria-label={label} inputMode="decimal" placeholder="no limit" value={text ?? (value === 0 ? "" : String(value))}
           onChange={(e) => setText(e.target.value)} onBlur={commit}
           onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setText(null); }}
           className={cx("h-8 w-24 rounded-md border border-line bg-panel px-2 tabular placeholder:text-dim focus-visible:outline-2 focus-visible:outline-accent", mono)} />
  );
}

/** A day that saves when it is left or Enter is pressed: every keystroke of a year is a valid date on the way to the right one. */
function LastDay({ value, label, onSave }: { value: string; label: string; onSave: (day: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    setText(null);
    if (text !== value) onSave(text);
  };
  return (
    <input type="date" aria-label={label} value={text ?? value} onChange={(e) => setText(e.target.value)} onBlur={commit}
           onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setText(null); }}
           className="h-8 rounded-md border border-line bg-panel px-2 text-[12px] focus-visible:outline-2 focus-visible:outline-accent" />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="mb-1 whitespace-nowrap text-[12px] text-dim">{label}</div>{children}</div>;
}

const pick = "inline-flex h-8 min-w-32 items-center justify-between gap-2 rounded-md border border-line bg-panel px-2 hover:border-accent focus-visible:outline-2 focus-visible:outline-accent";

const count = (u: Used | undefined): number => (u ? u.in + u.out : 0);

/** One model a key reaches, each limit either the key's, dashed, or its own, solid. */
function ModelRow({ k, end }: { k: KeyRow; end: ReachEnd }) {
  const rule = k.rule ?? NO_RULE;
  const own: KeyModelRule = rule.models?.[end.id] ?? {};
  const now = k.now[end.id] ?? { running: 0, waiting: 0 };
  const tokens = own.tokensPerDay ?? rule.tokensPerDay;
  const jobs = own.maxConcurrent ?? rule.maxConcurrent ?? 0;
  const save = (field: keyof KeyModelRule, value: number | null, done: string) => void updateKey(k.label, { model: { id: end.id, limits: { [field]: value } } }, done);
  const cell = (field: keyof KeyModelRule, label: string, inherited: number) => {
    const mine = own[field] !== undefined;
    return (
      <td className="px-2 py-1.5"><div className="relative">
        <Num label={`${k.label}, ${end.id}: ${label}`} min={0} none="no limit" value={own[field] ?? inherited}
             title={mine ? `${end.id}'s own limit` : "the key's limit: type to give this model its own"}
             className={cx("h-7 w-full", mine ? "pr-7 font-medium text-fg" : "border-dashed text-dim hover:border-solid")}
             onSave={(n) => save(field, n === 0 ? null : n, `${end.id}: ${label} saved`)} />
        {mine && (
          <div className="absolute inset-y-0 right-0.5 flex items-center">
            <button type="button" aria-label={`${end.id} ${label} back to the key's limit`} title="back to the key's limit" onClick={() => save(field, null, `${end.id}: ${label} back to the key's limit`)}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"><Undo2 size={13} /></button>
          </div>
        )}
      </div></td>
    );
  };
  const none = <td className="px-2 py-1.5 text-dim">—</td>;
  const month = k.byModel.month[end.id];
  return (
    <tr className="border-b border-line/40 last:border-0 hover:bg-muted/40">
      <td className={cx("truncate py-1.5 pl-5 pr-2", mono)} title={end.id}>
        {end.id}{end.peers.length > 0 && <span className="font-sans text-dim"> {end.here ? "also on" : "on"} {end.peers.join(", ")}</span>}
      </td>
      {end.lane !== null
        ? <td className={cx("px-2 py-1.5", mono)} title={end.lane === "varies" ? "it depends on the rule that sends work here" : "set on this model, its route or the rule that sends it here, so it beats the key's lane"}>{end.lane}</td>
        : <td className={cx("px-2 py-1.5 text-dim", mono)}><span className="border-b border-dashed border-dim" title="the key's lane">{k.lane ?? "default"}</span></td>}
      {end.here ? cell("maxConcurrent", "jobs at once", rule.maxConcurrent ?? 0) : none}
      {end.chat ? cell("tokensPerDay", "tokens a day", rule.tokensPerDay) : none}
      {cell("requestsPerMinute", "requests a minute", rule.requestsPerMinute)}
      <td className="tabular whitespace-nowrap px-2 py-1.5 text-[12px]">
        {now.running === 0 && now.waiting === 0 ? <span className="text-dim">idle</span> : (
          <>
            <span className={jobs > 0 && now.running >= jobs ? "text-warn" : undefined}>{now.running}{jobs > 0 && ` of ${jobs}`}</span>
            {now.waiting > 0 && <span className="text-warn"> · {now.waiting} waiting</span>}
          </>
        )}
      </td>
      <td className="px-2 py-1.5">{end.chat ? <Today used={count(k.byModel.today[end.id])} limit={tokens} /> : <span className="tabular text-dim">{short(k.byModel.today[end.id]?.requests ?? 0)} req</span>}</td>
      <td className="tabular px-2 py-1.5 text-right">{month ? (end.chat ? short(count(month)) : `${short(month.requests)} req`) : <span className="text-dim">—</span>}</td>
    </tr>
  );
}

/** What one key is set to, and everything its router can land on. */
function KeyDetail({ k }: { k: KeyRow }) {
  const settings = useStore((s) => s.data!.keySettings);
  const [groups, setGroups] = useState<Record<string, boolean>>({});
  const rule = k.rule ?? NO_RULE;
  const set = (body: Record<string, unknown>, done: string) => void updateKey(k.label, body, done);
  const openOf = (type: string, ends: ReachEnd[]) => groups[type] ?? (k.reach.length <= 5 || ends.some((e) => k.byModel.month[e.id] || k.now[e.id] || rule.models?.[e.id]));
  const listed = new Set(k.reach.flatMap((t) => t.ends.map((e) => e.id)));
  // Where a name runs as itself the rules cannot list what it may ask for, so its use and its limits stand in.
  const open = k.reach.some((t) => t.asAsked);
  const named = open ? [...new Set([...Object.keys(k.byModel.month), ...Object.keys(rule.models ?? {})])].filter((id) => !listed.has(id)) : [];
  const reach = k.reach.map((t) => (t.asAsked ? { ...t, ends: [...t.ends, ...named.map((id): ReachEnd => ({ id, peers: [], here: true, chat: true, lane: null }))] } : t));
  const reached = new Set(reach.flatMap((t) => t.ends.map((e) => e.id)));
  const stale = open ? [] : Object.keys(rule.models ?? {}).filter((id) => !reached.has(id));
  const clearStale = async () => {
    for (const id of stale) await updateKey(k.label, { model: { id, limits: { maxConcurrent: null, tokensPerDay: null, requestsPerMinute: null } } }, `${id}: its limits cleared`);
  };
  const laneOf = (l: string) => { const c = settings.lanes.find((x) => x.name === l); return c ? `priority ${c.priority}${c.ceiling ? ` · ${c.ceiling} at once` : ""}` : undefined; };
  const heading = "py-2 font-medium";
  return (
    <div className="px-5 pb-4 pt-3">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <Field label="goes by router">
          <button type="button" aria-label={`${k.label}: router`} className={cx(pick, mono)}
                  onClick={(e) => choose(e, settings.routers.map((r) => ({ label: r, value: r, mono: true, on: r === k.router })), (r) => set({ router: r }, `${k.label} now goes by ${r}`))}>
            {k.router}<ChevronDown size={12} className="text-dim" />
          </button>
        </Field>
        <Field label="queues in lane">
          <button type="button" aria-label={`${k.label}: lane`} className={cx(pick, mono)}
                  onClick={(e) => choose(e, [
                    { label: "default", value: "", aside: "what the request asks, else the first lane", on: k.lane === null },
                    ...settings.lanes.map((l) => ({ label: l.name, value: l.name, mono: true, aside: laneOf(l.name) ?? "", on: l.name === k.lane })),
                    { label: "edit lanes on Scheduler", value: "\0scheduler", icon: "split" as const },
                  ], (l) => {
                    if (l === "\0scheduler") return go("scheduler");
                    set({ lane: l === "" ? null : l }, l === "" ? `${k.label} queues as the request asks` : `${k.label} now queues in ${l}`);
                  })}>
            {k.lane ?? "default"}<ChevronDown size={12} className="text-dim" />
          </button>
        </Field>
        <Field label="jobs at once, all models">
          <Num label={`${k.label}: jobs at once`} min={0} none="no limit" className="w-24" value={rule.maxConcurrent ?? 0} onSave={(n) => set({ limits: { maxConcurrent: n === 0 ? null : n } }, "jobs at once saved")} />
        </Field>
        <Field label="tokens a day, whole key">
          <Num label={`${k.label}: tokens a day`} min={0} none="no limit" className="w-28" value={rule.tokensPerDay} onSave={(n) => set({ limits: { tokensPerDay: n === 0 ? null : n } }, "tokens a day saved")} />
        </Field>
        <Field label="requests a minute">
          <Num label={`${k.label}: requests a minute`} min={0} none="no limit" className="w-24" value={rule.requestsPerMinute} onSave={(n) => set({ limits: { requestsPerMinute: n === 0 ? null : n } }, "requests a minute saved")} />
        </Field>
        <Field label="dollars a day">
          <Dollars label={`${k.label}: dollars a day`} value={rule.dollarsPerDay ?? 0} onSave={(n) => set({ limits: { dollarsPerDay: n === 0 ? null : n } }, "dollars a day saved")} />
        </Field>
        <Field label="last day it works">
          <LastDay label={`${k.label}: last day it works`} value={rule.expires === null ? "" : new Date(rule.expires - 1).toISOString().slice(0, 10)}
                   onSave={(day) => set({ expires: day === "" ? null : day }, "last day saved")} />
        </Field>
      </div>
      {k.models !== null && k.models.length > 0 && (
        <p className="mt-3 text-[12px] text-dim">Also held in hearth.yaml to <span className={mono}>{k.models.join(", ")}</span>, and to chat. That list is changed in Config.</p>
      )}
      <div className="mt-4 border-t border-line/60 pt-3">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span aria-hidden className="size-2.5 rounded-sm bg-accent" />
          <h3 className="text-[11px] font-semibold uppercase tracking-wide">what it reaches</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular text-dim">{reached.size} through {k.router}</span>
          <span className="text-[12px] text-dim"><span className="border-b border-dashed border-dim">dashed</span> values are the key's, solid ones the model's own</span>
          <button type="button" onClick={() => go("routing")} className="ml-auto inline-flex h-7 items-center rounded-md border border-line px-2 text-[12px] text-dim hover:border-accent hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">change this in Routing</button>
        </div>
        {stale.length > 0 && (
          <p className="mb-2 text-[12px] text-dim">
            {stale.length === 1 ? "A limit is" : "Limits are"} set on <span className={mono}>{stale.join(", ")}</span>, which {k.router} does not reach.{" "}
            <button type="button" onClick={() => void clearStale()} className="text-accent hover:underline">clear</button>
          </p>
        )}
        {reach.length === 0 ? <p className="text-dim">Its rulebook reaches nothing: whatever it asks for is refused.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[880px] max-w-[1060px] table-fixed text-left">
            <colgroup><col /><col className="w-[92px]" /><col className="w-[104px]" /><col className="w-[116px]" /><col className="w-[92px]" /><col className="w-[132px]" /><col className="w-[126px]" /><col className="w-[64px]" /></colgroup>
            <thead className="text-[11px] text-dim">
              <tr className="border-b border-line/60">
                <th className={cx(heading, "pr-2")}>model</th>
                {["lane", "jobs at once", "tokens a day", "req / min", "running now", "used today"].map((h) => <th key={h} className={cx(heading, "px-2")}>{h}</th>)}
                <th className={cx(heading, "px-2 text-right")}>31 days</th>
              </tr>
            </thead>
            <tbody>
              {reach.map(({ type, ends, asAsked }) => {
                const isOpen = openOf(type, ends);
                return (
                  <Fragment key={type}>
                    <tr className="border-b border-line/40">
                      <td colSpan={8} className="pb-1 pt-2.5">
                        <button type="button" aria-expanded={isOpen} onClick={() => setGroups({ ...groups, [type]: !isOpen })}
                                className="inline-flex items-center gap-1 text-[12px] font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-accent">
                          <ChevronRight size={14} className={cx("text-dim transition-transform", isOpen && "rotate-90")} />{type}
                          <span className="ml-1 rounded-full bg-muted px-1.5 text-[11px] font-normal tabular text-dim">{ends.length}</span>
                        </button>
                      </td>
                    </tr>
                    {isOpen && asAsked && <tr className="border-b border-line/40"><td colSpan={8} className="py-1.5 pl-5 text-[12px] text-dim">any name no rule takes runs as itself, if this node has it; these are the ones it has used or has a limit on</td></tr>}
                    {isOpen && ends.map((e) => e.plugin
                      ? <tr key={e.id} className="border-b border-line/40 last:border-0"><td className={cx("truncate py-1.5 pl-5 pr-2", mono)}>{e.id}</td><td colSpan={7} className="px-2 py-1.5 text-[12px] text-dim">a plugin: it has no queue, so these limits do not apply</td></tr>
                      : <ModelRow key={e.id} k={k} end={e} />)}
                  </Fragment>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

export function Keys() {
  const keys = useStore((s) => s.data!.keys ?? []);
  const others = useStore((s) => s.data!.others ?? []);
  const routers = useStore((s) => s.data!.keySettings.routers);
  const [open, setOpen] = useState<string | null>(null);
  useLink(open ? [open] : [], true, ([l]) => { if (keys.some((k) => k.label === l)) setOpen(l!); });
  const [label, setLabel] = useState("");
  const [router, setRouter] = useState("default");
  const shown = useStore((s) => s.fresh);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const mint = async () => {
    const l = label.trim();
    if (l === "" || busy) return;
    setBusy(true);
    const key = await mintKey(l, null, { router });
    setBusy(false);
    if (key !== null) {
      setCopied(false);
      setLabel("");
      setRouter("default");
      setOpen(l);
    }
  };
  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the text stays selectable either way */ }
  };
  const cell = "px-4 py-2";
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-2.5">
        <div className="font-medium">Keys</div>
        <div className="text-[11px] text-dim">Bearer keys for /v1 on this node. They live in hearth.yaml and a change takes effect at once; what is shown here is a label and a hash, never the secret. Days are UTC; tokens are the backend&rsquo;s own count where its answer carries one, and an estimate where it does not. A key&rsquo;s router and limits hold what it asks for through /v1, for clients that behave: with no models list of its own, it can still reach the rest of this node past them.</div>
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[940px] text-left">
        <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
          <tr>
            <th className={cx(cell, "font-medium")}>label</th>
            <th className={cx(cell, "font-medium")}>id</th>
            <th className={cx(cell, "font-medium")}>router</th>
            <th className={cx(cell, "font-medium")}>limits</th>
            <th className={cx(cell, "font-medium")}>today</th>
            <th className={cx(cell, "font-medium")}>31 days</th>
            <th className={cx(cell, "text-right font-medium")}>last seen</th>
            <th className="w-20" />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const isOpen = open !== null && open === k.label;
            const waiting = Object.values(k.now).reduce((n, m) => n + m.waiting, 0);
            return (
              <Fragment key={k.label || k.id}>
                <tr className={cx("border-b border-line/60 last:border-0", isOpen && "bg-accent/5")}>
                  <td className={cell}>
                    {k.label === "" ? <span className="text-dim">unlabeled</span> : (
                      <button type="button" aria-expanded={isOpen} title="its router, lane and limits" onClick={() => setOpen(isOpen ? null : k.label)}
                              className="inline-flex items-center gap-1 font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-accent">
                        <ChevronRight size={14} className={cx("text-dim transition-transform", isOpen && "rotate-90")} />{k.label}
                      </button>
                    )}
                  </td>
                  <td className={cx(cell, "text-dim", mono)}>{k.id}</td>
                  <td className={cx(cell, mono, k.router === "default" && "text-dim")}>{k.router}</td>
                  <td className={cx(cell, "text-dim")}>{limitsOf(k)}</td>
                  <td className={cx(cell, "tabular")}><UsedCell used={k.today} />{waiting > 0 && <span className="whitespace-nowrap text-warn"> · {waiting} waiting</span>}</td>
                  <td className={cx(cell, "tabular")}><UsedCell used={k.month} /></td>
                  <td className={cx(cell, "tabular text-right", k.lastSeen === null ? "text-dim" : "text-fg")}>{k.lastSeen === null ? "never" : ago(k.lastSeen)}</td>
                  <td className={cx(cell, "whitespace-nowrap text-right")}>
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
                {isOpen && <tr className="border-b border-line last:border-0"><td colSpan={8} className="bg-accent/[0.03] p-0"><KeyDetail k={k} /></td></tr>}
              </Fragment>
            );
          })}
          {/* Whoever else used the node: this machine with no key, and peers. */}
          {others.map((o) => (
            <tr key={o.caller} className="border-b border-line/60 last:border-0">
              <td className={cx(cell, "text-dim")}>{o.caller === "local" ? "this machine, no key" : o.caller.startsWith("peer:") ? `peer ${o.caller.slice(5)}` : o.caller}</td>
              <td className={cx(cell, "text-dim")}>—</td>
              <td className={cx(cell, "text-dim")}>—</td>
              <td className={cx(cell, "text-dim")}>—</td>
              <td className={cx(cell, "tabular")}><UsedCell used={o.today} /></td>
              <td className={cx(cell, "tabular")}><UsedCell used={o.month} /></td>
              <td className={cx(cell, "text-right text-dim")}>—</td><td />
            </tr>
          ))}
        </tbody>
      </table></div>
      {keys.length === 0 && <Empty>No keys yet. Without any, only this machine may call /v1.</Empty>}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" maxLength={40} aria-label="label for a new key"
               onKeyDown={(e) => { if (e.key === "Enter") void mint(); }}
               className="h-8 w-48 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />
        <button type="button" aria-label="router for a new key" className={cx(pick, mono)}
                onClick={(e) => choose(e, routers.map((r) => ({ label: r, value: r, mono: true, on: r === router })), setRouter)}>
          {router}<ChevronDown size={12} className="text-dim" />
        </button>
        <button disabled={busy || label.trim() === ""} onClick={() => void mint()}
                className="h-8 rounded-md bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40">
          {busy ? "minting…" : "mint a key"}
        </button>
        <span className="text-[11px] text-dim">it opens here, to set the rest</span>
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
      <Menu />
    </Card>
  );
}
