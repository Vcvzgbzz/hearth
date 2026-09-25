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
import { needsOf, NOTE_MAX, unfit, type ModelStats } from "./stats.js";
import { UI_HTML } from "./ui.js";
import { send, type UpstreamResponse } from "./upstream.js";

/**
 * Constant-time compare over digests. No length leak, no throw on mismatch.
 *
 * The digests are the point, and both halves of that sentence are load-bearing.
 * timingSafeEqual THROWS on unequal lengths, so a raw-byte compare has to guard
 * with an early `length !==` return — and that return is a length oracle: an
 * attacker sweeps the length of their own input and watches for the one that
 * stops returning immediately. Hashing first removes the choice. Both sides
 * become 32 bytes, so there is nothing to guard against and nothing to learn:
 * hashing the attacker's input costs time proportional to input they already
 * know, and hashing the fixed secret costs the same on every request.
 */
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
  /**
   * Stop, optionally letting requests already in flight finish first.
   *
   * `graceMs` defaults to 0, which destroys them where they stand -- the old
   * behaviour, kept as the default because a test that just wants the socket
   * back should not wait on a request it deliberately left hanging. The
   * service passes `shutdownGraceMs`.
   */
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
  /** A local identity, and what it may run: null is everything. */
  type Local = { caller: string; models: string[] | null };

  function localCaller(req: IncomingMessage): Local | null {
    const given = bearer(req);
    if (cfg.apiKeys.length === 0) {
      if (given !== "") return null; // presented a credential; it's not valid here
      return LOOPBACK.has(req.socket.remoteAddress ?? "") ? { caller: "local", models: null } : null;
    }
    if (given === "") return null;
    // A labeled key shows the operator's own name; an unlabeled one keeps the
    // hash prefix, not the key's own first characters. This id lands in every
    // request log line and in /queue, and a label is never key material, while
    // six characters of a live credential is six an attacker doesn't have to
    // guess — so the fallback stays the hash, never the key.
    let i = 0;
    for (const k of cfg.apiKeys) {
      if (secretEq(given, k)) {
        return { caller: "key:" + (cfg.apiKeyLabels[i] || keyId(k)), models: cfg.apiKeyModels[i] ?? null };
      }
      i++;
    }
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
  /** Relays the upstream answer and hands back the status it relayed, so a
   *  caller can record what actually happened. A backend's own 4xx is passed
   *  to the client untouched — it is a better error than anything we could
   *  invent — but it is NOT a success, and the request log and the console's
   *  call history used to record it as one. */
  /** Sends a chat completion to a local backend, emulating another server's answers if the route asks. */
  async function sendLocal(url: string, model: string, payload: Record<string, unknown>, res: ServerResponse, opts: { signal: AbortSignal } & ReturnType<typeof backendDeadline>): Promise<number> {
    const emulate = cfg.models[model]?.emulate ?? null;
    const body = pool.outboundBody(model, payload);
    const sentAt = Date.now();
    const up = await send(`${url}/v1/chat/completions`, { json: emulate ? emulatedRequest(body) : body, ...opts });
    return emulate ? relayEmulated(up, res, forwardable(up.headers), sentAt) : pipeThrough(up, res);
  }

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
      // Our id out, the backend's id in — the same rewrite the peer path below
      // does with theirModel, just for a local backend — plus the route's
      // `params` stamped over the client's. Identity unless the model sets
      // one of them, so the common payload is untouched.
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
      // Too big (or too rich) for the model that would run it here. Refused
      // now, with both numbers, rather than after a queue wait and a swap — and
      // only on something the backend actually told us, so a model we have
      // never loaded is never refused on a guess. The backend stays the
      // authority on its own limits: this catches the clear cases early and
      // does not replace its check. The peer-failed fallback below does not
      // repeat it, so a request that fitted the peer but not the local model
      // still reaches the backend and is refused there — one rare path with
      // an uglier error, not a wrong answer.
      const tooMuch = unfit(pool.statsFor(model), need);
      if (tooMuch !== null) {
        logRequest(t, { model, lane, caller, backend: local.name, target: "local" }, false, tooMuch);
        apiError(res, 400, `${model} ${tooMuch}`, "invalid_request_error");
        return;
      }
      try {
        await local.scheduler.submit(
          { lane, model, caller, ...(cfg.scheduler.maxPerCaller > 0 ? { maxPerCaller: cfg.scheduler.maxPerCaller } : {}), signal, tokens: pool.poolTokens(model, need) },
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
          lastTarget = "local";
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
          await local.scheduler.submit({ lane, model, caller, signal, tokens: pool.poolTokens(model, need) }, runLocal);
        }
      },
    );
    } catch (e) {
      // The local path logged its failures and this one didn't, so a peer
      // failure or a full queue returned 502/429 with nothing at info. On a
      // service whose one-line-per-request is a selling point. lastTarget
      // reflects the *actual* last target, even when a local retry after a
      // peer failure also failed — the log should not pretend the peer won.
      //
      // `target` is not only a label: logRequest gates the call ring on it, so
      // saying "local" here also enrols a failed fallback as a local use. That
      // is right — the weights were busy either way — but only with `backend`
      // alongside it, or the record lands with an empty backend name and is
      // invisible to everything that groups by one.
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

  /**
   * Requests being served right now, for the drain in `close()`.
   *
   * Counted here rather than from `pool.jobs()` because a job is only the
   * queued half: a passthrough render holds no job at all, and neither does a
   * peer relay. What must not be destroyed mid-flight is a REQUEST, so that is
   * what is counted.
   */
  let inFlight = 0;
  let drained: (() => void) | null = null;
  /** Responses that are open but are not work — the event stream. */
  const parked = new WeakSet<ServerResponse>();

  /**
   * Stop counting this response as work in flight.
   *
   * For a long-lived stream: it is open for as long as somebody has a tab
   * open, so counting it would make every shutdown sit out the full drain
   * waiting for a page that is never going to finish.
   */
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

  /**
   * One request, with its caller already established.
   *
   * `peer` and `caller` are resolved by the table below and handed in, so a
   * handler never re-asks who is calling — which is what let one route's answer
   * differ from another's.
   */
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

  /**
   * Who a route lets in.
   *
   * Declared once per path instead of re-derived inside each handler. The
   * routes here differ in ways that are easy to get subtly wrong by hand — one
   * is deliberately open, one is decided by address rather than credential, and
   * three accept either a peer or a local caller — and the way that goes wrong
   * is a route that quietly accepts more than it meant to.
   */
  type Auth =
    /** No credential at all. Only /healthz, which is built to say nothing. */
    | "open"
    /**
     * By ADDRESS, never by credential.
     *
     * The status page's own gate. EventSource cannot send an Authorization
     * header, so deciding these sockets by address is what lets the stream and
     * the poll share one story about auth instead of needing two.
     */
    | "loopback"
    /** A peer's token, and nothing else. */
    | "peer"
    /** This machine, or one of our api keys. Never a peer. */
    | "local"
    /** Either — work a peer may send us, and we may ask for ourselves. */
    | "either";

  /**
   * The refusal's shape, because clients parse it.
   *
   * The /v1 surface answers in OpenAI's error envelope because that is what an
   * OpenAI client reads; the control and peer surfaces answer in the plain
   * `{error}` shape they always have. Stated per route so the pairing is a
   * decision rather than a coincidence of which helper was nearest.
   */
  type Envelope = "plain" | "openai";

  interface Route {
    path: string | string[];
    /**
     * Methods this route claims. Anything else FALLS THROUGH to the
     * passthrough, which is how a `GET /v1/chat/completions` has always
     * reached the backend untouched.
     */
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

  /**
   * Resolve the caller for a route, or answer the refusal and return null.
   *
   * The single place a credential is turned into an identity. A handler that
   * wants to know who is calling reads it off `Call`; there is nowhere else to
   * ask.
   */
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

  /**
   * Every path this node answers, in the order they are tried.
   *
   * The point of the table is the `auth` column: it is the one property of a
   * route that must never be got wrong, and having it beside the path makes a
   * new route's policy a thing you choose rather than a thing you remember to
   * copy. The passthrough is last and claims everything left, which is what
   * makes pointing an app at hearth instead of its backend change nothing the
   * app can see.
   */
  const ROUTES: Route[] = [
    // Unauthenticated on purpose, and on a port that may be bound wide, so it
    // answers in counts and never in names.
    { path: "/healthz", auth: "open", handler: routeHealthz },

    { path: ["/peer/hello", "/peer/state"], auth: "peer", handler: routePeer },

    // Local only. /control is the one route here that CHANGES anything, so a
    // peer must never reach it: switching off our lending is a denial of
    // service against ourselves, and switching it back on after we paused it
    // is worse.
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
   * Whether this node can serve, for an external probe.
   *
   * It used to answer `{ok: true}` unconditionally, which made it a check
   * that the socket accepts connections and nothing more -- every backend
   * dead and every peer gone still read healthy, so the one thing monitoring
   * it could tell you was the one thing you already knew from the fact that
   * it answered.
   *
   * The honest signal is the event stream. Where we hold one open, a backend
   * going away drops it within a reconnect; that is real, it is continuously
   * maintained, and it costs nothing to read. What it is NOT built on is
   * `answering()`, which means "something came back from this lately" -- on a
   * quiet box nothing does, so every backend reads silent while all of them
   * are fine, even one with a model resident.
   *
   * So: 503 only when we are watching backends and have lost every one of
   * them. A config we cannot watch reports `watched: 0` and stays ok, because
   * hearth does not probe backends it is not using and will not invent a
   * verdict it has no evidence for -- and a probe that cried wolf on an idle
   * box would be worse than the unconditional true it replaced.
   *
   * Peers never affect `ok`. A peer being down is a routing input, not this
   * node's health, and every model that matters has a local fallback.
   *
   * UNAUTHENTICATED, and on a port that may be bound wide -- so counts, never
   * names. What is loaded, who is calling and which models exist stay behind
   * the page's gate.
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
    for (const m of shared()) {
      // Capacity says whether they can start now; stats say whether their
      // request can run at all. Both are per model, both are things a
      // borrower has no other way of finding out, and they ride the same
      // poll. Absent when we have never loaded it — silence is not a claim
      // that there is no limit, see unfit().
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

  async function routeQueue(c: Call): Promise<void> {
    const { res } = c;
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
          // Bounded by the same deadline every other backend call uses: a
          // warm that hangs holds this backend's slot and wedges everything
          // queued behind it.
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

  async function routeModels(c: Call): Promise<void> {
    const { res } = c;
    const modelsPeer = c.peer;
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
      type Entry = { id: string; status?: { value: string }; context_length?: number; description?: string };
      const upstream: { data?: Entry[] } = {
        data: pool.catalog().map((id) => {
          // A backend that cannot report warm state must not be flattened
          // into cold. "We cannot see" and "nothing is loaded" are different
          // claims and only one of them would be honest, so such a model
          // carries no status at all rather than a made-up one.
          // Same principle for context_length: absent when unknown, not null,
          // because we cannot see is not the same claim as a value.
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
      // Models only a peer serves. A client asks for them by OUR id, so that
      // is what gets listed, with the window and warmth the peer reported for
      // THEIR id on its last poll. Nothing reported (peer down, protocol 1,
      // never loaded) is silence, not cold and not unlimited, as above. A
      // model we also serve locally keeps the local reading: that is where a
      // request lands when the peer is not chosen.
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
      // A peer only sees what it may use. This used to hand the whole backend
      // catalogue to anyone with a peer token. Unusable, since every other
      // route enforces the share list, but a full inventory of what someone
      // runs isn't theirs to have. Model names alone can be personal.
      // The context_length field travels with the entry, so a peer can size
      // its own client limit from the shared subset.
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
    // Refused before it is queued, and only where it cannot be wrong. An id
    // nothing serves used to fall through to the first backend, wait its
    // turn, possibly evict whatever was resident, and then 404 — so a typo
    // cost a slot on the GPU. It still routes to a peer if one maps it, even
    // a peer that is currently down: that is a routing question, and the
    // policies below already answer it.
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
      // A borrower who ignored our advertised stats, or whose estimate came
      // in low, gets the same answer the local path gives — before the work
      // is queued and before it evicts anything. 4xx on purpose: their
      // request is wrong, and PeerStatusError.isRefusal means they hand that
      // verdict to their caller instead of retrying it at us.
      const why = unfit(pool.statsFor(model), needsOf(payload));
      if (why !== null) {
        apiError(res, 400, `${model} ${why}`, "invalid_request_error");
        return;
      }
    }

    // Peers don't choose our lane, see cfg.peerLane. Local callers can, with
    // a non-standard `lane` field, which we strip before forwarding so it
    // never reaches an OpenAI backend that would reject it. A lane on the
    // model route beats the client's: the operator ranked that id.
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
            // peerMaxConcurrent rather than maxPerCaller. A peer is always a
            // caller we can tell apart, so it gets capped whether or not
            // apiKeys are set. Otherwise a borrower is bounded only by an
            // hourly rate no serialized GPU could ever retire, and their retry
            // loop parks in front of the host's own work.
            //
            // Capped per backend, so a borrower filling the GPU queue does not
            // also lock itself out of the embedder.
            { lane, model, caller, maxPerCaller: cfg.peerMaxConcurrent, signal: ctrl.signal, tokens: pool.poolTokens(model, needsOf(payload)) },
            async () => {
              t.startedAt = Date.now();
              await serving.state.ensureFresh();
              // A peer asked in OUR vocabulary, so the same rewrite and the same
              // stamped params apply on the way to the backend as for a local
              // caller. (Before, a lent `as` model reached the backend under
              // the advertised id and 404'd.)
              lentStatus = await sendLocal(serving.cfg.url, model, payload, res, { signal: ctrl.signal, ...backendDeadline(serving.cfg) });
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

  async function routeUi(c: Call): Promise<void> {
    const { req, res, path } = c;
    // Same gate, same data, different transport. EventSource cannot send an
    // Authorization header, which is exactly why the page's sockets are
    // decided by ADDRESS and not by credential — so the stream needs no
    // separate story about auth, and gets none.
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
    // Resolved by the table rather than re-derived here.
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
    // What the CALLER asked for, kept apart from `named` below. The two used to
    // be one value, which quietly meant a declared route could not also be an
    // aliased model: `named` picks the backend, a route has already picked one,
    // so it had to be undefined here — and that also switched off the rewrite.
    const asked = viaPath ?? viaBody;
    const named = routed ? undefined : asked;
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
    // A DECLARED route needs the same rewrite, for the same reason. Queueing a
    // path does not change what the backend calls the model, so `routes:` and
    // `as:` used to be mutually exclusive in a way nothing said out loud: the
    // route matched, the request was scheduled, and the backend was then handed
    // an id it had never heard of.
    //
    // Scoped as tightly as possible: only when the id actually differs, only for
    // a JSON body that already parsed, and only the `model` field. The path
    // form (/upstream/<model>/...) is rewritten too, since llama-swap routes on
    // that segment.
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
        ...backendDeadline(target.cfg),
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
        const { lane } = routed.rule;
        // Two models can share one routed path; each queues as itself.
        const model = pool.routedModel(routed.slot, routed.rule, asked);
        // Recorded like any other local use, because that is what it is.
        //
        // A declared route already went through the scheduler — it waited its
        // turn and held a slot — but it left no trace in the history ring, so it
        // drew no spark and no bar and never reached "last 10 minutes". Video
        // renders have been queueing invisibly this whole time for that reason,
        // and a sidecar call is worse: they finish in under a second, so the
        // running-job particle is gone before the next 3s poll and the history
        // was the only place they could ever have shown up.
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

  /**
   * The first-byte deadline for a call to a local backend.
   *
   * A helper rather than a literal at each call site, because the failure it
   * guards against is invisible until it happens and the cost of forgetting it
   * at one site is the whole node: a backend that accepts the connection and
   * never answers holds a scheduler slot for as long as the process lives, and
   * with `resources` declared it holds the card too.
   *
   * Takes the backend, because the plausible wait is a property of what is
   * behind the port. A sidecar that renders a clip before it answers at all is
   * not misbehaving when it takes half an hour, and a node-wide number sized
   * for a chat server would cut its honest work off mid-render.
   */
  const backendDeadline = (b: BackendConfig): { headersTimeoutMs?: number } => {
    const ms = b.firstByteMs ?? cfg.backendFirstByteMs;
    return ms > 0 ? { headersTimeoutMs: ms } : {};
  };

  /**
   * Everything the page draws, in one object.
   *
   * Extracted from `serveUi` so the poll and the event stream cannot drift:
   * `/ui/data` is one of these serialised, and a stream frame is the diff
   * between two of them. A field added here reaches both by construction.
   *
   * ensureFresh, not probeAll: this is built every second while a page is
   * open, and a forced round trip to every peer each time would turn a status
   * page into a load generator.
   */
  async function uiPayload(canWarm: boolean): Promise<Record<string, unknown>> {
    await peers.ensureFresh();
    // Page-driven, exactly like ensureFresh above: a backend's declared activity
    // path is read only while a page is assembling its data — a broadcast tick,
    // the first snapshot, or the /ui/data poll fallback — never on a background
    // timer, so hearth still makes no unbidden poll of a backend. Fire-and-forget
    // and rate-limited inside: this frame draws the last reading, the next draws
    // this one.
    for (const b of pool.all()) if (b.cfg.activity) void b.state.sampleActivity(b.cfg.activity);
    return {
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
      contexts: (() => {
        const out: Record<string, number> = {};
        for (const id of pool.catalog()) {
          const ctx = pool.contextLength(id);
          if (ctx !== null) out[id] = ctx;
        }
        return out;
      })(),
      // Which advertised ids are one seat under another name. `models.<id>.as`
      // rewrites the id on the way to a local backend, so an id whose `as` is
      // itself an advertised model is a VARIANT of that model: the same weights
      // answering to a second id, usually with different `params`. The page
      // folds those under their parent instead of drawing sixteen rows for
      // eleven models. An `as` that names a backend-only wire id (nomic-embed
      // -> nomic-embed-text-v2-moe:latest) is a rename, not a variant; the page
      // can tell the two apart because it also has the catalog, so both are
      // sent as they are.
      aliases: aliasView(),
      // Where a request for each id is allowed to go, and what happens when it
      // cannot go there. This is the decision hearth exists to make, so the
      // console has to be able to state it: a mapping alone only says a request
      // MAY leave, and the policy beside it says whether it will.
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
   * The page, pushed instead of polled.
   *
   * The poll was 95KB every 3 seconds per open tab, and 93% of it was `hist` --
   * 120 samples of which the client already had 119. So the stream sends one
   * snapshot on connect and then only what changed, with new history samples
   * appended one at a time. An idle box goes from ~31KB/s to nothing at all.
   *
   * Frames are diffs of the SAME object `/ui/data` serves, so there is one
   * payload builder and the two transports cannot drift. `/ui/data` stays
   * exactly as it was: it is the fallback when EventSource cannot connect, and
   * it is what every test reads.
   *
   * One baseline is shared by every subscriber, which is why `canWarm` and
   * `control` are stamped per connection at snapshot time and never appear in a
   * patch -- they describe the SOCKET, not the node, and they never change for
   * the life of one.
   */
  const streams = new Set<ServerResponse>();
  let lastSent: Record<string, unknown> | null = null;
  let uiTimer: ReturnType<typeof setInterval> | null = null;
  let lastFlushAt = 0;

  /** 1s, against the page's old 3s. Cheap now that a quiet tick sends nothing,
   *  and it is the difference between a graph that animates and one that
   *  lurches. Not configurable: a knob here would only ever be turned down to
   *  save traffic that no longer exists. */
  const UI_TICK_MS = 1_000;
  /** Comment frames keep an idle connection alive through anything that times
   *  out a quiet socket. Nothing should be between us and the browser, but a
   *  stream that dies silently after 60s is a bad way to find out otherwise. */
  const UI_PING_MS = 15_000;

  /**
   * Everything after `prev`'s last element, when `next` is `prev` with items
   * appended (and possibly some dropped off the front, which is what a ring
   * does). Null when it cannot be expressed that way and the array must be
   * sent whole.
   *
   * By value rather than by index: a fixed-size ring gives no stable position,
   * and by timestamp would drop the second of two samples that share a
   * millisecond -- the same trap that made the queue table lose rows.
   */
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
    // Backpressure is ignored on purpose. Every frame is derived from a
    // snapshot the client can re-request, so a slow reader falling behind
    // costs it freshness and nothing else -- and the alternative, buffering
    // per client, is how a status page starts holding memory.
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * The baseline, built at most once at a time.
   *
   * `uiPayload` awaits `peers.ensureFresh()`, which can outlast the tick
   * exactly when a peer is timing out — which is exactly when somebody is
   * watching. Two overlapping builds both diff against the same `lastSent`,
   * and whichever finishes LAST wins the baseline: if that is the older
   * snapshot, the newer one's changes are never sent again, because the next
   * diff is taken against a payload that already contained them.
   *
   * Both producers go through here — the tick and a page connecting — because
   * they race each other as readily as the tick races itself. A subscriber that
   * built its own snapshot while a broadcast was building the next one would be
   * handed a baseline the server then forgot, and every field that differed
   * between the two would stay wrong on that page until it changed again.
   *
   * Callers that find a build already running join it rather than starting a
   * second. The page's own poll fallback carries the same guard for the same
   * reason.
   */
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
  /**
   * Requests we are proxying right now, unqueued.
   *
   * The passthrough below is deliberately not scheduled, which is a statement
   * about ADMISSION and was silently also a statement about visibility: an
   * image render arrives on /upstream/<model>/generate, never becomes a job,
   * and so the console drew an idle backend and a free card while the GPU was
   * flat out. The queue was right and the picture was wrong.
   *
   * Counting is not queueing. Nothing here decides whether a request runs, in
   * what order, or waits for anything — the bytes are already in our hands on
   * their way through, and this notes that they are. The arbiter still does not
   * know about this work, and the card is still reported as unheld, because
   * that remains the truth: we were never asked to admit it and cannot make it
   * wait for anything.
   */
  let proxySeq = 0;
  const proxying = new Set<{ id: string; backend: string; model: string | null }>();

  const uiWritable = cfg.uiListen?.control === "key";
  /**
   * What the standalone listener serves, and nothing else.
   *
   * A separate question from the auth table above: that decides who may call a
   * path, this decides which paths exist on a socket that may be bound wide.
   * Both are allowlists and they sit together so that adding a route somewhere
   * else does not quietly appear here — the point of this port is that it is a
   * status page and a shorter attack surface, not a second front door.
   */
  const UI_PATHS = new Set(["/ui", "/ui/", "/ui/data", "/ui/events", "/"]);
  /**
   * The only writes this port will pass through, and only when `uiListen`
   * allows writes at all.
   *
   * Kept as a named set rather than an inline comparison because it is the
   * half that gets forgotten: a new control path added to the main table is
   * NOT reachable here until it is named here too, and that is deliberate.
   */
  const UI_WRITE_PATHS = new Set(["/control", "/v1/warm"]);
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
      changes.notes.length > 0 ||
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

  /**
   * Advertised id -> how it routes.
   *
   * Effective, so a runtime link shows the policy it was linked with rather
   * than the one the file was last written with.
   */
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
  
  function networkView() {
    const cap = pool.loadedAggregate();
    // How many of our jobs each peer is running right now, so an edge can show
    // live flow rather than just "configured".
    const sendingTo = new Map<string, number>();
    for (const j of pool.jobs()) {
      if (j.offbox && j.peer) sendingTo.set(j.peer, (sendingTo.get(j.peer) ?? 0) + 1);
    }

    // What each model can take, per node rather than merged into one map. Two
    // nodes can serve the same id with different windows — a 262k local coder
    // and a peer running the same weights at 32k — and a union would have to
    // pick one of those numbers and get it wrong for somebody.
    const selfStats: Record<string, ModelStats> = {};
    // Route models as well as the catalogue. A `kind: none` backend is in no
    // catalogue and can never answer /props, so a declaration is the ONLY thing
    // that will ever be known about it — and leaving it out of the payload
    // would mean the one model whose stats can only be declared is the one the
    // page cannot show. Nothing is enforced for these: their requests arrive on
    // a declared path with a body we do not read, so there is nothing to
    // measure. Reported, not checked.
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
            // Whether anything has come back from it lately, and ONLY for the
            // backends where silence means something — the ones whose event
            // stream we hold open. A polled or `none` backend is never
            // contacted unless something is being asked of it, so hearing
            // nothing from one is not evidence of anything, and sending `false`
            // there had the page draw a red "nothing back in a minute" against
            // every CPU sidecar on a perfectly healthy box.
            //
            // Omitted rather than sent as `false`, so the distinction lives on
            // the wire instead of in a rule the page has to remember. Same
            // reasoning as `knowsWarm` above: not knowing is its own answer.
            ...(b.state.watched() ? { answering: b.state.answering() } : {}),
            // A backend's own busy signal, for one hearth forwards to but does
            // not schedule. Sent whenever the path is declared — INCLUDING when
            // it could not be read (ok:false), which the page draws as unknown
            // rather than idle, so omitting it there would be the wrong silence.
            ...(b.cfg.activity ? { activity: b.state.activity() } : {}),
            // Only llama-swap evicts. An ollama backend keeps its set resident
            // and serves them together, so there is no thrash to warn about.
            evicts: b.cfg.kind === "llama-swap",
            slots: c.slots,
            free: c.free,
            queued: Object.values(c.queued).reduce((a, x) => a + x, 0),
            // Only what is ACTUALLY resident, mapped back into advertised ids.
            //
            // This used to return the whole `serves` list the moment ANYTHING
            // was loaded, which made a seven-model image backend report all
            // seven as warm while llama-swap held exactly one. The console then
            // drew six cold models as warm — and "will this cost me a load" is
            // the entire question that indicator exists to answer. The reason
            // for the shortcut was that state.loaded() speaks WIRE ids; the fix
            // is to translate them rather than to give up on them.
            loaded: b.cfg.serves.length
              ? [...b.cfg.serves].filter((m) => b.state.isWarm(pool.outboundId(m)))
              : b.state.loaded(),
            // Being read off the disk right now. The longest thing that happens
            // on this box, and until now the only one the page could not name:
            // a cold load drew as "nothing loaded" with a job running on it,
            // which is true twice and explains nothing. Same translation as
            // `loaded` above, for the same reason.
            //
            // Empty for a backend that cannot tell us, which is not a claim
            // that nothing is loading — so the page draws this only when there
            // IS something in it, and draws no absence.
            // Where a resident model's weights actually are, when the launch
            // command says something worth reporting. Permanent, unlike a
            // load: every token crosses the boundary, not just the first.
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
            // A backend fronting a non-OpenAI service has an EMPTY serves list,
            // so without this it draws as a bare name with nothing beside it
            // forever — the one row on the page that could never say what it
            // does. Its work is addressed by path, so the path is the answer.
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
      // Event streams go first and explicitly. They are already excluded from
      // the in-flight count, so they would not HOLD the drain — but leaving
      // them open means a page keeps its connection to a node that is going
      // away, and reconnects to nothing. Ending them lets EventSource start
      // retrying immediately.
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
