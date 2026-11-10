/**
 * The operator's routes: health and the bug report, federation switches (`/control`),
 * hearth.yaml itself, restart, and probing a server before it is a backend.
 */
import { readFileSync } from "node:fs";

import { BodyTooLargeError, Refusal } from "../errors.js";
import { troubleSays } from "../queue/backend.js";
import { backendAuth, backendBase } from "../config/backends.js";
import type { RoutePolicy } from "../config/flows.js";
import { ConfigError, resolveSecret } from "../config/read.js";
import { link, setNote, setShare, unlink } from "../config/configfile.js";
import { apiError, fail, json } from "../wire/http.js";
import { bugReport } from "../observe/report.js";
import { NOTE_MAX } from "../config/models.js";
import { UpstreamError, getJson } from "../wire/upstream.js";
import type { Call, RouteContext } from "./context.js";

export function adminRoutes(ctx: RouteContext, { networkView }: { networkView: () => unknown }) {
  const { cfg, log, logs, pool, peers, plugins, controls, config, canary, limits, readJson, readBody, failConfig, broadcast, lifecycle } = ctx;

  /**
   * Whether this node can serve, for an external probe: 503 only when every backend we hold an
   * event stream to is gone. Peers never affect it. Unauthenticated and may be bound wide, so it
   * answers in counts, never names.
   */
  function health(): { ok: boolean } & Record<string, unknown> {
    const local = pool.all();
    const watched = local.filter((b) => b.state.watched());
    const connected = watched.filter((b) => b.state.streamingNow());
    const ok = watched.length === 0 || connected.length > 0;
    const pluginsFailed = plugins.status().filter((p) => p.state === "failed").length;
    return {
      ok,
      // Still serving, with part of it gone: a stream down, or a plugin that did not start.
      degraded: connected.length < watched.length || pluginsFailed > 0,
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
      plugins: { total: Object.keys(cfg.plugins).length, failed: pluginsFailed },
      // Only with a canary configured, and as a count: this endpoint is unauthenticated
      // and may be bound wide, so it says how many models are out, never which.
      ...(canary ? { canary: { degraded: canary.degradedCount() } } : {}),
    };
  }

  async function routeHealthz(c: Call): Promise<void> {
    const h = health();
    json(c.res, h.ok ? 200 : 503, h);
  }

  /** This build's version, read once, for the report's header. */
  let reportVersion: string | undefined;

  /** `hearth report` as a download: the same file, with the node's part read from memory rather than over loopback. */
  async function routeReport(c: Call): Promise<void> {
    if (cfg.configPath === null) {
      apiError(c.res, 409, "this node was not started from a config file, so there is no report to write");
      return;
    }
    reportVersion ??= (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
    const text = await bugReport(cfg.configPath, reportVersion, async (path) => {
      if (path === "/healthz") return { ok: true, text: JSON.stringify(health()) };
      if (path === "/network") return { ok: true, text: JSON.stringify(networkView()) };
      return { ok: true, text: JSON.stringify({ entries: logs.all() }) };
    });
    c.res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="hearth-report-${new Date().toISOString().slice(0, 10)}.md"`,
    }).end(text);
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

  /** Drain and exit non-zero, so a supervisor with Restart=on-failure starts the node again. */
  async function routeRestart(c: Call): Promise<void> {
    if (lifecycle.onRestart === null) {
      json(c.res, 501, { error: "this node was not started by `hearth serve`, so it cannot restart itself" });
      return;
    }
    log.info("restart.requested", { caller: c.caller });
    json(c.res, 202, { ok: true });
    lifecycle.onRestart();
  }

  /**
   * Read (GET) or change (POST) federation at runtime: `lending`, `borrowing`, per-model `share`
   * (null defers to config), `link`/`unlink`, and `save`. Local only; omitted fields are left alone.
   */
  async function routeControl(c: Call): Promise<void> {
    const { req, res } = c;
    if (req.method === "GET") {
      json(res, 200, { ...controls.state(), share: limits.shared(), catalog: pool.models.catalog(), config: config.status() });
      return;
    }
    if (req.method !== "POST") {
      apiError(res, 405, "use GET to read or POST to change");
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        res.setHeader("Connection", "close");
        apiError(res, 413, e.message);
        return;
      }
      apiError(res, 400, `body was not JSON: ${String(e)}`);
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      apiError(res, 400, "body must be a JSON object");
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

    // Share only models we can serve, or peers are advertised a model that 404s.
    if (body.share !== undefined) {
      if (typeof body.share !== "object" || body.share === null || Array.isArray(body.share)) {
        apiError(res, 400, "share must be an object of model -> true, false or null");
        return;
      }
      const catalog = pool.models.catalog();
      for (const [model, want] of Object.entries(body.share as Record<string, unknown>)) {
        if (want !== true && want !== false && want !== null) {
          apiError(res, 400, `share.${model} must be true, false or null`);
          return;
        }
        if (want === true && catalog.includes(model) && pool.models.for(model).cfg.cloud) {
          apiError(res, 400, `cannot lend "${model}": it runs on a cloud backend, and a peer's requests would spend that provider's key`);
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

    // Everything validates before anything mutates, so a combined POST lands whole or not at all.
    if (body.link !== undefined && body.unlink !== undefined) {
      // Silently preferring one is how you end up having removed a mapping
      // you thought you were adding.
      apiError(res, 400, "send link or unlink, not both");
      return;
    }
    let edit: { peer: string; mine: string; theirs: string; policy: RoutePolicy; fallbackLocal: boolean; unlink: boolean } | null = null;
    if (body.link !== undefined || body.unlink !== undefined) {
      const e = (body.link ?? body.unlink) as Record<string, unknown>;
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        apiError(res, 400, "link/unlink must be an object");
        return;
      }
      const peerName = typeof e.peer === "string" ? e.peer : "";
      const mine = typeof e.mine === "string" ? e.mine : "";
      if (peerName === "" || mine === "") {
        apiError(res, 400, "link/unlink need peer and mine");
        return;
      }
      // If we serve it too, `fastest` with local fallback; if not, peer only, since home would 404.
      const local = pool.models.catalog().includes(mine);
      const policy = (e.policy as RoutePolicy | undefined) ?? (local ? "fastest" : "peer");
      if (!["local", "peer", "spillover", "fastest"].includes(policy)) {
        apiError(res, 400, `policy must be local, peer, spillover or fastest (got ${policy})`);
        return;
      }
      edit = {
        peer: peerName, mine, policy, unlink: body.unlink !== undefined,
        theirs: typeof e.theirs === "string" && e.theirs !== "" ? e.theirs : mine,
        fallbackLocal: typeof e.fallbackLocal === "boolean" ? e.fallbackLocal : local,
      };
    }

    // One write: every config edit in this POST lands in hearth.yaml together, or none does.
    if (edit || body.notes !== undefined || body.share !== undefined) {
      try {
        config.update((d) => {
          if (edit?.unlink) unlink(d, edit.peer, edit.mine);
          else if (edit) link(d, edit.peer, edit.mine, edit.theirs, edit.policy, edit.fallbackLocal);
          for (const [model, text] of Object.entries((body.notes ?? {}) as Record<string, string | null>)) setNote(d, model, text);
          for (const [model, want] of Object.entries((body.share ?? {}) as Record<string, boolean | null>)) {
            // null meant "defer to the file" when edits were a layer over it; the file is all there is now.
            if (want !== null) setShare(d, model, want);
          }
        });
      } catch (e) {
        failConfig(res, e);
        return;
      }
      log.info("control.config", {
        ...(edit ? { [edit.unlink ? "unlink" : "link"]: { peer: edit.peer, model: edit.mine } } : {}),
        ...(body.notes !== undefined ? { notes: Object.keys(body.notes as object) } : {}),
        ...(body.share !== undefined ? { share: limits.shared() } : {}),
      });
    }

    const changed = controls.set({
      lending: body.lending as boolean | undefined,
      borrowing: body.borrowing as boolean | undefined,
    });
    // Only the transitions; a no-op POST should not leave a trail implying something moved.
    if (Object.keys(changed).length > 0) {
      log.info("control.changed", changed);
      void broadcast();
    }
    // `save` is accepted and does nothing: every edit above is already in the file.

    json(res, 200, { ...controls.state(), share: limits.shared(), changed, config: config.status() });
    return;
  }

  /**
   * hearth.yaml itself: GET is its text, hash and status; PATCH takes `{baseHash, ops}` or
   * `{baseHash, text}` (and `dryRun`), writes the file and applies it, or says why not.
   */
  async function routeConfig(c: Call): Promise<void> {
    const { req, res } = c;
    if (req.method === "GET") {
      try {
        json(res, 200, { ...config.text(), ...config.status() });
      } catch (e) {
        failConfig(res, e);
      }
      return;
    }
    try {
      const body = await readJson(req);
      const ops = body.ops;
      if (ops !== undefined && !Array.isArray(ops)) throw new Refusal(400, "ops must be a list of {path, value} or {path, delete: true}");
      if (body.text !== undefined && typeof body.text !== "string") throw new Refusal(400, "text must be the whole file as a string");
      const out = config.patch({
        ...(typeof body.baseHash === "string" ? { baseHash: body.baseHash } : {}),
        ...(ops ? { ops: ops as never } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        dryRun: body.dryRun === true,
        ...(typeof body.name === "string" ? { name: body.name.trim().slice(0, 80) } : {}),
      });
      if (body.dryRun !== true) log.info("config.patched", { hash: out.hash, restartPending: out.restartPending });
      json(res, 200, { ...config.status(), ...out });
    } catch (e) {
      failConfig(res, e);
    }
  }

  /** The console's draft of the file: kept here so it is there tomorrow and from another browser. Nothing reads it but the console. */
  async function routeConfigDraft(c: Call): Promise<void> {
    const { req, res } = c;
    try {
      if (req.method === "PUT") config.keepDraft(await readJson(req));
      else if (req.method === "DELETE") config.keepDraft(null);
      json(res, 200, { draft: config.draft() });
    } catch (e) {
      failConfig(res, e);
    }
  }

  /** The versions written through the node, and `POST { hash, dryRun? }` to make one of them the file again. */
  async function routeConfigVersions(c: Call): Promise<void> {
    const { req, res } = c;
    try {
      if (req.method === "GET") { json(res, 200, { versions: config.versions() }); return; }
      const body = await readJson(req);
      if (typeof body.hash !== "string") throw new Refusal(400, "hash must be the hash of a kept version");
      const out = config.restore(body.hash, body.dryRun === true);
      if (body.dryRun !== true) log.info("config.restored", { hash: out.hash });
      json(res, 200, { ...config.status(), ...out });
    } catch (e) {
      failConfig(res, e);
    }
  }

  /**
   * Asks a server what it serves before it is a backend, with the key it would be sent: the answer is its
   * model ids, or in a few words why there are none. Nothing is kept.
   */
  async function routeProbe(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      if (typeof body.url !== "string") throw new Refusal(400, "url is required");
      const key = typeof body.key === "string" && body.key.trim() !== "" ? resolveSecret(body.key.trim(), "key") : null;
      const format = body.format === "anthropic" ? "anthropic" : "openai";
      let url: string;
      try { url = backendBase(body.url.trim(), "url"); } catch (e) { throw new Refusal(400, e instanceof Error ? e.message : String(e)); }
      try {
        const got = await getJson<{ data?: { id?: unknown }[] }>(`${url}/v1/models`, { headers: backendAuth(format, key), headersTimeoutMs: 5_000 });
        const models = (got.data ?? []).map((m) => m.id).filter((m): m is string => typeof m === "string" && m !== "").sort();
        json(c.res, 200, { ok: true, url, models });
      } catch (e) {
        json(c.res, 200, { ok: false, url, problem: troubleSays(e instanceof UpstreamError && e.status !== undefined ? e.status : 0) });
      }
    } catch (e) {
      // A key written as env:NAME with no such variable is the asker's mistake.
      fail(c.res, e instanceof ConfigError ? new Refusal(400, e.message) : e);
    }
  }

  return { routeHealthz, routeReport, routeNetwork, routeRestart, routeControl, routeConfig, routeConfigDraft, routeConfigVersions, routeProbe };
}
