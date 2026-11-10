/**
 * What the console reads: the page and its event stream (a snapshot, then diffs), the caller's
 * own queue as events, and the Keys, Lending and Usage pages' data.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { DEFAULT_ROUTER } from "../config/flows.js";
import { json, keyId } from "../wire/http.js";
import { termsFor } from "../peers/lending.js";
import { LIVE_KINDS, LIVE_STAGES, placements } from "../plugins/plugins.js";
import { type ReachType, reachOf } from "../routing/reach.js";
import { flowsOf } from "../routing/route.js";
import { CONSOLE_CSP, CONSOLE_HTML } from "../ui.js";
import { KEEP_DAYS, Usage } from "../observe/usage.js";
import { type CallerUse, type KeyInfo, type LedgerRow, createViews } from "../observe/views.js";
import type { Call, RouteContext } from "./context.js";
import type { UiData } from "../observe/uidata.js";

export function consoleRoutes(ctx: RouteContext, { proxying }: { proxying: ReadonlySet<{ id: string; backend: string; model: string | null }> }) {
  const { cfg, pool, peers, plugins, controls, config, canary, usage, borrowed, history, callers, limits, worlds, requests, notWork, lifecycle } = ctx;

  /**
   * The caller's own jobs, pushed: a snapshot on connect, then the list again whenever it changes
   * (queued, started, finished, moved in line). One connection serves every job a client has.
   */
  const queueStreams = new Map<ServerResponse, { caller: string; last: string }>();
  const callerJobs = (caller: string) =>
    pool.jobs().filter((j) => j.caller === caller).map((j) => ({
      id: j.id, state: j.state, position: j.position, lane: j.lane, model: j.model,
      backend: j.backend, ...(j.peer ? { peer: j.peer } : {}), since: j.since,
    }));
  function pushJobs(res: ServerResponse, s: { caller: string; last: string }, event: "snapshot" | "jobs"): void {
    const body = JSON.stringify({ jobs: callerJobs(s.caller) });
    if (event === "jobs" && body === s.last) return;
    s.last = body;
    res.write(`event: ${event}\ndata: ${body}\n\n`);
  }
  let jobsPending = false;
  pool.onJobs(() => {
    if (jobsPending || queueStreams.size === 0) return;
    // A burst of changes in one tick goes out as one update.
    jobsPending = true;
    queueMicrotask(() => {
      jobsPending = false;
      for (const [res, s] of queueStreams) pushJobs(res, s, "jobs");
    });
  });

  async function routeQueueEvents(c: Call): Promise<void> {
    const { res } = c;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    notWork(res);
    const s = { caller: c.caller, last: "" };
    queueStreams.set(res, s);
    pushJobs(res, s, "snapshot");
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    ping.unref();
    res.on("close", () => {
      clearInterval(ping);
      queueStreams.delete(res);
    });
  }

  async function routeQueue(c: Call): Promise<void> {
    const { res } = c;
    json(res, 200, {
      jobs: pool.jobs(),
      // Narrowed to what the loaded model can hold.
      capacity: pool.loadedAggregate(),
      backends: pool.all().map((b) => ({ name: b.name, ...pool.loadedCapacity(b) })),
    });
    return;
  }

  /** The keys page's rows: every key by its label and scope, with the last time it spoke to this node. */
  const keysView = (): KeyInfo[] => {
    const jobs = pool.jobs();
    const reached = new Map<string, ReachType[]>();
    return cfg.apiKeys.map((k, i) => {
      const caller = "key:" + (cfg.apiKeyLabels[i] || keyId(k));
      const router = worlds.routerNameOf(caller);
      if (!reached.has(router)) reached.set(router, reachOf(cfg, flowsOf(worlds.rulesFor(caller))));
      const now: KeyInfo["now"] = {};
      for (const j of jobs) {
        if (j.caller !== caller) continue;
        const n = (now[j.model] ??= { running: 0, waiting: 0 });
        if (j.state === "running") n.running++;
        else n.waiting++;
      }
      const rule = cfg.apiKeyRules[i] ?? null;
      return {
        label: cfg.apiKeyLabels[i] ?? "", id: keyId(k), models: cfg.apiKeyModels[i] ?? null, lastSeen: callers.lastSeen(caller), today: limits.spent(caller, 1), month: limits.spent(caller, KEEP_DAYS), rule,
        router, reach: reached.get(router)!, lane: rule?.lane ?? null, byModel: { today: usage.byModel(caller, 1), month: usage.byModel(caller, KEEP_DAYS) }, now,
      };
    });
  };

  /** Whoever else used this node in the last month: this machine with no key, and peers. */
  const othersView = (): CallerUse[] => {
    const keys = new Set(cfg.apiKeys.map((k, i) => "key:" + (cfg.apiKeyLabels[i] || keyId(k))));
    return usage.callers().filter((c) => !keys.has(c)).map((caller) => ({ caller, today: limits.spent(caller, 1), month: limits.spent(caller, KEEP_DAYS) }));
  };

  /** The ledger: every peer with what it ran here, what this node ran there, and whether its limits let it in now. */
  const ledgerView = (): LedgerRow[] =>
    [...new Set([...Object.keys(cfg.peerTokens), ...cfg.peers.map((p) => p.name)])].sort().map((peer) => ({
      peer,
      lent: { today: usage.total(`peer:${peer}`, 1), month: usage.total(`peer:${peer}`, KEEP_DAYS) },
      borrowed: { today: borrowed.total(peer, 1), month: borrowed.total(peer, KEEP_DAYS) },
      // Only a peer with a token can be lent to, so only one has limits to be held to.
      ...(peer in cfg.peerTokens ? {
        terms: termsFor(cfg, peer),
        own: Object.keys(cfg.peerTerms[peer] ?? {}).filter((k) => k !== "off" && k !== "limits"),
        closed: controls.lendingOn ? limits.closedTo(peer) : "lending is paused",
        lentToday: Object.fromEntries(Object.entries(usage.byModel(`peer:${peer}`, 1)).map(([m, r]) => [m, r.in + r.out])),
      } : {}),
      ...receivedFrom(peer),
    }));

  /** What this node borrows from `peer`, with the limits it reported for each model on its last reading. */
  const receivedFrom = (peer: string): Pick<LedgerRow, "received"> => {
    const p = cfg.peers.find((x) => x.name === peer);
    if (!p) return {};
    const models = peers.get(peer)?.capacity?.models;
    return { received: Object.fromEntries(Object.entries(p.models).map(([mine, theirs]) => {
      const terms = models?.[theirs]?.terms;
      return [mine, { theirs, ...(terms ? { terms } : {}) }];
    })) };
  };

  /** One caller's tokens for each day kept; a day with none is absent. */
  const tokensByDay = (book: Usage, caller: string): Record<string, number> =>
    Object.fromEntries(Object.entries(book.since()).flatMap(([day, callers]) => {
      const n = Object.values(callers[caller] ?? {}).reduce((sum, r) => sum + r.in + r.out, 0);
      return n > 0 ? [[day, n]] : [];
    }));

  // The ledger, with each peer's use by model and by day, which the page's own stream leaves out.
  async function routeLending(c: Call): Promise<void> {
    json(c.res, 200, {
      days: KEEP_DAYS,
      peers: ledgerView().map((row) => ({
        ...row,
        byModel: { lent: usage.byModel(`peer:${row.peer}`, KEEP_DAYS), borrowed: borrowed.byModel(row.peer, KEEP_DAYS) },
        byDay: { lent: tokensByDay(usage, `peer:${row.peer}`), borrowed: tokensByDay(borrowed, row.peer) },
      })),
    });
  }

  // What was used, by whom: the last `days` days (31 at most) as day -> caller -> model -> counts.
  async function routeUsage(c: Call): Promise<void> {
    const days = Math.min(KEEP_DAYS, Math.max(1, Number(c.url.searchParams.get("days")) || KEEP_DAYS));
    const prices = Object.fromEntries(Object.entries(cfg.models).flatMap(([id, m]) => (m.price ? [[id, m.price]] : [])));
    json(c.res, 200, { days, usage: usage.since(days), prices });
  }

  /** A caller id like `operator:admin` is the login the page can show and sign out of. */
  const opOf = (caller: string): string | null => (caller.startsWith("operator:") ? caller.slice(9) : null);

  async function routeUi(c: Call): Promise<void> {
    const { req, res, path } = c;
    // The event stream shares the page's address-based gate.
    if (path === "/ui/events") {
      await serveUiEvents(req, res, opOf(c.caller));
      return;
    }
    await serveUi(path, res, opOf(c.caller));
  }

  /**
   * How the page may write: "open" when apiKeys is empty (loopback is trusted), "key" when writes
   * need a bearer key, which the page asks for.
   */
  const writeMode = (): "open" | "key" => (cfg.apiKeys.length === 0 ? "open" : "key");

  /**
   * The page pushed over SSE: one snapshot, then diffs of the same object /ui/data serves, with
   * history appended. `operator` is per request and never in a patch.
   */
  const streams = new Set<ServerResponse>();
  let lastSent: UiData | null = null;
  let uiTimer: ReturnType<typeof setInterval> | null = null;
  let lastFlushAt = 0;

  /** 1s: a quiet tick sends nothing. */
  const UI_TICK_MS = 1_000;
  /** Comment frames keep an idle connection alive through anything that times
   *  out a quiet socket. Nothing should be between us and the browser, but a
   *  stream that dies silently after 60s is a bad way to find out otherwise. */
  const UI_PING_MS = 15_000;

  /** Items appended to `prev` (a ring may drop from the front), compared by value; null if not an append. */
  function appendedTail(prev: unknown[], next: unknown[]): unknown[] | null {
    if (prev.length === 0) return null;
    const last = JSON.stringify(prev[prev.length - 1]);
    for (let i = next.length - 1; i >= 0; i--) {
      if (JSON.stringify(next[i]) === last) return next.slice(i + 1);
    }
    return null;
  }

  /** What changed between two payloads, key by key, with `hist` sent as what was appended to it. */
  function uiDiff(prev: UiData, next: UiData): { set?: Partial<UiData>; add?: { hist: UiData["hist"] } } | null {
    const before: Record<string, unknown> = { ...prev };
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      if (k === "hist" || k === "operator") continue;
      if (JSON.stringify(v) !== JSON.stringify(before[k])) set[k] = v;
    }
    let add: { hist: UiData["hist"] } | undefined;
    const ph = prev.hist ?? [];
    const nh = next.hist ?? [];
    if (JSON.stringify(ph) !== JSON.stringify(nh)) {
      const tail = appendedTail(ph, nh);
      // A tail of nothing means the ring rolled without gaining anything, which
      // cannot happen -- but sending `add: {hist: []}` would be a frame saying
      // nothing, so treat it as no change rather than as a resync.
      if (tail && tail.length > 0) add = { hist: tail as UiData["hist"] };
      else if (!tail) set.hist = nh;
    }
    if (Object.keys(set).length === 0 && !add) return null;
    return { ...(Object.keys(set).length ? { set } : {}), ...(add ? { add } : {}) };
  }

  function writeFrame(res: ServerResponse, event: string, data: unknown): void {
    // Backpressure ignored: a slow reader loses freshness, never buffers memory.
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** The baseline, built at most once at a time: overlapping builds join, so the diff baseline never regresses. */
  let inBuild: Promise<UiData> | null = null;

  function build(): Promise<UiData> {
    inBuild ??= uiPayload()
      .then((d) => { lastSent = d; return d; })
      .finally(() => { inBuild = null; });
    return inBuild;
  }

  async function broadcast(): Promise<void> {
    // A build already in flight will publish a fresher baseline than this tick
    // could, and the next tick diffs from it. Skipping costs a second.
    if (streams.size === 0 || inBuild) return;
    const prev = lastSent;
    const next = await build();
    const patch = prev ? uiDiff(prev, next) : null;
    if (patch) {
      for (const res of streams) writeFrame(res, "patch", patch);
      lastFlushAt = Date.now();
      return;
    }
    if (Date.now() - lastFlushAt >= UI_PING_MS) {
      for (const res of streams) res.write(": ping\n\n");
      lastFlushAt = Date.now();
    }
  }

  async function serveUiEvents(req: IncomingMessage, res: ServerResponse, operator: string | null): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    // An open stream is not work in flight. Without this every page left open
    // in a tab would hold a shutdown for the whole drain, which is the exact
    // failure the drain was added to prevent, arriving by a different door.
    notWork(res);

    // The same baseline the patches will be diffed against, or this page
    // applies deltas to a snapshot the server never recorded.
    const snapshot = lastSent ?? await build();
    writeFrame(res, "snapshot", { ...snapshot, operator });
    lastFlushAt = Date.now();

    streams.add(res);
    if (uiTimer === null) {
      uiTimer = setInterval(() => void broadcast(), UI_TICK_MS);
      uiTimer.unref?.();
    }
    const drop = (): void => {
      streams.delete(res);
      // Nobody watching, nothing to build. The payload is only assembled while
      // a page is actually open.
      if (streams.size === 0 && uiTimer !== null) {
        clearInterval(uiTimer);
        uiTimer = null;
        lastSent = null;
      }
    };
    res.on("close", drop);
    req.on("aborted", drop);
  }

  /** The page and its data. */
  async function serveUi(path: string, res: ServerResponse, operator: string | null): Promise<void> {
    if (path === "/ui/data") {
      // One payload rather than three fetches. It also means /network and
      // /queue keep their own auth gate untouched: nothing here relaxes them,
      // the page simply does not use them.
      json(res, 200, await uiPayload(operator));
      return;
    }
    const html = CONSOLE_HTML;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      // It is a live status page; a cached copy is a lie.
      "Cache-Control": "no-store",
      "Content-Security-Policy": CONSOLE_CSP,
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    res.end(html);
  }

  const { uiPayload, networkView } = createViews({
    cfg, pool, peers, history, controls, config, proxying, writeMode,
    shared: (peer?: string) => limits.shared(peer),
    flowHits: () => worlds.flowHits(),
    // Drawn whether or not it is on, so "not configured" and "configured and
    // quiet" are not the same blank tile.
    canary: () => canary?.page() ?? { enabled: false, passive: false, recovery: false, models: {} },
    keys: keysView,
    others: othersView,
    ledger: ledgerView,
    lendDefaults: () => ({ tokensPerDay: cfg.lendTokensPerDay, maxConcurrent: cfg.peerMaxConcurrent, rateLimit: cfg.peerRateLimit }),
    update: () => lifecycle.update,
    recent: () => requests.recent(),
    plugins: () => {
      // The callers the console draws everywhere: everyone else, this machine, and each labelled key.
      const callers = ["*", "local", ...cfg.apiKeyLabels.filter(Boolean)];
      const routerOfCaller = (c: string) => cfg.callers[c] ?? cfg.callers["*"] ?? DEFAULT_ROUTER;
      /** The settings a router's own entry changes, by name only: a value can be a secret. */
      const changed = (plugin: string, own: Record<string, unknown>) => {
        const global = cfg.plugins[plugin]?.config ?? {};
        return [...new Set([...Object.keys(global), ...Object.keys(own)])].filter((k) => JSON.stringify(global[k]) !== JSON.stringify(own[k])).sort();
      };
      return {
        plugins: plugins.status(),
        // Where each plugin is placed, and what each line wires into its slots.
        placed: placements(cfg).map((x) => ({ plugin: x.plugin.name, ...x.line, kind: x.kind, models: x.plugin.models })),
        // What each model takes, for the slot pickers; a model not listed is chat.
        modelKinds: cfg.modelKinds,
        liveKinds: [...LIVE_KINDS],
        liveStages: [...LIVE_STAGES],
        pending: config.pluginChanges(),
        routers: Object.fromEntries([DEFAULT_ROUTER, ...Object.keys(cfg.routers).filter((n) => n !== DEFAULT_ROUTER)].map((name) => [name, {
          plugins: Object.fromEntries(Object.entries(cfg.routers[name]?.plugins ?? {}).map(([p, v]) => [p, v === "off" ? "off" : "own"])),
          changes: Object.fromEntries(Object.entries(cfg.routers[name]?.plugins ?? {}).flatMap(([p, v]) => (v === "off" ? [] : [[p, changed(p, v.config)]]))),
          callers: callers.filter((c) => routerOfCaller(c) === name),
        }])),
      };
    },
  });

  /** End every open event stream, so pages start reconnecting at once. */
  function closeStreams(): void {
    for (const res of streams) res.end();
    for (const res of queueStreams.keys()) res.end();
    streams.clear();
  }

  return { routeQueue, routeQueueEvents, routeLending, routeUsage, routeUi, broadcast, closeStreams, networkView };
}
