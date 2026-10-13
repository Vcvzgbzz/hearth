/**
 * What sits around the routing map: the strip that adds things and reviews the draft, the panel
 * with a node's full settings, the list of places a line can go, and the row that tries a
 * request against the draft.
 */
import { ArrowDown, ArrowUp, ChevronDown, CircleHelp, History, Plus, Redo2, RefreshCw, Split, RotateCcw, Save, Search, Trash2, Undo2, Users, X, Zap } from "lucide-react";
import { useContext, useEffect, useState } from "react";

import { NewDialog, Refs, refsOf, Review, Value } from "./config.js";
import { ACTIONS, arranged, callersIn, directTo, EVERYONE, editStep, FACTS, isObj, linesRunning, list, moveStep, nodeOf, obj, problems, put, rawTo, routeId, TEMPLATES, text, tidied, toOf, toText, usersOf, withCaller, withDo, type Doc, type To } from "./draft.js";
import { addRouter, change, choose, chooseAt, closeMenu, copy, copyMany, dirty, duplicate, edits, closeRule, editSelect, openRule, type EditSel, facts, focusOn, goBack, loadDraft, paste, pick, redo, remove, removeMany, removeRouter, selectMany, rename, revert, review, setAdding, showRouter, startRule, tryRequest, undo, useEdit, versions, wire, type Choice } from "./editStore.js";
import { HUE } from "./flowNodes.js";
import { Conds } from "./flowNodes.js";
import { useStore } from "./store.js";
import { Button, cx, Dialog, mono } from "./ui.js";

const SECTION = { flow: "flows", action: "actions" } as const;

/** What each thing on the map means, for the "?" beside the buttons. */
const LEGEND: [string, string][] = [
  ["Router", "this node deciding where a request runs; the same Router the Topology page draws"],
  ["Type", "a name clients ask for, drawn with a dot; drag the dot to say where its requests go"],
  ["Routing rule", "lines checked top to bottom; the first that fits decides"],
  ["In order", "places a line tries in turn: the next one when one fails before it answers"],
  ["\"the target\"", "the model that line sends to"],
  ["Dashed line to an action", "the line also runs that action; it does not change where the request goes"],
  ["3×", "how many requests that line has decided since the rules last changed"],
  ["≤2", "the line takes at most that many at once; the rest go on down the list"],
  ["! and ?", "the line cannot work as drawn, or its model has not said whether it can"],
  ["Lane", "a queue with a priority: chat goes ahead of batch"],
  ["In hearth.yaml", "a rule is a flow, its lines are its steps, a type is one of its inputs, and a machine is a server"],
];
/** The legend as the menu draws it: a swatch for each colour a dot or line can wear, then what each thing means. */
const legend = (): Choice[] => [
  { label: "a dot wears the colour of what it is plugged into", head: true },
  ...Object.values(HUE).map((h) => ({ label: h.says, swatch: h.stroke, still: true })),
  { label: "what is on the map", head: true },
  ...LEGEND.map(([label, hint]) => ({ label, hint, still: true })),
];

/** The choices for adding a rule: the common shapes, then a blank one. */
export const ruleChoices = (): Choice[] => [
  { label: "start from a common rule", head: true },
  ...TEMPLATES.map((t) => ({ label: t.label, value: `rule:${t.name}`, hint: t.hint })),
  { label: "A blank rule…", value: "rule:" },
];

/**
 * Everything on the map that can be gone to, for the search: the names that are routed, the rules,
 * the actions, and the models and peers a line ends at.
 */
export function finding(draft: Doc): Choice[] {
  const flows = Object.entries(obj(draft.flows)).map(([name, f]) => ({ name, inputs: list(obj(f).inputs), steps: (Array.isArray(obj(f).steps) ? (obj(f).steps as unknown[]) : []).map(obj) }));
  const rules = flows.filter((f) => directTo(f.name, f) === null);
  const ends = flows.flatMap((f) => f.steps.flatMap((s) => { const t = toOf(s.to); return t.kind === "fastest" ? t.of : t.kind === "model" || t.kind === "peer" ? [t] : []; }));
  const models = [...new Set(ends.flatMap((e) => (e.kind === "model" ? [e.model] : [])))];
  const peers = [...new Set(ends.flatMap((e) => (e.kind === "peer" ? [e.peer] : [])))];
  const names = [...new Set(flows.flatMap((f) => f.inputs))];
  const group = (label: string, items: Choice[]): Choice[] => (items.length ? [{ label, head: true }, ...items] : []);
  return [
    ...group("routing rules", rules.map((f) => ({ label: f.name, value: `flow:${f.name}`, mono: true, hint: f.inputs.length ? `takes ${f.inputs.join(", ")}` : "nothing reaches it yet" }))),
    ...group("actions", Object.keys(obj(draft.actions)).map((a) => ({ label: a, value: `action:${a}`, mono: true }))),
    ...group("types that are routed", names.map((n) => ({ label: n, value: `name:${n}`, mono: true, hint: `goes into ${flows.find((f) => f.inputs.includes(n))!.name}` }))),
    ...group("models a line ends at", models.map((m) => ({ label: m, value: `model:${m}`, mono: true }))),
    ...group("peers a line ends at", peers.map((p) => ({ label: p, value: `peer:${p}`, mono: true }))),
  ];
}

/** Open what can be edited: a rule in its dialog, an action in the side panel. */
const show = (on: NonNullable<EditSel>) => (on.kind === "flow" ? openRule(on.id) : editSelect(on));

/** Go to what a search found: bring it into view, and open it when it has a panel. */
export function goTo(value: string): void {
  const node = value.startsWith("name:") ? "self" : value;
  focusOn(node);
  const at = nodeOf(node);
  const open = at.kind.opens?.(at.id);
  if (open) show(open);
}

/** Open the search over the map's nodes, at a point on the page. */
export const openSearch = (x: number, y: number) => {
  const { draft } = useEdit.getState();
  if (draft) chooseAt(x, y, finding(draft), goTo, true);
};

/**
 * The menu a right-click opens: on empty map, what can be added and found; on a rule or an
 * action, what can be done with it.
 */
export function contextMenu(e: { clientX: number; clientY: number }, node: string | null): void {
  const { draft } = useEdit.getState();
  if (!draft) return;
  const at = node ? nodeOf(node) : null;
  const on = at?.kind.opens?.(at.id) ?? null;
  const entry = on ? obj(obj(draft[SECTION[on.kind]])[on.id]) : {};
  const items: Choice[] = on ? [
    { label: `${on.kind === "flow" ? "rule" : "action"} ${on.id}`, head: true },
    { label: "Edit…", value: "edit", hint: "its name is changed there, or by clicking it" },
    { label: "Duplicate", value: "duplicate", hint: "⌘D, or ⌘C then ⌘V" },
    ...(on.kind === "flow" ? [{ label: entry.off === true ? "Switch on" : "Switch off", value: "toggle", hint: entry.off === true ? undefined : "its names run as themselves until it is on again" }] : []),
    { label: "Delete", value: "delete", danger: true, hint: "or press Delete" },
    { label: "the map", head: true },
  ] : [];
  chooseAt(e.clientX, e.clientY, [
    ...items,
    { label: "Find a node…", value: "find", hint: "or press /" },
    ...ruleChoices(),
    { label: "add an action", head: true },
    ...ACTIONS.map((k) => ({ label: k.label, value: `action:${k.key}`, hint: k.hint })),
    { label: "view", head: true },
    { label: "Fit everything in view", value: "fit" },
    ...(arranged(draft) ? [{ label: "Tidy up", value: "tidy", hint: "back to the automatic arrangement" }] : []),
  ], (v) => {
    if (v === "find") openSearch(e.clientX, e.clientY);
    else if (v.startsWith("rule:")) startRule(v.slice(5));
    else if (v.startsWith("action:")) setAdding(`actions:${v.slice(7)}`);
    else if (v === "fit") focusOn("*");
    else if (v === "tidy") change(tidied);
    else if (on && v === "duplicate") duplicate(on);
    else if (on && v === "edit") { show(on); focusOn(node!); }
    else if (on && v === "delete") remove(on);
    else if (on && v === "toggle") change((d) => { const { off: _, ...rest } = obj(obj(d.flows)[on.id]); return put(d, "flows", on.id, entry.off === true ? rest : { ...rest, off: true }); });
  });
}

/** The versions button for a page with no map: it brings the list, the review and the file they need with it. */
export function VersionsHere() {
  const plan = useEdit((s) => s.plan);
  const hash = useStore((s) => s.data?.config.hash);
  useEffect(() => { void loadDraft(); }, [hash]);
  return (
    <>
      <VersionsButton />
      <Menu />
      {plan && <Review plan={plan} onClose={() => useEdit.setState({ plan: null })} />}
    </>
  );
}

/** A caller as the console names it: everyone not sent somewhere else is "default". */
const said = (caller: string) => (caller === EVERYONE ? "default" : caller);

/** List the published versions at a point on the page; choosing one shows what going back to it changes. */
export function openVersions(x: number, y: number): void {
  void versions().then((all) => chooseAt(x, y, all.length === 0 ? [{ label: "nothing has been published from here yet", off: true }] : [
    { label: "go back to", head: true },
    // Newest first; the one that is the file as it stands is marked, and is nowhere to go back to.
    ...all.map((v) => ({ label: v.name || "unnamed", value: v.hash, hint: `${new Date(v.at).toLocaleString()}${v.hash === useEdit.getState().file?.hash ? " · the file now" : ""}`, off: v.hash === useEdit.getState().file?.hash })).reverse(),
  ], (hash) => { const v = all.findLast((x) => x.hash === hash); if (v) void goBack(v); }, all.length > 8));
}

/** The versions that have been published, to see what one changed and go back to it. */
export function VersionsButton() {
  return (
    <button type="button" aria-label="published versions" title="the versions that have been published: see what one changed, and go back to it" className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-[12px] text-dim hover:bg-muted hover:text-fg"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  openVersions(r.left, r.bottom + 4);
                }}>
          <History size={13} />versions
    </button>
  );
}

/** A first place for a choice between several to start from: something a backend already serves. */
const anyModel = (draft: Doc | null): string =>
  list(Object.values(obj(draft?.backends)).flatMap((b) => list(obj(b).serves)))[0] ?? Object.keys(obj(draft?.models))[0] ?? "";

/** The strip over the graph: add things, and review what the draft changes. */
export function EditBar() {
  const { draft, err, plan, past, future, unread, adding, router } = useEdit();
  const hash = useStore((s) => s.data?.config.hash);
  const isDirty = useEdit(dirty);
  // The map's keys, from anywhere on the page unless something is being typed into or a list is open:
  // "/" searches, Delete takes out what is selected, and copy, paste, duplicate and undo are where they always are.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const s = useEdit.getState();
      if (el?.closest("input, textarea, select, [contenteditable]") || s.choosing || s.picking || s.adding || s.plan || !s.draft) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      // Several nodes picked out together are acted on together, before the one that is open.
      const several = s.many.length > 1;
      if (k === "/" && !mod) openSearch(innerWidth / 2 - 150, 120);
      else if ((e.key === "Backspace" || e.key === "Delete") && !mod && several) removeMany();
      else if ((e.key === "Backspace" || e.key === "Delete") && !mod && s.sel) remove(s.sel);
      else if (mod && k === "d" && several) { if (copyMany()) paste(); }
      else if (mod && k === "d" && s.sel) duplicate(s.sel);
      // Text that is selected on the page is what a copy is for, before any node.
      else if (mod && k === "c" && several && !String(getSelection() ?? "")) copyMany();
      else if (mod && k === "c" && s.sel && !String(getSelection() ?? "")) copy(s.sel);
      else if (mod && k === "v" && !e.shiftKey) paste();
      else if (mod && k === "z") (e.shiftKey ? redo : undo)();
      else if (e.key === "Escape" && (s.sel || several)) { editSelect(null); selectMany([]); }
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  const changes = useEdit(edits);
  // The draft follows the file: read on arrival, and again whenever the file moves, with any changes here carried over.
  useEffect(() => { void loadDraft(); }, [hash]);
  // With nothing to edit the map is still drawn, and says why it cannot be changed.
  if (!draft) {
    return (
      <div className="relative z-10 mx-3 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[12px] shadow-sm">
        <span className={unread ? "text-warn" : "text-dim"}>{unread ?? "Reading hearth.yaml…"}</span>
        {unread && <span className="text-dim">Until then this is a picture of the routing in force.</span>}
        <div className="ml-auto"><Button onClick={() => void loadDraft()}>try again</Button></div>
      </div>
    );
  }
  const issues = problems(draft, facts() ?? undefined);
  return (
    <>
      <div className="relative z-10 mx-3 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 shadow-sm">
        {/* Which rulebook is on the map: the one everyone goes by, or a router some callers have to themselves. */}
        <button type="button" aria-label="the router being edited" title="which rulebook is on the map: the default one, or a router some callers have to themselves"
                className={cx("flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] hover:bg-muted", router === null ? "border-line bg-panel" : "border-accent bg-accent/10")}
                onClick={(e) => choose(e, [
                  { label: "edit the rules of", head: true },
                  { label: "The default router", value: "show:", hint: usersOf(draft, null).length ? `used by ${usersOf(draft, null).map(said).join(", ")}` : "nobody uses it now", on: router === null },
                  ...Object.keys(obj(draft.routers)).map((name) => ({ label: name, value: `show:${name}`, mono: true, on: router === name, hint: usersOf(draft, name).length ? `used by ${usersOf(draft, name).map(said).join(", ")}` : "nobody uses it yet" })),
                  { label: "a router of their own for some callers", head: true },
                  { label: "New, starting from these rules…", value: "new:copy", hint: "then change what should differ" },
                  { label: "New, refusing everything…", value: "new:empty", hint: "then add only what its callers may ask for" },
                ], (v) => (v.startsWith("show:") ? showRouter(v.slice(5) || null) : setAdding(`routers:${v.slice(4)}`)))}>
          <Split size={13} className="text-accent" /><span className={router === null ? "" : mono}>{router ?? "default router"}</span><ChevronDown size={12} className="text-dim" />
        </button>
        {router !== null && (() => {
          const mine = obj(obj(draft.routers)[router]);
          const uses = usersOf(draft, router);
          return (
            <>
              <button type="button" title="whose requests go by this router; everyone else goes by the default one" className={cx("flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] hover:bg-muted", uses.length ? "border-line" : "border-warn text-warn")}
                      onClick={(e) => choose(e, [{ label: "requests from", head: true }, ...callersIn(draft).map((c) => ({ label: said(c), value: c, mono: c !== EVERYONE, on: uses.includes(c), hint: c === EVERYONE ? "every caller not sent somewhere else" : c === "local" ? "this machine, with no api key" : "the api key with this label" }))],
                        (c) => change((d) => withCaller(d, c, uses.includes(c) ? null : router)))}>
                {uses.length ? `used by ${uses.map(said).join(", ")}` : "used by nobody yet"}<ChevronDown size={12} className="text-dim" />
              </button>
              <button type="button" aria-pressed={mine.strict === true} title="A request runs on the model its rule names or fails: a backend's own fallback to another model is switched off for these callers."
                      className={cx("h-8 rounded-lg border px-3 text-[12px] transition-colors", mine.strict === true ? "border-accent bg-accent/15" : "border-line hover:bg-muted")}
                      onClick={() => change((d) => { const { strict: _, ...r } = obj(obj(d.routers)[router]); return put(d, "routers", router, mine.strict === true ? r : { ...r, strict: true }); })}>
                never fall back
              </button>
              <button type="button" aria-label={`delete router ${router}`} title="delete this router: its callers go by the default one again" className="grid h-8 w-8 place-items-center rounded-lg border border-line text-dim hover:bg-muted hover:text-bad" onClick={() => removeRouter(router)}><Trash2 size={13} /></button>
            </>
          );
        })()}
        <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 text-[13px] hover:bg-muted"
                onClick={(e) => choose(e, ruleChoices(), (v) => startRule(v.slice(5)))}>
          <Plus size={13} />rule
        </button>
        <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 text-[13px] hover:bg-muted"
                title="something a rule's line sets off beside sending the request on"
                onClick={(e) => choose(e, ACTIONS.map((k) => ({ label: k.label, value: k.key, hint: k.hint })), (k) => setAdding(`actions:${k}`))}>
          <Zap size={13} />action
        </button>
        {arranged(draft) && <Button onClick={() => change(tidied)}>tidy up</Button>}
        <button type="button" aria-label="find a node" title="find a rule, an action, a name or a model on the map ( / )" className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-[12px] text-dim hover:bg-muted hover:text-fg"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openSearch(r.left, r.bottom + 4); }}>
          <Search size={13} />find<kbd className="rounded border border-line px-1 text-[10px]">/</kbd>
        </button>
        <button type="button" aria-label="what the map shows" title="what the map shows" className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-panel text-dim hover:bg-muted hover:text-fg"
                onClick={(e) => choose(e, legend(), () => {})}>
          <CircleHelp size={14} />
        </button>
        <VersionsButton />
        {router === null && <span className="ml-2 truncate text-[11px] text-dim max-2xl:hidden">A draft: nothing changes until you publish. Right-click for more.</span>}
        <div className="ml-auto flex items-center gap-2">
          {isDirty && <span className="flex items-center gap-1.5 text-[12px] text-accent"><span className="size-1.5 rounded-full bg-accent" />draft · {changes} {changes === 1 ? "change" : "changes"}</span>}
          <Button disabled={past.length === 0} onClick={undo}><Undo2 size={13} />undo</Button>
          {future.length > 0 && <Button onClick={redo}><Redo2 size={13} />redo</Button>}
          <Button disabled={!isDirty} onClick={revert}><RotateCcw size={13} />discard draft</Button>
          <Button tone="primary" disabled={!isDirty} onClick={() => void review()}><Save size={13} />review &amp; publish</Button>
        </div>
        {err && <div className="w-full text-[12px] text-bad">{err.message}</div>}
        {!err && issues.length > 0 && <div className="w-full text-[12px] text-warn">{issues[0]}{issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}</div>}
      </div>
      {adding === "flows" && (
        <NewDialog spec={{ noun: "routing rule", scope: "flow", keys: [] }} taken={Object.keys(obj(draft.flows))} onClose={() => setAdding(null)}
                   note="The name is only a label for the rule. It is drawn on the map: its pencil, or any of its lines, opens it to say which model names it handles and where each kind of request goes."
                   onCreate={(id) => {
                     // One line that always applies and goes nowhere yet. It is left on the map, picked out and in view,
                     // so where it landed is seen before anything opens over it.
                     change((d) => put(d, "flows", id, { inputs: [], steps: [{ to: "" }] }));
                     editSelect({ kind: "flow", id });
                     focusOn(`flow:${id}`);
                     setAdding(null);
                   }} />
      )}
      {adding?.startsWith("routers:") && (
        <NewDialog spec={{ noun: "router", scope: "flow", keys: [] }} taken={Object.keys(obj(draft.routers))} onClose={() => setAdding(null)}
                   note="A router is a rulebook of its own. Next, choose whose requests go by it; everyone else keeps the default router."
                   onCreate={(id) => { addRouter(id, adding === "routers:copy"); setAdding(null); }} />
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
  // A rule that takes a backend's own path may send to any model; a chat rule only to one that answers chat.
  const chat = !(out?.paths ?? false);
  // What cannot take a chat request is left out, unless it is searched for by name: then it is shown, and says why not.
  // Every model a backend serves or a route of its names, and every one the file describes.
  const models = [...new Set(Object.values(obj(draft.backends)).flatMap((b) => [...list(obj(b).serves), ...(Array.isArray(obj(b).routes) ? (obj(b).routes as unknown[]) : []).map((r) => text(obj(r).model)).filter(Boolean)]).concat(Object.keys(obj(draft.models))))].filter(hit)
    .filter((m) => !chat || q.trim() !== "" || known?.kind(m) !== "paths");
  const peers = Object.keys(obj(draft.peers)).filter(hit);
  // A flow that only says where one name runs is a line on the map, not a rule to hand work to.
  const flows = Object.entries(obj(draft.flows)).filter(([f, v]) => f !== self && hit(f) && !list(obj(v).inputs).includes("*")
    && directTo(f, { inputs: list(obj(v).inputs), steps: (Array.isArray(obj(v).steps) ? (obj(v).steps as unknown[]) : []).map(obj) }) === null).map(([f]) => f);
  // A rule one name enters can send it on as itself; with several names there is no single "itself" to offer.
  const entering = self ? list(obj(obj(draft.flows)[self]).inputs) : [];
  // With several names entering, "its own model" is whichever of them was asked for.
  const own = entering.length === 1 ? entering[0]! : entering.length > 1 ? "whichever was asked for" : null;
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
                   const first = models.find((m) => !chat || known?.kind(m) !== "paths");
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
          {own && hit("its own model") && <button className={row} onClick={() => send(entering.length === 1 ? { kind: "model", model: own } : { kind: "asked" })}><span className="size-2 rounded-full bg-info" />Its own model<span className="ml-auto text-[11px] text-dim">the default: {own}</span></button>}
          {models.length > 0 && <div className={head}>a model on this node</div>}
          {models.map((m) => {
            const shut = chat && known?.kind(m) === "paths";
            const on = text(obj(obj(draft.models)[m]).backend) || Object.entries(obj(draft.backends)).find(([, b]) => list(obj(b).serves).includes(m) || (Array.isArray(obj(b).routes) ? (obj(b).routes as unknown[]) : []).some((r) => text(obj(r).model) === m))?.[0];
            const hw = on ? list(obj(obj(draft.backends)[on]).resources) : [];
            return <button key={m} disabled={shut} title={shut ? `${m} is not a chat model, and this rule takes chat requests. To send it requests on its own path, open the rule and set "It takes" to that path.` : undefined} className={cx(row, mono, "disabled:opacity-40")} onClick={() => send({ kind: "model", model: m })}>{m}{shut ? <span className="ml-auto font-sans text-[10px] text-dim">not chat: set what the rule takes</span>
              : hw.length > 0 && <span className="ml-auto shrink-0 font-sans text-[10px] uppercase text-dim" title={`runs on ${hw.join(", ")}, behind the ${on} backend`}>{hw.join(" · ")}</span>}</button>;
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
/** The icons a choice can stand behind, by the name it asks for one with. */
const ICONS = { plus: Plus, rotate: RefreshCw, bin: Trash2, split: Split, users: Users };

export function Menu() {
  const m = useEdit((s) => s.choosing);
  const [q, setQ] = useState("");
  useEffect(() => setQ(""), [m]);
  if (!m) return null;
  const long = m.search === true || m.items.filter((i) => !i.head).length > 8;
  const fits = m.items.filter((i) => i.head || i.label.toLowerCase().includes(q.trim().toLowerCase()));
  // A heading with nothing left under it goes too.
  // A rule between groups stays while anything follows it.
  const shown = fits.filter((i, k) => !i.head || (fits[k + 1] !== undefined && (i.label === "" || !fits[k + 1]!.head)));
  // A name typed that is not one of the choices can be made, where the list says how.
  const typed = q.trim();
  const make = m.create && typed !== "" && !m.items.some((i) => !i.head && (i.value ?? i.label) === typed) ? m.create : null;
  return (
    <div className="fixed inset-0 z-50" onClick={closeMenu} onKeyDown={(e) => { if (e.key === "Escape") closeMenu(); }}>
      <div role="menu" className="absolute min-w-44 max-w-sm rounded-xl border border-line bg-panel p-1.5 shadow-2xl" onClick={(e) => e.stopPropagation()}
           style={{ left: Math.min(m.x, innerWidth - 300), ...(m.y + 340 > innerHeight ? { bottom: innerHeight - m.y + 34 } : { top: m.y }) }}>
        {long && <input autoFocus aria-label="filter" placeholder={m.ask ?? (m.search ? "find a rule, an action, a name or a model…" : "filter…")} value={q} onChange={(e) => setQ(e.target.value)}
                        onKeyDown={(e) => {
                          const first = shown.find((i) => !i.head && !i.off && i.value?.charCodeAt(0) !== 0);
                          if (e.key !== "Enter") return;
                          // What was typed wins over a near match: a new name is what typing one is for.
                          if (make) { closeMenu(); make.make(typed); } else if (first) { closeMenu(); m.onPick(first.value ?? first.label); }
                        }} className="mb-1 h-8 w-full rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />}
        <div className="menu-list max-h-[min(26rem,70vh)] overflow-auto">
          {make && (
            <button role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-accent hover:bg-line/60" onClick={() => { closeMenu(); make.make(typed); }}>
              <Plus size={12} />{make.says} <span className={mono}>{typed}</span><span className="ml-auto text-[10px] text-dim">Enter</span>
            </button>
          )}
          {!make && shown.length === 0 && !m.ask && <div className="px-2 py-1.5 text-[12px] text-dim">nothing by that name</div>}
          {shown.map((i, k) => i.head ? (
            i.label === "" ? <div key={k} className="mx-1 my-1 border-t border-line" />
              : <div key={k} className="px-2 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-dim">{i.label}</div>
          ) : (
            i.still ? (
              <div key={k} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]">
                {i.swatch && <span className="size-2.5 shrink-0 rounded-full" style={{ background: i.swatch }} />}
                <span className="min-w-0 flex-1">
                  <span className="block">{i.label}</span>
                  {i.hint && <span className="block whitespace-normal text-[11px] text-dim">{i.hint}</span>}
                </span>
              </div>
            ) :
            <button key={k} role="menuitem" autoFocus={!long && k === m.items.findIndex((x) => !x.head)} disabled={i.off}
                    className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-line/60 focus:bg-line/60 focus:outline-none disabled:opacity-40", i.mono && mono, i.danger && "text-bad", i.on && "font-medium")}
                    onClick={() => { closeMenu(); m.onPick(i.value ?? i.label); }}>
              {i.icon && (() => { const Icon = ICONS[i.icon!]; return <Icon size={13} className={cx("shrink-0", i.danger ? "text-bad" : "text-dim")} />; })()}
              {/* What a choice is comes first and whole; what it means sits under it. */}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{i.label}</span>
                {i.hint && <span className="block whitespace-normal font-sans text-[11px] font-normal text-dim">{i.hint}</span>}
              </span>
              {i.aside && <span className="shrink-0 pl-3 font-sans text-[11px] font-normal text-dim">{i.aside}</span>}
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
      // A header a line tests can be tried with each value it names, or with any value where it names none.
      for (const k of ["header", "headerNot"]) for (const [h, vals] of Object.entries(obj(when[k]))) for (const val of list(vals).length ? list(vals) : ["1"]) if (h) out.set(`hdr:${h}=${val}`, `the request carries ${h}: ${val}`);
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
  const flowList = Object.values(obj(draft?.flows)).map(obj);
  // Each type, and each variant a line of its rule tests, is a name that can be tried.
  const typed = flowList.flatMap((f) => list(f.inputs).filter((n) => n !== "*").flatMap((n) => [n, ...[...new Set((Array.isArray(f.steps) ? (f.steps as unknown[]) : []).flatMap((s) => list(obj(obj(s).when).variant)))].map((v) => `${n}:${v}`)]));
  const names = [...new Set([...typed, ...pending, ...Object.values(obj(draft?.backends)).flatMap((b) => list(obj(b).serves))])];
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
function Lines({ name, flow, at }: { name: string; flow: Doc; /** The line it was opened for, brought into view. */ at: number | null }) {
  const refs = useContext(Refs);
  useEffect(() => { if (at !== null) document.getElementById(`rule-line-${at}`)?.scrollIntoView({ block: "center" }); }, []);
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
          <div key={i} id={`rule-line-${i}`} className={cx("rounded-lg border bg-bg/40 p-2.5", i === at ? "border-accent" : "border-line")}>
            <div className="flex items-start gap-2">
              <span className="pt-1 text-[12px] font-medium">{i === last ? "Otherwise" : i === 0 ? "If" : "Else if"}</span>
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
                <span className="truncate">{to.kind === "unset" ? "choose where" : to.kind === "asked" || (to.kind === "model" && list(flow.inputs).includes(to.model)) ? "its own model" : toText(to)}</span><ChevronDown size={12} className="shrink-0 text-dim" />
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
                  (v) => (v === "\u0000new" ? setTyping("") : add(v)), { says: "a new name:", make: add })}>
          <Plus size={12} />a type
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

/** What is open to edit, with room to work: a rule line by line in a dialog, or an action's settings beside the map as the Config page shows them. */
export function EditRail() {
  const { draft, sel, err, pending, opened } = useEdit();
  const data = useStore((s) => s.data);
  if (!draft || !sel || (sel.kind === "flow" && !opened)) return null;
  const section = SECTION[sel.kind];
  const entry = obj(draft[section])[sel.id];
  const self = data?.net.nodes.find((n) => n.self);
  const catalog = [...(data?.catalog ?? []), ...(self?.backends ?? []).flatMap((b) => [...(b.serves ?? []), ...(b.loaded ?? [])])];
  // An action taken away is taken off every line that ran it, so the file still loads.
  // Every path a backend declares: what a rule can take besides chat.
  const paths = [...new Set(Object.values(obj(draft.backends)).flatMap((b) => (Array.isArray(obj(b).routes) ? (obj(b).routes as unknown[]) : []).map((r) => text(obj(r).path)).filter(Boolean)))];
  // What runs this action, so taking it away is not a surprise.
  const users = sel.kind === "action" ? linesRunning(draft, sel.id) : [];
  // The names a rule can be given: the draft's own types and the ones still waiting for a line, then every model.
  // A type the draft has renamed or removed is still in what the running node lists, and is left out.
  const mine = new Set(Object.values(obj(draft.flows)).flatMap((f) => list(obj(f).inputs)));
  const gone = new Set(Object.values(data?.flows ?? {}).flatMap((f) => f.inputs).filter((n) => !mine.has(n)));
  const offered = [...new Set([...pending, ...mine, ...refsOf(draft, catalog).models])].filter((n) => n !== "*" && !gone.has(n));
  const name = (
        <div className="min-w-0 font-normal">
          <div className="text-[11px] uppercase tracking-wide text-dim">{sel.kind === "flow" ? "routing rule" : "action"}</div>
          {isObj(entry)
            ? <input key={sel.id} aria-label="name" title="click to rename" defaultValue={sel.id} className={cx("w-full truncate rounded border border-transparent bg-transparent text-base font-semibold hover:border-line focus:border-accent focus:outline-none", mono)}
                     onBlur={(e) => { rename(sel, e.target.value); e.target.value = sel.id; }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.stopPropagation(); e.currentTarget.value = sel.id; e.currentTarget.blur(); } }} />
            : <div className={cx("truncate text-base font-semibold", mono)}>{sel.id}</div>}
        </div>
  );
  const bin = isObj(entry) && <button className="text-dim hover:text-bad" aria-label={`delete ${sel.id}`} onClick={() => remove(sel)}><Trash2 size={15} /></button>;
  const body = (
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
              <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="text-dim">It takes</span>
                <button type="button" className={PICK} title="what kind of request this rule answers"
                        onClick={(e) => choose(e, [
                          { label: "chat requests", value: "", on: list(entry.takes).length === 0 },
                          { label: "requests on a backend's own path", head: true },
                          ...paths.map((p) => ({ label: p, value: p, mono: true, on: list(entry.takes).includes(p) })),
                          ...(paths.length ? [] : [{ label: "no backend declares a path under routes:", off: true }]),
                        ], (p) => change((d) => {
                          const { takes: _, ...rest } = obj(obj(d.flows)[sel.id]);
                          const had = list(obj(obj(d.flows)[sel.id]).takes);
                          const next = p === "" ? [] : had.includes(p) ? had.filter((x) => x !== p) : [...had, p];
                          return put(d, "flows", sel.id, next.length ? { ...rest, takes: next } : rest);
                        }))}>
                  {list(entry.takes).length ? list(entry.takes).join(", ") : "chat requests"}<ChevronDown size={12} className="shrink-0 text-dim" />
                </button>
              </div>
              <div className="mb-1 text-[12px] font-medium">When a request asks for</div>
              <Names flow={sel.id} names={list(entry.inputs)} options={offered} />
              {list(entry.inputs).length === 0 && <div className="mt-1 text-[11px] text-warn">Nothing reaches this rule yet. Add a type here, or drag a type's blue dot from the Router onto the rule.</div>}
              <div className="mb-1 mt-4 text-[12px] font-medium">decide where it goes</div>
              <Lines name={sel.id} flow={entry} at={opened?.line ?? null} />
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
  );
  if (sel.kind === "flow") return (
    <Dialog title={name} label={`routing rule ${sel.id}`} head={bin} size="full" onClose={closeRule}>
      <div className="min-h-0 flex-1 overflow-auto p-4"><div className="mx-auto max-w-4xl">{body}</div></div>
    </Dialog>
  );
  return (
    <aside className="w-[480px] shrink-0 overflow-auto border-l border-line bg-panel p-4 max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-10 max-lg:max-w-full">
      <div className="mb-3 flex items-center gap-2">
        {name}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {bin}
          <button className="text-dim hover:text-fg" aria-label="close" onClick={() => editSelect(null)}><X size={16} /></button>
        </span>
      </div>
      {body}
    </aside>
  );
}
