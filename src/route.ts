/**
 * Where a request runs: local unless the config routes it to a peer that is known-good
 * right now. Pure, so it tests without a socket.
 */
import type { HearthConfig } from "./config.js";
import type { PeerRegistry } from "./peers.js";
import { unfit, type Need } from "./stats.js";

export interface LocalLoad {
  /** Jobs waiting on the local backend, all lanes. */
  queued: number;
  /** Free slots on the local backend right now. */
  free: number;
  /** Total slots, so local and peer pressure come out in the same units. */
  slots: number;
  /** Loaded here right now. Starting cold isn't free. */
  loaded: string[];
}

export type Decision =
  | { target: "local"; reason: string }
  | { target: "peer"; peer: string; theirModel: string; reason: string }
  /** Nobody can take it and the operator said it can't run here. */
  | { target: "unavailable"; reason: string };

/**
 * "How soon does this start", lower is sooner: queued work, plus one if nothing is free,
 * plus `coldPenalty` (in queued-job units) when the model has to load first.
 */
function pressure(
  queued: number,
  free: number,
  slots: number,
  warm: boolean,
  coldPenalty: number,
): number {
  const busy = slots - free;
  return queued + (free > 0 ? 0 : Math.max(busy, 1)) + (warm ? 0 : coldPenalty);
}

export function decide(
  model: string,
  cfg: HearthConfig,
  peers: PeerRegistry,
  local: LocalLoad,
  /** What the request needs; a peer that reported a smaller limit is skipped. Silence is not a limit. */
  need?: Need,
): Decision {
  const route = cfg.models[model];
  if (!route || route.policy === "local") {
    return { target: "local", reason: route ? "policy is local" : "no route configured" };
  }

  let candidates = peers.candidates(model, route.peers);
  /** The first fit refusal, kept for the reason string: "no peer available" is
   *  what you get when they are all down, and it would be a confusing thing to
   *  read about peers that are up and simply too small. */
  let refused: string | null = null;
  if (need) {
    const kept: string[] = [];
    for (const name of candidates) {
      // Safe: candidates() only returns peers that map the model.
      const why = unfit(peers.statsFor(name, peers.theirModelId(name, model)!), need);
      if (why === null) kept.push(name);
      else refused ??= `${name} ${why}`;
    }
    candidates = kept;
  }
  if (candidates.length === 0) {
    // With fallbackLocal off, a down peer refuses rather than running here.
    const why = refused ?? "no peer available";
    if (!route.fallbackLocal) {
      return { target: "unavailable", reason: `${why} and fallbackLocal is off` };
    }
    return { target: "local", reason: why };
  }

  const toPeer = (name: string, reason: string): Decision => ({
    target: "peer",
    peer: name,
    // Safe: candidates() only hands back peers that map the model.
    theirModel: peers.theirModelId(name, model)!,
    reason,
  });

  if (route.policy === "peer") {
    return toPeer(candidates[0]!, "policy prefers a peer");
  }

  if (route.policy === "spillover") {
    if (local.queued < route.spilloverAt) {
      return { target: "local", reason: `local depth ${local.queued} is below the spill threshold` };
    }
    return toPeer(candidates[0]!, `local depth ${local.queued} reached the spill threshold`);
  }

  // fastest: compare pressure, move work only if a peer is genuinely better.
  // Ties stay home. The hop costs something, and a peer that merely matches us
  // isn't worth sending the prompt off the machine for.
  const localPressure = pressure(
    local.queued,
    local.free,
    local.slots,
    local.loaded.includes(model),
    cfg.coldPenalty,
  );
  let best: { name: string; p: number } | null = null;
  for (const name of candidates) {
    // Scored on THIS model's queue, under the peer's own id for it.
    const theirId = peers.theirModelId(name, model);
    if (theirId === undefined) continue;
    const load = peers.loadFor(name, theirId);
    if (!load) continue;
    const p = pressure(load.queued, load.free, load.slots, load.warm, cfg.coldPenalty);
    if (best === null || p < best.p) best = { name, p };
  }
  if (best === null) return { target: "local", reason: "no peer reported capacity" };
  if (best.p < localPressure) {
    return toPeer(best.name, `peer pressure ${best.p} beats local ${localPressure}`);
  }
  return { target: "local", reason: `local pressure ${localPressure} is no worse than any peer` };
}
