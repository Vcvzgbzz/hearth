/**
 * The plugin routes: each plugin's state and the pause switch, the API a plugin `serves` at
 * `/plugins/<name>/*`, and probing a plugin service's manifest before it is added.
 */
import { pipeline } from "node:stream/promises";

import { Refusal } from "../admit.js";
import { ConfigError, resolveSecret } from "../config.js";
import { fail, forwardable, json } from "../http.js";
import { Plugins } from "../plugins.js";
import { send } from "../upstream.js";
import type { Call, RouteContext } from "./context.js";

export function pluginRoutes(ctx: RouteContext) {
  const { cfg, log, plugins, callers, readJson, readBody } = ctx;

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
    const to = plugins.serve(m?.[1] ?? "");
    if ("why" in to) {
      json(res, to.status, { error: to.why });
      return;
    }
    let body: Buffer | undefined;
    try {
      body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    } catch (e) {
      to.done(false);
      fail(res, e);
      return;
    }
    const headers = callers.headersFor(req) as Record<string, string>;
    delete headers["x-hearth-caller"];
    if (to.key) headers.authorization = `Bearer ${to.key}`;
    headers["x-hearth-caller"] = c.caller;
    const ctrl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });
    const t0 = Date.now();
    try {
      const up = await send(`${to.url}${m?.[2] ?? "/"}${url.search}`, {
        method: req.method ?? "GET",
        ...(body && body.length > 0 ? { raw: body } : {}),
        headers,
        signal: ctrl.signal,
        ...(cfg.backendFirstByteMs > 0 ? { headersTimeoutMs: cfg.backendFirstByteMs } : {}),
      });
      to.done(up.status < 500);
      res.writeHead(up.status, forwardable(up.headers));
      await pipeline(up.body, res);
      log.info("plugin.served", { plugin: m![1], method: req.method, path: m?.[2] ?? "/", status: up.status, caller: c.caller, ms: Date.now() - t0 });
    } catch (e) {
      to.done(false);
      // A caller that hung up mid-stream is the end of the exchange, not a failure of the service.
      if (ctrl.signal.aborted) return;
      log.warn("plugin.serve_failed", { plugin: m![1], path: m?.[2] ?? "/", error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) json(res, 502, { error: `plugin ${m![1]} could not be reached: ${e instanceof Error ? e.message : String(e)}` });
      else res.destroy();
    }
  }

  /** POST `{url, key?}`: what a plugin service declares at its /manifest, before it is added. */
  async function routePluginProbe(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      if (typeof body.url !== "string" || !/^https?:\/\/[^/]/.test(body.url.trim())) throw new Refusal(400, "url is an http(s) URL");
      const key = typeof body.key === "string" && body.key.trim() !== "" ? resolveSecret(body.key.trim(), "key") : null;
      const url = body.url.trim();
      try {
        json(c.res, 200, { ok: true, url, ...(await Plugins.manifest(url, key)) });
      } catch (e) {
        json(c.res, 200, { ok: false, url, problem: e instanceof Error ? e.message : String(e) });
      }
    } catch (e) {
      fail(c.res, e instanceof ConfigError ? new Refusal(400, e.message) : e);
    }
  }

  return { routePlugins, routePluginServes, routePluginProbe };
}
