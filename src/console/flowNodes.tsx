/**
 * What the routing map draws: this node and the names it answers to, a rule whose lines read as
 * sentences and are edited where they stand, the places a line can end (a model, a peer, the
 * fastest of several, a refusal) and the actions a line can set off. VIEWS at the foot lists
 * them by node type; how each behaves when a line is drawn is NODES in draft.ts.
 */
import { Handle, Position, useConnection, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDown, MoreHorizontal, Plus, Split, X, Zap } from "lucide-react";
import { memo, useState } from "react";

import { ACTIONS, editStep, list, moveStep, NODES, obj, put, rawTo, text, toOf, toText, withDo, type Doc, type End } from "./draft.js";
import { addName, change, choose, editSelect, hover, pick, type Choice } from "./editStore.js";
import { cx } from "./ui.js";

type About = "the request" | "where it would go" | "this node";
type Cond =
  | { key: string; kind: "bool"; yes: string; no: string; about: About; /** What it means, where the words alone do not say. */ hint?: string }
  | { key: string; kind: "num"; before: string; after: string; seed: number; about: About }
  | { key: string; kind: "list"; before: string; hint: string; about: About }
  | { key: "idle"; kind: "idle"; about: About }
  | { key: "time"; kind: "time"; about: About };

/** Every condition a line can test, in the words the canvas uses for it. "The target" is where the line sends work. */
export const CONDS: Cond[] = [
  { key: "images", kind: "bool", yes: "the request has images", no: "the request has no images", about: "the request" },
  { key: "tools", kind: "bool", yes: "the request uses tools", no: "the request uses no tools", about: "the request" },
  { key: "tokensOver", kind: "num", before: "the prompt is over", after: "tokens", seed: 8000, about: "the request" },
  { key: "tokensUnder", kind: "num", before: "the prompt is under", after: "tokens", seed: 8000, about: "the request" },
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
const nameOf = (c: Cond) => (c.kind === "bool" ? c.yes : c.kind === "idle" ? "a model has been idle for a while" : c.kind === "time" ? "it is between two times of day" : `${c.before} …`);
const seedOf = (c: Cond): unknown => (c.kind === "bool" ? true : c.kind === "num" ? c.seed : c.kind === "idle" ? { ms: 600_000 } : c.kind === "time" ? { from: "22:00", to: "06:00" } : []);
/** A condition and its value as one phrase, for a line that is read and not edited. */
const phrase = (c: Cond, v: unknown): string =>
  c.kind === "bool" ? (v === false ? c.no : c.yes)
  : c.kind === "num" ? `${c.before} ${String(v)} ${c.after}`
  : c.kind === "list" ? `${c.before} ${list(v).join(" or ")}`
  : c.kind === "time" ? `it is between ${text(obj(v).from)} and ${text(obj(v).to)}`
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
export function Conds({ when, models, optional, onChange }: { when: Doc; models: string[]; optional?: boolean; onChange: (w: Doc) => void }) {
  const without = (k: string) => { const { [k]: _, ...rest } = when; return rest; };
  const have = CONDS.filter((c) => c.key in when);
  const rest = CONDS.filter((c) => !(c.key in when));
  const adding: Choice[] = (["the request", "where it would go", "this node"] as About[]).flatMap((about) => {
    const these = rest.filter((c) => c.about === about);
    return these.length ? [{ label: `about ${about}`, head: true }, ...these.map((c) => ({ label: nameOf(c), value: c.key, ...(c.kind === "bool" && c.hint ? { hint: c.hint } : {}) }))] : [];
  });
  const add = (key: string) => { const c = CONDS.find((x) => x.key === key); if (c) onChange({ ...when, [c.key]: seedOf(c) }); };
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {have.map((c, n) => {
        const v = when[c.key];
        const drop = <button type="button" aria-label="remove this condition" title="remove this condition" className="nodrag nopan text-dim hover:text-bad" onClick={() => onChange(without(c.key))}><X size={11} /></button>;
        return (
          <span key={c.key} className="flex min-w-0 items-center gap-1">
            {n > 0 && <span className="text-dim">and</span>}
            {c.kind === "bool" ? (
              <button type="button" className={CHIP}
                      onClick={(e) => choose(e, [{ label: c.yes, value: "yes", on: v !== false }, { label: c.no, value: "no", on: v === false }, { label: "Remove this condition", value: "drop", danger: true }],
                        (x) => onChange(x === "drop" ? without(c.key) : { ...when, [c.key]: x === "yes" }))}>
                <span className="truncate">{v === false ? c.no : c.yes}</span><ChevronDown size={10} className="shrink-0 text-dim" />
              </button>
            ) : c.kind === "num" ? (
              <>
                <span>{c.before}</span>
                <input aria-label={c.before} type="number" min={0} className={cx(FIELD, "w-16 tabular")} value={typeof v === "number" ? v : ""} onChange={(e) => onChange({ ...when, [c.key]: Number(e.target.value) })} />
                <span>{c.after}</span>
                {drop}
              </>
            ) : c.kind === "list" ? (
              <>
                <span>{c.before}</span>
                <input aria-label={c.before} className={cx(FIELD, "w-28 font-mono")} placeholder={c.hint} value={list(v).join(", ")}
                       onChange={(e) => onChange({ ...when, [c.key]: e.target.value.split(",").map((x) => x.trim()).filter((x, k, all) => x !== "" || k === all.length - 1) })} />
                {drop}
              </>
            ) : c.kind === "time" ? (
              <>
                <span>it is between</span>
                {(["from", "to"] as const).map((k) => (
                  <span key={k} className="flex items-center gap-1">
                    {k === "to" && <span>and</span>}
                    <input aria-label={k === "from" ? "from this time of day" : "until this time of day"} type="time" className={cx(FIELD, "tabular")} value={text(obj(v)[k])}
                           onChange={(e) => onChange({ ...when, time: { ...obj(v), [k]: e.target.value } })} />
                  </span>
                ))}
                {drop}
              </>
            ) : (
              <>
                <button type="button" className={cx(CHIP, "font-mono")}
                        onClick={(e) => choose(e, [{ label: "the target", value: "", hint: "where this line sends work", on: !text(obj(v).model) }, { label: "a model", head: true }, ...models.map((m) => ({ label: m, mono: true, on: text(obj(v).model) === m }))],
                          (m) => { const { model: _, ...keep } = obj(v); onChange({ ...when, idle: m ? { ...keep, model: m } : keep }); })}>
                  <span className="truncate">{text(obj(v).model) || "the target"}</span><ChevronDown size={10} className="shrink-0 text-dim" />
                </button>
                <span>has been idle</span>
                {/* The file keeps milliseconds; a person thinks in minutes. */}
                <input aria-label="minutes idle" type="number" min={0} step="any" className={cx(FIELD, "w-12 tabular")} value={typeof obj(v).ms === "number" ? (obj(v).ms as number) / 60_000 : ""}
                       onChange={(e) => onChange({ ...when, idle: { ...obj(v), ms: Math.round(Number(e.target.value) * 60_000) } })} />
                <span>min</span>
                {drop}
              </>
            )}
          </span>
        );
      })}
      {have.length === 0 && optional && <span className="text-dim">it can take it</span>}
      {adding.length > 0 && (
        <button type="button" className={cx(CHIP, "border-dashed text-dim", have.length === 0 && !optional && "border-warn text-warn")} onClick={(e) => choose(e, adding, add)}>
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
  flow: { dot: "!bg-info", stroke: "var(--info)", says: "a routing rule" },
  fastest: { dot: "!bg-pick", stroke: "var(--pick)", says: "the fastest of several" },
  refuse: { dot: "!bg-bad", stroke: "var(--bad)", says: "a refusal" },
  action: { dot: "!bg-warn", stroke: "var(--warn)", says: "an action" },
  unset: { dot: "!bg-dim", stroke: "var(--dim)", says: "nowhere yet" },
};
const hue = (kind: string) => HUE[kind] ?? HUE.unset!;
// Big enough to see and to grab at the size the whole picture is drawn.
const PORT = "!h-3.5 !w-3.5 !border-2 !border-panel";

/** What is known about a line: `bad` is why it cannot work, `unsure` that its target has not said whether it can take what the line tests. */
export type Mark = { bad: string } | { unsure: true } | null;

export type SwitchBox = { marks?: Mark[]; /** The names that enter it: a line that sends one of them to itself is "its own model". */ inputs?: string[]; name: string; steps: Doc[]; selected?: boolean; editable?: boolean; lit?: number; models: string[]; lanes: string[]; /** Every action a line could run. */ actions: string[]; /** Switched off: drawn, but it takes nothing. */ off?: boolean; note?: string; /** It keeps a conversation where it started. */ sticky?: boolean; /** How many times each line has decided since the rules last changed. */ hits?: number[]; /** No name enters it and no rule hands work to it. */ orphan?: boolean };

export const SwitchNode = memo(function SwitchNode({ id, data }: NodeProps<Node<SwitchBox>>) {
  const from = useWireFrom();
  const last = data.steps.length - 1;
  const canTake = from !== id && takesWork(from);
  const edit = (i: number, fn: (s: Doc) => Doc | null) => change((d) => editStep(d, data.name, i, fn));
  // Sending a name to the model of the same name is leaving it alone: the default, said as such.
  const own = (to: ReturnType<typeof toOf>) => to.kind === "model" && (data.inputs ?? []).includes(to.model);
  return (
    <div className={cx(
      "w-[570px] rounded-xl border bg-panel shadow-sm transition-colors",
      data.selected ? "border-accent ring-2 ring-accent/25" : "border-info/60",
      canTake && RING, data.off && "opacity-60",
    )} title={data.note}>
      <div className="relative flex h-9 items-center gap-2 border-b border-line px-3">
        <Handle type="target" position={Position.Left} className={cx(PORT, HUE.flow!.dot)} style={{ left: -6 }} />
        <Split size={13} className="text-info" />
        <span className="text-[10px] uppercase tracking-wide text-info">routing rule</span>
        <span className="truncate font-mono font-medium">{data.name}</span>
        <span className={cx("ml-auto shrink-0 text-[10px]", data.orphan ? "text-warn" : "text-dim")}>{data.off ? "switched off" : data.orphan ? "nothing reaches this yet" : data.sticky ? "a conversation stays where it starts" : "top to bottom, first match wins"}</span>
      </div>
      {data.steps.map((s, i) => {
        const to = toOf(s.to);
        const when = obj(s.when);
        return (
          <div key={i} className={cx("relative flex min-h-[32px] items-center gap-1.5 px-3 py-1 text-[11px]", data.lit === i && "bg-accent/15")}
               onMouseEnter={() => hover(`e:${id}:${i}`)} onMouseLeave={() => hover(null)}>
            {/* Work sent to a peer leaves on the peers' side. */}
            <Handle type="source" id={`step-${i}-back`} position={Position.Left} className="!opacity-0" style={{ left: -6 }} />
            {i === last ? <span className="flex-1 font-medium">Otherwise</span> : (
              <>
                <span className="font-medium">If</span>
                {data.editable
                  // A peer can be down, so a line that sends to one may stand with no condition of its own.
                  ? <Conds when={when} models={data.models} optional={to.kind === "peer"} onChange={(w) => edit(i, (r) => ({ ...r, when: w }))} />
                  : <span className="min-w-0 flex-1 truncate">{sentence(when) || "it can take it"}</span>}
              </>
            )}
            {to.kind !== "refuse" && <span className="shrink-0 text-dim">send to</span>}
            {data.editable ? (
              <button type="button" className={cx(CHIP, "max-w-[130px] shrink-0 font-mono", to.kind === "unset" && "border-warn text-warn")} title="choose where this line sends requests"
                      onClick={(e) => pick({ x: e.clientX, y: e.clientY, from: { node: id, handle: `step-${i}` } })}>
                <span className="truncate">{to.kind === "unset" ? "choose where" : own(to) ? "its own model" : toText(to)}</span><ChevronDown size={10} className="shrink-0 text-dim" />
              </button>
            ) : <span className="max-w-[130px] shrink-0 truncate font-mono" title={toText(to)}>{own(to) ? "its own model" : toText(to)}</span>}
            {typeof s.max === "number" && <span className="shrink-0 rounded border border-line px-1 text-[10px] text-dim" title={`takes at most ${s.max} at once; the rest go on down the list`}>≤{s.max}</span>}
            {data.hits && <span className="w-7 shrink-0 text-right text-[10px] tabular text-dim" title={`decided ${data.hits[i] ?? 0} ${(data.hits[i] ?? 0) === 1 ? "request" : "requests"} since the rules last changed or the node started`}>{data.hits[i] ?? 0}×</span>}
            {data.marks?.[i] && ("bad" in data.marks[i]!
              ? <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-bad text-[10px] font-bold text-panel" title={(data.marks[i] as { bad: string }).bad}>!</span>
              : <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-dim/60 text-[10px] text-dim" title="Not checked: this model has not said whether it takes what this line is for. It is checked once the model has loaded, or when you describe it under Models.">?</span>)}
            {data.editable && (
              <button type="button" aria-label={`line ${i + 1} options`} title="more for this line" className="nodrag nopan grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim hover:bg-muted hover:text-fg"
                      onClick={(e) => choose(e, [
                        ...(i < last ? [{ label: "Move up", value: "up", off: i === 0 }, { label: "Move down", value: "down", off: i >= last - 1 }] : []),
                        { label: "queue it in", head: true },
                        { label: "the model's own lane", value: "lane:", on: text(s.lane) === "" },
                        ...data.lanes.map((l) => ({ label: `the ${l} lane`, value: `lane:${l}`, on: text(s.lane) === l })),
                        { label: "also run", head: true },
                        ...(data.actions.length ? data.actions.map((a) => ({ label: a, value: `do:${a}`, mono: true, on: list(s.do).includes(a) })) : [{ label: "no actions yet: + action makes one", off: true }]),
                        { label: "more", head: true },
                        { label: "Set request fields (params)…", value: "more" },
                        ...(i < last ? [{ label: "Delete this line", value: "delete", danger: true }] : []),
                      ], (v) => {
                        if (v === "up") change((d) => moveStep(d, data.name, i, -1));
                        else if (v === "down") change((d) => moveStep(d, data.name, i, 1));
                        else if (v === "delete") edit(i, () => null);
                        else if (v === "more") editSelect({ kind: "flow", id: data.name });
                        else if (v.startsWith("do:")) change((d) => withDo(d, data.name, i, v.slice(3), !list(s.do).includes(v.slice(3))) ?? d);
                        else if (v.startsWith("lane:")) edit(i, ({ lane: _, ...r }) => (v === "lane:" ? r : { ...r, lane: v.slice(5) }));
                      })}>
                <MoreHorizontal size={13} />
              </button>
            )}
            <Handle type="source" id={`step-${i}`} position={Position.Right} className={cx(PORT, data.lit === i ? "!bg-accent" : hue(to.kind).dot, !data.editable && "!pointer-events-none")} style={{ right: -6 }} />
          </div>
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
  rows: { id: string; on?: boolean; loose?: boolean; /** The kind of thing its line goes to, for the colour of its dot. */ to?: string; /** Why this name cannot be routed; it then has no dot to drag. */ fixed?: string }[];
  /** Names that go to their own model and so are not drawn: there to be picked when one is to be routed. */
  others?: string[];
};

/** This node's router: the model names it sends somewhere, each with a line to where requests for it go. */
export const HubNode = memo(function HubNode({ data }: NodeProps<Node<Hub>>) {
  const [typing, setTyping] = useState<string | null>(null);
  const add = (v: string) => { setTyping(null); addName(v.trim()); };
  return (
    <div className={cx("w-[240px] rounded-xl border border-line bg-panel shadow-sm")}>
      <div className="border-b border-line px-3 py-2">
        <div className="flex items-center gap-2"><Split size={14} className="text-accent" /><span className="truncate font-medium">{data.title}</span></div>
        <div className="mt-0.5 truncate text-[11px] text-dim">{data.sub}</div>
      </div>
      {data.rows.length > 0 && <div className="px-3 pt-1.5 text-[10px] uppercase tracking-wide text-dim">when asked for</div>}
      {data.rows.map((r) => (
        <div key={r.id} className={cx("relative flex h-[22px] items-center px-3 text-[11px] hover:bg-muted", r.on && "bg-accent/15", r.fixed && "text-dim")} title={r.fixed ?? `drag the dot to say where requests for ${r.id} go`}
             onMouseEnter={() => hover(`e:ask:${r.id}`)} onMouseLeave={() => hover(null)}>
          {/* A name sent to a peer leaves on the peers' side. */}
          <Handle type="source" id={`ask-${r.id}-back`} position={Position.Left} className="!opacity-0 !pointer-events-none" style={{ left: -6 }} />
          <span className={cx("truncate font-mono", r.loose && "text-warn")}>{r.id}</span>
          {r.loose && <span className="ml-auto shrink-0 text-[10px] text-warn">drag me →</span>}
          {r.fixed && <span className="ml-auto shrink-0 rounded border border-line px-1 text-[9px] uppercase text-dim" title={r.fixed}>not chat</span>}
          <Handle type="source" id={`ask-${r.id}`} position={Position.Right} style={{ right: -6 }}
                  className={cx(PORT, r.on ? "!bg-accent" : hue(r.to ?? "unset").dot, (!data.editable || r.fixed) && "!pointer-events-none", r.fixed && "!opacity-0")} />
        </div>
      ))}
      {/* What is not routed is not drawn: it goes to its own model, and says so in one line. */}
      <div className="border-t border-line px-3 py-1.5 text-[10px] text-dim">
        {(data.others ?? []).length > 0 ? `${data.others!.length} other ${data.others!.length === 1 ? "name goes" : "names go"} to ${data.others!.length === 1 ? "its" : "their"} own model` : data.rows.length ? "every other name goes to its own model" : "every name goes to its own model"}
      </div>
      {data.editable && (typing === null ? (
        <div className="px-1.5 pb-1.5">
          <button type="button" className="nodrag nopan flex h-7 w-full items-center justify-center gap-1 rounded-md border border-dashed border-line text-[11px] text-dim hover:border-accent hover:text-fg"
                  onClick={(e) => choose(e, [{ label: "A new name…", value: "\u0000new", hint: "one nothing serves yet, like auto" }, { label: "a name that goes to its own model now", head: true }, ...(data.others ?? []).map((o) => ({ label: o, mono: true }))],
                    (v) => (v === "\u0000new" ? setTyping("") : add(v)))}>
            <Plus size={12} />route a name
          </button>
        </div>
      ) : (
        <input autoFocus aria-label="a new name clients can ask for" placeholder="any name, e.g. auto" value={typing} onChange={(e) => setTyping(e.target.value)}
               onBlur={() => add(typing)} onKeyDown={(e) => { if (e.key === "Enter") add(typing); if (e.key === "Escape") setTyping(null); }}
               className="nodrag nopan m-1.5 h-7 w-[calc(100%-12px)] rounded-md border border-accent bg-panel px-2 font-mono text-[11px] focus:outline-none" />
      ))}
    </div>
  );
});

export type Dest = { title: string; sub: string; /** `model` or `peer`. */ kind: string; on?: boolean; /** Not somewhere a chat request can run. */ shut?: boolean; /** A peer that cannot be reached. */ down?: boolean };

/** A model or a peer a line ends at. Only the ones a line uses are drawn; the rest are picked from a list when wanted. */
export const DestNode = memo(function DestNode({ data }: NodeProps<Node<Dest>>) {
  const open = useConnection((c) => (c.inProgress ? takesWork(c.fromNode.id) : false));
  return (
    <div title={data.shut ? `${data.title} is not a chat model, so a line cannot end here` : undefined}
         className={cx("w-[200px] rounded-xl border bg-panel px-3 py-1.5 shadow-sm", data.on ? "border-accent bg-accent/10" : "border-line", open && !data.shut && RING, open && data.shut && "opacity-40")}>
      <Handle type="target" position={Position.Left} className={cx(PORT, data.on ? "!bg-accent" : hue(data.kind).dot, "!opacity-100")} style={{ left: -6 }} />
      <div className="truncate font-mono text-[12px] font-medium">{data.title}</div>
      <div className={cx("truncate text-[10px]", data.down ? "text-bad" : "text-dim")}>{data.sub}</div>
    </div>
  );
});

export type ActionBox = { name: string; kind: string; says?: string; selected?: boolean; on?: boolean; /** No line runs it. */ unused?: boolean };

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
        <span className="truncate font-mono text-[12px] font-medium">{data.name}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-dim" title={data.says}>{kind ? `${kind.label.toLowerCase()}${data.says ? `: ${data.says}` : ""}` : "not set up yet"}</div>
      {data.unused && <div className="truncate text-[10px] text-warn">no line runs this yet: drag a line's dot here</div>}
    </div>
  );
});

/** Every node the routing map draws, by its React Flow type. */
export const VIEWS = { hub: HubNode, flow: SwitchNode, fastest: FastestNode, refuse: RefuseNode, dest: DestNode, action: ActionNode };
