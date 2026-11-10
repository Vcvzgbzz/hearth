/**
 * What a rulebook lets a caller reach: each name it takes, and every place that name can land,
 * fallbacks included. Read off the rules alone, so it says what could run, not what would now.
 */
import type { HearthConfig } from "../config/config.js";
import { ANY, type Flow } from "../config/flows.js";

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
  /** The lane it lands in whatever the key says; null takes the key's, `varies` where its rules differ. */
  lane: string | null;
}

export interface ReachType {
  type: string;
  ends: ReachEnd[];
  /** A name no rule takes runs as itself, so more than `ends` can be reached. */
  asAsked?: true;
}

/** Where a name no flow takes goes. */
const ANYTHING = "anything else";

export function reachOf(cfg: HearthConfig, flows: Readonly<Record<string, Flow>>): ReachType[] {
  const out: ReachType[] = [];
  /** A path resolves to exactly one backend, so its route says the lane of all that runs under it, a fallback included. */
  const routes = cfg.backends.flatMap((b) => b.routes);
  const routeOf = (id: string, takes: readonly string[]) => routes.find((r) => takes.includes(r.path) && r.model === id) ?? routes.find((r) => takes.includes(r.path));
  for (const [name, flow] of Object.entries(flows)) {
    for (const input of flow.inputs) {
      const found = new Map<string, ReachEnd>();
      const seen = new Set<string>();
      let asAsked = false;
      /** In the order a request meets them; a routed request queues in its route's lane whatever else is said. */
      const landsIn = (id: string, takes: readonly string[], stepLane: string | null): string | null =>
        takes.length > 0 ? routeOf(id, takes)?.lane ?? null : cfg.models[id]?.lane ?? stepLane ?? cfg.models[input]?.lane ?? null;
      const place = (id: string, takes: readonly string[], stepLane: string | null, how: { peer?: string; plugin?: true }): void => {
        const lane = how.plugin ? null : landsIn(id, takes, stepLane);
        const known = found.get(id);
        const end = known ?? { id, peers: [], here: false, chat: false, lane, ...(how.plugin ? { plugin: true as const } : {}) };
        found.set(id, end);
        if (end.lane !== lane) end.lane = "varies";
        if (how.peer === undefined && !how.plugin) end.here = true;
        if (how.peer !== undefined && !end.peers.includes(how.peer)) end.peers.push(how.peer);
        if (takes.length === 0) end.chat = true;
      };
      /** A name of its own, or nothing to list where the name is whatever was asked for. */
      const itself = (model: string | null | undefined): string | null => {
        if (model) return model;
        if (input !== ANY) return input;
        asAsked = true;
        return null;
      };
      const walk = (at: string, inherited: readonly string[], carried: string | null): void => {
        if (seen.has(at)) return;
        seen.add(at);
        const here = flows[at];
        if (!here) return;
        const takes = here.takes ?? inherited;
        // Only a name that enters a flow switched off runs as itself; a hand-off still runs its steps.
        if (here.off && at === name) {
          const id = itself(null);
          if (id !== null) place(id, takes, carried, {});
          return;
        }
        for (const { to, lane } of here.steps) {
          const stepLane = lane ?? carried;
          const land = (model: string | null | undefined, how: { peer?: string } = {}): void => {
            const id = itself(model);
            if (id !== null) place(id, takes, stepLane, how);
          };
          if ("flow" in to) walk(to.flow, takes, stepLane);
          else if ("fastest" in to) for (const e of to.fastest) land(e.model, "peer" in e ? { peer: e.peer } : {});
          else if ("peer" in to) land(to.model, { peer: to.peer });
          else if ("model" in to) land(to.model);
          else if ("asked" in to) land(null);
          else if ("plugin" in to) place(to.plugin as string, takes, null, { plugin: true });
        }
      };
      walk(name, [], null);
      if (found.size > 0 || asAsked) out.push({ type: input === ANY ? ANYTHING : input, ends: [...found.values()], ...(asAsked ? { asAsked: true as const } : {}) });
    }
  }
  // Tokens are counted by model, so one reached by chat anywhere counts them on every row.
  const chatty = new Set(out.flatMap((t) => t.ends).filter((e) => e.chat).map((e) => e.id));
  for (const t of out) for (const e of t.ends) if (chatty.has(e.id)) e.chat = true;
  return out;
}
