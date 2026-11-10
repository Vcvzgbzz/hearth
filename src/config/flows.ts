/**
 * Flows and routers: the rules that decide where a request for a name goes.
 */
import type { HearthConfig } from "./config.js";
import { modelParams } from "./models.js";
import type { PeerConfig } from "./peers.js";
import { pluginKinds, type PluginDecl, type RouterPlugin, routerPlugins, slotModels, type StepPlugin } from "./plugins.js";
import { asRecord, atLeast, bad, bool, count, only, str, strList } from "./read.js";

/** The shapes of flow a newly borrowed model can start as; see `routedFlow`. */
export type RoutePolicy = "local" | "peer" | "spillover" | "fastest";

/** Settings a model once routed by, each now a step of a flow. Refused, with the command that rewrites them. */
export const MOVED_TO_FLOWS = ["policy", "peers", "spilloverAt", "fallbackLocal", "whenHeld"] as const;

/**
 * What a flow step tests. Every condition present must hold. `warm`, `free` and `queuedUnder`
 * read the step's own target; the rest read the request and the node.
 */
export type FlowWhen = {
  images?: boolean;
  tools?: boolean;
  /** Estimated prompt plus reserved output, strictly over or under. */
  tokensOver?: number;
  tokensUnder?: number;
  /** The id the client asked for, when several enter one flow. */
  asked?: string[];
  /** An api key's label, or `local` for loopback without a key. */
  caller?: string[];
  lane?: string[];
  /** One of these ids has its hardware held against the request's lane; see HoldDecl. */
  held?: string[];
  /** None of these peers can take the request: down, not lending the id, or too small for it. */
  down?: string[];
  /**
   * `model` has had no work here for at least `ms`: nothing queued or running now, and nothing
   * finished more recently. A null `model` reads the step's own target.
   */
  idle?: { model: string | null; ms: number };
  warm?: boolean;
  free?: boolean;
  queuedUnder?: number;
  /**
   * Running it on the step's own target needs no swap: the model is loaded there, or nothing
   * else is loaded on its backend or on the exclusive hardware that backend uses.
   */
  ready?: boolean;
  /**
   * The variant the name was asked for with, after its last colon: `ImageGen:realism` is the
   * type `ImageGen` in its `realism` variant. A request with no variant matches none of these.
   */
  variant?: string[];
  /**
   * A header the request carries, by name (lower case), is one of these values; an empty list is
   * any value at all. A request without the header matches none.
   */
  header?: Record<string, string[]>;
  /** The opposite: the header is not one of these values, or with an empty list is not there. A request without it matches. */
  headerNot?: Record<string, string[]>;
  /** The path the request arrived on is one of these, each as a backend declares it under `routes:`. A chat request matches none. */
  path?: string[];
  /** The opposite of `asked`, `caller` and `lane`: none of these. */
  askedNot?: string[];
  callerNot?: string[];
  laneNot?: string[];
  /** The node's own clock is between these, `HH:MM` each; `from` later than `to` runs through midnight. */
  time?: { from: string; to: string };
};

/** Somewhere a request can run: here as `model`, or on `peer` as its id for `model` (null: the id asked for). */
export type FlowEnd = { model: string } | { peer: string; model: string | null };

/**
 * Where a step sends a request: to run, into another flow, to whichever of several would start
 * it soonest, nowhere, or here as the very id that was asked for.
 */
export type FlowTo = FlowEnd | { flow: string } | { fastest: FlowEnd[] } | { refuse: string } | { asked: true } | { plugin: string };

/** The input that stands for every name no other flow takes: the flow that has it decides what happens to those. */
export const ANY = "*";

/** One step of a flow: when its conditions hold and its target can take the request, the request goes there. */
export interface FlowStep {
  /** null always holds. */
  when: FlowWhen | null;
  to: FlowTo;
  /** The lane it queues in, over the target's own and the client's. */
  lane: string | null;
  /** Request fields stamped before the target model's own `params`. */
  params: Record<string, unknown> | null;
  /** Actions set off when this step decides, by their names under `actions:`. */
  do: string[];
  /** Plugins run, in this order, on the requests this step sends to a model; each with the models wired into its slots here. */
  plugins?: StepPlugin[];
  /** The most requests this step may have in flight at once; past it the step is passed over. */
  max?: number;
}

/**
 * `flows.<name>`: how requests for its `inputs` are routed. Steps are tried in order and the
 * first that holds wins; the last always can. Only what a client asked for enters a flow:
 * a step that names a model runs it as named.
 */
export interface Flow {
  inputs: string[];
  steps: FlowStep[];
  /** Switched off: requests for its inputs run as themselves. Another flow can still hand work to it. */
  off?: true;
  /** What it is for, in the operator's words. */
  note?: string;
  /**
   * The request paths this flow answers besides chat, each as a backend declares it under
   * `routes:`. A path with no name in it (`/generate`) is asked for by this flow's first input;
   * one with a `{model}` segment, or a model in its body, is asked for by the name it carries.
   */
  takes?: string[];
  /**
   * How long a conversation stays where this flow first sent it, in ms. A later turn of the same
   * conversation goes there again while it can take it, whatever the steps would say now.
   */
  sticky?: number;
}

const WHEN_KEYS = ["images", "tools", "tokensOver", "tokensUnder", "variant", "path", "header", "headerNot", "asked", "askedNot", "caller", "callerNot", "lane", "laneNot", "time", "held", "down", "idle", "warm", "free", "queuedUnder", "ready"] as const;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A step's `to`: a bare id runs it here; a map says a peer, another flow, the fastest of several, or a refusal. */
function flowTo(raw: unknown, at: string): FlowTo {
  if (typeof raw === "string" && raw.trim() !== "") return { model: raw.trim() };
  const o = asRecord(raw, at);
  only(o, ["model", "peer", "flow", "fastest", "refuse", "asked", "plugin"], at);
  const said = ["peer", "flow", "fastest", "refuse", "asked", "plugin"].filter((k) => o[k] !== undefined);
  if (said.length > 1 || (said.length === 1 && said[0] !== "peer" && o.model !== undefined)) {
    throw bad(at, "must say one thing: a model, a peer, a flow, fastest, refuse, asked or a plugin");
  }
  if (o.asked !== undefined) {
    if (o.asked !== true) throw bad(`${at}.asked`, "must be true: run it here as the id that was asked for");
    return { asked: true };
  }
  if (o.refuse !== undefined) return { refuse: str(o.refuse, `${at}.refuse`) };
  if (o.plugin !== undefined) return { plugin: str(o.plugin, `${at}.plugin`) };
  if (o.flow !== undefined) return { flow: str(o.flow, `${at}.flow`) };
  if (o.fastest !== undefined) {
    if (!Array.isArray(o.fastest) || o.fastest.length < 2) throw bad(`${at}.fastest`, "must list at least two places to choose between");
    return {
      fastest: o.fastest.map((e, i) => {
        const end = flowTo(e, `${at}.fastest[${i}]`);
        if ("flow" in end || "fastest" in end || "refuse" in end || "asked" in end || "plugin" in end) throw bad(`${at}.fastest[${i}]`, "must be a model or a peer");
        return end;
      }),
    };
  }
  if (o.peer !== undefined) return { peer: str(o.peer, `${at}.peer`), model: o.model === undefined ? null : str(o.model, `${at}.model`) };
  return { model: str(o.model, `${at}.model`) };
}

/** A flow as hearth.yaml writes it: the shortest form of each step, with nothing that is only a default. */
export function rawFlow(flow: Flow): Record<string, unknown> {
  const end = (e: FlowEnd): unknown => ("peer" in e ? (e.model === null ? { peer: e.peer } : { peer: e.peer, model: e.model }) : e.model);
  return {
    ...(flow.note !== undefined ? { note: flow.note } : {}),
    ...(flow.off ? { off: true } : {}),
    ...(flow.sticky !== undefined ? { sticky: flow.sticky } : {}),
    ...(flow.takes !== undefined ? { takes: [...flow.takes] } : {}),
    inputs: [...flow.inputs],
    steps: flow.steps.map((s) => ({
      ...(s.when !== null ? { when: s.when } : {}),
      to: "fastest" in s.to ? { fastest: s.to.fastest.map(end) } : "flow" in s.to || "refuse" in s.to || "asked" in s.to || "plugin" in s.to ? s.to : end(s.to),
      ...(s.max !== undefined ? { max: s.max } : {}),
      ...(s.lane !== null ? { lane: s.lane } : {}),
      ...(s.params !== null ? { params: s.params } : {}),
      ...(s.do.length > 0 ? { do: [...s.do] } : {}),
      ...(s.plugins?.length ? { plugins: s.plugins.map((x) => (Object.keys(x.models).length ? { use: x.name, models: { ...x.models } } : x.name)) } : {}),
    })),
  };
}

/** The places a target can run a request: itself, or each of the several it chooses between. `asked` is the id in hand, for a target that runs "what was asked for". */
export function endsOf(to: FlowTo, asked?: string): FlowEnd[] {
  if ("fastest" in to) return to.fastest;
  if ("asked" in to) return asked === undefined ? [] : [{ model: asked }];
  return "flow" in to || "refuse" in to || "plugin" in to ? [] : [to];
}

/** Can this target be passed over when it cannot take the request? A peer can be down, and a plugin takes no model request. */
const skippable = (to: FlowTo): boolean => "peer" in to || "plugin" in to || ("fastest" in to && to.fastest.every((e) => "peer" in e));

/** The name that stands for `flows:` where a caller is given a rulebook. */
export const DEFAULT_ROUTER = "default";

/**
 * `routers.<name>`: a rulebook used in place of `flows:` for the callers `callers:` gives it.
 * `strict` switches off a flow's next line after a failure and a backend route's own fallback
 * for them, so a request runs where its line says or fails.
 */
export interface Router {
  strict: boolean;
  note?: string;
  flows: Record<string, Flow>;
  /** Global plugins this router turns off or sets differently. */
  plugins: Record<string, RouterPlugin>;
}

/** `routers:`, each checked as `flows:` is. */
export function routerDecls(raw: unknown, flows: (raw: unknown) => Record<string, Flow>, plugins: Record<string, PluginDecl> = {}): Record<string, Router> {
  const out: Record<string, Router> = {};
  for (const [name, v] of Object.entries(asRecord(raw ?? {}, "routers"))) {
    const at = `routers.${name}`;
    if (name === DEFAULT_ROUTER) throw bad(at, `is the name flows: goes by; give this router another`);
    const r = asRecord(v, at);
    only(r, ["strict", "note", "flows", "plugins"], at);
    const own = flows(r.flows);
    if (!Object.values(own).some((f) => f.inputs.includes(ANY))) throw bad(`${at}.flows`, `needs a flow with inputs: ["${ANY}"], as flows: does, to say what happens to a name no other flow takes`);
    out[name] = { strict: bool(r.strict, `${at}.strict`, false), ...(typeof r.note === "string" && r.note ? { note: r.note } : {}), flows: own, plugins: routerPlugins(r.plugins, `${at}.plugins`, plugins) };
  }
  return out;
}

/** `callers:`: an api key's label, `local`, or `*` for everyone else, each to a router's name or `default`. */
export function callerDecls(raw: unknown, routers: Record<string, Router>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [who, v] of Object.entries(asRecord(raw ?? {}, "callers"))) {
    if (typeof v !== "string" || (v !== DEFAULT_ROUTER && routers[v] === undefined)) throw bad(`callers.${who}`, `must be "${DEFAULT_ROUTER}" or a name under routers:`);
    out[who] = v;
  }
  return out;
}

/** Check a `flows:` section against a running config, as loading the file would. */
export function flowsFor(raw: unknown, cfg: HearthConfig, actions: Record<string, unknown> = cfg.actions): Record<string, Flow> {
  return flowDecls(raw, cfg.scheduler.lanes, cfg.peers, actions, cfg.backends.flatMap((b) => b.routes.map((r) => r.path)), cfg.plugins);
}

/** A step's `plugins:`: names under `plugins:`, or `{ use, models }` to wire this line's own models. */
function stepPlugins(raw: unknown, at: string, plugins: Record<string, PluginDecl>, to: FlowTo): StepPlugin[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw bad(at, "must be a list of plugin names, or of { use, models }");
  if (raw.length && ("refuse" in to || "flow" in to)) throw bad(at, "runs on requests this step sends to a model; this step refuses or hands to another flow, which places its own");
  const out: StepPlugin[] = [];
  raw.forEach((v, i) => {
    const here = `${at}[${i}]`;
    const entry = typeof v === "string" ? { use: v } : asRecord(v, here);
    only(entry, ["use", "models"], here);
    const name = str(entry.use, `${here}.use`);
    const p = plugins[name];
    if (!p) throw bad(here, `names plugin "${name}", which is not under plugins:`);
    if (p.everyLine) throw bad(here, `${name} runs on every line already (everyLine: true)`);
    if (out.some((x) => x.name === name)) throw bad(here, `places ${name} twice on one line`);
    out.push({ name, models: slotModels(entry.models, `${here}.models`) });
  });
  return out;
}

/**
 * A flow's `takes`: the kinds of request it answers besides chat, each a path a backend declares or a
 * type this section offers. Nothing here decides which types exist: `types` is every type the config
 * gives the section, and a name is accepted or refused by that set as any other type would be.
 * What arrives on one is not a chat request, so a step cannot test what only chat has, nor send it
 * to a peer, which is only ever sent chat.
 */
function takesOf(raw: unknown, at: string, steps: readonly FlowStep[], routed: readonly string[], types: readonly string[]): string[] {
  const named = strList(typeof raw === "string" ? [raw] : raw, at);
  for (const p of named) {
    if (types.includes(p) || routed.includes(p)) continue;
    throw bad(at, `names "${p}", which is neither a path a backend declares under routes: (${routed.join(", ") || "none"}) nor a type this node offers: (${types.join(", ") || "none"})`);
  }
  steps.forEach((s, i) => {
    const chatOnly = (["images", "tools", "tokensOver", "tokensUnder"] as const).find((k) => s.when?.[k] !== undefined);
    if (chatOnly) throw bad(`${at.replace(/takes$/, `steps[${i}].when.${chatOnly}`)}`, "reads a chat request, and this flow takes paths that are not chat");
    if (endsOf(s.to).some((e) => "peer" in e)) throw bad(`${at.replace(/takes$/, `steps[${i}].to`)}`, "sends to a peer, and a peer is only ever sent chat: this flow takes paths that are not chat");
  });
  return named;
}

/** Every type a section's own flows are entered by, so one rule's `takes` may name another's type. */
function offeredTypes(raw: unknown, plugins: Record<string, PluginDecl>): string[] {
  const out = new Set<string>(pluginKinds(plugins));
  for (const v of Object.values(asRecord(raw ?? {}, "flows"))) {
    const inputs = (v !== null && typeof v === "object" ? (v as Record<string, unknown>).inputs : undefined);
    for (const id of Array.isArray(inputs) ? inputs : typeof inputs === "string" ? [inputs] : []) if (typeof id === "string" && id !== ANY) out.add(id);
  }
  return [...out];
}

/** `flows:`, checked whole: every name resolves, every flow ends in an answer, and none leads back to itself. */
export function flowDecls(
  raw: unknown, lanes: Record<string, unknown>, peers: readonly PeerConfig[], actions: Record<string, unknown>, routed: readonly string[],
  plugins: Record<string, PluginDecl> = {},
): Record<string, Flow> {
  const flows: Record<string, Flow> = {};
  const entry = new Map<string, string>();
  const types = offeredTypes(raw, plugins);
  const inLanes = (l: string, where: string) => {
    if (!(l in lanes)) throw bad(where, `names lane "${l}", which is not in scheduler.lanes (${Object.keys(lanes).join(", ")})`);
  };
  for (const [name, v] of Object.entries(asRecord(raw ?? {}, "flows"))) {
    const at = `flows.${name}`;
    const decl = asRecord(v, at);
    only(decl, "flow", at);
    const inputs = strList(decl.inputs, `${at}.inputs`);
    for (const id of inputs) {
      // Several flows may take the same type: they are tried in file order, and one whose
      // steps match nothing falls through to the next. The flow for every other name is one
      // and only one, so it still refuses a second.
      if (id === ANY && entry.has(ANY)) throw bad(`${at}.inputs`, `lists "${ANY}", which is the flow for every other name and may appear only once`);
      if (id === ANY && inputs.length > 1) throw bad(`${at}.inputs`, `lists "${ANY}" beside other names: the flow for every other name takes only "${ANY}"`);
      entry.set(id, name);
    }
    const rawSteps = decl.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw bad(`${at}.steps`, "must be a list of steps, the last one a bare `to:`");
    const steps = rawSteps.map((r, i): FlowStep => {
      const here = `${at}.steps[${i}]`;
      const step = asRecord(r, here);
      only(step, ["when", "to", "lane", "params", "do", "max", "plugins"], here);
      if (step.to === undefined) throw bad(`${here}.to`, "is required");
      const to = flowTo(step.to, `${here}.to`);
      let when: FlowWhen | null = null;
      if (step.when !== undefined && step.when !== null) {
        const w = asRecord(step.when, `${here}.when`);
        only(w, WHEN_KEYS, `${here}.when`);
        when = {};
        for (const k of ["images", "tools", "warm", "free", "ready"] as const) if (w[k] !== undefined) when[k] = bool(w[k], `${here}.when.${k}`, false);
        for (const k of ["tokensOver", "tokensUnder", "queuedUnder"] as const) if (w[k] !== undefined) when[k] = count(w[k], `${here}.when.${k}`, 0, k === "tokensOver" ? 0 : 1);
        for (const k of ["variant", "path", "asked", "askedNot", "caller", "callerNot", "lane", "laneNot", "held", "down"] as const) if (w[k] !== undefined) when[k] = strList(typeof w[k] === "string" ? [w[k]] : w[k], `${here}.when.${k}`);
        for (const l of [...(when.lane ?? []), ...(when.laneNot ?? [])]) inLanes(l, `${here}.when.lane`);
        for (const k of ["header", "headerNot"] as const) {
          if (w[k] === undefined || w[k] === null) continue;
          const named: Record<string, string[]> = {};
          for (const [name, v] of Object.entries(asRecord(w[k], `${here}.when.${k}`))) {
            if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw bad(`${here}.when.${k}`, `names "${name}", which is not a header name`);
            // One value may be written bare, and nothing at all is the empty list: any value, or for headerNot none.
            named[name.toLowerCase()] = strList(v === null || v === undefined ? [] : typeof v === "string" ? [v] : v, `${here}.when.${k}.${name}`).map((x) => x.trim());
          }
          if (Object.keys(named).length) when[k] = named;
        }
        for (const p of when.path ?? []) if (!routed.includes(p)) throw bad(`${here}.when.path`, `names "${p}", which no backend declares under routes: (${routed.join(", ") || "none"})`);
        for (const v of when.variant ?? []) if (v === "" || v.includes(":")) throw bad(`${here}.when.variant`, `names "${v}": a variant is a plain word, asked for as <name>:<variant>`);
        if (w.time !== undefined) {
          const time = asRecord(w.time, `${here}.when.time`);
          only(time, ["from", "to"], `${here}.when.time`);
          when.time = { from: str(time.from, `${here}.when.time.from`), to: str(time.to, `${here}.when.time.to`) };
          for (const k of ["from", "to"] as const) if (!CLOCK.test(when.time[k])) throw bad(`${here}.when.time.${k}`, "must be a time of day as HH:MM, like 22:00");
        }
        for (const p of when.down ?? []) if (!peers.some((x) => x.name === p)) throw bad(`${here}.when.down`, `names "${p}", which is not a peer you borrow from (one with a url)`);
        if (w.idle !== undefined) {
          const idle = asRecord(w.idle, `${here}.when.idle`);
          only(idle, ["model", "ms"], `${here}.when.idle`);
          when.idle = { model: idle.model === undefined ? null : str(idle.model, `${here}.when.idle.model`), ms: atLeast(idle.ms, `${here}.when.idle.ms`, 0, 0) };
          if (idle.ms === undefined) throw bad(`${here}.when.idle.ms`, "is required: how long it must have been idle, in ms");
        }
        const ownTarget = when.warm !== undefined || when.free !== undefined || when.queuedUnder !== undefined || when.ready !== undefined || when.idle?.model === null;
        if (ownTarget && !("model" in to)) {
          throw bad(`${here}.when`, "tests warm, free, queuedUnder, ready or idle, which read a model or a peer — this step goes somewhere else (give idle a model)");
        }
        if (Object.keys(when).length === 0) when = null;
      }
      const last = i === rawSteps.length - 1;
      const max = step.max === undefined ? undefined : count(step.max, `${here}.max`, 1);
      if (last && max !== undefined) throw bad(`${here}.max`, "cannot be set on the last step, which must always apply");
      if (last && (when !== null || skippable(to))) {
        // A flow for every other name is the last place a request can go, so it must decide everything.
        // Other flows may pass on what they do not take.
        if (inputs.includes(ANY)) {
          throw bad(`${at}.steps`, "must end with a step that always applies: no `when`, and somewhere that can always answer (a model, a flow or refuse)");
        }
      }
      // A model here can fail before it answers, and the next line is where the request goes then.
      const mayFail = "model" in to && !("peer" in to);
      if (!last && when === null && max === undefined && !skippable(to) && !mayFail) throw bad(here, "has no `when`, so the steps after it can never be reached");
      for (const end of "fastest" in to ? to.fastest : "peer" in to ? [to] : []) {
        if (!("peer" in end)) continue;
        const peer = peers.find((x) => x.name === end.peer);
        if (!peer) throw bad(`${here}.to`, `names peer "${end.peer}", which is not a peer you borrow from (one with a url)`);
        if (end.model === null && inputs.includes(ANY)) throw bad(`${here}.to`, `sends every other name to ${end.peer}: say which model with \`model:\`, since a peer maps ids one by one`);
        for (const id of end.model === null ? inputs : [end.model]) {
          if (peer.models[id] === undefined) throw bad(`${here}.to`, `sends "${id}" to ${end.peer}, which does not map it — add it to peers.${end.peer}.models`);
        }
      }
      const lane = str(step.lane, `${here}.lane`, "");
      if (lane !== "") inLanes(lane, `${here}.lane`);
      const doing = step.do === undefined ? [] : strList(typeof step.do === "string" ? [step.do] : step.do, `${here}.do`);
      for (const a of doing) if (!(a in actions)) throw bad(`${here}.do`, `names action "${a}", which is not under actions:`);
      const placed = stepPlugins(step.plugins, `${here}.plugins`, plugins, to);
      return {
        when, to, lane: lane === "" ? null : lane, params: modelParams(step.params, name, `${here}.params`), do: doing,
        ...(max !== undefined ? { max } : {}), ...(placed.length ? { plugins: placed } : {}),
      };
    });
    flows[name] = {
      inputs, steps,
      ...(bool(decl.off, `${at}.off`, false) ? { off: true as const } : {}),
      ...(str(decl.note, `${at}.note`, "") !== "" ? { note: str(decl.note, `${at}.note`) } : {}),
      ...(decl.sticky !== undefined ? { sticky: atLeast(decl.sticky, `${at}.sticky`, 0, 1000) } : {}),
      ...(decl.takes !== undefined ? { takes: takesOf(decl.takes, `${at}.takes`, steps, routed, types) } : {}),
    };
  }
  for (const [name, flow] of Object.entries(flows)) {
    flow.steps.forEach((step, i) => {
      if ("flow" in step.to && flows[step.to.flow] === undefined) {
        throw bad(`flows.${name}.steps[${i}].to`, `names flow "${step.to.flow}", which is not under flows:`);
      }
    });
    const walk = (at: string, seen: string[]): void => {
      for (const step of flows[at]!.steps) {
        if (!("flow" in step.to)) continue;
        if (step.to.flow === name) throw bad(`flows.${name}`, `leads back to itself: ${[...seen, at, name].join(" → ")}`);
        if (!seen.includes(step.to.flow)) walk(step.to.flow, [...seen, at]);
      }
    };
    walk(name, []);
  }
  return flows;
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
