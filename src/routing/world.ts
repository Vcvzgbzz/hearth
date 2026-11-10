/**
 * The live state a flow reads about this node, gathered into the `World` that `route.ts` decides
 * on: load per model, when each model was last used, requests in flight per step, where a sticky
 * flow put each conversation, and which rulebook a caller goes by. Also counts each step's hits
 * and sets off the actions a decision names.
 */
import type { ServerResponse } from "node:http";
import { createHash } from "node:crypto";

import { runAction, type Action, type ActionFacts } from "./actions.js";
import type { HearthConfig } from "../config/config.js";
import { DEFAULT_ROUTER, type FlowEnd } from "../config/flows.js";
import type { Logger } from "../observe/log.js";
import type { PeerRegistry } from "../peers/peers.js";
import type { BackendPool, BackendSlot } from "../queue/pool.js";
import type { LocalLoad, resolve, World } from "./route.js";
import { derived } from "../config/derived.js";

/** Conversations a sticky flow remembers before the oldest is forgotten. */
const PLACED_MAX = 5000;

/** The local half of a routing decision: this model's queue and slots on the backend that serves it. */
export function localLoad(slot: BackendSlot, model: string): LocalLoad {
  const cap = slot.scheduler.capacityFor(model);
  return {
    queued: Object.values(cap.queued).reduce((a, b) => a + b, 0),
    free: cap.free,
    slots: cap.slots,
    loaded: slot.state.loaded(),
  };
}

export class Worlds {
  /**
   * When each model was last in use here, for a flow's `idle`: someone asked for it by one of its
   * names, here or from a peer. Kept by the id the backend knows it by, so every name for one model
   * counts as that model. A request a flow sent there is not someone using it, or a rule that
   * borrows an idle model would end its own idleness.
   */
  private readonly lastUse = new Map<string, number>();
  private readonly bootAt = Date.now();
  /** Requests open per model id right now. */
  private readonly open = new Map<string, number>();
  /** How many times each step of each flow has decided, since the flows last changed. */
  private readonly hits = derived(() => [this.cfg.flows], () => new Map<string, number[]>());
  /** Where a sticky flow sent each conversation; a Map keeps insertion order, so the first key is the least recently placed. */
  private readonly placed = new Map<string, { end: FlowEnd; until: number }>();
  /** When each action last ran, for one that sets `every`. */
  private readonly ranAt = new Map<string, number>();
  /** How many requests each step that sets `max` has in flight, by `<flow>\0<step>`. */
  private readonly stepsBusy = new Map<string, number>();

  constructor(
    private readonly cfg: HearthConfig,
    private readonly pool: BackendPool,
    private readonly peers: PeerRegistry,
    private readonly log: Logger,
  ) {}

  /** The router a caller goes by: the one `callers:` gives it by its key's label or `local`, else the one it gives everyone, else `default` for `flows:`. */
  routerNameOf(caller: string): string {
    return this.cfg.callers[caller.startsWith("key:") ? caller.slice(4) : caller] ?? this.cfg.callers["*"] ?? DEFAULT_ROUTER;
  }

  routerOf(caller: string): HearthConfig["routers"][string] | undefined {
    return this.cfg.routers[this.routerNameOf(caller)];
  }

  /** The config as a caller's requests see it: its router's rulebook in place of `flows:`. */
  rulesFor(caller: string): HearthConfig {
    const r = this.routerOf(caller);
    return r ? { ...this.cfg, flows: r.flows } : this.cfg;
  }

  /** Count a request that asked for this model as use of it until `res` closes. */
  using(model: string, res: ServerResponse): void {
    const wire = this.pool.models.outboundId(model);
    this.open.set(wire, (this.open.get(wire) ?? 0) + 1);
    res.once("close", () => {
      this.open.set(wire, (this.open.get(wire) ?? 1) - 1);
      this.lastUse.set(wire, Date.now());
    });
  }

  /** How long since this model had work here, in ms; 0 while it has some. Unused since startup is idle since then. */
  idleMs(model: string): number {
    const wire = this.pool.models.outboundId(model);
    return (this.open.get(wire) ?? 0) > 0 ? 0 : Date.now() - (this.lastUse.get(wire) ?? this.bootAt);
  }

  /** When each model was last used, for the history file. */
  lastUses(): Record<string, number> {
    return Object.fromEntries(this.lastUse);
  }

  restoreLastUses(saved: unknown): void {
    for (const [m, at] of Object.entries(saved ?? {})) if (typeof at === "number") this.lastUse.set(m, at);
  }

  /** Count each step a decision passed through. Only `flows:` is counted; a change to the flows starts the counts over. */
  countHits(path: readonly { flow: string; step: number }[]): void {
    const hits = this.hits();
    for (const p of path) {
      const row = hits.get(p.flow) ?? [];
      row[p.step] = (row[p.step] ?? 0) + 1;
      hits.set(p.flow, row);
    }
  }

  /** Each flow's hits per step, for the console. */
  flowHits(): Record<string, number[]> {
    return Object.fromEntries([...this.hits()].map(([flow, row]) => [flow, Array.from(row, (n) => n ?? 0)]));
  }

  /**
   * A conversation is who is calling, the id they ask for and how it opens: everything up to its
   * first user turn. `later` is true once the model has answered in it.
   */
  conversation(caller: string, asked: string, payload: Record<string, unknown>): { key: string; later: boolean } | null {
    const turns = Array.isArray(payload.messages) ? (payload.messages as { role?: unknown }[]) : [];
    const first = turns.findIndex((m) => m?.role === "user");
    if (first < 0) return null;
    const key = createHash("sha256").update(`${caller}\0${asked}\0${JSON.stringify(turns.slice(0, first + 1))}`).digest("hex");
    return { key, later: turns.some((m) => m?.role === "assistant") };
  }

  /** Where a sticky flow put this conversation, while that is still remembered. */
  pinned(flow: string, conversation: string): FlowEnd | undefined {
    const at = this.placed.get(`${flow}\0${conversation}`);
    return at && at.until > Date.now() ? at.end : undefined;
  }

  /** Remember where a sticky flow put this conversation, for `ms`; the least recently placed is forgotten past the cap. */
  place(flow: string, conversation: string, end: FlowEnd, ms: number): void {
    const key = `${flow}\0${conversation}`;
    // Re-inserted, so it moves to the young end of the Map's order.
    this.placed.delete(key);
    this.placed.set(key, { end, until: Date.now() + ms });
    if (this.placed.size > PLACED_MAX) this.placed.delete(this.placed.keys().next().value!);
  }

  /** Count a request against a step's `max` until its response closes. */
  occupy(flow: string, step: number, res: ServerResponse): void {
    const key = `${flow}\0${step}`;
    this.stepsBusy.set(key, (this.stepsBusy.get(key) ?? 0) + 1);
    res.once("close", () => { this.stepsBusy.set(key, (this.stepsBusy.get(key) ?? 1) - 1); });
  }

  /** Run an action, unless it sets `every` and ran more recently than that. */
  act(name: string, action: Action, facts: ActionFacts): void {
    const now = Date.now();
    if (action.every > 0 && now - (this.ranAt.get(name) ?? -Infinity) < action.every) return;
    this.ranAt.set(name, now);
    runAction(action, facts, this.log);
  }

  /**
   * Would running this model here need no swap? It is loaded, or nothing else is: not on its own
   * backend, and not on any backend that shares exclusive hardware with it.
   */
  ready(model: string): boolean {
    const slot = this.pool.models.for(model);
    const loaded = slot.state.loaded();
    if (loaded.includes(model) || loaded.includes(this.pool.models.outboundId(model))) return true;
    if (loaded.length > 0) return false;
    const exclusive = new Set(this.pool.hardware.resources().filter((r) => !r.shared).map((r) => r.name));
    const mine = slot.cfg.resources.filter((r) => exclusive.has(r));
    return !this.pool.all().some((o) => o !== slot && o.cfg.resources.some((r) => mine.includes(r)) && o.state.loaded().length > 0);
  }

  /** What a flow decided for work that is not chat: counted, and its actions that run as a step decides set off. */
  settle(r: ReturnType<typeof resolve>, asked: string, caller: string): void {
    // ponytail: only `flows:` is counted; a router's lines show no counts until hits are kept per router.
    if (!this.routerOf(caller)) this.countHits(r.path);
    for (const a of r.actions) {
      const action = this.cfg.actions[a.name];
      if (action?.on !== "decided") continue;
      this.act(a.name, action, {
        action: a.name, node: this.cfg.name, asked, model: r.model, target: r.target, peer: "", lane: r.lane, caller, tokens: 0, images: false, tools: false,
        flow: a.flow, line: a.step + 1, reason: r.reason, outcome: "decided", ms: 0, error: "", backend: r.target === "local" ? this.pool.models.for(r.model).name : "", id: "", queuedMs: 0, ranMs: 0,
      });
    }
  }

  /** What a flow reads about this node, for a request with these needs. */
  worldFor(caller: string, lane: string, need: World["need"], from: HearthConfig = this.rulesFor(caller), headers: World["headers"] = {}): World {
    return {
      cfg: from, peers: this.peers, caller, lane, need, headers,
      local: (m) => localLoad(this.pool.models.for(m), m),
      held: (m, l) => this.pool.hardware.heldOff(this.pool.models.for(m).cfg, l),
      ready: (m) => this.ready(m),
      inFlight: (flow, step) => this.stepsBusy.get(`${flow}\0${step}`) ?? 0,
      idleMs: (m) => this.idleMs(m),
    };
  }
}
