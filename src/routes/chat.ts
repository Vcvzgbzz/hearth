/**
 * The chat doors (`/v1/chat/completions`, `/v1/messages`) and `/flows/try`: admit a request, route it
 * through its flow, and run it on a local backend or a peer, falling back where the flow allows.
 */
import { pipeline as pipelineCb } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type ActionFacts, actionDecls } from "../actions.js";
import { Refusal } from "../admit.js";
import { relayAnthropic, toAnthropic } from "../anthropic.js";
import { type BackendConfig, ConfigError, type HearthConfig, backendAuth, flowsFor } from "../config.js";
import { emulatedRequest, relayEmulated } from "../emulate.js";
import { KEY_REFUSED, fail, headersOf, jobId, json, pipeThrough, refusedKey, relayable } from "../http.js";
import { MessagesResponse, chatOf } from "../messages.js";
import { PeerStatusError } from "../peers.js";
import { type Active, type HookRequest, PluginRefusal, replyText } from "../plugins.js";
import { type Timing, notRun } from "../requestlog.js";
import { type Resolution, type World, mayLeave, resolve } from "../route.js";
import { QueueFullError } from "../scheduler.js";
import { fitOutput, needsOf, unfit } from "../stats.js";
import { send } from "../upstream.js";
import { type Meter, meter, withoutUsage } from "../usage.js";
import type { Call, RouteContext } from "./context.js";

export function chatRoutes(ctx: RouteContext) {
  const { cfg, log, pool, peers, plugins, canary, answers, callers, limits, worlds, requests, readJson, degraded, backendDeadline } = ctx;

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


  /** Refuse a degraded model on the chat route. */
  function refuseDegraded(model: string): void {
    const refusal = degraded(model);
    if (refusal) throw refusal;
  }

  /** Sends a chat completion to a local backend, emulating another server's answers if the route asks. */
  async function sendLocal(to: BackendConfig, model: string, payload: Record<string, unknown>, res: ServerResponse, opts: { signal: AbortSignal; /** Where a stream's usage is counted, for a backend that reports it only when asked. */ count?: Meter } & ReturnType<typeof backendDeadline>, spare = false): Promise<number> {
    const emulate = cfg.models[model]?.emulate ?? null;
    const { count, ...deadline } = opts;
    const url = to.url;
    const reach = { ...deadline, headers: backendAuth(to.format, to.key, to.headers) };
    const sent = pool.outboundBody(model, payload);
    if (to.format === "anthropic") {
      const up = await send(`${url}/v1/messages`, { json: toAnthropic(sent, to.promptCache, to.promptCacheTtl), ...reach });
      if (to.key && refusedKey(up.status) && !res.headersSent) { await up.text(); throw new BackendFailed(502, KEY_REFUSED); }
      if (spare && up.status >= 500 && !res.headersSent) throw new BackendFailed(up.status, (await up.text()).slice(0, 200));
      const asks = typeof sent.stream_options === "object" && sent.stream_options !== null && (sent.stream_options as Record<string, unknown>).include_usage === true;
      return relayAnthropic(up, res, { model: String(sent.model ?? model), usage: asks, ...(count ? { meter: count } : {}) });
    }
    const options = typeof sent.stream_options === "object" && sent.stream_options !== null ? sent.stream_options as Record<string, unknown> : {};
    // A provider says what a stream cost only when asked. Asked here for the count, the report is kept from a caller who did not ask for it.
    const ask = count !== undefined && sent.stream === true && options.include_usage !== true;
    const body = ask ? { ...sent, stream_options: { ...options, include_usage: true } } : sent;
    const sentAt = Date.now();
    const got = await send(`${url}/v1/chat/completions`, { json: emulate ? emulatedRequest(body) : body, ...reach });
    // Errors on either side end both, so the relay below sees a failed stream as it would the backend's own.
    const up = ask && got.status < 400 ? { ...got, body: pipelineCb(got.body, withoutUsage(count!), () => {}) } : got;
    // The key refused was this node's, not the caller's: said as such, and the request may move on.
    if (to.key && refusedKey(up.status) && !res.headersSent) { await up.text(); throw new BackendFailed(502, KEY_REFUSED); }
    // With somewhere else to run it, a backend's own failure is not relayed: the request moves on.
    if (spare && up.status >= 500 && !res.headersSent) throw new BackendFailed(up.status, (await up.text()).slice(0, 200));
    if (emulate) return relayEmulated(up, res, relayable(up), sentAt);
    // Observed as it is relayed, never held back: see RelayWatch.
    return pipeThrough(up, res, canary?.watchRelay(model, pool.for(model).name, up.headers["content-type"]));
  }

  /** A backend answered 5xx before anything reached the client, while its flow had another place to send the request. */
  class BackendFailed extends Refusal {
    constructor(status: number, detail: string) { super(status, detail || `backend answered ${status}`, "server_error"); }
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
      const real = worlds.worldFor(typeof b.caller === "string" ? b.caller : "local", from.models[asked]?.lane ?? lane, need, from, tried);
      // `pretend` stands in for state that cannot be arranged on demand: models named as idle, just used, busy, loaded or held.
      const pretend = (typeof b.pretend === "object" && b.pretend !== null ? b.pretend : {}) as Record<string, unknown>;
      const said = (k: string): string[] => (Array.isArray(pretend[k]) ? (pretend[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
      const r = resolve(asked, {
        ...real,
        idleMs: (m) => (said("idle").includes(m) ? Number.MAX_SAFE_INTEGER : said("used").includes(m) ? 0 : real.idleMs!(m)),
        held: (m, l) => said("held").includes(m) || real.held(m, l),
        ready: (m) => !said("unready").includes(m) && (said("warm").includes(m) || worlds.ready(m)),
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

  /** One chat request on its way through: who sent it, what it asked for, and where its answer goes. */
  interface ChatRequest {
    /** The request body; routing writes the model it chose and the route's params into it. */
    payload: Record<string, unknown>;
    /** The model the client asked for, and the lane it asked to queue in. */
    asked: string;
    lane: string;
    caller: string;
    res: ServerResponse;
    signal: AbortSignal;
    headers: World["headers"];
    onPosition?: ((position: number) => void) | undefined;
    id?: string | undefined;
    /** The caller's limits, when admit left them to be checked once the flow has decided. */
    checkLimits?: (() => void) | undefined;
    /** The plugins on this request, what they last saw of it, and whether one asked to keep it here. */
    plugins?: { active: Active[]; hook: HookRequest; stayLocal: boolean };
  }

  /** Route a chat request and run it, then tell the actions that wait for how it ended. */
  async function dispatch(r: ChatRequest): Promise<void> {
    const ended: ((error: string | null) => void)[] = [];
    let error: string | null = null;
    let status = 0;
    const startedAt = Date.now();
    // Kept before routing has said which line's plugins join, so any plugin that may read the reply has it.
    const reply = r.plugins && plugins.anyWantsReply() ? keepCopy(r.res) : null;
    try {
      status = await route(r, ended);
      if (status >= 400) error = `backend answered ${status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (e instanceof Refusal) status = e.status;
      throw e;
    } finally {
      for (const tell of ended) tell(error);
      if (r.plugins) {
        plugins.observe(error === null ? "log" : "error", r.plugins.active, {
          ...r.plugins.hook, status: status || 200, error, reply: reply ? replyText(reply()) : null, ms: Date.now() - startedAt,
        });
      }
    }
  }

  /** A copy of what is written to a response, up to a cap, for plugins that read the reply. Encoded bodies are not kept. */
  function keepCopy(res: ServerResponse, cap = 2_000_000): () => string {
    const parts: Buffer[] = [];
    let size = 0;
    const keep = (chunk: unknown): void => {
      if (size > cap || chunk === undefined || chunk === null || typeof chunk === "function") return;
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += b.length;
      if (size <= cap) parts.push(b);
    };
    const write = res.write.bind(res) as (...a: unknown[]) => boolean;
    const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
    res.write = ((chunk: unknown, ...rest: unknown[]) => { keep(chunk); return write(chunk, ...rest); }) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => { if (typeof chunk !== "function") keep(chunk); return end(chunk, ...rest); }) as typeof res.end;
    return () => (res.getHeader("content-encoding") ? "" : Buffer.concat(parts).toString("utf8"));
  }

  /** A model that runs at a cloud provider: it would take a request off this machine. */
  const offHere = (model: string): boolean => pool.for(model).cfg.cloud;
  /** Where a decision sends a request, as a plugin sees it. */
  const where = (d: { target: "local" | "peer"; model: string; peer?: string }): Pick<HookRequest, "model" | "target" | "peer" | "backend" | "leaves"> =>
    d.target === "peer"
      ? { model: d.model, target: "peer", peer: d.peer ?? null, backend: null, leaves: true }
      : { model: d.model, target: "local", peer: null, backend: pool.for(d.model).name, leaves: offHere(d.model) };

  /** Returns the status a local backend relayed, or 0 when a peer answered. */
  async function route(r: ChatRequest, ended: ((error: string | null) => void)[]): Promise<number> {
    const { payload, asked, lane: askedLane, caller, res, signal, onPosition, id, headers, checkLimits } = r;
    const kept = r.plugins?.stayLocal === true;
    // Refresh peer state only when a decision needs it, and only for requests that may leave.
    if (mayLeave(cfg, asked)) await peers.ensureFresh();

    // The flow reads each model on the backend that would serve it here: a node with an idle
    // embedder and a busy GPU has no single answer to "am I busy". Per model, like a peer's
    // numbers, since a backend's flat count says "free" while THIS model's slots are full.
    // What this request asks for goes with it, so a peer whose model is too small is passed over
    // rather than sent the prompt across the network to be refused there.
    const talk = worlds.conversation(caller, asked, payload);
    const world: World = {
      ...worlds.worldFor(caller, askedLane, needsOf(payload, cfg.models[asked]?.videoTokens), worlds.rulesFor(caller), headers),
      // Only a later turn is held to where the conversation started; an opening turn is decided afresh.
      ...(talk?.later ? { pinned: (flow: string) => worlds.pinned(flow, talk.key) } : {}),
      // A plugin asked to keep this request on this machine: no peer, no cloud provider.
      ...(kept ? { keepHere: offHere } : {}),
    };
    const startedAt = Date.now();
    const flowsNow = world.cfg.flows;
    let decision = resolve(asked, world);
    // A name this node does not offer is not found, which is a different answer from one it will not run right now.
    const paths = flowsNow[decision.via[0] ?? ""]?.takes;
    const notHere = decision.unlisted ? decision.reason
      // Nor is one that takes paths of its own a chat model.
      : paths ? `"${asked}" is not offered as chat: it takes ${paths.join(", ")}` : null;
    if (notHere !== null) {
      requests.record(notRun(), { model: asked, lane: askedLane, caller, target: "refused" }, false, notHere);
      throw new Refusal(404, notHere);
    }
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
      if (flowsNow === cfg.flows) worlds.countHits(r.path);
      // A sticky flow remembers where it put this conversation, for its later turns.
      const sticky = flowsNow[r.path.at(-1)?.flow ?? ""]?.sticky;
      if (talk && sticky !== undefined && r.target !== "unavailable") {
        worlds.place(r.path.at(-1)!.flow, talk.key, r.target === "peer" ? { peer: r.peer, model: r.model } : { model: r.model }, sticky);
      }
      // A step with a limit counts this request against it until the response closes.
      for (const p of r.path) {
        if (flowsNow[p.flow]?.steps[p.step]?.max !== undefined) worlds.occupy(p.flow, p.step, res);
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
        if (action.on === "decided") worlds.act(a.name, action, facts);
        else ended.push((error) => {
          // One reading of the clock, so the time it ran is never more than the time it took.
          const now = Date.now();
          const ms = now - startedAt;
          if ((action.on === "failed" && error === null) || (action.slowerThan > 0 && ms <= action.slowerThan)) return;
          // Where it ended up, which a failed backend or peer may have changed since the step decided.
          const ran = t.startedAt > 0 ? now - t.startedAt : 0;
          worlds.act(a.name, action, { ...facts, model, backend: ranOn, outcome: error === null ? "ok" : "failed", ms, error: error ?? "", queuedMs: ms - ran, ranMs: ran });
        });
      }
    };
    fire(decision);
    if (r.plugins && decision.target !== "unavailable") {
      const p = r.plugins;
      p.hook = { ...p.hook, ...where(decision), lane, body: payload };
      // The step that sent it to a model places its own plugins, after those that run on every line.
      const step = decision.path.at(-1);
      if (step) p.active = [...p.active, ...plugins.forLine("chat", flowsNow[step.flow]?.steps[step.step]?.plugins ?? [], { router: worlds.routerNameOf(caller), flow: step.flow, step: step.step })];
      let after;
      try {
        after = await plugins.run("routed", p.active, p.hook);
      } catch (e) {
        if (!(e instanceof PluginRefusal)) throw e;
        requests.record(notRun(), { model, lane, caller, target: "refused", plugin: e.plugin }, false, e.message);
        throw new Refusal(e.status, e.message);
      }
      const changed = after.req.body !== p.hook.body;
      p.hook = after.req;
      p.stayLocal ||= after.stayLocal;
      if (changed) {
        for (const k of Object.keys(payload)) delete payload[k];
        Object.assign(payload, after.req.body);
      }
      lane = after.req.lane;
      // Changed after routing: routed once more, so a bigger prompt or a request kept here lands where it fits.
      if (changed || (p.stayLocal && p.hook.leaves)) {
        const again = resolve(asked, { ...world, need: needsOf(payload, cfg.models[asked]?.videoTokens), ...(p.stayLocal ? { keepHere: offHere } : {}) });
        if (again.target === "unavailable" || again.target !== decision.target || again.model !== decision.model) {
          decision = again;
          land(again);
          fire(again);
          if (again.target !== "unavailable") p.hook = { ...p.hook, ...where(again) };
        }
      }
    }
    if (model !== asked) {
      refuseDegraded(model);
      log.debug("route.flow", { asked, via: decision.via, as: model, reason: decision.reason });
    } else if (decision.target === "local") {
      worlds.using(model, res);
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
      localStatus = await sendLocal(local.cfg, model, payload, res, { signal, ...backendDeadline(local.cfg), ...(local.cfg.cloud && t.meter ? { count: t.meter } : {}) }, spare);
    };

    const t: Timing = { enqueuedAt: Date.now(), startedAt: 0, meter: meter(res), need: Math.max(0, (need?.tokens ?? 0) - (need?.output ?? 0)) };

    if (decision.target === "unavailable") {
      // Refusing is the point. The operator said this can't run here.
      requests.record(t, { model, lane, caller, target: "unavailable" }, false, decision.reason);
      // The flow's own words: a refusal step's reason, with why a peer was passed over when one was.
      throw new Refusal(503, `${asked} is not being run: ${decision.reason}`, "server_error");
    }
    // A flow that runs a name as itself still needs something here to serve it.
    const instead = decision.target === "local" ? limits.unknownHere(model) : null;
    if (instead !== null) {
      const why = `no backend here serves "${model}" (${instead})`;
      requests.record(notRun(), { model: asked, lane: askedLane, caller, target: "refused" }, false, why);
      throw new Refusal(404, why);
    }
    checkLimits?.();
    /** A model's own limits, checked once for each model this request lands on. */
    const limited = new Set<string>();
    const limitModel = (m: string): void => {
      if (limited.has(m)) return;
      limited.add(m);
      limits.withinModelLimits(caller, m);
    };
    limitModel(model);

    // A model that keeps its answers gives one back to a request identical to the one it answered.
    // A stream opened early to report queue position is neither kept nor answered from what is.
    const keepMs = cfg.models[model]?.cacheMs ?? 0;
    if (keepMs > 0 && onPosition === undefined) {
      const key = answers.key(model, payload);
      const hit = answers.get(key);
      if (hit !== null) {
        res.writeHead(200, { "Content-Type": hit.type, "X-Hearth-Cache": "hit", "X-Accel-Buffering": "no", ...(res.hasHeader("x-hearth-model") ? { "x-hearth-model": String(res.getHeader("x-hearth-model")) } : {}) });
        res.end(hit.body);
        requests.record(t, { model, lane, caller, target: "cache" }, true);
        return 200;
      }
      answers.keep(res, key, keepMs);
    }

    /**
     * Run it here. A backend that fails before anything reaches the client is passed over like a peer that
     * is down: the flow is asked again without it, and the request runs where that lands, here.
     */
    const runHere = async (): Promise<number> => {
      const failed = new Set<string>();
      let why = decision.reason;
      for (;;) {
        // A strict router's callers get the model its line names or its failure, so for them nothing is left to ask for.
        const spare = (): ReturnType<typeof resolve> => (worlds.routerOf(caller)?.strict
          ? { ...decision, target: "unavailable" as const, reason: "its router never falls back" }
          : resolve(asked, { ...world, noPeers: true, skip: new Set([...failed, model]) }));
        // A backend that keeps failing is not made to fail once more for each request, while another line fits.
        if (local.state.restingMs() > 0 && !res.headersSent) {
          const next = spare();
          if (next.target === "local" && !failed.has(next.model) && next.model !== model) {
            log.debug("route.resting_trying_next", { asked, model, backend: local.name, next: next.model, restingMs: local.state.restingMs() });
            failed.add(model);
            land(next);
            fire(next);
            why = next.reason;
            continue;
          }
        }
        // Refused here only on reported limits, before queueing or evicting; the backend stays the authority.
        const fitted = fitOutput(pool.statsFor(model), needsOf(payload, cfg.models[model]?.videoTokens), payload);
        const tooMuch = unfit(pool.statsFor(model), fitted);
        if (tooMuch !== null) {
          requests.record(t, { model, lane, caller, backend: local.name, target: "local" }, false, tooMuch);
          throw new Refusal(400, `${model} ${tooMuch}`);
        }
        try {
          limitModel(model);
          const elsewhere = spare().target === "local";
          await local.scheduler.submit(
            // A second try goes back through admission without re-applying the caller cap.
            { lane, model, caller, ...limits.keyLimitOf(caller, model), ...(failed.size === 0 ? { maxPerCaller: limits.capOf(caller, model), onPosition, ...(id ? { id } : {}) } : {}), signal, tokens: pool.poolTokens(model, fitted) },
            async () => {
              t.startedAt = Date.now();
              await runLocal(elsewhere);
            },
          );
        } catch (e) {
          requests.record(t, { model, lane, caller, backend: local.name, target: "local", reason: why }, false, e);
          // Its own fault, not the caller's or a full queue's: counted towards resting it.
          if (!signal.aborted && !(e instanceof QueueFullError) && (e instanceof BackendFailed || !(e instanceof Refusal))) local.state.struck(cfg.backendRestMs);
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
        // An answer of its own making that says it cannot serve (overloaded, rate limited) counts as a failure too.
        if (localStatus >= 500 || localStatus === 429) local.state.struck(cfg.backendRestMs);
        else local.state.answered();
        requests.record(
          t,
          { model, lane, caller, backend: local.name, target: "local", reason: why,
            ...(localStatus >= 400 ? { status: localStatus } : {}) },
          localStatus < 400,
          localStatus >= 400 ? `backend answered ${localStatus}` : undefined,
        );
        return localStatus;
      }
    };

    /** Run it on the peer the flow chose; one that fails before the first byte is retried here. */
    const runOnPeer = async (decision: Extract<Resolution, { target: "peer" }>): Promise<number> => {
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
            maxPerCaller: limits.capOf(caller, model),
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
            const over = peers.sent(peer.name, decision.theirModel);
            try {
              const up = await send(`${peer.url}/v1/chat/completions`, {
                json: body,
                headers: { Authorization: `Bearer ${peer.token}` },
                signal,
                // A peer can accept the connection and then never answer, unlike
                // the local backend. This turns that into a fallback instead of a
                // hang. 0 disables it.
                ...(cfg.peerFirstByteMs > 0 ? { headersTimeoutMs: cfg.peerFirstByteMs } : {}),
                // A peer that goes silent mid-answer is cut as a local backend is.
                ...(cfg.backendIdleMs > 0 ? { idleTimeoutMs: cfg.backendIdleMs } : {}),
              });
              if (!up.ok) {
                const detail = await up.text();
                if (up.status === 429) peers.rateCapped(peer.name, decision.theirModel, up.headers["retry-after"]);
                throw new PeerStatusError(peer.name, up.status, detail.slice(0, 200));
              }
              peers.served(peer.name);
              await pipeThrough(up, res);
              over();
            } catch (e) {
              over();
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
              limitModel(model);
              await local.scheduler.submit({ lane, model, caller, ...limits.keyLimitOf(caller, model), signal, tokens: pool.poolTokens(model, need) }, () => runLocal());
            }
          },
        );
      } catch (e) {
        // Log the actual last target, local fallback included, with its backend so the call ring counts it.
        requests.record(t, { model, lane, caller, backend: local.name, target: lastTarget, peer: peer.name }, false, e);
        throw e;
      }
      requests.record(
        t,
        { model, lane, caller, backend: local.name, target: lastTarget, peer: peer.name, offbox: !fellBack,
          ...(fellBack && localStatus >= 400 ? { status: localStatus } : {}) },
        // Only the fallback can have relayed a bad status: a peer's own 4xx threw
        // a PeerStatusError further up and never reached here.
        !fellBack || localStatus < 400,
        fellBack && localStatus >= 400 ? `backend answered ${localStatus}` : undefined,
      );
      return fellBack ? localStatus : 0;
    };

    return decision.target === "local" ? runHere() : runOnPeer(decision);
  }

  async function routeChat(c: Call): Promise<void> {
    try {
      const payload = await readJson(c.req);
      const model = typeof payload.model === "string" ? payload.model : "";
      let deferred: boolean;
      try {
        deferred = limits.admit(c, model, true);
        // Before anything is queued or routed: a degraded seat is out of rotation
        // for everyone, peers included.
        refuseDegraded(model);
      } catch (e) {
        requests.refused(c, model, e);
        throw e;
      }
      await chat(c, model, payload, deferred);
    } catch (e) {
      fail(c.res, e);
    }
  }

  /** A Messages request served as a chat completion; everything written goes out in Messages shapes. */
  async function routeMessages(c: Call): Promise<void> {
    const out = new MessagesResponse(c.res);
    const m: Call = { ...c, res: out as unknown as ServerResponse };
    try {
      const body = await readJson(c.req);
      out.model = typeof body.model === "string" ? body.model : "";
      let deferred: boolean;
      try {
        deferred = limits.admit(m, out.model, true);
        refuseDegraded(out.model);
      } catch (e) {
        requests.refused(m, out.model, e);
        throw e;
      }
      await chat(m, out.model, chatOf(body), deferred);
    } catch (e) {
      fail(m.res, e);
    }
  }

  async function chat(c: Call, asked: string, sent: Record<string, unknown>, limitsDeferred = false): Promise<void> {
    let payload = sent;
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
        : cfg.models[model]?.lane ?? callers.ruleOf(caller)?.lane ??
          (typeof payload.lane === "string" && payload.lane in cfg.scheduler.lanes
            ? payload.lane
            : Object.keys(cfg.scheduler.lanes)[0]!);
    delete payload.lane;

    const ctrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ctrl.abort();
    });

    if (fromPeer === null) {
      let headers = headersOf(c.req);
      // A plugin's own calls, and every request when plugins are off, run none.
      const active = c.internal ? [] : plugins.forRequest("chat", worlds.routerNameOf(caller));
      let state: ChatRequest["plugins"];
      // A request any plugin might see carries their state: plugins on the line it takes join once routing has decided.
      if (!c.internal && plugins.any()) {
        const hook: HookRequest = { id: requests.id(), kind: "chat", asked: model, caller, router: worlds.routerNameOf(caller), lane, headers, body: payload };
        let before;
        try {
          before = await plugins.run("request", active, hook);
        } catch (e) {
          if (!(e instanceof PluginRefusal)) throw e;
          requests.record(notRun(), { model, lane, caller, target: "refused", plugin: e.plugin }, false, e.message);
          throw new Refusal(e.status, e.message);
        }
        payload = before.req.body;
        headers = before.req.headers;
        lane = before.req.lane;
        if (typeof payload.model === "string" && payload.model !== model) model = payload.model;
        state = { active, hook: before.req, stayLocal: before.stayLocal };
      }
      await dispatch({
        payload, asked: model, lane, caller, res, signal: ctrl.signal, headers,
        onPosition: positionStream(c.req, res, payload), id: jobId(c.req),
        checkLimits: limitsDeferred ? () => limits.withinLimits(caller) : undefined,
        ...(state ? { plugins: state } : {}),
      });
      return;
    }
    // A peer running a model here is that model in use.
    worlds.using(model, res);

    const t: Timing = { enqueuedAt: Date.now(), startedAt: 0, meter: meter(res) };
    const serving = pool.for(model);
    // As on the local path: what we relayed to the borrower, so lent
    // capacity that failed is not filed as lent capacity that worked.
    let lentStatus = 0;
    try {
      await serving.scheduler.submit(
        // Peers are capped per backend, whether or not apiKeys are set.
        { lane, model, caller, ...limits.capFor(fromPeer, model), signal: ctrl.signal, tokens: pool.poolTokens(model, needsOf(payload, cfg.models[model]?.videoTokens)) },
        async () => {
          t.startedAt = Date.now();
          await serving.state.ensureFresh();
          // A lent request gets the same id rewrite and params as a local one.
          lentStatus = await sendLocal(serving.cfg, model, payload, res, { signal: ctrl.signal, ...backendDeadline(serving.cfg) });
        },
      );
    } catch (e) {
      // Log lent failures too.
      requests.record(t, { model, lane, target: "local", forPeer: fromPeer }, false, e);
      throw e;
    }
    // Lent capacity is the thing you most want a record of.
    requests.record(
      t,
      { model, lane, target: "local", forPeer: fromPeer,
        ...(lentStatus >= 400 ? { status: lentStatus } : {}) },
      lentStatus < 400,
      lentStatus >= 400 ? `backend answered ${lentStatus}` : undefined,
    );
  }

  return { routeChat, routeMessages, routeFlowsTry };
}
