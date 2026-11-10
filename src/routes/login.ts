/**
 * The operator login: first-run setup, log in, log out. Sessions themselves live in `Callers`.
 */
import { isLoopback } from "../access/callers.js";
import { ConfigRefusal } from "../config/configfile.js";
import { json, secretEq } from "../wire/http.js";
import { hashPassword, verifyDecoy, verifyPassword } from "../access/login.js";
import type { Call, RouteContext } from "./context.js";

export function loginRoutes(ctx: RouteContext) {
  const { cfg, log, config, callers, readBody } = ctx;

  const NO_OPERATOR = "this node has no operator yet: open the console on the machine itself, or run `hearth set-operator <user> <pass>` there";

  /** The operator login: verify against the config's hash, mint a session, set the cookie. */
  async function routeLogin(c: Call): Promise<void> {
    if (!cfg.operator) {
      json(c.res, 404, { error: NO_OPERATOR });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(c.req)).toString() || "{}");
    } catch {
      json(c.res, 400, { error: "the login body must be JSON" });
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      json(c.res, 400, { error: "the login body must be JSON" });
      return;
    }
    const user = typeof body.user === "string" ? body.user : "";
    const pass = typeof body.pass === "string" ? body.pass : "";
    const ip = c.req.socket.remoteAddress ?? "?";
    const now = Date.now();
    if (callers.loginThrottle.blocked(user, ip, now)) {
      json(c.res, 429, { error: "too many failed logins — try again in a few minutes" });
      return;
    }
    // Counted before scrypt yields, or a parallel burst all passes the check above.
    callers.loginThrottle.note(user, ip, now);
    // An unknown username burns one full scrypt, so response time says nothing about it.
    const ok = user !== "" && secretEq(user, cfg.operator.user)
      ? await verifyPassword(pass, cfg.operator.passHash)
      : await verifyDecoy(pass);
    if (!ok) {
      log.warn("login.failed", { ip, user: user === "" ? null : user });
      json(c.res, 401, { error: "bad username or password" });
      return;
    }
    callers.loginThrottle.clear(user);
    callers.startSession(c.res, user, now);
    log.info("login.ok", { ip, caller: "operator:" + user });
    json(c.res, 200, { ok: true });
  }

  /** GET says whether the node still needs its first operator; POST creates it and signs it in. */
  async function routeSetup(c: Call): Promise<void> {
    // Creating the operator is taking the node: only a caller who already holds all of it may.
    const may = isLoopback(c.req) || callers.local(c.req)?.models === null;
    if (c.req.method === "GET") {
      json(c.res, 200, { needed: cfg.operator === null && may });
      return;
    }
    if (cfg.operator) {
      json(c.res, 409, { error: "this node already has an operator — log in instead" });
      return;
    }
    if (!may) {
      json(c.res, 403, { error: NO_OPERATOR });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse((await readBody(c.req)).toString() || "{}");
    } catch {
      json(c.res, 400, { error: "the setup body must be JSON" });
      return;
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const user = typeof b.user === "string" ? b.user.trim() : "";
    const pass = typeof b.pass === "string" ? b.pass : "";
    if (user === "" || pass.length < 8) {
      json(c.res, 400, { error: "a username and a password of at least 8 characters" });
      return;
    }
    const passHash = await hashPassword(pass);
    // Re-checked after the await: two first-run tabs must not both win.
    if (cfg.operator) {
      json(c.res, 409, { error: "this node already has an operator — log in instead" });
      return;
    }
    try {
      config.patch({ ops: [{ path: ["operator"], value: { user, passHash } }] });
    } catch (e) {
      json(c.res, e instanceof ConfigRefusal ? e.status : 500, { error: (e as Error).message });
      return;
    }
    callers.startSession(c.res, user, Date.now());
    log.info("setup.operator", { ip: c.req.socket.remoteAddress ?? "?", caller: "operator:" + user });
    json(c.res, 200, { ok: true });
  }

  /** Drop this request's session, if any; a session-less logout is a no-op. */
  async function routeLogout(c: Call): Promise<void> {
    callers.endSession(c.req, c.res);
    json(c.res, 200, { ok: true });
  }

  return { routeLogin, routeSetup, routeLogout };
}
