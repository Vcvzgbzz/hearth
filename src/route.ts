/**
 * Where should this request run?
 *
 * Pure, and kept away from the server, so the question worth testing ("when
 * does work leave this machine?") can be tested without a socket anywhere in
 * sight. The server does plumbing. This decides.
 *
 * Local is always the default. A model with no `models` entry never leaves, and
 * neither does one whose peers don't map it. Work goes elsewhere only if the
 * config said so and a peer is known-good right now.
 */
import type { HearthConfig } from "./config.js";
import type { PeerRegistry } from "./peers.js";

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
 * Rough "how soon does this start" score. Lower is sooner.
 *
 * Three terms, and the last one usually decides it:
 *
 *   queued   work already in line
 *   busy     nothing free, so something has to finish first
 *   cold     model isn't loaded, so there's a swap coming
 *
 * Queue depth on its own isn't enough. An idle node holding the wrong model has
 * to evict and reload first, which is tens of seconds on anything large, and a
 * node with the model already resident and one job queued will beat it easily.
 * Compare depth alone and you hand the work to whichever side happens to be
 * idle and cold, which is the slower answer.
 *
 * Crude on purpose. A real duration model needs per-model load times and token
 * rates, which is a research project. coldPenalty is in queued-jobs-equivalent
 * so the terms add up, and it's a knob because the right value depends on your
 * model size and disk.
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
): Decision {
  const route = cfg.models[model];
  if (!route || route.policy === "local") {
    return { target: "local", reason: route ? "policy is local" : "no route configured" };
  }

  const candidates = peers.candidates(model, route.peers);
  if (candidates.length === 0) {
    // A down peer is the normal case here, but if fallbackLocal is off, honour
    // it. This used to only change the reason string, so the one knob meaning
    // "never run this here" worked when a peer errored and did nothing when a
    // peer was simply down. People set it because the local box would OOM.
    if (!route.fallbackLocal) {
      return { target: "unavailable", reason: "no peer available and fallbackLocal is off" };
    }
    return { target: "local", reason: "no peer available" };
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
    // Ask about THIS model, not about the node. A peer fronting several
    // backends can be busy on its GPU and completely idle on the queue that
    // would actually serve us; node-level numbers would send our work away, or
    // keep it home, for reasons that have nothing to do with our model.
    // Their id, since that is the only name their side reports under.
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
