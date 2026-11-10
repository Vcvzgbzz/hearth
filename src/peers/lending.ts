/**
 * What one peer may take from this node: the node's lending limits with that peer's own laid over
 * them, each held per model, and whether they let it in right now.
 */
import type { HearthConfig } from "../config/config.js";
import type { LendTerms, ModelLimits } from "../config/peers.js";
import type { Row } from "../observe/usage.js";

type Lending = Pick<HearthConfig, "share" | "lendTokensPerDay" | "peerMaxConcurrent" | "peerRateLimit" | "peerTerms">;

/** The limits `peer` is held to: `lending.*`, with whatever its own `lend:` restates. */
export function termsFor(cfg: Lending, peer: string): LendTerms {
  return {
    models: cfg.share,
    tokensPerDay: cfg.lendTokensPerDay,
    maxConcurrent: cfg.peerMaxConcurrent,
    rateLimit: cfg.peerRateLimit,
    ...cfg.peerTerms[peer],
  };
}

/** What one model is held to under these terms: the peer's three, with that model's own laid over them. */
export function limitsFor(t: LendTerms, model: string): ModelLimits {
  return { tokensPerDay: t.tokensPerDay, maxConcurrent: t.maxConcurrent, rateLimit: t.rateLimit, ...t.limits?.[model] };
}

/** Why a peer on these terms is turned away from every model right now; null when it is not. */
export function closedWhy(t: LendTerms): string | null {
  return t.off ? "lending to this peer is off" : null;
}

/** Why a peer is turned away from one model, given what it ran of that model today; null when it is not. */
export function spentWhy(model: string, l: ModelLimits, ranToday: Row | undefined): string | null {
  const used = ranToday ? ranToday.in + ranToday.out : 0;
  return l.tokensPerDay > 0 && used >= l.tokensPerDay ? `today's ${l.tokensPerDay} tokens of ${model} are used (UTC)` : null;
}
