/**
 * What one peer may take from this node: the node's lending limits with that peer's own laid over
 * them, and whether they let it in right now.
 */
import type { HearthConfig, LendTerms } from "./config.js";
import type { Row } from "./usage.js";

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

/** Why a peer on these limits is turned away right now, given what it ran here today; null when it is not. */
export function closedWhy(t: LendTerms, lentToday: Row): string | null {
  if (t.off) return "lending to this peer is off";
  if (t.tokensPerDay > 0 && lentToday.in + lentToday.out >= t.tokensPerDay) return `today's ${t.tokensPerDay} tokens are used (UTC)`;
  return null;
}
