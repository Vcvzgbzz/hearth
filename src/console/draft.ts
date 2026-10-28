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
      // The draft says whether it is a provider's; what the node reports of one it runs is kept only while it still is.
      cloud: obj(b).cloud === true, ...(obj(b).cloud === true ? {} : { trouble: undefined }),
    };
  });
  const peers: NetNode[] = Object.entries(obj(doc.peers)).map(([name, p]) =>
    // What a peer lends is the draft's to say, whether or not the peer has been heard from: a link is drawn the same either way.
    ({ up: false, free: null, slots: null, queued: null, ...live.net.nodes.find((n) => !n.self && n.name === name), name, map: obj(obj(p).models) as Record<string, string> }));
  // What holds a card right now is the running node's to say; what the card is, the draft's.
  const resources: Resource[] = Object.entries(obj(doc.resources)).map(([name, r]) => ({
    holder: null, backends: [], ...(live.net.resources ?? []).find((x) => x.name === name),
    name, kind: (text(obj(r).kind) || "gpu") as Resource["kind"], shared: obj(r).shared === true,
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
export function directTo(name: string, flow: { inputs: string[]; steps: { when?: unknown; to?: unknown; lane?: unknown; params?: unknown; do?: unknown; plugins?: unknown }[] }): End | null {
  if (flow.inputs.length !== 1 || flow.inputs[0] !== name || flow.steps.length !== 1) return null;
  const [step] = flow.steps;
  const to = toOf(step!.to);
  const bare = !isObj(step!.when) || Object.keys(step!.when).length === 0;
  return bare && !step!.lane && !isObj(step!.params) && list(step!.do).length === 0 && placedOn(step!).length === 0 && (to.kind === "model" || to.kind === "peer") ? to : null;
}

/**
 * A flow that is only an order to try places in: no name enters it and no line of it tests
 * anything, so each line is where the request goes when the one above fails. The canvas draws it
 * as a node beside the first line that hands to it, not as a rule.
 */
export function orderOf(flow: { inputs: string[]; off?: boolean; sticky?: number; steps: { when?: unknown; to?: unknown; lane?: unknown; params?: unknown; do?: unknown; max?: unknown; plugins?: unknown }[] }): End[] | null {
  if (flow.inputs.length !== 0 || flow.steps.length < 2 || flow.off === true || flow.sticky !== undefined) return null;
  const ends: End[] = [];
  for (const s of flow.steps) {
    const to = toOf(s.to);
    const bare = (!isObj(s.when) || Object.keys(s.when).length === 0) && !s.lane && !isObj(s.params) && list(s.do).length === 0 && s.max === undefined && placedOn(s).length === 0;
    if (!bare || (to.kind !== "model" && to.kind !== "peer")) return null;
    ends.push(to);
  }
  return ends;
}

/**
 * Give step `i` of a flow somewhere to go when the place it sends work fails: the line hands to an
 * order of its own, the place it named first and `to` after it. Null when the line names no one place.
 */
export function thenTry(doc: Doc, flow: string, i: number, to: To): Doc | null {
  const steps = stepsOf(doc, flow);
  const first = steps?.[i] ? toOf(steps[i]!.to) : null;
  if (!steps || !first || (first.kind !== "model" && first.kind !== "peer") || (to.kind !== "model" && to.kind !== "peer")) return null;
  if (JSON.stringify(rawTo(first)) === JSON.stringify(rawTo(to))) return null;
  const base = `${first.kind === "model" ? first.model : first.model ?? first.peer}-then`;
  let name = base;
  for (let n = 2; isObj(obj(doc.flows)[name]); n++) name = `${base}-${n}`;
  // An order answers the same requests as the rule that hands to it.
  const takes = list(obj(obj(doc.flows)[flow]).takes);
  const made = put(doc, "flows", name, { inputs: [], ...(takes.length ? { takes } : {}), steps: [{ to: rawTo(first) }, { to: rawTo(to) }] });
  return withSteps(made, flow, steps.map((s, k) => (k === i ? { ...s, to: { flow: name } } : s)));
}

/** Add a place to the end of an order. */
export function addPlace(doc: Doc, order: string, to: To): Doc | null {
  const steps = stepsOf(doc, order);
  return steps && (to.kind === "model" || to.kind === "peer") ? withSteps(doc, order, [...steps, { to: rawTo(to) }]) : null;
}

/** Try place `k` of an order one place sooner. */
export function raisePlace(doc: Doc, order: string, k: number): Doc {
  const steps = stepsOf(doc, order);
  if (!steps || k < 1 || !steps[k]) return doc;
  return withSteps(doc, order, steps.map((s, n) => (n === k - 1 ? steps[k]! : n === k ? steps[k - 1]! : s)));
}

/**
 * Take place `k` out of an order. With one place left there is nothing to fall back to, so the
 * order goes too and every line that handed to it names that place again.
 */
export function dropPlace(doc: Doc, order: string, k: number): Doc {
  const steps = stepsOf(doc, order);
  if (!steps || !steps[k]) return doc;
  const left = steps.filter((_, n) => n !== k);
  if (left.length > 1) return withSteps(doc, order, left);
  const flows = Object.fromEntries(Object.entries(obj(doc.flows)).filter(([name]) => name !== order).map(([name, f]) => [name, Array.isArray(obj(f).steps)
    ? { ...obj(f), steps: (obj(f).steps as unknown[]).map((s) => (isObj(obj(s).to) && (obj(s).to as Doc).flow === order ? { ...obj(s), to: left[0]!.to } : s)) } : f]));
  return { ...doc, flows };
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

/**
 * Send a name straight to a model that is not chat: a flow of its own that takes the paths that
 * model answers on, which is what makes the name callable there.
 */
export function routeTyped(doc: Doc, id: string, model: string, takes: string[]): Doc {
  const sent = routeId(doc, id, { kind: "model", model });
  const hit = Object.entries(obj(sent.flows)).find(([, f]) => list(obj(f).inputs).length === 1 && list(obj(f).inputs)[0] === id);
  return hit && takes.length ? put(sent, "flows", hit[0], { takes, ...obj(hit[1]) }) : sent;
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
  // An order taken out leaves its first place behind: every line that handed to it goes straight there.
  const steps = section === "flows" ? stepsOf(doc, id) : null;
  if (steps && orderOf({ ...obj(obj(doc.flows)[id]), inputs: list(obj(obj(doc.flows)[id]).inputs), steps })) return steps.slice(1).reduce<Doc>((d) => dropPlace(d, id, 1), doc);
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
  // A rule drawn as an order was placed under that node's id, and keeps its place the same way.
  const moved = (id: string) => (id === `routing/${kind}:${from}` ? `routing/${kind}:${to}` : section === "flows" && id === `routing/inorder:${from}` ? `routing/inorder:${to}` : id);
  const layout = Object.fromEntries(Object.entries(obj(doc.layout)).map(([id, at]) => [moved(id), at]));
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

/** Where the callers of a router stand among the others in the topology, kept the same way; the default router's are `default`. */
export const BAYS = "topology/order:";

/** Where a backend stands among the others in the hardware it uses, kept the same way, by backend name. */
export const STACK = "topology/backend:";

const isOrder = (id: string): boolean => id.startsWith(RANK) || id.startsWith(BAYS) || id.startsWith(STACK);

/** `names` in the order they were put in: ranked ones first by rank, then the rest as they come. `under` is whose order it is. */
export function ordered(layout: Record<string, { x: number; y: number }> | undefined, names: string[], under = RANK): string[] {
  const rank = (n: string) => layout?.[under + n]?.y ?? Infinity;
  return names.map((n, i) => [n, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([n]) => n);
}

/**
 * Put `name` where it was let go among `names`, the order they stand in now: after every other whose
 * middle (`middles`, by name) `x` has passed. Let go where it already stands, nothing changes.
 */
export function movedBay(doc: Doc, names: string[], name: string, x: number, middles: Record<string, number>): Doc {
  const next = names.filter((n) => n !== name);
  next.splice(next.filter((n) => (middles[n] ?? Infinity) < x).length, 0, name);
  if (!names.includes(name) || next.every((n, i) => n === names[i])) return doc;
  return next.reduce<Doc>((d, n, k) => put(d, "layout", BAYS + n, { x: 0, y: k }), doc);
}

/**
 * Hardware put on another machine: the backends on machine `from` ("" for this one) that use it go to
 * `to` with it, and so does any other card they use, as one card cannot be on two machines. Shared
 * hardware can, so only the backends that sit in it go. One reached by `port` alone that comes to this
 * machine is given a loopback url, as a port needs a server.
 */
export function movedHardware(doc: Doc, resource: string, from: string, to: string): Doc {
  if (from === to) return doc;
  const shared = (r: string) => obj(obj(doc.resources)[r]).shared === true;
  const here = Object.entries(obj(doc.backends)).filter(([, b]) => obj(b).cloud !== true && text(obj(b).server) === from).map(([name, b]) => ({ name, had: list(obj(b).resources) }));
  const going = new Set(here.filter((b) => (shared(resource) ? (b.had.find((r) => !shared(r)) ?? b.had[0]) === resource : b.had.includes(resource))).map((b) => b.name));
  // A card one of them uses goes too, and every backend here that uses it, until no card is left on both sides.
  for (let more = true; more;) {
    const cards = new Set(here.filter((b) => going.has(b.name)).flatMap((b) => b.had.filter((r) => !shared(r))));
    const next = here.filter((b) => !going.has(b.name) && b.had.some((r) => cards.has(r)));
    next.forEach((b) => going.add(b.name));
    more = next.length > 0;
  }
  return [...going].reduce<Doc>((d, name) => {
    const { server: _, port, ...rest } = obj(obj(d.backends)[name]);
    const local = to === "" && rest.url === undefined && port !== undefined;
    return put(d, "backends", name, { ...rest, ...(local ? { url: `http://127.0.0.1:${String(port)}` } : port !== undefined ? { port } : {}), ...(to ? { server: to } : {}) });
  }, doc);
}

/**
 * Put backend `name` `at` that place among the others in `names`, the order its hardware shows them in
 * now (0 is first). Put where it already stands, nothing changes.
 */
export function restacked(doc: Doc, names: string[], name: string, at: number): Doc {
  const next = names.filter((n) => n !== name);
  next.splice(Math.max(0, Math.min(at, next.length)), 0, name);
  if (!names.includes(name) || next.every((n, i) => n === names[i])) return doc;
  return next.reduce<Doc>((d, n, k) => put(d, "layout", STACK + n, { x: 0, y: k }), doc);
}

/** A backend's place among the others in its hardware forgotten, so wherever it goes it stands after those placed there. */
export const unstacked = (doc: Doc, name: string): Doc => (STACK + name in obj(doc.layout) ? put(doc, "layout", STACK + name, undefined) : doc);

/** Move a type `by` places in the list `names`, which is the order they are shown in now. */
export function movedName(doc: Doc, names: string[], name: string, by: number): Doc {
  const i = names.indexOf(name);
  const j = i + by;
  if (i < 0 || j < 0 || j >= names.length) return doc;
  const next = names.filter((n) => n !== name);
  next.splice(j, 0, name);
  return next.reduce<Doc>((d, n, k) => put(d, "layout", RANK + n, { x: 0, y: k }), doc);
}

/** Has a node been placed by hand? */
export const arranged = (doc: Doc): boolean => Object.keys(obj(doc.layout)).some((id) => !isOrder(id));

/** The draft with every node back where the automatic arrangement puts it; the orders things were put in are kept. */
export function tidied(doc: Doc): Doc {
  const kept = Object.fromEntries(Object.entries(obj(doc.layout)).filter(([id]) => isOrder(id)));
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

/** A plugin placed on a step, as the file writes it: its name, or `{ use, models }` with the models this line wires. */
export type Placed = { name: string; models: Record<string, string> };

/** The plugins a step places, in the order they run: as the file writes them, or as the node reports them (`{ name, models }`). */
export function placedOn(step: { plugins?: unknown }): Placed[] {
  if (!Array.isArray(step.plugins)) return [];
  return step.plugins.flatMap((p): Placed[] => {
    if (typeof p === "string") return [{ name: p, models: {} }];
    const o = obj(p);
    const name = typeof o.use === "string" ? o.use : typeof o.name === "string" ? o.name : null;
    return name === null ? [] : [{ name, models: Object.fromEntries(Object.entries(obj(o.models)).filter((e): e is [string, string] => typeof e[1] === "string")) }];
  });
}

/** A step with these plugins on it, each written in its shortest form; none takes the key away. */
const withPlaced = (doc: Doc, flow: string, i: number, placed: Placed[]): Doc =>
  editStep(doc, flow, i, ({ plugins: _, ...s }) => (placed.length ? { ...s, plugins: placed.map((p) => (Object.keys(p.models).length ? { use: p.name, models: p.models } : p.name)) } : s));

/** Put a plugin on a line, last in its order, or take it off. Null when there is nothing to change. */
export function withPlugin(doc: Doc, flow: string, i: number, plugin: string, on: boolean): Doc | null {
  const step = stepsOf(doc, flow)?.[i];
  if (!step) return null;
  const placed = placedOn(step);
  if (placed.some((p) => p.name === plugin) === on) return null;
  return withPlaced(doc, flow, i, on ? [...placed, { name: plugin, models: {} }] : placed.filter((p) => p.name !== plugin));
}

/** Run a plugin earlier (-1) or later (1) on its line. */
export function movePlugin(doc: Doc, flow: string, i: number, plugin: string, by: -1 | 1): Doc | null {
  const step = stepsOf(doc, flow)?.[i];
  if (!step) return null;
  const placed = placedOn(step);
  const at = placed.findIndex((p) => p.name === plugin);
  const to = at + by;
  if (at < 0 || to < 0 || to >= placed.length) return null;
  [placed[at], placed[to]] = [placed[to]!, placed[at]!];
  return withPlaced(doc, flow, i, placed);
}

/** Wire a model into one of a placed plugin's slots on this line; null goes back to the plugin's own. */
export function wireSlot(doc: Doc, flow: string, i: number, plugin: string, slot: string, model: string | null): Doc | null {
  const step = stepsOf(doc, flow)?.[i];
  if (!step) return null;
  const placed = placedOn(step).map((p) => {
    if (p.name !== plugin) return p;
    const { [slot]: _, ...rest } = p.models;
    return { ...p, models: model === null ? rest : { ...rest, [slot]: model } };
  });
  return withPlaced(doc, flow, i, placed);
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
      // `step-<n>-then`: not where the line goes, but where it goes next when that fails.
      if (step && /^step-\d+-then$/.test(handle ?? "")) return { when: obj(step.when), endsOnly: true, paths: list(obj(obj(doc.flows)[id]).takes).length > 0, send: (to) => thenTry(doc, id, i, to) };
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
  // An order to try places in: an outlet per place, `end-<k>`, and any other handle adds a place after the last.
  // Its id is not `order:`, which is where the layout keeps the order of the types (RANK).
  inorder: {
    lands: (id) => ({ kind: "flow", flow: id }),
    opens: (id) => ({ kind: "flow", id }),
    outlet: (doc, id, handle) => {
      const k = /^end-(\d+)/.exec(handle ?? "");
      return stepsOf(doc, id) ? { when: null, endsOnly: true, paths: list(obj(obj(doc.flows)[id]).takes).length > 0, send: (to) => (to.kind !== "model" && to.kind !== "peer" ? null : k ? pointStep(doc, id, Number(k[1]), to) : addPlace(doc, id, to)) } : null;
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
 * `gap` is how near two may come before they count as overlapping: none, so boxes that only
 * touch stay where they were put.
 */
export function spread(boxes: Box[], carry: Map<string, string[]> = new Map(), gap = 0): Map<string, number> {
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

/**
 * The room a box of `callers` chips takes: `cols` across at most, and never narrower than `least`, the
 * card that stands under its middle, so the cards under boxes set side by side do not lie on each other.
 * `inset` is where the first chip starts, which keeps a row narrower than the box in its middle.
 */
export function bayRoom(callers: number, chip: { w: number; h: number; gap: number; cols: number }, edge: { head: number; pad: number }, least: number): { cols: number; w: number; h: number; inset: number } {
  const cols = Math.min(chip.cols, callers);
  const row = cols * (chip.w + chip.gap) - chip.gap;
  const w = Math.max(row + edge.pad * 2, least);
  return { cols, w, h: edge.head + Math.ceil(callers / cols) * (chip.h + chip.gap) - chip.gap + edge.pad, inset: (w - row) / 2 };
}

/**
 * A draft as one router's rulebook: its flows stand as `flows`, and its map has places of its own
 * (kept as `routing@<router>/...`). With `null` the draft is its own view: the rules everyone else goes by.
 */
export function scoped(doc: Doc, router: string | null): Doc {
  if (router === null) return doc;
  const pre = `routing@${router}/`;
  const layout = Object.fromEntries(Object.entries(obj(doc.layout)).flatMap(([id, at]) =>
    (id.startsWith(pre) ? [[`routing/${id.slice(pre.length)}`, at]] : id.startsWith("routing/") ? [] : [[id, at]])));
  return { ...doc, flows: obj(obj(obj(doc.routers)[router]).flows), ...(isObj(doc.layout) ? { layout } : {}) };
}

/** The whole draft again, from one router's view of it and `whole`, the draft that view was taken of. */
export function unscoped(view: Doc, whole: Doc, router: string | null): Doc {
  if (router === null) return view;
  const pre = `routing@${router}/`;
  const layout = {
    ...Object.fromEntries(Object.entries(obj(whole.layout)).filter(([id]) => id.startsWith("routing/"))),
    ...Object.fromEntries(Object.entries(obj(view.layout)).map(([id, at]) => [id.startsWith("routing/") ? pre + id.slice(8) : id, at])),
  };
  const { layout: _, ...rest } = view;
  return {
    ...rest, flows: whole.flows,
    routers: { ...obj(view.routers), [router]: { ...obj(obj(view.routers)[router]), flows: view.flows } },
    ...(Object.keys(layout).length ? { layout } : {}),
  };
}

/**
 * `full` with a new router `name` whose rules are the ones `view` shows, and whose map is drawn
 * as that one's is: each place `view` keeps as `routing/...` is kept again as `routing@<name>/...`.
 */
export function copiedRouter(view: Doc, full: Doc, name: string): Doc {
  const pre = `routing@${name}/`;
  const layout = {
    ...Object.fromEntries(Object.entries(obj(full.layout)).filter(([id]) => !id.startsWith(pre))),
    ...Object.fromEntries(Object.entries(obj(view.layout)).flatMap(([id, at]) => (id.startsWith("routing/") ? [[pre + id.slice(8), at]] : []))),
  };
  const { layout: _, ...rest } = put(full, "routers", name, { flows: view.flows });
  return { ...rest, ...(Object.keys(layout).length ? { layout } : {}) };
}

/** The caller that stands for everyone `callers:` does not name. */
export const EVERYONE = "*";

/** Who can be given a router: everyone else as one, whoever calls from this machine without a key, and each api key by its label. */
export const callersIn = (doc: Doc): string[] =>
  [EVERYONE, "local", ...(Array.isArray(doc.apiKeys) ? doc.apiKeys : []).map((k) => text(obj(k).label)).filter(Boolean)];

/** A row of one of the topology's menus: what it says, what choosing it means, and how it is drawn. */
export type CallerChoice = { label: string; value?: string; aside?: string; icon?: "plus" | "rotate" | "bin"; head?: boolean; on?: boolean; danger?: boolean; mono?: boolean };

/**
 * The menu for a right-click among the callers. On one of them: which router its requests go by,
 * with the one in force marked, and for a key what can be done with the key. On none (`null`),
 * the frame they stand in: only what adds one. A heading with no label is a rule between groups.
 */
export function callerChoices(doc: Doc | null, id: string | null): CallerChoice[] {
  const key = id !== null && id !== EVERYONE && id !== "local";
  const at = doc && id !== null ? routerFor(doc, id) : null;
  return [
    ...(at && id !== null ? [
      { label: `${id === EVERYONE ? "everyone else" : id} goes by`, head: true },
      { label: "The default router", value: "to:", on: at.own && at.router === null },
      ...Object.keys(obj(doc!.routers)).map((r) => ({ label: r, value: `to:${r}`, mono: true, on: at.own && at.router === r })),
      // Everyone else is who the others follow, so it cannot follow.
      ...(id === EVERYONE ? [] : [{ label: "Wherever everyone else goes", value: "follow", on: !at.own, aside: "moves with them" }]),
      { label: "A new router…", value: "new-router", icon: "plus" as const },
      { label: "", head: true },
    ] : []),
    ...(key ? [
      { label: "its key", head: true },
      { label: "Rotate…", value: "rotate", icon: "rotate" as const, aside: "a new secret, shown once" },
      { label: "Revoke", value: "revoke", icon: "bin" as const, danger: true, aside: "stops working at once" },
      { label: "", head: true },
    ] : []),
    ...(id === null ? [{ label: "callers", head: true }] : []),
    { label: "New key…", value: "mint", icon: "plus" as const },
  ];
}

/**
 * The menu for a right-click on the empty part of the topology: everything the strip over the picture
 * adds, by the section it joins (`add:<section>`), a provider, the published versions, and the view.
 */
export function paneChoices(kinds: { section: string; noun: string }[]): CallerChoice[] {
  return [
    { label: "add", head: true },
    ...kinds.map((k) => ({ label: `New ${k.noun}…`, value: `add:${k.section}`, icon: "plus" as const })),
    { label: "New provider…", value: "provider", icon: "plus" as const, aside: "an API on the internet" },
    { label: "", head: true },
    { label: "Versions…", value: "versions", aside: "published, and the way back" },
    { label: "Fit everything in view", value: "fit" },
  ];
}

/** The router a caller goes by, null for the default one. `own` is false where it only goes where everyone else does. */
export function routerFor(doc: Doc, caller: string): { router: string | null; own: boolean } {
  const given = text(obj(doc.callers)[caller]);
  const name = given || text(obj(doc.callers)[EVERYONE]);
  return { router: name && name !== "default" ? name : null, own: caller === EVERYONE || given !== "" };
}

/** The callers that go by a router (null: the default one), those that only follow everyone else included. */
export const usersOf = (doc: Doc, router: string | null): string[] => callersIn(doc).filter((c) => routerFor(doc, c).router === router);

/**
 * Send a caller's requests by a router, or with null by the default one. A caller sent where
 * everyone else goes follows them from then on; one sent elsewhere stays there when they move.
 */
export function withCaller(doc: Doc, caller: string, router: string | null): Doc {
  const { [caller]: _, ...kept } = obj(doc.callers);
  const to = router ?? "default";
  const rest = text(kept[EVERYONE]) || "default";
  if (caller === EVERYONE ? to !== "default" : to !== rest) kept[caller] = to;
  const { callers: _c, ...others } = doc;
  return Object.keys(kept).length ? { ...others, callers: kept } : others;
}

/** Stop saying where a caller goes, so it goes where everyone else does. */
export function followed(doc: Doc, caller: string): Doc {
  const { [caller]: _, ...kept } = obj(doc.callers);
  const { callers: _c, ...others } = doc;
  return Object.keys(kept).length ? { ...others, callers: kept } : others;
}

const NOUN: Record<string, string> = { backends: "backend", resources: "hardware", servers: "machine", flows: "rule", routers: "router", models: "model", actions: "action", peers: "peer" };

/** What a draft changes, in the words the map uses: one line per thing added, removed or changed. */
export function summary(from: Doc, to: Doc): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (same(from[key], to[key])) continue;
    if (key === "layout") { out.push("where things are placed on the maps"); continue; }
    if (key === "callers") {
      for (const c of new Set([...Object.keys(obj(from.callers)), ...Object.keys(obj(to.callers))])) {
        const [was, now] = [text(obj(from.callers)[c]), text(obj(to.callers)[c])];
        const who = c === EVERYONE ? "everyone else" : `caller ${c}`;
        if (was !== now) out.push(now === "" ? `${who}: no longer sent anywhere of its own` : `${who}: now goes by ${now === "default" ? "the default router" : `router ${now}`}`);
      }
      continue;
    }
    const noun = NOUN[key];
    if (!noun || !isObj(from[key] ?? {}) || !isObj(to[key] ?? {})) { out.push(`setting ${key}: changed`); continue; }
    const [a, b] = [obj(from[key]), obj(to[key])];
    // One that went and one that came with the same contents is one thing under a new name.
    const renamed = new Map<string, string>();
    for (const was of Object.keys(a)) {
      if (was in b) continue;
      const now = Object.keys(b).find((id) => !(id in a) && ![...renamed.values()].includes(id) && JSON.stringify(b[id]).split(JSON.stringify(was)).join(JSON.stringify(id)) === JSON.stringify(a[was]).split(JSON.stringify(was)).join(JSON.stringify(id)));
      if (now !== undefined) renamed.set(was, now);
    }
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (same(a[id], b[id]) || [...renamed.values()].includes(id)) continue;
      if (renamed.has(id)) out.push(`${noun} ${id}: renamed to ${renamed.get(id)!}`);
      else if (!(id in a)) out.push(`${noun} ${id}: added`);
      else if (!(id in b)) out.push(`${noun} ${id}: removed`);
      else {
        const keys = [...new Set([...Object.keys(obj(a[id])), ...Object.keys(obj(b[id]))])].filter((k) => !same(obj(a[id])[k], obj(b[id])[k]));
        out.push(`${noun} ${id}: ${key === "flows" ? "its lines or what enters it" : keys.join(", ")} changed`);
      }
    }
  }
  return out;
}

/** Remember where a node was put, to the pixel: a layout is a picture, not a measurement. */
export const placed = (doc: Doc, id: string, at: { x: number; y: number }): Doc =>
  put(doc, "layout", id, { x: Math.round(at.x), y: Math.round(at.y) });

/** A node picked out on the map and where it stands. */
export type Picked = { node: string; x: number; y: number };
/** One of them that stands in the file on its own, and what it said when it was copied. */
export type Copied = Picked & { kind: "flow" | "action"; id: string; entry: Doc };

/**
 * The nodes among `many` that are a thing of their own in the file: a rule or an action, as its
 * kind and name. A node that is part of one, or is only somewhere a line ends, is moved and nothing more.
 */
export function wholes(many: Picked[]): (Picked & { kind: "flow" | "action"; id: string })[] {
  return many.flatMap((m) => {
    const at = nodeOf(m.node);
    const on = at.kind.opens?.(at.id);
    return on && on.id === at.id ? [{ ...m, ...on }] : [];
  });
}

/**
 * Everything in `copied` put in again, each under a free name with its node a little down and
 * right of the one it came from; `made` is the new nodes, in the same order.
 */
export function pastedAll(doc: Doc, copied: Copied[]): { doc: Doc; made: Picked[] } {
  const made: Picked[] = [];
  let out = doc;
  for (const c of copied) {
    const next = added(out, c.kind === "flow" ? "flows" : "actions", c.id, c.entry);
    const node = `${c.node.slice(0, c.node.indexOf(":"))}:${next.name}`;
    const at = { x: c.x + 40, y: c.y + 40 };
    out = placed(next.doc, `routing/${node}`, at);
    made.push({ node, ...at });
  }
  return { doc: out, made };
}

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
  /** The paths a model that is not chat answers on, as its backend declares them. */
  paths: (name: string) => string[];
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
  const routesOf = (backend: string): { path: string; model?: string }[] => (Array.isArray(obj(obj(doc.backends)[backend]).routes)
    ? (obj(obj(doc.backends)[backend]).routes as unknown[]).map((r) => ({ path: text(obj(r).path), ...(text(obj(r).model) ? { model: text(obj(r).model) } : {}) }))
    : (self?.backends ?? []).find((b) => b.name === backend)?.routes ?? []);
  return {
    kind: (name) => { const on = owner(name); return on !== undefined && paths(on) ? "paths" : "chat"; },
    paths: (name) => {
      const on = owner(name);
      const wire = text(obj(obj(doc.models)[name]).as) || name;
      // A path with the model in it serves every model on the backend; one without belongs to the model its route names.
      return on === undefined ? [] : routesOf(on).filter((r) => r.path.includes("{model}") || r.model === undefined || r.model === wire).map((r) => r.path);
    },
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
    // `paths`: the rule takes requests that are not chat. Any model here may answer those: one whose backend
    // declares no path of its own is still sent a request that names it, so only a peer is ruled out.
    if (paths && end.kind === "peer") return `This rule takes requests that are not chat, and a peer is only ever sent chat.`;
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
      for (const k of ["header", "headerNot"]) if ("" in obj(obj(s.when)[k])) out.push(`Rule "${f.name}", ${last ? "the Otherwise line" : `line ${i + 1}`}: say which header it tests, by name.`);
      if (to.kind === "unset") out.push(`Rule "${f.name}", ${last ? "the Otherwise line" : `line ${i + 1}`}: choose where it sends requests.`);
      // In an order a line with nothing to test is the point: the next is where the request goes when it fails.
      else if (!last && to.kind !== "peer" && typeof s.max !== "number" && Object.keys(obj(s.when)).length === 0 && orderOf({ ...obj(obj(doc.flows)[f.name]), inputs: f.inputs, steps: f.steps }) === null) out.push(`Rule "${f.name}", line ${i + 1}: choose a condition, or the lines after it are never reached.`);
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

/**
 * Neighbouring lines whose conditions share one, read as a single "if" with the lines under it.
 * `foot` is a group a request can leave without a line taking it. The file keeps the condition on each line.
 */
export type Group = { key: string; from: number; to: number; foot: boolean };
export function groupsOf(steps: { when?: unknown }[]): Group[] {
  const out: Group[] = [];
  const last = steps.length - 1;
  for (let i = 0; i < last;) {
    const when = obj(steps[i]!.when);
    let best: Group | null = null;
    for (const key of Object.keys(when)) {
      const v = JSON.stringify(when[key]);
      let j = i;
      while (j + 1 < last && JSON.stringify(obj(steps[j + 1]!.when)[key]) === v) j++;
      if (j > i && (best === null || j > best.to)) best = { key, from: i, to: j, foot: Object.keys(obj(steps[j]!.when)).length > 1 };
    }
    if (best) out.push(best);
    i = best ? best.to + 1 : i + 1;
  }
  return out;
}
/** The heights of a group's heading and foot, which the map's layout counts as the box draws them. */
export const GROUP = { head: 26, foot: 20 };
/** What the headings and feet above line `i` add to a rule box's height; with no `i`, all of them. */
export const groupRows = (steps: { when?: unknown }[], i = steps.length): number =>
  groupsOf(steps).reduce((px, g) => px + (g.from <= i ? GROUP.head : 0) + (g.foot && g.to < i ? GROUP.foot : 0), 0);
