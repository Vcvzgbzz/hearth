/**
 * The plugin routes: each plugin's state and the pause switch, the API a plugin `serves` at
 * `/plugins/<name>/*`, and probing a plugin service's manifest before it is added.
 */
import { pipeline } from "node:stream/promises";

import { Refusal } from "../errors.js";
import { pluginAuth } from "../config/plugins.js";
import { ConfigError, resolveSecret } from "../config/read.js";
import { fail, forwardable, headersOf, json } from "../wire/http.js";
import { checkHttp } from "../plugins/mcp.js";
import { Plugins } from "../plugins/plugins.js";
import type { AdapterAnswer, AdapterRequest } from "../routing/adapters.js";
import { resolve } from "../routing/route.js";
import { send } from "../wire/upstream.js";
import type { Call, RouteContext } from "./context.js";

/**
 * How long a plugin's service has to accept the connection. A service on the network accepts in milliseconds;
 * one that is gone would otherwise hold the caller for as long as the OS keeps trying, before its fallback is asked.
 */
const PLUGIN_CONNECT_MS = 3_000;

/** Media types whose body an adapter may see as text; anything else is bytes, and is left as it was. */
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-www-form-urlencoded)|[^/;]+\/[^;]*\+(json|xml))/i;

/** Is this a body an adapter can be given as UTF-8? A request with no content type is read as text. */
function isText(contentType: string | null): boolean {
  if (contentType === null) return true;
  return TEXT_TYPES.test(contentType.split(";")[0]!.trim());
}

export function pluginRoutes(ctx: RouteContext) {
  const { cfg, log, plugins, callers, worlds, readJson, readBody } = ctx;

  /** GET: every plugin's state and numbers. POST `{name, paused}`: pause or resume one until the next restart. */
  async function routePlugins(c: Call): Promise<void> {
    if (c.req.method === "GET") {
      json(c.res, 200, { plugins: plugins.status() });
      return;
    }
    try {
      const body = await readJson(c.req);
      if (typeof body.name !== "string" || typeof body.paused !== "boolean") throw new Refusal(400, "send {name, paused: true|false}");
      const problem = plugins.pause(body.name, body.paused);
      if (problem) throw new Refusal(409, problem);
      json(c.res, 200, { plugins: plugins.status() });
    } catch (e) {
      fail(c.res, e);
    }
  }

  /**
   * `/plugins/<name>/*`: the API a plugin `serves`, forwarded both ways as it streams. Only the first byte has a
   * deadline (`backendDefaults.firstByteMs`): once an answer starts, a service may hold the stream open (an MCP
   * session, server-sent events). The caller's key for this node is not passed on; the plugin's own `key` is, and
   * the service is told who is calling in `x-hearth-caller`.
   *
   * The caller's router decides one line at a time: a line whose plugin cannot answer — or whose adapter says the
   * request has no counterpart there — hands the request to the next line that matches, as a chat request does,
   * unless the caller's router is strict. Each line's own `fallback` is still one hop, with the same request.
   */
  async function routePluginServes(c: Call): Promise<void> {
    const { req, res, url } = c;
    const m = /^\/plugins\/([^/]+)(\/.*)?$/.exec(c.path);
    // The caller's router decides, as it does for a model: the request is asked of it as MCP:<name> or API:<name>.
    // With no rule for MCP or API, its flow for every other name decides: one that runs a name as itself lets
    // plugins through, and one that refuses refuses them until a rule for MCP or API is added. A name that is no
    // plugin's may be a router's own name for one, so it is asked as either type, and the plugin a step names answers.
    const asked = m?.[1] ?? "";
    const kind = plugins.kindOf(asked);
    const world = { ...worlds.worldFor(c.caller, Object.keys(cfg.scheduler.lanes)[0]!, undefined, worlds.rulesFor(c.caller), headersOf(req)), plugin: asked };
    const path = m?.[2] ?? "/";
    const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
    let body: Buffer | undefined;
    try {
      body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    } catch (e) {
      fail(res, e);
      return;
    }
    // The request as the caller sent it: what an adapter's request() sees, and what its response() is given back.
    const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null;
    const original: AdapterRequest = {
      method: req.method ?? "GET",
      path,
      query: Object.fromEntries(url.searchParams),
      contentType,
      body: body === undefined || body.length === 0 || !isText(contentType) ? null : body.toString("utf8"),
    };
    const ctrl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
    const kinds = kind !== null ? [kind] : (["API", "MCP"] as const);
    // A strict router's callers get the plugin their line names or its failure: no next line for them.
    const strict = worlds.routerOf(c.caller)?.strict === true;
    /** Would the router pick another plugin line for this request, leaving these plugins out? */
    const hasNext = (skip: ReadonlySet<string>): boolean => kinds.some((as) => {
      const r = resolve(`${as}:${asked}`, { ...world, skip });
      return r.plugin !== undefined && plugins.kindOf(r.plugin) !== null;
    });

    /** Sends one request to the plugin's service, with its own credentials and the caller's headers. */
    const call = (target: { url: string; auth: Record<string, string> }, method: string, at: string, search: string, raw: Buffer | undefined, plain: boolean, type: string | null) => {
      const headers = callers.headersFor(req) as Record<string, string>;
      delete headers["x-hearth-caller"];
      // An answer the adapter reads is asked for uncompressed, so it can be read.
      if (plain) delete headers["accept-encoding"];
      for (const h of Object.keys(headers)) if (h.toLowerCase() in target.auth) delete headers[h];
      Object.assign(headers, target.auth);
      // What the target is told it is being sent, when the adapter changed it.
      if (type !== original.contentType) {
        if (type === null) delete headers["content-type"];
        else headers["content-type"] = type;
      }
      headers["x-hearth-caller"] = c.caller;
      return send(`${target.url}${at}${search}`, {
        method,
        ...(raw && raw.length > 0 ? { raw } : {}),
        headers,
        signal: ctrl.signal,
        connectTimeoutMs: PLUGIN_CONNECT_MS,
        ...(cfg.backendFirstByteMs > 0 ? { headersTimeoutMs: cfg.backendFirstByteMs } : {}),
      });
    };

    /** What became of one line: it answered, it failed (go on to the next), or the caller is owed this answer instead. */
    type Line =
      | { answered: true }
      | { failed: string }
      | { answer: number; error: string };

    /**
     * One line: the plugin it names, with the adapter in front of it when it has one. Falls back to the plugin's
     * own `fallback` — one hop, with the request as it stands — before the line counts as failed.
     */
    async function serveLine(name: string, adaptName: string | undefined): Promise<Line> {
      /** What one attempt at a target is sent. */
      type Outgoing = { method: string; path: string; search: string; body: Buffer | undefined; type: string | null };
      const t0 = Date.now();
      // An adapter is a trust: code plugin a line names: it runs where that line sends the request.
      const adapter = adaptName === undefined ? null : plugins.adapterOf(adaptName);
      if (adaptName !== undefined && adapter === null) {
        log.warn("flow.adapter_missing", { adapter: adaptName, plugin: name, caller: c.caller });
        return { failed: `adapter ${adaptName} is not running` };
      }

      /** Is there nothing left that could take this request? Then the line's own failure is the caller's answer. */
      const nothingElse = (): boolean => plugins.fallbackOf(name) === null && (strict || !hasNext(new Set([...tried, name])));

      /** The plugin's own fallback, one hop, sent the request as it stands; or why the line failed. */
      async function fallback(why: string, went: Outgoing): Promise<Line> {
        const fb = plugins.fallbackOf(name);
        if (fb === null) return { failed: why };
        // The caller's router is asked about the fallback as about any plugin: one it would not send this caller to
        // does not answer in its place, so a fallback is never a way past a refusal.
        const fbKind = plugins.kindOf(fb.plugin);
        const open = fbKind !== null && resolve(`${fbKind}:${fb.plugin}`, { ...world, plugin: fb.plugin }).plugin === fb.plugin;
        if (!open) {
          log.info("plugin.fallback_refused", { plugin: name, to: fb.plugin, why, caller: c.caller });
          return { failed: `${why}, and its fallback ${fb.plugin} is not open to this caller` };
        }
        const alt = plugins.serve(fb.plugin, c.caller);
        if ("why" in alt || "stdio" in alt) {
          if ("done" in alt) alt.done(false);
          return { failed: `${why}, and neither could its fallback ${fb.plugin}${"why" in alt ? `: ${alt.why}` : ""}` };
        }
        log.info("plugin.fallback", { plugin: name, to: fb.plugin, why, caller: c.caller });
        try {
          const up = await call(alt, went.method, went.path, went.search, went.body, false, went.type);
          alt.done(up.status < 500);
          res.writeHead(up.status, forwardable(up.headers));
          await pipeline(up.body, res);
          log.info("plugin.served", { plugin: fb.plugin, for: name, method: went.method, path: went.path, status: up.status, caller: c.caller, ms: Date.now() - t0 });
          return { answered: true };
        } catch (e) {
          alt.done(false);
          if (ctrl.signal.aborted) return { answered: true };
          log.warn("plugin.serve_failed", { plugin: fb.plugin, for: name, path: went.path, error: said(e) });
          if (!res.headersSent) return { failed: `${why}, and its fallback ${fb.plugin} failed: ${said(e)}` };
          res.destroy();
          return { answered: true };
        }
      }

      // The target first: a plugin that cannot answer at all is the line failing, and its adapter is never run.
      const to = plugins.serve(name, c.caller);
      // With nowhere else to go, the plugin's own status and words are the answer: paused is 503, unknown 404.
      if ("why" in to) return nothingElse() ? { answer: to.status, error: to.why } : fallback(to.why, { method: original.method, path, search: url.search, body, type: contentType });
      const done = to.done;

      // The request the target is sent, as the line's adapter made it: unchanged without one.
      let method = original.method;
      let at = path;
      // The query as it arrived, byte for byte, unless the adapter rewrites it.
      let search = url.search;
      let sent = body;
      let type = contentType;
      if (adapter !== null) {
        let carried: Partial<AdapterRequest> | null;
        try {
          carried = await adapter.request(original);
        } catch (e) {
          plugins.adapterCalled(adapter.name, { side: "request", ok: false, error: said(e), plugin: name });
          done(false);
          log.warn("flow.adapter_failed", { adapter: adapter.name, side: "request", plugin: name, caller: c.caller, error: said(e) });
          return { failed: `adapter ${adapter.name} could not carry the request over: ${said(e)}` };
        }
        // `null` is an answer too: this line has no counterpart for it, which is the next line's turn.
        plugins.adapterCalled(adapter.name, { side: "request", ok: true, plugin: name });
        // No counterpart on the target's API: this line cannot serve the request, so the next one is asked.
        if (carried === null) {
          done(false);
          return { failed: `adapter ${adapter.name} has no counterpart for it on ${name}'s API` };
        }
        method = carried.method ?? method;
        at = carried.path ?? at;
        if (carried.query !== undefined) {
          const qs = new URLSearchParams(carried.query).toString();
          search = qs === "" ? "" : `?${qs}`;
        }
        if (carried.body !== undefined) sent = carried.body === null ? undefined : Buffer.from(carried.body, "utf8");
        if (carried.contentType !== undefined) type = carried.contentType;
      }

      /** The target's 2xx answer through the line's adapter; a 502 naming it when the code cannot read the answer. */
      async function adaptAnswer(answer: AdapterAnswer, from: Record<string, string | string[]> = {}): Promise<Line> {
        let read: Partial<AdapterAnswer>;
        try {
          read = await adapter!.response(answer, original);
          plugins.adapterCalled(adapter!.name, { side: "response", ok: true, plugin: name });
        } catch (e) {
          plugins.adapterCalled(adapter!.name, { side: "response", ok: false, error: said(e), plugin: name });
          log.warn("flow.adapter_failed", { adapter: adapter!.name, side: "response", plugin: name, status: answer.status, caller: c.caller, error: said(e) });
          return { answer: 502, error: `adapter ${adapter!.name} could not read ${name}'s answer: ${said(e)}` };
        }
        // The answer is the adapter's now: what described the target's bytes no longer does.
        const headers: Record<string, string | string[]> = { ...from };
        for (const h of Object.keys(headers)) if (["content-length", "content-encoding", "etag"].includes(h.toLowerCase())) delete headers[h];
        const kind = read.contentType === undefined ? answer.contentType : read.contentType;
        if (kind === null) delete headers["content-type"];
        else headers["content-type"] = kind;
        const out = read.body ?? answer.body;
        headers["content-length"] = String(Buffer.byteLength(out));
        res.writeHead(read.status ?? answer.status, headers).end(out);
        log.info("plugin.served", { plugin: name, method, path: at, status: read.status ?? answer.status, adapt: adapter!.name, caller: c.caller, ms: Date.now() - t0 });
        return { answered: true };
      }

      // An MCP server hearth runs answers at its own /mcp, whatever comes after the name.
      if ("stdio" in to) {
        try {
          const a = await to.stdio.handle(method, sent);
          done(a.status < 500);
          if (adapter !== null && a.status >= 200 && a.status < 300) {
            return await adaptAnswer({ status: a.status, contentType: a.type, body: a.body });
          }
          res.writeHead(a.status, { "content-type": a.type, ...(a.session ? { "mcp-session-id": a.session } : {}) }).end(a.body);
          log.info("plugin.served", { plugin: name, method, path: at, status: a.status, caller: c.caller, ms: Date.now() - t0 });
          return { answered: true };
        } catch (e) {
          done(false);
          if (ctrl.signal.aborted) return { answered: true };
          log.warn("plugin.serve_failed", { plugin: name, path: at, error: said(e) });
          if (nothingElse()) return { answer: 502, error: `plugin ${name} could not be reached: ${said(e)}` };
          return fallback(said(e), { method, path: at, search, body: sent, type });
        }
      }
      try {
        const up = await call(to, method, at, search, sent, adapter !== null, type);
        // An overloaded or failing target is a failed line, and the next one is asked — unless there is none,
        // and no fallback either: then the target's own answer is the caller's, as it always was.
        if (up.status >= 500 || up.status === 429) {
          done(false);
          if (nothingElse()) {
            res.writeHead(up.status, forwardable(up.headers));
            await pipeline(up.body, res);
            log.info("plugin.served", { plugin: name, method, path: at, status: up.status, caller: c.caller, ms: Date.now() - t0 });
            return { answered: true };
          }
          up.body.resume();
          return fallback(`it answered ${up.status}`, { method, path: at, search, body: sent, type });
        }
        // A non-2xx is the target's answer to give: it is never given to the adapter.
        if (adapter === null || up.status < 200 || up.status >= 300) {
          done(up.status < 500);
          res.writeHead(up.status, forwardable(up.headers));
          await pipeline(up.body, res);
          log.info("plugin.served", { plugin: name, method, path: at, status: up.status, caller: c.caller, ms: Date.now() - t0 });
          return { answered: true };
        }
        done(true);
        const contentTypeOf = up.headers["content-type"];
        return await adaptAnswer(
          { status: up.status, contentType: typeof contentTypeOf === "string" ? contentTypeOf : null, body: await up.text(cfg.maxBodyBytes) },
          forwardable(up.headers),
        );
      } catch (e) {
        done(false);
        // A caller that hung up mid-stream is the end of the exchange, not a failure of the service.
        if (ctrl.signal.aborted) return { answered: true };
        log.warn("plugin.serve_failed", { plugin: name, path: at, error: said(e) });
        // Once an answer has begun there is no taking it back, so only a plugin that never answered falls back.
        if (res.headersSent) { res.destroy(); return { answered: true }; }
        if (nothingElse()) return { answer: 502, error: `plugin ${name} could not be reached: ${said(e)}` };
        return fallback(said(e), { method, path: at, search, body: sent, type });
      }
    }

    // Each attempt is the router's decision on the plugins that have not failed this request yet: the next line
    // that names one is where a failed line sends it.
    const tried = new Set<string>();
    let failure: string | null = null;
    for (;;) {
      let name: string | null = null;
      let adapt: string | undefined;
      let refused: string | null = null;
      for (const as of kinds) {
        const r = resolve(`${as}:${asked}`, { ...world, skip: tried });
        if (r.plugin !== undefined && plugins.kindOf(r.plugin) !== null) { name = r.plugin; adapt = r.adapt; break; }
        if (r.plugin === undefined) refused ??= r.reason;
      }
      if (name === null) {
        // Nothing is left to try: a line that failed is worth more than what the router says about a name it cannot place.
        if (failure !== null) {
          log.warn("plugin.failed", { plugin: asked, tried: [...tried], error: failure, caller: c.caller });
          json(res, 502, { error: `plugin ${asked} could not answer: ${failure}` });
          return;
        }
        if (refused !== null) log.info("plugin.refused", { plugin: asked, caller: c.caller, reason: refused });
        json(res, refused !== null ? 403 : 404, { error: refused ?? `no plugin named ${asked} serves an API here, and no rule gives that name to one` });
        return;
      }
      const line = await serveLine(name, adapt);
      if ("answered" in line) return;
      if ("answer" in line) {
        json(res, line.answer, { error: line.error });
        return;
      }
      tried.add(name);
      failure = line.failed;
      if (strict) {
        log.warn("plugin.failed", { plugin: name, error: failure, caller: c.caller, strict: true });
        json(res, 502, { error: `plugin ${name} could not answer: ${failure}` });
        return;
      }
    }
  }

  /**
   * POST `{url, key?, headers?}`: what a plugin service declares at its /manifest, before it is added. With `mcp` (a path
   * under `url`), whether an MCP server answers there instead: its name and how many tools it has.
   */
  async function routePluginProbe(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      if (typeof body.url !== "string" || !/^https?:\/\/[^/]/.test(body.url.trim())) throw new Refusal(400, "url is an http(s) URL");
      const key = typeof body.key === "string" && body.key.trim() !== "" ? resolveSecret(body.key.trim(), "key") : null;
      if (body.headers !== undefined && (typeof body.headers !== "object" || body.headers === null || Array.isArray(body.headers) || Object.values(body.headers).some((v) => typeof v !== "string"))) {
        throw new Refusal(400, "headers is a map of header names to values");
      }
      const headers = Object.fromEntries(Object.entries((body.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, resolveSecret(v.trim(), `headers.${k}`)]));
      const auth = pluginAuth({ key, headers });
      const url = body.url.trim();
      if (typeof body.mcp === "string") {
        if (!body.mcp.startsWith("/")) throw new Refusal(400, "mcp is a path, like /mcp");
        const s = await checkHttp(url.replace(/\/$/, "") + body.mcp, auth, 10_000);
        json(c.res, 200, s.error ? { ok: false, url, problem: s.error } : { ok: true, url, server: s.server, tools: s.tools });
        return;
      }
      try {
        json(c.res, 200, { ok: true, url, ...(await Plugins.manifest(url, auth)) });
      } catch (e) {
        json(c.res, 200, { ok: false, url, problem: e instanceof Error ? e.message : String(e) });
      }
    } catch (e) {
      fail(c.res, e instanceof ConfigError ? new Refusal(400, e.message) : e);
    }
  }

  return { routePlugins, routePluginServes, routePluginProbe };
}
