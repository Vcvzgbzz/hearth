/**
 * What the routing map draws: this node and the names it answers to, a rule whose lines read as
 * sentences and are edited where they stand, the places a line can end (a model, a peer, the
 * fastest of several, a refusal) and the actions a line can set off. VIEWS at the foot lists
 * them by node type; how each behaves when a line is drawn is NODES in draft.ts.
 */
import { Handle, Position, useConnection, type Node, type NodeProps } from "@xyflow/react";
import { ArrowUp, ChevronDown, CircuitBoard, Cloud, Cpu, MoreHorizontal, Pencil, Plus, Split, Trash2, X, Zap } from "lucide-react";
import { Fragment, memo, useEffect, useRef, useState } from "react";

import { ACTIONS, ANY, dropPlace, editStep, GROUP, groupsOf, list, movedName, moveStep, NODES, obj, put, raisePlace, rawTo, text, toOf, toText, withDo, withRest, type Doc, type End } from "./draft.js";
import { addName, change, choose, dropName, hover, openRule, pick, remove, rename, retype, type Choice } from "./editStore.js";
import { cx } from "./ui.js";

type About = "the request" | "where it would go" | "this node";
type Cond =
  | { key: string; kind: "bool"; yes: string; no: string; about: About; /** What it means, where the words alone do not say. */ hint?: string }
  | { key: string; kind: "num"; before: string; after: string; seed: number; about: About }
  | { key: string; kind: "list"; before: string; hint: string; about: About }
  | { key: "idle"; kind: "idle"; about: About }
  | { key: "time"; kind: "time"; about: About }
  | { key: "header" | "headerNot"; kind: "header"; about: About };

/** Every condition a line can test, in the words the canvas uses for it. "The target" is where the line sends work. */
export const CONDS: Cond[] = [
  { key: "images", kind: "bool", yes: "the request has images", no: "the request has no images", about: "the request" },
  { key: "tools", kind: "bool", yes: "the request uses tools", no: "the request uses no tools", about: "the request" },
  { key: "tokensOver", kind: "num", before: "the prompt is over", after: "tokens", seed: 8000, about: "the request" },
  { key: "tokensUnder", kind: "num", before: "the prompt is under", after: "tokens", seed: 8000, about: "the request" },
  { key: "variant", kind: "list", before: "the variant is", hint: "e.g. realism, for Name:realism", about: "the request" },
  { key: "path", kind: "list", before: "the path is", hint: "e.g. /v1/embeddings", about: "the request" },
  { key: "header", kind: "header", about: "the request" },
  { key: "headerNot", kind: "header", about: "the request" },
  { key: "asked", kind: "list", before: "they asked for", hint: "model names", about: "the request" },
  { key: "askedNot", kind: "list", before: "they did not ask for", hint: "model names", about: "the request" },
  { key: "caller", kind: "list", before: "the caller is", hint: "key label, or local", about: "the request" },
  { key: "callerNot", kind: "list", before: "the caller is not", hint: "key label, or local", about: "the request" },
  { key: "lane", kind: "list", before: "the lane is", hint: "lane names", about: "the request" },
  { key: "laneNot", kind: "list", before: "the lane is not", hint: "lane names", about: "the request" },
  { key: "ready", kind: "bool", yes: "the target needs no swap", no: "the target would need a swap", about: "where it would go", hint: "it is loaded, or nothing else is on its hardware: nothing gets pushed out" },
  { key: "idle", kind: "idle", about: "where it would go" },
  { key: "warm", kind: "bool", yes: "the target is already loaded", no: "the target is not loaded", about: "where it would go" },
  { key: "free", kind: "bool", yes: "the target has a free slot", no: "the target is full", about: "where it would go" },
  { key: "queuedUnder", kind: "num", before: "the target has fewer than", after: "waiting", seed: 3, about: "where it would go" },
  { key: "held", kind: "list", before: "an app is using the hardware of", hint: "model names", about: "this node" },
  { key: "down", kind: "list", before: "these peers cannot take it:", hint: "peer names", about: "this node" },
  { key: "time", kind: "time", about: "this node" },
];
/** A condition as it appears in the list of ones to add. */
const nameOf = (c: Cond) => (c.kind === "bool" ? c.yes : c.kind === "idle" ? "a model has been idle for a while" : c.kind === "time" ? "it is between two times of day"
  : c.kind === "header" ? (c.key === "header" ? "a header it carries is …" : "a header it carries is not …") : `${c.before} …`);
const seedOf = (c: Cond): unknown => (c.kind === "bool" ? true : c.kind === "num" ? c.seed : c.kind === "idle" ? { ms: 600_000 } : c.kind === "time" ? { from: "22:00", to: "06:00" } : c.kind === "header" ? { "": [] } : []);
/** A condition and its value as one phrase, for a line that is read and not edited. */
const phrase = (c: Cond, v: unknown): string =>
  c.kind === "bool" ? (v === false ? c.no : c.yes)
  : c.kind === "num" ? `${c.before} ${String(v)} ${c.after}`
  : c.kind === "list" ? `${c.before} ${list(v).join(" or ")}`
  : c.kind === "time" ? `it is between ${text(obj(v).from)} and ${text(obj(v).to)}`
  // No values is the header being there at all, or for the opposite, not there.
  : c.kind === "header" ? Object.entries(obj(v)).map(([n, vals]) => `the header ${n} ${c.key === "header" ? (list(vals).length ? `is ${list(vals).join(" or ")}` : "is sent") : (list(vals).length ? `is not ${list(vals).join(" or ")}` : "is not sent")}`).join(" and ")
  : `${text(obj(v).model) || "the target"} has been idle ${Number(obj(v).ms ?? 0) / 60_000} min`;
/** A line's conditions as a sentence. */
export const sentence = (when: Doc): string => CONDS.filter((c) => c.key in when).map((c) => phrase(c, when[c.key])).join(" and ");

// `nodrag nopan`: a control inside a node takes the pointer itself, so using it never moves the node or the canvas.
const CHIP = "nodrag nopan inline-flex h-6 max-w-full items-center gap-1 rounded-md border-b border-dim/60 bg-muted px-1.5 text-[11px] text-fg hover:border-accent focus:border-accent focus:outline-none";
const FIELD = "nodrag nopan h-6 rounded-md border-0 border-b border-dim/60 bg-muted px-1.5 text-[11px] text-fg focus:border-accent focus:outline-none";

/**
 * A line's conditions as editable parts of a sentence. `models` are the ids `idle` may name;
 * `optional` is a line that may stand with none, because where it goes can be unavailable.
 */
/**
 * What ties conditions that all have to hold: a dot beside each, and a line from the first dot to the last.
 * `before` is the line through this condition's row, `after` its dot.
 */
const RAIL = "relative pl-3.5 before:absolute before:left-[3px] before:w-px before:bg-dim/45 before:content-[''] after:absolute after:left-px after:top-1/2 after:h-[5px] after:w-[5px] after:-translate-y-1/2 after:rounded-full after:bg-dim after:content-['']";
const railOf = (n: number, of: number): string => (of < 2 ? "" : cx(RAIL, n === 0 ? "before:top-1/2" : "before:top-0", n === of - 1 ? "before:bottom-1/2" : "before:bottom-0"));

export function Conds({ when, models, optional, onChange }: { when: Doc; models: string[]; optional?: boolean; onChange: (w: Doc) => void }) {
  const without = (k: string) => { const { [k]: _, ...rest } = when; return rest; };
  const have = CONDS.filter((c) => c.key in when);
  const rest = CONDS.filter((c) => !(c.key in when));
  const adding: Choice[] = (["the request", "where it would go", "this node"] as About[]).flatMap((about) => {
    const these = rest.filter((c) => c.about === about);
    return these.length ? [{ label: `about ${about}`, head: true }, ...these.map((c) => ({ label: nameOf(c), value: c.key, ...(c.kind === "bool" && c.hint ? { hint: c.hint } : {}) }))] : [];
  });
  // The condition just added takes the keys, so its value can be typed at once.
  const [fresh, setFresh] = useState<string | null>(null);
  const add = (key: string) => { const c = CONDS.find((x) => x.key === key); if (c) { setFresh(c.key); onChange({ ...when, [c.key]: seedOf(c) }); } };
  // Each condition has a row of its own; a field gives way before a row breaks.
  return (
    <span className="flex min-w-0 flex-1 flex-col items-stretch">
      {have.map((c, n) => {
        const v = when[c.key];
        // Every word and every value stands on its own, so a line breaks between them
        // and never splits a phrase or hides a value under another piece of the line.
        const lead = n > 0 ? <span className="shrink-0 text-dim">and</span> : null;
        const drop = <button type="button" aria-label="remove this condition" title="remove this condition" className="nodrag nopan shrink-0 text-dim hover:text-bad" onClick={() => onChange(without(c.key))}><X size={11} /></button>;
        return (
          <span key={c.key} className={cx("flex min-w-0 items-center gap-1 py-0.5", railOf(n, have.length))}>
            {lead}
            {c.kind === "bool" ? (
              <button type="button" className={cx(CHIP, "min-w-0")}
                      onClick={(e) => choose(e, [{ label: c.yes, value: "yes", on: v !== false }, { label: c.no, value: "no", on: v === false }, { label: "Remove this condition", value: "drop", danger: true }],
                        (x) => onChange(x === "drop" ? without(c.key) : { ...when, [c.key]: x === "yes" }))}>
                <span className="truncate">{v === false ? c.no : c.yes}</span><ChevronDown size={10} className="shrink-0 text-dim" />
              </button>
            ) : c.kind === "num" ? (
              <>
                <span className="shrink-0 whitespace-nowrap">{c.before}</span>
                <input aria-label={c.before} type="number" min={0} autoFocus={fresh === c.key} className={cx(FIELD, "w-16 shrink-0 tabular")} value={typeof v === "number" ? v : ""} onChange={(e) => onChange({ ...when, [c.key]: Number(e.target.value) })} />
                <span className="shrink-0 whitespace-nowrap">{c.after}</span>
                {drop}
              </>
            ) : c.kind === "list" ? (
              <>
                <span className="shrink-0 whitespace-nowrap">{c.before}</span>
                <input aria-label={c.before} autoFocus={fresh === c.key} className={cx(FIELD, "w-0 min-w-10 max-w-40 flex-1 font-mono")} placeholder={c.hint} value={list(v).join(", ")}
                       onChange={(e) => onChange({ ...when, [c.key]: e.target.value.split(",").map((x) => x.trim()).filter((x, k, all) => x !== "" || k === all.length - 1) })} />
                {drop}
              </>
            ) : c.kind === "header" ? (() => {
              // One header is edited here; any others the file names under the same condition are kept as they are.
              const all = Object.entries(obj(v));
              const [name, vals] = all[0] ?? ["", []];
              const write = (n: string, values: string[]) => onChange({ ...when, [c.key]: Object.fromEntries([[n, values], ...all.slice(1)]) });
              return (
                <>
                  <span className="shrink-0 whitespace-nowrap">the header</span>
                  <input aria-label="header name" autoFocus={fresh === c.key} spellCheck={false} className={cx(FIELD, "w-0 min-w-10 max-w-32 flex-1 font-mono", name === "" && "border-warn")} placeholder="x-name" value={name}
                         onChange={(e) => write(e.target.value.trim().toLowerCase(), list(vals))} />
                  <span className="shrink-0 whitespace-nowrap">{c.key === "header" ? "is" : "is not"}</span>
                  <input aria-label={c.key === "header" ? "the values it may have" : "the values it may not have"} spellCheck={false} className={cx(FIELD, "w-0 min-w-10 max-w-32 flex-1 font-mono")} placeholder={c.key === "header" ? "any value" : "sent at all"} value={list(vals).join(", ")}
                         onChange={(e) => write(name, e.target.value.split(",").map((x) => x.trim()).filter((x, k, parts) => x !== "" || k === parts.length - 1))} />
                  {drop}
                </>
              );
            })() : c.kind === "time" ? (
              <>
                <span className="shrink-0 whitespace-nowrap">between</span>
                {(["from", "to"] as const).map((k) => (
                  <span key={k} className="flex items-center gap-1">
                    {k === "to" && <span className="shrink-0 text-dim">and</span>}
                    <input aria-label={k === "from" ? "from this time of day" : "until this time of day"} type="time" className={cx(FIELD, "shrink-0 !px-1 tabular")} value={text(obj(v)[k])}
                           onChange={(e) => onChange({ ...when, time: { ...obj(v), [k]: e.target.value } })} />
                  </span>
                ))}
                {drop}
              </>
            ) : (
              <>
                <button type="button" className={cx(CHIP, "min-w-0 font-mono")}
                        onClick={(e) => choose(e, [{ label: "the target", value: "", hint: "where this line sends work", on: !text(obj(v).model) }, { label: "a model", head: true }, ...models.map((m) => ({ label: m, mono: true, on: text(obj(v).model) === m }))],
                          (m) => { const { model: _, ...keep } = obj(v); onChange({ ...when, idle: m ? { ...keep, model: m } : keep }); })}>
                  <span className="truncate">{text(obj(v).model) || "the target"}</span><ChevronDown size={10} className="shrink-0 text-dim" />
                </button>
                <span className="shrink-0 whitespace-nowrap">has been idle</span>
                {/* The file keeps milliseconds; a person thinks in minutes. */}
                <input aria-label="minutes idle" type="number" min={0} step="any" className={cx(FIELD, "w-12 shrink-0 tabular")} value={typeof obj(v).ms === "number" ? (obj(v).ms as number) / 60_000 : ""}
                       onChange={(e) => onChange({ ...when, idle: { ...obj(v), ms: Math.round(Number(e.target.value) * 60_000) } })} />
                <span className="shrink-0 whitespace-nowrap">min</span>
                {drop}
              </>
            )}
          </span>
        );
      })}
      {have.length === 0 && optional && <span className="text-dim">it can take it</span>}
      {adding.length > 0 && (
        <button type="button" className={cx(CHIP, "my-0.5 self-start border-dashed text-dim", have.length > 1 && "ml-3.5", have.length === 0 && !optional && "border-warn text-warn")} onClick={(e) => choose(e, adding, add)}>
          {have.length || optional ? <><Plus size={10} />and</> : "choose a condition"}
        </button>
      )}
    </span>
  );
}

/** While a wire is being dragged: the node it left, or null. Nodes that could take it show that they can. */
const useWireFrom = () => useConnection((c) => (c.inProgress ? c.fromNode.id : null));
/** Is a line being drawn from a node that has outlets? Then what can end one shows that it can. */
export const takesWork = (from: string | null) => from !== null && NODES[from.split(":")[0]!]?.outlet !== undefined;
const RING = "ring-2 ring-ok/70";

/**
 * One colour per kind of thing a line can end at, worn by that thing's own dot, by the dot of any
 * line that goes there, and by the line between them: a dot's colour says what it is plugged into.
 */
export const HUE: Record<string, { dot: string; stroke: string; says: string }> = {
  model: { dot: "!bg-ok", stroke: "var(--ok)", says: "a model here" },
  peer: { dot: "!bg-peer", stroke: "var(--peer)", says: "a peer" },
  cloud: { dot: "!bg-cloud", stroke: "var(--cloud)", says: "a provider's model: the request leaves this network" },
  flow: { dot: "!bg-info", stroke: "var(--info)", says: "a routing rule" },
  fastest: { dot: "!bg-pick", stroke: "var(--pick)", says: "the fastest of several, or several in order" },
  refuse: { dot: "!bg-bad", stroke: "var(--bad)", says: "a refusal" },
  action: { dot: "!bg-warn", stroke: "var(--warn)", says: "an action" },
  unset: { dot: "!bg-dim", stroke: "var(--dim)", says: "nowhere yet" },
};
const hue = (kind: string) => HUE[kind] ?? HUE.unset!;
// Big enough to see and to grab at the size the whole picture is drawn.
const PORT = "!h-3.5 !w-3.5 !border-2 !border-panel";

/**
 * A name that is renamed where it stands: a click starts typing, Enter or a press anywhere else keeps
 * it, Escape does not. `start` begins typing as soon as it is drawn.
 */
function Renamed({ name, label, onRename, className, start, wide, onEnd }: { name: string; label: string; onRename: (to: string) => void; className?: string; start?: boolean; /** Fill the row it is in. */ wide?: boolean; onEnd?: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState<string | null>(start ? name : null);
  const fresh = useRef(false);
  const end = (keep: boolean) => {
    const to = typed;
    setTyped(null);
    ref.current?.blur();
    if (keep && to !== null && to.trim() !== name) onRename(to);
    onEnd?.();
  };
  // While a name is being typed the keys stay with it, whatever the map redraws underneath.
  useEffect(() => { if (typed !== null && document.activeElement !== ref.current) ref.current?.focus(); });
  const typing = typed !== null;
  useEffect(() => { if (typing) ref.current?.select(); }, [typing]);
  useEffect(() => {
    if (!typing) return;
    const away = (e: PointerEvent) => { if (e.target !== ref.current) end(true); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  });
  return (
    <input ref={ref} aria-label={label} title="click to rename" value={typed ?? name} readOnly={!typing} spellCheck={false} style={wide ? undefined : { width: `${(typed ?? name).length + 2}ch` }}
           className={cx("nodrag nopan min-w-0 rounded border bg-transparent px-0.5 font-mono focus:outline-none", wide ? "flex-1" : "shrink font-medium", typing ? "border-accent" : "border-transparent hover:border-line", className)}
           // The press starts it, not the click that follows: the map swallows a click that comes straight after a drag.
           onPointerDown={(e) => { e.stopPropagation(); if (!typing) { fresh.current = true; setTyped(name); } }}
           // The click that completes that press would put the caret where it landed: the whole name stays selected instead.
           onClick={(e) => { e.stopPropagation(); if (fresh.current) { fresh.current = false; const el = e.currentTarget; setTimeout(() => el.select(), 0); } }} onChange={(e) => setTyped(e.target.value)}
           onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") end(true); if (e.key === "Escape") end(false); }} />
  );
}
const BIN = "nodrag nopan grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim hover:bg-muted hover:text-bad";

/** What is known about a line: `bad` is why it cannot work, `unsure` that its target has not said whether it can take what the line tests. */
export type Mark = { bad: string } | { unsure: true } | null;

export type SwitchBox = { /** The orders its lines hand to, by flow name, each as the places in it. */ orders?: Record<string, End[]>; marks?: Mark[]; /** The names that enter it: a line that sends one of them to itself is "its own model". */ inputs?: string[]; name: string; steps: Doc[]; selected?: boolean; editable?: boolean; lit?: number; models: string[]; lanes: string[]; /** Every action a line could run. */ actions: string[]; /** The models that run on a provider's server. */ cloud?: string[]; /** Switched off: drawn, but it takes nothing. */ off?: boolean; note?: string; /** It keeps a conversation where it started. */ sticky?: boolean; /** Request paths it takes besides chat. */ takes?: string[]; /** How many times each line has decided since the rules last changed. */ hits?: number[]; /** No name enters it and no rule hands work to it. */ orphan?: boolean };

export const SwitchNode = memo(function SwitchNode({ id, data }: NodeProps<Node<SwitchBox>>) {
  const from = useWireFrom();
  const last = data.steps.length - 1;
  const canTake = from !== id && takesWork(from);
  const edit = (i: number, fn: (s: Doc) => Doc | null) => change((d) => editStep(d, data.name, i, fn));
  // Sending a name to the model of the same name is leaving it alone: the default, said as such.
  const own = (to: ReturnType<typeof toOf>) => to.kind === "asked" || (to.kind === "model" && (data.inputs ?? []).includes(to.model));
  const groups = groupsOf(data.steps);
  // One line's conditions are open to change where they stand at a time; the rest read as a sentence, so a long rule stays short.
  const [open, setOpen] = useState<number | null>(null);
  /** The colour a line wears: what it is plugged into, and for a model, whether that is a provider's. */
  const worn = (to: ReturnType<typeof toOf>) => hue(to.kind === "asked" ? "model" : to.kind === "model" && (data.cloud ?? []).includes(to.model) ? "cloud" : to.kind);
  return (
    <div className={cx(
      "w-[640px] rounded-xl border bg-panel shadow-sm transition-colors",
      data.selected ? "border-accent ring-2 ring-accent/25" : "border-info/60",
      canTake && RING, data.off && "opacity-60",
    )} title={data.note}>
      <div className="relative flex h-9 items-center gap-2 border-b border-line px-3">
        <Handle type="target" position={Position.Left} className={cx(PORT, HUE.flow!.dot)} style={{ left: -6 }} />
        <Split size={13} className="text-info" />
        <span className="text-[10px] uppercase tracking-wide text-info">routing rule</span>
        {data.editable ? <Renamed name={data.name} label={`name of rule ${data.name}`} onRename={(to) => rename({ kind: "flow", id: data.name }, to)} /> : <span className="truncate font-mono font-medium">{data.name}</span>}
        {(data.takes ?? []).length > 0 && <span className="shrink-0 rounded border border-line px-1 text-[9px] uppercase text-dim" title={`not chat: it takes requests on ${data.takes!.join(", ")}`}>not chat</span>}
        <span className={cx("ml-auto shrink-0 text-[10px]", data.orphan ? "text-warn" : "text-dim")}>{data.off ? "switched off" : data.orphan ? "nothing reaches this yet" : data.sticky ? "a conversation stays where it starts" : "top to bottom, first match wins"}</span>
        {data.editable && <button type="button" aria-label={`edit rule ${data.name}`} title="edit this rule" className={cx(BIN, "hover:!text-fg")} onClick={() => openRule(data.name)}><Pencil size={13} /></button>}
        {data.editable && <button type="button" aria-label={`delete rule ${data.name}`} title="delete this rule" className={BIN} onClick={(e) => { e.stopPropagation(); remove({ kind: "flow", id: data.name }); }}><Trash2 size={13} /></button>}
      </div>
      {data.steps.map((s, i) => {
        const to = toOf(s.to);
        const when = obj(s.when);
        const group = groups.find((g) => g.from <= i && i <= g.to);
        // Under a heading a line says only what is its own; its dialog shows all it tests.
        const { [group?.key ?? ""]: _shared, ...mine } = when;
        const word = i === last ? "Otherwise" : group ? (Object.keys(mine).length === 0 && i === group.to ? "Else" : i === group.from ? "If" : "Else if") : i === 0 ? "If" : "Else if";
        // A line that hands to an order reads as the places in it, not as the rule that holds them.
        const order = to.kind === "flow" ? data.orders?.[to.flow] : undefined;
        const goes = order ? order.map(toText).join(", then ") : own(to) ? "its own model" : toText(to);
        return (
          <Fragment key={i}>
          {group?.from === i && (
            <div className={cx("flex items-center gap-1.5 px-3 text-[11px]", i > 0 && "border-t border-line/50")} style={{ height: GROUP.head }} title="the lines under this all test it; the file keeps it on each of them">
              <span className="w-4 shrink-0" />
              <span className="w-14 shrink-0 font-medium">{i === 0 ? "If" : "Else if"}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{sentence({ [group.key]: when[group.key] })}</span>
            </div>
          )}
          <div className={cx("relative flex min-h-[32px] items-center gap-1.5 px-3 py-1 text-[11px]", i > 0 && group?.from !== i && "border-t border-line/50", data.lit === i && "bg-accent/15")}
               onMouseEnter={() => hover(`e:${id}:${i}`)} onMouseLeave={() => hover(null)}>
            {group && <span className="absolute inset-y-0 left-[42px] w-px bg-dim/45" />}
            {/* Work sent to a peer leaves on the peers' side. */}
            <Handle type="source" id={`step-${i}-back`} position={Position.Left} className="!opacity-0" style={{ left: -6 }} />
            {/* Every line is the same three columns, so the where-it-goes and the counts read in line:
                the word, the conditions, and the fixed-width place the line ends at. */}
            <span className="w-4 shrink-0 text-right text-[10px] tabular text-dim/70" title={`line ${i + 1}`}>{i + 1}</span>
            {/* The word closes a line that is open. */}
            <span className={cx("w-14 shrink-0 font-medium", i === last && "truncate", group && "ml-4", open === i && "cursor-pointer")} title={open === i ? "done with this line's conditions" : undefined} onClick={() => { if (open === i) setOpen(null); }}>{word}</span>
            {i === last ? (
              <span className="min-w-0 flex-1" />
            ) : data.editable && (open === i || (Object.keys(when).length === 0 && to.kind !== "peer")) ? (
              // Its conditions are changed where they stand: the dialog, from the pencil or the line's menu, is for the rest of the line.
              // A peer can be down, so only a line that sends to one may stand with no condition of its own.
              // Under a heading the line's own conditions are what is changed here; the one it shares stays with the heading.
              <Conds when={group ? mine : when} models={data.models} optional={to.kind === "peer" || group !== undefined}
                     onChange={(w) => edit(i, (r) => ({ ...r, when: group ? { [group.key]: when[group.key], ...w } : w }))} />
            ) : data.editable ? (
              <button type="button" className="nodrag nopan min-h-6 min-w-0 flex-1 rounded-md px-1 py-1 text-left leading-snug hover:bg-muted" title="click to change this line's conditions" onClick={() => setOpen(i)}>{sentence(group ? mine : when) || (group?.to === i ? "" : "it can take it")}</button>
            ) : (
              <span className="min-w-0 flex-1 truncate">{sentence(group ? mine : when) || (group?.to === i ? "" : "it can take it")}</span>
            )}
            <span className="flex w-[200px] min-w-0 shrink-0 items-center gap-1.5">
              <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", (order ? hue("fastest") : worn(to)).dot)} title={(order ? hue("fastest") : worn(to)).says} />
              {to.kind !== "refuse" && <span className="shrink-0 text-dim">send to</span>}
              {data.editable ? (
                <button type="button" className={cx(CHIP, "min-w-0 flex-1 font-mono", to.kind === "unset" && "border-warn text-warn")} title={to.kind === "unset" ? "choose where this line sends requests" : `${goes} — click to choose where this line sends requests`}
                        onClick={(e) => pick({ x: e.clientX, y: e.clientY, from: { node: id, handle: `step-${i}` } })}>
                  <span className="truncate">{to.kind === "unset" ? "choose where" : goes}</span><ChevronDown size={10} className="shrink-0 text-dim" />
                </button>
              ) : <span className="min-w-0 flex-1 truncate font-mono" title={goes}>{goes}</span>}
            </span>
            {typeof s.max === "number" && <span className="shrink-0 rounded border border-line px-1 text-[10px] text-dim" title={`takes at most ${s.max} at once; the rest go on down the list`}>≤{s.max}</span>}
            {data.hits && <span className="w-7 shrink-0 text-right text-[10px] tabular text-dim" title={`decided ${data.hits[i] ?? 0} ${(data.hits[i] ?? 0) === 1 ? "request" : "requests"} since the rules last changed or the node started`}>{data.hits[i] ?? 0}×</span>}
            {data.marks && !data.marks[i] && <span className="w-4 shrink-0" />}
            {data.marks?.[i] && ("bad" in data.marks[i]!
              ? <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-bad text-[10px] font-bold text-panel" title={(data.marks[i] as { bad: string }).bad}>!</span>
              : <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-dim/60 text-[10px] text-dim" title="Not checked: this model has not said whether it takes what this line is for. It is checked once the model has loaded, or when you describe it under Models.">?</span>)}
            {data.editable && (
              <button type="button" aria-label={`line ${i + 1} options`} title="more for this line" className="nodrag nopan grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim hover:bg-muted hover:text-fg"
                      onClick={(e) => { const at = { x: e.clientX, y: e.clientY }; choose(e, [
                        ...(i < last ? [{ label: "Move up", value: "up", off: i === 0 }, { label: "Move down", value: "down", off: i >= last - 1 }] : []),
                        ...(to.kind === "model" || to.kind === "peer" ? [{ label: "if that fails", head: true }, { label: "Then try…", value: "then", hint: "another place to run it when this one fails" }] : []),
                        { label: "queue it in", head: true },
                        { label: "the model's own lane", value: "lane:", on: text(s.lane) === "" },
                        ...data.lanes.map((l) => ({ label: `the ${l} lane`, value: `lane:${l}`, on: text(s.lane) === l })),
                        { label: "also run", head: true },
                        ...(data.actions.length ? data.actions.map((a) => ({ label: a, value: `do:${a}`, mono: true, on: list(s.do).includes(a) })) : [{ label: "no actions yet: + action makes one", off: true }]),
                        { label: "more", head: true },
                        { label: "Edit this line…", value: "more" },
                        ...(i < last ? [{ label: "Delete this line", value: "delete", danger: true }] : []),
                      ], (v) => {
                        if (v === "then") pick({ x: at.x, y: at.y, from: { node: id, handle: `step-${i}-then` } });
                        else if (v === "up") change((d) => moveStep(d, data.name, i, -1));
                        else if (v === "down") change((d) => moveStep(d, data.name, i, 1));
                        else if (v === "delete") edit(i, () => null);
                        else if (v === "more") openRule(data.name, i);
                        else if (v.startsWith("do:")) change((d) => withDo(d, data.name, i, v.slice(3), !list(s.do).includes(v.slice(3))) ?? d);
                        else if (v.startsWith("lane:")) edit(i, ({ lane: _, ...r }) => (v === "lane:" ? r : { ...r, lane: v.slice(5) }));
                      }); }}>
                <MoreHorizontal size={13} />
              </button>
            )}
            <Handle type="source" id={`step-${i}`} position={Position.Right} className={cx(PORT, data.lit === i ? "!bg-accent" : order ? hue("fastest").dot : to.kind === "asked" ? hue(to.kind).dot : worn(to).dot, !data.editable && "!pointer-events-none")} style={{ right: -6 }} />
          </div>
          {group?.to === i && group.foot && (
            <div className="relative flex items-center px-3 text-[10px] italic text-dim" style={{ height: GROUP.foot }}>
              <span className="absolute left-[42px] top-0 h-1/2 w-px bg-dim/45" />
              <span className="ml-[46px]">none of these: on to line {i + 2}</span>
            </div>
          )}
          </Fragment>
        );
      })}
      {data.editable && (
        <button type="button" className="nodrag nopan flex h-8 w-full items-center gap-1 rounded-b-xl border-t border-line px-3 text-[11px] text-dim hover:bg-muted hover:text-fg"
                onClick={() => change((d) => { const all = obj(obj(d.flows)[data.name]); const steps = (all.steps as Doc[] | undefined) ?? []; return put(d, "flows", data.name, { ...all, steps: [...steps.slice(0, -1), { when: {}, to: "" }, steps.at(-1)!] }); })}>
          <Plus size={12} />add an "if" line
        </button>
      )}
    </div>
  );
});

export type FastestBox = { flow: string; step: number; ends: End[]; editable?: boolean; lit?: number; on?: boolean };

/** Where a line sends work to whichever of several places would start it soonest. */
export const FastestNode = memo(function FastestNode({ id, data }: NodeProps<Node<FastestBox>>) {
  const write = (of: End[]) => change((d) => editStep(d, data.flow, data.step, (s) => ({ ...s, to: rawTo({ kind: "fastest", of }) })));
  return (
    <div className={cx("w-[220px] rounded-xl border bg-panel shadow-sm", data.on ? "border-accent" : "border-ok/60")}>
      <div className="relative border-b border-line px-3 py-1.5">
        <Handle type="target" position={Position.Left} className={cx(PORT, data.on ? "!bg-accent" : HUE.fastest!.dot)} style={{ left: -6, top: 14 }} />
        <div className="text-[10px] uppercase tracking-wide text-ok">fastest of</div>
        <div className="text-[10px] text-dim">whichever would start it soonest</div>
      </div>
      {data.ends.map((e, k) => (
        <div key={k} className={cx("relative flex h-7 items-center gap-1.5 px-3 text-[11px]", data.lit === k && "bg-accent/15")}>
          <Handle type="source" id={`end-${k}-back`} position={Position.Left} className="!opacity-0" style={{ left: -6 }} />
          {data.editable
            ? <button type="button" className={cx(CHIP, "min-w-0 flex-1 justify-between font-mono")} onClick={(ev) => pick({ x: ev.clientX, y: ev.clientY, from: { node: id, handle: `end-${k}` } })}><span className="truncate">{toText(e)}</span><ChevronDown size={10} className="shrink-0 text-dim" /></button>
            : <span className="min-w-0 flex-1 truncate font-mono">{toText(e)}</span>}
          {data.editable && data.ends.length > 2 && <button type="button" aria-label={`remove ${toText(e)}`} className="nodrag nopan text-dim hover:text-bad" onClick={() => write(data.ends.filter((_, n) => n !== k))}><X size={11} /></button>}
          <Handle type="source" id={`end-${k}`} position={Position.Right} className={cx(PORT, data.lit === k ? "!bg-accent" : hue(e.kind).dot, !data.editable && "!pointer-events-none")} style={{ right: -6 }} />
        </div>
      ))}
      {data.editable && (
        <button type="button" className="nodrag nopan relative flex h-7 w-full items-center gap-1 rounded-b-xl border-t border-line px-3 text-[11px] text-dim hover:bg-muted hover:text-fg"
                onClick={(e) => pick({ x: e.clientX, y: e.clientY, from: { node: id, handle: "new" } })}>
          <Plus size={12} />add another place
        </button>
      )}
    </div>
  );
});

export type OrderBox = { /** The flow that holds the order. */ flow: string; ends: End[]; editable?: boolean; selected?: boolean; lit?: number; on?: boolean; /** No line hands work to it. */ unused?: boolean; /** Request paths it takes besides chat. */ takes?: string[]; /** The models that run on a provider's server. */ cloud?: string[] };

/** Where a line sends work to several places in turn: the first, and each one after it when the one before fails. */
export const OrderNode = memo(function OrderNode({ id, data }: NodeProps<Node<OrderBox>>) {
  const from = useWireFrom();
  // A line of a rule can be let go on it; a line of its own cannot.
  const canTake = from !== null && from !== id && from.startsWith("flow:");
  return (
    <div className={cx("w-[220px] rounded-xl border bg-panel shadow-sm", data.selected ? "border-accent ring-2 ring-accent/25" : data.on ? "border-accent" : "border-ok/60", canTake && RING)}>
      <div className="relative border-b border-line px-3 py-1.5">
        <Handle type="target" position={Position.Left} className={cx(PORT, "target", data.on ? "!bg-accent" : HUE.fastest!.dot)} style={{ left: -6, top: 14 }} />
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-ok">in order</span>
          {(data.takes ?? []).length > 0 && <span className="shrink-0 rounded border border-line px-1 text-[9px] uppercase text-dim" title={`not chat: it takes requests on ${data.takes!.join(", ")}`}>not chat</span>}
          {data.editable && <button type="button" aria-label={`delete order ${data.flow}`} title="delete this order" className={cx(BIN, "ml-auto h-5 w-5")} onClick={(e) => { e.stopPropagation(); remove({ kind: "flow", id: data.flow }); }}><Trash2 size={12} /></button>}
        </div>
        <div className={cx("text-[10px]", data.unused ? "text-warn" : "text-dim")}>{data.unused ? "no line sends here yet: drag a line's dot here" : "the next one when one fails"}</div>
      </div>
      {data.ends.map((e, k) => {
        // A request that failed on a model here is only moved to another model here.
        const dead = e.kind === "peer" && data.ends.slice(0, k).some((p) => p.kind === "model");
        return (
          <div key={k} className={cx("relative flex h-7 items-center gap-1.5 px-3 text-[11px]", data.lit === k && "bg-accent/15")}>
            <Handle type="source" id={`end-${k}-back`} position={Position.Left} className="!opacity-0" style={{ left: -6 }} />
            <span className="w-3 shrink-0 text-right text-[10px] tabular text-dim/70">{k + 1}</span>
            {data.editable
              ? <button type="button" className={cx(CHIP, "min-w-0 flex-1 justify-between font-mono", dead && "border-warn text-warn")} title={dead ? "Not reached: a request that failed on a model here is only moved to another model here. A peer is tried when it comes first." : undefined}
                        onClick={(ev) => pick({ x: ev.clientX, y: ev.clientY, from: { node: id, handle: `end-${k}` } })}><span className="truncate">{toText(e)}</span><ChevronDown size={10} className="shrink-0 text-dim" /></button>
              : <span className="min-w-0 flex-1 truncate font-mono">{toText(e)}</span>}
            {data.editable && k > 0 && <button type="button" aria-label={`try ${toText(e)} sooner`} title="try this one sooner" className="nodrag nopan text-dim hover:text-fg" onClick={() => change((d) => raisePlace(d, data.flow, k))}><ArrowUp size={11} /></button>}
            {data.editable && <button type="button" aria-label={`remove ${toText(e)}`} title={data.ends.length > 2 ? "take this place out" : "take this place out: the line then goes straight to the other"} className="nodrag nopan text-dim hover:text-bad" onClick={() => change((d) => dropPlace(d, data.flow, k))}><X size={11} /></button>}
            <Handle type="source" id={`end-${k}`} position={Position.Right} className={cx(PORT, data.lit === k ? "!bg-accent" : hue(e.kind === "model" && (data.cloud ?? []).includes(e.model) ? "cloud" : e.kind).dot, !data.editable && "!pointer-events-none")} style={{ right: -6 }} />
          </div>
        );
      })}
      {data.editable && (
        <button type="button" className="nodrag nopan relative flex h-7 w-full items-center gap-1 rounded-b-xl border-t border-line px-3 text-[11px] text-dim hover:bg-muted hover:text-fg"
                onClick={(e) => pick({ x: e.clientX, y: e.clientY, from: { node: id, handle: "new" } })}>
          <Plus size={12} />then try another
        </button>
      )}
    </div>
  );
});

export type RefuseBox = { flow: string; step: number; why: string; editable?: boolean; on?: boolean };

/** Where a line ends without running anything: the caller is told why. */
export const RefuseNode = memo(function RefuseNode({ data }: NodeProps<Node<RefuseBox>>) {
  return (
    <div className={cx("w-[220px] rounded-xl border bg-panel px-3 py-2 shadow-sm", data.on ? "border-bad ring-2 ring-bad/25" : "border-bad/50")}>
      <Handle type="target" position={Position.Left} className={cx(PORT, "!bg-bad")} style={{ left: -6 }} />
      <div className="text-[10px] uppercase tracking-wide text-bad">refuse the request</div>
      <div className="mt-0.5 text-[10px] text-dim">and tell the caller:</div>
      {data.editable
        ? <input aria-label="what the caller is told" className={cx(FIELD, "mt-1 w-full")} value={data.why}
                 onChange={(e) => change((d) => editStep(d, data.flow, data.step, (s) => ({ ...s, to: { refuse: e.target.value } })))} />
        : <div className="mt-0.5 truncate text-[11px]">{data.why}</div>}
    </div>
  );
});

export type Hub = {
  title: string; sub: string; editable?: boolean;
  /** Every name a client can ask this node for, and what its line says: `loose` is one that goes nowhere yet. */
  rows: { id: string; on?: boolean; loose?: boolean; /** The variants it can be asked for in, as `id:variant`. */ variants?: string[]; /** The kind of thing its line goes to, for the colour of its dot. */ to?: string; /** Why this name cannot be routed; it then has no dot to drag. */ fixed?: string }[];
  /** Models no rule takes, and so not drawn: there to be picked when one is to be offered or routed. */
  others?: string[];
  /** What becomes of a name no rule takes: run as itself, refused, decided by a rule drawn beside, or not yet said. */
  rest?: "asked" | "refuse" | "rule" | "none";
};

/** This node's router: the model names it sends somewhere, each with a line to where requests for it go. */
export const HubNode = memo(function HubNode({ data }: NodeProps<Node<Hub>>) {
  const [typing, setTyping] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const add = (v: string) => { setTyping(null); addName(v.trim()); };
  const order = data.rows.map((r) => r.id);
  return (
    <div className={cx("w-[240px] rounded-xl border border-line bg-panel shadow-sm")}>
      <div className="border-b border-line px-3 py-2">
        <div className="flex items-center gap-2"><Split size={14} className="text-accent" /><span className="truncate font-medium">{data.title}</span></div>
        <div className="mt-0.5 truncate text-[11px] text-dim">{data.sub}</div>
      </div>
      {data.rows.length > 0 && <div className="px-3 pt-1.5 text-[10px] uppercase tracking-wide text-dim" title="the names callers may ask for">types</div>}
      {data.rows.map((r) => (
        <div key={r.id} className={cx("nodrag nopan group relative flex h-[22px] items-center px-3 text-[11px] hover:bg-muted", r.on && "bg-accent/15", r.fixed && "text-dim", over === r.id && "border-t-2 border-accent")}
             title={r.fixed ?? `drag the dot to say where requests for ${r.id} go; drag the name to move it up or down the list`}
             // A row is dragged by its name to another row's place; the dot at its end draws its line instead.
             data-type={r.id}
             onPointerDown={(e) => {
               if (!data.editable || r.id === ANY || renaming === r.id || (e.target as Element).closest?.(".react-flow__handle, button, input")) return;
               const from = r.id;
               let to: string | null = null;
               const track = (ev: PointerEvent) => {
                 to = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-type]")?.getAttribute("data-type") ?? null;
                 setOver(to !== null && to !== from && to !== ANY ? to : null);
               };
               const drop = () => {
                 document.removeEventListener("pointermove", track);
                 setOver(null);
                 if (to !== null && to !== from && to !== ANY) { const at = to; change((d) => movedName(d, order, from, order.indexOf(at) - order.indexOf(from))); }
               };
               document.addEventListener("pointermove", track);
               document.addEventListener("pointerup", drop, { once: true });
             }}
             onMouseEnter={() => hover(`e:ask:${r.id}`)} onMouseLeave={() => hover(null)}>
          {/* A name sent to a peer leaves on the peers' side. */}
          <Handle type="source" id={`ask-${r.id}-back`} position={Position.Left} className="!opacity-0 !pointer-events-none" style={{ left: -6 }} />
          {renaming === r.id
            ? <Renamed start wide name={r.id} label={`new name for ${r.id}`} className="h-5 bg-panel text-[11px]" onRename={(to) => retype(r.id, to, order)} onEnd={() => setRenaming(null)} />
            : <span className={cx("truncate font-mono", r.loose && "text-warn")} onDoubleClick={() => { if (data.editable && r.id !== ANY) setRenaming(r.id); }}>{r.id === ANY ? "anything else" : r.id}</span>}
          {(r.variants ?? []).length > 0 && <span className="ml-1.5 min-w-0 truncate text-[10px] text-dim" title={`also asked for as ${r.variants!.map((v) => `${r.id}:${v}`).join(", ")}`}>:{r.variants!.join(" :")}</span>}
          {r.loose && <span className="ml-auto shrink-0 text-[10px] text-warn">drag me →</span>}
          {data.editable && r.id !== ANY && renaming !== r.id && (
            <button type="button" aria-label={`${r.id} options`} title="rename, move or remove this type" className={cx("nodrag nopan mr-1 hidden h-5 w-5 shrink-0 place-items-center rounded text-dim hover:bg-line hover:text-fg group-hover:grid", !r.loose && "ml-auto")}
                    onClick={(e) => choose(e, [
                      { label: "Rename…", value: "rename", hint: "or double-click the name" },
                      { label: "Move up", value: "up", off: order.indexOf(r.id) === 0 },
                      { label: "Move down", value: "down", off: order.indexOf(r.id) === order.length - 1 },
                      { label: "Move to the top", value: "top", off: order.indexOf(r.id) === 0 },
                      { label: "Move to the bottom", value: "bottom", off: order.indexOf(r.id) === order.length - 1 },
                      { label: "Remove from this router", value: "remove", danger: true, hint: "it is no longer offered here; other routers are untouched" },
                    ], (v) => {
                      const at = order.indexOf(r.id);
                      if (v === "rename") setRenaming(r.id);
                      else if (v === "remove") dropName(r.id);
                      else change((d) => movedName(d, order, r.id, v === "up" ? -1 : v === "down" ? 1 : v === "top" ? -at : order.length - 1 - at));
                    })}>
              <MoreHorizontal size={12} />
            </button>
          )}
          <Handle type="source" id={`ask-${r.id}`} position={Position.Right} style={{ right: -6 }}
                  className={cx(PORT, r.on ? "!bg-accent" : hue(r.to ?? "unset").dot, (!data.editable || r.fixed) && "!pointer-events-none", r.fixed && "!opacity-0")} />
        </div>
      ))}
      {/* What becomes of every name that is not a type, in one line, to be changed where it is read. */}
      {(() => {
        const n = (data.others ?? []).length;
        const says = data.rest === "asked" ? `other names run as themselves${n ? ` (${n})` : ""}`
          : data.rest === "refuse" ? `other names are refused${n ? ` (${n} models)` : ""}`
          : data.rest === "rule" ? "any other name: decided by a rule" : "any other name: not said yet";
        const line = cx("w-full border-t border-line px-3 py-1.5 text-left text-[10px]", data.rest === "none" ? "text-warn" : "text-dim");
        return data.editable && data.rest !== "rule"
          ? <button type="button" className={cx(line, "nodrag nopan flex items-center gap-1 hover:bg-muted hover:text-fg")} title="what happens to a name that is not one of the types"
                    onClick={(e) => choose(e, [
                      { label: "a name that is not a type", head: true },
                      { label: "Refuse it", value: "refuse", hint: "only the types above can be asked for", on: data.rest === "refuse" },
                      { label: "Run it as itself", value: "asked", hint: "every model stays callable by its own name", on: data.rest === "asked" },
                    ], (v) => change((d) => withRest(d, v as "asked" | "refuse")))}>
              <span className="min-w-0 flex-1 truncate">{says}</span><ChevronDown size={10} className="shrink-0" />
            </button>
          : <div className={line}>{says}</div>;
      })()}
      {data.editable && (typing === null ? (
        <div className="px-1.5 pb-1.5">
          <button type="button" className="nodrag nopan flex h-7 w-full items-center justify-center gap-1 rounded-md border border-dashed border-line text-[11px] text-dim hover:border-accent hover:text-fg"
                  onClick={(e) => choose(e, [{ label: "A new type…", value: "\u0000new", hint: "a name of your own, like LLM or ImageGen" }, { label: "a model, offered or routed under its own name", head: true }, ...(data.others ?? []).map((o) => ({ label: o, mono: true }))],
                    (v) => (v === "\u0000new" ? setTyping("") : add(v)), { says: "a new type:", make: add })}>
            <Plus size={12} />type
          </button>
        </div>
      ) : (
        <input autoFocus aria-label="a new type callers can ask for" placeholder="a name, e.g. LLM" value={typing} onChange={(e) => setTyping(e.target.value)}
               onBlur={() => add(typing)} onKeyDown={(e) => { if (e.key === "Enter") add(typing); if (e.key === "Escape") setTyping(null); }}
               className="nodrag nopan m-1.5 h-7 w-[calc(100%-12px)] rounded-md border border-accent bg-panel px-2 font-mono text-[11px] focus:outline-none" />
      ))}
    </div>
  );
});

export type Dest = { /** The hardware its backend runs on, to tell two copies of a model apart at a glance. */ hardware?: { name: string; cpu: boolean }[]; title: string; sub: string; /** `model` or `peer`. */ kind: string; /** A model on a provider's server. */ cloud?: boolean; on?: boolean; /** Not somewhere a chat request can run. */ shut?: boolean; /** A peer that cannot be reached. */ down?: boolean; /** Where its backend's route sends a request it fails, as "model on backend". */ fallback?: string };

/** A model or a peer a line ends at. Only the ones a line uses are drawn; the rest are picked from a list when wanted. */
export const DestNode = memo(function DestNode({ data }: NodeProps<Node<Dest>>) {
  const open = useConnection((c) => (c.inProgress ? takesWork(c.fromNode.id) : false));
  return (
    <div title={data.shut ? `${data.title} is not a chat model: only a rule that takes its path can send here` : undefined}
         className={cx("w-[200px] rounded-xl border bg-panel px-3 py-1.5 shadow-sm", data.on ? "border-accent bg-accent/10" : "border-line", open && !data.shut && RING, open && data.shut && "opacity-40")}>
      <Handle type="target" position={Position.Left} className={cx(PORT, data.on ? "!bg-accent" : hue(data.cloud ? "cloud" : data.kind).dot, "!opacity-100")} style={{ left: -6 }} />
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium">{data.title}</span>
        {data.cloud && <span title={HUE.cloud!.says} className="inline-flex shrink-0 items-center gap-0.5 rounded border border-cloud/50 px-1 text-[9px] uppercase text-cloud"><Cloud size={9} />cloud</span>}
        {(data.hardware ?? []).map((h) => (
          <span key={h.name} title={`runs on ${h.name}`} className={cx("inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[9px] uppercase", h.cpu ? "border-line text-dim" : "border-ok/50 text-ok")}>
            {h.cpu ? <Cpu size={9} /> : <CircuitBoard size={9} />}{h.name}
          </span>
        ))}
      </div>
      <div className={cx("truncate text-[10px]", data.down ? "text-bad" : "text-dim")}>{data.sub}</div>
      {data.fallback && (
        <div title="Where this backend's route sends a request it fails before answering. A strict router's callers skip it." className="mt-0.5 truncate border-t border-dashed border-line pt-0.5 text-[10px] text-dim">
          ↳ falls back to <span className="font-mono">{data.fallback}</span>
        </div>
      )}
    </div>
  );
});

export type ActionBox = { name: string; kind: string; says?: string; editable?: boolean; selected?: boolean; on?: boolean; /** No line runs it. */ unused?: boolean };

/** Something a line sets off beside sending the request on: it changes nothing about where the request goes. */
export const ActionNode = memo(function ActionNode({ data }: NodeProps<Node<ActionBox>>) {
  // Only a line of a rule can run one.
  const open = useConnection((c) => (c.inProgress ? c.fromNode.id.startsWith("flow:") : false));
  const kind = ACTIONS.find((k) => k.key === data.kind);
  return (
    <div className={cx("w-[220px] rounded-xl border bg-panel px-3 py-2 shadow-sm", data.selected ? "border-accent ring-2 ring-accent/25" : data.on ? "border-accent bg-accent/10" : "border-warn/60", open && RING)}>
      <Handle type="target" position={Position.Left} className={cx(PORT, data.on ? "!bg-accent" : HUE.action!.dot, "!opacity-100")} style={{ left: -6 }} />
      <div className="flex items-center gap-1.5">
        <Zap size={12} className="shrink-0 text-warn" />
        <span className="text-[10px] uppercase tracking-wide text-warn">action</span>
        {data.editable ? <Renamed name={data.name} label={`name of action ${data.name}`} className="text-[12px]" onRename={(to) => rename({ kind: "action", id: data.name }, to)} /> : <span className="truncate font-mono text-[12px] font-medium">{data.name}</span>}
        {data.editable && <button type="button" aria-label={`delete action ${data.name}`} title="delete this action" className={cx(BIN, "ml-auto h-5 w-5")} onClick={(e) => { e.stopPropagation(); remove({ kind: "action", id: data.name }); }}><Trash2 size={12} /></button>}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-dim" title={data.says}>{kind ? `${kind.label.toLowerCase()}${data.says ? `: ${data.says}` : ""}` : "not set up yet"}</div>
      {data.unused && <div className="truncate text-[10px] text-warn">no line runs this yet: drag a line's dot here</div>}
    </div>
  );
});

/** Every node the routing map draws, by its React Flow type. */
export const VIEWS = { hub: HubNode, flow: SwitchNode, fastest: FastestNode, order: OrderNode, refuse: RefuseNode, dest: DestNode, action: ActionNode };
