/**
 * Peers: who this node borrows from, and the terms it lends on.
 */
import { count, strList } from "./read.js";

export interface PeerConfig {
  name: string;
  /** Base url of the peer's hearth, not its backend. */
  url: string;
  /** Bearer token this peer expects. `env:NAME` pulls it from the environment so
   *  it stays out of the config file you commit. */
  token: string;
  /** my model id -> their model id. Also the allowlist: an unmapped model never goes to this peer. */
  models: Record<string, string>;
}

/** What a peer may take from this node, and how much of it. */
export interface LendTerms {
  models: readonly string[];
  tokensPerDay: number;
  maxConcurrent: number;
  rateLimit: number;
  /** Nothing is lent to this peer while set; only a peer's own `lend:` carries it. */
  off?: boolean;
  /** One model's own limits, each laid over the three above for that model; only a peer's own `lend:` carries them. */
  limits?: Record<string, Partial<ModelLimits>>;
}

/** The limits each lent model is held to on its own: a peer's use of one model never spends another's. */
export type ModelLimits = Pick<LendTerms, "tokensPerDay" | "maxConcurrent" | "rateLimit">;

/** The lending terms a block states, and only those: `lending:` for every peer, `peers.<name>.lend` for one. */
export function lendTerms(rec: Record<string, unknown>, at: string): Partial<LendTerms> {
  const out: Partial<LendTerms> = {};
  if (rec.models !== undefined) out.models = strList(rec.models, `${at}.models`);
  if (rec.tokensPerDay !== undefined) out.tokensPerDay = count(rec.tokensPerDay, `${at}.tokensPerDay`, 0, 0);
  if (rec.maxConcurrent !== undefined) out.maxConcurrent = count(rec.maxConcurrent, `${at}.maxConcurrent`, 2, 1);
  if (rec.rateLimit !== undefined) out.rateLimit = count(rec.rateLimit, `${at}.rateLimit`, 600, 1);
  return out;
}

/** Peers a route may use that map `id`, in preference order; an empty `named` means every peer. */
export function peersMapping(id: string, named: readonly string[], peers: readonly PeerConfig[]): string[] {
  const order = named.length > 0 ? named : peers.map((p) => p.name);
  return order.filter((n) => peers.find((p) => p.name === n)?.models[id] !== undefined);
}
