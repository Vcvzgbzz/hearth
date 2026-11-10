/**
 * The Keys page's writes: mint, update, rotate and revoke an api key. Each lands in hearth.yaml
 * through the same patch path every other config change uses, and takes effect at once.
 */
import { randomBytes } from "node:crypto";

import { Refusal } from "../errors.js";
import { DEFAULT_ROUTER } from "../config/flows.js";
import type { ConfigOp } from "../config/configfile.js";
import { json, keyId } from "../wire/http.js";
import type { Call, RouteContext } from "./context.js";

export function keyRoutes(ctx: RouteContext) {
  const { cfg, log, config, callers, readJson, failConfig } = ctx;

  // The keys page's writes: mint appends one entry, revoke removes one, rotate gives one a new
  // secret and keeps the rest of it. Each lands in the config file through the same patch path
  // every other config change uses, and takes effect at once. A plaintext comes back once, in
  // the answer of the mint or the rotate that made it.
  /** The edit that sends a key by a router: `default` is no line at all, unless `*` sends everyone else by another. */
  function routerOps(label: string, router: unknown): ConfigOp[] {
    if (typeof router !== "string") return [];
    if (router !== DEFAULT_ROUTER || cfg.callers["*"] !== undefined) return [{ path: ["callers", label], value: router }];
    if (cfg.callers[label] === undefined) return [];
    return [{ path: Object.keys(cfg.callers).length > 1 ? ["callers", label] : ["callers"], delete: true }];
  }

  /** The edits a `/keys/update` body asks for, the whole of `limits` written at once so no empty map is left behind. */
  function keyOps(i: number, label: string, body: Record<string, unknown>): ConfigOp[] {
    const written = ((config.text().doc as { apiKeys?: Record<string, unknown>[] } | null)?.apiKeys ?? [])[i] ?? {};
    const ops = routerOps(label, body.router);
    for (const k of ["lane", "expires"] as const) {
      if (body[k] === undefined) continue;
      if (body[k] !== null) ops.push({ path: ["apiKeys", i, k], value: body[k] });
      else if (written[k] !== undefined) ops.push({ path: ["apiKeys", i, k], delete: true });
    }
    type Fields = Record<string, unknown>;
    const gone = (v: unknown): boolean => v === null || v === 0;
    const merged = (was: Fields, change: Fields): Fields => Object.fromEntries(Object.entries({ ...was, ...change }).filter(([, v]) => !gone(v)));
    /** One edit per value that moved, so what a person wrote beside the others stays. */
    const diff = (at: (string | number)[], was: Fields, now: Fields): void => {
      for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (now[k] === undefined) ops.push({ path: [...at, k], delete: true });
        else if (now[k] !== was[k]) ops.push({ path: [...at, k], value: now[k] });
      }
    };
    const model = body.model as { id?: unknown; limits?: Fields } | undefined;
    if (body.limits === undefined && model === undefined) return ops;
    const at = ["apiKeys", i, "limits"];
    const { models: wasModels = {}, ...wasTop } = (written.limits ?? {}) as Fields & { models?: Record<string, Fields> };
    const top = merged(wasTop, (body.limits ?? {}) as Fields);
    const models = { ...wasModels };
    if (typeof model?.id === "string" && model.id !== "") {
      const own = merged(models[model.id] ?? {}, model.limits ?? {});
      if (Object.keys(own).length > 0) models[model.id] = own;
      else delete models[model.id];
    }
    if (Object.keys(top).length === 0 && Object.keys(models).length === 0) {
      if (written.limits !== undefined) ops.push({ path: at, delete: true });
      return ops;
    }
    diff(at, wasTop, top);
    if (Object.keys(models).length === 0) {
      if (Object.keys(wasModels).length > 0) ops.push({ path: [...at, "models"], delete: true });
      return ops;
    }
    for (const id of new Set([...Object.keys(wasModels), ...Object.keys(models)])) {
      if (models[id] === undefined) ops.push({ path: [...at, "models", id], delete: true });
      else diff([...at, "models", id], wasModels[id] ?? {}, models[id]!);
    }
    return ops;
  }

  async function routeKeys(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (label === "" || label.length > 40) throw new Refusal(400, "label must be 1-40 characters");
      if (c.path === "/keys/mint") {
        if (cfg.apiKeyLabels.includes(label)) throw new Refusal(409, `label ${label} is already used`);
        const models = Array.isArray(body.models)
          ? [...new Set((body.models as unknown[]).map((m) => {
              if (typeof m !== "string" || cfg.models[m] === undefined) throw new Refusal(400, `model ${JSON.stringify(m)} is not configured here`);
              return m;
            }))] as string[]
          : null;
        const key = "hkey_" + randomBytes(20).toString("hex");
        const entry: Record<string, unknown> = { key, label };
        if (models !== null && models.length > 0) entry.models = models;
        // The file's own parser judges these, as it would had they been typed there.
        if (typeof body.expires === "string" && body.expires !== "") entry.expires = body.expires;
        if (typeof body.limits === "object" && body.limits !== null && Object.keys(body.limits).length > 0) entry.limits = body.limits;
        const commit = config.patch({ ops: [{ path: ["apiKeys", cfg.apiKeys.length], value: entry }, ...routerOps(label, body.router)] });
        log.info("keys.minted", { label, id: keyId(key), caller: c.caller });
        json(c.res, 200, { key, label, models, restartPending: commit.restartPending });
        return;
      }
      const i = cfg.apiKeyLabels.indexOf(label);
      if (i < 0) throw new Refusal(404, `no key labeled ${label}`);
      if (c.path === "/keys/update") {
        const ops = keyOps(i, label, body);
        if (ops.length === 0) throw new Refusal(400, "nothing to change");
        const commit = config.patch({ ops });
        log.info("keys.updated", { label, caller: c.caller });
        json(c.res, 200, { label, updated: true, restartPending: commit.restartPending });
        return;
      }
      if (c.path === "/keys/rotate") {
        // Only the secret changes: its label, and so its router, scope, limits and usage, stay.
        const written = ((config.text().doc as { apiKeys?: unknown[] } | null)?.apiKeys ?? [])[i];
        const was = typeof written === "object" && written !== null ? (written as { key?: unknown }).key : written;
        if (typeof was === "string" && was.startsWith("env:")) throw new Refusal(409, `${label} reads its key from the environment (${was}): change it there`);
        const key = "hkey_" + randomBytes(20).toString("hex");
        const commit = config.patch({ ops: [{ path: ["apiKeys", i, "key"], value: key }] });
        log.info("keys.rotated", { label, id: keyId(key), caller: c.caller });
        json(c.res, 200, { key, label, rotated: true, restartPending: commit.restartPending });
        return;
      }
      const commit = config.patch({ ops: [{ path: ["apiKeys", i], delete: true }] });
      callers.forget("key:" + label);
      log.info("keys.revoked", { label, caller: c.caller });
      json(c.res, 200, { label, revoked: true, restartPending: commit.restartPending });
    } catch (e) {
      failConfig(c.res, e);
    }
  }

  return { routeKeys };
}
