/**
 * Running a statement. Control flow is a signal returned to the caller (`return`, `break`,
 * `continue`) rather than a host exception, so a `finally` always gets its turn; only a thrown value
 * and a type error are host exceptions, and the two limits — a spent budget and a broken guard —
 * are the ones `finally` must not run for.
 */

import type { Stmt } from "./ast.js";
import { RuntimeError, Thrown, isLimit } from "./errors.js";
import { type Machine } from "./machine.js";
import { Env, type Value, errorValue, makeClosure, show, truthy } from "./values.js";
import { evalExpr } from "./run-expr.js";

export type Flow = { t: "normal" } | { t: "return"; value: Value } | { t: "break" } | { t: "continue" };

const NORMAL: Flow = { t: "normal" };

/** Run one statement in `env`, reporting how control left it. */
export function runStmt(m: Machine, s: Stmt, env: Env): Flow {
  m.tick();
  switch (s.t) {
    case "block": {
      const inner = new Env(env);
      for (const statement of s.body) {
        const flow = runStmt(m, statement, inner);
        if (flow.t !== "normal") return flow;
      }
      return NORMAL;
    }
    case "empty":
      return NORMAL;
    case "let": {
      const value = evalExpr(m, s.init, env);
      if (env.has(s.name)) throw new RuntimeError(`${s.name} is already declared`, s.line, s.column);
      env.declare(s.name, value, s.mutable);
      return NORMAL;
    }
    case "expr":
      evalExpr(m, s.e, env);
      return NORMAL;
    case "if":
      if (truthy(evalExpr(m, s.test, env))) return runStmt(m, s.then, env);
      return s.alt === null ? NORMAL : runStmt(m, s.alt, env);
    case "while":
      return loop(m, s, env);
    case "forOf":
      return forOf(m, s, env);
    case "break":
      return { t: "break" };
    case "continue":
      return { t: "continue" };
    case "return":
      return { t: "return", value: s.arg === null ? undefined : evalExpr(m, s.arg, env) };
    case "throw":
      throw new Thrown(evalExpr(m, s.arg, env), s.line, s.column);
    case "try":
      return tryStmt(m, s, env);
    case "func": {
      if (env.has(s.name)) throw new RuntimeError(`${s.name} is already declared`, s.line, s.column);
      env.declare(s.name, makeClosure(s.name, s.params, s.body, false, env), true);
      return NORMAL;
    }
  }
}

function loop(m: Machine, s: Stmt & { t: "while" }, env: Env): Flow {
  for (;;) {
    m.tick();
    if (!truthy(evalExpr(m, s.test, env))) return NORMAL;
    const flow = runStmt(m, s.body, env);
    if (flow.t === "return") return flow;
    if (flow.t === "break") return NORMAL;
  }
}

function forOf(m: Machine, s: Stmt & { t: "forOf" }, env: Env): Flow {
  const iterable = evalExpr(m, s.iter, env);
  if (typeof iterable === "string") {
    for (let i = 0; i < iterable.length; i += 1) {
      m.tick();
      const flow = iteration(m, s, env, m.text(iterable[i]!));
      if (flow.t === "return") return flow;
      if (flow.t === "break") return NORMAL;
    }
    return NORMAL;
  }
  if (typeof iterable === "object" && iterable !== null && iterable.t === "array") {
    for (let i = 0; i < iterable.items.length; i += 1) {
      m.tick();
      const flow = iteration(m, s, env, iterable.items[i]);
      if (flow.t === "return") return flow;
      if (flow.t === "break") return NORMAL;
    }
    return NORMAL;
  }
  throw new RuntimeError(`${show(iterable)} is not something a for...of loop can go through`, s.line, s.column);
}

function iteration(m: Machine, s: Stmt & { t: "forOf" }, env: Env, value: Value): Flow {
  const inner = new Env(env);
  inner.declare(s.name, value, s.mutable);
  return runStmt(m, s.body, inner);
}

function tryStmt(m: Machine, s: Stmt & { t: "try" }, env: Env): Flow {
  let flow: Flow = NORMAL;
  let pending: unknown = null;
  let failed = false;
  try {
    flow = runStmt(m, s.block, new Env(env));
  } catch (e) {
    if (isLimit(e)) throw e;
    if (s.handler === null) {
      pending = e;
      failed = true;
    } else {
      try {
        flow = catchBlock(m, s, env, e);
      } catch (again) {
        if (isLimit(again)) throw again;
        pending = again;
        failed = true;
      }
    }
  }
  if (s.finalizer !== null) {
    const last = runStmt(m, s.finalizer, new Env(env));
    if (last.t !== "normal") return last;
  }
  if (failed) throw pending;
  return flow;
}

function catchBlock(m: Machine, s: Stmt & { t: "try" }, env: Env, e: unknown): Flow {
  const inner = new Env(env);
  if (s.param !== null) inner.declare(s.param, caught(e), true);
  if (s.handler === null) throw e;
  return runStmt(m, s.handler, inner);
}

/** The value a `catch` binds: the thrown value itself, or an error object for a type error. */
function caught(e: unknown): Value {
  if (e instanceof Thrown) return e.value;
  if (e instanceof RuntimeError) return errorValue(e.reason);
  if (e instanceof Error) return errorValue(e.message);
  return errorValue(String(e));
}
