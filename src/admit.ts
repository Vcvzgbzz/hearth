/**
 * Every refusal a request can meet before it runs, and the status each one carries. The
 * scheduler answers "can this start now"; this answers "may it run at all", for every route.
 */
import { PeerStatusError } from "./peers.js";
import { QueueFullError, QueueTimeoutError } from "./scheduler.js";

/** A request turned away, with the status and OpenAI error type to answer it with. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: string = "invalid_request_error",
    /**
     * Extra fields for the error envelope. A degraded model needs more than a
     * sentence: the client should be able to read the reason and the bad output
     * without going to the logs.
     */
    readonly extra: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

export class BodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

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

/** May a key held to `scope` ask for `model`? By its own name, or as a variant of a type the scope names. */
export function inScope(scope: readonly string[], model: string, type: (name: string) => boolean = () => false): boolean {
  if (scope.includes(model)) return true;
  const base = model.slice(0, Math.max(0, model.lastIndexOf(":")));
  return base !== "" && scope.includes(base) && type(base);
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

/** The answer for any failure: a refusal as itself, a full queue as 429, a peer's 4xx as theirs, the rest 502. */
export function refusalOf(e: unknown): Refusal {
  if (e instanceof Refusal) return e;
  if (e instanceof BodyTooLargeError) return new Refusal(413, e.message);
  if (e instanceof QueueFullError) return new Refusal(429, e.message, "rate_limit_error");
  if (e instanceof QueueTimeoutError) return new Refusal(503, e.message, "server_error");
  if (e instanceof PeerStatusError && e.isRefusal) {
    return new Refusal(e.status, e.message, e.status === 429 ? "rate_limit_error" : "invalid_request_error");
  }
  return new Refusal(502, e instanceof Error ? e.message : String(e), "server_error");
}
