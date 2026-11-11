/**
 * Evaluating an expression. Every step of it goes through the machine, so a run that wanders
 * (`while (true)`, a comparator that never ends, a callback 256 deep) is stopped by a budget rather
 * than by the host. Reads and writes go through the value layer, which is where the property-name
 * guard lives.
 */

import type { BinOp, Expr, Pos, Prop, Spread } from "./ast.js";
import { LimitError, RuntimeError } from "./errors.js";
import { LIMITS, type Machine } from "./machine.js";
import { methodOf } from "./builtins.js";
import { callValue } from "./run-call.js";
import {
  Env,
  type Value,
  guarded,
  getIndex,
  getOwn,
  makeClosure,
  errorValue,
  newArray,
  newObject,
  setIndex,
  setOwn,
  show,
  strictEquals,
  toNumber,
  toText,
  truthy,
  typeOf,
} from "./values.js";

/** Evaluate one expression. */
export function evalExpr(m: Machine, e: Expr, env: Env): Value {
  m.tick();
  switch (e.t) {
    case "num":
      return e.value;
    case "str":
      return m.text(e.value);
    case "bool":
      return e.value;
    case "null":
      return null;
    case "undef":
      return undefined;
    case "tmpl": {
      let out = e.quasis[0] ?? "";
      for (let i = 0; i < e.parts.length; i += 1) {
        out += toText(evalExpr(m, e.parts[i]!, env));
        out += e.quasis[i + 1] ?? "";
        if (out.length > LIMITS.chars) throw new LimitError(`string too long (${LIMITS.chars} characters)`);
      }
      return m.text(out);
    }
    case "ident": {
      const found = env.lookup(e.name);
      if (found === undefined) throw new RuntimeError(`${e.name} is not defined`, e.line, e.column);
      return found.value;
    }
    case "array":
      return arrayLiteral(m, e.items, env);
    case "object":
      return objectLiteral(m, e.props, env);
    case "member": {
      const base = evalExpr(m, e.obj, env);
      if (e.optional && isNullish(base)) return undefined;
      const key = e.computed ? keyOf(evalExpr(m, e.key, env), e) : literalKey(e.key);
      return readMember(base, key, e);
    }
    case "call": {
      if (e.callee.t === "member") {
        const member = e.callee;
        const recv = evalExpr(m, member.obj, env);
        if (member.optional && isNullish(recv)) return undefined;
        const key = member.computed ? keyOf(evalExpr(m, member.key, env), member) : literalKey(member.key);
        guarded(key, member);
        if (!isNullish(recv)) {
          const method = methodOf(recv, key);
          if (method !== undefined) return method(m, recv, argsOf(m, e.args, env), e);
        }
        const fn = readMember(recv, key, member);
        if (isNullish(fn) && e.optional) return undefined;
        return callValue(m, fn, argsOf(m, e.args, env), e);
      }
      const fn = evalExpr(m, e.callee, env);
      if (e.optional && isNullish(fn)) return undefined;
      return callValue(m, fn, argsOf(m, e.args, env), e);
    }
    case "unary": {
      // `typeof` of a name nothing declared is "undefined", as in JavaScript; it does not throw.
      if (e.op === "typeof" && e.arg.t === "ident" && env.lookup(e.arg.name) === undefined) return "undefined";
      const v = evalExpr(m, e.arg, env);
      if (e.op === "!") return !truthy(v);
      if (e.op === "typeof") return typeOf(v);
      if (e.op === "-") return -toNumber(v);
      return toNumber(v);
    }
    case "binary": {
      if (e.op === "&&") {
        const left = evalExpr(m, e.left, env);
        return truthy(left) ? evalExpr(m, e.right, env) : left;
      }
      if (e.op === "||") {
        const left = evalExpr(m, e.left, env);
        return truthy(left) ? left : evalExpr(m, e.right, env);
      }
      if (e.op === "??") {
        const left = evalExpr(m, e.left, env);
        return isNullish(left) ? evalExpr(m, e.right, env) : left;
      }
      const left = evalExpr(m, e.left, env);
      const right = evalExpr(m, e.right, env);
      return binary(m, e.op, left, right, e);
    }
    case "ternary":
      return truthy(evalExpr(m, e.test, env)) ? evalExpr(m, e.then, env) : evalExpr(m, e.alt, env);
    case "arrow":
      return makeClosure(null, e.params, e.body, e.exprBody, env);
    case "error":
      return errorValue(toText(evalExpr(m, e.arg, env)));
    case "assign":
      return assign(m, e, env);
  }
}

const isNullish = (v: Value): boolean => v === null || v === undefined;

function argsOf(m: Machine, args: Expr[], env: Env): Value[] {
  return args.map((a) => evalExpr(m, a, env));
}

function literalKey(e: Expr): string {
  return e.t === "str" ? e.value : "";
}

function keyOf(v: Value, at: Pos): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  throw new RuntimeError(`a property name must be a string or a number, not ${show(v)}`, at.line, at.column);
}

function isIndex(key: string): boolean {
  if (key === "" || key.length > 15) return false;
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && String(n) === key;
}

function arrayLiteral(m: Machine, items: (Expr | Spread)[], env: Env): Value {
  const arr = newArray();
  for (const item of items) {
    if (item.t !== "spread") {
      m.cell(arr.items.length + 1);
      arr.items.push(evalExpr(m, item, env));
      continue;
    }
    const from = evalExpr(m, item.arg, env);
    if (typeof from === "string") {
      for (let i = 0; i < from.length; i += 1) {
        m.cell(arr.items.length + 1);
        arr.items.push(m.text(from[i]!));
      }
      continue;
    }
    if (typeof from === "object" && from !== null && from.t === "array") {
      for (const v of from.items) {
        m.cell(arr.items.length + 1);
        arr.items.push(v);
      }
      continue;
    }
    throw new RuntimeError(`${show(from)} cannot be spread into an array`, item.line, item.column);
  }
  return arr;
}

function objectLiteral(m: Machine, props: Prop[], env: Env): Value {
  const obj = newObject();
  for (const prop of props) {
    if (prop.t === "pSpread") {
      const from = evalExpr(m, prop.arg, env);
      if (typeof from !== "object" || from === null || (from.t !== "object" && from.t !== "array")) {
        throw new RuntimeError(`${show(from)} cannot be spread into an object`, prop.line, prop.column);
      }
      if (from.t === "array") {
        for (let i = 0; i < from.items.length; i += 1) {
          m.take(8);
          obj.entries.set(String(i), from.items[i]);
        }
        continue;
      }
      for (const [key, value] of from.entries) {
        guarded(key, prop);
        m.take(8);
        obj.entries.set(key, value);
      }
      continue;
    }
    const value = evalExpr(m, prop.value, env);
    m.take(8);
    obj.entries.set(prop.key, value);
  }
  return obj;
}

/** Read a property of a value, refusing the guard's names before the read. */
export function readMember(base: Value, key: string, at: Pos): Value {
  guarded(key, at);
  if (base === null || base === undefined) {
    throw new RuntimeError(`cannot read ${key} of ${show(base)}`, at.line, at.column);
  }
  if (typeof base === "string") return key === "length" ? base.length : undefined;
  if (typeof base === "number" || typeof base === "boolean") return undefined;
  if (base.t === "array") {
    if (key === "length") return base.items.length;
    return isIndex(key) ? getIndex(base, Number(key), at) : undefined;
  }
  if (base.t === "object") return getOwn(base, key, at);
  return undefined;
}

function setMember(m: Machine, base: Value, key: string, value: Value, at: Pos): void {
  guarded(key, at);
  if (base === null || base === undefined) throw new RuntimeError(`cannot set ${key} of ${show(base)}`, at.line, at.column);
  if (typeof base === "string") throw new RuntimeError("a string cannot be changed", at.line, at.column);
  if (typeof base === "number" || typeof base === "boolean") {
    throw new RuntimeError(`cannot set a property on ${show(base)}`, at.line, at.column);
  }
  if (base.t === "array") {
    if (!isIndex(key)) throw new RuntimeError(`an array has no property named ${key}`, at.line, at.column);
    const index = Number(key);
    if (index >= base.items.length) m.cell(index + 1);
    setIndex(base, index, value, at);
    return;
  }
  if (base.t === "object") {
    if (!base.entries.has(key)) m.take(8);
    setOwn(base, key, value, at);
    return;
  }
  throw new RuntimeError(`cannot set a property on ${show(base)}`, at.line, at.column);
}

/** `+` on two values: concatenation when either side is a string, addition otherwise. */
export function addValues(m: Machine, left: Value, right: Value): Value {
  if (typeof left === "string" || typeof right === "string") return m.text(toText(left) + toText(right));
  return toNumber(left) + toNumber(right);
}

function binary(m: Machine, op: BinOp, left: Value, right: Value, at: Pos): Value {
  switch (op) {
    case "+":
      return addValues(m, left, right);
    case "-":
      return toNumber(left) - toNumber(right);
    case "*":
      return toNumber(left) * toNumber(right);
    case "/":
      return toNumber(left) / toNumber(right);
    case "%":
      return toNumber(left) % toNumber(right);
    case "===":
      return strictEquals(left, right);
    case "!==":
      return !strictEquals(left, right);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compare(op, left, right);
    default:
      throw new RuntimeError(`unknown operator ${op}`, at.line, at.column);
  }
}

function compare(op: "<" | "<=" | ">" | ">=", left: Value, right: Value): boolean {
  if (typeof left === "string" && typeof right === "string") {
    if (op === "<") return left < right;
    if (op === "<=") return left <= right;
    if (op === ">") return left > right;
    return left >= right;
  }
  const a = toNumber(left);
  const b = toNumber(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  if (op === ">") return a > b;
  return a >= b;
}

function assign(m: Machine, e: Expr & { t: "assign" }, env: Env): Value {
  const { target } = e;
  if (target.t === "ident") {
    const found = env.lookup(target.name);
    if (found === undefined) throw new RuntimeError(`${target.name} is not defined`, e.line, e.column);
    const next = e.op === "=" ? evalExpr(m, e.value, env) : compound(m, e.op, found.value, evalExpr(m, e.value, env));
    if (!found.mutable) throw new RuntimeError(`cannot assign to ${target.name}, which a call may not change`, e.line, e.column);
    found.value = next;
    return next;
  }
  if (target.t === "member") {
    const base = evalExpr(m, target.obj, env);
    if (target.optional && isNullish(base)) return undefined;
    const key = target.computed ? keyOf(evalExpr(m, target.key, env), target) : literalKey(target.key);
    const current = e.op === "=" ? undefined : readMember(base, key, target);
    const written = evalExpr(m, e.value, env);
    const next = e.op === "=" ? written : compound(m, e.op, current, written);
    setMember(m, base, key, next, target);
    return next;
  }
  throw new RuntimeError("that is not something that can be assigned to", e.line, e.column);
}

function compound(m: Machine, op: "+=" | "-=", left: Value, right: Value): Value {
  if (op === "+=") return addValues(m, left, right);
  return toNumber(left) - toNumber(right);
}
