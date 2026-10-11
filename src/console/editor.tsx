/**
 * What sits around the routing map: the strip that adds things and reviews the draft, the panel
 * with a node's full settings, the list of places a line can go, and the row that tries a
 * request against the draft.
 */
import { ArrowDown, ArrowUp, ChevronDown, CircleHelp, Plus, RotateCcw, Save, Trash2, Undo2, X, Zap } from "lucide-react";
import { useContext, useEffect, useState } from "react";

import { NewDialog, Refs, refsOf, Review, Value } from "./config.js";
import { ACTIONS, editStep, FACTS, isObj, linesRunning, list, moveStep, nodeOf, obj, problems, put, rawTo, renamed, routeId, text, toOf, toText, withDo, type Doc, type To } from "./draft.js";
import { change, changed, choose, closeMenu, dirty, editSelect, facts, loadDraft, pick, revert, review, tryRequest, undo, useEdit, wire, type Choice } from "./editStore.js";
import { Conds } from "./flowNodes.js";
import { toast, useStore } from "./store.js";
import { Button, cx, mono } from "./ui.js";

const SECTION = { flow: "flows", action: "actions" } as const;

/** A rule to start from: a common shape with its conditions in place and its destinations left to choose. */
const TEMPLATES: { label: string; hint: string; name: string; steps: Doc[] }[] = [
  { label: "Borrow an idle model", hint: "use a bigger model while nobody else is", name: "borrow-idle", steps: [{ when: { idle: { ms: 300_000 }, ready: true }, to: "", max: 2 }, { to: "" }] },
  { label: "Use another model at certain hours", hint: "overnight, say, when nobody is waiting on it", name: "by-hour", steps: [{ when: { time: { from: "22:00", to: "06:00" } }, to: "" }, { to: "" }] },
  { label: "Send images somewhere else", hint: "requests with images go to a model that takes them", name: "images", steps: [{ when: { images: true }, to: "" }, { to: "" }] },
  { label: "Send long prompts somewhere else", hint: "past a size, use a model with more room", name: "long-prompts", steps: [{ when: { tokensOver: 8000 }, to: "" }, { to: "" }] },
  { label: "Stay off a busy model", hint: "use it while its queue is short, else another", name: "when-busy", steps: [{ when: { queuedUnder: 3 }, to: "" }, { to: "" }] },
  { label: "One caller gets its own model", hint: "by api key label", name: "per-caller", steps: [{ when: { caller: [] }, to: "" }, { to: "" }] },
];

/** What each thing on the map means, for the "?" beside the buttons. */
const LEGEND: [string, string][] = [
  ["Router", "this node deciding where a request runs; the same Router the Topology page draws"],
  ["A name with a dot", "a model name clients ask for; drag the dot to say where its requests go"],
  ["Routing rule", "lines checked top to bottom; the first that fits decides"],
  ["\"the target\"", "the model that line sends to"],
  ["Dashed line to an action", "the line also runs that action; it does not change where the request goes"],
  ["3×", "how many requests that line has decided since the rules last changed"],
  ["≤2", "the line takes at most that many at once; the rest go on down the list"],
  ["! and ?", "the line cannot work as drawn, or its model has not said whether it can"],
  ["Lane", "a queue with a priority: chat goes ahead of batch"],
];

/** A first place for a choice between several to start from: something a backend already serves. */
const anyModel = (draft: Doc | null): string =>
  list(Object.values(obj(draft?.backends)).flatMap((b) => list(obj(b).serves)))[0] ?? Object.keys(obj(draft?.models))[0] ?? "";

/** The strip over the graph: add things, and review what the draft changes. */
export function EditBar() {
  const { draft, err, plan, past, unread } = useEdit();
  const hash = useStore((s) => s.data?.config.hash);
  const isDirty = useEdit(dirty);
  const [adding, setAdding] = useState<string | null>(null);
  const changes = useEdit(changed);
  // The draft follows the file: read on arrival, and again whenever the file moves, with any changes here carried over.
  useEffect(() => { void loadDraft(); }, [hash]);
  // With nothing to edit the map is still drawn, and says why it cannot be changed.
  if (!draft) {
    return (
      <div className="absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel/95 px-3 py-2 text-[12px] shadow-sm">
        <span className={unread ? "text-warn" : "text-dim"}>{unread ?? "Reading hearth.yaml…"}</span>
        {unread && <span className="text-dim">Until then this is a picture of the routing in force.</span>}
        <div className="ml-auto"><Button onClick={() => void loadDraft()}>try again</Button></div>
      </div>
    );
  }
  const issues = problems(draft, facts() ?? undefined);
  return (
    <>
      <div className="absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel/95 px-3 py-2 shadow-sm">
        <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 text-[13px] hover:bg-muted"
                onClick={(e) => choose(e, [
                  { label: "start from a common rule", head: true },
                  ...TEMPLATES.map((t) => ({ label: t.label, value: t.name, hint: t.hint })),
                  { label: "or", head: true },
                  { label: "A blank rule…", value: "" },
                ], (v) => {
                  const t = TEMPLATES.find((x) => x.name === v);
                  if (!t) { setAdding("flows"); return; }
                  // A name that is free: the rule opens straight away, to be pointed at the models it is for.
                  let name = t.name;
                  for (let n = 2; name in obj(draft.flows); n++) name = `${t.name}-${n}`;
                  change((d) => put(d, "flows", name, { inputs: [], steps: t.steps }));
                  editSelect({ kind: "flow", id: name });
                })}>
          <Plus size={13} />rule
        </button>
        <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 text-[13px] hover:bg-muted"
                title="something a rule's line sets off beside sending the request on"
                onClick={(e) => choose(e, ACTIONS.map((k) => ({ label: k.label, value: k.key, hint: k.hint })), (k) => setAdding(`actions:${k}`))}>
          <Zap size={13} />action
        </button>
        {isObj(draft.layout) && <Button onClick={() => change(({ layout: _, ...rest }) => rest)}>tidy up</Button>}
        <button type="button" aria-label="what the map shows" title="what the map shows" className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-panel text-dim hover:bg-muted hover:text-fg"
                onClick={(e) => choose(e, LEGEND.map(([label, hint]) => ({ label, hint })), () => {})}>
          <CircleHelp size={14} />
        </button>
        <span className="ml-2 truncate text-[11px] text-dim max-xl:hidden">Only what you have routed is shown. Drag a name's dot to send it elsewhere, or onto a rule.</span>
        <div className="ml-auto flex items-center gap-2">
          {isDirty && <span className="flex items-center gap-1.5 text-[12px] text-accent"><span className="size-1.5 rounded-full bg-accent" />{changes} unsaved {changes === 1 ? "change" : "changes"}</span>}
          <Button disabled={past.length === 0} onClick={undo}><Undo2 size={13} />undo</Button>
          <Button disabled={!isDirty} onClick={revert}><RotateCcw size={13} />discard</Button>
          <Button tone="primary" disabled={!isDirty} onClick={() => void review()}><Save size={13} />review &amp; save</Button>
        </div>
        {err && <div className="w-full text-[12px] text-bad">{err.message}</div>}
        {!err && issues.length > 0 && <div className="w-full text-[12px] text-warn">{issues[0]}{issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}</div>}
      </div>
      {adding === "flows" && (
        <NewDialog spec={{ noun: "routing rule", scope: "flow", keys: [] }} taken={Object.keys(obj(draft.flows))} onClose={() => setAdding(null)}
                   note="The name is only a label for the rule. Next you say which model names it handles, and where each kind of request goes."
                   onCreate={(id) => {
                     // One line that always applies and goes nowhere yet: the rule opens to be filled in.
                     change((d) => put(d, "flows", id, { inputs: [], steps: [{ to: "" }] }));
                     editSelect({ kind: "flow", id });
                     setAdding(null);
                   }} />
      )}
      {adding?.startsWith("actions:") && (
        <NewDialog spec={{ noun: "action", scope: "action", keys: [adding.slice(8)] }} taken={Object.keys(obj(draft.actions))} onClose={() => setAdding(null)}
                   note="Next, drag the dot of a rule's line onto the action to have that line run it."
                   onCreate={(id, vals) => {
                     const kind = ACTIONS.find((k) => k.key === adding.slice(8))!;
                     change((d) => put(d, "actions", id, { [kind.key]: kind.seed, ...vals }));
                     editSelect({ kind: "action", id });
                     setAdding(null);
                   }} />
      )}
      {plan && <Review plan={plan} onClose={() => useEdit.setState({ plan: null })} />}
    </>
  );
}

/* ------------------------------------------------------------------ picker */

/** Where a wire can go, listed where it was let go: a new node, a model, a peer or another switch. */
export function Picker() {
  const picking = useEdit((s) => s.picking);
  const draft = useEdit((s) => s.draft);
  const [q, setQ] = useState("");
  useEffect(() => setQ(""), [picking]);
  if (!picking || !draft) return null;
  const from = picking.from;
  const send = (to: To) => { if (from) wire(from, to); pick(null); };
  const hit = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  // What the outlet is says what it can be sent to: one that chooses between places work can run offers only those.
  const out = from ? nodeOf(from.node).kind.outlet?.(draft, nodeOf(from.node).id, from.handle) ?? null : null;
  const ends = out?.endsOnly ?? false;
  const self = out?.rule ?? null;
  const known = facts();
  // What cannot take a chat request is left out, unless it is searched for by name: then it is shown, and says why not.
  const models = [...new Set(Object.values(obj(draft.backends)).flatMap((b) => list(obj(b).serves)).concat(Object.keys(obj(draft.models))))].filter(hit)
    .filter((m) => q.trim() !== "" || known?.kind(m) !== "paths");
  const peers = Object.keys(obj(draft.peers)).filter(hit);
  const flows = Object.keys(obj(draft.flows)).filter((f) => f !== self && hit(f));
  // A rule one name enters can send it on as itself; with several names there is no single "itself" to offer.
  const entering = self ? list(obj(obj(draft.flows)[self]).inputs) : [];
  const own = entering.length === 1 ? entering[0]! : null;
  const row = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-line/60";
  const head = "px-2 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-dim";
  return (
    <div className="fixed inset-0 z-40" onClick={() => pick(null)}>
      {/* Below what was clicked, or above it when there is no room below: never somewhere else. */}
      <div className="absolute w-72 rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}
           style={{ left: Math.min(picking.x, innerWidth - 300), ...(picking.y + 380 > innerHeight ? { bottom: innerHeight - picking.y + 14 } : { top: picking.y + 6 }) }}>
        <div className="border-b border-line p-2">
          <input autoFocus aria-label="send it to" placeholder="send these requests to…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
                   if (e.key === "Escape") pick(null);
                   // Enter takes the first model that fits what was typed.
                   const first = models.find((m) => known?.kind(m) !== "paths");
                   if (e.key === "Enter" && q.trim() && first) send({ kind: "model", model: first });
                 }}
                 className="h-8 w-full rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />
        </div>
        <div className="max-h-72 overflow-auto p-1.5">
          {!ends && (
            <>
              {(hit("fastest of several") || hit("refuse it")) && <div className={head}>something other than one model</div>}
              {hit("fastest of several") && <button className={row} onClick={() => send({ kind: "fastest", of: [{ kind: "model", model: models[0] ?? anyModel(draft) }, { kind: "model", model: models[1] ?? anyModel(draft) }] })}><span className="size-2 rounded-full bg-ok" />Fastest of several<span className="ml-auto text-[11px] text-dim">whichever starts soonest</span></button>}
              {hit("refuse it") && <button className={row} onClick={() => send({ kind: "refuse", why: "nowhere to run this" })}><span className="size-2 rounded-full bg-bad" />Refuse it<span className="ml-auto text-[11px] text-dim">tell the caller why</span></button>}
            </>
          )}
          {/* Leaving a name alone is a choice too, and the one most lines end on. */}
          {own && hit("its own model") && <button className={row} onClick={() => send({ kind: "model", model: own })}><span className="size-2 rounded-full bg-info" />Its own model<span className="ml-auto text-[11px] text-dim">the default: {own}</span></button>}
          {models.length > 0 && <div className={head}>a model on this node</div>}
          {models.map((m) => {
            const shut = known?.kind(m) === "paths";
            return <button key={m} disabled={shut} title={shut ? `${m} is not a chat model, so a chat request cannot run as it` : undefined} className={cx(row, mono, "disabled:opacity-40")} onClick={() => send({ kind: "model", model: m })}>{m}{shut && <span className="ml-auto font-sans text-[10px] text-dim">not chat</span>}</button>;
          })}
          {peers.length > 0 && <div className={head}>a peer</div>}
          {peers.map((p) => <button key={p} className={row} onClick={() => send({ kind: "peer", peer: p, model: null })}>{p}</button>)}
          {!ends && flows.length > 0 && <div className={head}>another routing rule</div>}
          {!ends && flows.map((f) => <button key={f} className={cx(row, mono)} onClick={() => send({ kind: "flow", flow: f })}>{f}</button>)}
        </div>
      </div>
    </div>
  );
}

/** The one menu the canvas uses: a list of choices under what was clicked, searchable once it is long. */
export function Menu() {
  const m = useEdit((s) => s.choosing);
  const [q, setQ] = useState("");
  useEffect(() => setQ(""), [m]);
  if (!m) return null;
  const long = m.items.filter((i) => !i.head).length > 8;
  const fits = m.items.filter((i) => i.head || i.label.toLowerCase().includes(q.trim().toLowerCase()));
  // A heading with nothing left under it goes too.
  const shown = fits.filter((i, k) => !i.head || (fits[k + 1] !== undefined && !fits[k + 1]!.head));
  return (
    <div className="fixed inset-0 z-50" onClick={closeMenu} onKeyDown={(e) => { if (e.key === "Escape") closeMenu(); }}>
      <div role="menu" className="absolute min-w-44 max-w-sm rounded-xl border border-line bg-panel p-1.5 shadow-2xl" onClick={(e) => e.stopPropagation()}
           style={{ left: Math.min(m.x, innerWidth - 300), ...(m.y + 340 > innerHeight ? { bottom: innerHeight - m.y + 34 } : { top: m.y }) }}>
        {long && <input autoFocus aria-label="filter" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)}
                        onKeyDown={(e) => { const first = shown.find((i) => !i.head && !i.off); if (e.key === "Enter" && first) { closeMenu(); m.onPick(first.value ?? first.label); } }} className="mb-1 h-8 w-full rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />}
        <div className="max-h-72 overflow-auto">
          {shown.map((i, k) => i.head ? (
            <div key={k} className="px-2 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-dim">{i.label}</div>
          ) : (
            <button key={k} role="menuitem" autoFocus={!long && k === m.items.findIndex((x) => !x.head)} disabled={i.off}
                    className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-line/60 focus:bg-line/60 focus:outline-none disabled:opacity-40", i.mono && mono, i.danger && "text-bad", i.on && "font-medium")}
                    onClick={() => { closeMenu(); m.onPick(i.value ?? i.label); }}>
              {/* What a choice is comes first and whole; what it means sits under it. */}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{i.label}</span>
                {i.hint && <span className="block truncate font-sans text-[11px] font-normal text-dim">{i.hint}</span>}
              </span>
              {i.on && <span className="shrink-0 text-accent">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- try */

/**
 * The situations the draft's rules test that cannot be arranged on demand, as things to pretend
 * when a request is tried: only what some line reads is offered.
 */
function situations(draft: Doc, on: string[]): Choice[] {
  const out = new Map<string, string>();
  const callers = new Set<string>();
  const lanes = new Set<string>();
  for (const [rule, f] of Object.entries(obj(draft.flows))) {
    for (const [n, step] of (Array.isArray(obj(f).steps) ? (obj(f).steps as unknown[]) : []).map(obj).entries()) {
      if (typeof step.max === "number") out.set(`full:${n}:${rule}`, `line ${n + 1} of ${rule} already has ${step.max} running`);
      const when = obj(step.when);
      const to = toOf(step.to);
      const target = to.kind === "model" ? to.model : null;
      const idle = isObj(when.idle) ? text(when.idle.model) || target : null;
      if (idle) { out.set(`idle:${idle}`, `${idle} has been idle a long time`); out.set(`used:${idle}`, `${idle} was used a moment ago`); }
      for (const m of list(when.held)) out.set(`held:${m}`, `an app is using the hardware of ${m}`);
      if (target && (when.free !== undefined || when.queuedUnder !== undefined)) out.set(`busy:${target}`, `${target} is full, with a long queue`);
      if (target && (when.warm !== undefined || when.ready !== undefined)) out.set(`warm:${target}`, `${target} is already loaded`);
      if (target && when.ready !== undefined) out.set(`unready:${target}`, `${target} would need a swap`);
      if (isObj(when.time)) { out.set(`now:${text(when.time.from)}`, `the time is ${text(when.time.from)}`); out.set(`now:${text(when.time.to)}`, `the time is ${text(when.time.to)}`); }
      list(when.caller).forEach((c) => callers.add(c));
      list(when.lane).forEach((l) => lanes.add(l));
    }
  }
  return [
    ...(out.size ? [{ label: "pretend that", head: true }] : []),
    ...[...out].map(([value, label]) => ({ label, value, on: on.includes(value) })),
    ...(callers.size ? [{ label: "the caller is", head: true }, ...[...callers].map((c) => ({ label: c, value: `caller:${c}`, on: on.includes(`caller:${c}`) }))] : []),
    ...(lanes.size ? [{ label: "the lane is", head: true }, ...[...lanes].map((l) => ({ label: l, value: `lane:${l}`, on: on.includes(`lane:${l}`) }))] : []),
  ];
}

/** Ask where a request would go under the draft, and light the way it takes. */
export function TryStrip() {
  const { draft, trial, tried, pending } = useEdit();
  // The name last tried stays chosen when the result is cleared.
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => { if (trial) setLast(trial.model); }, [trial]);
  // Every name the node answers to can be tried, routed or not.
  const names = [...new Set([...Object.values(obj(draft?.flows)).flatMap((f) => list(obj(f).inputs)), ...pending, ...Object.values(obj(draft?.backends)).flatMap((b) => list(obj(b).serves))])];
  // Asked again as the draft changes, so the lit path is always the draft's.
  useEffect(() => { if (trial) void tryRequest({ ...trial }); }, [draft]);
  if (!draft || names.length === 0) return null;
  const t = trial ?? { model: last !== null && names.includes(last) ? last : names[0]!, images: false, tools: false, long: false };
  // A draft that would not load cannot be tried: what is wrong is said in the map's words, not the file's.
  const wrong = problems(draft, facts() ?? undefined)[0];
  /** An action as the result names it: one that waits for the end says what for. */
  const runs = (name: string): string => {
    const a = obj(obj(draft.actions)[name]);
    const slow = typeof a.slowerThan === "number" ? ` and takes over ${a.slowerThan / 1000} s` : "";
    return a.on === "failed" ? `${name} (if it fails${slow})` : slow ? `${name} (if it${slow.slice(4)})` : a.on === "finished" ? `${name} (when it ends)` : name;
  };
  const flip = (k: "images" | "tools" | "long") => void tryRequest({ ...t, [k]: !t[k] });
  const toggle = (k: "images" | "tools" | "long", label: string, title: string) => (
    <button type="button" aria-pressed={t[k]} title={title} onClick={(e) => { e.currentTarget.blur(); flip(k); }}
            className={cx("h-8 rounded-lg border px-3 text-[12px] transition-colors", t[k] ? "border-accent bg-accent/15" : "border-line hover:bg-muted")}>{label}</button>
  );
  // What is being pretended, the caller and the lane included, as one list of ticks.
  const ticked = [...(t.pretend ?? []), ...(t.caller ? [`caller:${t.caller}`] : []), ...(t.lane ? [`lane:${t.lane}`] : [])];
  const offered = situations(draft, ticked);
  const tick = (v: string) => {
    const [kind, ...rest] = v.split(":");
    const name = rest.join(":");
    if (kind === "caller") return void tryRequest({ ...t, caller: t.caller === name ? undefined : name });
    if (kind === "lane") return void tryRequest({ ...t, lane: t.lane === name ? undefined : name });
    // Idle and just used are the two answers to one question.
    const rival = kind === "idle" ? `used:${name}` : kind === "used" ? `idle:${name}` : kind === "warm" ? `unready:${name}` : kind === "unready" ? `warm:${name}` : "";
    const had = t.pretend ?? [];
    // And the clock reads one time.
    void tryRequest({ ...t, pretend: had.includes(v) ? had.filter((p) => p !== v) : [...had.filter((p) => p !== rival && !(kind === "now" && p.startsWith("now:"))), v] });
  };
  const decided = tried?.path.at(-1);
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-4 py-2.5">
      <span className="font-medium">Try a request</span>
      <span className="text-dim">asking for</span>
      <button type="button" aria-label="the name asked for" className={cx("flex h-8 items-center gap-1.5 rounded-lg border border-line bg-bg px-2.5 hover:bg-muted", mono)}
              onClick={(e) => choose(e, names.map((m) => ({ label: m, mono: true, on: m === t.model })), (m) => void tryRequest({ ...t, model: m }))}>
        {t.model}<ChevronDown size={12} className="text-dim" />
      </button>
      {toggle("images", "with images", "the request carries an image")}
      {toggle("long", "long prompt", "a prompt of about 50,000 tokens, where a short one is about 200")}
      {toggle("tools", "with tools", "the request offers tools to call")}
      {offered.length > 0 && (
        <button type="button" title="state your rules test that cannot be arranged on demand: pretend it, and see which line decides"
                className={cx("flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] transition-colors", ticked.length ? "border-accent bg-accent/15" : "border-line hover:bg-muted")}
                onClick={(e) => choose(e, offered, tick)}>
          {ticked.length ? `pretending ${ticked.length}` : "pretend…"}<ChevronDown size={12} className="text-dim" />
        </button>
      )}
      {!trial ? <Button onClick={() => void tryRequest(t)}>show where it goes</Button> : (
        <>
          <span className="text-dim">→</span>
          {!tried ? <span className="text-dim">…</span>
            : tried.error ? <span className="text-bad">{wrong ? `Fix this first: ${wrong}` : tried.error}</span>
            : tried.target === "unavailable" ? <span className="font-medium text-bad">refused: {tried.reason}</span>
            : (
              <>
                <span className={cx("font-medium", mono)}>{tried.model}</span>
                <span className="text-dim">{tried.peer ? `on the peer ${tried.peer}` : `on the ${tried.backend} backend`}</span>
                {tried.unfit && <span className="font-medium text-bad">but it would be turned down: {tried.unfit}</span>}
                {(tried.actions ?? []).length > 0 && <span className="flex items-center gap-1 text-warn"><Zap size={12} />and runs {tried.actions!.map(runs).join(", ")}</span>}
                <span className="text-dim">· {decided ? `decided by rule ${decided.flow}, ${decided.step === (obj(obj(draft.flows)[decided.flow]).steps as unknown[] | undefined ?? []).length - 1 ? "its Otherwise line" : `line ${decided.step + 1}`}` : "no rule: it runs as itself"}</span>
              </>
            )}
          <button type="button" aria-label="stop trying" title="clear" className="ml-auto text-dim hover:text-fg" onClick={() => void tryRequest(null)}><X size={14} /></button>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- rail */

const PICK = "inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-[12px] hover:border-accent focus:border-accent focus:outline-none";

/** One rule, line by line, at a size that is comfortable to work in: the same parts the node shows, with room to breathe. */
function Lines({ name, flow }: { name: string; flow: Doc }) {
  const refs = useContext(Refs);
  const err = useEdit((s) => s.err);
  const steps = (Array.isArray(flow.steps) ? flow.steps : []).map(obj);
  const last = steps.length - 1;
  const edit = (i: number, fn: (s: Doc) => Doc | null) => change((d) => editStep(d, name, i, fn));
  const from = (e: { clientX: number; clientY: number }, node: string, handle: string) => pick({ x: e.clientX, y: e.clientY, from: { node, handle } });
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-dim">Checked top to bottom. The first line that fits decides where the request goes.</div>
      {steps.map((r, i) => {
        const to = toOf(r.to);
        return (
          <div key={i} className="rounded-lg border border-line bg-bg/40 p-2.5">
            <div className="flex items-start gap-2">
              <span className="pt-1 text-[12px] font-medium">{i === last ? "Otherwise" : "If"}</span>
              {i < last && <div className="min-w-0 flex-1 pt-0.5 text-[12px]"><Conds when={obj(r.when)} models={refs.models} optional={to.kind === "peer"} onChange={(w) => edit(i, (x) => ({ ...x, when: w }))} /></div>}
              {i < last && (
                <span className="ml-auto flex shrink-0 gap-1 pt-1 text-dim">
                  <button aria-label={`move line ${i + 1} up`} title="move up" disabled={i === 0} className="hover:text-fg disabled:opacity-30" onClick={() => change((d) => moveStep(d, name, i, -1))}><ArrowUp size={14} /></button>
                  <button aria-label={`move line ${i + 1} down`} title="move down" disabled={i >= last - 1} className="hover:text-fg disabled:opacity-30" onClick={() => change((d) => moveStep(d, name, i, 1))}><ArrowDown size={14} /></button>
                  <button aria-label={`delete line ${i + 1}`} title="delete this line" className="hover:text-bad" onClick={() => edit(i, () => null)}><Trash2 size={14} /></button>
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
              <span className="text-dim">{to.kind === "refuse" ? "then" : "send to"}</span>
              <button type="button" className={cx(PICK, mono, to.kind === "unset" && "border-warn text-warn")} onClick={(e) => from(e, `flow:${name}`, `step-${i}`)}>
                <span className="truncate">{to.kind === "unset" ? "choose where" : to.kind === "model" && list(flow.inputs).includes(to.model) ? "its own model" : toText(to)}</span><ChevronDown size={12} className="shrink-0 text-dim" />
              </button>
              {i < last && to.kind !== "refuse" && (
                <label className="flex items-center gap-1.5" title="The most requests this line takes at once. Past it, requests go on down the list. Empty is no limit.">
                  <span className="text-dim">at most</span>
                  <input aria-label="most at once" type="number" min={1} placeholder="any" className="h-8 w-14 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" value={typeof r.max === "number" ? r.max : ""}
                         onChange={(e) => edit(i, ({ max: _, ...x }) => (Number(e.target.value) >= 1 ? { ...x, max: Math.floor(Number(e.target.value)) } : x))} />
                  <span className="text-dim">at once,</span>
                </label>
              )}
              {to.kind !== "refuse" && <span className="text-dim" title="A lane is a queue with a priority: chat goes ahead of batch.">queued in</span>}
              {to.kind !== "refuse" && <button type="button" className={PICK}
                      onClick={(e) => choose(e, [{ label: "the model's own lane", value: "", on: text(r.lane) === "" }, ...refs.lanes.map((l) => ({ label: `the ${l} lane`, value: l, on: text(r.lane) === l }))],
                        (l) => edit(i, ({ lane: _, ...x }) => (l ? { ...x, lane: l } : x)))}>
                {text(r.lane) ? `the ${text(r.lane)} lane` : "the model's own lane"}<ChevronDown size={12} className="shrink-0 text-dim" />
              </button>}
            </div>
            {to.kind === "fastest" && (
              <div className="mt-2 flex flex-col gap-1.5 border-l-2 border-ok/50 pl-3 text-[12px]">
                <span className="text-dim">whichever of these would start it soonest (a tie stays with the first):</span>
                {to.of.map((e, k) => (
                  <div key={k} className="flex items-center gap-1.5">
                    <button type="button" className={cx(PICK, mono, "min-w-0 flex-1 justify-between")} onClick={(ev) => from(ev, `fastest:${name}:${i}`, `end-${k}`)}><span className="truncate">{toText(e)}</span><ChevronDown size={12} className="shrink-0 text-dim" /></button>
                    <button aria-label={`remove ${toText(e)}`} disabled={to.of.length <= 2} className="text-dim hover:text-bad disabled:opacity-30" onClick={() => edit(i, (x) => ({ ...x, to: rawTo({ kind: "fastest", of: to.of.filter((_, n) => n !== k) }) }))}><X size={13} /></button>
                  </div>
                ))}
                <div><button type="button" className={cx(PICK, "text-dim")} onClick={(ev) => from(ev, `fastest:${name}:${i}`, "new")}><Plus size={13} />add another place</button></div>
              </div>
            )}
            {to.kind === "refuse" && (
              <label className="mt-2 flex items-center gap-2 text-[12px]"><span className="shrink-0 text-dim">and tell the caller</span>
                <input className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" value={to.why} onChange={(e) => edit(i, (x) => ({ ...x, to: { refuse: e.target.value } }))} />
              </label>
            )}
            {isObj(obj(r.when).idle) && obj(r.when).free === undefined && obj(r.when).warm === undefined && obj(r.when).ready === undefined && typeof r.max !== "number" && (
              <div className="mt-2 text-[11px] text-dim">
                Idle is not the same as ready, and every request that arrives while it is idle goes there.{" "}
                <button type="button" className="underline hover:text-fg" onClick={() => edit(i, (x) => ({ ...x, when: { ...obj(x.when), ready: true } }))}>Add "needs no swap"</button> so borrowing never pushes another model out, and set "at most" to cap how many it takes at once.
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="text-dim">and run</span>
              {list(r.do).map((a) => (
                <span key={a} className={cx("inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2", mono)}>
                  <Zap size={11} className="text-warn" />{a}
                  <button aria-label={`stop running ${a}`} className="text-dim hover:text-bad" onClick={() => change((d) => withDo(d, name, i, a, false) ?? d)}><X size={12} /></button>
                </span>
              ))}
              <button type="button" className={cx(PICK, "h-7 border-dashed text-dim")}
                      onClick={(e) => choose(e, refs.actions.filter((a) => !list(r.do).includes(a)).map((a) => ({ label: a, mono: true })).concat(refs.actions.length ? [] : [{ label: "no actions yet: + action makes one", mono: false }]),
                        (a) => { if (refs.actions.includes(a)) change((d) => withDo(d, name, i, a, true) ?? d); })}>
                <Plus size={12} />an action
              </button>
            </div>
            <details className="mt-2" open={isObj(r.params)}>
              <summary className="cursor-pointer text-[11px] text-dim">request fields to set on the way (params)</summary>
              <div className="border-l-2 border-line pl-3">
                <Value name="params" v={obj(r.params)} path={["flows", name, "steps", i, "params"]} err={err} compact
                       onChange={(p) => edit(i, ({ params: _, ...x }) => (isObj(p) && Object.keys(p).length ? { ...x, params: p } : x))} />
              </div>
            </details>
          </div>
        );
      })}
      <div><Button onClick={() => change((d) => put(d, "flows", name, { ...flow, steps: [...steps.slice(0, -1), { when: {}, to: "" }, steps.at(-1)!] }))}><Plus size={13} />add an "if" line</Button></div>
    </div>
  );
}

/** The model names a rule handles: add one that exists, or a new one that only the rule answers. */
function Names({ flow, names, options }: { flow: string; names: string[]; options: string[] }) {
  const [typing, setTyping] = useState<string | null>(null);
  const add = (v: string) => { const id = v.trim(); setTyping(null); if (id) change((d) => routeId(d, id, { kind: "flow", flow })); };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {names.map((n) => (
        <span key={n} className={cx("inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-[12px]", mono)}>
          {n}<button aria-label={`stop sending ${n} here`} title={`stop sending requests for ${n} to this rule`} className="text-dim hover:text-bad" onClick={() => change((d) => routeId(d, n, { kind: "model", model: n }))}><X size={12} /></button>
        </span>
      ))}
      {typing === null ? (
        <button type="button" className={cx(PICK, "h-7 border-dashed text-dim")}
                onClick={(e) => choose(e, [{ label: "A new name…", value: "\u0000new", hint: "one nothing serves yet, like auto" }, { label: "a name this node already answers to", head: true }, ...options.filter((o) => !names.includes(o)).map((o) => ({ label: o, mono: true }))],
                  (v) => (v === "\u0000new" ? setTyping("") : add(v)))}>
          <Plus size={12} />a model name
        </button>
      ) : (
        <input autoFocus aria-label="a new model name" placeholder="any name, e.g. auto" value={typing} onChange={(e) => setTyping(e.target.value)}
               onBlur={() => add(typing)} onKeyDown={(e) => { if (e.key === "Enter") add(typing); if (e.key === "Escape") setTyping(null); }}
               className={cx("h-7 w-44 rounded-md border border-accent bg-bg px-2 text-[12px] focus:outline-none", mono)} />
      )}
    </div>
  );
}

/** What was selected is no longer in the draft (an undo took it away): the panel closes itself. */
function Gone() {
  useEffect(() => editSelect(null), []);
  return null;
}

/** What is selected on the map, with room to work: a rule line by line, or an action's settings as the Config page shows them. */
export function EditRail() {
  const { draft, sel, err } = useEdit();
  const data = useStore((s) => s.data);
  if (!draft || !sel) return null;
  const section = SECTION[sel.kind];
  const entry = obj(draft[section])[sel.id];
  const self = data?.net.nodes.find((n) => n.self);
  const catalog = [...(data?.catalog ?? []), ...(self?.backends ?? []).flatMap((b) => [...(b.serves ?? []), ...(b.loaded ?? [])])];
  // An action taken away is taken off every line that ran it, so the file still loads.
  // What runs this action, so taking it away is not a surprise.
  const users = sel.kind === "action" ? linesRunning(draft, sel.id) : [];
  const rename = (to: string) => {
    const next = renamed(draft, section, sel.id, to.trim());
    if (!next) { if (to.trim() && to.trim() !== sel.id) toast("bad", `"${to.trim()}" is taken, or not a name`); return; }
    change(() => next);
    editSelect({ kind: sel.kind, id: to.trim() });
  };
  const remove = () => {
    if (users.length) toast("ok", `${sel.id} deleted, and taken off ${users.length} ${users.length === 1 ? "line" : "lines"} that ran it — undo brings it back`);
    change((d) => {
      const gone = put(d, section, sel.id, undefined);
      if (sel.kind !== "action") return gone;
      return Object.entries(obj(gone.flows)).reduce((doc, [name, f]) =>
        (Array.isArray(obj(f).steps) ? (obj(f).steps as unknown[]) : []).reduce<Doc>((x, _, i) => withDo(x, name, i, sel.id, false) ?? x, doc), gone);
    });
    editSelect(null);
  };
  return (
    <aside className="w-[480px] shrink-0 overflow-auto border-l border-line bg-panel p-4 max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-10 max-lg:max-w-full">
      <div className="mb-3 flex items-center gap-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-dim">{sel.kind === "flow" ? "routing rule" : "action"}</div>
          {isObj(entry)
            ? <input key={sel.id} aria-label="name" title="click to rename" defaultValue={sel.id} className={cx("w-full truncate rounded border border-transparent bg-transparent text-base font-semibold hover:border-line focus:border-accent focus:outline-none", mono)}
                     onBlur={(e) => { rename(e.target.value); e.target.value = sel.id; }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = sel.id; e.currentTarget.blur(); } }} />
            : <div className={cx("truncate text-base font-semibold", mono)}>{sel.id}</div>}
        </div>
        {isObj(entry) && <button className="ml-auto text-dim hover:text-bad" aria-label={`delete ${sel.id}`} onClick={remove}><Trash2 size={15} /></button>}
        <button className={cx("text-dim hover:text-fg", !isObj(entry) && "ml-auto")} aria-label="close" onClick={() => editSelect(null)}><X size={16} /></button>
      </div>
      <Refs.Provider value={refsOf(draft, catalog)}>
        {!isObj(entry) ? <Gone />
          : sel.kind === "flow" ? (
            <>
              <div className="mb-4 flex flex-col gap-2 text-[12px]">
                <label className="flex items-center gap-2"><input type="checkbox" checked={entry.off !== true} onChange={(e) => change((d) => { const { off: _, ...rest } = obj(obj(d.flows)[sel.id]); return put(d, "flows", sel.id, e.target.checked ? rest : { ...rest, off: true }); })} />
                  <span>{entry.off === true ? "Switched off: its names run as themselves" : "On"}</span></label>
                <label className="flex items-center gap-2" title="A later turn of a conversation goes where its first turn went, while that model can take it. Without this, each turn is decided afresh and a chat can change model midway.">
                  <input type="checkbox" checked={typeof entry.sticky === "number"} onChange={(e) => change((d) => { const { sticky: _, ...rest } = obj(obj(d.flows)[sel.id]); return put(d, "flows", sel.id, e.target.checked ? { ...rest, sticky: 1_800_000 } : rest); })} />
                  <span>Keep a conversation on the model it started with</span>
                  {typeof entry.sticky === "number" && (
                    <><span className="text-dim">for</span>
                      <input aria-label="minutes a conversation stays put" type="number" min={1} className="h-7 w-16 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" value={entry.sticky / 60_000}
                             onChange={(e) => change((d) => put(d, "flows", sel.id, { ...obj(obj(d.flows)[sel.id]), sticky: Math.max(1000, Math.round(Number(e.target.value) * 60_000)) }))} />
                      <span className="text-dim">min</span></>
                  )}
                </label>
                <input aria-label="what this rule is for" placeholder="a note: what this rule is for" className="h-8 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" value={text(entry.note)}
                       onChange={(e) => change((d) => { const { note: _, ...rest } = obj(obj(d.flows)[sel.id]); return put(d, "flows", sel.id, e.target.value ? { ...rest, note: e.target.value } : rest); })} />
              </div>
              <div className="mb-1 text-[12px] font-medium">When a request asks for</div>
              <Names flow={sel.id} names={list(entry.inputs)} options={refsOf(draft, catalog).models} />
              {list(entry.inputs).length === 0 && <div className="mt-1 text-[11px] text-warn">Nothing reaches this rule yet. Add a model name here, or drag a name's blue dot from the node onto the rule.</div>}
              <div className="mb-1 mt-4 text-[12px] font-medium">decide where it goes</div>
              <Lines name={sel.id} flow={entry} />
            </>
          )
          : (
            <>
              <div className="mb-3 text-[12px] text-dim">
                Runs when a line that names it decides, beside sending the request on: it never changes where the request goes and never holds it up.
                Text may use {FACTS.slice(0, -5).map((f) => <span key={f} className={mono}>{`{${f}} `}</span>)}
                and, with <span className={mono}>on</span> set to finished or failed, how it ended: <span className={mono}>{"{outcome} {ms} {queuedMs} {ranMs} {error}"}</span> (times in ms).
              </div>
              <div className="mb-3 text-[12px]">
                {users.length === 0 ? <span className="text-warn">No line runs this yet: drag a line's dot onto it, or pick it under a line's "and run".</span>
                  : <span className="text-dim">Run by {users.map(([rule, i]) => `${rule} line ${i + 1}`).join(", ")}.</span>}
              </div>
              <Value name={sel.id} v={entry} path={[section, sel.id]} err={err} compact onChange={(n) => change((d) => put(d, section, sel.id, n))} />
            </>
          )}
      </Refs.Provider>
    </aside>
  );
}
