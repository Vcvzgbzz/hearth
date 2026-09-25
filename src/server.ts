/**
 * The HTTP surface: OpenAI-compatible `/v1/*` (clients change only a base url) and the `/peer/*`
 * protocol. Bodies stream through untouched; only the model id and stream flag are read.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";

import {
  ConfigError, WARM_LANE,
  type BackendConfig, type HearthConfig, type RoutePolicy,
} from "./config.js";
import { Controls } from "./controls.js";
import { emulatedRequest, relayEmulated } from "./emulate.js";
import { Overrides, readState, writeState } from "./overrides.js";
import type { Logger } from "./log.js";
import { PeerRegistry, PeerStatusError } from "./peers.js";
import { BackendPool } from "./pool.js";
import { decide } from "./route.js";
import { History, KEEP } from "./history.js";
import { QueueFullError } from "./scheduler.js";
import { fitOutput, needsOf, NOTE_MAX, unfit, type ModelStats } from "./stats.js";
import { UI_HTML } from "./ui.js";
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

/** OpenAI's error envelope, since that's what clients parse. */
function apiError(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
  json(res, status, { error: { message, type } });
}

/** Thrown, not returned, so the caller can answer 413 rather than the 400 an
 *  unparseable body would otherwise get. */
class BodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

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
  /** The status page on its own socket when `uiListen` is set; it answers only the page paths. */
  uiServer: Server | null;
  peers: PeerRegistry;
  history: History;
  /** Start watching backends and polling peers. Call before listen(); without it the node silently routes everything locally. */
  start: () => void;
  /** Stop, letting in-flight requests finish for up to `graceMs` (default 0 destroys them). */
  close: (graceMs?: number) => Promise<void>;
}

export function createNode(cfg: HearthConfig, log: Logger): HearthNode {
  // One state and one queue per backend. Pushed over SSE where the backend
  // supports it, polled where it doesn't.
  const pool = new BackendPool(cfg, log);

  // Runtime overrides on the config's two federation directions. Passed to the
  // registry so a borrowing pause removes every peer from routing at source.
  const controls = new Controls();
  // Writes THROUGH cfg, so peers and routing see an edit on the next request
  // with nothing to invalidate. It snapshots the file's version first, which is
  // the only remaining record of what the YAML said.
  const overrides = new Overrides(cfg);
  // AFTER the baseline snapshot above, so restored edits still read as
  // differing from the file — saved and "in the config" are separate claims and
  // the page reports both.
  if (cfg.stateFile) {
    const saved = readState(cfg.stateFile, log);
    if (saved) {
      overrides.restore(saved, log);
      for (const [model, on] of Object.entries(saved.share)) controls.setShare(model, on);
      log.info("state.restored", {
        path: cfg.stateFile,
        savedAt: saved.savedAt,
        share: Object.keys(saved.share).length,
        peers: Object.keys(saved.maps).length,
        routes: Object.keys(saved.routes).length,
      });
    }
  }
  const peers = new PeerRegistry(cfg, log, controls);

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
        return { caller: "key:" + (cfg.apiKeyLabels[i] || keyId(k)), models: cfg.apiKeyModels[i] ?? null };
      }
      i++;
    }
    return null;
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
  async function sendLocal(url: string, model: string, payload: Record<string, unknown>, res: ServerResponse, opts: { signal: AbortSignal } & ReturnType<typeof backendDeadline>): Promise<number> {
    const emulate = cfg.models[model]?.emulate ?? null;
    const body = pool.outboundBody(model, payload);
    const sentAt = Date.now();
    const up = await send(`${url}/v1/chat/completions`, { json: emulate ? emulatedRequest(body) : body, ...opts });
    return emulate ? relayEmulated(up, res, forwardable(up.headers), sentAt) : pipeThrough(up, res);
  }

  /**
   * Relay an upstream answer verbatim, all headers included, and return its status: a backend's 4xx
   * reaches the client but is not a success. `pipeline` settles even if the client disconnects.
   */
  async function pipeThrough(up: UpstreamResponse, res: ServerResponse): Promise<number> {
    res.writeHead(up.status, {
      ...forwardable(up.headers),
      "Content-Type": up.headers["content-type"] ?? "application/json",
      // Tell any proxy in front not to buffer, or a streamed answer arrives all
      // at once at the end and looks like a hang.
      "X-Accel-Buffering": "no",
    });
    await pipeline(up.body, res);
    return up.status;
  }

  /** Run one completion where it belongs. A peer that fails before the first byte is retried locally. */
  async function dispatch(
    payload: Record<string, unknown>,
    model: string,
    lane: string,
    caller: string,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    // Refresh peer state only when a decision needs it, and only for models that may leave.
    if (cfg.models[model] && cfg.models[model].policy !== "local") {
      await peers.ensureFresh();
    }

    // Which of our backends would serve this, and therefore whose queue and
    // whose numbers the local half of the decision is about. A node with an
    // idle embedder and a busy GPU has no single answer to "am I busy".
    const local = pool.for(model);
    // Per model, like the peer half two lines down. The backend's flat number
    // says "free" while THIS model's slots are full, which keeps work home to
    // queue behind itself when a peer could have started it.
    const cap = local.scheduler.capacityFor(model);
    const queuedTotal = Object.values(cap.queued).reduce((a, b) => a + b, 0);
    // What this request asks for, so routing can skip a peer whose model is too
    // small for it rather than sending the prompt across the network to be
    // refused there.
    const need = needsOf(payload);
    const decision = decide(model, cfg, peers, {
      queued: queuedTotal,
      free: cap.free,
      slots: cap.slots,
      loaded: local.state.loaded(),
    }, need);

    // What the local backend answered, for the log and the call history. A
    // relayed 400 — "this prompt does not fit" is the common one — is a failed
    // request that happens to carry a useful body.
    let localStatus = 0;
    const runLocal = async (): Promise<void> => {
      await local.state.ensureFresh();
    // Our id and the route's params on the way to the backend; untouched when neither is set.
      localStatus = await sendLocal(local.cfg.url, model, payload, res, { signal, ...backendDeadline(local.cfg) });
    };

    const t: Timing = { enqueuedAt: Date.now(), startedAt: 0 };

    if (decision.target === "unavailable") {
      // Refusing is the point. The operator said this can't run here.
      logRequest(t, { model, lane, caller, target: "unavailable" }, false, decision.reason);
      apiError(
        res,
        503,
        // "none can take it" rather than "none is available": since routing
        // started reading model stats, a peer can be up, mapped and simply too
        // small for this request, and the reason in the brackets says so.
        `${model} runs only on a peer, and none can take it (${decision.reason})`,
        "server_error",
      );
      return;
    }

    if (decision.target === "local") {
    // Refused here only on reported limits, before queueing or evicting; the backend stays the authority.
      const fitted = fitOutput(pool.statsFor(model), need, payload);
      const tooMuch = unfit(pool.statsFor(model), fitted);
      if (tooMuch !== null) {
        logRequest(t, { model, lane, caller, backend: local.name, target: "local" }, false, tooMuch);
        apiError(res, 400, `${model} ${tooMuch}`, "invalid_request_error");
        return;
      }
      try {
        await local.scheduler.submit(
          { lane, model, caller, ...(cfg.scheduler.maxPerCaller > 0 ? { maxPerCaller: cfg.scheduler.maxPerCaller } : {}), signal, tokens: pool.poolTokens(model, fitted) },
          async () => {
            t.startedAt = Date.now();
            await runLocal();
          },
        );
      } catch (e) {
        logRequest(t, { model, lane, caller, backend: local.name, target: "local", reason: decision.reason }, false, e);
        throw e;
      }
      logRequest(
        t,
        { model, lane, caller, backend: local.name, target: "local", reason: decision.reason,
          ...(localStatus >= 400 ? { status: localStatus } : {}) },
        localStatus < 400,
        localStatus >= 400 ? `backend answered ${localStatus}` : undefined,
      );
      return;
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
        ...(cfg.scheduler.maxPerCaller > 0 ? { maxPerCaller: cfg.scheduler.maxPerCaller } : {}),
        // No local slot: this runs on their hardware, not ours.
        offbox: true,
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
          const route = cfg.models[model];
          if (!route?.fallbackLocal) throw e;
          // Nothing reached the client yet, so they'll never see this.
          log.warn("route.peer_failed_retrying_local", {
            model,
            peer: peer.name,
            error: e instanceof Error ? e.message : String(e),
          });
          fellBack = true;
          lastTarget = "local";
          // A local retry goes back through admission, without re-applying the caller cap.
          await local.scheduler.submit({ lane, model, caller, signal, tokens: pool.poolTokens(model, need) }, runLocal);
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
      if (!isLoopback(req)) {
        refuse(res, 403, "the status page is loopback-only", env);
        return null;
      }
      return { ...base, peer: null, caller: "", models: null };
    }

    const asPeer = r.auth === "local" ? null : peerCaller(req);
    if (r.auth === "peer") {
      if (asPeer === null) {
        refuse(res, 401, "unknown peer token", env);
        return null;
      }
      return { ...base, peer: asPeer, caller: asPeer, models: null };
    }

    const asLocal = localCaller(req);
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
    { path: "/queue", auth: "local", handler: routeQueue },

    // The OpenAI surface: a peer may send us work here, and so may we.
    { path: "/v1/warm", methods: ["POST"], auth: "either", envelope: "openai", handler: routeWarm },
    { path: ["/v1/models", "/v1/models/*"], auth: "either", envelope: "openai", scoped: true,
      handler: routeModels },
    { path: "/v1/chat/completions", methods: ["POST"], auth: "either", envelope: "openai",
      scoped: true, handler: routeChat },

    // On the MAIN port the page stays loopback-only. Reaching it from
    // elsewhere is what uiListen is for, and that is a separate socket.
    { path: ["/ui", "/ui/", "/ui/data", "/ui/events"], auth: "loopback", envelope: "openai",
      handler: routeUi },

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
  async function routeControl(c: Call): Promise<void> {
    const { req, res } = c;
    if (req.method === "GET") {
      json(res, 200, {
        ...controls.state(),
        share: shared(),
        configuredShare: cfg.share,
        catalog: pool.catalog(),
        ...overrideView(),
      });
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
    if (body.link !== undefined || body.unlink !== undefined) {
      const edit = (body.link ?? body.unlink) as Record<string, unknown>;
      if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
        apiError(res, 400, "link/unlink must be an object");
        return;
      }
      const peerName = typeof edit.peer === "string" ? edit.peer : "";
      const mine = typeof edit.mine === "string" ? edit.mine : "";
      if (peerName === "" || mine === "") {
        apiError(res, 400, "link/unlink need peer and mine");
        return;
      }
      try {
        if (body.unlink !== undefined) {
          overrides.unlink(peerName, mine);
          log.info("control.unlink", { peer: peerName, model: mine });
        } else {
          const theirs = typeof edit.theirs === "string" && edit.theirs !== "" ? edit.theirs : mine;
          // If we serve it too, `fastest` with local fallback; if not, peer only, since home would 404.
          const local = pool.catalog().includes(mine);
          const policy = (edit.policy as RoutePolicy | undefined) ?? (local ? "fastest" : "peer");
          if (!["local", "peer", "spillover", "fastest"].includes(policy)) {
            apiError(res, 400, `policy must be local, peer, spillover or fastest (got ${policy})`);
            return;
          }
          const fallback = typeof edit.fallbackLocal === "boolean" ? edit.fallbackLocal : local;
          overrides.link(peerName, mine, theirs, policy, fallback);
          log.info("control.link", { peer: peerName, model: mine, theirs, policy, fallbackLocal: fallback });
        }
      } catch (e) {
        apiError(res, 400, e instanceof Error ? e.message : String(e));
        return;
      }
    }

    if (body.notes !== undefined) {
      for (const [model, text] of Object.entries(body.notes as Record<string, string | null>)) {
        overrides.setNote(model, text);
      }
      log.info("control.notes", { models: Object.keys(body.notes as object) });
    }

    if (body.share !== undefined) {
      for (const [model, want] of Object.entries(body.share as Record<string, boolean | null>)) {
        controls.setShare(model, want);
      }
      log.info("control.share", { share: shared() });
    }

    const changed = controls.set({
      lending: body.lending as boolean | undefined,
      borrowing: body.borrowing as boolean | undefined,
    });
    // Only the transitions. This is a thing a human did to a live system, so
    // it belongs at info — but a no-op POST should not leave a trail implying
    // something moved.
    if (Object.keys(changed).length > 0) log.info("control.changed", changed);

    // Save is its own verb and runs last, so a tried link does not outlive the session unless saved.
    if (body.save === true) {
      const to = savesTo();
      if (to === null) {
        apiError(
          res,
          400,
          cfg.configPath
            ? `${cfg.configPath} is not writable, and no stateFile is set — add ReadWritePaths=${cfg.configPath} ` +
              `to the unit (ProtectSystem=strict makes everything outside WorkingDirectory read-only), ` +
              `or set stateFile for a sidecar instead`
            : "this node was not loaded from a config file and has no stateFile, so there is nowhere to save",
        );
        return;
      }
      if (to === "config") {
        // The effective list BEFORE the overrides are folded away, since that
        // is what gets written as `share:`.
        const effective = [...shared()];
        try {
          overrides.saveConfig(effective);
        } catch (e) {
          apiError(res, e instanceof ConfigError ? 409 : 500, e instanceof Error ? e.message : String(e));
          return;
        }
        controls.clearShareOverrides();
        overrides.rebase(effective);
        // Whatever was in the sidecar is in the config now, and leaving it
        // would re-apply a stale copy of it over the file on the next start.
        if (cfg.stateFile) {
          try {
            writeState(cfg.stateFile, overrides.pending({}));
          } catch (e) {
            log.warn("state.stale", { path: cfg.stateFile, error: String(e) });
          }
        }
        overrides.markSaved(overrides.pending({}));
        log.info("config.saved", { path: cfg.configPath });
      } else {
        const state = overrides.pending(controls.shareOverrides());
        try {
          writeState(cfg.stateFile!, state);
        } catch (e) {
          // A write that fails must not report success: the operator would
          // walk away believing a restart is safe.
          apiError(res, 500, `could not write ${cfg.stateFile}: ${String(e)}`);
          return;
        }
        overrides.markSaved(state);
        log.info("state.saved", { path: cfg.stateFile });
      }
    }

    json(res, 200, { ...controls.state(), share: shared(), changed, ...overrideView() });
    return;
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

  // Ask a model to be resident without generating. Queued like any job, since loading one evicts
  // another; best-effort, and nothing reserves it.
  async function routeWarm(c: Call): Promise<void> {
    const { req, res } = c;
    const fromPeer = c.peer;
    const caller = c.caller;
    // A peer's warm is rate-limited like any other work it sends.
    if (fromPeer !== null && peerOverLimit(fromPeer)) {
      apiError(res, 429, "rate capped", "rate_limit_error");
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString()) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        res.setHeader("Connection", "close");
        apiError(res, 413, e.message, "invalid_request_error");
        return;
      }
      apiError(res, 400, `body was not JSON: ${String(e)}`);
      return;
    }
    const model = typeof body.model === "string" ? body.model : "";
    if (model === "") {
      apiError(res, 400, "model is required");
      return;
    }
    if (fromPeer !== null && !shared().includes(model)) {
      // Same gate as chat: lending is opt-in per model, and a warm is a way
      // of spending the GPU, so it cannot reach anything you did not offer.
      apiError(res, 403, `${cfg.name} does not share "${model}"`, "permission_error");
      return;
    }

    // Same routing question chat asks. Phase 1 implements only the local
    // answer, but asking it here is what makes peer warming a branch of this
    // route later rather than a second endpoint with its own opinions.
    const slotFor = pool.for(model);
    const capFor = slotFor.scheduler.capacityFor(model);
    const decision = fromPeer !== null
      // A peer's warm is served here or nowhere. Forwarding it onward would
      // let two nodes that each prefer the other bounce a warm between them,
      // the same loop the chat route avoids by not re-routing peer work.
      ? ({ target: "local", reason: "from a peer" } as const)
      : decide(model, cfg, peers, {
          queued: Object.values(capFor.queued).reduce((a, b) => a + b, 0),
          free: capFor.free,
          slots: capFor.slots,
          loaded: slotFor.state.loaded(),
        });

    // A peer's warm is taken only if it can start now; it may never make us wait or evict on its schedule.
    if (fromPeer !== null && capFor.free <= 0) {
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
    // Only an evicting backend has anything to do. A `single` backend holds
    // its model resident forever, and saying "warmed" there would claim work
    // that did not happen.
    if (slot.cfg.kind !== "llama-swap") {
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
        {
          lane: WARM_LANE, model, caller,
          ...(cfg.scheduler.maxPerCaller > 0 ? { maxPerCaller: cfg.scheduler.maxPerCaller } : {}),
          signal: ctrl.signal,
        },
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
      // A full lane is 429, the caller's cue to back off, not a 502.
      if (e instanceof QueueFullError) {
        apiError(res, 429, e.message, "rate_limit_error");
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("warm.failed", { model, backend: slot.name, error: msg });
      apiError(res, 502, msg, "server_error");
      return;
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
      type Entry = { id: string; status?: { value: string }; context_length?: number; description?: string };
      const upstream: { data?: Entry[] } = {
        data: pool.catalog().map((id) => {
          // Unknown warmth or window is omitted, never reported as cold or null.
          const entry: Entry = { id };
          const note = pool.statsFor(id)?.note;
          if (note) entry.description = note;
          if (pool.for(id).cfg.kind === "none") return entry;
          entry.status = { value: warm.has(id) ? "loaded" : "unloaded" };
          const ctx = pool.contextLength(id);
          if (ctx !== null) entry.context_length = ctx;
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
          upstream.data!.push(entry);
        }
      }
      // A peer sees only what we share.
      if (modelsPeer !== null) {
        upstream.data = (upstream.data ?? []).filter((m) => shared().includes(m.id));
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
    const { req, res } = c;
    // A peer's request gets served here and never routed onward. Two nodes
    // that each prefer the other would otherwise bounce a request back and
    // forth until something gave out.
    const fromPeer = c.peer;
    const caller = c.caller;
    if (fromPeer !== null && peerOverLimit(fromPeer)) {
      apiError(res, 429, "rate capped", "rate_limit_error");
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString()) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        res.setHeader("Connection", "close");
        apiError(res, 413, e.message, "invalid_request_error");
        return;
      }
      apiError(res, 400, `body was not JSON: ${String(e)}`);
      return;
    }

    const model = typeof payload.model === "string" ? payload.model : "";
    if (model === "") {
      apiError(res, 400, "model is required");
      return;
    }
    if (fromPeer !== null && !shared().includes(model)) {
      // Lending is opt-in per model, so a peer can't reach anything you
      // didn't deliberately offer.
      apiError(res, 403, `${cfg.name} does not share "${model}"`, "permission_error");
      return;
    }
    if (c.models !== null && !c.models.includes(model)) {
      apiError(res, 403, `this key may not run "${model}"`, "permission_error");
      return;
    }
    // An id nothing here can serve is refused before queueing, unless a peer maps it.
    if (pool.certainlyUnknown(model)
        && !peers.all().some((p) => peers.theirModelId(p.name, model) !== undefined)) {
      apiError(
        res, 404,
        `no backend here serves "${model}" (${pool.catalog().join(", ") || "nothing"})`,
        "invalid_request_error",
      );
      return;
    }
    if (fromPeer !== null) {
      // A borrower's oversized request gets the local path's 4xx before it is queued.
      const why = unfit(pool.statsFor(model), fitOutput(pool.statsFor(model), needsOf(payload), payload));
      if (why !== null) {
        apiError(res, 400, `${model} ${why}`, "invalid_request_error");
        return;
      }
    }

    // Peers get cfg.peerLane; local callers may send a `lane` (stripped before forwarding); a route's lane wins.
    const lane =
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

    try {
      if (fromPeer !== null) {
        const t: Timing = { enqueuedAt: Date.now(), startedAt: 0 };
        const serving = pool.for(model);
        // As on the local path: what we relayed to the borrower, so lent
        // capacity that failed is not filed as lent capacity that worked.
        let lentStatus = 0;
        try {
          await serving.scheduler.submit(
            // Peers are capped by peerMaxConcurrent per backend, whether or not apiKeys are set.
            { lane, model, caller, maxPerCaller: cfg.peerMaxConcurrent, signal: ctrl.signal, tokens: pool.poolTokens(model, needsOf(payload)) },
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
      } else {
        await dispatch(payload, model, lane, caller, res, ctrl.signal);
      }
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof QueueFullError) {
        apiError(res, 429, e.message, "rate_limit_error");
        return;
      }
      // A peer's refusal keeps its 4xx status; only its 5xx becomes our 502.
      if (e instanceof PeerStatusError && e.isRefusal) {
        apiError(
          res,
          e.status,
          e.message,
          e.status === 429 ? "rate_limit_error" : "invalid_request_error",
        );
        return;
      }
      apiError(res, 502, e instanceof Error ? e.message : String(e), "server_error");
    }
    return;
  }

  async function routeUi(c: Call): Promise<void> {
    const { req, res, path } = c;
    // The event stream shares the page's address-based gate.
    if (path === "/ui/events") {
      await serveUiEvents(req, res, true);
      return;
    }
    await serveUi(path, res, true);
    return;
  }

  /** Everything not claimed above, proxied to a backend as-is. */
  async function routePassthrough(c: Call): Promise<void> {
    const { req, res, url, path } = c;
    // Everything else is proxied as-is and unqueued (llama-swap's /unload, /running, /upstream/...),
    // unless `backends[].routes` names the path, in which case hearth is its admission control.
    const who = c.caller;
    let body: Buffer | undefined;
    try {
      body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await readBody(req, cfg.maxBodyBytes);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        res.setHeader("Connection", "close");
        apiError(res, 413, e.message, "invalid_request_error");
        return;
      }
      throw e;
    }
    // A declared route wins over every heuristic below it, being the only
    // statement here the operator actually made.
    const routed = pool.forPath(url.pathname);

    // The model from the /upstream/<model>/ path or the JSON body, else the first backend.
    const viaPath = /^\/upstream\/([^/]+)\//.exec(path)?.[1];
    let viaBody: string | undefined;
    if (body && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString()) as { model?: unknown };
        if (typeof parsed.model === "string") viaBody = parsed.model;
      } catch {
        // Not JSON, or not ours to understand. The fallback covers it.
      }
    }
    // What the caller asked for, kept apart from the backend `named` picks.
    const asked = viaPath ?? viaBody;
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

    const ctrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ctrl.abort();
    });
    const proxy = async (): Promise<void> => {
      const up = await send(`${target.cfg.url}${outPath}${url.search}`, {
        method: req.method ?? "GET",
        ...(outBody && outBody.length > 0 ? { raw: outBody } : {}),
        // Client headers minus hop-by-hop, and minus our own key if that is what it carries.
        headers: stripOurKey(req) as Record<string, string>,
        signal: ctrl.signal,
        ...backendDeadline(target.cfg),
      });
      log.debug("passthrough", { path, status: up.status });
      await pipeThrough(up, res);
    };

    try {
      // `queue: false` routes (progress, job lists) go straight through.
      if (routed?.rule.queue) {
        const { lane } = routed.rule;
        // Two models can share one routed path; each queues as itself.
        const model = pool.routedModel(routed.slot, routed.rule, asked);
        // Recorded in history like any local use.
        const t: Timing = { enqueuedAt: Date.now(), startedAt: 0 };
        try {
          await target.scheduler.submit(
            { lane, model, caller: who, signal: ctrl.signal },
            async () => {
              t.startedAt = Date.now();
              await proxy();
            },
          );
        } catch (e) {
          logRequest(t, { model, lane, caller: who, backend: target.name, target: "local", path }, false, e);
          throw e;
        }
        logRequest(t, { model, lane, caller: who, backend: target.name, target: "local", path }, true);
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
      // Same reasoning as the warm route: a full lane is the caller's cue to
      // back off, and dressing it as a 502 makes a client that retries on 429
      // give up on a queue that just needed a moment.
      if (e instanceof QueueFullError) {
        if (!res.headersSent) apiError(res, 429, e.message, "rate_limit_error");
        else res.end();
        return;
      }
      if (!res.headersSent) {
        apiError(res, 502, e instanceof Error ? e.message : String(e), "server_error");
      } else {
        res.end();
      }
    }
  }


  /**
   * How the page may write: "open" when apiKeys is empty (loopback is trusted), "key" when writes
   * need a bearer key, which the page asks for.
   */
  const writeMode = (): "open" | "key" => (cfg.apiKeys.length === 0 ? "open" : "key");

  /** The first-byte deadline for a local backend: its own `firstByteMs`, else the node default. */
  const backendDeadline = (b: BackendConfig): { headersTimeoutMs?: number } => {
    const ms = b.firstByteMs ?? cfg.backendFirstByteMs;
    return ms > 0 ? { headersTimeoutMs: ms } : {};
  };

  /**
   * Everything the page draws, shared by /ui/data and the event stream. `canWarm` is whether this
   * socket can perform actions. Uses ensureFresh, never probeAll.
   */
  async function uiPayload(canWarm: boolean): Promise<Record<string, unknown>> {
    await peers.ensureFresh();
    // Declared activity paths are read only while a page is building data, never on a timer.
    for (const b of pool.all()) if (b.cfg.activity) void b.state.sampleActivity(b.cfg.activity);
    return {
      canWarm,
      // How this page must authenticate its writes, decided per socket rather
      // than assumed. "off" when the socket serves no write routes at all.
      control: canWarm ? writeMode() : "off",
      // Pause state shows on both sockets; the buttons only where canWarm.
      controls: controls.state(),
      // What the sharing and mapping controls need, sent to the read-only listener too.
      share: shared(),
      configuredShare: cfg.share,
      catalog: pool.catalog(),
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
      overrides: overrideView(),
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

  /**
   * The page pushed over SSE: one snapshot, then diffs of the same object /ui/data serves, with
   * history appended. `canWarm` and `control` are per socket and never in a patch.
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
      if (k === "hist" || k === "canWarm" || k === "control") continue;
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
    inBuild ??= uiPayload(false)
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

  async function serveUiEvents(req: IncomingMessage, res: ServerResponse, canWarm: boolean): Promise<void> {
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
    writeFrame(res, "snapshot", {
      ...snapshot,
      canWarm,
      control: canWarm ? writeMode() : "off",
    });
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

  /** The page and its data, the only things either listener serves to the page. */
  async function serveUi(path: string, res: ServerResponse, canWarm = false): Promise<void> {
    if (path === "/ui/data") {
      // One payload rather than three fetches. It also means /network and
      // /queue keep their own auth gate untouched: nothing here relaxes them,
      // the page simply does not use them.
      json(res, 200, await uiPayload(canWarm));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(UI_HTML),
      // It is a live status page; a cached copy is a lie.
      "Cache-Control": "no-store",
    });
    res.end(UI_HTML);
  }

  /** Requests proxied right now without queueing, counted for the console only; admission is unchanged. */
  let proxySeq = 0;
  const proxying = new Set<{ id: string; backend: string; model: string | null }>();

  const uiWritable = cfg.uiListen?.control === "key";
  /** The only paths the standalone listener serves. */
  const UI_PATHS = new Set(["/ui", "/ui/", "/ui/data", "/ui/events", "/"]);
  /** The writes the standalone listener passes through when `uiListen.control` allows; new controls must be added here. */
  const UI_WRITE_PATHS = new Set(["/control", "/v1/warm"]);
  // The status listener: only UI_PATHS (plus UI_WRITE_PATHS behind localCaller), 404 for the rest.
  const uiServer = cfg.uiListen
    ? createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const isWrite = uiWritable && req.method === "POST" && UI_WRITE_PATHS.has(path);
        if (!UI_PATHS.has(path) && !isWrite) {
          json(res, 404, { error: "only the status page is served on this port" });
          return;
        }
        if (isWrite) {
          // Straight into the main handler. Reimplementing the gate here is how
          // the two copies drift and one of them ends up missing a check, so
          // there is exactly one implementation of /control and one of /v1/warm.
          void handle(req, res).catch((e) => {
            log.error("ui.write_failed", { error: e instanceof Error ? e.message : String(e) });
            if (!res.headersSent) json(res, 500, { error: "internal error" });
            else res.end();
          });
          return;
        }
        if (path === "/ui/events") {
          void serveUiEvents(req, res, uiWritable).catch((e) => {
            log.error("ui.stream_failed", { error: e instanceof Error ? e.message : String(e) });
            res.end();
          });
          return;
        }
        void serveUi(path === "/ui/data" ? "/ui/data" : "/ui", res, uiWritable).catch((e) => {
          log.error("ui.failed", { error: e instanceof Error ? e.message : String(e) });
          if (!res.headersSent) json(res, 500, { error: "internal error" });
          else res.end();
        });
      })
    : null;

  /** Where a Save goes: the config file when writable, else the sidecar, else nowhere. */
  function savesTo(): "config" | "state" | null {
    if (cfg.configPath) {
      try {
        accessSync(cfg.configPath, fsConstants.W_OK);
        return "config";
      } catch {
        // Read-only, or not ours. Fall through to the sidecar.
      }
    }
    return cfg.stateFile ? "state" : null;
  }

  /** Runtime changes not in the file, with the YAML to paste; shared by /control and /ui/data. */
  function overrideView() {
    const changes = overrides.changes();
    const dirty =
      changes.maps.length > 0 ||
      changes.routes.length > 0 ||
      changes.notes.length > 0 ||
      [...shared()].sort().join(",") !== [...cfg.share].sort().join(",");
    return {
      changes,
      dirty,
      // `dirty` is not in hearth.yaml; `unsaved` will not survive a restart.
      canSave: savesTo() !== null,
      savesTo: savesTo(),
      // Named, not left to be discovered. "Saved" is a claim about a specific
      // file and the operator should not have to guess which one.
      savePath: savesTo() === "config" ? cfg.configPath : savesTo() === "state" ? cfg.stateFile : null,
      // Only meaningful for the sidecar. A config save leaves nothing behind:
      // the file IS the record, so `dirty` goes false and the whole block goes
      // away rather than sitting there asking to be dealt with.
      unsaved: savesTo() !== null && overrides.unsaved(controls.shareOverrides()),
      yaml: dirty ? overrides.yaml(shared(), cfg.share) : "",
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
            // Only llama-swap evicts. An ollama backend keeps its set resident
            // and serves them together, so there is no thrash to warn about.
            evicts: b.cfg.kind === "llama-swap",
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
      readyNow: [...readyNow].sort(),
      available: [...available].sort(),
      unknownWarm: [...unknownWarm].sort(),
      // Does anything here actually evict? If nothing does, the status page
      // should not talk about model thrash.
      evicts: pool.all().some((b) => b.cfg.kind === "llama-swap"),
    };
  }

  return {
    server,
    uiServer,
    pool,
    peers,
    history,
    start: () => {
      pool.start();
      peers.start();
      history.start();
    },
    close: async (graceMs = 0) => {
      peers.stop();
      pool.stop();
      history.stop();
      // The page is not work. Nothing is lost by dropping a poll mid-flight,
      // and a browser holding one open would otherwise pace the whole drain.
      uiServer?.close();
      uiServer?.closeAllConnections?.();
      // End event streams first, so pages start reconnecting at once.
      for (const res of streams) res.end();
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
    },
  };
}
