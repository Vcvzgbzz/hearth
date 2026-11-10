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
import { resolve } from "../routing/route.js";
import { send } from "../wire/upstream.js";
import type { Call, RouteContext } from "./context.js";

/**
 * How long a plugin's service has to accept the connection. A service on the network accepts in milliseconds;
 * one that is gone would otherwise hold the caller for as long as the OS keeps trying, before its fallback is asked.
 */
const PLUGIN_CONNECT_MS = 3_000;

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
    let name: string | null = null;
    let refused: string | null = null;
    for (const as of kind !== null ? [kind] : (["API", "MCP"] as const)) {
      const r = resolve(`${as}:${asked}`, world);
      if (r.plugin !== undefined && plugins.kindOf(r.plugin) !== null) { name = r.plugin; break; }
      if (r.plugin === undefined) refused ??= r.reason;
    }
    if (name === null) {
      if (refused !== null) log.info("plugin.refused", { plugin: asked, caller: c.caller, reason: refused });
      json(res, refused !== null ? 403 : 404, { error: refused ?? `no plugin named ${asked} serves an API here, and no rule gives that name to one` });
      return;
    }
    const path = m?.[2] ?? "/";
    // The plugin that answers if this one cannot: it serves the same API, so it is sent the same request.
    const fb = plugins.fallbackOf(name);
    const to = plugins.serve(name);
    if ("why" in to && fb === null) {
      json(res, to.status, { error: to.why });
      return;
    }
    const done = "why" in to ? () => {} : to.done;
    let body: Buffer | undefined;
    try {
      body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    } catch (e) {
      done(false);
      fail(res, e);
      return;
    }
    // An MCP server hearth runs answers at its own /mcp, whatever comes after the name.
    if ("stdio" in to) {
      const t0 = Date.now();
      const a = await to.stdio.handle(req.method ?? "GET", body);
      to.done(a.status < 500);
      res.writeHead(a.status, { "content-type": a.type, ...(a.session ? { "mcp-session-id": a.session } : {}) }).end(a.body);
      log.info("plugin.served", { plugin: name, method: req.method, path: m?.[2] ?? "/", status: a.status, caller: c.caller, ms: Date.now() - t0 });
      return;
    }
    const ctrl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
    const t0 = Date.now();
    const call = (target: { url: string; auth: Record<string, string> }, at: string, search: string) => {
      const headers = callers.headersFor(req) as Record<string, string>;
      delete headers["x-hearth-caller"];
      // The plugin's own key and headers replace a caller's of the same name.
      for (const h of Object.keys(headers)) if (h.toLowerCase() in target.auth) delete headers[h];
      Object.assign(headers, target.auth);
      headers["x-hearth-caller"] = c.caller;
      return send(`${target.url}${at}${search}`, {
        method: req.method ?? "GET",
        ...(body && body.length > 0 ? { raw: body } : {}),
        headers,
        signal: ctrl.signal,
        connectTimeoutMs: PLUGIN_CONNECT_MS,
        ...(cfg.backendFirstByteMs > 0 ? { headersTimeoutMs: cfg.backendFirstByteMs } : {}),
      });
    };
    const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
    // Why this plugin did not answer, when its fallback is asked instead.
    let failure: string;
    if ("why" in to) failure = to.why;
    else {
      try {
        const up = await call(to, path, url.search);
        if (fb !== null && (up.status >= 500 || up.status === 429)) {
          to.done(false);
          up.body.resume();
          failure = `it answered ${up.status}`;
        } else {
          to.done(up.status < 500);
          res.writeHead(up.status, forwardable(up.headers));
          await pipeline(up.body, res);
          log.info("plugin.served", { plugin: name, method: req.method, path, status: up.status, caller: c.caller, ms: Date.now() - t0 });
          return;
        }
      } catch (e) {
        to.done(false);
        // A caller that hung up mid-stream is the end of the exchange, not a failure of the service.
        if (ctrl.signal.aborted) return;
        log.warn("plugin.serve_failed", { plugin: name, path, error: said(e) });
        // Once an answer has begun there is no taking it back, so only a plugin that never answered falls back.
        if (res.headersSent) { res.destroy(); return; }
        if (fb === null) { json(res, 502, { error: `plugin ${name} could not be reached: ${said(e)}` }); return; }
        failure = said(e);
      }
    }
    // The caller's router is asked about the fallback as about any plugin: one it would not send this caller to
    // does not answer in its place, so a fallback is never a way past a refusal.
    const fbKind = plugins.kindOf(fb!.plugin);
    const open = fbKind !== null && resolve(`${fbKind}:${fb!.plugin}`, { ...world, plugin: fb!.plugin }).plugin === fb!.plugin;
    if (!open) {
      log.info("plugin.fallback_refused", { plugin: name, to: fb!.plugin, why: failure, caller: c.caller });
      json(res, 502, { error: `plugin ${name} could not answer (${failure}), and its fallback ${fb!.plugin} is not open to this caller` });
      return;
    }
    // A fallback is one hop: it answers with its own API, and its own fallback is not followed.
    const alt = plugins.serve(fb!.plugin);
    log.info("plugin.fallback", { plugin: name, to: fb!.plugin, why: failure, caller: c.caller });
    if ("why" in alt || "stdio" in alt) {
      if ("done" in alt) alt.done(false);
      json(res, 502, { error: `plugin ${name} could not answer (${failure}), and neither could its fallback ${fb!.plugin}${"why" in alt ? `: ${alt.why}` : ""}` });
      return;
    }
    try {
      const up = await call(alt, path, url.search);
      alt.done(up.status < 500);
      res.writeHead(up.status, forwardable(up.headers));
      await pipeline(up.body, res);
      log.info("plugin.served", { plugin: fb!.plugin, for: name, method: req.method, path, status: up.status, caller: c.caller, ms: Date.now() - t0 });
    } catch (e) {
      alt.done(false);
      if (ctrl.signal.aborted) return;
      log.warn("plugin.serve_failed", { plugin: fb!.plugin, for: name, path, error: said(e) });
      if (!res.headersSent) json(res, 502, { error: `plugin ${name} could not answer (${failure}), and its fallback ${fb!.plugin} failed: ${said(e)}` });
      else res.destroy();
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
