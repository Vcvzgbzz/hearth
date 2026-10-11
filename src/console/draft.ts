/**
 * The routing map's draft of hearth.yaml: how it is drawn, and what a drawn line changes in it.
 * Pure, so it tests without a browser.
 *
 * NODES says how each kind of node on the map behaves when a line is drawn from it or onto it;
 * ACTIONS lists the kinds of action. A new kind is an entry there, a view in flowNodes.tsx and a
 * place in Routing.tsx's layout.
 */
import { opsBetween, type Op } from "./diff.js";
import type { Backend, Flow, Node as NetNode, Resource, Routing, UiData } from "./types.js";

export type Doc = Record<string, unknown>;

export const isObj = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
export const obj = (v: unknown): Doc => (isObj(v) ? v : {});
export const text = (v: unknown): string => (typeof v === "string" ? v : "");
export const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** `doc` with `value` at `section.id`, or without that entry when `value` is undefined. */
export function put(doc: Doc, section: string, id: string, value: unknown): Doc {
  const { [id]: _, ...rest } = obj(doc[section]);
  return { ...doc, [section]: value === undefined ? rest : { ...obj(doc[section]), [id]: value } };
}

/** Somewhere a request can run: a model here, or a peer's copy of one (null: the id asked for). */
export type End = { kind: "model"; model: string } | { kind: "peer"; peer: string; model: string | null };
/** A step's `to`, read the same way whether it came from the file or from the running node. */
export type To = End | { kind: "flow"; flow: string } | { kind: "fastest"; of: End[] } | { kind: "refuse"; why: string } | { kind: "asked" } | { kind: "unset" };

/** The input that stands for every name no other flow takes. */
export const ANY = "*";

export function toOf(raw: unknown): To {
  if (typeof raw === "string") return raw === "" ? { kind: "unset" } : { kind: "model", model: raw };
  const o = obj(raw);
  if (typeof o.refuse === "string") return { kind: "refuse", why: o.refuse };
  if (o.asked === true) return { kind: "asked" };
  if (typeof o.flow === "string") return { kind: "flow", flow: o.flow };
  if (Array.isArray(o.fastest)) return { kind: "fastest", of: o.fastest.map(toOf).filter((e): e is End => e.kind === "model" || e.kind === "peer") };
  if (typeof o.peer === "string") return { kind: "peer", peer: o.peer, model: text(o.model) || null };
  return typeof o.model === "string" && o.model !== "" ? { kind: "model", model: o.model } : { kind: "unset" };
}

/** A target as hearth.yaml writes it: the shortest form that says it. */
export function rawTo(to: To): unknown {
  switch (to.kind) {
    case "model": return to.model;
    case "peer": return to.model === null ? { peer: to.peer } : { peer: to.peer, model: to.model };
    case "flow": return { flow: to.flow };
    case "fastest": return { fastest: to.of.map(rawTo) };
    case "refuse": return { refuse: to.why };
    case "asked": return { asked: true };
    default: return "";
  }
}

/** A target in a few words. */
export function toText(to: To): string {
  switch (to.kind) {
    case "model": return to.model;
    case "peer": return to.model === null ? `${to.peer} (peer)` : `${to.model} on ${to.peer}`;
    case "flow": return `rule ${to.flow}`;
    case "fastest": return `fastest of ${to.of.length}`;
    case "refuse": return "refuse it";
    case "asked": return "its own model";
    default: return "nowhere yet";
  }
}

/** The flows a draft declares, in the shape the graph draws. */
const flowsIn = (doc: Doc): Record<string, Flow> =>
  Object.fromEntries(Object.entries(obj(doc.flows)).map(([name, f]) => [name, {
    inputs: list(obj(f).inputs),
    steps: (Array.isArray(obj(f).steps) ? (obj(f).steps as unknown[]) : []).map(obj),
    ...(obj(f).off === true ? { off: true } : {}), ...(text(obj(f).note) ? { note: text(obj(f).note) } : {}),
    ...(typeof obj(f).sticky === "number" ? { sticky: obj(f).sticky as number } : {}),
    ...(list(obj(f).takes).length ? { takes: list(obj(f).takes) } : {}),
  }]));

/** The kinds of action, by the key that names each in the file: what it is called, and what a new one starts as. */
export const ACTIONS: { key: string; label: string; hint: string; seed: string }[] = [
  { key: "log", label: "Write a log line", hint: "shows on the Logs page", seed: "{asked} ran as {model} for {caller}" },
  { key: "call", label: "Call a URL", hint: "a webhook: sends what is known about the request", seed: "http://127.0.0.1:9000/hook" },
];

/** The draft as the payload the console draws: what is declared, with no traffic and nothing loaded. */
export function draftView(doc: Doc, live: UiData): UiData {
  const self = live.net.nodes.find((n) => n.self)!;
  // What the node reports about a backend it already runs stays on it; the draft says where it sits and what it serves.
  const backends: Backend[] = Object.entries(obj(doc.backends)).map(([name, b]) => {
    const running = (self.backends ?? []).find((x) => x.name === name);
    const serves = list(obj(b).serves);
    return {
      ...(running ?? { knowsWarm: false }), name, url: text(obj(b).url) || running?.url || "", server: text(obj(b).server) || null,
      resources: list(obj(b).resources), serves: serves.length ? serves : running?.serves ?? [],
    };
  });
  const peers: NetNode[] = Object.entries(obj(doc.peers)).map(([name, p]) =>
    live.net.nodes.find((n) => !n.self && n.name === name)
      ?? { name, up: false, map: obj(obj(p).models) as Record<string, string>, free: null, slots: null, queued: null });
  const resources: Resource[] = Object.entries(obj(doc.resources)).map(([name, r]) => ({
    name, kind: (text(obj(r).kind) || "gpu") as Resource["kind"], shared: obj(r).shared === true, holder: null, backends: [],
  }));
  const routing: Record<string, Routing> = {};
  for (const [id, m] of Object.entries(obj(doc.models))) {
    const wire = text(obj(m).as) || id;
    const backend = text(obj(m).backend) || backends.find((b) => (b.serves ?? []).includes(wire))?.name;
    // Where the draft cannot say which backend serves a name, what the running node worked out still stands.
    routing[id] = { ...live.routing?.[id], ...(backend ? { backend } : {}) };
  }
  const flows = flowsIn(doc);
  return {
    ...live, net: { ...live.net, nodes: [{ ...self, backends }, ...peers], resources },
    routing: { ...live.routing, ...routing }, flows, layout: obj(doc.layout) as UiData["layout"],
    actions: Object.fromEntries(Object.entries(obj(doc.actions)).map(([name, a]) => {
      const kind = ACTIONS.find((k) => k.key in obj(a))?.key ?? "";
      return [name, { kind, says: text(obj(a)[kind]) }];
    })),
  };
}

const stepsOf = (doc: Doc, flow: string): Doc[] | null => {
  const f = obj(doc.flows)[flow];
  return isObj(f) && Array.isArray(f.steps) ? (f.steps as unknown[]).map(obj) : null;
};
const withSteps = (doc: Doc, flow: string, steps: Doc[]): Doc => put(doc, "flows", flow, { ...obj(obj(doc.flows)[flow]), steps });

/** Point step `i` of a flow somewhere else, keeping its conditions; null when it already points there. */
export function pointStep(doc: Doc, flow: string, i: number, to: To): Doc | null {
  const steps = stepsOf(doc, flow);
  if (!steps || !steps[i] || (to.kind === "flow" && to.flow === flow)) return null;
  const raw = rawTo(to);
  if (JSON.stringify(steps[i].to) === JSON.stringify(raw)) return null;
  return withSteps(doc, flow, steps.map((s, k) => (k === i ? { ...s, to: raw } : s)));
}

/** Change step `i` of a flow with `fn`, or take it out when `fn` returns null. */
export function editStep(doc: Doc, flow: string, i: number, fn: (step: Doc) => Doc | null): Doc {
  const steps = stepsOf(doc, flow);
  if (!steps || !steps[i]) return doc;
  const next = fn(steps[i]);
  return withSteps(doc, flow, next === null ? steps.filter((_, k) => k !== i) : steps.map((s, k) => (k === i ? next : s)));
}

/** Swap step `i` with its neighbour `by` places along; the last step stays last. */
export function moveStep(doc: Doc, flow: string, i: number, by: number): Doc {
  const steps = stepsOf(doc, flow);
  const j = i + by;
  if (!steps || j < 0 || i >= steps.length - 1 || j >= steps.length - 1) return doc;
  return withSteps(doc, flow, steps.map((s, k) => (k === i ? steps[j]! : k === j ? steps[i]! : s)));
}

/** In a step that sends to the fastest of several, point candidate `k` somewhere else, or add one when `k` is null. */
export function pointEnd(doc: Doc, flow: string, i: number, k: number | null, to: To): Doc | null {
  const steps = stepsOf(doc, flow);
  const cur = steps && steps[i] ? toOf(steps[i].to) : null;
  if (!cur || cur.kind !== "fastest" || (to.kind !== "model" && to.kind !== "peer")) return null;
  const of = k === null ? [...cur.of, to] : cur.of.map((e, n) => (n === k ? to : e));
  return editStep(doc, flow, i, (s) => ({ ...s, to: rawTo({ kind: "fastest", of }) }));
}

/**
 * A flow that only says "requests for this name run there": one input, its own name, and one
 * line with no conditions. The canvas draws it as a line from the name, not as a rule.
 */
export function directTo(name: string, flow: { inputs: string[]; steps: { when?: unknown; to?: unknown; lane?: unknown; params?: unknown; do?: unknown }[] }): End | null {
  if (flow.inputs.length !== 1 || flow.inputs[0] !== name || flow.steps.length !== 1) return null;
  const [step] = flow.steps;
  const to = toOf(step!.to);
  const bare = !isObj(step!.when) || Object.keys(step!.when).length === 0;
  return bare && !step!.lane && !isObj(step!.params) && list(step!.do).length === 0 && (to.kind === "model" || to.kind === "peer") ? to : null;
}

/**
 * What becomes of a name no flow takes: every one runs as itself (`asked`), every one is turned
 * away (`refuse`), a flow with lines of its own decides (`rule`), or the draft has yet to say (`none`).
 */
export function restOf(doc: Doc): { mode: "asked" | "refuse" | "rule" | "none"; name: string | null } {
  const hit = Object.entries(obj(doc.flows)).find(([, f]) => list(obj(f).inputs).includes(ANY));
  if (!hit) return { mode: "none", name: null };
  const steps = (Array.isArray(obj(hit[1]).steps) ? (obj(hit[1]).steps as unknown[]) : []).map(obj);
  const to = steps.length === 1 && Object.keys(obj(steps[0]!.when)).length === 0 && list(steps[0]!.do).length === 0 ? toOf(steps[0]!.to) : null;
  return { mode: to?.kind === "asked" ? "asked" : to?.kind === "refuse" ? "refuse" : "rule", name: hit[0] };
}

/** Say what becomes of a name no flow takes: run as itself, or turned away. A flow that already decides it is replaced. */
export function withRest(doc: Doc, mode: "asked" | "refuse"): Doc {
  const { name } = restOf(doc);
  let id = name ?? "anything-else";
  if (name === null) for (let n = 2; isObj(obj(doc.flows)[id]); n++) id = `anything-else-${n}`;
  return put(doc, "flows", id, { inputs: [ANY], steps: [{ to: mode === "asked" ? { asked: true } : { refuse: "that is not something this node offers" } }] });
}

/**
 * Say where requests for `id` go. Its own model means "as itself": no flow at all where every
 * other name already runs as itself, else a flow that says so, since only what a flow takes is
 * offered. A rule means it enters that rule; anywhere else becomes a flow of its own named after it.
 */
export function routeId(doc: Doc, id: string, to: To): Doc {
  // Wherever it went before, it goes one way now.
  const flows = Object.fromEntries(Object.entries(obj(doc.flows))
    .filter(([name, f]) => !(name === id && directTo(name, { inputs: list(obj(f).inputs), steps: (Array.isArray(obj(f).steps) ? (obj(f).steps as unknown[]) : []).map(obj) }) !== null))
    .map(([name, f]) => [name, { ...obj(f), inputs: list(obj(f).inputs).filter((x) => x !== id) }]));
  const out: Doc = { ...doc, flows };
  if (to.kind === "model" && to.model === id && restOf(out).mode === "asked") return out;
  if (to.kind === "flow") return isObj(flows[to.flow]) ? put(out, "flows", to.flow, { ...flows[to.flow]!, inputs: [...list(flows[to.flow]!.inputs), id] }) : out;
  if (to.kind === "unset") return out;
  // A name already taken by another flow gets one beside it.
  let name = id;
  for (let n = 2; isObj(flows[name]); n++) name = `${id}-${n}`;
  return put(out, "flows", name, { inputs: [id], steps: [{ to: rawTo(to) }] });
}

/** A rule to start from: a common shape with its conditions in place and its destinations left to choose. */
export const TEMPLATES: { label: string; hint: string; name: string; steps: Doc[] }[] = [
  { label: "Borrow an idle model", hint: "use a bigger model while nobody else is", name: "borrow-idle", steps: [{ when: { idle: { ms: 300_000 }, ready: true }, to: "", max: 2 }, { to: "" }] },
  { label: "Use another model at certain hours", hint: "overnight, say, when nobody is waiting on it", name: "by-hour", steps: [{ when: { time: { from: "22:00", to: "06:00" } }, to: "" }, { to: "" }] },
  { label: "Send images somewhere else", hint: "requests with images go to a model that takes them", name: "images", steps: [{ when: { images: true }, to: "" }, { to: "" }] },
  { label: "Send long prompts somewhere else", hint: "past a size, use a model with more room", name: "long-prompts", steps: [{ when: { tokensOver: 8000 }, to: "" }, { to: "" }] },
  { label: "Stay off a busy model", hint: "use it while its queue is short, else another", name: "when-busy", steps: [{ when: { queuedUnder: 3 }, to: "" }, { to: "" }] },
  { label: "One caller gets its own model", hint: "by api key label", name: "per-caller", steps: [{ when: { caller: [] }, to: "" }, { to: "" }] },
];

/** A rule or an action taken out of the draft. An action goes from every line that ran it too, so the file still loads. */
export function removed(doc: Doc, section: "flows" | "actions", id: string): Doc {
  const gone = put(doc, section, id, undefined);
  if (section !== "actions") return gone;
  return linesRunning(gone, id).reduce<Doc>((d, [rule, i]) => withDo(d, rule, i, id, false) ?? d, gone);
}

/** What an action is told about a request: the `{name}`s its text may use. The last four are known once the request has ended. */
export const FACTS = ["asked", "model", "caller", "lane", "tokens", "images", "tools", "target", "peer", "flow", "line", "reason", "node", "action", "backend", "id", "outcome", "ms", "queuedMs", "ranMs", "error"];

/** The lines that run an action, as `[rule, line index]`. */
export const linesRunning = (doc: Doc, action: string): [string, number][] =>
  Object.entries(obj(doc.flows)).flatMap(([name, f]) => (Array.isArray(obj(f).steps) ? (obj(f).steps as unknown[]) : []).flatMap((s, i) => (list(obj(s).do).includes(action) ? [[name, i] as [string, number]] : [])));

/**
 * Give a rule or an action another name, and follow it everywhere it is named: a line that hands
 * work to the rule or runs the action, and where its box was placed. Null when the name is taken or empty.
 */
export function renamed(doc: Doc, section: "flows" | "actions", from: string, to: string): Doc | null {
  const all = obj(doc[section]);
  if (!to || to === from || to in all || !(from in all)) return null;
  const step = (s: Doc): Doc => (section === "flows"
    ? (isObj(s.to) && s.to.flow === from ? { ...s, to: { ...s.to, flow: to } } : s)
    : (list(s.do).includes(from) ? { ...s, do: list(s.do).map((a) => (a === from ? to : a)) } : s));
  const flows = Object.fromEntries(Object.entries(section === "flows" ? Object.fromEntries(Object.entries(all).map(([n, f]) => [n === from ? to : n, f])) : obj(doc.flows))
    .map(([n, f]) => [n, Array.isArray(obj(f).steps) ? { ...obj(f), steps: (obj(f).steps as unknown[]).map((s) => step(obj(s))) } : f]));
  const kind = section === "flows" ? "flow" : "action";
  const layout = Object.fromEntries(Object.entries(obj(doc.layout)).map(([id, at]) => [id === `routing/${kind}:${from}` ? `routing/${kind}:${to}` : id, at]));
  return {
    ...doc, flows,
    ...(section === "actions" ? { actions: Object.fromEntries(Object.entries(all).map(([n, a]) => [n === from ? to : n, a])) } : {}),
    ...(isObj(doc.layout) ? { layout } : {}),
  };
}

/** A rule or an action put in again under a free name, and that name. A copied rule takes no names: a name enters one rule. */
export function added(doc: Doc, section: "flows" | "actions", base: string, entry: Doc): { doc: Doc; name: string } {
  let name = `${base}-copy`;
  for (let n = 2; name in obj(doc[section]); n++) name = `${base}-copy-${n}`;
  return { doc: put(doc, section, name, section === "flows" ? { ...entry, inputs: [] } : entry), name };
}

/**
 * Give a type another name, and follow it everywhere it is named: the rule it enters, a line that
 * tests what was asked for, and its place in the list. Null when the name is taken or not one.
 */
export function retyped(doc: Doc, from: string, to: string): Doc | null {
  const flows = Object.entries(obj(doc.flows));
  if (!to || to === from || from === ANY || /[:*\s]/.test(to) || flows.some(([, f]) => list(obj(f).inputs).includes(to))) return null;
  const swap = (names: unknown) => list(names).map((n) => (n === from ? to : n));
  const when = (w: Doc): Doc => ({ ...w, ...(w.asked !== undefined ? { asked: swap(w.asked) } : {}), ...(w.askedNot !== undefined ? { askedNot: swap(w.askedNot) } : {}) });
  // A flow that only says where this one name runs is named after it, and stays so while that name is free.
  const key = (name: string, f: unknown) => (name === from && !(to in obj(doc.flows)) && directTo(name, { inputs: list(obj(f).inputs), steps: (Array.isArray(obj(f).steps) ? (obj(f).steps as unknown[]) : []).map(obj) }) ? to : name);
  const out: Doc = {
    ...doc,
    flows: Object.fromEntries(flows.map(([name, f]) => [key(name, f), {
      ...obj(f), inputs: swap(obj(f).inputs),
      ...(Array.isArray(obj(f).steps) ? { steps: (obj(f).steps as unknown[]).map((s) => (isObj(obj(s).when) ? { ...obj(s), when: when(obj(obj(s).when)) } : s)) } : {}),
    }])),
  };
  const rank = obj(doc.layout)[RANK + from];
  return rank === undefined ? out : put(put(out, "layout", RANK + from, undefined), "layout", RANK + to, rank);
}

/** Where a type sits in the Router's list is kept with the layout, as a rank in `y`. */
export const RANK = "routing/order:";

/** `names` in the order they were put in: ranked ones first by rank, then the rest as they come. */
export function ordered(layout: Record<string, { x: number; y: number }> | undefined, names: string[]): string[] {
  const rank = (n: string) => layout?.[RANK + n]?.y ?? Infinity;
  return names.map((n, i) => [n, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([n]) => n);
}

/** Move a type `by` places in the list `names`, which is the order they are shown in now. */
export function movedName(doc: Doc, names: string[], name: string, by: number): Doc {
  const i = names.indexOf(name);
  const j = i + by;
  if (i < 0 || j < 0 || j >= names.length) return doc;
  const next = names.map((n, k) => (k === i ? names[j]! : k === j ? names[i]! : n));
  return next.reduce<Doc>((d, n, k) => put(d, "layout", RANK + n, { x: 0, y: k }), doc);
}

/** Has a node been placed by hand? */
export const arranged = (doc: Doc): boolean => Object.keys(obj(doc.layout)).some((id) => !id.startsWith(RANK));

/** The draft with every node back where the automatic arrangement puts it; the order of the types is kept. */
export function tidied(doc: Doc): Doc {
  const kept = Object.fromEntries(Object.entries(obj(doc.layout)).filter(([id]) => id.startsWith(RANK)));
  const { layout: _, ...rest } = doc;
  return Object.keys(kept).length ? { ...rest, layout: kept } : rest;
}

/** Make step `i` of a flow run `action` when it decides, or stop it; null when that changes nothing. */
export function withDo(doc: Doc, flow: string, i: number, action: string, on: boolean): Doc | null {
  const step = stepsOf(doc, flow)?.[i];
  if (!step || list(step.do).includes(action) === on) return null;
  const doing = on ? [...list(step.do), action] : list(step.do).filter((a) => a !== action);
  return editStep(doc, flow, i, ({ do: _, ...s }) => (doing.length ? { ...s, do: doing } : s));
}

/** What a line can be let go on: somewhere to send work, or an action to run on the way. */
export type Landing = To | { kind: "action"; action: string };

/** An outlet a line is drawn from, as what it stands for in the file. */
export interface Outlet {
  /** What the line it belongs to tests, which wherever it is sent must be able to take. */
  when: Doc | null;
  /** The name it routes, for a name's own outlet. */
  name?: string;
  /** The rule it is part of. */
  rule?: string;
  /** Only somewhere work can run will do: a model or a peer. */
  endsOnly?: boolean;
  /** Its rule takes requests that are not chat. */
  paths?: boolean;
  /** The draft with this outlet sent to `to`; null when that changes nothing or cannot be. */
  send: (to: To) => Doc | null;
  /** The draft with `action` run from this outlet, where one can be. */
  also?: (action: string) => Doc | null;
}

/** How one kind of node on the routing map behaves. Every part is optional: a node that only shows something has none. */
export interface NodeKind {
  /** What a line let go on it means. */
  lands?: (id: string) => Landing;
  /** The outlet `handle` of it, for a line drawn from there. */
  outlet?: (doc: Doc, id: string, handle: string | null) => Outlet | null;
  /** What a click on it opens in the side panel. */
  opens?: (id: string) => { kind: "flow" | "action"; id: string };
}

/** `<rule>:<line>`, the id of a node that belongs to one line of a rule. */
const lineOf = (id: string) => ({ flow: id.slice(0, id.lastIndexOf(":")), step: Number(id.slice(id.lastIndexOf(":") + 1)) });

/** Every kind of node on the routing map, by the start of its id (`flow:<name>`, `model:<id>` and so on). */
export const NODES: Record<string, NodeKind> = {
  // This node: each name it answers to has an outlet, `ask-<name>`, that says where requests for it go.
  self: {
    outlet: (doc, _id, handle) => {
      const name = (handle ?? "").startsWith("ask-") ? handle!.slice(4) : "";
      return name === "" ? null : { when: null, name, send: (to) => routeId(doc, name, to) };
    },
  },
  // A rule: each line has an outlet, `step-<n>`.
  flow: {
    lands: (id) => ({ kind: "flow", flow: id }),
    opens: (id) => ({ kind: "flow", id }),
    outlet: (doc, id, handle) => {
      const i = Number(/^step-(\d+)/.exec(handle ?? "")?.[1] ?? NaN);
      const step = stepsOf(doc, id)?.[i];
      return step ? { when: obj(step.when), rule: id, paths: list(obj(obj(doc.flows)[id]).takes).length > 0, send: (to) => pointStep(doc, id, i, to), also: (a) => withDo(doc, id, i, a, true) } : null;
    },
  },
  // The fastest of several: an outlet per place, `end-<k>`, and any other handle adds a place.
  fastest: {
    opens: (id) => ({ kind: "flow", id: lineOf(id).flow }),
    outlet: (doc, id, handle) => {
      const { flow, step } = lineOf(id);
      const line = stepsOf(doc, flow)?.[step];
      const k = /^end-(\d+)/.exec(handle ?? "");
      return line ? { when: obj(line.when), endsOnly: true, paths: list(obj(obj(doc.flows)[flow]).takes).length > 0, send: (to) => pointEnd(doc, flow, step, k ? Number(k[1]) : null, to) } : null;
    },
  },
  refuse: { opens: (id) => ({ kind: "flow", id: lineOf(id).flow }) },
  model: { lands: (id) => ({ kind: "model", model: id }) },
  peer: { lands: (id) => ({ kind: "peer", peer: id, model: null }) },
  action: { lands: (id) => ({ kind: "action", action: id }), opens: (id) => ({ kind: "action", id }) },
};

/** A node on the routing map as its kind and the id within that kind. */
export function nodeOf(node: string): { kind: NodeKind; id: string } {
  const cut = node.indexOf(":");
  return { kind: NODES[cut < 0 ? node : node.slice(0, cut)] ?? {}, id: cut < 0 ? "" : node.slice(cut + 1) };
}

/** A node as the room it takes on the map. */
export type Box = { id: string; x: number; y: number; w: number; h: number };

/**
 * Where each box sits once none overlaps another: taken top to bottom, a box that would lie on one
 * above it moves down past it. `carry` names the boxes drawn beside another, which move with it.
 */
export function spread(boxes: Box[], carry: Map<string, string[]> = new Map(), gap = 12): Map<string, number> {
  const ys = new Map(boxes.map((b) => [b.id, b.y]));
  const settled: Box[] = [];
  for (const b of [...boxes].sort((p, q) => p.y - q.y)) {
    let y = ys.get(b.id)!;
    for (let hit; (hit = settled.find((s) => b.x < s.x + s.w + gap && s.x < b.x + b.w + gap && y < s.y + s.h + gap && s.y < y + b.h + gap));) y = hit.y + hit.h + gap;
    const by = y - ys.get(b.id)!;
    if (by !== 0) for (const rider of carry.get(b.id) ?? []) if (!settled.some((s) => s.id === rider)) ys.set(rider, (ys.get(rider) ?? 0) + by);
    ys.set(b.id, y);
    settled.push({ ...b, y });
  }
  return ys;
}

/**
 * Where each of `ends` sits in its column: beside the middle of the lines that reach it, in that
 * order, `step` apart at least, so lines run across and seldom cross. `from` is where each line leaves.
 */
export function beside(ends: string[], from: (end: string) => number[], step: number): Map<string, number> {
  const mid = (id: string) => { const ys = from(id); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity; };
  const out = new Map<string, number>();
  let next = 0;
  for (const [id, y] of ends.map((id) => [id, mid(id)] as const).sort((a, b) => a[1] - b[1])) {
    const at = Math.max(next, Number.isFinite(y) ? Math.round(y - step / 2) : next);
    out.set(id, at);
    next = at + step;
  }
  return out;
}

/** Remember where a node was put, to the pixel: a layout is a picture, not a measurement. */
export const placed = (doc: Doc, id: string, at: { x: number; y: number }): Doc =>
  put(doc, "layout", id, { x: Math.round(at.x), y: Math.round(at.y) });

const at = (doc: unknown, path: (string | number)[]): unknown => path.reduce<unknown>((cur, k) => (cur as Record<string | number, unknown> | undefined)?.[k], doc);

/** `doc` with `ops` applied, sharing everything they do not touch. */
export function applyOps(doc: Doc, ops: Op[]): Doc {
  const set = (cur: unknown, path: (string | number)[], op: Op): unknown => {
    const [k, ...rest] = path;
    if (Array.isArray(cur)) {
      const next = [...cur];
      if (rest.length === 0 && op.delete) next.splice(k as number, 1);
      else next[k as number] = rest.length === 0 ? op.value : set(next[k as number], rest, op);
      return next;
    }
    const { [k as string]: mine, ...others } = obj(cur);
    if (rest.length === 0) return op.delete ? others : { ...obj(cur), [k as string]: op.value };
    return { ...obj(cur), [k as string]: set(mine, rest, op) };
  };
  return ops.reduce<Doc>((d, op) => set(d, op.path, op) as Doc, doc);
}

/**
 * Carry a draft made on `base` over to `fresh`, the file as it is now. Null when both changed
 * the same setting, named in `clash`: one of them has to give way, and that is a person's call.
 */
export function rebase(base: Doc, draft: Doc, fresh: Doc): { doc: Doc } | { clash: string } {
  const ops = opsOf(base, draft);
  // A setting the file already has as the draft wants it is no clash: that is the draft's own save, read back.
  const wants = (op: Op) => JSON.stringify(op.delete ? undefined : op.value);
  const hit = ops.find((op) => JSON.stringify(at(base, op.path)) !== JSON.stringify(at(fresh, op.path)) && JSON.stringify(at(fresh, op.path)) !== wants(op));
  return hit ? { clash: hit.path.slice(0, 2).join(".") } : { doc: applyOps(fresh, ops) };
}

/** What can be known, while a line is being drawn, about a name and about a place a line could send work. */
export interface Facts {
  /**
   * How requests for a name arrive: as `chat`, which routing decides, or on its backend's own
   * `paths` (image generation and the like), which routing never sees.
   */
  kind: (name: string) => "chat" | "paths";
  /** What a model here, or a peer's copy of one, is known to take; null when nothing has said. */
  stats: (end: End) => { context?: number; vision?: boolean; tools?: boolean } | null;
}

/** What the draft and the running node say between them. A name nothing serves is chat: a rule answers for it. */
export function factsOf(doc: Doc, live: UiData): Facts {
  const self = live.net.nodes.find((n) => n.self);
  const backends = Object.entries(obj(doc.backends));
  const owner = (name: string): string | undefined => {
    const wire = text(obj(obj(doc.models)[name]).as) || name;
    // A path with no name in it is answered by the model its route names, which need not be in `serves`.
    const routed = (b: unknown) => (Array.isArray(obj(b).routes) ? (obj(b).routes as unknown[]) : []).some((r) => text(obj(r).model) === wire);
    return text(obj(obj(doc.models)[name]).backend) || backends.find(([, b]) => list(obj(b).serves).includes(wire) || routed(b))?.[0]
      || live.routing?.[name]?.backend || (self?.backends ?? []).find((b) => (b.serves ?? []).includes(wire))?.name;
  };
  // A backend that declares paths of its own answers its models on those, not as chat.
  const paths = (backend: string) => (Array.isArray(obj(obj(doc.backends)[backend]).routes) ? (obj(obj(doc.backends)[backend]).routes as unknown[]).length : (self?.backends ?? []).find((b) => b.name === backend)?.routes?.length ?? 0) > 0;
  return {
    kind: (name) => { const on = owner(name); return on !== undefined && paths(on) ? "paths" : "chat"; },
    stats: (end) => {
      if (end.kind === "peer") return (end.model && live.net.nodes.find((n) => !n.self && n.name === end.peer)?.stats?.[end.model]) || null;
      const declared = obj(obj(obj(doc.models)[end.model]).stats);
      const seen = self?.stats?.[end.model];
      return seen || Object.keys(declared).length ? { ...(declared as object), ...seen } : null;
    },
  };
}

/**
 * Why a line that tests `when` cannot send work to `to`, or null when nothing known rules it out.
 * Only what is known counts: a model nobody has described is not refused.
 */
export function refusal(when: Doc | null | undefined, to: To, facts: Facts, paths = false): string | null {
  const ends: End[] = to.kind === "fastest" ? to.of : to.kind === "model" || to.kind === "peer" ? [to] : [];
  for (const end of ends) {
    const name = end.kind === "peer" ? `${end.model ?? "the model"} on ${end.peer}` : end.model;
    // `paths`: the rule takes requests that are not chat, so what it sends them to must answer those and not chat.
    if (paths && end.kind === "peer") return `This rule takes requests that are not chat, and a peer is only ever sent chat.`;
    if (paths && end.kind === "model" && facts.kind(end.model) === "chat") return `This rule takes requests that are not chat, and ${end.model} answers chat.`;
    if (paths) continue;
    if (end.kind === "model" && facts.kind(end.model) === "paths") {
      return `${end.model} is not a chat model: its backend answers it on paths of its own (image generation and the like), so a chat request cannot run as it. Give the rule the path it takes to route those.`;
    }
    const s = facts.stats(end);
    if (!s) continue;
    if (obj(when).images === true && s.vision === false) return `This line is for requests with images, and ${name} does not take images.`;
    if (obj(when).tools === true && s.tools === false) return `This line is for requests that use tools, and ${name} does not take tools.`;
    const over = obj(when).tokensOver;
    if (typeof over === "number" && typeof s.context === "number" && s.context <= over) return `This line is for prompts over ${over} tokens, and ${name} holds ${s.context}.`;
  }
  return null;
}

/** Does a line test something its target has not said whether it can take? Then the line stands, but unchecked. */
export function unchecked(when: Doc | null | undefined, to: To, facts: Facts): boolean {
  const w = obj(when);
  if (w.images !== true && w.tools !== true && typeof w.tokensOver !== "number") return false;
  const ends: End[] = to.kind === "fastest" ? to.of : to.kind === "model" || to.kind === "peer" ? [to] : [];
  return ends.some((end) => {
    const s = facts.stats(end);
    return !s || (w.images === true && s.vision === undefined) || (w.tools === true && s.tools === undefined) || (typeof w.tokensOver === "number" && s.context === undefined);
  });
}

/** What is wrong with a draft that a person can fix, said before the file refuses it. */
export function problems(doc: Doc, facts?: Facts): string[] {
  const out: string[] = [];
  const flows = Object.entries(obj(doc.flows)).map(([name, f]) => ({ name, inputs: list(obj(f).inputs), paths: list(obj(f).takes).length > 0, steps: (Array.isArray(obj(f).steps) ? (obj(f).steps as unknown[]) : []).map(obj) }));
  if (restOf(doc).mode === "none") out.push(`Say what happens to a name no type takes: on the Router, choose "run it as itself" or "refuse it". The file does not load without one.`);
  for (const f of flows) {
    const fed = f.inputs.length > 0 || flows.some((o) => o.steps.some((s) => { const to = toOf(s.to); return to.kind === "flow" && to.flow === f.name; }));
    if (!fed) out.push(`Nothing reaches the rule "${f.name}" yet: drag a model name onto it, or it does nothing.`);
    f.steps.forEach((s, i) => {
      const last = i === f.steps.length - 1;
      const to = toOf(s.to);
      // A condition changed after the line was drawn can leave it pointing somewhere that cannot take it.
      const no = facts ? refusal(obj(s.when), to, facts, f.paths) : null;
      if (no) out.push(`Rule "${f.name}", ${last ? "the Otherwise line" : `line ${i + 1}`}: ${no}`);
      if (to.kind === "unset") out.push(`Rule "${f.name}", ${last ? "the Otherwise line" : `line ${i + 1}`}: choose where it sends requests.`);
      else if (!last && to.kind !== "peer" && typeof s.max !== "number" && Object.keys(obj(s.when)).length === 0) out.push(`Rule "${f.name}", line ${i + 1}: choose a condition, or the lines after it are never reached.`);
      for (const a of list(s.do)) if (!isObj(obj(doc.actions)[a])) out.push(`Rule "${f.name}", ${last ? "the Otherwise line" : `line ${i + 1}`}: it runs the action "${a}", which is gone.`);
    });
  }
  for (const [name, a] of Object.entries(obj(doc.actions))) {
    const kind = ACTIONS.find((k) => k.key in obj(a));
    if (!kind || !text(obj(a)[kind.key])) out.push(`The action "${name}" needs ${kind?.key === "call" ? "the URL to call" : "something to do"}.`);
    if (kind && ACTIONS.some((k) => k !== kind && k.key in obj(a))) out.push(`The action "${name}" is two kinds at once: keep ${kind.key}, or the other, not both.`);
    // Asking how long it took is itself a reason to wait for the end.
    const waits = obj(a).on === "finished" || obj(a).on === "failed" || (typeof obj(a).slowerThan === "number" && obj(a).on === undefined);
    if (typeof obj(a).slowerThan === "number" && !waits) out.push(`The action "${name}" has "slowerThan", which is only known once a request has ended: set "on" to finished or failed.`);
    // A name in braces that is not something an action is told would be written out as typed.
    const wild = [...JSON.stringify([obj(a).log, obj(a).body]).matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((w) => !FACTS.includes(w));
    if (wild.length) out.push(`The action "${name}" uses {${wild[0]}}, which is not something it is told: it would be written out as typed. How long a request took is {ms}, with "on" set to finished.`);
    else if (!waits && /\{(ms|queuedMs|ranMs|outcome|error)\}/.test(JSON.stringify([obj(a).log, obj(a).body]))) out.push(`The action "${name}" uses how the request ended, which is only known with "on" set to finished or failed.`);
  }
  for (const [name, s] of Object.entries(obj(doc.servers))) if (!text(obj(s).host)) out.push(`The server "${name}" needs its address (host).`);
  // One card is in one machine.
  const on = new Map<string, Set<string>>();
  for (const b of Object.values(obj(doc.backends))) {
    for (const r of list(obj(b).resources)) {
      if (obj(obj(doc.resources)[r]).shared === true) continue;
      on.set(r, (on.get(r) ?? new Set()).add(text(obj(b).server) || "this machine"));
    }
  }
  for (const [r, where] of on) if (where.size > 1) out.push(`The hardware "${r}" is used on ${[...where].join(" and ")}: a card is in one machine, so give the other its own name.`);
  return out;
}

/** What the draft changes, as path ops, so untouched keys and their comments stay as they are. */
export function opsOf(from: Doc, to: Doc): Op[] {
  const ops: Op[] = [];
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (!(k in to)) ops.push({ path: [k], delete: true });
    else ops.push(...opsBetween(from[k], to[k], [k]));
  }
  return ops;
}
