/**
 * Invites: one node makes a one-time code, another redeems it, and each ends up with the other
 * as a peer. Proved with HMACs over the invite secret, so no token crosses the wire.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { Refusal } from "../errors.js";
import { fail, json } from "../wire/http.js";
import { send } from "../wire/upstream.js";
import type { Call, RouteContext } from "./context.js";

export function joinRoutes(ctx: RouteContext) {
  const { cfg, log, config, whois, readJson, failConfig } = ctx;

  /** Open invites by secret: each lets one node join as a peer that may borrow from this one, once, until it expires. */
  const invites = new Map<string, number>();
  const INVITE_TTL_MS = 10 * 60_000;
  const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
  const INVITE_PREFIX = "hearth-invite:";

  /**
   * Make an invite: a code holding this node's address and a one-time secret. Whoever redeems it
   * becomes a peer that may borrow from this node on what `lending` allows, no more. Held in
   * memory only, so a restart voids every open code.
   */
  async function routeInvite(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      const url = (typeof body.url === "string" ? body.url.trim() : "").replace(/\/+$/, "");
      if (!/^https?:\/\/[^/?#]+$/.test(url)) {
        throw new Refusal(400, "url must be the address your friend reaches this node at, as http://host:port");
      }
      const now = Date.now();
      for (const [s, until] of invites) if (until <= now) invites.delete(s);
      const secret = randomBytes(24).toString("base64url");
      invites.set(secret, now + INVITE_TTL_MS);
      const code = INVITE_PREFIX + Buffer.from(JSON.stringify({ u: url, s: secret })).toString("base64url");
      log.info("peers.invited", { caller: c.caller, url, expiresInSec: INVITE_TTL_MS / 1000 });
      json(c.res, 200, { code, expiresAt: new Date(now + INVITE_TTL_MS).toISOString() });
    } catch (e) {
      fail(c.res, e);
    }
  }

  /**
   * A token proved without sending it: keyed with the invite's secret, so a proof shown to one
   * code's address is worth nothing against any other code. Each side proves with its own label, so
   * neither can pass a proof it was shown back as its own: only a holder of the token can answer.
   */
  const proof = (secret: string, token: string, side: "join" | "known"): string => createHmac("sha256", secret).update(`${side}:${token}`).digest("hex");

  /**
   * The peer here a joiner already is, if any: one sharing a token the joiner proves it holds (with
   * that proof, so the joiner can find its own entry too), or one bound to the tailnet machine it
   * calls from. Null for a node this one has no link with.
   */
  async function knownJoiner(req: IncomingMessage, secret: string, knows: readonly string[]): Promise<{ peer: string; knew?: string } | null> {
    if (knows.length > 0) {
      const held = new Set(knows);
      const shared: [string, string][] = [...Object.entries(cfg.peerTokens), ...cfg.peers.map((p): [string, string] => [p.name, p.token])];
      for (const [peer, token] of shared) {
        if (held.has(proof(secret, token, "join"))) return { peer, knew: proof(secret, token, "known") };
      }
    }
    const bound = Object.entries(cfg.peerTailnet);
    if (bound.length === 0) return null;
    try {
      const node = await whois(req.socket.remoteAddress ?? "", req.socket.remotePort ?? 0);
      const peer = bound.find(([, id]) => id === node?.id)?.[0];
      return peer === undefined ? null : { peer };
    } catch {
      // Unasked is unknown: the joiner is taken as a new peer, as it would be with no tailscaled at all.
      return null;
    }
  }

  /**
   * The inviter's half of a join, the one write a caller with no credential can make: a live
   * invite secret, spent on first use, adds the caller as a peer under the name it gives and
   * answers with the token it is to present from then on. A caller that is already a peer here
   * joins that entry instead, keeping any token it is already accepted with.
   */
  async function routePeerJoin(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      const secret = typeof body.secret === "string" ? body.secret : "";
      const until = invites.get(secret);
      if (until === undefined || until <= Date.now()) {
        invites.delete(secret);
        throw new Refusal(403, "this invite is not valid here: it was used, it expired, or this node restarted since");
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!PEER_NAME.test(name)) throw new Refusal(400, "name must be 1-40 letters, digits, '.', '_' or '-'");
      const knows = Array.isArray(body.knows) ? body.knows.filter((k): k is string => typeof k === "string").slice(0, 64) : [];
      // Claimed before the lookup awaits, so a second try with the same secret cannot race this one.
      invites.delete(secret);
      const known = await knownJoiner(c.req, secret, knows);
      if (known === null && (name in cfg.peerTokens || cfg.peers.some((p) => p.name === name))) {
        // A taken name spends nothing: the joiner may try again under another.
        invites.set(secret, until);
        throw new Refusal(409, `this node already has a peer called ${name}`);
      }
      const peer = known?.peer ?? name;
      const kept = cfg.peerTokens[peer];
      const token = kept ?? "hpeer_" + randomBytes(24).toString("hex");
      if (kept === undefined) config.patch({ ops: [{ path: ["peers", peer, "accept"], value: token }] });
      log.info("peers.joined", { peer, ...(known !== null && { already: true }), ip: c.req.socket.remoteAddress ?? "?" });
      json(c.res, 200, { name: cfg.name, token, ...(known?.knew !== undefined && { knew: known.knew }) });
    } catch (e) {
      failConfig(c.res, e);
    }
  }

  /** The name a node gives on its health check, or null when it does not say. */
  async function inviterName(url: string): Promise<string | null> {
    try {
      const v = (JSON.parse(await (await send(`${url}/healthz`, { headersTimeoutMs: 15_000 })).text()) as { name?: unknown }).name;
      return typeof v === "string" && v !== "" ? v : null;
    } catch {
      return null;
    }
  }

  /** Redeem an invite: ask the inviter to take this node as a peer, then add the inviter as one to borrow from. */
  async function routeJoin(c: Call): Promise<void> {
    try {
      const body = await readJson(c.req);
      const code = typeof body.code === "string" ? body.code.trim() : "";
      let u = "";
      let s = "";
      try {
        if (!code.startsWith(INVITE_PREFIX)) throw new Error();
        const d = JSON.parse(Buffer.from(code.slice(INVITE_PREFIX.length), "base64url").toString()) as { u?: unknown; s?: unknown };
        if (typeof d.u === "string" && typeof d.s === "string") [u, s] = [d.u, d.s];
      } catch {
        // Answered below, the same as a code with a field missing.
      }
      if (!/^https?:\/\/[^/?#]+$/.test(u) || s === "") throw new Refusal(400, "that is not an invite code: it starts with hearth-invite:");
      const as = typeof body.as === "string" ? body.as.trim() : "";
      if (as !== "" && !PEER_NAME.test(as)) throw new Refusal(400, "as must be 1-40 letters, digits, '.', '_' or '-'");
      const borrowsAt = (name: string): string | null => cfg.peers.find((p) => p.name === name)?.url ?? null;
      // The entry that already stands for the inviter: the one at the code's address, else the name it is to be kept under.
      const atUrl = cfg.peers.find((p) => p.url === u)?.name;
      const expected = atUrl ?? (as !== "" ? as : await inviterName(u));
      const was = expected === null ? null : borrowsAt(expected);
      // A name borrowing from another address is another node, refused before the code is spent.
      if (was !== null && was !== u) throw new Refusal(409, `you already borrow from a peer called ${expected}: join again with as`);
      // Tokens the inviter may already share with this node, proved and never sent: what it presents
      // to that entry, and what it accepts from each peer. The inviter's answer names the one it holds.
      const held: [string, string][] = Object.entries(cfg.peerTokens);
      const there = cfg.peers.find((p) => p.name === expected);
      if (there) held.unshift([there.name, there.token]);
      // What is sent, and what only an inviter that holds the same token can answer with.
      const knows = held.map(([, token]) => proof(s, token, "join")).slice(0, 64);
      const mine = new Map(held.map(([peer, token]) => [proof(s, token, "known"), peer]));
      const up = await send(`${u}/peer/join`, { method: "POST", json: { secret: s, name: cfg.name, ...(knows.length > 0 && { knows }) }, headersTimeoutMs: 15_000 });
      const said = await up.text();
      let answer: { name?: unknown; token?: unknown; knew?: unknown; error?: unknown } = {};
      try {
        answer = JSON.parse(said) as typeof answer;
      } catch {
        // Not hearth on the other end; refused below with its status.
      }
      if (!up.ok) {
        // The code chose this address, so only a short hearth-shaped reason is passed on, never a body.
        const why = typeof answer.error === "object" && answer.error !== null ? (answer.error as { message?: unknown }).message : answer.error;
        throw new Refusal(502, `the inviter refused: ${typeof why === "string" ? why.slice(0, 200) : `it answered ${up.status}`}`);
      }
      if (typeof answer.token !== "string" || typeof answer.name !== "string") throw new Refusal(502, "the inviter answered something that is not a join");
      // The entry the inviter recognised us by is the same node, whatever it is called here.
      const same = typeof answer.knew === "string" ? mine.get(answer.knew) : undefined;
      const name = same ?? expected ?? answer.name;
      if (!PEER_NAME.test(name)) throw new Refusal(502, `the inviter's name ${JSON.stringify(name)} cannot be a peer name here: join again with as`);
      const now = borrowsAt(name);
      if (same === undefined && now !== null && now !== u) throw new Refusal(409, `the inviter added you, but you already borrow from a peer called ${name}: add peers.<another name> with url ${u} and token ${answer.token} by hand`);
      // An entry this node has for the inviter keeps what it holds and gains, or refreshes, the url and token beside it.
      const ops = name in cfg.peerTokens || now !== null
        ? [{ path: ["peers", name, "url"], value: u }, { path: ["peers", name, "token"], value: answer.token }]
        : [{ path: ["peers", name], value: { url: u, token: answer.token } }];
      try {
        config.patch({ ops });
      } catch (e) {
        // The inviter already took us, so the token is all that is missing here: say where it goes.
        throw new Refusal(500, `the inviter added you, but saving them here failed (${e instanceof Error ? e.message : String(e)}): add peers.${name} with url ${u} and token ${answer.token} by hand`);
      }
      log.info("peers.joined_as_borrower", { peer: name, url: u, caller: c.caller });
      json(c.res, 200, { peer: name, url: u });
    } catch (e) {
      failConfig(c.res, e);
    }
  }

  return { routeInvite, routePeerJoin, routeJoin };
}
