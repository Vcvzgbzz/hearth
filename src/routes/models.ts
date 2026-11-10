/**
 * The model routes: `/v1/models` lists what can be asked for, `/v1/warm` loads one without
 * generating, `/v1/evict` drops one off its card.
 */
import { inScope } from "../access/admit.js";
import { Refusal, refusalOf } from "../errors.js";
import { WARM_LANE } from "../config/config.js";
import { ANY } from "../config/flows.js";
import { apiError, fail, json } from "../wire/http.js";
import { decide, variantsOf } from "../routing/route.js";
import type { ModelStats } from "../config/models.js";
import { send } from "../wire/upstream.js";
import { localLoad } from "../routing/world.js";
import type { Call, RouteContext } from "./context.js";

export function modelRoutes(ctx: RouteContext) {
  const { cfg, log, pool, peers, canary, limits, worlds, readJson, backendDeadline } = ctx;

  /** A model as the OpenAI API lists one: clients that check an answer's shape look for `object`. */
  const asModel = <T extends { id: string }>(m: T) => ({ object: "model" as const, owned_by: cfg.name, ...m });

  async function routeModels(c: Call): Promise<void> {
    const { res } = c;
    const modelsPeer = c.peer;
    try {
      // The union, so a client sees every model this node can serve rather
      // than only whatever the first backend happens to list. Freshened first
      // so a model added since startup shows up.
      await Promise.all(pool.all().map((b) => b.state.ensureFresh()));
      // Carry warm state, as llama-swap does on this route.
      const warm = new Set(pool.models.loaded());
      type Entry = {
        id: string; status?: { value: string }; context_length?: number; description?: string;
        input_modalities?: string[];
      };
      // What a client may send, where the model or its operator has said. Silence stays silence.
      const input = (stats: ModelStats | null | undefined): string[] | undefined =>
        typeof stats?.vision === "boolean" ? (stats.vision ? ["text", "image"] : ["text"]) : undefined;
      const upstream: { data?: Entry[] } = {
        data: pool.models.catalog().map((id) => {
          // Unknown warmth or window is omitted, never reported as cold or null.
          const entry: Entry = { id };
          const stats = pool.models.statsFor(id);
          if (stats?.note) entry.description = stats.note;
          // A degraded model is loaded and answering, just not with an answer,
          // so its status wins over warmth: "loaded" would read as healthy.
          const sick = canary?.refuse(id);
          if (sick) {
            entry.status = { value: "degraded" };
            entry.description = `${sick.detail} (since ${new Date(sick.since).toISOString()})`;
            return entry;
          }
          if (!pool.models.for(id).state.knowsWarm()) return entry;
          entry.status = { value: warm.has(id) ? "loaded" : "unloaded" };
          const ctx = pool.models.contextLength(id);
          if (ctx !== null) entry.context_length = ctx;
          const takes = input(stats);
          if (takes) entry.input_modalities = takes;
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
          const takes = input(per?.stats);
          if (takes) entry.input_modalities = takes;
          upstream.data!.push(entry);
        }
      }
      // A peer sees only what we share.
      if (modelsPeer !== null) {
        const lent = limits.shared(modelsPeer);
        upstream.data = (upstream.data ?? []).filter((m) => lent.includes(m.id));
      } else {
        // Everyone else sees what can be asked for: the names flows take, and every model as well
        // only where the flow for other names runs them as themselves.
        const mine = worlds.rulesFor(c.caller).flows;
        const taken = Object.values(mine).filter((f) => !f.off).flatMap((f) => f.inputs).filter((id) => id !== ANY);
        const open = Object.values(mine).some((f) => !f.off && f.inputs.includes(ANY) && f.steps.some((s) => "asked" in s.to));
        const listed = new Set(upstream.data!.map((m) => m.id));
        if (!open) upstream.data = upstream.data!.filter((m) => taken.includes(m.id));
        for (const id of taken) if (!listed.has(id)) upstream.data!.push({ id });
        // Each variant a type comes in is a name of its own to ask for.
        for (const id of taken) for (const v of variantsOf(mine, id)) upstream.data!.push({ id: `${id}:${v}` });
      }
      // Same for a scoped key: its picker shows what it may pick.
      if (c.models !== null) {
        upstream.data = (upstream.data ?? []).filter((m) => inScope(c.models!, m.id, (n: string) => limits.isType(n)));
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
        json(res, 200, asModel(one));
        return;
      }
      json(res, 200, { object: "list", data: upstream.data!.map(asModel) });
    } catch (e) {
      apiError(res, 502, `backend unreachable: ${String(e)}`, "server_error");
    }
    return;
  }

  // Ask a model to be resident without generating. Queued like any job, since loading one evicts
  // another; best-effort, and nothing reserves it.
  async function routeWarm(c: Call): Promise<void> {
    try {
      // A warm spends the GPU, so it meets the same gates as chat.
      const body = await readJson(c.req);
      const model = typeof body.model === "string" ? body.model : "";
      limits.admit(c, model);
      await warm(c, model);
    } catch (e) {
      fail(c.res, e);
    }
  }

  async function warm(c: Call, model: string): Promise<void> {
    const { res } = c;
    const fromPeer = c.peer;
    const caller = c.caller;

    // Same routing question chat asks. Phase 1 implements only the local
    // answer, but asking it here is what makes peer warming a branch of this
    // route later rather than a second endpoint with its own opinions.
    const slotFor = pool.models.for(model);
    const load = localLoad(slotFor, model);
    const decision = fromPeer !== null
      // A peer's warm is served here or nowhere. Forwarding it onward would
      // let two nodes that each prefer the other bounce a warm between them,
      // the same loop the chat route avoids by not re-routing peer work.
      ? ({ target: "local", reason: "from a peer" } as const)
      : decide(model, cfg, peers, load);

    // A peer's warm is taken only if it can start now; it may never make us wait or evict on its schedule.
    if (fromPeer !== null && load.free <= 0) {
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
    const wire = pool.models.outboundId(model);
    // Only a backend that swaps models has anything to warm; saying "warmed" elsewhere claims work that did not happen.
    if (!slot.state.canUnload()) {
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
        { lane: WARM_LANE, model, caller, ...limits.capFor(fromPeer, model), signal: ctrl.signal },
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
      const r = refusalOf(e);
      if (r.status >= 500) log.warn("warm.failed", { model, backend: slot.name, error: r.message });
      throw r;
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
  // Drop a model off the card that serves it. Per-model where the backend can, because that
  // leaves the card's other residents working; a whole-card clear only as its one and only verb,
  // and then only when nothing else is resident to lose.
  async function routeEvict(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (model === "") throw new Refusal(400, "model is required");
      const slot = pool.models.for(model);
      const wire = pool.models.outboundId(model);
      if (!slot.state.isWarm(wire)) throw new Refusal(409, `${model} is not resident on ${slot.name} — nothing to evict`);
      // A request that is running would lose its model mid-answer.
      const running = slot.scheduler.view().filter((j) => j.state === "running" && !j.offbox);
      const mine = running.filter((j) => pool.models.outboundId(j.model) === wire).length;
      if (mine > 0) throw new Refusal(409, `${model} is answering ${mine} request${mine > 1 ? "s" : ""} — evict it once ${mine > 1 ? "they finish" : "it finishes"}`);
      let via: "model" | "card";
      if (await slot.state.dropOne(wire)) {
        via = "model";
      } else if (slot.state.canUnload() && slot.state.loaded().length === 1 && running.length === 0) {
        await slot.state.unload();
        via = "card";
      } else {
        const others = slot.state.loaded().filter((m) => m !== wire);
        throw new Refusal(409, others.length > 0
          ? `${slot.name} keeps ${others.length} other resident model${others.length > 1 ? "s" : ""} and this kind can only clear the whole card`
          : `${slot.name} cannot drop a single model`);
      }
      log.info("pool.evicted", { model, backend: slot.name, via, caller: c.caller });
      json(c.res, 200, { model, backend: slot.name, evicted: true, via });
    } catch (e) {
      fail(c.res, e);
    }
  }

  return { routeModels, routeWarm, routeEvict };
}
