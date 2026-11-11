/**
 * The values an adapter's code can hold, and the rules that keep them plain data.
 *
 * A value is a number, a string, a boolean, null, undefined, an array, a map of named values, or a
 * function the interpreter itself made. Nothing here wraps a host object: the interpreter's own
 * arrays and objects hold only other values, so no JavaScript prototype or constructor is reachable
 * from adapter code.
 *
 * The three names `__proto__`, `constructor` and `prototype` are refused on every path: reading,
 * writing, a computed key, a spread, and a key that arrives through `JSON.parse`. Objects are maps,
 * so those names would mean nothing here anyway; refusing them keeps a value that leaves the
 * interpreter from becoming a prototype mutation somewhere that does honour them.
 */

import type { Expr, Pos, Stmt } from "./ast.js";
import { RuntimeError } from "./errors.js";
import type { Machine } from "./machine.js";

/** A named value a function or a block can see. */
export interface Binding {
  value: Value;
  mutable: boolean;
}

/** One lexical scope. A closure keeps the scope it was made in, so its variables stay reachable. */
export class Env {
  private readonly vars = new Map<string, Binding>();

  constructor(readonly parent: Env | null) {}

  /** Declare a name in this scope; a second declaration of the same name is a type error. */
  declare(name: string, value: Value, mutable: boolean): void {
    if (this.vars.has(name)) throw new RuntimeError(`${name} is already declared`);
    this.vars.set(name, { value, mutable });
  }

  /** The binding `name` names, in this scope or the nearest one above it. */
  lookup(name: string): Binding | undefined {
    for (let e: Env | null = this; e !== null; e = e.parent) {
      const found = e.vars.get(name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Whether this scope itself has `name`. */
  has(name: string): boolean {
    return this.vars.has(name);
  }

  /** This scope's own names, for freezing the module's top level and for the exported sides. */
  own(): IterableIterator<[string, Binding]> {
    return this.vars.entries();
  }
}

/** An array value. `frozen` marks a value that belongs to the module, which no call may change. */
export interface VArray {
  readonly t: "array";
  items: Value[];
  frozen: boolean;
}

/** A plain object: a map of names to values, with no prototype of its own to fall through to. */
export interface VObject {
  readonly t: "object";
  entries: Map<string, Value>;
  frozen: boolean;
  /** True for `new Error(...)`, so a thrown error can be reported by its message. */
  isError: boolean;
}

/** A function made by the interpreter: its parameters, its body, and the scope it closed over. */
export interface Closure {
  readonly t: "closure";
  readonly name: string | null;
  readonly params: string[];
  readonly body: Expr | Stmt;
  readonly exprBody: boolean;
  readonly env: Env;
}

/** A function the interpreter provides, such as `JSON.parse` or `map`. */
export interface Native {
  readonly t: "native";
  readonly name: string;
  readonly call: (m: Machine, args: Value[], at: Pos) => Value;
}

/** Everything adapter code can hold. */
export type Value = undefined | null | boolean | number | string | VArray | VObject | Closure | Native;

export const newArray = (): VArray => ({ t: "array", items: [], frozen: false });
export const newObject = (): VObject => ({ t: "object", entries: new Map(), frozen: false, isError: false });

/** The value `new Error(message)` makes. */
export function errorValue(message: string): VObject {
  const o = newObject();
  o.entries.set("message", message);
  o.isError = true;
  return o;
}

// --- the property-name guard -------------------------------------------------

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** True when `key` may be used as a property name at all. */
export function keyAllowed(key: string): boolean {
  return !FORBIDDEN.has(key);
}

/** Refuse `key` unless the language allows it, naming the place it was used. */
export function guarded(key: string, at?: Pos): string {
  if (!keyAllowed(key)) {
    throw new RuntimeError(`"${key}" is not a property name the adapter language allows`, at?.line, at?.column);
  }
  return key;
}

function writable(v: VArray | VObject, at?: Pos): void {
  if (v.frozen) throw new RuntimeError("cannot change a value that belongs to the module", at?.line, at?.column);
}

// --- reading and writing ----------------------------------------------------

/** The value of `key` in an object, or undefined. The guard runs before the lookup. */
export function getOwn(obj: VObject, key: string, at?: Pos): Value {
  guarded(key, at);
  return obj.entries.get(key);
}

/** Set `key` in an object. Refuses a guarded name, and refuses any write to a frozen value. */
export function setOwn(obj: VObject, key: string, value: Value, at?: Pos): void {
  guarded(key, at);
  writable(obj, at);
  obj.entries.set(key, value);
}

/** The `index`th item of an array, or undefined past the end. */
export function getIndex(a: VArray, index: number, at?: Pos): Value {
  if (!Number.isInteger(index) || index < 0) {
    throw new RuntimeError(`an array index must be a whole number from 0, not ${index}`, at?.line, at?.column);
  }
  return a.items[index];
}

/** Set the `index`th item of an array, refusing a frozen array and an index past the cap. */
export function setIndex(a: VArray, index: number, value: Value, at?: Pos): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new RuntimeError(`an array index must be a whole number from 0, not ${index}`, at?.line, at?.column);
  }
  writable(a, at);
  a.items[index] = value;
}

/** Mark a module-level value, and everything reachable from it, as no call may change. */
export function deepFreeze(value: Value, depth = 0): void {
  if (depth > 512) throw new RuntimeError("a value is nested too deeply");
  if (typeof value !== "object" || value === null) return;
  if (value.t === "closure" || value.t === "native") return;
  if (value.frozen) return;
  value.frozen = true;
  if (value.t === "array") {
    for (const item of value.items) deepFreeze(item, depth + 1);
  } else {
    for (const item of value.entries.values()) deepFreeze(item, depth + 1);
  }
}

/**
 * Freeze everything a module's top level owns: its bindings, the values they hold, and the scopes
 * its closures captured while loading. A call may therefore change nothing the module started
 * with, so each call begins from the same state the load ended in.
 */
export function freezeModuleState(env: Env, seen = new Set<Env>()): void {
  for (let e: Env | null = env; e !== null; e = e.parent) {
    if (seen.has(e)) continue;
    seen.add(e);
    for (const [, binding] of e.own()) {
      binding.mutable = false;
      freezeValue(binding.value, seen, 0);
    }
  }
}

function freezeValue(value: Value, seen: Set<Env>, depth: number): void {
  if (depth > 512) throw new RuntimeError("a value is nested too deeply");
  if (typeof value !== "object" || value === null) return;
  if (value.t === "native") return;
  if (value.t === "closure") {
    freezeModuleState(value.env, seen);
    return;
  }
  if (value.frozen) return;
  value.frozen = true;
  if (value.t === "array") {
    for (const item of value.items) freezeValue(item, seen, depth + 1);
  } else {
    for (const item of value.entries.values()) freezeValue(item, seen, depth + 1);
  }
}

// --- how a value behaves in the language ------------------------------------

/** The `typeof` of a value, as JavaScript names the language's own types. */
export function typeOf(v: Value): string {
  if (v === undefined) return "undefined";
  if (v === null) return "object";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (v.t === "closure" || v.t === "native") return "function";
  return "object";
}

/** What is on the left of an operator that needed a function: `undefined is not a function`. */
export function show(v: Value): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v.t === "array") return "an array";
  if (v.t === "object") return v.isError ? "an Error" : "an object";
  return "a function";
}

/** True when a value is truthy, by JavaScript's rules, which is what `if` and `&&` use. */
export function truthy(v: Value): boolean {
  if (v === false || v === undefined || v === null) return false;
  if (v === 0) return false;
  if (v === "") return false;
  if (typeof v === "number") return !Number.isNaN(v);
  return true;
}

/** JavaScript's `String(v)`, used by `+` with a string on either side, by template strings, and by `String()`. */
export function toText(v: Value, depth = 0): string {
  if (depth > 512) throw new RuntimeError("a value is nested too deeply");
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v.t === "array") return v.items.map((item) => (item === null || item === undefined ? "" : toText(item, depth + 1))).join(",");
  if (v.t === "object") return v.isError ? `Error: ${toText(v.entries.get("message") ?? "", depth + 1)}` : "[object Object]";
  return "function";
}

/** JavaScript's `Number(v)`: NaN for anything an adapter should not have added up. */
export function toNumber(v: Value): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null) return 0;
  if (v === undefined) return Number.NaN;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? 0 : Number(t);
  }
  return Number.NaN;
}

/** Strict equality (`===`): type and value both, and identity for the values that have no other. */
export function strictEquals(a: Value, b: Value): boolean {
  if (a === b) return typeof a !== "number" || !Number.isNaN(a);
  if (typeof a !== typeof b) return false;
  return false;
}

/** A function the interpreter made: its parameters, its body, and the scope it closed over. */
export function makeClosure(name: string | null, params: string[], body: Expr | Stmt, exprBody: boolean, env: Env): Closure {
  return { t: "closure", name, params, body, exprBody, env };
}

/** True for a value that can be called. */
export function isCallable(v: Value): v is Closure | Native {
  return typeof v === "object" && v !== null && (v.t === "closure" || v.t === "native");
}
