/**
 * Every way a request can be turned away or fail before it is answered, and the status each one is
 * answered with. Imports nothing, so any layer can throw these.
 */

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

export class QueueFullError extends Error {
  constructor(
    public readonly reason: "caller_cap" | "lane_full" | "key_full",
    public readonly lane: string,
  ) {
    super(
      reason === "caller_cap"
        ? `too many concurrent jobs in the ${lane} lane`
        : reason === "key_full"
          ? `this key's queue is full in the ${lane} lane`
          : `the ${lane} queue is full`,
    );
    this.name = "QueueFullError";
  }
}

export class QueueTimeoutError extends Error {
  constructor(
    public readonly lane: string,
    public readonly waitMs: number,
  ) {
    super(`nothing in the ${lane} lane started for ${Math.round(waitMs / 1000)}s`);
    this.name = "QueueTimeoutError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

/**
 * A peer's refusal, with its status kept: callers retry a 5xx and must not retry a 4xx, so a
 * peer's 429 reported as 502 turns a rate limit into a retry storm.
 */
export class PeerStatusError extends Error {
  constructor(
    readonly peer: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`peer ${peer} returned ${status}: ${detail}`);
    this.name = "PeerStatusError";
  }

  /** True when the peer refused the REQUEST rather than failing to serve it.
   *  Passed through to our caller unchanged: a refusal is theirs to explain,
   *  and re-badging it as our failure loses what the caller should do next. */
  get isRefusal(): boolean {
    return this.status >= 400 && this.status < 500;
  }
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
