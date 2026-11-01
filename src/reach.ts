/**
 * What a rulebook lets a caller reach: each name it takes, and every place that name can land,
 * fallbacks included. Read off the rules alone, so it says what could run, not what would now.
 */
import { ANY, type Flow, type HearthConfig } from "./config.js";

export interface ReachEnd {
  /** The id a job runs as, or a plugin's name. */
  id: string;
  plugin?: true;
  /** Peers that may run it. */
  peers: string[];
  /** It can run on this node. */
  here: boolean;
  /** Reached by chat, where tokens are counted. Routed work counts requests only. */
  chat: boolean;
  /** The lane its model or route pins; null takes the key's. */
  lane: string | null;
}

export interface ReachType {
  type: string;
  ends: ReachEnd[];
}

export function reachOf(cfg: HearthConfig, flows: Readonly<Record<string, Flow>>): ReachType[] {
  const out: ReachType[] = [];
  /** A path resolves to exactly one backend, so its route says the lane of all that runs under it, a fallback included. */
  const routes = cfg.backends.flatMap((b) => b.routes);
  const routeOf = (id: string, takes: readonly string[]) => routes.find((r) => takes.includes(r.path) && r.model === id) ?? routes.find((r) => takes.includes(r.path));
  for (const [name, flow] of Object.entries(flows)) {
    for (const type of flow.inputs.filter((i) => i !== ANY)) {
      const found = new Map<string, ReachEnd>();
      const seen = new Set<string>();
      const place = (id: string, takes: readonly string[], how: { peer?: string; plugin?: true }): void => {
        const end = found.get(id) ?? { id, peers: [], here: false, chat: false, lane: null, ...(how.plugin ? { plugin: true as const } : {}) };
        found.set(id, end);
        if (how.peer === undefined && !how.plugin) end.here = true;
        if (how.peer !== undefined && !end.peers.includes(how.peer)) end.peers.push(how.peer);
        if (takes.length === 0) end.chat = true;
        if (!how.plugin) end.lane = cfg.models[id]?.lane ?? routeOf(id, takes)?.lane ?? end.lane;
      };
      const walk = (at: string, inherited: readonly string[]): void => {
        if (seen.has(at)) return;
        seen.add(at);
        const here = flows[at];
        if (!here) return;
        const takes = here.takes ?? inherited;
        if (here.off) return place(type, takes, {});
        for (const { to } of here.steps) {
          if ("flow" in to) walk(to.flow, takes);
          else if ("fastest" in to) for (const e of to.fastest) place(e.model ?? type, takes, "peer" in e ? { peer: e.peer } : {});
          else if ("peer" in to) place(to.model ?? type, takes, { peer: to.peer });
          else if ("model" in to) place(to.model, takes, {});
          else if ("asked" in to) place(type, takes, {});
          else if ("plugin" in to) place(to.plugin as string, takes, { plugin: true });
        }
      };
      walk(name, []);
      out.push({ type, ends: [...found.values()] });
    }
  }
  // A model reached by chat anywhere counts tokens everywhere, and takes the key's lane on that work.
  const chatty = new Set(out.flatMap((t) => t.ends).filter((e) => e.chat).map((e) => e.id));
  for (const t of out) {
    for (const e of t.ends) {
      if (!chatty.has(e.id)) continue;
      e.chat = true;
      e.lane = cfg.models[e.id]?.lane ?? null;
    }
  }
  return out;
}
