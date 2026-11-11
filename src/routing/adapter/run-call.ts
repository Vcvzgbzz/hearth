/**
 * Calling a value: the one place a function's body runs, so the call-depth cap and the step counter
 * hold for closures, for builtins and for a builtin that calls the adapter's own callbacks (`map`,
 * `sort`, and the rest).
 */

import type { Pos } from "./ast.js";
import { RuntimeError } from "./errors.js";
import type { Machine } from "./machine.js";
import { Env, type Value, isCallable, show } from "./values.js";
import { type Stmt, type Expr } from "./ast.js";
import { evalExpr } from "./run-expr.js";
import { runStmt } from "./run-stmt.js";

/** Call `callee` with `args`. A non-function is a type error the adapter's `try` may catch. */
export function callValue(m: Machine, callee: Value, args: Value[], at: Pos): Value {
  if (!isCallable(callee)) throw new RuntimeError(`${show(callee)} is not a function`, at.line, at.column);
  m.enter();
  try {
    if (callee.t === "native") return callee.call(m, args, at);
    const env = new Env(callee.env);
    for (let i = 0; i < callee.params.length; i += 1) env.declare(callee.params[i]!, args[i], true);
    if (callee.exprBody) return evalExpr(m, callee.body as Expr, env);
    const flow = runStmt(m, callee.body as Stmt, env);
    return flow.t === "return" ? flow.value : undefined;
  } finally {
    m.leave();
  }
}
