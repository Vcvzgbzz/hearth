/**
 * The interpreter's front door: `compile(name, code)` turns adapter source into a module, and
 * `call(module, side, args, timeoutMs)` runs one of its sides on plain JSON data.
 *
 * Everything here is synchronous. The budgets are the interpreter's own, so a call that will not
 * finish is stopped by its own loop rather than by an interrupt from outside.
 */

import type { Program } from "./ast.js";
import { installGlobals } from "./builtins.js";
import { LimitError, ParseFail, RuntimeError, Thrown } from "./errors.js";
import { LOAD_MS, Machine, valuesIn, valuesOut } from "./machine.js";
import { parse } from "./parse.js";
import { callValue } from "./run-call.js";
import { evalExpr } from "./run-expr.js";
import { Env, type Value, freezeModuleState, isCallable, makeClosure, toText } from "./values.js";

/** The two sides a module may have. */
export type Side = "request" | "response";

/** A compiled adapter module: its top-level scope, with the sides it defines. */
export interface AdapterModule {
  readonly name: string;
  readonly code: string;
  readonly sides: { readonly request?: Value; readonly response?: Value };
}

/** Compile `code` as the module `name`. Throws what is wrong with it when it could never run. */
export function compile(name: string, code: string): AdapterModule {
  let program: Program;
  try {
    program = parse(code);
  } catch (e) {
    if (e instanceof ParseFail) throw new Error(`adapter ${name}: parse error at line ${e.line}, column ${e.column}: ${e.reason}`);
    throw e;
  }

  const m = new Machine(name, "loading", LOAD_MS);
  const globals = new Env(null);
  installGlobals(globals);
  const scope = new Env(globals);
  try {
    load(m, program, scope);
  } catch (e) {
    throw new Error(format(name, "loading", e));
  }

  const sides: { request?: Value; response?: Value } = {};
  for (const side of ["request", "response"] as const) {
    const found = scope.lookup(side);
    if (found === undefined) continue;
    if (!isCallable(found.value)) throw new Error(`adapter ${name}: ${side} is not a function`);
    sides[side] = found.value;
  }
  if (sides.request === undefined && sides.response === undefined) {
    throw new Error(`adapter ${name}: exports neither request nor response`);
  }

  // A call may change nothing the module owns, so every top-level value is frozen once, here.
  freezeModuleState(scope);
  return { name, code, sides };
}

/**
 * Call one side of a module: `args` are copied in as JSON data, and what it returns is copied out.
 * `undefined` when the module does not define that side, so the caller passes the side through.
 */
export function call(module: AdapterModule, side: Side, args: readonly unknown[], timeoutMs: number): unknown {
  const fn = module.sides[side];
  if (fn === undefined) return undefined;
  const m = new Machine(module.name, side, timeoutMs);
  const here = { line: 1, column: 1 };
  const tooBig = side === "request" ? "the request is too large to adapt" : "the answer is too large to adapt";
  try {
    const given = args.map((arg) => valuesIn(m, arg, here, tooBig));
    return valuesOut(callValue(m, fn, given, here));
  } catch (e) {
    throw new Error(format(module.name, side, e));
  }
}

/** Declare the module's functions first, so a `const` may mention one written below it. */
function load(m: Machine, program: Program, scope: Env): void {
  for (const decl of program.body) {
    if (decl.t === "func") scope.declare(decl.name, makeClosure(decl.name, decl.params, decl.body, false, scope), true);
  }
  for (const decl of program.body) {
    if (decl.t === "const") scope.declare(decl.name, evalExpr(m, decl.init, scope), false);
  }
}

/** The message a failure is reported with: `adapter <name> <side>(): <reason> (line N, column M)`. */
function format(name: string, side: string, e: unknown): string {
  const prefix = `adapter ${name} ${side}():`;
  if (e instanceof LimitError) return `${prefix} ${e.reason}`;
  if (e instanceof RuntimeError) return `${prefix} ${e.reason}${where(e.line, e.column)}`;
  if (e instanceof Thrown) return `${prefix} ${thrownText(e.value)}${where(e.line, e.column)}`;
  if (e instanceof RangeError) return `${prefix} the code recursed too deeply`;
  if (e instanceof Error) return `${prefix} ${e.message}`;
  return `${prefix} ${String(e)}`;
}

function where(line?: number, column?: number): string {
  return typeof line === "number" && typeof column === "number" && line > 0 ? ` (line ${line}, column ${column})` : "";
}

/** What a thrown value says: an Error's message, or the value itself when it is a string. */
function thrownText(v: Value): string {
  if (typeof v === "object" && v !== null && v.t === "object" && v.isError) return toText(v.entries.get("message") ?? "");
  return toText(v);
}
