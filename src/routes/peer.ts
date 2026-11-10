/**
 * The peer surface: `/peer/hello` and `/peer/state` for a borrower polling this node, and the
 * tailnet check that holds a peer's token to its own machine.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Envelope, apiError, json, refuse } from "../wire/http.js";
import { limitsFor, termsFor } from "../peers/lending.js";
import type { Call, RouteContext } from "./context.js";

export function peerRoutes(ctx: RouteContext) {
  const { cfg, log, pool, usage, limits, whois } = ctx;

  /** Where each peer last presented its token from, so the console can offer to bind it to that machine. */
  const peerSeen = new Map<string, { ip: string; port: number; at: number }>();

  /** `GET ?peer=`: what the peer is bound to now, and which tailnet machine it last called from as tailscaled names it. */
  async function routePeerMachine(c: Call): Promise<void> {
    const peer = c.url.searchParams.get("peer") ?? "";
    if (!(peer in cfg.peerTokens)) {
      apiError(c.res, 404, `${peer || "that"} is not a peer that borrows from this node`, "not_found_error");
      return;
    }
    const bound = cfg.peerTailnet[peer] ?? null;
    const seen = peerSeen.get(peer);
    if (!seen) {
      json(c.res, 200, { peer, bound, seen: null });
      return;
    }
    try {
      const node = await whois(seen.ip, seen.port);
      json(c.res, 200, { peer, bound, seen: { ip: seen.ip.replace(/^::ffff:/, ""), at: new Date(seen.at).toISOString(), node } });
    } catch (e) {
      json(c.res, 200, { peer, bound, seen: { ip: seen.ip.replace(/^::ffff:/, ""), at: new Date(seen.at).toISOString(), node: null, error: e instanceof Error ? e.message : String(e) } });
    }
  }

  /**
   * A peer bound with `tailnet` is let in only from that machine, so its token alone is not enough.
   * Fails closed: a node that cannot ask tailscaled refuses the peer rather than trusting the token.
   */
  async function fromPeerMachine(peer: string, req: IncomingMessage, res: ServerResponse, env: Envelope): Promise<boolean> {
    const want = cfg.peerTailnet[peer];
    if (want === undefined) return true;
    const ip = req.socket.remoteAddress ?? "";
    try {
      const node = await whois(ip, req.socket.remotePort ?? 0);
      if (node?.id === want) return true;
      log.warn("peer.wrong_machine", { peer, ip, node: node?.name ?? null });
      refuse(res, 403, `the token for ${peer} is honoured only from its own machine`, env);
    } catch (e) {
      log.warn("peer.machine_unchecked", { peer, ip, error: e instanceof Error ? e.message : String(e) });
      refuse(res, 403, `cannot check which machine is calling as ${peer}`, env);
    }
    return false;
  }

  // ---- peer surface ----
  async function routePeer(c: Call): Promise<void> {
    const { res, path } = c;
    const who = c.peer!;
    // Control plane, not work, so it gets its own budget. See overBudget.
    if (!limits.controlAllowed(who)) {
      json(res, 429, { error: "rate capped" });
      return;
    }
    if (path === "/peer/hello") {
      json(res, 200, {
        name: cfg.name,
        protocol: 2,
        models: limits.shared(who),
        lanes: Object.keys(cfg.scheduler.lanes),
        // Additive, so older peers ignore it and newer ones need not probe.
        capabilities: ["warm"],
      });
      return;
    }
    // Loaded and served models ride with capacity, both filtered to what we share.
    const lent = limits.shared(who);
    const warmAndShared = pool.models.loaded().filter((m) => lent.includes(m));
    const agg = pool.aggregate();
    // Protocol 2: capacity per shared model, beside the aggregate protocol-1 peers still read.
    const models: Record<string, unknown> = {};
    for (const m of lent) {
      // Per-model stats, absent until loaded; silence is not a claim of no limit.
      const stats = pool.models.statsFor(m);
      // The borrower is shown what it is held to here, and how much of today it has used.
      const ran = usage.byModel(`peer:${who}`, 1)[m];
      const terms = { ...limitsFor(termsFor(cfg, who), m), usedToday: ran ? ran.in + ran.out : 0 };
      models[m] = { ...pool.capacityFor(m), ...(stats ? { stats } : {}), terms };
    }
    json(res, 200, {
      ...agg,
      resident: agg.resident !== null && lent.includes(agg.resident) ? agg.resident : null,
      loaded: warmAndShared,
      serves: lent,
      models,
    });
    return;
  }

  /** Note where a peer presented its token from, so the console can offer to bind it to that machine. */
  function sawPeer(peer: string, req: IncomingMessage): void {
    peerSeen.set(peer, { ip: req.socket.remoteAddress ?? "", port: req.socket.remotePort ?? 0, at: Date.now() });
  }

  return { routePeer, routePeerMachine, fromPeerMachine, sawPeer };
}
