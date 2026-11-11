/**
 * The builtin whitelist: the only names adapter code can reach besides its own.
 *
 * Everything here is either a pure function of its arguments or a walk over an array that calls a
 * callback **through the evaluator**, so a callback that never ends is still stopped by the step
 * budget. A native call made in one piece (`JSON.parse`, `split`, `join`) is bounded by its input
 * size, which is checked before it runs: no native function ever starts on data bigger than the
 * language's caps.
 */

import type { Pos } from "./ast.js";
import { LimitError, RuntimeError } from "./errors.js";
import { LIMITS, type Machine, valuesIn } from "./machine.js";
import { callValue } from "./run-call.js";
import {
  Env,
  type Closure,
  type Native,
  type Value,
  type VArray,
  type VObject,
  deepFreeze,
  errorValue,
  guarded,
  isCallable,
  newArray,
  newObject,
  setIndex,
  show,
  strictEquals,
  toNumber,
  toText,
  truthy,
} from "./values.js";

/** A method of a string or an array, called with its receiver. */
export type Method = (m: Machine, recv: Value, args: Value[], at: Pos) => Value;

// --- argument helpers -------------------------------------------------------

function textArg(v: Value, what: string, at: Pos): string {
  if (typeof v !== "string") throw new RuntimeError(`${what} must be a string, not ${show(v)}`, at.line, at.column);
  return v;
}

function callableArg(v: Value, what: string, at: Pos): Closure | Native {
  if (!isCallable(v)) throw new RuntimeError(`${what} must be a function, not ${show(v)}`, at.line, at.column);
  return v;
}

function objectArg(v: Value, what: string, at: Pos): VObject {
  if (typeof v !== "object" || v === null || v.t !== "object") {
    throw new RuntimeError(`${what} must be an object, not ${show(v)}`, at.line, at.column);
  }
  return v;
}

function arrayArg(v: Value, what: string, at: Pos): VArray {
  if (typeof v !== "object" || v === null || v.t !== "array") {
    throw new RuntimeError(`${what} must be an array, not ${show(v)}`, at.line, at.column);
  }
  return v;
}

/** A `slice()` index: JavaScript's rule, where NaN counts as 0. */
function sliceIndex(v: Value): number {
  const n = Math.trunc(toNumber(v));
  return Number.isNaN(n) ? 0 : n;
}

// --- string methods ---------------------------------------------------------

const STRING_METHODS: Record<string, Method> = {
  split: (m, recv, args) => {
    const s = recv as string;
    const out = newArray();
    const sep = args[0] === undefined ? null : toText(args[0]);
    if (sep === null) {
      m.cell(1);
      out.items.push(m.text(s));
      return out;
    }
    if (sep === "") {
      for (let i = 0; i < s.length; i += 1) {
        m.cell(out.items.length + 1);
        out.items.push(m.text(s[i]!));
      }
      return out;
    }
    let start = 0;
    for (;;) {
      m.tick();
      const found = s.indexOf(sep, start);
      const end = found === -1 ? s.length : found;
      m.cell(out.items.length + 1);
      out.items.push(m.text(s.slice(start, end)));
      if (found === -1) return out;
      start = found + sep.length;
    }
  },
  slice: (m, recv, args) => {
    const s = recv as string;
    const start = sliceIndex(args[0]);
    const end = args[1] === undefined ? undefined : sliceIndex(args[1]);
    return m.text(s.slice(start, end));
  },
  trim: (m, recv) => m.text((recv as string).trim()),
  toLowerCase: (m, recv) => m.text((recv as string).toLowerCase()),
  toUpperCase: (m, recv) => m.text((recv as string).toUpperCase()),
  startsWith: (_m, recv, args) => (recv as string).startsWith(toText(args[0])),
  endsWith: (_m, recv, args) => (recv as string).endsWith(toText(args[0])),
  includes: (_m, recv, args) => (recv as string).includes(toText(args[0])),
  indexOf: (_m, recv, args) => (recv as string).indexOf(toText(args[0])),
  replaceAll: (m, recv, args) => {
    const s = recv as string;
    const old = toText(args[0]);
    const fresh = toText(args[1]);
    if (old === "") {
      let out = fresh;
      for (let i = 0; i < s.length; i += 1) {
        m.tick();
        out += s[i]! + fresh;
        if (out.length > LIMITS.chars) throw new LimitError(`string too long (${LIMITS.chars} characters)`);
      }
      return m.text(out);
    }
    let out = "";
    let start = 0;
    for (;;) {
      m.tick();
      const found = s.indexOf(old, start);
      if (found === -1) {
        out += s.slice(start);
        if (out.length > LIMITS.chars) throw new LimitError(`string too long (${LIMITS.chars} characters)`);
        return m.text(out);
      }
      out += s.slice(start, found) + fresh;
      if (out.length > LIMITS.chars) throw new LimitError(`string too long (${LIMITS.chars} characters)`);
      start = found + old.length;
    }
  },
  padStart: (m, recv, args) => {
    const s = recv as string;
    const length = Math.trunc(toNumber(args[0]));
    const fill = args[1] === undefined ? " " : toText(args[1]);
    if (!Number.isFinite(length) || length <= s.length || fill === "") return m.text(s);
    if (length > LIMITS.chars) throw new LimitError(`string too long (${LIMITS.chars} characters)`);
    return m.text(s.padStart(length, fill));
  },
  charAt: (m, recv, args) => {
    const s = recv as string;
    const i = Math.trunc(toNumber(args[0]));
    if (!Number.isInteger(i) || i < 0 || i >= s.length) return "";
    return m.text(s[i]!);
  },
};

// --- array methods ----------------------------------------------------------

const ARRAY_METHODS: Record<string, Method> = {
  map: (m, recv, args, at) => {
    const a = recv as VArray;
    const fn = callableArg(args[0], "map's callback", at);
    const count = a.items.length;
    const out = newArray();
    for (let i = 0; i < count; i += 1) {
      m.tick();
      m.cell(out.items.length + 1);
      out.items.push(callValue(m, fn, [a.items[i], i], at));
    }
    return out;
  },
  filter: (m, recv, args, at) => {
    const a = recv as VArray;
    const fn = callableArg(args[0], "filter's callback", at);
    const count = a.items.length;
    const out = newArray();
    for (let i = 0; i < count; i += 1) {
      m.tick();
      if (truthy(callValue(m, fn, [a.items[i], i], at))) {
        m.cell(out.items.length + 1);
        out.items.push(a.items[i]);
      }
    }
    return out;
  },
  find: (m, recv, args, at) => {
    const a = recv as VArray;
    const fn = callableArg(args[0], "find's callback", at);
    const count = a.items.length;
    for (let i = 0; i < count; i += 1) {
      m.tick();
      if (truthy(callValue(m, fn, [a.items[i], i], at))) return a.items[i];
    }
    return undefined;
  },
  findIndex: (m, recv, args, at) => {
    const a = recv as VArray;
    const fn = callableArg(args[0], "findIndex's callback", at);
    const count = a.items.length;
    for (let i = 0; i < count; i += 1) {
      m.tick();
      if (truthy(callValue(m, fn, [a.items[i], i], at))) return i;
    }
    return -1;
  },
  some: (m, recv, args, at) => {
    const a = recv as VArray;
    const fn = callableArg(args[0], "some's callback", at);
    const count = a.items.length;
    for (let i = 0; i < count; i += 1) {
      m.tick();
      if (truthy(callValue(m, fn, [a.items[i], i], at))) return true;
    }
    return false;
  },
  every: (m, recv, args, at) => {
    const a = recv as VArray;
    const fn = callableArg(args[0], "every's callback", at);
    const count = a.items.length;
    for (let i = 0; i < count; i += 1) {
      m.tick();
      if (!truthy(callValue(m, fn, [a.items[i], i], at))) return false;
    }
    return true;
  },
  reduce: (m, recv, args, at) => {
    const a = recv as VArray;
    const fn = callableArg(args[0], "reduce's callback", at);
    const count = a.items.length;
    let acc: Value;
    let start: number;
    if (args.length >= 2) {
      acc = args[1];
      start = 0;
    } else {
      if (count === 0) throw new RuntimeError("reduce of an empty array with no starting value", at.line, at.column);
      acc = a.items[0];
      start = 1;
    }
    for (let i = start; i < count; i += 1) {
      m.tick();
      acc = callValue(m, fn, [acc, a.items[i], i], at);
    }
    return acc;
  },
  slice: (m, recv, args) => {
    const a = recv as VArray;
    const start = sliceIndex(args[0]);
    const end = args[1] === undefined ? undefined : sliceIndex(args[1]);
    const out = newArray();
    for (const item of a.items.slice(start, end)) {
      m.cell(out.items.length + 1);
      out.items.push(item);
    }
    return out;
  },
  concat: (m, recv, args, at) => {
    const a = recv as VArray;
    const out = newArray();
    for (const item of a.items) {
      m.cell(out.items.length + 1);
      out.items.push(item);
    }
    for (const arg of args) {
      if (typeof arg === "object" && arg !== null && arg.t === "array") {
        for (const item of arg.items) {
          m.cell(out.items.length + 1);
          out.items.push(item);
        }
        continue;
      }
      if (isCallable(arg)) throw new RuntimeError("a function cannot be added to an array", at.line, at.column);
      m.cell(out.items.length + 1);
      out.items.push(arg);
    }
    return out;
  },
  includes: (_m, recv, args) => {
    const a = recv as VArray;
    for (const item of a.items) if (strictEquals(item, args[0])) return true;
    return false;
  },
  indexOf: (_m, recv, args) => {
    const a = recv as VArray;
    for (let i = 0; i < a.items.length; i += 1) if (strictEquals(a.items[i]!, args[0])) return i;
    return -1;
  },
  join: (m, recv, args) => {
    const a = recv as VArray;
    const sep = args[0] === undefined ? "," : toText(args[0]);
    let total = sep.length * Math.max(0, a.items.length - 1);
    for (const item of a.items) {
      if (item !== null && item !== undefined) total += toText(item).length;
      if (total > LIMITS.chars) throw new LimitError(`string too long (${LIMITS.chars} characters)`);
    }
    const parts: string[] = [];
    for (const item of a.items) {
      m.tick();
      parts.push(item === null || item === undefined ? "" : toText(item));
    }
    return m.text(parts.join(sep));
  },
  push: (m, recv, args, at) => {
    const a = recv as VArray;
    for (const value of args) {
      m.cell(a.items.length + 1);
      setIndex(a, a.items.length, value, at);
    }
    return a.items.length;
  },
  sort: (m, recv, args, at) => {
    const a = recv as VArray;
    const fn = callableArg(args[0], "sort's comparator", at);
    if (a.frozen) throw new RuntimeError("cannot change a value that belongs to the module", at.line, at.column);
    const compare = (x: Value, y: Value): number => {
      m.tick();
      const r = toNumber(callValue(m, fn, [x, y], at));
      if (Number.isNaN(r) || r === 0) return 0;
      return r < 0 ? -1 : 1;
    };
    a.items = mergeSort(a.items.slice(), compare);
    return a;
  },
};

/** A merge sort that asks the adapter's comparator, one tick per comparison. */
function mergeSort(items: Value[], compare: (a: Value, b: Value) => number): Value[] {
  if (items.length <= 1) return items;
  const middle = Math.floor(items.length / 2);
  const left = mergeSort(items.slice(0, middle), compare);
  const right = mergeSort(items.slice(middle), compare);
  const out: Value[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (compare(left[i]!, right[j]!) <= 0) out.push(left[i++]!);
    else out.push(right[j++]!);
  }
  while (i < left.length) out.push(left[i++]!);
  while (j < right.length) out.push(right[j++]!);
  return out;
}

/** The method `name` of a string or an array, if it has one. */
export function methodOf(recv: Value, name: string): Method | undefined {
  if (typeof recv === "string") return Object.hasOwn(STRING_METHODS, name) ? STRING_METHODS[name] : undefined;
  if (typeof recv === "object" && recv !== null && recv.t === "array") {
    return Object.hasOwn(ARRAY_METHODS, name) ? ARRAY_METHODS[name] : undefined;
  }
  return undefined;
}

// --- JSON -------------------------------------------------------------------

/** Escape one string for JSON. */
function quoted(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Serialize a value to JSON text, refusing to build one over the string cap. */
function serialize(m: Machine, v: Value, depth = 0): string {
  if (depth > LIMITS.nest) throw new RuntimeError("a value is nested too deeply");
  if (v === null) return "null";
  if (v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "string") return quoted(v);
  const grow = (out: string): string => {
    if (out.length > LIMITS.chars) throw new LimitError(`string too long (${LIMITS.chars} characters)`);
    return out;
  };
  if (v.t === "array") {
    let out = "[";
    for (let i = 0; i < v.items.length; i += 1) {
      m.tick();
      const item = v.items[i];
      out = grow(`${out}${i === 0 ? "" : ","}${item === undefined || isCallable(item) ? "null" : serialize(m, item, depth + 1)}`);
    }
    return `${out}]`;
  }
  if (v.t === "object") {
    let out = "{";
    let first = true;
    for (const [key, item] of v.entries) {
      m.tick();
      if (item === undefined || isCallable(item)) continue;
      out = grow(`${out}${first ? "" : ","}${quoted(key)}:${serialize(m, item, depth + 1)}`);
      first = false;
    }
    return `${out}}`;
  }
  return "null";
}

/** A function value the interpreter provides. */
function native(name: string, call: Native["call"]): Native {
  return { t: "native", name, call };
}

/** An object built from names and values. */
function bag(entries: Record<string, Value>): VObject {
  const o = newObject();
  for (const [key, value] of Object.entries(entries)) o.entries.set(key, value);
  return o;
}

// --- globals ----------------------------------------------------------------

/** Install the builtin whitelist into the global scope of one module. */
export function installGlobals(env: Env): void {
  env.declare(
    "JSON",
    deepFreezeValue(
      bag({
        parse: native("JSON.parse", (m, args, at) => {
          const text = textArg(args[0], "JSON.parse's argument", at);
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            throw new RuntimeError(`JSON.parse: ${e instanceof Error ? e.message : String(e)}`, at.line, at.column);
          }
          return valuesIn(m, parsed, at);
        }),
        stringify: native("JSON.stringify", (m, args) => {
          const v = args[0];
          if (v === undefined || isCallable(v)) return undefined;
          return m.text(serialize(m, v));
        }),
      }),
    ),
    false,
  );

  const math = bag({
    abs: native("Math.abs", (_m, args) => Math.abs(toNumber(args[0]))),
    ceil: native("Math.ceil", (_m, args) => Math.ceil(toNumber(args[0]))),
    floor: native("Math.floor", (_m, args) => Math.floor(toNumber(args[0]))),
    round: native("Math.round", (_m, args) => Math.round(toNumber(args[0]))),
    sqrt: native("Math.sqrt", (_m, args) => Math.sqrt(toNumber(args[0]))),
    pow: native("Math.pow", (_m, args) => Math.pow(toNumber(args[0]), toNumber(args[1]))),
    min: native("Math.min", (_m, args) => {
      let least = Number.POSITIVE_INFINITY;
      for (const arg of args) least = Math.min(least, toNumber(arg));
      return least;
    }),
    max: native("Math.max", (_m, args) => {
      let most = Number.NEGATIVE_INFINITY;
      for (const arg of args) most = Math.max(most, toNumber(arg));
      return most;
    }),
    random: native("Math.random", () => Math.random()),
    PI: Math.PI,
    E: Math.E,
  });
  env.declare("Math", deepFreezeValue(math), false);

  env.declare(
    "Object",
    deepFreezeValue(
      bag({
        keys: native("Object.keys", (m, args, at) => {
          const o = objectArg(args[0], "Object.keys's argument", at);
          const out = newArray();
          for (const key of o.entries.keys()) {
            m.cell(out.items.length + 1);
            out.items.push(m.text(key));
          }
          return out;
        }),
        values: native("Object.values", (m, args, at) => {
          const o = objectArg(args[0], "Object.values's argument", at);
          const out = newArray();
          for (const value of o.entries.values()) {
            m.cell(out.items.length + 1);
            out.items.push(value);
          }
          return out;
        }),
        entries: native("Object.entries", (m, args, at) => {
          const o = objectArg(args[0], "Object.entries's argument", at);
          const out = newArray();
          for (const [key, value] of o.entries) {
            m.cell(out.items.length + 1);
            const pair = newArray();
            m.cell(2);
            pair.items.push(m.text(key), value);
            out.items.push(pair);
          }
          return out;
        }),
        fromEntries: native("Object.fromEntries", (m, args, at) => {
          const pairs = arrayArg(args[0], "Object.fromEntries's argument", at);
          const out = newObject();
          for (const pair of pairs.items) {
            const p = arrayArg(pair, "each entry of Object.fromEntries's argument", at);
            m.take(8);
            out.entries.set(guarded(toText(p.items[0]), at), p.items[1]);
          }
          return out;
        }),
      }),
    ),
    false,
  );

  const arrayApi = bag({
    isArray: native("Array.isArray", (_m, args) => {
      const v = args[0];
      return typeof v === "object" && v !== null && v.t === "array";
    }),
  });
  env.declare("Array", deepFreezeValue(arrayApi), false);

  env.declare("Number", native("Number", (_m, args) => toNumber(args[0])), false);
  env.declare("String", native("String", (m, args) => m.text(toText(args[0]))), false);
  env.declare("Boolean", native("Boolean", (_m, args) => truthy(args[0])), false);
  env.declare(
    "parseInt",
    native("parseInt", (_m, args, at) => {
      const text = textArg(args[0], "parseInt's argument", at);
      const radix = args[1] === undefined ? 10 : Math.trunc(toNumber(args[1]));
      if (!Number.isInteger(radix) || radix < 2 || radix > 36) return Number.NaN;
      return Number.parseInt(text, radix);
    }),
    false,
  );
  env.declare("parseFloat", native("parseFloat", (_m, args, at) => Number.parseFloat(textArg(args[0], "parseFloat's argument", at))), false);
  env.declare("isNaN", native("isNaN", (_m, args) => Number.isNaN(toNumber(args[0]))), false);
  env.declare(
    "encodeURIComponent",
    native("encodeURIComponent", (m, args, at) => m.text(encodeURIComponent(textArg(args[0], "encodeURIComponent's argument", at)))),
    false,
  );
  env.declare(
    "decodeURIComponent",
    native("decodeURIComponent", (m, args, at) => {
      const text = textArg(args[0], "decodeURIComponent's argument", at);
      try {
        return m.text(decodeURIComponent(text));
      } catch {
        throw new RuntimeError("decodeURIComponent: the text is not a valid percent-encoded string", at.line, at.column);
      }
    }),
    false,
  );
  env.declare(
    "Error",
    native("Error", (_m, args) => {
      const message = args[0] === undefined ? "" : toText(args[0]);
      return errorValue(message);
    }),
    false,
  );
}

/** Freeze a builtin object so no call can change the whitelist itself. */
function deepFreezeValue(v: Value): Value {
  deepFreeze(v);
  return v;
}
