/**
 * The node: builds the services, puts every route in one table with the credential it needs, and
 * runs the HTTP server's lifecycle (request ids, the cross-origin and rebinding guards, the drain
 * on close). What each route does lives in `routes/`; who a caller is lives in `callers.ts`.
 */
import { isIP } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";

import { Refusal } from "./errors.js";
import { Answers } from "./wire/answers.js";
import { Callers, isLoopback } from "./access/callers.js";
import { createCanary, degradedError } from "./observe/canary.js";
import type { BackendConfig } from "./config/backends.js";
import type { HearthConfig } from "./config/config.js";
import { ConfigFile, ConfigRefusal, deepFreeze, writeFileAtomic } from "./config/configfile.js";
import { Controls } from "./peers/controls.js";
import { DAY_MS, History } from "./observe/history.js";
import { apiError, bearer, fail, json, readBody, readJson, refuse, type Envelope } from "./wire/http.js";
import { Limits } from "./access/limits.js";
import { LogRing, type Logger } from "./observe/log.js";
import { PeerRegistry } from "./peers/peers.js";
import { Plugins } from "./plugins/plugins.js";
import { BackendPool } from "./queue/pool.js";
import { RequestLog } from "./observe/requestlog.js";
import { tailscaleWhois } from "./peers/tailscale.js";
import { Usage } from "./observe/usage.js";
import { Worlds } from "./routing/world.js";
import { adminRoutes } from "./routes/admin.js";
import { chatRoutes } from "./routes/chat.js";
import { consoleRoutes } from "./routes/console.js";
import type { Call, Handler, RouteContext } from "./routes/context.js";
import { joinRoutes } from "./routes/join.js";
import { keyRoutes } from "./routes/keys.js";
import { loginRoutes } from "./routes/login.js";
import { modelRoutes } from "./routes/models.js";
import { passthroughRoutes } from "./routes/passthrough.js";
import { peerRoutes } from "./routes/peer.js";
import { pluginRoutes } from "./routes/plugins.js";

export type { RecentCall } from "./observe/requestlog.js";

/** The shape of the history file this build writes, and the latest it reads. */
const HISTORY_VERSION = 1;

export interface HearthNode {
  server: Server;
  /** The local backends and their queues. One entry unless `backends:` is used. The node's own machinery, as are the next two: not held steady between releases. */
  pool: BackendPool;
  peers: PeerRegistry;
  history: History;
  /** Start watching backends and polling peers. Call before listen(); without it the node silently routes everything locally. */
  start: () => void;
  /** Stop, letting in-flight requests finish for up to `graceMs` (default 0 destroys them). */
  close: (graceMs?: number) => Promise<void>;
  /** What `POST /restart` calls; set by `hearth serve`, null when nothing could start the node again. */
  onRestart: (() => void) | null;
  /** The node's logger: stdout, plus the console's Logs page. */
  log: Logger;
  /** A newer published hearth, for the console to mention; set by `hearth serve`. */
  update: string | null;
  /** Loads `plugins:`. Await it before listening, so no request runs before a locked plugin is in place. */
  startPlugins: () => Promise<void>;
  plugins: Plugins;
}

export function createNode(cfg: HearthConfig, baseLog: Logger, opts: { plugins?: boolean } = {}): HearthNode {
  // Every line still goes to stdout; the ring keeps the recent ones for the console's Logs page.
  const logs = new LogRing();
  const log = logs.tap(baseLog);
  const plugins = new Plugins(cfg, log, {
    off: opts.plugins === false,
    selfUrl: () => `http://${cfg.listen.host === "0.0.0.0" || cfg.listen.host === "::" ? "127.0.0.1" : cfg.listen.host}:${cfg.listen.port}`,
  });
  // ConfigFile swaps the live keys in whole and everything reads those per call; the rest changes
  // only with a restart, so an accidental write throws instead of going stale.
  for (const part of [cfg.listen, cfg.backends, cfg.scheduler, cfg.resources,
                      cfg.apiKeys, cfg.apiKeyLabels, cfg.apiKeyModels, cfg.apiKeyRules, cfg.peerTokens]) deepFreeze(part);
  // One state and one queue per backend. Pushed over SSE where the backend
  // supports it, polled where it doesn't.
  const pool = new BackendPool(cfg, log);
  // Pause switches for the two federation directions. Passed to the registry so a
  // borrowing pause removes every peer from routing at source.
  const controls = new Controls();
  const peers = new PeerRegistry(cfg, log, controls);
  // hearth.yaml as the only config state: edits write the file and apply live.
  // Peers apply live, so the registry follows every edit before the status surfaces hear of it.
  const config = new ConfigFile(cfg, log, () => {
    peers.sync();
    // New lanes and order settings, and a changed key limit, apply to jobs already waiting.
    pool.retune(cfg.scheduler);
    pool.kickAll();
    queueMicrotask(() => ctx.broadcast());
  });
  if (cfg.stateFile) config.migrateSidecar(cfg.stateFile);

  /** The opt-in canary, or null when `canary:` is not configured. */
  const canary = createCanary(cfg, pool, log);
  const usage = new Usage();
  const borrowed = new Usage();
  const history = new History(() => {
    const agg = pool.aggregate();
    return {
      queued: Object.values(agg.queued).reduce((a, b) => a + b, 0),
      // Several backends means several models warm at once, so this is a list.
      residents: pool.models.loaded(),
      // What is being USED, as opposed to what is loaded: models with a job
      // running on a local backend at this instant. Off-box jobs are a peer's
      // activity, not ours. Finished calls are recorded as they end.
      active: [...new Set(pool.jobs().filter((j) => j.state === "running" && !j.offbox).map((j) => j.model))],
      perBackend: pool.all().map((b) => {
        const c = b.scheduler.capacity();
        return {
          name: b.name,
          queued: Object.values(c.queued).reduce((a, x) => a + x, 0),
          resident: b.state.resident(),
        };
      }),
    };
  });
  const callers = new Callers(cfg);
  const worlds = new Worlds(cfg, pool, peers, log);
  const limits = new Limits(cfg, pool, controls, usage, callers, worlds);
  const requests = new RequestLog(cfg, log, history, usage, borrowed);

  /** Requests being served now, for the drain in `close()`; counts requests, not queued jobs. */
  let inFlight = 0;
  let drained: (() => void) | null = null;
  /** Responses that are open but are not work — the event stream. */
  const parked = new WeakSet<ServerResponse>();

  const ctx: RouteContext = {
    cfg, log, logs, pool, peers, plugins, controls, config, canary, usage, borrowed, history,
    answers: new Answers(),
    callers, limits, worlds, requests,
    whois: tailscaleWhois(cfg.tailscaleSocket),
    readJson: (req) => readJson(req, cfg.maxBodyBytes),
    readBody: (req) => readBody(req, cfg.maxBodyBytes),
    failConfig: (res, e) => {
      if (e instanceof ConfigRefusal) json(res, e.status, { error: { message: e.message, type: "invalid_request_error", path: e.path } });
      else fail(res, e);
    },
    degraded: (model) => {
      const sick = canary?.refuse(model);
      if (sick === undefined || sick === null) return null;
      const { message, fields } = degradedError(model, pool.models.for(model).name, sick);
      return new Refusal(503, message, "server_error", fields);
    },
    backendDeadline: (b: BackendConfig) => {
      const first = b.firstByteMs ?? cfg.backendFirstByteMs;
      const idle = b.idleMs ?? cfg.backendIdleMs;
      return { ...(first > 0 ? { headersTimeoutMs: first } : {}), ...(idle > 0 ? { idleTimeoutMs: idle } : {}) };
    },
    broadcast: () => void consoleArea.broadcast(),
    notWork: (res) => {
      if (parked.has(res)) return;
      parked.add(res);
      if (--inFlight === 0) drained?.();
    },
    // Set through the node by `hearth serve` once it is made.
    lifecycle: { onRestart: null, update: null },
  };

  const passArea = passthroughRoutes(ctx);
  const consoleArea = consoleRoutes(ctx, { proxying: passArea.proxying });
  const chatArea = chatRoutes(ctx);
  const modelArea = modelRoutes(ctx);
  const peerArea = peerRoutes(ctx);
  const adminArea = adminRoutes(ctx, { networkView: consoleArea.networkView });
  const keyArea = keyRoutes(ctx);
  const joinArea = joinRoutes(ctx);
  const loginArea = loginRoutes(ctx);
  const pluginArea = pluginRoutes(ctx);

  const server = createServer((req, res) => {
    inFlight++;
    // "close" rather than "finish": it fires for a response that ended and for
    // a client that hung up, which are the same thing to a drain and would
    // otherwise leak the count upward until nothing could ever finish waiting.
    res.on("close", () => {
      if (parked.has(res)) return;
      if (--inFlight === 0) drained?.();
    });
    // Sent back on every answer, and on this request's line in the log, so the two can be matched.
    const id = "req_" + randomBytes(8).toString("hex");
    res.setHeader("X-Request-Id", id);
    void requests.run(id, req, () => handle(req, res)).catch((e) => {
      log.error("request.failed", { id, error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) apiError(res, 500, "internal error", "server_error");
      else res.end();
    });
  });

  /**
   * Refuse a write carrying a foreign `Origin`: any web page can POST to loopback, and loopback is
   * trusted. curl, peers and apps send no Origin and are unaffected. `null` is what a sandboxed
   * frame or a redirected form sends, and is as foreign as any other.
   */
  function crossOriginWrite(req: IncomingMessage): boolean {
    if (req.method === "GET" || req.method === "HEAD") return false;
    const origin = req.headers.origin;
    if (origin === undefined) return false;
    try {
      return new URL(origin).host !== req.headers.host;
    } catch {
      // An Origin we cannot parse is not one we can vouch for.
      return true;
    }
  }

  /**
   * A loopback caller that asked for this node by a name: a page elsewhere whose name was
   * re-pointed at 127.0.0.1, which the address gate would take for this machine. An address
   * cannot be re-pointed, and `localhost` never leaves the machine.
   */
  function reboundHost(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (host === undefined || !isLoopback(req)) return false;
    let name: string;
    try {
      name = new URL(`http://${host}`).hostname;
    } catch {
      return true;
    }
    return !(name.startsWith("[") || isIP(name) !== 0 || name === "localhost" || name.endsWith(".localhost"));
  }

  /** Who a route lets in, declared per path rather than re-derived in each handler. */
  type Auth =
    /** No credential at all. Only /healthz, which is built to say nothing. */
    | "open"
    /** By address, never credential: the status page's gate, since EventSource cannot send headers. */
    | "loopback"
    /** A peer's token, and nothing else. */
    | "peer"
    /** This machine, or one of our api keys. Never a peer. */
    | "local"
    /** Either — work a peer may send us, and we may ask for ourselves. */
    | "either";

  interface Route {
    path: string | string[];
    /** Methods this route claims; anything else falls through to the passthrough. */
    methods?: string[];
    auth: Auth;
    envelope?: Envelope;
    /** A scoped key may reach this route. Off by default: a new route is
     *  closed to scoped keys until someone decides otherwise. */
    scoped?: true;
    handler: Handler;
  }

  /** Resolve a route's caller or answer the refusal; the one place a credential becomes an identity. */
  function authorize(r: Route, req: IncomingMessage, res: ServerResponse): Call | null {
    const url = new URL(req.url ?? "/", "http://localhost");
    const base = { req, res, url, path: url.pathname };
    const env = r.envelope ?? "plain";

    if (r.auth === "open") return { ...base, peer: null, caller: "", models: null };

    if (r.auth === "loopback") {
      // Off this machine, the page's data takes an operator session: EventSource cannot send a key.
      const op = callers.operator(req);
      if (!isLoopback(req) && op === null) {
        refuse(res, 403, "the status page is loopback-only, or open to a logged-in operator", env);
        return null;
      }
      return { ...base, peer: null, caller: op !== null ? "operator:" + op : "", models: null };
    }

    const asPeer = r.auth === "local" ? null : callers.peer(req);
    if (asPeer !== null) peerArea.sawPeer(asPeer, req);
    if (r.auth === "peer") {
      if (asPeer === null) {
        refuse(res, 401, "unknown peer token", env);
        return null;
      }
      return { ...base, peer: asPeer, caller: asPeer, models: null };
    }

    // A plugin's own token: a local caller whose requests no plugin sees, so a hook cannot call itself.
    // It reaches model calls and nothing else: not the config, keys or control routes.
    const plugin = plugins.internalCaller(bearer(req));
    if (plugin !== null) {
      if (r.scoped !== true && !(r.path === "*" && url.pathname.startsWith("/v1/"))) {
        refuse(res, 403, "a plugin's token reaches /v1 model calls only", env);
        return null;
      }
      return { ...base, peer: null, caller: "plugin:" + plugin, models: null, internal: true };
    }

    // A live operator session is a full local identity: no scope, so nothing below it can refuse.
    let asLocal = callers.local(req);
    if (asLocal === null) {
      const op = callers.operator(req);
      if (op !== null) asLocal = { caller: "operator:" + op, models: null };
    }
    if (asPeer === null && asLocal === null) {
      refuse(res, 401, "unauthorized", env);
      return null;
    }
    if (asPeer !== null) return { ...base, peer: asPeer, caller: asPeer, models: null };
    // A scoped key is a chat client and nothing more. 403, not 404: the route
    // exists, this key is not the kind that reaches it.
    if (asLocal!.models !== null && r.scoped !== true) {
      refuse(res, 403, "this key is scoped to chat on its models", env);
      return null;
    }
    return { ...base, peer: null, caller: asLocal!.caller, models: asLocal!.models };
  }

  /** Every path this node answers, in order, with its `auth` beside it. The passthrough is last and takes the rest. */
  const ROUTES: Route[] = [
    // Unauthenticated on purpose, and on a port that may be bound wide, so it
    // answers in counts and never in names.
    { path: "/healthz", auth: "open", handler: adminArea.routeHealthz },

    { path: ["/peer/hello", "/peer/state"], auth: "peer", handler: peerArea.routePeer },
    // No credential yet: a one-time invite secret in the body is the whole gate.
    { path: "/peer/join", methods: ["POST"], auth: "open", handler: joinArea.routePeerJoin },

    // Local only: /control changes state, so a peer must never reach it.
    { path: "/network", auth: "local", handler: adminArea.routeNetwork },
    { path: "/control", auth: "local", handler: adminArea.routeControl },
    { path: "/lending", methods: ["GET"], auth: "local", handler: consoleArea.routeLending },
    { path: "/restart", methods: ["POST"], auth: "local", handler: adminArea.routeRestart },
    { path: "/config", methods: ["GET", "PATCH", "POST"], auth: "local", handler: adminArea.routeConfig },
    { path: "/config/draft", methods: ["GET", "PUT", "DELETE"], auth: "local", handler: adminArea.routeConfigDraft },
    { path: "/config/versions", methods: ["GET", "POST"], auth: "local", handler: adminArea.routeConfigVersions },
    { path: "/flows/try", methods: ["POST"], auth: "local", handler: chatArea.routeFlowsTry },
    { path: "/flows/replay", methods: ["POST"], auth: "local", handler: chatArea.routeFlowsReplay },
    { path: "/queue", auth: "local", handler: consoleArea.routeQueue },
    { path: "/queue/events", methods: ["GET"], auth: "local", handler: consoleArea.routeQueueEvents },

    // Mint and revoke write the config file, and the node follows it at once.
    { path: ["/keys/mint", "/keys/revoke", "/keys/rotate", "/keys/update"], methods: ["POST"], auth: "local", handler: keyArea.routeKeys },
    // Invite a node to borrow from this one, or redeem another node's invite.
    { path: "/peers/invite", methods: ["POST"], auth: "local", handler: joinArea.routeInvite },
    { path: "/peers/join", methods: ["POST"], auth: "local", handler: joinArea.routeJoin },
    { path: "/peers/machine", methods: ["GET"], auth: "local", handler: peerArea.routePeerMachine },
    { path: "/usage", methods: ["GET"], auth: "local", handler: consoleArea.routeUsage },
    { path: "/plugins", methods: ["GET", "POST"], auth: "local", handler: pluginArea.routePlugins },
    { path: "/plugins/probe", methods: ["POST"], auth: "local", handler: pluginArea.routePluginProbe },
    { path: "/plugins/*", auth: "local", handler: pluginArea.routePluginServes },
    { path: "/report", methods: ["GET"], auth: "local", handler: adminArea.routeReport },
    { path: "/backends/probe", methods: ["POST"], auth: "local", handler: adminArea.routeProbe },

    // The OpenAI surface: a peer may send us work here, and so may we.
    { path: "/v1/warm", methods: ["POST"], auth: "either", envelope: "openai", handler: modelArea.routeWarm },
    { path: "/v1/evict", methods: ["POST"], auth: "local", envelope: "openai", handler: modelArea.routeEvict },
    { path: ["/v1/models", "/v1/models/*"], auth: "either", envelope: "openai", scoped: true,
      handler: modelArea.routeModels },
    { path: "/v1/chat/completions", methods: ["POST"], auth: "either", envelope: "openai",
      scoped: true, handler: chatArea.routeChat },
    // The Messages API, for clients that speak only that; peers borrow over chat completions.
    { path: "/v1/messages", methods: ["POST"], auth: "local", envelope: "openai", scoped: true,
      handler: chatArea.routeMessages },
    // Embeddings pass through as before; a scoped key may use them for the names in its scope.
    { path: "/v1/embeddings", methods: ["POST"], auth: "local", envelope: "openai", scoped: true,
      handler: passArea.routeEmbeddings },

    // Login and logout take no credential by definition; cross-origin POSTs are refused above.
    { path: "/login", methods: ["POST"], auth: "open", handler: loginArea.routeLogin },
    { path: "/logout", methods: ["POST"], auth: "open", handler: loginArea.routeLogout },
    // First run: the console creates the first operator, from this machine or with a full key. Closed after.
    { path: "/setup", methods: ["GET", "POST"], auth: "open", handler: loginArea.routeSetup },

    // A bare address typed into a browser lands on the console instead of a 401.
    { path: "/", methods: ["GET", "HEAD"], auth: "open", handler: async (c) => {
      c.res.writeHead(302, { Location: "/ui" }).end();
    } },

    // The page is static — every byte of data comes from /ui/data and /ui/events — so it may go
    // out wide; the gate that matters is the one on the data stream.
    { path: ["/ui", "/ui/"], auth: "open", handler: consoleArea.routeUi },
    { path: ["/ui/data", "/ui/events"], auth: "loopback", envelope: "openai", handler: consoleArea.routeUi },
    // The history view's day and the Logs page, fetched on demand rather than pushed with every frame.
    { path: "/ui/history", methods: ["GET"], auth: "loopback", envelope: "openai",
      handler: async (c) => json(c.res, 200, history.since(DAY_MS)) },
    { path: "/ui/logs", methods: ["GET"], auth: "loopback", envelope: "openai",
      handler: async (c) => json(c.res, 200, { entries: logs.all(), persisted: cfg.historyFile !== null }) },
    // One record per finished request, newest first, and one by its id.
    { path: "/ui/requests", methods: ["GET"], auth: "loopback", envelope: "openai", handler: async (c) => {
      const q = c.url.searchParams;
      const num = (k: string): number | undefined => (q.get(k) !== null && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
      json(c.res, 200, requests.traces.list({
        after: num("after"), limit: num("limit"), model: q.get("model") || undefined, caller: q.get("caller") || undefined,
        ok: q.get("ok") === "true" ? true : q.get("ok") === "false" ? false : undefined,
      }));
    } },
    { path: "/ui/requests/*", methods: ["GET"], auth: "loopback", envelope: "openai", handler: async (c) => {
      const found = requests.traces.get(decodeURIComponent(c.path.slice("/ui/requests/".length)));
      if (found) json(c.res, 200, found);
      else apiError(c.res, 404, "no such request among those kept", "invalid_request_error");
    } },
    { path: "/ui/lending", methods: ["GET"], auth: "loopback", envelope: "openai", handler: consoleArea.routeLending },

    { path: "*", auth: "local", envelope: "openai", handler: passArea.routePassthrough },
  ];

  const claims = (r: Route, path: string, method: string | undefined): boolean => {
    if (r.path !== "*") {
      const paths = Array.isArray(r.path) ? r.path : [r.path];
      // A trailing "/*" claims everything under it, with at least one char.
      if (!paths.some((p) => p === path
                             || (p.endsWith("/*") && path.length > p.length - 1
                                 && path.startsWith(p.slice(0, -1))))) return false;
    }
    return r.methods === undefined || r.methods.includes(method ?? "GET");
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    // Before anything is routed, because it is a fact about the REQUEST rather
    // than about any one path: a browser on some other site's page must not be
    // able to POST here just because loopback is trusted.
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (reboundHost(req)) {
      log.warn("request.rebound_host", { path, method: req.method, host: req.headers.host });
      apiError(res, 403, "on this machine, this node answers at localhost or an IP address, not at a name", "permission_error");
      return;
    }
    if (crossOriginWrite(req)) {
      log.warn("request.cross_origin", { path, method: req.method, origin: req.headers.origin });
      apiError(res, 403, "cross-origin writes are refused", "permission_error");
      return;
    }

    for (const r of ROUTES) {
      if (!claims(r, path, req.method)) continue;
      const c = authorize(r, req, res);
      if (c === null) return;
      if (c.peer !== null && !(await peerArea.fromPeerMachine(c.peer, req, res, r.envelope ?? "plain"))) return;
      await r.handler(c);
      return;
    }
  }

  /** Expired sessions and spent rate-limit windows, swept like any other in-memory state; unref'd so it never holds the process. */
  const sessionSweep = setInterval(() => { callers.prune(); limits.prune(); }, 30 * 60_000);
  sessionSweep.unref?.();

  /** The day of history and recent logs, read once at start and written every minute and at close. */
  function loadHistory(): void {
    if (!cfg.historyFile || !existsSync(cfg.historyFile)) return;
    try {
      const saved = JSON.parse(readFileSync(cfg.historyFile, "utf8")) as { v?: unknown; history?: unknown; logs?: unknown; requests?: unknown; lastUse?: unknown; usage?: unknown; borrowed?: unknown };
      // A later hearth's file is set aside whole rather than half-read and then written over.
      if (typeof saved.v === "number" && saved.v > HISTORY_VERSION) {
        renameSync(cfg.historyFile, `${cfg.historyFile}.v${saved.v}`);
        log.warn("history.newer", { path: cfg.historyFile, version: saved.v, reads: HISTORY_VERSION, keptAs: `${cfg.historyFile}.v${saved.v}` });
        return;
      }
      history.restore(saved.history);
      usage.restore(saved.usage);
      borrowed.restore(saved.borrowed);
      logs.restore(saved.logs);
      requests.traces.restore(saved.requests);
      // When each model was last asked for, so a restart does not make everything look long idle.
      worlds.restoreLastUses(saved.lastUse);
    } catch (e) {
      log.warn("history.unreadable", { path: cfg.historyFile, error: String(e) });
    }
  }
  let historyWarned = false;
  function saveHistory(): void {
    if (!cfg.historyFile) return;
    try {
      writeFileAtomic(cfg.historyFile, JSON.stringify({ v: HISTORY_VERSION, history: history.snapshot(), logs: logs.all(), requests: requests.traces.all(), lastUse: worlds.lastUses(), usage: usage.snapshot(), borrowed: borrowed.snapshot() }));
      historyWarned = false;
    } catch (e) {
      // Once per failure streak: a read-only path must not fill the journal every minute.
      if (!historyWarned) log.warn("history.unwritable", { path: cfg.historyFile, error: String(e) });
      historyWarned = true;
    }
  }
  let historyTimer: ReturnType<typeof setInterval> | null = null;

  const node: HearthNode = {
    // Kept on the routes' context, where `/restart` and the console read them.
    get onRestart() { return ctx.lifecycle.onRestart; },
    set onRestart(fn) { ctx.lifecycle.onRestart = fn; },
    get update() { return ctx.lifecycle.update; },
    set update(v) { ctx.lifecycle.update = v; },
    log,
    server,
    pool,
    peers,
    history,
    plugins,
    startPlugins: () => plugins.start(),
    start: () => {
      loadHistory();
      pool.start();
      peers.start();
      history.start();
      if (cfg.historyFile) {
        historyTimer = setInterval(saveHistory, 60_000);
        historyTimer.unref?.();
      }
      config.watch();
      // Last, so the first probe sees a backend whose warm state has been read.
      canary?.start();
    },
    close: async (graceMs = 0) => {
      canary?.stop();
      void plugins.stop();
      if (historyTimer) clearInterval(historyTimer);
      clearInterval(sessionSweep);
      callers.prune();
      config.close();
      peers.stop();
      pool.stop();
      history.stop();
      // End event streams first, so pages start reconnecting at once.
      consoleArea.closeStreams();

      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Stop accepting, and drop the connections sitting idle. A keep-alive
      // client holding one open is not work either, and waiting on it would
      // make every drain take the full grace period.
      server.closeIdleConnections?.();

      if (graceMs > 0 && inFlight > 0) {
        const t0 = Date.now();
        log.info("drain.start", { inFlight, graceMs });
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          new Promise<void>((resolve) => { drained = resolve; }),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        drained = null;
        const ms = Date.now() - t0;
        // Say which one it was. A drain that timed out means the deploy DID
        // take work with it, and that is worth knowing before the reports come
        // in rather than after.
        if (inFlight > 0) log.warn("drain.cut", { abandoned: inFlight, ms });
        else log.info("drain.done", { ms });
      }

      server.closeAllConnections?.();
      await closed;
      // After the drain, so the calls it let finish are in the file.
      saveHistory();
    },
  };
  return node;
}
