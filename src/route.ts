/**
 * Where a request runs. Every routing choice is a flow: an ordered list of steps, each a
 * condition and a place to send the request. Pure, so it tests without a socket.
 */
import { ANY, endsOf, type Flow, type FlowEnd, type FlowStep, type FlowTo, type FlowWhen, type HearthConfig } from "./config.js";
import type { PeerRegistry } from "./peers.js";
import { unfit, type Need } from "./stats.js";

export interface LocalLoad {
  /** Jobs waiting on the local backend, all lanes. */
  queued: number;
  /** Free slots on the local backend right now. */
  free: number;
  /** Total slots, so local and peer pressure come out in the same units. */
  slots: number;
  /** Loaded here right now. Starting cold isn't free. */
  loaded: string[];
}

export type Decision =
  | { target: "local"; reason: string }
  | { target: "peer"; peer: string; theirModel: string; reason: string }
  /** Nobody can take it and the operator said it can't run here. */
  | { target: "unavailable"; reason: string };

/** What a flow reads to decide: the request, and the state of this node and its peers. */
export interface World {
  cfg: HearthConfig;
  peers: Pick<PeerRegistry, "candidates" | "statsFor" | "theirModelId" | "loadFor">;
  /** What the request asks for; absent reads as a small text request. */
  need?: Need;
  caller: string;
  lane: string;
  /** The path the request arrived on, as a backend declares it; absent for chat. */
  path?: string;
  /** The headers the request carries, by lower-case name. Absent reads as a request with none. */
  headers?: Readonly<Record<string, string | undefined>>;
  /** Load on the backend that serves a model here. */
  local: (model: string) => LocalLoad;
  /** Is this model's hardware held against this lane? */
  held: (model: string, lane: string) => boolean;
  /** How long since this model last had work here, in ms; 0 while it has any. Absent reads as busy. */
  idleMs?: (model: string) => number;
  /** Would running this model here need no swap? Absent reads as "only when it is loaded". */
  ready?: (model: string) => boolean;
  /** How many requests a step has in flight, for one that sets `max`. */
  inFlight?: (flow: string, step: number) => number;
  /** The node's clock, for `time`; absent is now. */
  now?: () => Date;
  /** Leave peers out: one has already failed this request. */
  noPeers?: boolean;
  /** Models here that have just failed this request, to be passed over. */
  skip?: ReadonlySet<string>;
  /** Kept on this machine: no peer, and no model this says runs elsewhere (a cloud provider). */
  keepHere?: (model: string) => boolean;
  /** Where a sticky flow sent the earlier turns of this conversation, if it remembers. */
  pinned?: (flow: string) => FlowEnd | undefined;
  /** The plugin a request to /plugins/<name>/* is for: it runs as asked only there, and a step that names a model is passed over. */
  plugin?: string;
}

/** Where a request ended up, and what the steps it passed through put on it. */
export type Resolution = {
  /** The id it runs as: ours, also when a peer runs it. */
  model: string;
  lane: string;
  /** Request fields the steps stamped, earliest first. */
  params: Record<string, unknown>;
  reason: string;
  /** The flows it passed through, in order; empty for an id no flow takes. */
  via: string[];
  /** The step that decided in each of those flows, counted from 0. */
  path: { flow: string; step: number }[];
  /** The actions those steps name, in the order they were passed, each once. */
  actions: { name: string; flow: string; step: number }[];
  /** No flow takes the id, and none takes every other name: it is not something this node offers. */
  unlisted?: true;
  /** For a request to /plugins/<name>/*: the plugin it goes to, which a step may name in place of the one asked for. */
  plugin?: string;
} & ({ target: "local" } | { target: "peer"; peer: string; theirModel: string } | { target: "unavailable" });

/**
 * "How soon does this start", lower is sooner: queued work, plus one if nothing is free,
 * plus `coldPenalty` (in queued-job units) when the model has to load first.
 */
function pressure(queued: number, free: number, slots: number, warm: boolean, coldPenalty: number): number {
  const busy = slots - free;
  return queued + (free > 0 ? 0 : Math.max(busy, 1)) + (warm ? 0 : coldPenalty);
}

const step = (to: FlowTo, when: FlowWhen | null = null): FlowStep => ({ when, to, lane: null, params: null, do: [] });

/**
 * A flow to start a model from, in one of the common shapes: `peer` tries each peer in turn,
 * `spillover` runs here until the queue is `spilloverAt` deep, `fastest` picks whoever would
 * start it soonest. `peers` are the ones that map the id, in order; with none, or with `local`,
 * it only ever runs here and null says no flow is needed.
 */
export function routedFlow(id: string, o: { policy: "local" | "peer" | "spillover" | "fastest"; peers: readonly string[]; spilloverAt?: number; fallbackLocal?: boolean }): Flow | null {
  if (o.policy === "local" || o.peers.length === 0) return null;
  const steps: FlowStep[] = [];
  const fallbackLocal = o.fallbackLocal ?? true;
  const home: FlowEnd = { model: id };
  const away = o.peers.map((peer): FlowEnd => ({ peer, model: null }));
  const refuse: FlowTo = { refuse: "no peer could take it, and it does not run here" };
  // Unless it may run here, nothing does once no peer could have taken it.
  if (!fallbackLocal && o.policy !== "peer") steps.push(step(refuse, { down: [...o.peers] }));
  if (o.policy === "fastest") return { inputs: [id], steps: [...steps, step({ fastest: [home, ...away] })] };
  if (o.policy === "spillover") steps.push(step(home, { queuedUnder: o.spilloverAt ?? 1 }));
  return { inputs: [id], steps: [...steps, ...away.map((a) => step(a)), step(fallbackLocal ? home : refuse)] };
}

/** Every flow in force. */
export function flowsOf(cfg: HearthConfig): Record<string, Flow> {
  return cfg.flows;
}

/** Is the clock between `from` and `to`? `from` counts and `to` does not; a `from` later than `to` runs through midnight. */
function inHours(t: { from: string; to: string }, now: Date): boolean {
  const at = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return t.from <= t.to ? at >= t.from && at < t.to : at >= t.from || at < t.to;
}

/**
 * A name as the type it asks for and the variant it asks for it in. The whole name wins where a
 * flow takes it as written, so an id with a colon of its own is still itself; else what follows
 * the last colon is a variant of what precedes it, when a flow takes that.
 */
export function typeOf(flows: Readonly<Record<string, Flow>>, name: string): { type: string; variant: string | null } {
  const cut = name.lastIndexOf(":");
  if (cut <= 0 || entryOf(flows, name) !== undefined || entryOf(flows, name.slice(0, cut)) === undefined) return { type: name, variant: null };
  return { type: name.slice(0, cut), variant: name.slice(cut + 1) };
}

/** The variants a type can be asked for in: every one a step tests, in its own flow and in those it hands on to. */
export function variantsOf(flows: Readonly<Record<string, Flow>>, type: string): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (name: string | undefined): void => {
    if (name === undefined || seen.has(name) || !flows[name]) return;
    seen.add(name);
    for (const s of flows[name].steps) {
      for (const v of s.when?.variant ?? []) out.add(v);
      if ("flow" in s.to) walk(s.to.flow);
    }
  };
  walk(entryOf(flows, type));
  return [...out];
}

/** The flow a request for `asked` enters, if any. One that is switched off takes nothing. */
export function entryOf(flows: Readonly<Record<string, Flow>>, asked: string): string | undefined {
  return Object.keys(flows).find((name) => !flows[name]!.off && flows[name]!.inputs.includes(asked));
}

/** Does any step a request for `asked` could reach send work to a peer? Peer state is only worth refreshing then. */
export function mayLeave(cfg: HearthConfig, asked: string): boolean {
  const flows = flowsOf(cfg);
  const seen = new Set<string>();
  const walk = (name: string | undefined): boolean => {
    if (name === undefined || seen.has(name)) return false;
    seen.add(name);
    return flows[name]!.steps.some(({ to, when }) =>
      when?.down !== undefined || "peer" in to || ("fastest" in to && to.fastest.some((e) => "peer" in e)) || ("flow" in to && walk(to.flow)));
  };
  return walk(entryOf(flows, typeOf(flows, asked).type) ?? entryOf(flows, ANY));
}

/** A place a step can send work, resolved against what is reachable right now. */
type Reached = { model: string; peer?: string; theirModel?: string; plugin?: string };

/**
 * Walk the flow a request for `asked` enters. Steps are tried in order: one is passed over
 * when a condition fails or its target cannot take the request, and the first that holds decides.
 */
export function resolve(named: string, w: World): Resolution {
  const flows = flowsOf(w.cfg);
  // From here on `asked` is the type; the variant it was asked for in is something a step can test.
  const { type: asked, variant } = typeOf(flows, named);
  const need = w.need ?? { tokens: 0, images: false, tools: false };
  let lane = w.lane;
  const params: Record<string, unknown> = {};
  const via: string[] = [];
  const path: { flow: string; step: number }[] = [];
  const actions: Resolution["actions"] = [];
  /** Step `i` of `flow` decides: it is on the path, and what it names is set off. */
  const took = (flow: string, i: number, s: FlowStep): void => {
    path.push({ flow, step: i });
    for (const a of s.do) if (!actions.some((x) => x.name === a)) actions.push({ name: a, flow, step: i });
  };
  /** Why targets were passed over, for the reason a person reads. */
  const passed: string[] = [];
  const done = (r: Reached | null, reason: string): Resolution => {
    const why = passed.length > 0 ? `${reason} (${passed[0]})` : reason;
    if (r === null) return { target: "unavailable", model: asked, lane, params, via, path, actions, reason: passed.length > 0 ? `${passed[0]}; ${reason}` : reason };
    if (r.plugin !== undefined) return { target: "local", plugin: r.plugin, model: r.model, lane, params, via, path, actions, reason: why };
    if (r.peer !== undefined) return { target: "peer", peer: r.peer, theirModel: r.theirModel!, model: r.model, lane, params, via, path, actions, reason: why };
    return { target: "local", model: r.model, lane: w.cfg.models[r.model]?.lane ?? lane, params, via, path, actions, reason: why };
  };

  /** The target as something that can take this request, or why it cannot. */
  const reach = (to: FlowEnd): Reached | string => {
    if (!("peer" in to)) {
      if (w.skip?.has(to.model)) return `${to.model} just failed`;
      return w.keepHere?.(to.model) ? `${to.model} runs off this machine, and this request is kept here` : { model: to.model };
    }
    const model = to.model ?? asked;
    if (w.keepHere) return "this request is kept on this machine";
    if (w.noPeers) return "a peer already failed this request";
    if (!w.peers.candidates(model, [to.peer]).includes(to.peer)) return `${to.peer} is not available`;
    // Safe: candidates() only returns peers that map the model.
    const theirModel = w.peers.theirModelId(to.peer, model)!;
    // Without a request to size, there is nothing a peer can be too small for.
    const small = w.need === undefined ? null : unfit(w.peers.statsFor(to.peer, theirModel), w.need);
    return small === null ? { model, peer: to.peer, theirModel } : `${to.peer} ${small}`;
  };
  const load = (r: Reached): { queued: number; free: number; slots: number; warm: boolean } | null => {
    if (r.peer !== undefined) return w.peers.loadFor(r.peer, r.theirModel!) ?? null;
    const l = w.local(r.model);
    return { queued: l.queued, free: l.free, slots: l.slots, warm: l.loaded.includes(r.model) };
  };
  /** Whichever would start it soonest. A tie stays with the earlier one, so listing this node first keeps work home. */
  const fastest = (ends: readonly FlowEnd[]): Reached | string => {
    let best: { r: Reached; p: number } | null = null;
    for (const end of ends) {
      const r = reach(end);
      if (typeof r === "string") { passed.push(r); continue; }
      const l = load(r);
      if (l === null) { passed.push(`${r.peer} has not reported capacity`); continue; }
      const p = pressure(l.queued, l.free, l.slots, l.warm, w.cfg.coldPenalty);
      if (best === null || p < best.p) best = { r, p };
    }
    return best === null ? "none of them can take it" : best.r;
  };
  /** A header's value as sent, trimmed; null when the request has none by that name or it is empty. */
  const sent = (name: string): string | null => {
    const v = w.headers?.[name];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  /** Does every header named carry one of its values? An empty list asks only that it is there. */
  const carries = (named: Record<string, string[]>): boolean =>
    Object.entries(named).every(([name, values]) => { const v = sent(name); return v !== null && (values.length === 0 || values.includes(v)); });
  /** Does no header named carry one of its values? An empty list asks that it is not there at all. */
  const lacks = (named: Record<string, string[]>): boolean =>
    Object.entries(named).every(([name, values]) => { const v = sent(name); return v === null || (values.length > 0 && !values.includes(v)); });
  const asks = (c: FlowWhen): boolean =>
    (c.images === undefined || c.images === need.images)
    && (c.tools === undefined || c.tools === need.tools)
    && (c.tokensOver === undefined || need.tokens > c.tokensOver)
    && (c.tokensUnder === undefined || need.tokens < c.tokensUnder)
    && (c.asked === undefined || c.asked.includes(asked))
    && (c.variant === undefined || (variant !== null && c.variant.includes(variant)))
    && (c.path === undefined || (w.path !== undefined && c.path.includes(w.path)))
    && (c.header === undefined || carries(c.header))
    && (c.headerNot === undefined || lacks(c.headerNot))
    // A key's caller is `key:<label>`; a step names the label.
    && (c.caller === undefined || c.caller.some((n) => n === w.caller || `key:${n}` === w.caller))
    && (c.lane === undefined || c.lane.includes(lane))
    && (c.askedNot === undefined || !c.askedNot.includes(asked))
    && (c.callerNot === undefined || !c.callerNot.some((n) => n === w.caller || `key:${n}` === w.caller))
    && (c.laneNot === undefined || !c.laneNot.includes(lane))
    && (c.time === undefined || inHours(c.time, (w.now ?? (() => new Date()))()))
    && (c.held === undefined || c.held.some((m) => w.held(m, lane)))
    && (c.idle === undefined || c.idle.model === null || (w.idleMs?.(c.idle.model) ?? 0) >= c.idle.ms)
    && (c.down === undefined || c.down.every((peer) => {
      const r = reach({ peer, model: null });
      if (typeof r === "string") passed.push(r);
      return typeof r === "string";
    }));
  const fits = (c: FlowWhen, r: Reached): boolean => {
    // What a peer's model last did is not something this node can see.
    if (c.idle?.model === null && (r.peer !== undefined || (w.idleMs?.(r.model) ?? 0) < c.idle.ms)) return false;
    if (c.warm === undefined && c.free === undefined && c.queuedUnder === undefined && c.ready === undefined) return true;
    const l = load(r);
    // A peer that has said nothing about its load has not said it is free.
    if (l === null) return false;
    // All this node can see of a peer's hardware is whether the model is loaded there.
    const ready = r.peer !== undefined ? l.warm : (w.ready?.(r.model) ?? l.warm);
    return (c.warm === undefined || c.warm === l.warm)
      && (c.ready === undefined || c.ready === ready)
      && (c.free === undefined || c.free === l.free > 0)
      && (c.queuedUnder === undefined || l.queued < c.queuedUnder);
  };

  // A name no flow takes goes to the flow for every other name, when there is one.
  let name = entryOf(flows, asked) ?? entryOf(flows, ANY);
  if (name === undefined) {
    const types = Object.values(flows).filter((f) => !f.off).flatMap((f) => f.inputs);
    return { ...done(null, `"${asked}" is not offered here${types.length ? ` (${types.join(", ")})` : ""}`), unlisted: true };
  }
  // A variant nothing tests would be answered as the plain type, which is not what was asked for. A plugin
  // request's variant is the plugin it names, which the steps decide on whether or not one tests it.
  if (variant !== null && w.plugin === undefined && !variantsOf(flows, asked).includes(variant)) {
    const known = variantsOf(flows, asked);
    return { ...done(null, `"${named}" is not offered here: ${asked} ${known.length ? `comes as ${known.map((v) => `${asked}:${v}`).join(", ")}` : "has no variants"}`), unlisted: true };
  }
  // A flow cannot lead back to itself: the file is refused if one would.
  walking: while (name !== undefined) {
    const flow: Flow = flows[name]!;
    via.push(name);
    // A conversation this flow has already placed goes back there while that place can take it.
    const pin = w.pinned?.(name);
    const same = (e: FlowEnd): boolean => pin !== undefined
      && ("peer" in pin ? "peer" in e && e.peer === pin.peer && (e.model ?? asked) === pin.model : !("peer" in e) && e.model === pin.model);
    const kept = flow.steps.findIndex(({ to }) => endsOf(to, asked).some(same));
    if (kept >= 0) {
      const r = reach(pin!);
      if (typeof r !== "string") {
        const s = flow.steps[kept]!;
        took(name, kept, s);
        if (s.lane !== null) lane = s.lane;
        if (s.params !== null) Object.assign(params, s.params);
        return done(r, `${name} kept the conversation where it started`);
      }
      passed.push(r);
    }
    for (const [i, s] of flow.steps.entries()) {
      if (s.when !== null && !asks(s.when)) continue;
      const here = `${name} step ${i + 1}`;
      if (s.max !== undefined && (w.inFlight?.(name, i) ?? 0) >= s.max) { passed.push(`${here} is at its limit of ${s.max}`); continue; }
      if ("refuse" in s.to) { took(name, i, s); return done(null, s.to.refuse); }
      // A plugin request goes to a plugin, and a model request to a model: a step for the other kind is passed over.
      if ("plugin" in s.to || (w.plugin !== undefined && "asked" in s.to)) {
        if (w.plugin === undefined) { passed.push(`${here} sends to the plugin ${(s.to as { plugin: string }).plugin}, which takes no model requests`); continue; }
        const to = "plugin" in s.to ? s.to.plugin : w.plugin;
        took(name, i, s);
        return done({ model: to, plugin: to }, here);
      }
      if (w.plugin !== undefined && !("flow" in s.to)) { passed.push(`${here} sends to a model, and this request is for the plugin ${w.plugin}`); continue; }
      let r: Reached | string | null = null;
      if (!("flow" in s.to)) {
        r = "fastest" in s.to ? fastest(s.to.fastest) : reach("asked" in s.to ? { model: asked } : s.to);
        if (typeof r === "string") { passed.push(r); continue; }
        if (s.when !== null && !fits(s.when, r)) continue;
      }
      took(name, i, s);
      if (s.lane !== null) lane = s.lane;
      if (s.params !== null) Object.assign(params, s.params);
      if (r === null) {
        name = (s.to as { flow: string }).flow;
        continue walking;
      }
      return done(r, here);
    }
    return done(null, `no step of ${name} could take it`);
  }
  return done(null, "no flow answered");
}

/** Where a request for `model` runs, on the load of the backend that serves it here. */
export function decide(model: string, cfg: HearthConfig, peers: World["peers"], local: LocalLoad, need?: Need): Decision {
  const r = resolve(model, { cfg, peers, need, caller: "", lane: Object.keys(cfg.scheduler.lanes)[0] ?? "", local: () => local, held: () => false });
  if (r.target === "peer") return { target: "peer", peer: r.peer, theirModel: r.theirModel, reason: r.reason };
  return { target: r.target, reason: r.reason };
}
