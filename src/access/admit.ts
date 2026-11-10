/**
 * The model gates a request meets before it is queued: named, lent to this peer, within the key's
 * scope, served by someone. The scheduler answers "can this start now"; this, "may it run at all".
 */
import { Refusal } from "../errors.js";

/** Who is asking for which model. */
export interface Ask {
  model: string;
  /** The peer whose token this came with, or null for a local caller. */
  peer: string | null;
  /** The ids a scoped key may run, or null for any. */
  scope: string[] | null;
}

export interface Policy {
  /** This node's name, for the refusal a peer reads. */
  name: string;
  /** What we lend right now. */
  shared(): readonly string[];
  /** Null when something here or on a mapped peer serves this id, else what is served instead. */
  unknown(model: string): string | null;
  /** Is this name one a flow takes? A key scoped to such a name may ask for its variants too. */
  type?(name: string): boolean;
}

/**
 * May a key held to `scope` ask for `model`? By its own name, or as a variant of a type the scope
 * names. A name some flow takes for itself is not a variant of anything, colon or not.
 */
export function inScope(scope: readonly string[], model: string, type: (name: string) => boolean = () => false): boolean {
  if (scope.includes(model)) return true;
  const base = model.slice(0, Math.max(0, model.lastIndexOf(":")));
  return base !== "" && scope.includes(base) && type(base) && !type(model);
}

/** The model gates, in order: named, lent to this peer, within this key's scope, served by someone. */
export function admitModel(ask: Ask, policy: Policy): Refusal | null {
  const { model } = ask;
  if (model === "") return new Refusal(400, "model is required");
  if (ask.peer !== null && !policy.shared().includes(model)) {
    return new Refusal(403, `${policy.name} does not share "${model}"`, "permission_error");
  }
  if (ask.scope !== null && !inScope(ask.scope, model, policy.type)) {
    return new Refusal(403, `this key may not run "${model}"`, "permission_error");
  }
  const instead = policy.unknown(model);
  if (instead !== null) return new Refusal(404, `no backend here serves "${model}" (${instead})`);
  return null;
}

/** Queued-or-running jobs one caller may hold per lane: peers always capped, local callers when configured. */
export function callerCap(peer: string | null, cfg: { peerMaxConcurrent: number; scheduler: { maxPerCaller: number } }): number | undefined {
  if (peer !== null) return cfg.peerMaxConcurrent;
  return cfg.scheduler.maxPerCaller > 0 ? cfg.scheduler.maxPerCaller : undefined;
}

