/**
 * Everything the route table does not claim, proxied to a backend as it came: `/v1/embeddings`,
 * llama-swap's own paths, and paths a backend declares under `routes`, which queue like chat.
 */
import { inScope } from "../access/admit.js";
import { QueueFullError, Refusal } from "../errors.js";
import { backendAuth } from "../config/backends.js";
import { KEY_REFUSED, fail, headersOf, jobId, pipeThrough, refusedKey } from "../wire/http.js";
import { multipartField, replaceMultipartField } from "../wire/multipart.js";
import type { BackendSlot } from "../queue/pool.js";
import { type Timing, notRun } from "../observe/requestlog.js";
import { type World, resolve } from "../routing/route.js";
import { send } from "../wire/upstream.js";
import type { Call, RouteContext } from "./context.js";

export function passthroughRoutes(ctx: RouteContext) {
  const { cfg, log, pool, canary, callers, limits, worlds, requests, readBody, degraded, backendDeadline } = ctx;

  /** The text-completion paths a relayed answer is worth watching on, with or without an `/upstream/<model>` prefix. */
  const COMPLETION_PATH = /^\/(?:v1\/(?:completions|chat\/completions|responses)|completion)$/;

  /** A passthrough path with llama-swap's `/upstream/<model>` prefix removed. */
  function stripUpstream(path: string): string {
    return path.replace(/^\/upstream\/[^/]+/, "");
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

  async function routeEmbeddings(c: Call): Promise<void> {
    if (c.models !== null) {
      try {
        c.body = await readBody(c.req);
      } catch (e) {
        fail(c.res, e);
        return;
      }
      let model = "";
      try {
        const parsed = JSON.parse(c.body.toString()) as { model?: unknown };
        if (typeof parsed.model === "string") model = parsed.model;
      } catch {
        // Unreadable: refused below as naming no model.
      }
      if (model === "" || !inScope(c.models, model, (n: string) => limits.isType(n))) {
        fail(c.res, new Refusal(403, model === "" ? "this key needs a request that names a model" : `this key may not run "${model}"`, "permission_error"));
        return;
      }
    }
    return routePassthrough(c);
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
      body = c.body ?? (req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req));
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
    let routed = pool.models.forPath(pathname);
    const held = pool.models.named(pathname);
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
      if (model === routed.rule.model || pool.models.owns(routed.slot, model)) return routed.slot;
      const fb = routed.rule.fallback ? pool.get(routed.rule.fallback.backend) : undefined;
      if (fb && pool.models.owns(fb, model)) return fb;
      return pool.all().find((b) => pool.models.owns(b, model) && (b.cfg.routes.length === 0 || b.cfg.routes.some((x) => x.path === pathname)));
    };
    if (c.peer === null && (held !== undefined || routed?.rule.queue === true)) {
      const rules = worlds.rulesFor(who).flows;
      const taker = Object.values(rules).find((f) => !f.off && f.takes?.includes(held?.path ?? pathname));
      const name = held?.name ?? viaBody ?? taker?.inputs[0] ?? routed!.rule.model;
      const world: World = { ...worlds.worldFor(who, routed?.rule.lane ?? Object.keys(cfg.scheduler.lanes)[0]!, undefined, worlds.rulesFor(who), headersOf(req)), path: held?.path ?? pathname };
      const r = resolve(name, world);
      const refuse = (status: number, why: string) => fail(res, new Refusal(status, why, status === 404 ? "invalid_request_error" : "server_error"));
      if (r.unlisted) return refuse(404, r.reason);
      // A type that says which paths it takes is not offered on any other.
      const takes = rules[r.via[0] ?? ""]?.takes;
      if (takes && !takes.includes(held?.path ?? pathname)) return refuse(404, `"${name}" is not offered on ${held?.path ?? pathname}: it takes ${takes.join(", ")}`);
      if (r.target === "unavailable") return refuse(503, `${name} is not being run: ${r.reason}`);
      if (r.target === "peer") return refuse(503, `${name} is not being run: its flow sends it to a peer, and only chat goes to a peer`);
      worlds.settle(r, name, who);
      if (r.model !== name) {
        if (held) {
          pathname = held.as(r.model);
          path = pathname;
          routed = pool.models.forPath(pathname);
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
      if (r.path.length > 0) {
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
    const sick = asked === undefined ? null : degraded(asked);
    if (sick) {
      fail(res, sick);
      return;
    }
    const named = routed ? undefined : asked;
    const target = routed ? routed.slot : named ? pool.models.for(named) : pool.first();
    if (named && !pool.single) {
      log.debug("passthrough.resolved", { path, model: named, backend: target.name });
    }

    // The one exception to verbatim forwarding: an aliased `model` field (or /upstream path segment)
    // is rewritten, or the backend 404s the advertised id.
    let outBody = body;
    let outPath = path;
    if (asked) {
      const wire = pool.models.outboundId(asked);
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
        // A backend with a key of its own is sent that, whatever the client carried.
        headers: { ...callers.headersFor(req), ...backendAuth(to.cfg.format, to.cfg.key, to.cfg.headers) } as Record<string, string>,
        signal: ctrl.signal,
        ...backendDeadline(to.cfg),
      });
      log.debug("passthrough", { path, status: up.status });
      if (to.cfg.key && refusedKey(up.status)) {
        up.body.resume();
        throw new Refusal(502, KEY_REFUSED, "server_error");
      }
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
        limits.withinLimits(who);
        const { lane } = routed.rule;
        // Two models can share one routed path; each queues as itself.
        const model = pool.models.routedModel(routed.slot, routed.rule, asked);
        // Queued on the backend that runs it, and recorded in history like any local use.
        const run = async (to: BackendSlot, as: string, sendBody: Buffer | undefined, orFail: boolean): Promise<void> => {
          const t: Timing = notRun();
          try {
            await to.scheduler.submit(
              { lane, model: as, caller: who, ...limits.keyLimitOf(who, as), maxPerCaller: limits.capOf(who, as), signal: ctrl.signal, ...(jobId(req) ? { id: jobId(req)! } : {}) },
              async () => {
                t.startedAt = Date.now();
                await proxy(to, sendBody, orFail);
              },
            );
          } catch (e) {
            requests.record(t, { model: as, lane, caller: who, backend: to.name, target: "local", path }, false, e);
            throw e;
          }
          requests.record(t, { model: as, lane, caller: who, backend: to.name, target: "local", path }, true);
        };
        // A strict router's callers get the model its line names or its failure: no next line, no route fallback.
        const strict = worlds.routerOf(who)?.strict === true;
        const fb = strict ? undefined : routed.rule.fallback;
        const spare = fb ? pool.get(fb.backend) : undefined;
        // A line that names a model on another backend runs there; a name only the fallback serves is a choice, not a failure.
        let to = runOn ?? (spare && asked !== undefined && asked !== model && pool.models.owns(spare, asked) ? spare : target);
        let as = to === target ? model : picked ?? asked ?? model;
        let sendBody = outBody;
        const failed: string[] = [];
        let fellBack = to === spare;
        const renamed = (m: string): Buffer | undefined => {
          // A form names its model in a field, which is rewritten as a JSON body's is.
          const wire = pool.models.outboundId(m);
          return isForm && body ? replaceMultipartField(body, contentType, "model", wire) ?? body : withModel(body, wire);
        };
        for (;;) {
          // What is left if this fails before anything reaches the client: the flow's next line that ends at a
          // model this path can run, as a chat flow's would, and after the last of those the route's own fallback.
          const next = !strict && again ? again([...failed, as]) : null;
          const usable = next && next.target === "local" && next.model !== as && !failed.includes(next.model);
          // A path with the model in it runs the next line at that path for its model.
          const line = !usable ? undefined : held ? pool.models.forPath(held.as(next.model))?.slot : placeOf(next.model);
          const more = line ? { slot: line, model: next!.model, line: next }
            : spare && fb && !fellBack ? { slot: spare, model: fb.model, line: null } : null;
          // Outside the try: a refusal here is the answer, not a reason to try the next line.
          limits.withinModelLimits(who, as, false);
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
            if (more.line && flowed !== null) worlds.settle(more.line, flowed, who);
            else fellBack = true;
            if (held && more.line) outPath = held.as(more.model);
            [to, as, sendBody] = [more.slot, more.model, held && more.line ? sendBody : renamed(more.model)];
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


  /** Requests proxied right now without queueing, counted for the console only; admission is unchanged. */
  let proxySeq = 0;
  const proxying = new Set<{ id: string; backend: string; model: string | null }>();

  return { routeEmbeddings, routePassthrough, proxying };
}
