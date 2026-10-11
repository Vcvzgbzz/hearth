/**
 * The HTTP surface: OpenAI-compatible `/v1/*` (clients change only a base url) and the `/peer/*`
 * protocol. Bodies stream through untouched; only the model id and stream flag are read.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { actionDecls, runAction, type Action, type ActionFacts } from "./actions.js";
import { admitModel, BodyTooLargeError, callerCap, Refusal, refusalOf } from "./admit.js";
import { createCanary, degradedError, type RelayWatch } from "./canary.js";
import { ANY, ConfigError, flowsFor, peersMapping, WARM_LANE, type BackendConfig, type FlowEnd, type HearthConfig, type RoutePolicy } from "./config.js";
import { Controls } from "./controls.js";
import { emulatedRequest, relayEmulated, streamErrorFrame } from "./emulate.js";
import { ConfigFile, ConfigRefusal, deepFreeze, link, setNote, setShare, unlink, writeFileAtomic } from "./configfile.js";
import { COOKIE, LoginThrottle, OperatorSessions, SESSION_TTL_MS, cookieToken, hashPassword, verifyDecoy, verifyPassword } from "./login.js";
import { LogRing, type Logger } from "./log.js";
import { PeerRegistry, PeerStatusError } from "./peers.js";
import { BackendPool, type BackendSlot } from "./pool.js";
import { decide, mayLeave, resolve, variantsOf, type LocalLoad, type World } from "./route.js";
import { QueueFullError } from "./scheduler.js";
import { DAY_MS, History } from "./history.js";
import { fitOutput, needsOf, NOTE_MAX, unfit, type ModelStats } from "./stats.js";
import { CONSOLE_HTML } from "./ui.js";
import { createViews, type KeyInfo } from "./views.js";
import { multipartField, replaceMultipartField } from "./multipart.js";
import { send, type UpstreamResponse } from "./upstream.js";

/** Constant-time compare over sha256 digests, so neither length nor content leaks. */
function secretEq(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

/** Stable, non-reversible id for an api key. Safe for logs and /queue. */
function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization;
  if (typeof h !== "string") return "";
  return h.replace(/^Bearer\s+/i, "").trim();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** OpenAI's error envelope, since that's what clients parse. Extra fields ride beside `type`. */
function apiError(
  res: ServerResponse,
  status: number,
  message: string,
  type = "invalid_request_error",
  extra?: Record<string, unknown>,
): void {
  json(res, status, { error: { message, type, ...extra } });
}

/** Thrown, not returned, so the caller can answer 413 rather than the 400 an
 *  unparseable body would otherwise get. */
function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        // Don't destroy the socket here. It races the response, and the client
        // sees a connection reset instead of a status, which looks like a crash.
        // Pausing is enough to stop us buffering while the caller writes 413.
        req.pause();
        reject(new BodyTooLargeError(limitBytes));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Connection-level headers that cannot cross a proxy hop; Content-Length is left to the runtime. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

function forwardable(
  headers: IncomingMessage["headers"] | UpstreamResponse["headers"],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export interface HearthNode {
  server: Server;
  /** The local backends and their queues. One entry unless `backends:` is used. */
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
}

export function createNode(cfg: HearthConfig, baseLog: Logger): HearthNode {
  // Every line still goes to stdout; the ring keeps the recent ones for the console's Logs page.
  const logs = new LogRing();
  const log = logs.tap(baseLog);
  // ConfigFile swaps the live keys in whole and everything reads those per call; the rest changes
  // only with a restart, so an accidental write throws instead of going stale.
  for (const part of [cfg.listen, cfg.backends, cfg.scheduler, cfg.resources,
                      cfg.apiKeys, cfg.apiKeyLabels, cfg.apiKeyModels, cfg.peerTokens]) deepFreeze(part);
  // One state and one queue per backend. Pushed over SSE where the backend
  // supports it, polled where it doesn't.
  const pool = new BackendPool(cfg, log);

  // Pause switches for the two federation directions. Passed to the registry so a
  // borrowing pause removes every peer from routing at source.
  const controls = new Controls();
  // hearth.yaml as the only config state: edits write the file and apply live.
  // Deferred: the sidecar migration below applies before the stream state further down exists.
  const config = new ConfigFile(cfg, log, () => queueMicrotask(() => void broadcast()));
  if (cfg.stateFile) config.migrateSidecar(cfg.stateFile);
  const peers = new PeerRegistry(cfg, log, controls);

  /** The opt-in canary, or null when `canary:` is not configured. */
  const canary = createCanary(cfg, pool, log);

  /** What we lend right now: `share:` while lending is on, nothing while paused. Every share gate reads this. */
  const shared = (): readonly string[] => controls.share(cfg.share);

  const history = new History(() => {
    const agg = pool.aggregate();
    return {
      queued: Object.values(agg.queued).reduce((a, b) => a + b, 0),
      // Several backends means several models warm at once, so this is a list.
      residents: pool.loaded(),
      // What is being USED, as opposed to what is loaded: models with a job
      // running on a local backend at this instant. Off-box jobs are a peer's
      // activity, not ours. Finished calls are recorded as they end (logRequest).
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

  /** Separate hourly budgets per peer for inference and the control plane, so polling never starves real work. */
  const peerHits = new Map<string, number[]>();
  const controlHits = new Map<string, number[]>();
  const CONTROL_LIMIT_PER_HOUR = 2_000;

  function overBudget(bucket: Map<string, number[]>, name: string, limit: number): boolean {
    const now = Date.now();
    const hits = (bucket.get(name) ?? []).filter((t) => now - t < 3_600_000);
    if (hits.length >= limit) {
      bucket.set(name, hits);
      return true;
    }
    hits.push(now);
    bucket.set(name, hits);
    return false;
  }

  const peerOverLimit = (name: string) => overBudget(peerHits, name, cfg.peerRateLimit);
  const controlOverLimit = (name: string) => overBudget(controlHits, name, CONTROL_LIMIT_PER_HOUR);

  /** The gates every model request passes before it is queued; throws the Refusal. */
  function admit(c: Call, model: string): void {
    const refused = admitModel({ model, peer: c.peer, scope: c.models }, {
      name: cfg.name,
      shared,
      // A peer may map an id nothing here serves.
      unknown: (m) => pool.certainlyUnknown(m) && peersMapping(m, [], cfg.peers).length === 0
        ? pool.catalog().join(", ") || "nothing"
        : null,
    });
    if (refused) throw refused;
  }

  /** A peer's hourly budget, spent before its body is even read. */
  function admitPeer(c: Call): void {
    if (c.peer !== null && peerOverLimit(c.peer)) throw new Refusal(429, "rate capped", "rate_limit_error");
  }

  /**
   * Opt-in queue position for a streamed chat (`X-Hearth-Queue: stream`): the stream opens while the
   * request waits and carries `: hearth-queue {"position":N}` comments, which OpenAI-style parsers skip.
   */
  function positionStream(req: IncomingMessage, res: ServerResponse, payload: Record<string, unknown>) {
    if (req.headers["x-hearth-queue"] !== "stream" || payload.stream !== true) return undefined;
    return (position: number) => {
      if (res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      }
      res.write(`: hearth-queue ${JSON.stringify({ position })}\n\n`);
    };
  }

  /** The caller's own id for this request (`X-Hearth-Job`), so its updates on /queue/events can be matched; ignored if malformed. */
  function jobId(req: IncomingMessage): string | undefined {
    const v = req.headers["x-hearth-job"];
    return typeof v === "string" && /^[\w.:-]{1,128}$/.test(v) ? v : undefined;
  }

  /**
   * The 503 a degraded model owes a client. Returned rather than thrown so every
   * door can answer it: the chat route throws it, the passthrough hands it to `fail`.
   */
  function degradedRefusal(model: string): Refusal | null {
    const sick = canary?.refuse(model);
    if (sick === undefined || sick === null) return null;
    const { message, fields } = degradedError(model, pool.for(model).name, sick);
    return new Refusal(503, message, "server_error", fields);
  }

  /** Refuse a degraded model on the chat route. */
  function refuseDegraded(model: string): void {
    const refusal = degradedRefusal(model);
    if (refusal) throw refusal;
  }

  /** The JSON body: 413 over maxBodyBytes, 400 when not JSON. */
  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBody(req, cfg.maxBodyBytes);
    try {
      return JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch (e) {
      throw new Refusal(400, `body was not JSON: ${String(e)}`);
    }
  }

  /** Answer any failure with its status, or end a response already under way. */
  function fail(res: ServerResponse, e: unknown): void {
    if (res.headersSent) {
      // A stream opened early for queue position carries the failure in-band; a 200 cannot be taken back.
      const early = String(res.getHeader("Content-Type") ?? "").includes("text/event-stream");
      if (early && !res.writableEnded) {
        const r = refusalOf(e);
        res.end(streamErrorFrame(r.status, r.message));
      } else res.end();
      return;
    }
    const r = refusalOf(e);
    // The rest of an oversized body is never read, so the connection cannot be reused.
    if (e instanceof BodyTooLargeError) res.setHeader("Connection", "close");
    apiError(res, r.status, r.message, r.type, r.extra ?? undefined);
  }

  /** Which peer is calling, by token. Null if we don't recognise it. */
  function peerCaller(req: IncomingMessage): string | null {
    const given = bearer(req);
    if (given === "") return null;
    for (const [name, token] of Object.entries(cfg.peerTokens)) {
      if (token !== "" && secretEq(given, token)) return name;
    }
    return null;
  }

  const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

  /** On this machine, whatever the config says. The status page is gated on this alone, since a browser cannot send a bearer token. */
  const isLoopback = (req: IncomingMessage) =>
    LOOPBACK.has(req.socket.remoteAddress ?? "");

  /** A local identity, and what it may run: null is everything. */
  type Local = { caller: string; models: string[] | null };

  /** When each key last authenticated here — the one per-key fact the config file cannot hold. */
  const keySeen = new Map<string, number>();

  /** A local caller by api key; with no keys configured, loopback and nothing else. */
  function localCaller(req: IncomingMessage): Local | null {
    const given = bearer(req);
    if (cfg.apiKeys.length === 0) {
      if (given !== "") return null; // presented a credential; it's not valid here
      return LOOPBACK.has(req.socket.remoteAddress ?? "") ? { caller: "local", models: null } : null;
    }
    if (given === "") return null;
    // An unlabeled key is identified by its hash prefix, never by characters of the key itself.
    let i = 0;
    for (const k of cfg.apiKeys) {
      if (secretEq(given, k)) {
        const caller = "key:" + (cfg.apiKeyLabels[i] || keyId(k));
        keySeen.set(caller, Date.now());
        return { caller, models: cfg.apiKeyModels[i] ?? null };
      }
      i++;
    }
    return null;
  }

  /** The operator login: a session is the third trust signal, beside the address and the keys. */
  const sessions = new OperatorSessions();
  const loginThrottle = new LoginThrottle();
  let sessionsFor = cfg.operator;
  /** The login applies live, so a changed one signs every old session out, as a restart would. */
  function syncSessions(): void {
    if (cfg.operator === sessionsFor) return;
    sessions.clear();
    sessionsFor = cfg.operator;
  }
  /** The logged-in operator behind this request's session cookie, or null. */
  function sessionOperator(req: IncomingMessage): string | null {
    syncSessions();
    const token = cookieToken(req.headers.cookie);
    return token ? sessions.check(token) : null;
  }

  /** Per-request timing for the one-line request log; `waitedMs` shows whether admission queued it. */
  interface Timing {
    enqueuedAt: number;
    startedAt: number;
  }
  function logRequest(
    t: Timing,
    fields: Record<string, unknown>,
    ok: boolean,
    error?: unknown,
  ): void {
    const started = t.startedAt || Date.now();
    // A call that actually ran on a local backend is a use of that model,
    // whether or not it succeeded: the weights were busy either way. Admission
    // refusals (startedAt 0) and peer dispatches are not local uses.
    if (t.startedAt > 0 && fields.target === "local" && typeof fields.model === "string") {
      history.record({
        t: Date.now(), model: fields.model, backend: String(fields.backend ?? ""),
        ms: Date.now() - started, waitedMs: started - t.enqueuedAt, ok,
      });
    }
    log.info("request", {
      ...fields,
      waitedMs: started - t.enqueuedAt,
      runMs: Date.now() - started,
      ok,
      ...(error ? { error: String(error).slice(0, 200) } : {}),
    });
  }

  /** Sends a chat completion to a local backend, emulating another server's answers if the route asks. */
  async function sendLocal(url: string, model: string, payload: Record<string, unknown>, res: ServerResponse, opts: { signal: AbortSignal } & ReturnType<typeof backendDeadline>, spare = false): Promise<number> {
    const emulate = cfg.models[model]?.emulate ?? null;
    const body = pool.outboundBody(model, payload);
    const sentAt = Date.now();
    const up = await send(`${url}/v1/chat/completions`, { json: emulate ? emulatedRequest(body) : body, ...opts });
    // With somewhere else to run it, a backend's own failure is not relayed: the request moves on.
    if (spare && up.status >= 500 && !res.headersSent) throw new BackendFailed(up.status, (await up.text()).slice(0, 200));
    if (emulate) return relayEmulated(up, res, forwardable(up.headers), sentAt);
    // Observed as it is relayed, never held back: see RelayWatch.
    return pipeThrough(up, res, canary?.watchRelay(model, pool.for(model).name, up.headers["content-type"]));
  }

  /** A backend answered 5xx before anything reached the client, while its flow had another place to send the request. */
  class BackendFailed extends Refusal {
    constructor(status: number, detail: string) { super(status, detail || `backend answered ${status}`, "server_error"); }
  }

  /** The text-completion paths a relayed answer is worth watching on, with or without an `/upstream/<model>` prefix. */
  const COMPLETION_PATH = /^\/(?:v1\/(?:completions|chat\/completions|responses)|completion)$/;

  /** A passthrough path with llama-swap's `/upstream/<model>` prefix removed. */
  function stripUpstream(path: string): string {
    return path.replace(/^\/upstream\/[^/]+/, "");
  }

  /**
   * Relay an upstream answer verbatim, all headers included, and return its status: a backend's 4xx
   * reaches the client but is not a success. `pipeline` settles even if the client disconnects.
   *
   * `watch`, when given, sees each chunk on its way past and is never allowed to
   * delay, alter or hold one: the transform writes the same buffer straight on.
   */
  async function pipeThrough(
    up: UpstreamResponse,
    res: ServerResponse,
    watch?: RelayWatch,
  ): Promise<number> {
    if (res.headersSent) {
      // Opened early for queue position: the status cannot change now, so a failure is a frame.
      if (up.status >= 400) {
        res.end(streamErrorFrame(up.status, await up.text()));
        return up.status;
      }
      // A good body still gets watched, so a queue-position stream counts too.
      if (watch === undefined) {
        await pipeline(up.body, res);
        return up.status;
      }
      await pipeline(up.body, watch.through(), res);
      watch.end();
      return up.status;
    }
    res.writeHead(up.status, {
      ...forwardable(up.headers),
      // Ours, not a peer's own id for it: the name this node knows the model by.
      ...(res.hasHeader("x-hearth-model") ? { "x-hearth-model": String(res.getHeader("x-hearth-model")) } : {}),
      "Content-Type": up.headers["content-type"] ?? "application/json",
      // Tell any proxy in front not to buffer, or a streamed answer arrives all
      // at once at the end and looks like a hang.
      "X-Accel-Buffering": "no",
    });
    if (watch === undefined) {
      await pipeline(up.body, res);
      return up.status;
    }
    await pipeline(up.body, watch.through(), res);
    watch.end();
    return up.status;
  }

  /** Run one completion where it belongs. A peer that fails before the first byte is retried locally. */
  /** The local half of a routing decision: this model's queue and slots on the backend that serves it. */
  function localLoad(slot: BackendSlot, model: string): LocalLoad {
    const cap = slot.scheduler.capacityFor(model);
    return {
      queued: Object.values(cap.queued).reduce((a, b) => a + b, 0),
      free: cap.free,
      slots: cap.slots,
      loaded: slot.state.loaded(),
    };
  }

  /**
   * When each model was last in use here, for a flow's `idle`: someone asked for it by one of its
   * names, here or from a peer. Kept by the id the backend knows it by, so every name for one model
   * counts as that model. A request a flow sent there is not someone using it, or a rule that
   * borrows an idle model would end its own idleness.
   */
  const lastUse = new Map<string, number>();
  const bootAt = Date.now();
  const open = new Map<string, number>();
  /** Count a request that asked for this model as use of it until `res` closes. */
  function using(model: string, res: ServerResponse): void {
    const wire = pool.outboundId(model);
    open.set(wire, (open.get(wire) ?? 0) + 1);
    res.once("close", () => {
      open.set(wire, (open.get(wire) ?? 1) - 1);
      lastUse.set(wire, Date.now());
    });
  }

  /** How many times each step of each flow has decided, since the flows last changed. */
  const hits = new Map<string, number[]>();
  let hitsFor = cfg.flows;
  function countHits(path: readonly { flow: string; step: number }[]): void {
    if (hitsFor !== cfg.flows) { hits.clear(); hitsFor = cfg.flows; }
    for (const p of path) {
      const row = hits.get(p.flow) ?? [];
      row[p.step] = (row[p.step] ?? 0) + 1;
      hits.set(p.flow, row);
    }
  }

  /**
   * Where a sticky flow sent each conversation, so its later turns go there too. A conversation
   * is who is calling, the id they ask for and how it opens: everything up to its first user turn.
   */
  const placed = new Map<string, { end: FlowEnd; until: number }>();
  const PLACED_MAX = 5000;
  function conversation(caller: string, asked: string, payload: Record<string, unknown>): { key: string; later: boolean } | null {
    const turns = Array.isArray(payload.messages) ? (payload.messages as { role?: unknown }[]) : [];
    const first = turns.findIndex((m) => m?.role === "user");
    if (first < 0) return null;
    const key = createHash("sha256").update(`${caller}\0${asked}\0${JSON.stringify(turns.slice(0, first + 1))}`).digest("hex");
    return { key, later: turns.some((m) => m?.role === "assistant") };
  }

  /** When each action last ran, for one that sets `every`. */
  const ranAt = new Map<string, number>();
  function act(name: string, action: Action, facts: ActionFacts): void {
    const now = Date.now();
    if (action.every > 0 && now - (ranAt.get(name) ?? -Infinity) < action.every) return;
    ranAt.set(name, now);
    runAction(action, facts, log);
  }

  /** How many requests each step that sets `max` has in flight, by `<flow>\0<step>`. */
  const stepsBusy = new Map<string, number>();

  /**
   * Would running this model here need no swap? It is loaded, or nothing else is: not on its own
   * backend, and not on any backend that shares exclusive hardware with it.
   */
  function ready(model: string): boolean {
    const slot = pool.for(model);
    const loaded = slot.state.loaded();
    if (loaded.includes(model) || loaded.includes(pool.outboundId(model))) return true;
    if (loaded.length > 0) return false;
    const exclusive = new Set(pool.resources().filter((r) => !r.shared).map((r) => r.name));
    const mine = slot.cfg.resources.filter((r) => exclusive.has(r));
    return !pool.all().some((o) => o !== slot && o.cfg.resources.some((r) => mine.includes(r)) && o.state.loaded().length > 0);
  }

  /** What a flow decided for work that is not chat: counted, and its actions that run as a step decides set off. */
  function settle(r: ReturnType<typeof resolve>, asked: string, caller: string): void {
    // ponytail: only `flows:` is counted; a router's lines show no counts until hits are kept per router.
    if (!routerOf(caller)) countHits(r.path);
    for (const a of r.actions) {
      const action = cfg.actions[a.name];
      if (action?.on !== "decided") continue;
      act(a.name, action, {
        action: a.name, node: cfg.name, asked, model: r.model, target: r.target, peer: "", lane: r.lane, caller, tokens: 0, images: false, tools: false,
        flow: a.flow, line: a.step + 1, reason: r.reason, outcome: "decided", ms: 0, error: "", backend: r.target === "local" ? pool.for(r.model).name : "", id: "", queuedMs: 0, ranMs: 0,
      });
    }
  }

  /** What a flow reads about this node, for a request with these needs. */
  /** The router a caller goes by, if not `flows:`: the one `callers:` gives it by its key's label or `local`, else the one it gives everyone. */
  const routerOf = (caller: string) => cfg.routers[cfg.callers[caller.startsWith("key:") ? caller.slice(4) : caller] ?? cfg.callers["*"] ?? ""];
  /** The config as a caller's requests see it: its router's rulebook in place of `flows:`. */
  const rulesFor = (caller: string): HearthConfig => { const r = routerOf(caller); return r ? { ...cfg, flows: r.flows } : cfg; };

  /** A request's headers as a flow reads them: one value per lower-case name, the first where a name was sent twice. */
  const headersOf = (req: IncomingMessage): Record<string, string> =>
    Object.fromEntries(Object.entries(req.headers).flatMap(([k, v]) => { const one = Array.isArray(v) ? v[0] : v; return typeof one === "string" ? [[k.toLowerCase(), one]] : []; }));

  function worldFor(caller: string, lane: string, need: World["need"], from: HearthConfig = rulesFor(caller), headers: World["headers"] = {}): World {
    return {
      cfg: from, peers, caller, lane, need, headers,
      local: (m) => localLoad(pool.for(m), m),
      held: (m, l) => pool.heldOff(pool.for(m).cfg, l),
      ready,
      inFlight: (flow, step) => stepsBusy.get(`${flow}\0${step}`) ?? 0,
      // A model nobody has used since startup has been idle since then.
      idleMs: (m) => ((open.get(pool.outboundId(m)) ?? 0) > 0 ? 0 : Date.now() - (lastUse.get(pool.outboundId(m)) ?? bootAt)),
    };
  }

  /**
   * Where a request would go right now, without sending it: for the console's "try a request".
   * `flows` and `actions` try unsaved sections in place of the ones in force, and `pretend` names
   * models to read as idle, used, busy, warm or held, and `now` a time of day. No action is set off and nothing is counted.
   */
  async function routeFlowsTry(c: Call): Promise<void> {
    try {
      const b = await readJson(c.req);
      const asked = typeof b.model === "string" ? b.model : "";
      if (asked === "") throw new Refusal(400, "model is required: the id the request would ask for");
      const lane = typeof b.lane === "string" && b.lane in cfg.scheduler.lanes ? b.lane : Object.keys(cfg.scheduler.lanes)[0]!;
      let from: HearthConfig = cfg;
      if (b.flows !== undefined) {
        try {
          const actions = b.actions === undefined ? cfg.actions : actionDecls(b.actions);
          from = { ...cfg, actions, flows: flowsFor(b.flows, cfg, actions) };
        } catch (e) {
          if (e instanceof ConfigError) throw new Refusal(400, e.message);
          throw e;
        }
      }
      if (mayLeave(from, asked)) await peers.ensureFresh();
      const need = { tokens: typeof b.tokens === "number" ? b.tokens : 0, images: b.images === true, tools: b.tools === true };
      // Headers to try it with, as `{ name: value }`; anything that is not text is left out.
      const tried = Object.fromEntries(Object.entries(typeof b.headers === "object" && b.headers !== null ? b.headers as Record<string, unknown> : {})
        .flatMap(([k, v]) => (typeof v === "string" ? [[k.toLowerCase(), v]] : [])));
      const real = worldFor(typeof b.caller === "string" ? b.caller : "local", from.models[asked]?.lane ?? lane, need, from, tried);
      // `pretend` stands in for state that cannot be arranged on demand: models named as idle, just used, busy, loaded or held.
      const pretend = (typeof b.pretend === "object" && b.pretend !== null ? b.pretend : {}) as Record<string, unknown>;
      const said = (k: string): string[] => (Array.isArray(pretend[k]) ? (pretend[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
      const r = resolve(asked, {
        ...real,
        idleMs: (m) => (said("idle").includes(m) ? Number.MAX_SAFE_INTEGER : said("used").includes(m) ? 0 : real.idleMs!(m)),
        held: (m, l) => said("held").includes(m) || real.held(m, l),
        ready: (m) => !said("unready").includes(m) && (said("warm").includes(m) || ready(m)),
        // `full` names steps to read as at their limit, each `<step>:<flow>`.
        inFlight: (flow, step) => (said("full").includes(`${step}:${flow}`) ? Number.MAX_SAFE_INTEGER : real.inFlight!(flow, step)),
        // `now` is a time of day to read the clock as, HH:MM.
        ...(typeof pretend["now"] === "string" && /^\d\d:\d\d$/.test(pretend["now"]) ? { now: () => { const d = new Date(); d.setHours(Number((pretend["now"] as string).slice(0, 2)), Number((pretend["now"] as string).slice(3)), 0, 0); return d; } } : {}),
        local: (m) => {
          const l = real.local(m);
          return { ...l, ...(said("busy").includes(m) ? { queued: Math.max(l.queued, 99), free: 0 } : {}), loaded: said("warm").includes(m) ? [...l.loaded, m] : l.loaded };
        },
      });
      // What the backend it lands on is known to take, as a real request would be checked before it is queued.
      const small = r.target === "local" ? unfit(pool.statsFor(r.model), need) : null;
      json(c.res, 200, {
        target: r.target, model: r.model, lane: r.lane, reason: r.reason, path: r.path, params: r.params, actions: r.actions.map((a) => a.name), ...(r.unlisted ? { unlisted: true } : {}), ...(small ? { unfit: `${r.model} ${small}` } : {}),
        ...(r.target === "peer" ? { peer: r.peer } : r.target === "local" ? { backend: pool.for(r.model).name } : {}),
      });
    } catch (e) {
      fail(c.res, e);
    }
  }

  /** Route a chat request and run it, then tell the actions that wait for how it ended. */
  async function dispatch(
    payload: Record<string, unknown>,
    asked: string,
    askedLane: string,
    caller: string,
    res: ServerResponse,
    signal: AbortSignal,
    onPosition?: (position: number) => void,
    id?: string,
    headers: World["headers"] = {},
  ): Promise<void> {
    const ended: ((error: string | null) => void)[] = [];
    let error: string | null = null;
    try {
      const status = await route(payload, asked, askedLane, caller, res, signal, ended, onPosition, id, headers);
      if (status >= 400) error = `backend answered ${status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      for (const tell of ended) tell(error);
    }
  }

  /** Returns the status a local backend relayed, or 0 when a peer answered. */
  async function route(
    payload: Record<string, unknown>,
    asked: string,
    askedLane: string,
    caller: string,
    res: ServerResponse,
    signal: AbortSignal,
    ended: ((error: string | null) => void)[],
    onPosition?: (position: number) => void,
    id?: string,
    headers: World["headers"] = {},
  ): Promise<number> {
    // Refresh peer state only when a decision needs it, and only for requests that may leave.
    if (mayLeave(cfg, asked)) await peers.ensureFresh();

    // The flow reads each model on the backend that would serve it here: a node with an idle
    // embedder and a busy GPU has no single answer to "am I busy". Per model, like a peer's
    // numbers, since a backend's flat count says "free" while THIS model's slots are full.
    // What this request asks for goes with it, so a peer whose model is too small is passed over
    // rather than sent the prompt across the network to be refused there.
    const talk = conversation(caller, asked, payload);
    const world: World = {
      ...worldFor(caller, askedLane, needsOf(payload, cfg.models[asked]?.videoTokens), rulesFor(caller), headers),
      // Only a later turn is held to where the conversation started; an opening turn is decided afresh.
      ...(talk?.later ? { pinned: (flow: string) => { const at = placed.get(`${flow}\0${talk.key}`); return at && at.until > Date.now() ? at.end : undefined; } } : {}),
    };
    const startedAt = Date.now();
    const flowsNow = world.cfg.flows;
    const decision = resolve(asked, world);
    // A name this node does not offer is not found, which is a different answer from one it will not run right now.
    if (decision.unlisted) throw new Refusal(404, decision.reason);
    // Nor is one that takes paths of its own a chat model.
    const paths = flowsNow[decision.via[0] ?? ""]?.takes;
    if (paths) throw new Refusal(404, `"${asked}" is not offered as chat: it takes ${paths.join(", ")}`);
    // What the flow chose, which a fallback from a failed peer may change again.
    let model = decision.model;
    let lane = decision.lane;
    let local = pool.for(model);
    const land = (r: { model: string; lane: string; params: Record<string, unknown> }): void => {
      model = r.model;
      lane = r.lane;
      local = pool.for(model);
      Object.assign(payload, r.params);
      // Our id for it, so the backend is asked for what the flow chose and not what the client named.
      if (model !== asked) payload.model = model;
      // The caller can read off which model answered, since one name may run as several; a node may keep that to itself.
      if (cfg.modelHeader && !res.headersSent) res.setHeader("x-hearth-model", model);
    };
    land(decision);
    // Each action a deciding step names is set off once per request, however many times it is re-routed:
    // as the step decides, or once the request has ended for one that waits to hear how.
    const fired = new Set<string>();
    const fire = (r: typeof decision): void => {
      if (flowsNow === cfg.flows) countHits(r.path);
      // A sticky flow remembers where it put this conversation, for its later turns.
      const sticky = flowsNow[r.path.at(-1)?.flow ?? ""]?.sticky;
      if (talk && sticky !== undefined && r.target !== "unavailable") {
        const key = `${r.path.at(-1)!.flow}\0${talk.key}`;
        placed.delete(key);
        placed.set(key, { end: r.target === "peer" ? { peer: r.peer, model: r.model } : { model: r.model }, until: Date.now() + sticky });
        if (placed.size > PLACED_MAX) placed.delete(placed.keys().next().value!);
      }
      // A step with a limit counts this request against it until the response closes.
      for (const p of r.path) {
        if (flowsNow[p.flow]?.steps[p.step]?.max === undefined) continue;
        const key = `${p.flow}\0${p.step}`;
        stepsBusy.set(key, (stepsBusy.get(key) ?? 0) + 1);
        res.once("close", () => { stepsBusy.set(key, (stepsBusy.get(key) ?? 1) - 1); });
      }
      for (const a of r.actions) {
        const action = cfg.actions[a.name];
        if (!action || fired.has(a.name)) continue;
        fired.add(a.name);
        const facts: ActionFacts = {
          action: a.name, node: cfg.name, asked, model: r.model, target: r.target, peer: r.target === "peer" ? r.peer : "",
          lane: r.lane, caller, tokens: world.need?.tokens ?? 0, images: world.need?.images ?? false, tools: world.need?.tools ?? false,
          flow: a.flow, line: a.step + 1, reason: r.reason, outcome: "decided", ms: 0, error: "",
          backend: r.target === "local" ? pool.for(r.model).name : "", id: id ?? "", queuedMs: 0, ranMs: 0,
        };
        if (action.on === "decided") act(a.name, action, facts);
        else ended.push((error) => {
          const ms = Date.now() - startedAt;
          if ((action.on === "failed" && error === null) || (action.slowerThan > 0 && ms <= action.slowerThan)) return;
          // Where it ended up, which a failed backend or peer may have changed since the step decided.
          const ran = t.startedAt > 0 ? Date.now() - t.startedAt : 0;
          act(a.name, action, { ...facts, model, backend: ranOn, outcome: error === null ? "ok" : "failed", ms, error: error ?? "", queuedMs: ms - ran, ranMs: ran });
        });
      }
    };
    fire(decision);
    if (model !== asked) {
      refuseDegraded(model);
      log.debug("route.flow", { asked, via: decision.via, as: model, reason: decision.reason });
    } else if (decision.target === "local") {
      using(model, res);
    }
    const need = needsOf(payload, cfg.models[model]?.videoTokens);

    // What the local backend answered, for the log and the call history. A
    // relayed 400 — "this prompt does not fit" is the common one — is a failed
    // request that happens to carry a useful body.
    let localStatus = 0;
    /** The backend here that last ran it, for an action told how it ended. */
    let ranOn = "";
    const runLocal = async (spare = false): Promise<void> => {
      ranOn = local.name;
      await local.state.ensureFresh();
    // Our id and the route's params on the way to the backend; untouched when neither is set.
      localStatus = await sendLocal(local.cfg.url, model, payload, res, { signal, ...backendDeadline(local.cfg) }, spare);
    };

    const t: Timing = { enqueuedAt: Date.now(), startedAt: 0 };

    if (decision.target === "unavailable") {
      // Refusing is the point. The operator said this can't run here.
      logRequest(t, { model, lane, caller, target: "unavailable" }, false, decision.reason);
      // The flow's own words: a refusal step's reason, with why a peer was passed over when one was.
      throw new Refusal(503, `${asked} is not being run: ${decision.reason}`, "server_error");
    }

    if (decision.target === "local") {
      // A backend that fails before anything reaches the client is passed over like a peer that is down:
      // the flow is asked again without it, and the request runs where that lands, here.
      const failed = new Set<string>();
      let why = decision.reason;
      for (;;) {
        // A strict router's callers get the model its line names or its failure, so for them nothing is left to ask for.
        const spare = (): ReturnType<typeof resolve> => (routerOf(caller)?.strict
          ? { ...decision, target: "unavailable" as const, reason: "its router never falls back" }
          : resolve(asked, { ...world, noPeers: true, skip: new Set([...failed, model]) }));
        // Refused here only on reported limits, before queueing or evicting; the backend stays the authority.
        const fitted = fitOutput(pool.statsFor(model), needsOf(payload, cfg.models[model]?.videoTokens), payload);
        const tooMuch = unfit(pool.statsFor(model), fitted);
        if (tooMuch !== null) {
          logRequest(t, { model, lane, caller, backend: local.name, target: "local" }, false, tooMuch);
          throw new Refusal(400, `${model} ${tooMuch}`);
        }
        try {
          const elsewhere = spare().target === "local";
          await local.scheduler.submit(
            // A second try goes back through admission without re-applying the caller cap.
            { lane, model, caller, ...(failed.size === 0 ? { maxPerCaller: callerCap(null, cfg), onPosition, ...(id ? { id } : {}) } : {}), signal, tokens: pool.poolTokens(model, fitted) },
            async () => {
              t.startedAt = Date.now();
              await runLocal(elsewhere);
            },
          );
        } catch (e) {
          logRequest(t, { model, lane, caller, backend: local.name, target: "local", reason: why }, false, e);
          const mayMove = !res.headersSent && !signal.aborted && !(e instanceof QueueFullError) && (e instanceof BackendFailed || !(e instanceof Refusal));
          const next = mayMove ? spare() : null;
          if (!next || next.target !== "local" || failed.has(next.model) || next.model === model) throw e;
          log.warn("route.local_failed_trying_next", { asked, model, next: next.model, error: e instanceof Error ? e.message : String(e) });
          failed.add(model);
          land(next);
          fire(next);
          why = next.reason;
          continue;
        }
        logRequest(
          t,
          { model, lane, caller, backend: local.name, target: "local", reason: why,
            ...(localStatus >= 400 ? { status: localStatus } : {}) },
          localStatus < 400,
          localStatus >= 400 ? `backend answered ${localStatus}` : undefined,
        );
        return localStatus;
      }
    }

    const peer = peers.config(decision.peer)!;
    let fellBack = false;
    let lastTarget = "peer" as "peer" | "local";
    log.debug("route.peer", { model, peer: decision.peer, reason: decision.reason });

    try {
      await local.scheduler.submit(
      {
        lane,
        model,
        caller,
        maxPerCaller: callerCap(null, cfg),
        // No local slot: this runs on their hardware, not ours.
        offbox: true,
        ...(id ? { id } : {}),
        peer: decision.peer,
        signal,
      },
      async () => {
        t.startedAt = Date.now();
        // The peer's id, with the route's params still applied.
        const body = pool.outboundBody(model, payload, decision.theirModel);
        try {
          const up = await send(`${peer.url}/v1/chat/completions`, {
            json: body,
            headers: { Authorization: `Bearer ${peer.token}` },
            signal,
            // A peer can accept the connection and then never answer, unlike
            // the local backend. This turns that into a fallback instead of a
            // hang. 0 disables it.
            ...(cfg.peerFirstByteMs > 0 ? { headersTimeoutMs: cfg.peerFirstByteMs } : {}),
          });
          if (!up.ok) {
            const detail = await up.text();
            throw new PeerStatusError(peer.name, up.status, detail.slice(0, 200));
          }
          await pipeThrough(up, res);
        } catch (e) {
          if (res.headersSent) throw e;
          // Where the flow sends it with peers out of the picture; only somewhere here will do.
          const home = resolve(asked, { ...world, noPeers: true });
          if (home.target !== "local") throw e;
          land(home);
          fire(home);
          // Nothing reached the client yet, so they'll never see this.
          log.warn("route.peer_failed_retrying_local", {
            model,
            peer: peer.name,
            error: e instanceof Error ? e.message : String(e),
          });
          fellBack = true;
          lastTarget = "local";
          // A local retry goes back through admission, without re-applying the caller cap.
          await local.scheduler.submit({ lane, model, caller, signal, tokens: pool.poolTokens(model, need) }, () => runLocal());
        }
      },
    );
    } catch (e) {
      // Log the actual last target, local fallback included, with its backend so the call ring counts it.
      logRequest(t, { model, lane, caller, backend: local.name, target: lastTarget, peer: peer.name }, false, e);
      throw e;
    }
    logRequest(
      t,
      { model, lane, caller, backend: local.name, target: lastTarget, peer: peer.name, offbox: !fellBack,
        ...(fellBack && localStatus >= 400 ? { status: localStatus } : {}) },
      // Only the fallback can have relayed a bad status: a peer's own 4xx threw
      // a PeerStatusError further up and never reached here.
      !fellBack || localStatus < 400,
      fellBack && localStatus >= 400 ? `backend answered ${localStatus}` : undefined,
    );
    return fellBack ? localStatus : 0;
  }

  /** Requests being served now, for the drain in `close()`; counts requests, not queued jobs. */
  let inFlight = 0;
  let drained: (() => void) | null = null;
  /** Responses that are open but are not work — the event stream. */
  const parked = new WeakSet<ServerResponse>();

  /** Stop counting a long-lived stream as in-flight work, so shutdown does not wait on an open page. */
  function notWork(res: ServerResponse): void {
    if (parked.has(res)) return;
    parked.add(res);
    if (--inFlight === 0) drained?.();
  }

  const server = createServer((req, res) => {
    inFlight++;
    // "close" rather than "finish": it fires for a response that ended and for
    // a client that hung up, which are the same thing to a drain and would
    // otherwise leak the count upward until nothing could ever finish waiting.
    res.on("close", () => {
      if (parked.has(res)) return;
      if (--inFlight === 0) drained?.();
    });
    void handle(req, res).catch((e) => {
      log.error("request.failed", { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) apiError(res, 500, "internal error", "server_error");
      else res.end();
    });
  });

  /**
   * Refuse a write carrying a foreign `Origin`: any web page can POST to loopback, and loopback is
   * trusted. curl, peers and apps send no Origin and are unaffected.
   */
  function crossOriginWrite(req: IncomingMessage): boolean {
    if (req.method === "GET" || req.method === "HEAD") return false;
    const origin = req.headers.origin;
    if (origin === undefined || origin === "null") return false;
    try {
      return new URL(origin).host !== req.headers.host;
    } catch {
      // An Origin we cannot parse is not one we can vouch for.
      return true;
    }
  }

  /** Forwardable headers, minus an Authorization that is our own api key. */
  function stripOurKey(req: IncomingMessage): Record<string, string | string[]> {
    const out = forwardable(req.headers);
    const given = bearer(req);
    if (given !== "" && cfg.apiKeys.some((k) => secretEq(given, k))) delete out.authorization;
    return out;
  }

  /** One request with its caller already resolved by the route table. */
  interface Call {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    path: string;
    /** The peer whose token authenticated this, or null for a local caller. */
    peer: string | null;
    /** Who to bill and to log: a peer's name, "local", or "key:<label>".
     *  Empty for routes that need no caller. */
    caller: string;
    /** The ids a scoped key may run, or null for an unscoped caller. */
    models: string[] | null;
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

  /** The refusal's shape: OpenAI's envelope on /v1, plain `{error}` elsewhere. */
  type Envelope = "plain" | "openai";

  interface Route {
    path: string | string[];
    /** Methods this route claims; anything else falls through to the passthrough. */
    methods?: string[];
    auth: Auth;
    envelope?: Envelope;
    /** A scoped key may reach this route. Off by default: a new route is
     *  closed to scoped keys until someone decides otherwise. */
    scoped?: true;
    handler: (c: Call) => Promise<void>;
  }

  const refuse = (res: ServerResponse, status: number, msg: string, env: Envelope): void => {
    if (env === "openai") apiError(res, status, msg, status === 401 ? "authentication_error" : "permission_error");
    else json(res, status, { error: msg });
  };

  /** Resolve a route's caller or answer the refusal; the one place a credential becomes an identity. */
  function authorize(r: Route, req: IncomingMessage, res: ServerResponse): Call | null {
    const url = new URL(req.url ?? "/", "http://localhost");
    const base = { req, res, url, path: url.pathname };
    const env = r.envelope ?? "plain";

    if (r.auth === "open") return { ...base, peer: null, caller: "", models: null };

    if (r.auth === "loopback") {
      // Off this machine, the page's data takes an operator session: EventSource cannot send a key.
      const op = sessionOperator(req);
      if (!isLoopback(req) && op === null) {
        refuse(res, 403, "the status page is loopback-only, or open to a logged-in operator", env);
        return null;
      }
      return { ...base, peer: null, caller: op !== null ? "operator:" + op : "", models: null };
    }

    const asPeer = r.auth === "local" ? null : peerCaller(req);
    if (r.auth === "peer") {
      if (asPeer === null) {
        refuse(res, 401, "unknown peer token", env);
        return null;
      }
      return { ...base, peer: asPeer, caller: asPeer, models: null };
    }

    // A live operator session is a full local identity: no scope, so nothing below it can refuse.
    let asLocal = localCaller(req);
    if (asLocal === null) {
      const op = sessionOperator(req);
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
    { path: "/healthz", auth: "open", handler: routeHealthz },

    { path: ["/peer/hello", "/peer/state"], auth: "peer", handler: routePeer },

    // Local only: /control changes state, so a peer must never reach it.
    { path: "/network", auth: "local", handler: routeNetwork },
    { path: "/control", auth: "local", handler: routeControl },
    { path: "/restart", methods: ["POST"], auth: "local", handler: routeRestart },
    { path: "/config", methods: ["GET", "PATCH", "POST"], auth: "local", handler: routeConfig },
    { path: "/config/draft", methods: ["GET", "PUT", "DELETE"], auth: "local", handler: routeConfigDraft },
    { path: "/config/versions", methods: ["GET", "POST"], auth: "local", handler: routeConfigVersions },
    { path: "/flows/try", methods: ["POST"], auth: "local", handler: routeFlowsTry },
    { path: "/queue", auth: "local", handler: routeQueue },
    { path: "/queue/events", methods: ["GET"], auth: "local", handler: routeQueueEvents },

    // Mint and revoke write the config file, and the node follows it at once.
    { path: ["/keys/mint", "/keys/revoke"], methods: ["POST"], auth: "local", handler: routeKeys },

    // The OpenAI surface: a peer may send us work here, and so may we.
    { path: "/v1/warm", methods: ["POST"], auth: "either", envelope: "openai", handler: routeWarm },
    { path: "/v1/evict", methods: ["POST"], auth: "local", envelope: "openai", handler: routeEvict },
    { path: ["/v1/models", "/v1/models/*"], auth: "either", envelope: "openai", scoped: true,
      handler: routeModels },
    { path: "/v1/chat/completions", methods: ["POST"], auth: "either", envelope: "openai",
      scoped: true, handler: routeChat },

    // Login and logout take no credential by definition; cross-origin POSTs are refused above.
    { path: "/login", methods: ["POST"], auth: "open", handler: routeLogin },
    { path: "/logout", methods: ["POST"], auth: "open", handler: routeLogout },
    // First run: whoever reaches the console before an operator exists creates one. Closed after.
    { path: "/setup", methods: ["GET", "POST"], auth: "open", handler: routeSetup },

    // A bare address typed into a browser lands on the console instead of a 401.
    { path: "/", methods: ["GET", "HEAD"], auth: "open", handler: async (c) => {
      c.res.writeHead(302, { Location: "/ui" }).end();
    } },

    // The page is static — every byte of data comes from /ui/data and /ui/events — so it may go
    // out wide; the gate that matters is the one on the data stream.
    { path: ["/ui", "/ui/"], auth: "open", handler: routeUi },
    { path: ["/ui/data", "/ui/events"], auth: "loopback", envelope: "openai", handler: routeUi },
    // The history view's day and the Logs page, fetched on demand rather than pushed with every frame.
    { path: "/ui/history", methods: ["GET"], auth: "loopback", envelope: "openai",
      handler: async (c) => json(c.res, 200, history.since(DAY_MS)) },
    { path: "/ui/logs", methods: ["GET"], auth: "loopback", envelope: "openai",
      handler: async (c) => json(c.res, 200, { entries: logs.all(), persisted: cfg.historyFile !== null }) },

    { path: "*", auth: "local", envelope: "openai", handler: routePassthrough },
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
    if (crossOriginWrite(req)) {
      log.warn("request.cross_origin", { path, method: req.method, origin: req.headers.origin });
      apiError(res, 403, "cross-origin writes are refused", "permission_error");
      return;
    }

    for (const r of ROUTES) {
      if (!claims(r, path, req.method)) continue;
      const c = authorize(r, req, res);
      if (c === null) return;
      await r.handler(c);
      return;
    }
  }

  /**
   * Whether this node can serve, for an external probe: 503 only when every backend we hold an
   * event stream to is gone. Peers never affect it. Unauthenticated, so counts only, never names.
   */
  async function routeHealthz(c: Call): Promise<void> {
    const { res } = c;
    const local = pool.all();
    const watched = local.filter((b) => b.state.watched());
    const connected = watched.filter((b) => b.state.streamingNow());
    const ok = watched.length === 0 || connected.length > 0;
    json(res, ok ? 200 : 503, {
      ok,
      name: cfg.name,
      backends: {
        total: local.length,
        watched: watched.length,
        connected: connected.length,
      },
      peers: {
        total: cfg.peers.length,
        up: peers.all().filter((p) => p.up).length,
      },
      // Only with a canary configured, and as a count: this endpoint is unauthenticated
      // and may be bound wide, so it says how many models are out, never which.
      ...(canary ? { canary: { degraded: canary.degradedCount() } } : {}),
    });
    return;
  }

  // ---- peer surface ----
  async function routePeer(c: Call): Promise<void> {
    const { res, path } = c;
    const who = c.peer!;
    // Control plane, not work, so it gets its own budget. See overBudget.
    if (controlOverLimit(who)) {
      json(res, 429, { error: "rate capped" });
      return;
    }
    if (path === "/peer/hello") {
      json(res, 200, {
        name: cfg.name,
        protocol: 2,
        models: shared(),
        lanes: Object.keys(cfg.scheduler.lanes),
        // Additive, so older peers ignore it and newer ones need not probe.
        capabilities: ["warm"],
      });
      return;
    }
    // Loaded and served models ride with capacity, both filtered to what we share.
    const warmAndShared = pool.loaded().filter((m) => shared().includes(m));
    const agg = pool.aggregate();
    // Protocol 2: capacity per shared model, beside the aggregate protocol-1 peers still read.
    const models: Record<string, unknown> = {};
    for (const m of shared()) {
      // Per-model stats, absent until loaded; silence is not a claim of no limit.
      const stats = pool.statsFor(m);
      models[m] = { ...pool.capacityFor(m), ...(stats ? { stats } : {}) };
    }
    json(res, 200, {
      ...agg,
      resident: agg.resident !== null && shared().includes(agg.resident) ? agg.resident : null,
      loaded: warmAndShared,
      serves: shared(),
      models,
    });
    return;
  }

  async function routeNetwork(c: Call): Promise<void> {
    const { res } = c;
    // Ask everyone now instead of reading a cache. Someone is sitting there
    // waiting on this, and the cost is one parallel round trip capped at 1.5s
    // per peer.
    await Promise.all([peers.probeAll(), ...pool.all().map((b) => b.state.ensureFresh())]);
    json(res, 200, networkView());
    return;
  }

  /**
   * Read (GET) or change (POST) federation at runtime: `lending`, `borrowing`, per-model `share`
   * (null defers to config), `link`/`unlink`, and `save`. Local only; omitted fields are left alone.
   */
  /** Drain and exit non-zero, so a supervisor with Restart=on-failure starts the node again. */
  async function routeRestart(c: Call): Promise<void> {
    if (node.onRestart === null) {
      json(c.res, 501, { error: "this node was not started by `hearth serve`, so it cannot restart itself" });
      return;
    }
    log.info("restart.requested", { caller: c.caller });
    json(c.res, 202, { ok: true });
    node.onRestart();
  }

  async function routeControl(c: Call): Promise<void> {
    const { req, res } = c;
    if (req.method === "GET") {
      json(res, 200, { ...controls.state(), share: shared(), catalog: pool.catalog(), config: config.status() });
      return;
    }
    if (req.method !== "POST") {
      apiError(res, 405, "use GET to read or POST to change");
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString()) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        res.setHeader("Connection", "close");
        apiError(res, 413, e.message);
        return;
      }
      apiError(res, 400, `body was not JSON: ${String(e)}`);
      return;
    }
    // Strict booleans. A missing field means "leave it", so accepting a
    // truthy string here would make `{"lending":"false"}` turn lending ON —
    // the exact opposite of what someone typing that in a hurry wants.
    for (const k of ["lending", "borrowing"]) {
      if (body[k] !== undefined && typeof body[k] !== "boolean") {
        apiError(res, 400, `${k} must be true or false`);
        return;
      }
    }

    // Share only models we can serve, or peers are advertised a model that 404s.
    if (body.share !== undefined) {
      if (typeof body.share !== "object" || body.share === null || Array.isArray(body.share)) {
        apiError(res, 400, "share must be an object of model -> true, false or null");
        return;
      }
      const catalog = pool.catalog();
      for (const [model, want] of Object.entries(body.share as Record<string, unknown>)) {
        if (want !== true && want !== false && want !== null) {
          apiError(res, 400, `share.${model} must be true, false or null`);
          return;
        }
        if (want === true && !catalog.includes(model)) {
          apiError(
            res,
            400,
            `cannot lend "${model}" — no backend here serves it (${catalog.join(", ") || "nothing"})`,
          );
          return;
        }
      }
    }

    if (body.notes !== undefined) {
      if (typeof body.notes !== "object" || body.notes === null || Array.isArray(body.notes)) {
        apiError(res, 400, "notes must be an object of model -> text or null");
        return;
      }
      for (const [model, text] of Object.entries(body.notes as Record<string, unknown>)) {
        if (text !== null && typeof text !== "string") {
          apiError(res, 400, `notes.${model} must be text or null`);
          return;
        }
        if (typeof text === "string" && text.trim().length > NOTE_MAX) {
          apiError(res, 400, `notes.${model} is over ${NOTE_MAX} characters`);
          return;
        }
      }
    }

    // Everything validates before anything mutates, so a combined POST lands whole or not at all.
    if (body.link !== undefined && body.unlink !== undefined) {
      // Silently preferring one is how you end up having removed a mapping
      // you thought you were adding.
      apiError(res, 400, "send link or unlink, not both");
      return;
    }
    let edit: { peer: string; mine: string; theirs: string; policy: RoutePolicy; fallbackLocal: boolean; unlink: boolean } | null = null;
    if (body.link !== undefined || body.unlink !== undefined) {
      const e = (body.link ?? body.unlink) as Record<string, unknown>;
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        apiError(res, 400, "link/unlink must be an object");
        return;
      }
      const peerName = typeof e.peer === "string" ? e.peer : "";
      const mine = typeof e.mine === "string" ? e.mine : "";
      if (peerName === "" || mine === "") {
        apiError(res, 400, "link/unlink need peer and mine");
        return;
      }
      // If we serve it too, `fastest` with local fallback; if not, peer only, since home would 404.
      const local = pool.catalog().includes(mine);
      const policy = (e.policy as RoutePolicy | undefined) ?? (local ? "fastest" : "peer");
      if (!["local", "peer", "spillover", "fastest"].includes(policy)) {
        apiError(res, 400, `policy must be local, peer, spillover or fastest (got ${policy})`);
        return;
      }
      edit = {
        peer: peerName, mine, policy, unlink: body.unlink !== undefined,
        theirs: typeof e.theirs === "string" && e.theirs !== "" ? e.theirs : mine,
        fallbackLocal: typeof e.fallbackLocal === "boolean" ? e.fallbackLocal : local,
      };
    }

    // One write: every config edit in this POST lands in hearth.yaml together, or none does.
    if (edit || body.notes !== undefined || body.share !== undefined) {
      try {
        config.update((d) => {
          if (edit?.unlink) unlink(d, edit.peer, edit.mine);
          else if (edit) link(d, edit.peer, edit.mine, edit.theirs, edit.policy, edit.fallbackLocal);
          for (const [model, text] of Object.entries((body.notes ?? {}) as Record<string, string | null>)) setNote(d, model, text);
          for (const [model, want] of Object.entries((body.share ?? {}) as Record<string, boolean | null>)) {
            // null meant "defer to the file" when edits were a layer over it; the file is all there is now.
            if (want !== null) setShare(d, model, want);
          }
        });
      } catch (e) {
        failConfig(res, e);
        return;
      }
      log.info("control.config", {
        ...(edit ? { [edit.unlink ? "unlink" : "link"]: { peer: edit.peer, model: edit.mine } } : {}),
        ...(body.notes !== undefined ? { notes: Object.keys(body.notes as object) } : {}),
        ...(body.share !== undefined ? { share: shared() } : {}),
      });
    }

    const changed = controls.set({
      lending: body.lending as boolean | undefined,
      borrowing: body.borrowing as boolean | undefined,
    });
    // Only the transitions; a no-op POST should not leave a trail implying something moved.
    if (Object.keys(changed).length > 0) {
      log.info("control.changed", changed);
      void broadcast();
    }
    // `save` is accepted and does nothing: every edit above is already in the file.

    json(res, 200, { ...controls.state(), share: shared(), changed, config: config.status() });
    return;
  }

  /** A config refusal as `{error: {message, path}}`, so a form can put it beside its field. */
  function failConfig(res: ServerResponse, e: unknown): void {
    if (e instanceof ConfigRefusal) {
      json(res, e.status, { error: { message: e.message, type: "invalid_request_error", path: e.path } });
      return;
    }
    fail(res, e);
  }

  /**
   * hearth.yaml itself: GET is its text, hash and status; PATCH takes `{baseHash, ops}` or
   * `{baseHash, text}` (and `dryRun`), writes the file and applies it, or says why not.
   */
  async function routeConfig(c: Call): Promise<void> {
    const { req, res } = c;
    if (req.method === "GET") {
      try {
        json(res, 200, { ...config.text(), ...config.status() });
      } catch (e) {
        failConfig(res, e);
      }
      return;
    }
    try {
      const body = await readJson(req);
      const ops = body.ops;
      if (ops !== undefined && !Array.isArray(ops)) throw new Refusal(400, "ops must be a list of {path, value} or {path, delete: true}");
      if (body.text !== undefined && typeof body.text !== "string") throw new Refusal(400, "text must be the whole file as a string");
      const out = config.patch({
        ...(typeof body.baseHash === "string" ? { baseHash: body.baseHash } : {}),
        ...(ops ? { ops: ops as never } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        dryRun: body.dryRun === true,
        ...(typeof body.name === "string" ? { name: body.name.trim().slice(0, 80) } : {}),
      });
      if (body.dryRun !== true) log.info("config.patched", { hash: out.hash, restartPending: out.restartPending });
      json(res, 200, { ...config.status(), ...out });
    } catch (e) {
      failConfig(res, e);
    }
  }

  /** The console's draft of the file: kept here so it is there tomorrow and from another browser. Nothing reads it but the console. */
  async function routeConfigDraft(c: Call): Promise<void> {
    const { req, res } = c;
    try {
      if (req.method === "PUT") config.keepDraft(await readJson(req));
      else if (req.method === "DELETE") config.keepDraft(null);
      json(res, 200, { draft: config.draft() });
    } catch (e) {
      failConfig(res, e);
    }
  }

  /** The versions written through the node, and `POST { hash, dryRun? }` to make one of them the file again. */
  async function routeConfigVersions(c: Call): Promise<void> {
    const { req, res } = c;
    try {
      if (req.method === "GET") { json(res, 200, { versions: config.versions() }); return; }
      const body = await readJson(req);
      if (typeof body.hash !== "string") throw new Refusal(400, "hash must be the hash of a kept version");
      const out = config.restore(body.hash, body.dryRun === true);
      if (body.dryRun !== true) log.info("config.restored", { hash: out.hash });
      json(res, 200, { ...config.status(), ...out });
    } catch (e) {
      failConfig(res, e);
    }
  }

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
  const keysView = (): KeyInfo[] =>
    cfg.apiKeys.map((k, i) => {
      const caller = "key:" + (cfg.apiKeyLabels[i] || keyId(k));
      return { label: cfg.apiKeyLabels[i] ?? "", id: keyId(k), models: cfg.apiKeyModels[i] ?? null, lastSeen: keySeen.get(caller) ?? null };
    });

  // Drop a model off the card that serves it. Per-model where the backend can, because that
  // leaves the card's other residents working; a whole-card clear only as its one and only verb,
  // and then only when nothing else is resident to lose.
  async function routeEvict(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (model === "") throw new Refusal(400, "model is required");
      const slot = pool.for(model);
      const wire = pool.outboundId(model);
      if (!slot.state.isWarm(wire)) throw new Refusal(409, `${model} is not resident on ${slot.name} — nothing to evict`);
      // A request that is running would lose its model mid-answer.
      const running = slot.scheduler.view().filter((j) => j.state === "running" && !j.offbox);
      const mine = running.filter((j) => pool.outboundId(j.model) === wire).length;
      if (mine > 0) throw new Refusal(409, `${model} is answering ${mine} request${mine > 1 ? "s" : ""} — evict it once ${mine > 1 ? "they finish" : "it finishes"}`);
      let via: "model" | "card";
      if (await slot.state.dropOne(wire)) {
        via = "model";
      } else if (slot.state.canUnload() && slot.state.loaded().length === 1 && running.length === 0) {
        await slot.state.unload();
        via = "card";
      } else {
        const others = slot.state.loaded().filter((m) => m !== wire);
        throw new Refusal(409, others.length > 0
          ? `${slot.name} keeps ${others.length} other resident model${others.length > 1 ? "s" : ""} and this kind can only clear the whole card`
          : `${slot.name} cannot drop a single model`);
      }
      log.info("pool.evicted", { model, backend: slot.name, via, caller: c.caller });
      json(c.res, 200, { model, backend: slot.name, evicted: true, via });
    } catch (e) {
      fail(c.res, e);
    }
  }

  // The keys page's two writes: mint appends one entry, revoke removes one. Both land in the
  // config file through the same patch path every other config change uses, and take effect at
  // once. The plaintext comes back once, in the mint's answer.
  async function routeKeys(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (label === "" || label.length > 40) throw new Refusal(400, "label must be 1-40 characters");
      if (c.path === "/keys/mint") {
        if (cfg.apiKeyLabels.includes(label)) throw new Refusal(409, `label ${label} is already used`);
        const models = Array.isArray(body.models)
          ? [...new Set((body.models as unknown[]).map((m) => {
              if (typeof m !== "string" || cfg.models[m] === undefined) throw new Refusal(400, `model ${JSON.stringify(m)} is not configured here`);
              return m;
            }))] as string[]
          : null;
        const key = "hkey_" + randomBytes(20).toString("hex");
        const entry: Record<string, unknown> = { key, label };
        if (models !== null && models.length > 0) entry.models = models;
        const commit = config.patch({ ops: [{ path: ["apiKeys", cfg.apiKeys.length], value: entry }] });
        log.info("keys.minted", { label, id: keyId(key), caller: c.caller });
        json(c.res, 200, { key, label, models, restartPending: commit.restartPending });
        return;
      }
      const i = cfg.apiKeyLabels.indexOf(label);
      if (i < 0) throw new Refusal(404, `no key labeled ${label}`);
      const commit = config.patch({ ops: [{ path: ["apiKeys", i], delete: true }] });
      keySeen.delete("key:" + label);
      log.info("keys.revoked", { label, caller: c.caller });
      json(c.res, 200, { label, revoked: true, restartPending: commit.restartPending });
    } catch (e) {
      failConfig(c.res, e);
    }
  }

  // Ask a model to be resident without generating. Queued like any job, since loading one evicts
  // another; best-effort, and nothing reserves it.
  async function routeWarm(c: Call): Promise<void> {
    try {
      // A warm spends the GPU, so it meets the same gates as chat.
      admitPeer(c);
      const body = await readJson(c.req);
      const model = typeof body.model === "string" ? body.model : "";
      admit(c, model);
      await warm(c, model);
    } catch (e) {
      fail(c.res, e);
    }
  }

  async function warm(c: Call, model: string): Promise<void> {
    const { res } = c;
    const fromPeer = c.peer;
    const caller = c.caller;

    // Same routing question chat asks. Phase 1 implements only the local
    // answer, but asking it here is what makes peer warming a branch of this
    // route later rather than a second endpoint with its own opinions.
    const slotFor = pool.for(model);
    const load = localLoad(slotFor, model);
    const decision = fromPeer !== null
      // A peer's warm is served here or nowhere. Forwarding it onward would
      // let two nodes that each prefer the other bounce a warm between them,
      // the same loop the chat route avoids by not re-routing peer work.
      ? ({ target: "local", reason: "from a peer" } as const)
      : decide(model, cfg, peers, load);

    // A peer's warm is taken only if it can start now; it may never make us wait or evict on its schedule.
    if (fromPeer !== null && load.free <= 0) {
      json(res, 503, {
        model, warmed: false, declined: true,
        note: `${cfg.name} is busy; warm requests from peers are only taken when a slot is free`,
      });
      return;
    }

    if (decision.target === "peer") {
      const p = peers.config(decision.peer);
      const theirId = peers.theirModelId(decision.peer, model);
      if (!p || theirId === undefined) {
        apiError(res, 502, `no route to ${decision.peer} for ${model}`, "server_error");
        return;
      }
      // Ask the peer whether it supports warming; its status codes cannot tell us.
      if (!peers.supports(decision.peer, "warm")) {
        apiError(res, 501,
          `peer ${decision.peer} does not advertise warm support`,
          "invalid_request_error");
        return;
      }
      // Their id, not ours — the same rewrite the chat peer branch does.
      // No local slot is taken: this warms THEIR hardware, not ours.
      try {
        const up = await send(`${p.url}/v1/warm`, {
          method: "POST",
          json: { model: theirId },
          headers: { Authorization: `Bearer ${p.token}` },
          signal: AbortSignal.any([
            AbortSignal.timeout(900_000),
          ]),
        });
        const text = await up.text().catch(() => "");
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
        if (up.status === 404 || up.status === 501 || up.status === 401) {
          // Belt and braces: it advertised the capability but did not honour
          // it, so it is mid-upgrade or misconfigured. Name the node, rather
          // than surfacing a bare status from a machine you do not own.
          apiError(res, 501,
            `peer ${decision.peer} advertised warm support but answered ${up.status}`,
            "invalid_request_error");
          return;
        }
        log.info("warm.peer", { model, peer: decision.peer, status: up.status });
        // Pass their answer through, including a decline, in OUR id.
        json(res, up.ok ? 200 : up.status, { ...parsed, model, peer: decision.peer });
      } catch (e) {
        apiError(res, 502, e instanceof Error ? e.message : String(e), "server_error");
      }
      return;
    }

    const slot = slotFor;
    const wire = pool.outboundId(model);
    // Only a backend that swaps models has anything to warm; saying "warmed" elsewhere claims work that did not happen.
    if (!slot.state.canUnload()) {
      json(res, 200, {
        model, backend: slot.name, warmed: false,
        note: `${slot.name} keeps its models resident, so there is nothing to warm`,
      });
      return;
    }
    if (slot.state.isWarm(wire)) {
      json(res, 200, {
        model, backend: slot.name, warmed: false, note: "already resident",
      });
      return;
    }

    const ctrl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
    const queuedAt = Date.now();
    let startedAt = 0;
    try {
      await slot.scheduler.submit(
        { lane: WARM_LANE, model, caller, maxPerCaller: callerCap(fromPeer, cfg), signal: ctrl.signal },
        async () => {
          startedAt = Date.now();
          // A health probe on the model's upstream loads it without generating, within the backend deadline.
          const up = await send(`${slot.cfg.url}/upstream/${encodeURIComponent(wire)}/health`, {
            method: "GET",
            signal: ctrl.signal,
            ...backendDeadline(slot.cfg),
          });
          if (!up.ok) throw new Error(`backend returned ${up.status} warming ${wire}`);
          await up.text().catch(() => "");
          // So the very next /ui/data or /network sees it, rather than waiting
          // out the poll interval and looking like the warm did nothing.
          await slot.state.refresh().catch(() => {});
        },
      );
    } catch (e) {
      const r = refusalOf(e);
      if (r.status >= 500) log.warn("warm.failed", { model, backend: slot.name, error: r.message });
      throw r;
    }
    const now = Date.now();
    log.info("warm", { model, backend: slot.name,
                       waitedMs: (startedAt || now) - queuedAt, ranMs: now - (startedAt || now) });
    json(res, 200, {
      model, backend: slot.name, warmed: true,
      waitedMs: (startedAt || now) - queuedAt,
      ranMs: now - (startedAt || now),
      note: "best effort: the next request for another model will evict it",
    });
    return;
  }

  async function routeModels(c: Call): Promise<void> {
    const { res } = c;
    const modelsPeer = c.peer;
    try {
      // The union, so a client sees every model this node can serve rather
      // than only whatever the first backend happens to list. Freshened first
      // so a model added since startup shows up.
      await Promise.all(pool.all().map((b) => b.state.ensureFresh()));
      // Carry warm state, as llama-swap does on this route.
      const warm = new Set(pool.loaded());
      type Entry = {
        id: string; status?: { value: string }; context_length?: number; description?: string;
        input_modalities?: string[];
      };
      // What a client may send, where the model or its operator has said. Silence stays silence.
      const input = (stats: ModelStats | null | undefined): string[] | undefined =>
        typeof stats?.vision === "boolean" ? (stats.vision ? ["text", "image"] : ["text"]) : undefined;
      const upstream: { data?: Entry[] } = {
        data: pool.catalog().map((id) => {
          // Unknown warmth or window is omitted, never reported as cold or null.
          const entry: Entry = { id };
          const stats = pool.statsFor(id);
          if (stats?.note) entry.description = stats.note;
          // A degraded model is loaded and answering, just not with an answer,
          // so its status wins over warmth: "loaded" would read as healthy.
          const sick = canary?.refuse(id);
          if (sick) {
            entry.status = { value: "degraded" };
            entry.description = `${sick.detail} (since ${new Date(sick.since).toISOString()})`;
            return entry;
          }
          if (!pool.for(id).state.knowsWarm()) return entry;
          entry.status = { value: warm.has(id) ? "loaded" : "unloaded" };
          const ctx = pool.contextLength(id);
          if (ctx !== null) entry.context_length = ctx;
          const takes = input(stats);
          if (takes) entry.input_modalities = takes;
          return entry;
        }),
      };
          // Peer-only models under our ids, with what the peer last reported; a local reading wins.
      const seen = new Set(upstream.data!.map((m) => m.id));
      for (const p of peers.all()) {
        for (const [mine, theirs] of Object.entries(peers.config(p.name)?.models ?? {})) {
          if (seen.has(mine)) continue;
          seen.add(mine);
          const entry: Entry = { id: mine };
          const per = p.capacity?.models?.[theirs];
          if (per) entry.status = { value: per.warm ? "loaded" : "unloaded" };
          if (per?.stats?.context !== undefined) entry.context_length = per.stats.context;
          if (per?.stats?.note) entry.description = per.stats.note;
          const takes = input(per?.stats);
          if (takes) entry.input_modalities = takes;
          upstream.data!.push(entry);
        }
      }
      // A peer sees only what we share.
      if (modelsPeer !== null) {
        upstream.data = (upstream.data ?? []).filter((m) => shared().includes(m.id));
      } else {
        // Everyone else sees what can be asked for: the names flows take, and every model as well
        // only where the flow for other names runs them as themselves.
        const mine = rulesFor(c.caller).flows;
        const taken = Object.values(mine).filter((f) => !f.off).flatMap((f) => f.inputs).filter((id) => id !== ANY);
        const open = Object.values(mine).some((f) => !f.off && f.inputs.includes(ANY) && f.steps.some((s) => "asked" in s.to));
        const listed = new Set(upstream.data!.map((m) => m.id));
        if (!open) upstream.data = upstream.data!.filter((m) => taken.includes(m.id));
        for (const id of taken) if (!listed.has(id)) upstream.data!.push({ id });
        // Each variant a type comes in is a name of its own to ask for.
        for (const id of taken) for (const v of variantsOf(mine, id)) upstream.data!.push({ id: `${id}:${v}` });
      }
      // Same for a scoped key: its picker shows what it may pick.
      if (c.models !== null) {
        upstream.data = (upstream.data ?? []).filter((m) => c.models!.includes(m.id));
      }
      // /v1/models/<id>: one entry from the same list, so a peer model answers
      // here too instead of falling through to the passthrough and asking a
      // local backend that has never heard of it.
      if (c.path.startsWith("/v1/models/")) {
        const want = c.path.slice("/v1/models/".length);
        const one = upstream.data!.find((m) => m.id === want);
        if (one === undefined) {
          apiError(res, 404, `no model "${want}"`, "invalid_request_error");
          return;
        }
        json(res, 200, one);
        return;
      }
      json(res, 200, upstream);
    } catch (e) {
      apiError(res, 502, `backend unreachable: ${String(e)}`, "server_error");
    }
    return;
  }

  async function routeChat(c: Call): Promise<void> {
    try {
      admitPeer(c);
      const payload = await readJson(c.req);
      const model = typeof payload.model === "string" ? payload.model : "";
      admit(c, model);
      // Before anything is queued or routed: a degraded seat is out of rotation
      // for everyone, peers included.
      refuseDegraded(model);
      await chat(c, model, payload);
    } catch (e) {
      fail(c.res, e);
    }
  }

  async function chat(c: Call, asked: string, payload: Record<string, unknown>): Promise<void> {
    const { res } = c;
    let model = asked;
    // A peer's request gets served here and never routed onward. Two nodes
    // that each prefer the other would otherwise bounce a request back and
    // forth until something gave out.
    const fromPeer = c.peer;
    const caller = c.caller;
    if (fromPeer !== null) {
      // A borrower's oversized request gets the local path's 4xx before it is queued.
      const why = unfit(pool.statsFor(model), fitOutput(pool.statsFor(model), needsOf(payload, cfg.models[model]?.videoTokens), payload));
      if (why !== null) throw new Refusal(400, `${model} ${why}`);
    }

    // Peers get cfg.peerLane; local callers may send a `lane` (stripped before forwarding); a route's lane wins.
    let lane =
      fromPeer !== null
        ? cfg.peerLane
        : cfg.models[model]?.lane ??
          (typeof payload.lane === "string" && payload.lane in cfg.scheduler.lanes
            ? payload.lane
            : Object.keys(cfg.scheduler.lanes)[0]!);
    delete payload.lane;

    const ctrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ctrl.abort();
    });

    if (fromPeer === null) {
      await dispatch(payload, model, lane, caller, res, ctrl.signal, positionStream(c.req, res, payload), jobId(c.req), headersOf(c.req));
      return;
    }
    // A peer running a model here is that model in use.
    using(model, res);

    const t: Timing = { enqueuedAt: Date.now(), startedAt: 0 };
    const serving = pool.for(model);
    // As on the local path: what we relayed to the borrower, so lent
    // capacity that failed is not filed as lent capacity that worked.
    let lentStatus = 0;
    try {
      await serving.scheduler.submit(
        // Peers are capped by peerMaxConcurrent per backend, whether or not apiKeys are set.
        { lane, model, caller, maxPerCaller: callerCap(fromPeer, cfg), signal: ctrl.signal, tokens: pool.poolTokens(model, needsOf(payload, cfg.models[model]?.videoTokens)) },
        async () => {
          t.startedAt = Date.now();
          await serving.state.ensureFresh();
          // A lent request gets the same id rewrite and params as a local one.
          lentStatus = await sendLocal(serving.cfg.url, model, payload, res, { signal: ctrl.signal, ...backendDeadline(serving.cfg) });
        },
      );
    } catch (e) {
      // Log lent failures too.
      logRequest(t, { model, lane, target: "local", forPeer: fromPeer }, false, e);
      throw e;
    }
    // Lent capacity is the thing you most want a record of.
    logRequest(
      t,
      { model, lane, target: "local", forPeer: fromPeer,
        ...(lentStatus >= 400 ? { status: lentStatus } : {}) },
      lentStatus < 400,
      lentStatus >= 400 ? `backend answered ${lentStatus}` : undefined,
    );
  }

  /** The operator login: verify against the config's hash, mint a session, set the cookie. */
  async function routeLogin(c: Call): Promise<void> {
    if (!cfg.operator) {
      json(c.res, 404, { error: "no operator login is configured on this node" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(c.req, cfg.maxBodyBytes)).toString() || "{}");
    } catch {
      json(c.res, 400, { error: "the login body must be JSON" });
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      json(c.res, 400, { error: "the login body must be JSON" });
      return;
    }
    const user = typeof body.user === "string" ? body.user : "";
    const pass = typeof body.pass === "string" ? body.pass : "";
    const ip = c.req.socket.remoteAddress ?? "?";
    const now = Date.now();
    if (loginThrottle.blocked(user, ip, now)) {
      json(c.res, 429, { error: "too many failed logins — try again in a few minutes" });
      return;
    }
    // An unknown username burns one full scrypt, so response time says nothing about it.
    const ok = user !== "" && secretEq(user, cfg.operator.user)
      ? await verifyPassword(pass, cfg.operator.passHash)
      : await verifyDecoy(pass);
    if (!ok) {
      loginThrottle.note(user, ip, now);
      log.warn("login.failed", { ip, user: user === "" ? null : user });
      json(c.res, 401, { error: "bad username or password" });
      return;
    }
    loginThrottle.clear(user);
    startSession(c.res, user, now);
    log.info("login.ok", { ip, caller: "operator:" + user });
    json(c.res, 200, { ok: true });
  }

  function startSession(res: ServerResponse, user: string, now: number): void {
    syncSessions();
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    res.setHeader("Set-Cookie", `${COOKIE}=${sessions.mint(user, now)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
  }

  /** GET says whether the node still needs its first operator; POST creates it and signs it in. */
  async function routeSetup(c: Call): Promise<void> {
    if (c.req.method === "GET") {
      json(c.res, 200, { needed: cfg.operator === null });
      return;
    }
    if (cfg.operator) {
      json(c.res, 409, { error: "this node already has an operator — log in instead" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse((await readBody(c.req, cfg.maxBodyBytes)).toString() || "{}");
    } catch {
      json(c.res, 400, { error: "the setup body must be JSON" });
      return;
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const user = typeof b.user === "string" ? b.user.trim() : "";
    const pass = typeof b.pass === "string" ? b.pass : "";
    if (user === "" || pass.length < 8) {
      json(c.res, 400, { error: "a username and a password of at least 8 characters" });
      return;
    }
    const passHash = await hashPassword(pass);
    // Re-checked after the await: two first-run tabs must not both win.
    if (cfg.operator) {
      json(c.res, 409, { error: "this node already has an operator — log in instead" });
      return;
    }
    try {
      config.patch({ ops: [{ path: ["operator"], value: { user, passHash } }] });
    } catch (e) {
      json(c.res, e instanceof ConfigRefusal ? e.status : 500, { error: (e as Error).message });
      return;
    }
    startSession(c.res, user, Date.now());
    log.info("setup.operator", { ip: c.req.socket.remoteAddress ?? "?", caller: "operator:" + user });
    json(c.res, 200, { ok: true });
  }

  /** Drop this request's session, if any; a session-less logout is a no-op. */
  async function routeLogout(c: Call): Promise<void> {
    const token = cookieToken(c.req.headers.cookie);
    if (token) sessions.drop(token);
    c.res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    json(c.res, 200, { ok: true });
  }

  /** A caller id like `operator:jadeyn` is the login the page can show and sign out of. */
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

  /** The body with its `model` field renamed; anything that is not a JSON object goes through untouched. */
  function withModel(body: Buffer | undefined, model: string): Buffer | undefined {
    if (!body || body.length === 0) return body;
    try {
      const parsed = JSON.parse(body.toString()) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
      return Buffer.from(JSON.stringify({ ...(parsed as Record<string, unknown>), model }));
    } catch {
      return body;
    }
  }

  /** Everything not claimed above, proxied to a backend as-is. */
  async function routePassthrough(c: Call): Promise<void> {
    const { req, res, url } = c;
    // Both may be rewritten below, when the name a path carries turns out to be one a flow takes.
    let path = c.path;
    let pathname = url.pathname;
    // Everything else is proxied as-is and unqueued (llama-swap's /unload, /running, /upstream/...),
    // unless `backends[].routes` names the path, in which case hearth is its admission control.
    const who = c.caller;
    let body: Buffer | undefined;
    try {
      body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, cfg.maxBodyBytes);
    } catch (e) {
      fail(res, e);
      return;
    }
    // A declared route wins over every heuristic below it, being the only
    // statement here the operator actually made.

    // The model from the /upstream/<model>/ path or the body, else the first backend. A form upload
    // (/v1/audio/transcriptions) names its model in a multipart field rather than in JSON.
    const viaPath = /^\/upstream\/([^/]+)\//.exec(path)?.[1];
    const contentType = req.headers["content-type"] ?? "";
    const isForm = /^\s*multipart\/form-data\b/i.test(contentType);
    let viaBody: string | undefined;
    if (body && body.length > 0) {
      if (isForm) {
        viaBody = multipartField(body, contentType, "model");
      } else {
        try {
          const parsed = JSON.parse(body.toString()) as { model?: unknown };
          if (typeof parsed.model === "string") viaBody = parsed.model;
        } catch {
          // Not JSON, or not ours to understand. The fallback covers it.
        }
      }
    }
    // Work that queues is asked for by name as chat is, and the name's flow says which model runs it. The
    // name is the `{model}` segment of the path or the model in the body; a path that carries neither is
    // asked for by the flow that takes it, else by the model its route names.
    let routed = pool.forPath(pathname);
    const held = pool.named(pathname);
    // For a request a flow decided: the name it went by, how to ask its flow again without what just failed,
    // and the backend its line named when that is not the one that declares the path.
    let flowed: string | null = null;
    let again: ((failed: readonly string[]) => ReturnType<typeof resolve>) | null = null;
    let runOn: BackendSlot | undefined;
    let picked: string | undefined;
    /**
     * The backend that can run a model on this path: the one that declares the path, its route's
     * fallback, or another that serves the model and either declares the path too or declares none.
     */
    const placeOf = (model: string): BackendSlot | undefined => {
      if (!routed) return undefined;
      // The model a route names is its backend's whether or not the backend lists it.
      if (model === routed.rule.model || pool.owns(routed.slot, model)) return routed.slot;
      const fb = routed.rule.fallback ? pool.get(routed.rule.fallback.backend) : undefined;
      if (fb && pool.owns(fb, model)) return fb;
      return pool.all().find((b) => pool.owns(b, model) && (b.cfg.routes.length === 0 || b.cfg.routes.some((x) => x.path === pathname)));
    };
    if (c.peer === null && (held !== undefined || routed?.rule.queue === true)) {
      const rules = rulesFor(who).flows;
      const taker = Object.values(rules).find((f) => !f.off && f.takes?.includes(held?.path ?? pathname));
      const name = held?.name ?? viaBody ?? taker?.inputs[0] ?? routed!.rule.model;
      const world: World = { ...worldFor(who, routed?.rule.lane ?? Object.keys(cfg.scheduler.lanes)[0]!, undefined, rulesFor(who), headersOf(req)), path: held?.path ?? pathname };
      const r = resolve(name, world);
      const refuse = (status: number, why: string) => fail(res, new Refusal(status, why, status === 404 ? "invalid_request_error" : "server_error"));
      if (r.unlisted) return refuse(404, r.reason);
      // A type that says which paths it takes is not offered on any other.
      const takes = rules[r.via[0] ?? ""]?.takes;
      if (takes && !takes.includes(held?.path ?? pathname)) return refuse(404, `"${name}" is not offered on ${held?.path ?? pathname}: it takes ${takes.join(", ")}`);
      if (r.target === "unavailable") return refuse(503, `${name} is not being run: ${r.reason}`);
      if (r.target === "peer") return refuse(503, `${name} is not being run: its flow sends it to a peer, and only chat goes to a peer`);
      settle(r, name, who);
      if (r.model !== name) {
        if (held) {
          pathname = held.as(r.model);
          path = pathname;
          routed = pool.forPath(pathname);
          if (!routed) return refuse(503, `${name} is not being run: its flow sends it to ${r.model}, which does not answer ${held.path}`);
        } else {
          // The model the flow picked has to be one this path can run, here or on another backend.
          const at = placeOf(r.model);
          if (!at) return refuse(503, `${name} is not being run: its flow sends it to ${r.model}, which does not answer ${pathname}`);
          if (at !== routed!.slot) runOn = at;
          picked = r.model;
          // A body that named what it asked for names the model instead; one that named nothing is left as it came.
          if (viaBody !== undefined && body) {
            viaBody = r.model;
            body = isForm ? replaceMultipartField(body, contentType, "model", r.model) ?? body : withModel(body, r.model) ?? body;
          }
        }
      }
      // A path with the model in it is matched to its backend by that name, so only the others can be asked again.
      if (!held && r.path.length > 0) {
        flowed = name;
        again = (failed) => resolve(name, { ...world, noPeers: true, skip: new Set(failed) });
      }
    }

    // What the caller asked for, kept apart from the backend `named` picks.
    const asked = viaPath ?? viaBody;
    // A degraded model is out of rotation on EVERY door, not only the chat one.
    // `/v1/completions`, the declared routed paths and llama-swap's
    // `/upstream/<model>/...` all reach the same seat, and an answer of `!!!!`
    // costs the caller just as much there. `asked` is already resolved above —
    // from the path or the body — so this reads nothing new.
    const degraded = asked === undefined ? null : degradedRefusal(asked);
    if (degraded) {
      fail(res, degraded);
      return;
    }
    const named = routed ? undefined : asked;
    const target = routed ? routed.slot : named ? pool.for(named) : pool.first();
    if (named && !pool.single) {
      log.debug("passthrough.resolved", { path, model: named, backend: target.name });
    }

    // The one exception to verbatim forwarding: an aliased `model` field (or /upstream path segment)
    // is rewritten, or the backend 404s the advertised id.
    let outBody = body;
    let outPath = path;
    if (asked) {
      const wire = pool.outboundId(asked);
      if (wire !== asked) {
        if (viaPath) {
          outPath = path.replace(`/upstream/${viaPath}/`, `/upstream/${wire}/`);
        } else if (body && body.length > 0 && isForm) {
          // Only the one field changes; the file part is never decoded or re-encoded.
          outBody = replaceMultipartField(body, contentType, "model", wire) ?? body;
        } else if (body && body.length > 0) {
          try {
            const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
            outBody = Buffer.from(JSON.stringify({ ...parsed, model: wire }));
          } catch {
            // Unparseable bodies are forwarded untouched, exactly as before.
          }
        }
        log.debug("passthrough.aliased", { path, from: asked, to: wire });
      }
    }

    // A completion relayed down here is watched exactly as one on the chat
    // route is, so a legacy `/v1/completions` — or `/upstream/<model>/v1/…` —
    // answer of `!!!!` is counted rather than passed by. Only text-completion
    // paths: judging a rerank score or an image as "the model's words" would be
    // inventing a verdict about something that is not an answer.
    const watchable = COMPLETION_PATH.test(stripUpstream(path));

    const ctrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ctrl.abort();
    });
    // `orFail` turns a 5xx into a throw before anything is relayed, so a route with a fallback can still use it.
    const proxy = async (to: BackendSlot = target, sendBody = outBody, orFail = false): Promise<void> => {
      const up = await send(`${to.cfg.url}${outPath}${url.search}`, {
        method: req.method ?? "GET",
        ...(sendBody && sendBody.length > 0 ? { raw: sendBody } : {}),
        // Client headers minus hop-by-hop, and minus our own key if that is what it carries.
        headers: stripOurKey(req) as Record<string, string>,
        signal: ctrl.signal,
        ...backendDeadline(to.cfg),
      });
      log.debug("passthrough", { path, status: up.status });
      if (orFail && up.status >= 500) {
        up.body.resume();
        throw new Error(`${to.name} answered ${up.status}`);
      }
      // Watched on the backend actually used: a declared route may fall back to
      // a spare, and the label has to be the one that answered.
      await pipeThrough(up, res, watchable ? canary?.watchRelay(asked, to.name, up.headers["content-type"]) : undefined);
    };

    try {
      // `queue: false` routes (progress, job lists) go straight through.
      if (routed?.rule.queue) {
        const { lane } = routed.rule;
        // Two models can share one routed path; each queues as itself.
        const model = pool.routedModel(routed.slot, routed.rule, asked);
        // Queued on the backend that runs it, and recorded in history like any local use.
        const run = async (to: BackendSlot, as: string, sendBody: Buffer | undefined, orFail: boolean): Promise<void> => {
          const t: Timing = { enqueuedAt: Date.now(), startedAt: 0 };
          try {
            await to.scheduler.submit(
              { lane, model: as, caller: who, maxPerCaller: callerCap(null, cfg), signal: ctrl.signal, ...(jobId(req) ? { id: jobId(req)! } : {}) },
              async () => {
                t.startedAt = Date.now();
                await proxy(to, sendBody, orFail);
              },
            );
          } catch (e) {
            logRequest(t, { model: as, lane, caller: who, backend: to.name, target: "local", path }, false, e);
            throw e;
          }
          logRequest(t, { model: as, lane, caller: who, backend: to.name, target: "local", path }, true);
        };
        // A strict router's callers get the model its line names or its failure: no next line, no route fallback.
        const strict = routerOf(who)?.strict === true;
        const fb = strict ? undefined : routed.rule.fallback;
        const spare = fb ? pool.get(fb.backend) : undefined;
        // A line that names a model on another backend runs there; a name only the fallback serves is a choice, not a failure.
        let to = runOn ?? (spare && asked !== undefined && asked !== model && pool.owns(spare, asked) ? spare : target);
        let as = to === target ? model : picked ?? asked ?? model;
        let sendBody = outBody;
        const failed: string[] = [];
        let fellBack = to === spare;
        const renamed = (m: string): Buffer | undefined => {
          // A form names its model in a field, which is rewritten as a JSON body's is.
          const wire = pool.outboundId(m);
          return isForm && body ? replaceMultipartField(body, contentType, "model", wire) ?? body : withModel(body, wire);
        };
        for (;;) {
          // What is left if this fails before anything reaches the client: the flow's next line that ends at a
          // model this path can run, as a chat flow's would, and after the last of those the route's own fallback.
          const next = !strict && again ? again([...failed, as]) : null;
          const line = next && next.target === "local" && next.model !== as && !failed.includes(next.model) ? placeOf(next.model) : undefined;
          const more = line ? { slot: line, model: next!.model, line: next }
            : spare && fb && !fellBack ? { slot: spare, model: fb.model, line: null } : null;
          try {
            await run(to, as, sendBody, more !== null);
            break;
          } catch (e) {
            // A full lane is back-pressure, a closed socket has nobody to answer, and a started reply cannot be restarted.
            if (!more || e instanceof QueueFullError || ctrl.signal.aborted || res.headersSent) throw e;
            log.warn(more.line ? "route.next_line" : "route.fallback", {
              path, from: to.name, to: more.slot.name, model: more.model,
              detail: e instanceof Error ? e.message : String(e),
            });
            failed.push(as);
            if (more.line && flowed !== null) settle(more.line, flowed, who);
            else fellBack = true;
            [to, as, sendBody] = [more.slot, more.model, renamed(more.model)];
          }
        }
      } else if (routed) {
        // A declared `queue: false` path — a progress endpoint polled WHILE the
        // work it asks about holds the slot. Counting those would draw traffic
        // for the polling, not the working.
        await proxy();
      } else {
        const mark = { id: `p${++proxySeq}`, backend: target.name, model: named ?? null };
        proxying.add(mark);
        try {
          await proxy();
        } finally {
          // finally, not after the await: an aborted or failed proxy must not
          // leave a phantom request on the page forever.
          proxying.delete(mark);
        }
      }
    } catch (e) {
      fail(res, e);
    }
  }


  /**
   * How the page may write: "open" when apiKeys is empty (loopback is trusted), "key" when writes
   * need a bearer key, which the page asks for.
   */
  const writeMode = (): "open" | "key" => (cfg.apiKeys.length === 0 ? "open" : "key");

  /** A local backend's deadlines, first byte and mid-answer silence: its own, else the node defaults. */
  const backendDeadline = (b: BackendConfig): { headersTimeoutMs?: number; idleTimeoutMs?: number } => {
    const first = b.firstByteMs ?? cfg.backendFirstByteMs;
    const idle = b.idleMs ?? cfg.backendIdleMs;
    return { ...(first > 0 ? { headersTimeoutMs: first } : {}), ...(idle > 0 ? { idleTimeoutMs: idle } : {}) };
  };

  /**
   * The page pushed over SSE: one snapshot, then diffs of the same object /ui/data serves, with
   * history appended. `operator` is per request and never in a patch.
   */
  const streams = new Set<ServerResponse>();
  let lastSent: Record<string, unknown> | null = null;
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

  function uiDiff(
    prev: Record<string, unknown>,
    next: Record<string, unknown>,
  ): { set?: Record<string, unknown>; add?: { hist: unknown[] } } | null {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      if (k === "hist" || k === "operator") continue;
      if (JSON.stringify(v) !== JSON.stringify(prev[k])) set[k] = v;
    }
    let add: { hist: unknown[] } | undefined;
    const ph = (prev.hist ?? []) as unknown[];
    const nh = (next.hist ?? []) as unknown[];
    if (JSON.stringify(ph) !== JSON.stringify(nh)) {
      const tail = appendedTail(ph, nh);
      // A tail of nothing means the ring rolled without gaining anything, which
      // cannot happen -- but sending `add: {hist: []}` would be a frame saying
      // nothing, so treat it as no change rather than as a resync.
      if (tail && tail.length > 0) add = { hist: tail };
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
  let inBuild: Promise<Record<string, unknown>> | null = null;

  function build(): Promise<Record<string, unknown>> {
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
    });
    res.end(html);
  }

  /** Requests proxied right now without queueing, counted for the console only; admission is unchanged. */
  let proxySeq = 0;
  const proxying = new Set<{ id: string; backend: string; model: string | null }>();
  const { uiPayload, networkView } = createViews({
    cfg, pool, peers, history, controls, config, shared, proxying, writeMode,
    flowHits: () => (hitsFor === cfg.flows ? Object.fromEntries([...hits].map(([flow, row]) => [flow, Array.from(row, (n) => n ?? 0)])) : {}),
    // Drawn whether or not it is on, so "not configured" and "configured and
    // quiet" are not the same blank tile.
    canary: () => canary?.page() ?? { enabled: false, passive: false, recovery: false, models: {} },
    keys: keysView,
  });

  /** Expired sessions, swept like any other in-memory state; unref'd so it never holds the process. */
  const sessionSweep = setInterval(() => { sessions.prune(); }, 30 * 60_000);
  sessionSweep.unref?.();

  /** The day of history and recent logs, read once at start and written every minute and at close. */
  function loadHistory(): void {
    if (!cfg.historyFile || !existsSync(cfg.historyFile)) return;
    try {
      const saved = JSON.parse(readFileSync(cfg.historyFile, "utf8")) as { history?: unknown; logs?: unknown; lastUse?: unknown };
      history.restore(saved.history);
      logs.restore(saved.logs);
      // When each model was last asked for, so a restart does not make everything look long idle.
      for (const [m, at] of Object.entries(saved.lastUse ?? {})) if (typeof at === "number") lastUse.set(m, at);
    } catch (e) {
      log.warn("history.unreadable", { path: cfg.historyFile, error: String(e) });
    }
  }
  let historyWarned = false;
  function saveHistory(): void {
    if (!cfg.historyFile) return;
    try {
      writeFileAtomic(cfg.historyFile, JSON.stringify({ v: 1, history: history.snapshot(), logs: logs.all(), lastUse: Object.fromEntries(lastUse) }));
      historyWarned = false;
    } catch (e) {
      // Once per failure streak: a read-only path must not fill the journal every minute.
      if (!historyWarned) log.warn("history.unwritable", { path: cfg.historyFile, error: String(e) });
      historyWarned = true;
    }
  }
  let historyTimer: ReturnType<typeof setInterval> | null = null;

  const node: HearthNode = {
    onRestart: null,
    log,
    server,
    pool,
    peers,
    history,
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
      if (historyTimer) clearInterval(historyTimer);
      clearInterval(sessionSweep);
      sessions.prune();
      config.close();
      peers.stop();
      pool.stop();
      history.stop();
      // End event streams first, so pages start reconnecting at once.
      for (const res of streams) res.end();
      for (const res of queueStreams.keys()) res.end();
      streams.clear();

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
