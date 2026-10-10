/**
 * The read model: what /network, /control and the status page show, derived from live state
 * per call. Its only effects are freshening peers and sampling declared activity for the page.
 */
import type { HearthConfig, RoutePolicy } from "./config.js";
import type { Controls } from "./controls.js";
import { KEEP, type History } from "./history.js";
import type { ConfigFile } from "./configfile.js";
import type { PeerRegistry } from "./peers.js";
import type { BackendPool } from "./pool.js";
import type { ModelStats } from "./stats.js";

/** One watched model, as the page draws it. */
export interface CanaryModelView {
  backend: string;
  health: "ok" | "degraded";
  failures: number;
  lastProbeAt: number;
  /** Why it is out, when it is. */
  reason: string | null;
  detail: string | null;
  /** A bounded sample of the bad output. */
  sample: string | null;
  since: number | null;
  /** A recovery drop happened and a clean probe has not confirmed the reload. */
  reloadPending: boolean;
  recoveryCount: number;
}

/** The canary, for the page. Always present, so "off" is visible rather than blank. */
export interface CanaryView {
  enabled: boolean;
  /** Watching relayed traffic as well as probing. */
  passive: boolean;
  /** The gentle recovery is armed. */
  recovery: boolean;
  models: Record<string, CanaryModelView>;
}

export interface ViewDeps {
  cfg: HearthConfig;
  pool: BackendPool;
  peers: PeerRegistry;
  history: History;
  controls: Controls;
  config: ConfigFile;
  /** What we lend right now. */
  shared: () => readonly string[];
  /** Requests proxied right now without queueing. */
  proxying: ReadonlySet<{ id: string; backend: string; model: string | null }>;
  /** How the page must authenticate its writes. */
  writeMode: () => "open" | "key";
  /** The canary's state, and whether one is configured at all. */
  canary: () => CanaryView;
}

export function createViews({ cfg, pool, peers, history, controls, config, shared, proxying, writeMode, canary }: ViewDeps) {
  /**
   * Everything the page draws, shared by /ui/data and the event stream. Uses ensureFresh, never probeAll.
   */
  async function uiPayload(operator: string | null = null): Promise<Record<string, unknown>> {
    await peers.ensureFresh();
    // Declared activity paths are read only while a page is building data, never on a timer.
    for (const b of pool.all()) void pool.sampleActivity(b);
    return {
      // Who this request signed in as, so the page can show it and offer a sign-out;
      // loopback and key callers are nobody in particular.
      operator,
      // How this page must authenticate its writes.
      control: writeMode(),
      controls: controls.state(),
      // What the sharing and mapping controls need.
      share: shared(),
      configuredShare: cfg.share,
      // Where every edit lands, and what is waiting on a restart; replaces the old pending-changes block.
      config: config.status(),
      catalog: pool.catalog(),
      // The canary's verdict per model. Present even when no canary is
      // configured, so the page can say "off" instead of drawing nothing.
      canary: canary(),
      contexts: (() => {
        const out: Record<string, number> = {};
        for (const id of pool.catalog()) {
          const ctx = pool.contextLength(id);
          if (ctx !== null) out[id] = ctx;
        }
        return out;
      })(),
      // Advertised id -> `as`: the page folds variants under their parent and shows renames as-is.
      aliases: aliasView(),
      // Where each id may go, and whether it falls back home.
      routing: routingView(),
      net: networkView(),
      q: {
        jobs: pool.jobs(),
        capacity: pool.loadedAggregate(),
        // Per-backend capacity is not repeated here: `net.nodes[self].backends`
        // already carries it along with everything else about a backend, and
        // this frame is diffed and pushed on every change.
      },
      hist: history.all(),
      // Every call that ran here in the same window, so the page can draw the
      // lanes per request rather than per 5s reading, and say how long each took.
      calls: history.calls(),
      // How many samples the ring holds. The stream sends new samples one at a
      // time and the page trims to this, so its history stays the same length
      // as ours instead of growing for as long as the tab is open.
      histKeep: KEEP,
    };
  }

  /** Advertised id -> how it routes, including runtime links. */
  function routingView(): Record<string, {
    policy: RoutePolicy; peers: string[]; fallbackLocal: boolean; spilloverAt: number;
  }> {
    const out: Record<string, {
      policy: RoutePolicy; peers: string[]; fallbackLocal: boolean; spilloverAt: number;
    }> = {};
    for (const [id, m] of Object.entries(cfg.models)) {
      out[id] = {
        policy: m.policy,
        peers: [...m.peers],
        fallbackLocal: m.fallbackLocal,
        spilloverAt: m.spilloverAt,
      };
    }
    return out;
  }

  /** advertised id -> `as`, for every model that declares one. */
  function aliasView(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, m] of Object.entries(cfg.models)) if (m.as) out[id] = m.as;
    return out;
  }
  
  /** Who serves what, in our ids; peer models we have not mapped are listed separately. */
  function networkView() {
    const cap = pool.loadedAggregate();
    // How many of our jobs each peer is running right now, so an edge can show
    // live flow rather than just "configured".
    const sendingTo = new Map<string, number>();
    for (const j of pool.jobs()) {
      if (j.offbox && j.peer) sendingTo.set(j.peer, (sendingTo.get(j.peer) ?? 0) + 1);
    }

    // Stats per node, since two nodes can serve one id with different windows.
    const selfStats: Record<string, ModelStats> = {};
    // Route models too: for a `kind: none` backend a declaration is all that is known. Reported, not enforced.
    const named = new Set(pool.catalog());
    for (const b of pool.all()) {
      for (const r of b.cfg.routes) if (r.model !== "") named.add(r.model);
    }
    for (const m of named) {
      const st = pool.statsFor(m);
      if (st) selfStats[m] = st;
    }

    const nodes: Record<string, unknown>[] = [
      {
        name: cfg.name,
        self: true,
        up: true,
        serves: pool.catalog(),
        loaded: pool.loaded(),
        stats: selfStats,
        free: cap.free,
        slots: cap.slots,
        queued: Object.values(cap.queued).reduce((a, b) => a + b, 0),
        // Per backend, because on a multi-backend node the totals above are a
        // summary and this is the thing you actually want to look at.
        backends: pool.all().map((b) => {
          const c = pool.loadedCapacity(b);
          return {
            name: b.name,
            url: b.cfg.url,
            kind: b.cfg.kind,
            // Whether it CAN report warm state. An empty loaded list from a
            // backend that cannot see is not the same claim as one from a
            // backend that looked, and the page must not render it as such.
            knowsWarm: b.state.knowsWarm(),
            // Only where we hold an event stream; omitted elsewhere, since silence there means nothing.
            ...(b.state.watched() ? { answering: b.state.answering() } : {}),
            // Sent whenever declared, including unread (ok:false), which the page shows as unknown.
            ...(b.cfg.activity ? { activity: b.state.activity() } : {}),
            // Which lanes this backend keeps off its hardware while its app is in use, and whether it does so now.
            ...(b.cfg.hold ? { hold: { lanes: [...b.cfg.hold.lanes], idleMs: b.cfg.hold.idleMs, active: pool.holds().some((h) => h.backend === b.name && h.active), quietMs: b.state.quietMs() } } : {}),
            // Only a kind that unloads evicts; one that keeps its set resident has no thrash to warn about.
            evicts: b.state.canUnload(),
            slots: c.slots,
            free: c.free,
            queued: Object.values(c.queued).reduce((a, x) => a + x, 0),
            // Only what is actually resident, mapped back into advertised ids.
            loaded: b.cfg.serves.length
              ? [...b.cfg.serves].filter((m) => b.state.isWarm(pool.outboundId(m)))
              : b.state.loaded(),
            // Models loading off the disk, and where resident weights sit; both advertised ids.
            offload: [...b.state.placement()].map(([wire, p]) => ({
              model: pool.advertised(wire),
              cpuLayers: p.cpuLayers,
              cpuExpertsAll: p.cpuExpertsAll,
              cpuOnly: p.cpuOnly,
            })),
            loading: b.cfg.serves.length
              ? [...b.cfg.serves].filter((m) => b.state.loading().includes(pool.outboundId(m)))
              : b.state.loading(),
            // Unqueued work we are proxying for this backend right now. Real
            // traffic, no admission — see `proxying` above.
            proxying: [...proxying]
              .filter((x) => x.backend === b.name)
              .map((x) => ({ id: x.id, model: x.model })),
            serves: b.cfg.serves.length ? [...b.cfg.serves] : b.state.catalog(),
            // The hardware this backend consumes. Empty for a backend that
            // competes for nothing, which is every backend in a config that
            // never declared any.
            resources: [...b.cfg.resources],
            // A non-OpenAI backend has no serves list, so its routes say what it does.
            routes: b.cfg.routes.map((r) => ({
              path: r.path,
              model: r.model,
              lane: r.lane,
              queue: r.queue,
            })),
          };
        }),
      },
    ];

    // Ready now means loaded somewhere reachable. Loaded but busy still counts,
    // because warm-and-queued beats cold-and-idle on anything large, and
    // merging the two would hide the distinction this endpoint exists for.
    const readyNow = new Set(pool.loaded());
    const available = new Set(pool.catalog());

    for (const p of peers.all()) {
      const theirs = peers.config(p.name);
      if (!theirs) continue;
      // their id -> my id, for everything I've mapped to them
      const toMine = new Map(Object.entries(theirs.models).map(([mine, t]) => [t, mine]));
      const theirLoaded = p.capacity?.loaded ?? [];
      const theirServes = p.capacity?.serves ?? [];

      const mappedLoaded = theirLoaded.map((m) => toMine.get(m)).filter((m): m is string => !!m);
      const mappedServes = theirServes.map((m) => toMine.get(m)).filter((m): m is string => !!m);
      const unmapped = theirServes.filter((m) => !toMine.has(m));

      const peerStats: Record<string, ModelStats> = {};
      for (const [mine, theirId] of Object.entries(theirs.models)) {
        const st = peers.statsFor(p.name, theirId);
        if (st) peerStats[mine] = st;
      }

      if (p.up) {
        for (const m of mappedLoaded) readyNow.add(m);
        for (const m of mappedServes) available.add(m);
      }

      nodes.push({
        name: p.name,
        self: false,
        up: p.up,
        serves: mappedServes,
        loaded: mappedLoaded,
        unmapped,
        // What the config lets us send here, in our ids, even while the peer is unreachable.
        configured: Object.keys(theirs.models).sort(),
        // The effective mapping, my id -> theirs, runtime links included.
        map: { ...theirs.models },
        // Keyed by OUR id, like everything else about a peer on this payload,
        // so the page never has to know their vocabulary. Empty for a peer
        // speaking protocol 1 or one that has not loaded the model yet.
        stats: peerStats,
        free: p.capacity?.free ?? null,
        slots: p.capacity?.slots ?? null,
        queued: p.capacity
          ? Object.values(p.capacity.queued).reduce((a, b) => a + b, 0)
          : null,
        sending: sendingTo.get(p.name) ?? 0,
        lastError: p.up ? null : p.lastError,
      });
    }

    // Models on a backend that cannot report warmth. Neither warm nor cold, and
    // saying "something has to load first" about them would be a claim we have
    // no basis for.
    const unknownWarm = new Set<string>();
    for (const b of pool.all()) {
      if (b.state.knowsWarm()) continue;
      for (const m of b.cfg.serves.length ? b.cfg.serves : b.state.catalog()) {
        if (!readyNow.has(m)) unknownWarm.add(m);
      }
    }

    return {
      nodes,
      // The scarce thing. A backend is an admission domain; a card is what
      // decides whether an admission domain may run at all, and it belongs at
      // the top of the payload rather than inferred from a list of backends.
      resources: pool.resources(),
      // What the last few handoffs cost somebody.
      evictions: pool.evictions(),
      // Hardware kept for an app hearth does not schedule; a client can read this to plan around it.
      holds: pool.holds(),
      readyNow: [...readyNow].sort(),
      available: [...available].sort(),
      unknownWarm: [...unknownWarm].sort(),
      // Does anything here actually evict? If nothing does, the status page
      // should not talk about model thrash.
      evicts: pool.all().some((b) => b.state.canUnload()),
    };
  }

  return { uiPayload, networkView };
}
