/**
 * One side of an adapter, run on a sample: what the map's panel tries before the operator changes
 * the adapter's file. The adapter is `trust: code` already, so this only calls the two functions a
 * line would call; hearth sends nothing anywhere for it, and no plugin is asked. Both sides are
 * held to the adapter plugin's own `timeoutMs`, as they are on a line.
 */
import { Refusal } from "../errors.js";
import { type AdapterAnswer, type AdapterRequest } from "../routing/adapters.js";
import { fail, json } from "../wire/http.js";
import type { Call, RouteContext } from "./context.js";

/** A body's text field, or null where it was left out; anything else is refused rather than guessed at. */
const said = (v: unknown, at: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Refusal(400, `${at} is text, or left out`);
  return v;
};

/** A sample request as the panel holds it: every field an adapter may see, with what a bare one looks like. */
function sampleRequest(v: unknown): AdapterRequest {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Refusal(400, "req is the sample request: {method, path, query, contentType, body}");
  const o = v as Record<string, unknown>;
  if (o.query !== undefined && (typeof o.query !== "object" || o.query === null || Array.isArray(o.query))) throw new Refusal(400, "req.query is a map of names to values");
  const query: Record<string, string> = {};
  for (const [k, x] of Object.entries((o.query ?? {}) as Record<string, unknown>)) {
    if (typeof x !== "string") throw new Refusal(400, `req.query.${k} is text`);
    query[k] = x;
  }
  return {
    method: said(o.method, "req.method") ?? "GET",
    path: said(o.path, "req.path") ?? "/",
    query,
    contentType: said(o.contentType, "req.contentType"),
    body: said(o.body, "req.body"),
  };
}

/** A sample answer for the side that reads one: the target's status, content type and body. */
function sampleAnswer(v: unknown): AdapterAnswer {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Refusal(400, "res is the sample answer: {status, contentType, body}");
  const o = v as Record<string, unknown>;
  const status = o.status ?? 200;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) throw new Refusal(400, "res.status is an HTTP status");
  return { status, contentType: said(o.contentType, "res.contentType"), body: said(o.body, "res.body") ?? "" };
}

export function adapterRoutes(ctx: RouteContext) {
  const { plugins, readJson } = ctx;

  /**
   * POST `{ adapter, side, req, res? }`: one side of the adapter plugin `adapter` names, run on the
   * sample and answered with what it returned. The body is held to `maxBodyBytes` like every other
   * console route; nothing here touches the last-call state the map draws, which is real traffic only.
   */
  async function routeAdapterTry(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      const name = typeof body.adapter === "string" ? body.adapter.trim() : "";
      if (name === "") throw new Refusal(400, "adapter is required: the plugin a line's `adapt:` names");
      if (body.side !== "request" && body.side !== "response") throw new Refusal(400, 'side is "request" or "response": which of the two to run');
      if (body.req === undefined) throw new Refusal(400, "req is required: the sample request the code is given");
      const req = sampleRequest(body.req);
      // The answer a response() reads is the target's own; the request side is not given one.
      const res = body.side === "response" ? sampleAnswer(body.res) : null;
      const problem = plugins.adapterProblem(name);
      if (problem !== null) {
        // A plugin that is not there, or cannot serve as an adapter, is not a bad form: say which it is.
        throw new Refusal(plugins.knows(name) ? 409 : 404, problem);
      }
      const adapter = plugins.adapterOf(name)!;
      const started = Date.now();
      try {
        const value = body.side === "request" ? await adapter.request(req) : await adapter.response(res!, req);
        json(c.res, 200, { ok: true, value, ms: Date.now() - started });
      } catch (e) {
        // The code's own words, or the deadline's: `timeoutMs` is what bounded it.
        json(c.res, 200, { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started });
      }
    } catch (e) {
      fail(c.res, e);
    }
  }

  return { routeAdapterTry };
}
