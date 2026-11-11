/**
 * The chat doors (`/v1/chat/completions`, `/v1/messages`), `/flows/try` and `/flows/replay`: admit a request, route it
 * through its flow, and run it on a local backend or a peer, falling back where the flow allows.
 */
import { pipeline as pipelineCb } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type ActionFacts, actionDecls } from "../routing/actions.js";
import { PeerStatusError, QueueFullError, Refusal } from "../errors.js";
import { relayAnthropic, toAnthropic } from "../wire/anthropic.js";
import { type BackendConfig, backendAuth } from "../config/backends.js";
import type { HearthConfig } from "../config/config.js";
import { callerDecls, flowsFor, routerDecls } from "../config/flows.js";
import { ConfigError } from "../config/read.js";
import { emulatedRequest, relayEmulated } from "../wire/emulate.js";
import { KEY_REFUSED, fail, headersOf, jobId, json, pipeThrough, refusedKey, relayable } from "../wire/http.js";
import { MessagesResponse, chatOf } from "../wire/messages.js";
import { type Active, type HookRequest, PluginRefusal, replyText } from "../plugins/plugins.js";
import { type Timing, type Traced, firstByte, notRun } from "../observe/requestlog.js";
import { REQUESTS_KEPT } from "../observe/requests.js";
import type { RequestTrace } from "../observe/uidata.js";
import { type Resolution, type World, mayLeave, resolve } from "../routing/route.js";
import type { BackendSlot } from "../queue/pool.js";
import { fitOutput, type Need, needsOf, unfit } from "../routing/stats.js";
import { send } from "../wire/upstream.js";
import { type Meter, meter, withoutUsage } from "../observe/usage.js";
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
    const sent = pool.models.outboundBody(model, payload);
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
    return pipeThrough(up, res, canary?.watchRelay(model, pool.models.for(model).name, up.headers["content-type"]));
  }

  /** A backend answered 5xx before anything reached the client, while its flow had another place to send the request. */
  class BackendFailed extends Refusal {
    constructor(status: number, detail: string) { super(status, detail || `backend answered ${status}`, "server_error"); }
  }

  /** The config with a draft's sections in force in place of the live ones; a section left out stays as it is. */
  function draftOf(b: Record<string, unknown>): HearthConfig {
    if (b.flows === undefined) return cfg;
    try {
      const actions = b.actions === undefined ? cfg.actions : actionDecls(b.actions);
      const flows = flowsFor(b.flows, cfg, actions);
      const routers = b.routers === undefined ? cfg.routers : routerDecls(b.routers, (raw) => flowsFor(raw, cfg, actions), cfg.plugins);
      const callerMap = b.callers === undefined ? cfg.callers : callerDecls(b.callers, routers);
      return { ...cfg, actions, flows, routers, callers: callerMap };
    } catch (e) {
      if (e instanceof ConfigError) throw new Refusal(400, e.message);
      throw e;
    }
  }

  /** Where one request would go under `from` right now, as `/flows/try` answers it; `pretend` stands in for state that cannot be arranged on demand. */
  function decideNow(asked: string, from: HearthConfig, q: { caller: string; lane: string; need: Need; headers: World["headers"]; pretend?: Record<string, unknown> }) {
    const real = worlds.worldFor(q.caller, from.models[asked]?.lane ?? q.lane, q.need, from, q.headers);
    const pretend = q.pretend ?? {};
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
    const small = r.target === "local" ? unfit(pool.models.statsFor(r.model), q.need) : null;
    return {
      target: r.target, model: r.model, lane: r.lane, reason: r.reason, path: r.path, params: r.params, actions: r.actions.map((a) => a.name), ...(r.unlisted ? { unlisted: true } : {}), ...(small ? { unfit: `${r.model} ${small}` } : {}),
      ...(r.target === "peer" ? { peer: r.peer } : r.target === "local" ? { backend: pool.models.for(r.model).name } : {}),
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
      const from = draftOf(b);
      if (mayLeave(from, asked)) await peers.ensureFresh();
      const need = { tokens: typeof b.tokens === "number" ? b.tokens : 0, images: b.images === true, tools: b.tools === true };
      // Headers to try it with, as `{ name: value }`; anything that is not text is left out.
      const headers = Object.fromEntries(Object.entries(typeof b.headers === "object" && b.headers !== null ? b.headers as Record<string, unknown> : {})
        .flatMap(([k, v]) => (typeof v === "string" ? [[k.toLowerCase(), v]] : [])));
      const pretend = (typeof b.pretend === "object" && b.pretend !== null ? b.pretend : {}) as Record<string, unknown>;
      json(c.res, 200, decideNow(asked, from, { caller: typeof b.caller === "string" ? b.caller : "local", lane, need, headers, pretend }));
    } catch (e) {
      fail(c.res, e);
    }
  }

  /**
   * The recent routed requests decided again under a draft and under the rules in force, both against
   * the state now, with the requests whose destination differs grouped by where they went and would go.
   * Each keeps what was recorded of it: the name, caller, lane, tested headers, prompt size, images and tools.
   */
  async function routeFlowsReplay(c: Call): Promise<void> {
    try {
      const b = await readJson(c.req);
      if (b.flows === undefined) throw new Refusal(400, "flows is required: the draft to replay recent requests against");
      const draft = draftOf(b);
      const limit = Math.min(Math.max(1, typeof b.limit === "number" ? Math.floor(b.limit) : 500), REQUESTS_KEPT);
      // Newest first, one per id: a request that fell back has a record per attempt, and the first is the routing decision.
      const seen = new Set<string>();
      const firsts: RequestTrace[] = [];
      for (const r of requests.traces.all()) {
        if (r.router === undefined || (r.id !== "" && seen.has(r.id))) continue;
        seen.add(r.id);
        firsts.push(r);
      }
      const picked = firsts.reverse().slice(0, limit);
      if (picked.some((r) => mayLeave(cfg, r.asked) || mayLeave(draft, r.asked))) await peers.ensureFresh();
      const label = (d: { target: string; model: string; peer?: string; backend?: string }): string =>
        d.target === "peer" ? `peer ${d.peer}/${d.model}` : d.target === "local" ? `${d.model} on ${d.backend}` : "refused";
      const groups = new Map<string, { from: string; to: string; count: number; example: string; asked: string }>();
      let same = 0;
      for (const r of picked) {
        const q = { caller: r.caller, lane: r.lane ?? Object.keys(cfg.scheduler.lanes)[0]!, need: { tokens: r.tokensIn ?? 0, images: r.images === true, tools: r.tools === true }, headers: r.headers ?? {} };
        const from = label(decideNow(r.asked, worlds.rulesFor(r.caller), q));
        const to = label(decideNow(r.asked, worlds.rulesFor(r.caller, draft), q));
        if (from === to) { same++; continue; }
        const key = `${r.asked}\0${from}\0${to}`;
        const g = groups.get(key);
        if (g) g.count++;
        else groups.set(key, { from, to, count: 1, example: r.id, asked: r.asked });
      }
      const changed = [...groups.values()].sort((a, b) => b.count - a.count);
      json(c.res, 200, {
        considered: picked.length, same, changed,
        refusedNow: changed.filter((g) => g.to === "refused").reduce((n, g) => n + g.count, 0),
        note: "Both sides are decided against the state now (idle, free, queue, warm, held, step limits, time of day), not as it was when each request ran; a request keeps the lane it ran in, a conversation is decided as an opening turn, and images and tools are known only for chat requests.",
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
  const offHere = (model: string): boolean => pool.models.for(model).cfg.cloud;
  /** Where a decision sends a request, as a plugin sees it. */
  const where = (d: { target: "local" | "peer"; model: string; peer?: string }): Pick<HookRequest, "model" | "target" | "peer" | "backend" | "leaves"> =>
    d.target === "peer"
      ? { model: d.model, target: "peer", peer: d.peer ?? null, backend: null, leaves: true }
      : { model: d.model, target: "local", peer: null, backend: pool.models.for(d.model).name, leaves: offHere(d.model) };

  /**
   * One chat request from the routing decision to the answer. The fields are what routing has settled
   * so far: the decision, the model and lane it landed on, and the backend here that serves that model.
   * Anything that moves the request elsewhere goes through `land`, so they always agree.
   */
  class ChatTurn {
    private readonly startedAt = Date.now();
    private readonly world: World;
    private readonly flowsNow: HearthConfig["flows"];
    /** The conversation this turn belongs to, for a sticky flow; null for a request with no user turn. */
    private readonly talk: { key: string; later: boolean } | null;
    private decision!: Resolution;
    /** The decision it last landed on, a fallback's included, for its trace. */
    private last: Resolution | undefined;
    private model = "";
    private lane = "";
    private local!: BackendSlot;
    /** The request's size as it is queued, after the plugins that run once it is routed. */
    private need!: Need;
    /** Re-set as it is queued; set here too, so an action told how a refused request ended can read it. */
    private t: Timing = notRun();
    /** What the backend here answered, for the log and call history: a relayed 400 is a failure with a useful body. */
    private localStatus = 0;
    /** The backend here that last ran it, for an action told how it ended. */
    private ranOn = "";
    /** Actions already set off: each runs once per request, however many times it is re-routed. */
    private readonly fired = new Set<string>();
    /** Models whose own limits this request has been held to. */
    private readonly limited = new Set<string>();

    constructor(private readonly r: ChatRequest, private readonly ended: ((error: string | null) => void)[]) {
      const { payload, asked, lane, caller, headers } = r;
      // The flow reads each model on the backend that would serve it here: a node with an idle
      // embedder and a busy GPU has no single answer to "am I busy". What this request asks for goes
      // with it, so a peer whose model is too small is passed over rather than sent the prompt to refuse.
      this.talk = worlds.conversation(caller, asked, payload);
      const talk = this.talk;
      this.world = {
        ...worlds.worldFor(caller, lane, needsOf(payload, cfg.models[asked]?.videoTokens), worlds.rulesFor(caller), headers),
        // Only a later turn is held to where the conversation started; an opening turn is decided afresh.
        ...(talk?.later ? { pinned: (flow: string) => worlds.pinned(flow, talk.key) } : {}),
        // A plugin asked to keep this request on this machine: no peer, no cloud provider.
        ...(r.plugins?.stayLocal ? { keepHere: offHere } : {}),
      };
      this.flowsNow = this.world.cfg.flows;
    }

    /** Route it, run it where it lands, and return the status a backend here relayed, or 0 when a peer answered. */
    async run(): Promise<number> {
      // Refresh peer state only when a decision needs it, and only for requests that may leave.
      if (mayLeave(cfg, this.r.asked)) await peers.ensureFresh();
      this.decide();
      await this.afterRouted();
      this.admit();
      if (this.fromCache()) return 200;
      const d = this.decision;
      return d.target === "peer" ? this.runOnPeer(d) : this.runHere();
    }

    /** Ask the flow where this goes; a name it does not offer is a 404, which is not the same as one it will not run now. */
    private decide(): void {
      const { asked, lane, caller } = this.r;
      const decision = resolve(asked, this.world);
      const paths = this.flowsNow[decision.via[0] ?? ""]?.takes;
      const notHere = decision.unlisted ? decision.reason
        // Nor is one that takes paths of its own a chat model.
        : paths ? `"${asked}" is not offered as chat: it takes ${paths.join(", ")}` : null;
      if (notHere !== null) {
        requests.record(notRun(), { model: asked, lane, caller, target: "refused" }, false, notHere, this.traced());
        throw new Refusal(404, notHere);
      }
      this.decision = decision;
      this.land(decision);
      this.fire(decision);
    }

    /** Move the request onto what a decision chose: its model, lane and params, and the backend here that serves it. */
    private land(d: { model: string; lane: string; params: Record<string, unknown> }): void {
      const { payload, asked, res } = this.r;
      this.model = d.model;
      this.lane = d.lane;
      this.local = pool.models.for(d.model);
      Object.assign(payload, d.params);
      // Our id for it, so the backend is asked for what the flow chose and not what the client named.
      if (d.model !== asked) payload.model = d.model;
      // The caller can read off which model answered, since one name may run as several; a node may keep that to itself.
      if (cfg.modelHeader && !res.headersSent) res.setHeader("x-hearth-model", d.model);
    }

    /** Count a decision, remember it for a sticky flow, hold it against step limits, and set off its actions. */
    private fire(d: Resolution): void {
      const { asked, caller, res, id } = this.r;
      const { flowsNow, talk, world } = this;
      this.last = d;
      if (flowsNow === cfg.flows) worlds.countHits(d.path);
      // A sticky flow remembers where it put this conversation, for its later turns.
      const sticky = flowsNow[d.path.at(-1)?.flow ?? ""]?.sticky;
      if (talk && sticky !== undefined && d.target !== "unavailable") {
        worlds.place(d.path.at(-1)!.flow, talk.key, d.target === "peer" ? { peer: d.peer, model: d.model } : { model: d.model }, sticky);
      }
      // A step with a limit counts this request against it until the response closes.
      for (const p of d.path) {
        if (flowsNow[p.flow]?.steps[p.step]?.max !== undefined) worlds.occupy(p.flow, p.step, res);
      }
      for (const a of d.actions) {
        const action = cfg.actions[a.name];
        if (!action || this.fired.has(a.name)) continue;
        this.fired.add(a.name);
        const facts: ActionFacts = {
          action: a.name, node: cfg.name, asked, model: d.model, target: d.target, peer: d.target === "peer" ? d.peer : "",
          lane: d.lane, caller, tokens: world.need?.tokens ?? 0, images: world.need?.images ?? false, tools: world.need?.tools ?? false,
          flow: a.flow, line: a.step + 1, reason: d.reason, outcome: "decided", ms: 0, error: "",
          backend: d.target === "local" ? pool.models.for(d.model).name : "", id: id ?? "", queuedMs: 0, ranMs: 0,
        };
        if (action.on === "decided") worlds.act(a.name, action, facts);
        else this.ended.push((error) => {
          // One reading of the clock, so the time it ran is never more than the time it took.
          const now = Date.now();
          const ms = now - this.startedAt;
          if ((action.on === "failed" && error === null) || (action.slowerThan > 0 && ms <= action.slowerThan)) return;
          // Where it ended up, which a failed backend or peer may have changed since the step decided.
          const ran = this.t.startedAt > 0 ? now - this.t.startedAt : 0;
          worlds.act(a.name, action, { ...facts, model: this.model, backend: this.ranOn, outcome: error === null ? "ok" : "failed", ms, error: error ?? "", queuedMs: ms - ran, ranMs: ran });
        });
      }
    }

    /** What routing decided, for the request's trace; `from` is the model a failure moved it off. */
    private traced(from?: string): Traced {
      const d = this.last;
      return {
        asked: this.r.asked, router: worlds.routerNameOf(this.r.caller),
        ...(this.world.need?.images ? { images: true as const } : {}), ...(this.world.need?.tools ? { tools: true as const } : {}),
        ...(d ? { path: d.path, reason: d.reason, actions: d.actions.map((a) => a.name) } : {}),
        ...(this.r.plugins ? { plugins: this.r.plugins.active.map((p) => p.name) } : {}),
        ...(from !== undefined && from !== this.model ? { fallbackFrom: from } : {}),
      };
    }

    /** The plugins that run once a request is routed; one that changes it, or keeps it here, has it routed once more. */
    private async afterRouted(): Promise<void> {
      const p = this.r.plugins;
      if (!p || this.decision.target === "unavailable") return;
      const { payload, asked, caller } = this.r;
      p.hook = { ...p.hook, ...where(this.decision), lane: this.lane, body: payload };
      // The step that sent it to a model places its own plugins, after those that run on every line.
      const step = this.decision.path.at(-1);
      if (step) p.active = [...p.active, ...plugins.forLine("chat", this.flowsNow[step.flow]?.steps[step.step]?.plugins ?? [], { router: worlds.routerNameOf(caller), flow: step.flow, step: step.step })];
      let after;
      try {
        after = await plugins.run("routed", p.active, p.hook);
      } catch (e) {
        if (!(e instanceof PluginRefusal)) throw e;
        requests.record(notRun(), { model: this.model, lane: this.lane, caller, target: "refused", plugin: e.plugin }, false, e.message, this.traced());
        throw new Refusal(e.status, e.message);
      }
      const changed = after.req.body !== p.hook.body;
      p.hook = after.req;
      p.stayLocal ||= after.stayLocal;
      if (changed) {
        for (const k of Object.keys(payload)) delete payload[k];
        Object.assign(payload, after.req.body);
      }
      this.lane = after.req.lane;
      // Changed after routing: routed once more, so a bigger prompt or a request kept here lands where it fits.
      if (changed || (p.stayLocal && p.hook.leaves)) {
        const again = resolve(asked, { ...this.world, need: needsOf(payload, cfg.models[asked]?.videoTokens), ...(p.stayLocal ? { keepHere: offHere } : {}) });
        if (again.target === "unavailable" || again.target !== this.decision.target || again.model !== this.decision.model) {
          this.decision = again;
          this.land(again);
          this.fire(again);
          if (again.target !== "unavailable") p.hook = { ...p.hook, ...where(again) };
        }
      }
    }

    /** What must hold before it is queued: a model that is running, something here to serve it, and the caller's limits. */
    private admit(): void {
      const { payload, asked, lane: askedLane, caller, res, checkLimits } = this.r;
      const { decision, model, lane } = this;
      if (model !== asked) {
        refuseDegraded(model);
        log.debug("route.flow", { asked, via: decision.via, as: model, reason: decision.reason });
      } else if (decision.target === "local") {
        worlds.using(model, res);
      }
      this.need = needsOf(payload, cfg.models[model]?.videoTokens);
      this.t = firstByte(res, { enqueuedAt: Date.now(), startedAt: 0, meter: meter(res), need: Math.max(0, (this.need?.tokens ?? 0) - (this.need?.output ?? 0)) });
      if (decision.target === "unavailable") {
        // Refusing is the point: the flow's own words, with why a peer was passed over when one was.
        requests.record(this.t, { model, lane, caller, target: "unavailable" }, false, decision.reason, this.traced());
        throw new Refusal(503, `${asked} is not being run: ${decision.reason}`, "server_error");
      }
      // A flow that runs a name as itself still needs something here to serve it.
      const instead = decision.target === "local" ? limits.unknownHere(model) : null;
      if (instead !== null) {
        const why = `no backend here serves "${model}" (${instead})`;
        requests.record(notRun(), { model: asked, lane: askedLane, caller, target: "refused" }, false, why, this.traced());
        throw new Refusal(404, why);
      }
      checkLimits?.();
      this.limitModel(model);
    }

    /** A model's own limits, checked once for each model this request lands on. */
    private limitModel(m: string): void {
      if (this.limited.has(m)) return;
      this.limited.add(m);
      limits.withinModelLimits(this.r.caller, m);
    }

    /**
     * Answer from a model's kept answers when it keeps them and this exact request was answered; otherwise start
     * keeping this answer. A stream opened early to report queue position is neither kept nor answered from one.
     */
    private fromCache(): boolean {
      const { payload, res, onPosition, caller } = this.r;
      const keepMs = cfg.models[this.model]?.cacheMs ?? 0;
      if (keepMs <= 0 || onPosition !== undefined) return false;
      const key = answers.key(this.model, payload);
      const hit = answers.get(key);
      if (hit === null) {
        answers.keep(res, key, keepMs);
        return false;
      }
      res.writeHead(200, { "Content-Type": hit.type, "X-Hearth-Cache": "hit", "X-Accel-Buffering": "no", ...(res.hasHeader("x-hearth-model") ? { "x-hearth-model": String(res.getHeader("x-hearth-model")) } : {}) });
      res.end(hit.body);
      requests.record(this.t, { model: this.model, lane: this.lane, caller, target: "cache" }, true, undefined, this.traced());
      return true;
    }

    /** Send it to the backend here that serves the current model. */
    private async runLocal(spare = false): Promise<void> {
      const { payload, res, signal } = this.r;
      const local = this.local;
      this.ranOn = local.name;
      await local.state.ensureFresh();
      this.localStatus = await sendLocal(local.cfg, this.model, payload, res, { signal, ...backendDeadline(local.cfg), ...(local.cfg.cloud && this.t.meter ? { count: this.t.meter } : {}) }, spare);
    }

    /**
     * Run it here. A backend that fails before anything reaches the client is passed over like a peer that
     * is down: the flow is asked again without it, and the request runs where that lands, here.
     */
    private async runHere(): Promise<number> {
      const { payload, asked, caller, res, signal, onPosition, id } = this.r;
      const failed = new Set<string>();
      let why = this.decision.reason;
      const moveTo = (next: Resolution): void => {
        failed.add(this.model);
        this.land(next);
        this.fire(next);
        why = next.reason;
      };
      for (;;) {
        const { model, lane, local } = this;
        // A strict router's callers get the model its line names or its failure, so for them nothing is left to ask for.
        const spare = (): Resolution => (worlds.routerOf(caller)?.strict
          ? { ...this.decision, target: "unavailable" as const, reason: "its router never falls back" }
          : resolve(asked, { ...this.world, noPeers: true, skip: new Set([...failed, model]) }));
        // A backend that keeps failing is not made to fail once more for each request, while another line fits.
        if (local.state.restingMs() > 0 && !res.headersSent) {
          const next = spare();
          if (next.target === "local" && !failed.has(next.model) && next.model !== model) {
            log.debug("route.resting_trying_next", { asked, model, backend: local.name, next: next.model, restingMs: local.state.restingMs() });
            moveTo(next);
            continue;
          }
        }
        // Refused here only on reported limits, before queueing or evicting; the backend stays the authority.
        const fitted = fitOutput(pool.models.statsFor(model), needsOf(payload, cfg.models[model]?.videoTokens), payload);
        const tooMuch = unfit(pool.models.statsFor(model), fitted);
        if (tooMuch !== null) {
          requests.record(this.t, { model, lane, caller, backend: local.name, target: "local" }, false, tooMuch, this.traced([...failed][0]));
          throw new Refusal(400, `${model} ${tooMuch}`);
        }
        try {
          this.limitModel(model);
          const elsewhere = spare().target === "local";
          await local.scheduler.submit(
            // A second try goes back through admission without re-applying the caller cap.
            { lane, model, caller, ...limits.keyLimitOf(caller, model), ...(failed.size === 0 ? { maxPerCaller: limits.capOf(caller, model), onPosition, ...(id ? { id } : {}) } : {}), signal, tokens: pool.models.poolTokens(model, fitted) },
            async () => {
              this.t.startedAt = Date.now();
              await this.runLocal(elsewhere);
            },
          );
        } catch (e) {
          requests.record(this.t, { model, lane, caller, backend: local.name, target: "local", reason: why }, false, e, this.traced([...failed][0]));
          // Its own fault, not the caller's or a full queue's: counted towards resting it, and a reason to move on.
          const itsOwn = !signal.aborted && !(e instanceof QueueFullError) && (e instanceof BackendFailed || !(e instanceof Refusal));
          if (itsOwn) local.state.struck(cfg.backendRestMs);
          const next = itsOwn && !res.headersSent ? spare() : null;
          if (!next || next.target !== "local" || failed.has(next.model) || next.model === model) throw e;
          log.warn("route.local_failed_trying_next", { asked, model, next: next.model, error: e instanceof Error ? e.message : String(e) });
          moveTo(next);
          continue;
        }
        // An answer of its own making that says it cannot serve (overloaded, rate limited) counts as a failure too.
        const status = this.localStatus;
        if (status >= 500 || status === 429) local.state.struck(cfg.backendRestMs);
        else local.state.answered();
        requests.record(
          this.t,
          { model, lane, caller, backend: local.name, target: "local", reason: why, ...(status >= 400 ? { status } : {}) },
          status < 400,
          status >= 400 ? `backend answered ${status}` : undefined,
          this.traced([...failed][0]),
        );
        return status;
      }
    }

    /** Run it on the peer the flow chose; one that fails before the first byte is retried here. */
    private async runOnPeer(decision: Extract<Resolution, { target: "peer" }>): Promise<number> {
      const { payload, asked, caller, res, signal, id } = this.r;
      const peer = peers.config(decision.peer)!;
      let fellBack = false;
      log.debug("route.peer", { model: this.model, peer: decision.peer, reason: decision.reason });
      const logged = () => ({ model: this.model, lane: this.lane, caller, backend: this.local.name, target: fellBack ? "local" : "peer", peer: peer.name });
      try {
        await this.local.scheduler.submit(
          // No local slot: this runs on their hardware, not ours.
          { lane: this.lane, model: this.model, caller, maxPerCaller: limits.capOf(caller, this.model), offbox: true, ...(id ? { id } : {}), peer: decision.peer, signal },
          async () => {
            this.t.startedAt = Date.now();
            // The peer's id, with the route's params still applied.
            const body = pool.models.outboundBody(this.model, payload, decision.theirModel);
            const over = peers.sent(peer.name, decision.theirModel);
            try {
              const up = await send(`${peer.url}/v1/chat/completions`, {
                json: body,
                headers: { Authorization: `Bearer ${peer.token}` },
                signal,
                // A peer can accept the connection and never answer: this turns that into a fallback, not a hang. 0 disables it.
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
              const home = resolve(asked, { ...this.world, noPeers: true });
              if (home.target !== "local") throw e;
              this.land(home);
              this.fire(home);
              // Nothing reached the client yet, so they'll never see this.
              log.warn("route.peer_failed_retrying_local", { model: this.model, peer: peer.name, error: e instanceof Error ? e.message : String(e) });
              fellBack = true;
              // A local retry goes back through admission, without re-applying the caller cap.
              this.limitModel(this.model);
              await this.local.scheduler.submit({ lane: this.lane, model: this.model, caller, ...limits.keyLimitOf(caller, this.model), signal, tokens: pool.models.poolTokens(this.model, this.need) }, () => this.runLocal());
            }
          },
        );
      } catch (e) {
        // Logged as where it last ran, a local fallback included, with its backend so the call ring counts it.
        requests.record(this.t, logged(), false, e, this.traced(fellBack ? decision.model : undefined));
        throw e;
      }
      const status = this.localStatus;
      // Only the fallback can have relayed a bad status: a peer's own 4xx threw a PeerStatusError above.
      const bad = fellBack && status >= 400;
      requests.record(this.t, { ...logged(), offbox: !fellBack, ...(bad ? { status } : {}) }, !bad, bad ? `backend answered ${status}` : undefined, this.traced(fellBack ? decision.model : undefined));
      return fellBack ? status : 0;
    }
  }

  /** Route a chat request and run it; returns the status a backend here relayed, or 0 when a peer answered. */
  function route(r: ChatRequest, ended: ((error: string | null) => void)[]): Promise<number> {
    return new ChatTurn(r, ended).run();
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
      const why = unfit(pool.models.statsFor(model), fitOutput(pool.models.statsFor(model), needsOf(payload, cfg.models[model]?.videoTokens), payload));
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
          requests.record(notRun(), { model, lane, caller, target: "refused", plugin: e.plugin }, false, e.message, { router: hook.router, plugins: active.map((p) => p.name) });
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

    const t = firstByte(res, { enqueuedAt: Date.now(), startedAt: 0, meter: meter(res) });
    const serving = pool.models.for(model);
    // As on the local path: what we relayed to the borrower, so lent
    // capacity that failed is not filed as lent capacity that worked.
    let lentStatus = 0;
    try {
      await serving.scheduler.submit(
        // Peers are capped per backend, whether or not apiKeys are set.
        { lane, model, caller, ...limits.capFor(fromPeer, model), signal: ctrl.signal, tokens: pool.models.poolTokens(model, needsOf(payload, cfg.models[model]?.videoTokens)) },
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

  return { routeChat, routeMessages, routeFlowsTry, routeFlowsReplay };
}
