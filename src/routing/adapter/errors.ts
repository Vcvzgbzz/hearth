/**
 * What can go wrong while an adapter is compiled or run. Three of the four are catchable by the
 * adapter's own `try`; a limit is not, because a run that has spent its budget cannot be trusted to
 * unwind and carry on.
 *
 * Each carries a bare reason, and the caller at the edge (`index.ts`) puts the adapter's name, the
 * side and the location around it, which is the only place that knows them.
 */

import type { Value } from "./values.js";

/** The source could not be parsed. Thrown by the lexer and the parser, formatted by `compile`. */
export class ParseFail extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(reason);
    this.name = "ParseFail";
  }
}

/** A type error or a guard refusal inside the interpreter: `try` can catch it. */
export class RuntimeError extends Error {
  constructor(
    readonly reason: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(reason);
    this.name = "RuntimeError";
  }
}

/** A value adapter code threw: `try` can catch it, and it leaves the call as its own value. */
export class Thrown extends Error {
  constructor(
    readonly value: Value,
    readonly line?: number,
    readonly column?: number,
  ) {
    super("thrown value");
    this.name = "Thrown";
  }
}

/** A budget ran out. Nothing catches this: it ends the call. */
export class LimitError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "LimitError";
  }
}

/** True for the one kind of failure an adapter's `try` must not catch. */
export function isLimit(e: unknown): e is LimitError {
  return e instanceof LimitError;
}
