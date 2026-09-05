/**
 * The HTTP surface. Two faces on one port:
 *
 *   /v1/*      OpenAI-compatible, so existing clients change a base url and
 *              nothing else. That's the whole adoption story. No SDK, no
 *              bespoke protocol, no rewriting what you already use.
 *   /peer/*    the small protocol hearth nodes speak to each other.
 *
 * Bodies stream through byte-for-byte. We parse just enough to find the model
 * id and whether someone asked for streaming, and leave the rest to the
 * backend. That's what keeps tool calls, vision parts, and whatever gets
 * invented next month working without touching this file.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";

import { ConfigError, WARM_LANE, type HearthConfig, type RoutePolicy } from "./config.js";
import { Controls } from "./controls.js";
import { Overrides, readState, writeState } from "./overrides.js";
import type { Logger } from "./log.js";
import { PeerRegistry, PeerStatusError } from "./peers.js";
import { BackendPool } from "./pool.js";
import { decide } from "./route.js";
import { History } from "./history.js";
import { QueueFullError } from "./scheduler.js";
import { UI_HTML } from "./ui.js";
import { send, type UpstreamResponse } from "./upstream.js";

/** Constant-time compare over digests. No length leak, no throw on mismatch. */
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

/**
 * Headers describing this connection rather than the message. They can't be
 * copied across a proxy hop. Content-Length is in here for a different reason:
 * the body may get re-framed, so we let the runtime set it.
 */
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
  /**
   * The status page on its own socket, when `uiListen` is configured.
   *
   * A separate listener rather than a relaxed check on the main one, because
   * the thing being widened has to be only the page. This server answers `/ui`
   * and `/ui/data` and 404s everything else, so pointing it at a tailnet
   * address cannot expose `/v1`, the passthrough, or the peer protocol however
   * badly the bind is chosen.
   */
  uiServer: Server | null;
  peers: PeerRegistry;
  history: History;
  /**
   * Start watching the backend and polling peers. Call it before listen().
   *
   * Skipping it doesn't fail, which is the problem. The node serves requests,
   * never learns what's loaded, never marks a peer up, and routes everything
   * locally, and that looks exactly like working. Nasty thing for an embedder
   * to debug, so it's one call instead of three.
   */
  start: () => void;
  close: () => Promise<void>;
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

  /**
   * What we are lending RIGHT NOW — `share:` while lending is on, nothing while
   * it is paused.
   *
   * Every share gate calls this instead of reading cfg.share, which is what
   * makes one switch cover all of them: the peer chat gate, the peer warm gate,
   * what /peer/state advertises, and the peer view of /v1/models.
   */
  const shared = (): readonly string[] => controls.share(cfg.share);

  const history = new History(() => {
    const agg = pool.aggregate();
    return {
      queued: Object.values(agg.queued).reduce((a, b) => a + b, 0),
      // Several backends means several models warm at once, so this is a list.
      residents: pool.loaded(),
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

  /**
   * Two separate per-peer hourly budgets, on purpose.
   *
   * Inference and capacity checks aren't the same thing. A peer polls
   * /peer/state on a timer, four times a minute by default, and if that shares
   * a budget with real work then a perfectly healthy peer burns through it
   * asking whether you're busy. Being refused doesn't stop the poller either,
   * so the lockout feeds itself: their polling keeps the window full and every
   * real request queues up behind a refusal. Two of my nodes managed this
   * within thirteen minutes of meeting each other.
   *
   * So the control plane gets its own, much bigger allowance. It's cheap to
   * serve and the poll interval bounds it anyway. The number is there to stop a
   * broken peer spinning, not to ration a healthy one.
   */
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

  /**
   * On this machine, whatever the config says.
   *
   * The status page is gated on this alone and never on apiKeys. A browser
   * loading a page cannot present a bearer token, and the alternatives are all
   * worse: a key in the query string lands in history and logs, and baking one
   * into the HTML puts a live credential in a response body. Loopback-only
   * needs no credential at all, and an SSH tunnel still looks like loopback, so
   * remote access costs a `-L` and no new auth surface.
   */
  const isLoopback = (req: IncomingMessage) =>
    LOOPBACK.has(req.socket.remoteAddress ?? "");

  /**
   * A local client, by api key.
   *
   * With no keys configured we trust loopback and nothing else. The first
   * version trusted everything in that case, so a node with no keys would treat
   * a wrong peer token as a friendly local caller and just run the request.
   * Backwards for a box that's lending its GPU out. Anyone off-machine needs a
   * key now, whatever the config says.
   */
  function localCaller(req: IncomingMessage): string | null {
    const given = bearer(req);
    if (cfg.apiKeys.length === 0) {
      if (given !== "") return null; // presented a credential; it's not valid here
      return LOOPBACK.has(req.socket.remoteAddress ?? "") ? "local" : null;
    }
    if (given === "") return null;
    // Hash prefix, not the key's own first characters. This id lands in every
    // request log line and in /queue, and six characters of a live credential
    // sitting in a log file is six an attacker doesn't have to guess.
    for (const k of cfg.apiKeys) if (secretEq(given, k)) return "key:" + keyId(k);
    return null;
  }

  /**
   * One line per finished request, at info.
   *
   * `waitedMs` is the number that matters. It's the only thing that tells you
   * whether admission control is doing anything or whether you've added a hop
   * for nothing, and "did it actually queue?" is the first question anyone asks.
   */
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
    log.info("request", {
      ...fields,
      waitedMs: started - t.enqueuedAt,
      runMs: Date.now() - started,
      ok,
      ...(error ? { error: String(error).slice(0, 200) } : {}),
    });
  }

  /**
   * Forward a streamed response to the client, verbatim.
   *
   * All the upstream's headers, not just content-type. Forwarding that one
   * alone was fine for /v1/*, but the catch-all passthrough exists so an app
   * already using /unload or /upstream/<model>/... keeps working, and quietly
   * dropping Location, ETag, Content-Disposition or Retry-After isn't that.
   *
   * Use `pipeline` here, not a hand-rolled write/drain loop. Awaiting 'drain'
   * is correct right up until the client disconnects while a write is
   * backpressured, at which point 'drain' never fires. The loop is suspended on
   * that promise rather than on the body iterator, so destroying the upstream
   * doesn't help either. run() never settles, the scheduler slot never comes
   * back, and at the default concurrency of 1 one badly-timed disconnect wedges
   * the entire node until restart with nothing in the log to say why. pipeline
   * settles either way and destroys the body for us.
   */
  async function pipeThrough(up: UpstreamResponse, res: ServerResponse): Promise<void> {
    res.writeHead(up.status, {
      ...forwardable(up.headers),
      "Content-Type": up.headers["content-type"] ?? "application/json",
      // Tell any proxy in front not to buffer, or a streamed answer arrives all
      // at once at the end and looks like a hang.
      "X-Accel-Buffering": "no",
    });
    await pipeline(up.body, res);
  }

  /**
   * Run one completion, wherever it belongs.
   *
   * The failover is the bit a dumb TCP forwarder can't do. We're in the request
   * path, so a peer that dies before any bytes reach the client can be retried
   * locally without the client ever knowing. After the first byte it can't be:
   * they already have half an answer and replaying would corrupt it.
   */
  async function dispatch(
    payload: Record<string, unknown>,
    model: string,
    lane: string,
    caller: string,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    // Ask the network before deciding, rather than on a timer. Routing is the
    // only consumer of peer state, so we fetch it when a decision needs it:
    // bounded by peerFreshMs, coalesced per peer, skipped for a peer we know is
    // down. A model nobody routes away costs nothing here at all.
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
    const decision = decide(model, cfg, peers, {
      queued: queuedTotal,
      free: cap.free,
      slots: cap.slots,
      loaded: local.state.loaded(),
    });

    const runLocal = async (): Promise<void> => {
      await local.state.ensureFresh();
      // Our id out, the backend's id in — the same rewrite the peer path below
      // does with theirModel, just for a local backend — plus the route's
      // `params` stamped over the client's. Identity unless the model sets
      // one of them, so the common payload is untouched.
      const up = await send(`${local.cfg.url}/v1/chat/completions`, {
        json: pool.outboundBody(model, payload),
        signal,
      });
      await pipeThrough(up, res);
    };

    const t: Timing = { enqueuedAt: Date.now(), startedAt: 0 };

    if (decision.target === "unavailable") {
      // Refusing is the point. The operator said this can't run here.
      logRequest(t, { model, lane, caller, target: "unavailable" }, false, decision.reason);
      apiError(
        res,
        503,
        `${model} runs only on a peer, and no peer is available (${decision.reason})`,
        "server_error",
      );
      return;
    }

    if (decision.target === "local") {
      try {
        await local.scheduler.submit(
          { lane, model, caller, ...(cfg.scheduler.maxPerCaller > 0 ? { maxPerCaller: cfg.scheduler.maxPerCaller } : {}), signal },
          async () => {
            t.startedAt = Date.now();
            await runLocal();
          },
        );
      } catch (e) {
        logRequest(t, { model, lane, caller, backend: local.name, target: "local", reason: decision.reason }, false, e);
        throw e;
      }
      logRequest(t, { model, lane, caller, backend: local.name, target: "local", reason: decision.reason }, true);
      return;
    }

    const peer = peers.config(decision.peer)!;
    let fellBack = false;
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
        // Their id, not ours. The far side might be another hearth, or a
        // llama-swap routing on this field, and a name it doesn't know is a 404.
        // The route's `params` still ride along: the id the user picked meant
        // the same thing wherever the job lands, and dropping them here made a
        // `-low` request come back at full effort whenever it spilled over —
        // silently, and differently again if fallbackLocal brought it home.
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
          // Back through admission control, because this is local GPU work now.
          // Running it inline would inherit the off-box job's exemption from the
          // queue, so a peer that's up but failing would turn every request into
          // an unscheduled local generation. That's the exact thrash this whole
          // thing exists to prevent. Nesting a submit inside a running off-box
          // job is fine, since off-box jobs hold no slot.
          //
          // No maxPerCaller here. The caller already passed the cap on the way
          // in and its off-box job still counts against it, so applying it again
          // would reject its own retry.
          await local.scheduler.submit({ lane, model, caller, signal }, runLocal);
        }
      },
    );
    } catch (e) {
      // The local path logged its failures and this one didn't, so a peer
      // failure or a full queue returned 502/429 with nothing at info. On a
      // service whose one-line-per-request is a selling point.
      logRequest(t, { model, lane, caller, target: "peer", peer: peer.name }, false, e);
      throw e;
    }
    logRequest(
      t,
      { model, lane, caller, target: fellBack ? "local" : "peer", peer: peer.name, offbox: !fellBack },
      true,
    );
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      log.error("request.failed", { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) apiError(res, 500, "internal error", "server_error");
      else res.end();
    });
  });

  /**
   * Refuse a write that a browser made on some other site's behalf.
   *
   * Loopback is this node's whole notion of local trust, and a browser tab is
   * on loopback. So any page you happen to be visiting could POST here — no
   * preflight needed, since a form-shaped fetch is a CORS "simple request", and
   * the attacker not being able to READ the reply does not matter when the
   * damage is the request itself. The README's own advice makes it worse rather
   * than better: `ssh -L 4141:127.0.0.1:4141` puts this on the loopback of the
   * laptop you browse the web on.
   *
   * What that buys an attacker, with no credential at all: switch off lending,
   * unlink every peer mapping, save it into the config file, or hold the GPU in
   * a warm loop. Not theoretical — the routes are one POST each.
   *
   * The check is the presence of a foreign `Origin`, which is exactly the
   * signal a browser adds and nothing else does. curl, the peer protocol and
   * the app upstream all send none and are unaffected. Nor does this break a
   * legitimate browser client on another origin, because there is not one:
   * without CORS headers such a client could never read a reply anyway.
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (crossOriginWrite(req)) {
      log.warn("request.cross_origin", { path, method: req.method, origin: req.headers.origin });
      apiError(res, 403, "cross-origin writes are refused", "permission_error");
      return;
    }

    if (path === "/healthz") {
      json(res, 200, { ok: true, name: cfg.name });
      return;
    }

    // ---- peer surface ----
    if (path === "/peer/hello" || path === "/peer/state") {
      const who = peerCaller(req);
      if (who === null) {
        json(res, 401, { error: "unknown peer token" });
        return;
      }
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
          // Additive rather than a protocol bump: an older peer ignores an
          // unknown field, and a newer one can tell "supports warming" from
          // "will 404" without probing for it. peers.ts already warns on a
          // protocol number it does not recognise, so bumping would have made
          // every existing peer log a warning to gain one boolean.
          capabilities: ["warm"],
        });
        return;
      }
      // loaded/serves ride along with capacity so one probe answers both "can
      // you take work" and "what's warm over there".
      //
      // Both filtered to what we share. `resident` needed that too and didn't
      // have it, so a peer got told which model we had warm even when it was one
      // they can't ask for. Nothing breaks, but it's our business rather than
      // theirs, and it looked like a contradiction next to an empty `loaded`.
      const warmAndShared = pool.loaded().filter((m) => shared().includes(m));
      const agg = pool.aggregate();
      // Protocol 2: what each shared model would actually cost, which is the
      // capacity of the backend that serves it. The aggregate rides along
      // unchanged so a protocol-1 borrower keeps scoring us the old way instead
      // of seeing an unrecognisable answer and marking us down.
      const models: Record<string, unknown> = {};
      for (const m of shared()) models[m] = pool.capacityFor(m);
      json(res, 200, {
        ...agg,
        resident: agg.resident !== null && shared().includes(agg.resident) ? agg.resident : null,
        loaded: warmAndShared,
        serves: shared(),
        models,
      });
      return;
    }

    if (path === "/network") {
      if (localCaller(req) === null) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      // Ask everyone now instead of reading a cache. Someone is sitting there
      // waiting on this, and the cost is one parallel round trip capped at 1.5s
      // per peer.
      await Promise.all([peers.probeAll(), ...pool.all().map((b) => b.state.ensureFresh())]);
      json(res, 200, networkView());
      return;
    }

    /**
     * Turn either direction of federation on or off, without a restart.
     *
     * LOCAL ONLY, like /queue and /network — and this one matters more than
     * those, because it is the only route here that CHANGES anything. A peer
     * must never be able to switch off our lending (a denial of service against
     * ourselves) or, worse, switch it back on after we paused it.
     *
     * GET reads, POST writes. A POST body may carry any of the fields or all of
     * them; omitted fields are left alone so changing one thing cannot clobber
     * another with a stale value.
     *
     *   lending / borrowing   the master switches
     *   share                 {model: true|false|null} — null hands it back to
     *                         the config, which is why it is not two lists
     *   link / unlink         {peer, mine, theirs?} — a peer's model map and
     *                         the route that makes it do anything, together
     *
     * One route rather than four because the status page posts here already and
     * `uiListen.control: key` allows exactly two paths — a new path would have
     * to be added to that allowlist as well, and an allowlist you have to
     * remember to extend is one that eventually gets forgotten.
     */
    if (path === "/control") {
      if (localCaller(req) === null) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
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

      // Per-model sharing. Validated against the local catalog before anything
      // is stored: lending a model we cannot serve advertises it to peers and
      // then 404s every request for it, and the peer's operator has no way to
      // tell that from a broken link.
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

      // Mapping edits, and both blocks are ordered so a POST carrying share AND
      // a link either lands whole or changes nothing: everything above only
      // VALIDATES, link() validates before it mutates, and the share values are
      // written last, once nothing is left that can refuse.
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
            // The default depends on whether we serve it too, and getting this
            // wrong is the whole difficulty of the feature. Serving it here
            // means both sides can run it, so `fastest` picks whichever starts
            // sooner and home is a safe fallback. Not serving it means home is
            // a backend that has never heard of the id, so falling back there
            // turns a busy peer into a 404 rather than a wait.
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

      // Saving is LAST, and deliberately a separate verb rather than something
      // every write does on its way out. Trying a link on a hunch should not
      // outlive the hunch; only what somebody pressed Save on does. Being last
      // also means one POST can change something and keep it in a single call.
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

    if (path === "/queue") {
      if (localCaller(req) === null) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      json(res, 200, {
        jobs: pool.jobs(),
        // Narrowed to what the loaded model can hold, not the backend's flat
        // number: a seat whose resident model declares fewer slots would
        // otherwise report free slots next to jobs that can never use them,
        // which reads as a stuck queue rather than a cap doing its job.
        capacity: pool.loadedAggregate(),
        backends: pool.all().map((b) => ({ name: b.name, ...pool.loadedCapacity(b) })),
      });
      return;
    }

    // Ask a model to be resident, without generating anything.
    //
    // THROUGH THE SCHEDULER, deliberately. A warm on a llama-swap backend is an
    // EVICTION of whatever is loaded, so letting it jump the queue would mean a
    // button that steals the GPU from a turn already in flight. As a job it
    // cannot preempt (a running job always finishes), it waits its turn, and it
    // holds a slot while loading so nothing dispatches into a half-loaded
    // backend. It also does not earn the warm bonus — its model is cold by
    // definition — so it sorts behind work for whatever is already resident.
    //
    // Nothing RESERVES warmth. The next request for another model evicts it
    // again. This is best-effort and the response says so rather than implying
    // a guarantee it cannot make.
    if (path === "/v1/warm" && req.method === "POST") {
      const fromPeer = peerCaller(req);
      const caller = fromPeer ?? localCaller(req);
      if (caller === null) {
        apiError(res, 401, "unauthorized", "authentication_error");
        return;
      }
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

      // THE DECLINE. A peer may ask; it may not make us wait.
      //
      // A local warm queues happily — it is your box and your call, and the
      // queue is what stops it stealing a slot. A peer is different in two
      // ways: it would hold a connection open across our queue for speculative
      // work, and honouring it evicts OUR resident model at a moment we did not
      // choose. So it is taken only if it can start about now, and refused
      // plainly otherwise. A peer that must obey is a peer who can thrash your
      // GPU from across the tailnet.
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
        // ASK, do not guess. Measured against a real older peer: it answers
        // 401, not 404, because /v1/warm is unknown to it and falls through to
        // a passthrough that only trusts local callers. A status-code heuristic
        // would have reported "bad credentials" for "feature not present".
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
            // A health probe on the model's own upstream. llama-swap starts the
            // server to answer it, which loads the model without generating a
            // token — cheaper and more honest than a one-token completion.
            // BOUNDED. send() has no default deadline, so a backend that
            // accepts the connection and never answers would hold this
            // backend's slot forever and wedge every other job queued behind
            // it — a hung warm taking the whole queue down with it. 900s
            // matches the chat path and is generous enough for a cold load of
            // a large model off a slow disk.
            const up = await send(`${slot.cfg.url}/upstream/${encodeURIComponent(wire)}/health`, {
              method: "GET",
              signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(900_000)]),
            });
            if (!up.ok) throw new Error(`backend returned ${up.status} warming ${wire}`);
            await up.text().catch(() => "");
            // So the very next /ui/data or /network sees it, rather than waiting
            // out the poll interval and looking like the warm did nothing.
            await slot.state.refresh().catch(() => {});
          },
        );
      } catch (e) {
        // A full lane is the caller's cue to back off, not a broken server.
        // Reported as 502 it looks like the backend failed, and a client that
        // retries on 429 but not 502 would give up on a queue that just needed
        // a moment.
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

    if (path === "/v1/models") {
      const modelsPeer = peerCaller(req);
      if (localCaller(req) === null && modelsPeer === null) {
        apiError(res, 401, "unauthorized", "authentication_error");
        return;
      }
      try {
        // The union, so a client sees every model this node can serve rather
        // than only whatever the first backend happens to list. Freshened first
        // so a model added since startup shows up.
        await Promise.all(pool.all().map((b) => b.state.ensureFresh()));
        // Carry warm state, the way llama-swap does on this route. Pointing an
        // app at us instead of its backend is supposed to change nothing it can
        // see, and a client that loses this field loses any idea of which model
        // answers now and which one costs a load first.
        const warm = new Set(pool.loaded());
        const upstream: { data?: { id: string; status?: { value: string } }[] } = {
          data: pool.catalog().map((id) => {
            // A backend that cannot report warm state must not be flattened
            // into cold. "We cannot see" and "nothing is loaded" are different
            // claims and only one of them would be honest, so such a model
            // carries no status at all rather than a made-up one.
            if (pool.for(id).cfg.kind === "none") return { id };
            return { id, status: { value: warm.has(id) ? "loaded" : "unloaded" } };
          }),
        };
        // A peer only sees what it may use. This used to hand the whole backend
        // catalogue to anyone with a peer token. Unusable, since every other
        // route enforces the share list, but a full inventory of what someone
        // runs isn't theirs to have. Model names alone can be personal.
        if (modelsPeer !== null) {
          json(res, 200, {
            ...upstream,
            data: (upstream.data ?? []).filter((m) => shared().includes(m.id)),
          });
          return;
        }
        json(res, 200, upstream);
      } catch (e) {
        apiError(res, 502, `backend unreachable: ${String(e)}`, "server_error");
      }
      return;
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      // A peer's request gets served here and never routed onward. Two nodes
      // that each prefer the other would otherwise bounce a request back and
      // forth until something gave out.
      const fromPeer = peerCaller(req);
      const caller = fromPeer ?? localCaller(req);
      if (caller === null) {
        apiError(res, 401, "unauthorized", "authentication_error");
        return;
      }
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

      // Peers don't choose our lane, see cfg.peerLane. Local callers can, with
      // a non-standard `lane` field, which we strip before forwarding so it
      // never reaches an OpenAI backend that would reject it.
      const lane =
        fromPeer !== null
          ? cfg.peerLane
          : typeof payload.lane === "string" && payload.lane in cfg.scheduler.lanes
            ? payload.lane
            : Object.keys(cfg.scheduler.lanes)[0]!;
      delete payload.lane;

      const ctrl = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) ctrl.abort();
      });

      try {
        if (fromPeer !== null) {
          const t: Timing = { enqueuedAt: Date.now(), startedAt: 0 };
          const serving = pool.for(model);
          try {
            await serving.scheduler.submit(
              // peerMaxConcurrent rather than maxPerCaller. A peer is always a
              // caller we can tell apart, so it gets capped whether or not
              // apiKeys are set. Otherwise a borrower is bounded only by an
              // hourly rate no serialized GPU could ever retire, and their retry
              // loop parks in front of the host's own work.
              //
              // Capped per backend, so a borrower filling the GPU queue does not
              // also lock itself out of the embedder.
              { lane, model, caller, maxPerCaller: cfg.peerMaxConcurrent, signal: ctrl.signal },
              async () => {
                t.startedAt = Date.now();
                await serving.state.ensureFresh();
                // A peer asked in OUR vocabulary, so the same rewrite and the same
                // stamped params apply on the way to the backend as for a local
                // caller. (Before, a lent `as` model reached the backend under
                // the advertised id and 404'd.)
                const up = await send(`${serving.cfg.url}/v1/chat/completions`, {
                  json: pool.outboundBody(model, payload),
                  signal: ctrl.signal,
                });
                await pipeThrough(up, res);
              },
            );
          } catch (e) {
            // Both halves, same as the local path. This logged successes only,
            // so a refused borrower or a failed lent generation left nothing at
            // info. That's the one kind of traffic you most want to account for
            // afterwards.
            logRequest(t, { model, lane, target: "local", forPeer: fromPeer }, false, e);
            throw e;
          }
          // Lent capacity is the thing you most want a record of.
          logRequest(t, { model, lane, target: "local", forPeer: fromPeer }, true);
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
        // A peer's REFUSAL is passed through with its own status. 502 would say
        // "the far side broke", which is a different fact and provokes the
        // opposite client behaviour: 5xx is retryable and 4xx is not, so
        // laundering their 429 into our 502 is what turns their rate limit into
        // our retry storm. Their 5xx still becomes our 502 — that genuinely is
        // an upstream failure from where our caller sits.
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

    if (path === "/ui" || path === "/ui/" || path === "/ui/data") {
      // On the MAIN port the page stays loopback-only. Reaching it from
      // elsewhere is what uiListen is for, and that is a separate socket.
      if (!isLoopback(req)) {
        apiError(res, 403, "the status page is loopback-only", "permission_error");
        return;
      }
      await serveUi(path, res, true);
      return;
    }

    // ---- everything else: straight through, unqueued ----
    //
    // A real backend is more than /v1. llama-swap alone serves /unload,
    // /running and /upstream/<model>/<anything>, and an app already using those
    // would break the moment it pointed at us. That's the opposite of "change
    // one base url", so anything not claimed above gets proxied as-is: method,
    // body, the lot.
    //
    // Not queued by default, on purpose. These are control-plane calls and
    // non-chat generation endpoints whose shapes we don't know, and scheduling
    // work you can't identify is guesswork. Anything sending them almost
    // certainly has its own admission control. Queueing here would also
    // deadlock a caller that's holding its own slot while it waits on us.
    //
    // `backends[].routes` is how an operator says otherwise for a specific
    // path. That resolves the objection rather than ignoring it: a named path
    // IS identified, and naming it is a statement that hearth is the admission
    // control for it — which also means whatever used to queue it must stop.
    const who = localCaller(req);
    if (who === null) {
      apiError(res, 401, "unauthorized", "authentication_error");
      return;
    }
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

    // Which backend? These paths are not chat, so there is no route table to
    // consult, but most of them still name a model somewhere: /v1/embeddings
    // and friends carry it in the body, and llama-swap's /upstream/<model>/...
    // puts it in the path. Peek at both, and fall back to the first backend,
    // which is exactly where a single-backend node always sent them.
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
    const named = routed ? undefined : (viaPath ?? viaBody);
    const target = routed ? routed.slot : named ? pool.for(named) : pool.first();
    if (named && !pool.single) {
      log.debug("passthrough.resolved", { path, model: named, backend: target.name });
    }

    // THE ONE EXCEPTION to this path's verbatim promise, and it is deliberate.
    //
    // Everything else here is forwarded byte for byte, headers included, because
    // trimming it has broken things before. But an aliased id is a name the
    // backend has never heard of: forwarding it faithfully guarantees a 404.
    // /v1/embeddings is the case that matters — it carries `model` in the body
    // and never touches the chat dispatch above, so without this the alias
    // works for chat and fails for embeddings, which is worse than not having it.
    //
    // Scoped as tightly as possible: only when the id actually differs, only for
    // a JSON body that already parsed, and only the `model` field. The path
    // form (/upstream/<model>/...) is rewritten too, since llama-swap routes on
    // that segment.
    let outBody = body;
    let outPath = path;
    if (named) {
      const wire = pool.outboundId(named);
      if (wire !== named) {
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
        log.debug("passthrough.aliased", { path, from: named, to: wire });
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
        // Client's headers minus hop-by-hop. Cutting this down to Content-Type
        // dropped Accept, Range, and any Authorization the backend itself wants,
        // on the one path whose whole promise is "verbatim".
        //
        // Except OUR key, if that is what it is. A caller who authenticated to
        // hearth handed us a hearth credential, and passing it on puts it in
        // the backend's logs and its request history — a place it has no reason
        // to be, and one the operator has no idea it reached. A credential the
        // backend actually wants is one that did NOT match ours, and that is
        // still forwarded untouched.
        headers: stripOurKey(req) as Record<string, string>,
        signal: ctrl.signal,
      });
      log.debug("passthrough", { path, status: up.status });
      await pipeThrough(up, res);
    };

    try {
      // A route declared `queue: false` — a progress endpoint, a job list —
      // goes straight through. Those are what the caller polls WHILE the work
      // it is asking about holds the slot, so queueing them behind it would
      // make a progress bar that only moves once there is nothing left to
      // report.
      if (routed?.rule.queue) {
        const { lane, model } = routed.rule;
        await target.scheduler.submit(
          { lane, model, caller: who, signal: ctrl.signal },
          proxy,
        );
      } else {
        await proxy();
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

  /** The page and its data. The only two things either listener will serve. */
  /**
   * `canWarm` says whether POST /v1/warm is reachable FROM THIS PAGE.
   *
   * The page is served on both listeners, but the ui-only one answers /ui and
   * /ui/data and 404s everything else — deliberately, so widening that bind
   * cannot widen anything but the page. A warm button there would be a control
   * that always fails. Rather than relax that listener, the page is told
   * whether the action exists and hides it when it does not.
   */
  /**
   * How the page may write, from the socket it was served on.
   *
   *   "off"  — read-only. It renders state and offers no controls.
   *   "open" — writes need no credential: apiKeys is empty, so localCaller
   *            trusts loopback and the browser IS on loopback.
   *   "key"  — writes need a bearer apiKey, so the page asks for one and keeps
   *            it client-side.
   *
   * The "key" case is not only about the status listener. It fixes the main
   * listener too, which had a quiet mismatch: /ui is gated by isLoopback while
   * /v1/warm is gated by localCaller, and once apiKeys is set localCaller wants
   * a credential EVEN FROM LOOPBACK. So on any keyed deployment the warm
   * buttons on the main page already answered 401 — invisible to us, because
   * our own node runs with apiKeys empty.
   */
  const writeMode = (): "open" | "key" => (cfg.apiKeys.length === 0 ? "open" : "key");

  async function serveUi(path: string, res: ServerResponse, canWarm = false): Promise<void> {
    if (path === "/ui/data") {
      // One payload rather than three fetches. It also means /network and
      // /queue keep their own auth gate untouched: nothing here relaxes them,
      // the page simply does not use them.
      //
      // ensureFresh, not probeAll: the page polls every few seconds, and a
      // forced round trip to every peer on every poll would turn a status page
      // into a load generator.
      await peers.ensureFresh();
      json(res, 200, {
        canWarm,
        // How this page must authenticate its writes, decided per socket rather
        // than assumed. "off" when the socket serves no write routes at all.
        control: canWarm ? writeMode() : "off",
        // Shown on both sockets, since knowing you are paused matters most when
        // you are looking at a page that says nothing is being served. The
        // BUTTONS are gated on canWarm, which is really "is this the socket that
        // can perform actions" — the standalone UI listener answers three paths
        // and /control is not one of them, so a switch there would always fail.
        controls: controls.state(),
        // Everything the sharing and mapping controls need to render: what we
        // could lend, what the file says we lend, what we lend right now, and
        // what differs. Sent even to the read-only listener, which renders the
        // same facts without the buttons.
        share: shared(),
        configuredShare: cfg.share,
        catalog: pool.catalog(),
        overrides: overrideView(),
        net: networkView(),
        q: {
          jobs: pool.jobs(),
          capacity: pool.loadedAggregate(),
          backends: pool.all().map((b) => ({ name: b.name, ...pool.loadedCapacity(b) })),
        },
        hist: history.all(),
      });
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

  /**
   * The status-page listener.
   *
   * Deliberately NOT the main handler with a looser gate. This one knows about
   * a short, explicit list of paths and answers 404 to everything else, so
   * however wide the bind, nothing else is on this socket. No passthrough to
   * the backend, no peer protocol, no /healthz, and above all no peer routes —
   * peerCaller is never consulted here, so a peer token is worth nothing on
   * this port however valid it is elsewhere.
   *
   * With `uiListen.control: key` the list gains the two WRITE routes, and they
   * are handled by the very same functions the main listener uses, gated by the
   * very same localCaller. That gate already accepts a valid apiKey from any
   * address, so this adds a socket, not an authority. Unauthenticated, this
   * port still serves exactly the page.
   */
  const uiWritable = cfg.uiListen?.control === "key";
  const UI_PATHS = new Set(["/ui", "/ui/", "/ui/data", "/"]);
  const uiServer = cfg.uiListen
    ? createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const isWrite = uiWritable && req.method === "POST" && (path === "/control" || path === "/v1/warm");
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
        void serveUi(path === "/ui/data" ? "/ui/data" : "/ui", res, uiWritable).catch((e) => {
          log.error("ui.failed", { error: e instanceof Error ? e.message : String(e) });
          if (!res.headersSent) json(res, 500, { error: "internal error" });
          else res.end();
        });
      })
    : null;

  /**
   * Who has what, and what's warm.
   *
   * Peer ids get translated into our namespace wherever a mapping exists, since
   * that's the only name a caller here can actually ask for. Models a peer
   * offers that we haven't mapped are reported separately rather than hidden.
   * "They have capacity you can't reach yet" is worth knowing, and it turns this
   * endpoint into a config diagnostic.
   */
  /**
   * What is set at runtime and not in the file, in one shape.
   *
   * On /control and /ui/data both, because the two ways of driving this — a
   * curl and the page — must not disagree about whether there is anything
   * pending. It carries the ready-to-paste YAML rather than making the page
   * build it: rendering config is exactly the job that belongs on the side that
   * owns the config types.
   */
  /**
   * Where a Save would go, or null for nowhere.
   *
   * The config file wins whenever it can be written, because that is the one
   * place a change should end up. The sidecar exists for the case where it
   * cannot be — a read-only bind mount in a container is the usual one — and
   * the page names the destination rather than leaving it to be discovered.
   */
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

  function overrideView() {
    const changes = overrides.changes();
    const dirty =
      changes.maps.length > 0 ||
      changes.routes.length > 0 ||
      [...shared()].sort().join(",") !== [...cfg.share].sort().join(",");
    return {
      changes,
      dirty,
      // Two separate questions, and collapsing them would lose the one that
      // matters: `dirty` is "not in hearth.yaml", `unsaved` is "will not
      // survive a restart". A saved change is still not in the config file, and
      // the page still offers the YAML for it.
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

  function networkView() {
    const cap = pool.loadedAggregate();
    // How many of our jobs each peer is running right now, so an edge can show
    // live flow rather than just "configured".
    const sendingTo = new Map<string, number>();
    for (const j of pool.jobs()) {
      if (j.offbox && j.peer) sendingTo.set(j.peer, (sendingTo.get(j.peer) ?? 0) + 1);
    }

    const nodes: Record<string, unknown>[] = [
      {
        name: cfg.name,
        self: true,
        up: true,
        serves: pool.catalog(),
        loaded: pool.loaded(),
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
            // Only llama-swap evicts. An ollama backend keeps its set resident
            // and serves them together, so there is no thrash to warn about.
            evicts: b.cfg.kind === "llama-swap",
            slots: c.slots,
            free: c.free,
            queued: Object.values(c.queued).reduce((a, x) => a + x, 0),
            loaded: b.cfg.serves.length && b.state.loaded().length
              ? [...b.cfg.serves]
              : b.state.loaded(),
            serves: b.cfg.serves.length ? [...b.cfg.serves] : b.state.catalog(),
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
        // What the CONFIG says we may send here, in my ids — independent of
        // whether the peer is reachable. `serves` above comes from their live
        // /peer/state, so an unreachable peer reports an EMPTY one and the page
        // had nothing to draw: the node survived but its models vanished, which
        // reads as "this peer offers nothing" rather than "we cannot see it".
        //
        // Deliberately a SEPARATE field, not a fallback merged into `serves`.
        // `serves` is a verified claim about what a peer is actually offering
        // right now; `configured` is only our own intent. Collapsing them would
        // let a peer that has been down for a week look like it is serving.
        configured: Object.keys(theirs.models).sort(),
        // The mapping itself, my id -> theirs, because an editor needs the
        // pairs and `configured` is only the left-hand side. Effective, not
        // what the file said: a runtime link has to show up here or the row you
        // just added would be missing from the table you added it in.
        map: { ...theirs.models },
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
    close: () =>
      new Promise<void>((resolve) => {
        peers.stop();
        pool.stop();
        history.stop();
        uiServer?.close();
        uiServer?.closeAllConnections?.();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
