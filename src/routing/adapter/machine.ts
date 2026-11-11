/**
 * One run's budgets, and the JSON boundary it crosses.
 *
 * A machine exists for one load of a module or one call to one of its sides, and it keeps the three
 * things the run is held to: a wall-clock deadline it reads from its own loop, an allocation total,
 * and a call depth. Nothing inside the interpreter allocates or recurses without going through it,
 * which is what makes `while (true) {}` and a heap that doubles itself both stoppable.
 */

import type { Pos } from "./ast.js";
import { LimitError, RuntimeError } from "./errors.js";
import { type Value, type VArray, type VObject, guarded, newArray, newObject } from "./values.js";

/** The budgets. Each is per run: a call starts with all of them whole again. */
export const LIMITS = {
  /** Bytes of string, array cell and object entry a run may allocate. */
  heap: 16 << 20,
  /** Elements in one array. */
  cells: 65_536,
  /** Characters in one string. */
  chars: 1 << 20,
  /** Nested calls. */
  depth: 256,
  /** How deeply a value may nest; bounds the walks that turn one into host data and back. */
  nest: 512,
  /** Steps between two readings of the clock. */
  clockEvery: 1000,
} as const;

/** What a module's own top-level code may take while it loads. */
export const LOAD_MS = 1000;

/** The machine one load or one call runs on. */
export class Machine {
  private steps = 0;
  private allocated = 0;
  private readonly deadline: number;

  /** Nested function calls running now, which no run may take past `LIMITS.depth`. */
  depth = 0;

  constructor(
    readonly name: string,
    readonly side: string,
    readonly limitMs: number,
  ) {
    this.deadline = Date.now() + limitMs;
  }

  /** One step of the interpreter. The clock is read every `clockEvery` steps, not on every one. */
  tick(): void {
    this.steps += 1;
    if (this.steps % LIMITS.clockEvery !== 0) return;
    if (Date.now() >= this.deadline) throw new LimitError(`step budget exceeded (${this.limitMs} ms)`);
  }

  /** Count an allocation, and stop the run when the heap is spent. */
  take(bytes: number): void {
    this.allocated += bytes;
    if (this.allocated > LIMITS.heap) throw new LimitError(`allocation budget exceeded (${LIMITS.heap >> 20} MiB)`);
  }

  /** A string the interpreter made: refuse one over the cap, and count it. */
  text(s: string): string {
    if (s.length > LIMITS.chars) throw new LimitError(`string too long (${LIMITS.chars} characters)`);
    this.take(s.length);
    return s;
  }

  /** An array of `n` cells: refuse one over the cap, and count it. */
  cells(n: number): void {
    if (n > LIMITS.cells) throw new LimitError(`array too long (${LIMITS.cells} elements)`);
    this.take(n * 8);
  }

  /** One more cell, when an array grows one item at a time; `total` is its new length. */
  cell(total: number): void {
    if (total > LIMITS.cells) throw new LimitError(`array too long (${LIMITS.cells} elements)`);
    this.take(8);
  }

  /** `n` object entries, counted like array cells. */
  entries(n: number): void {
    this.take(n * 8);
  }

  /** One nested call, refused once the depth cap is reached. */
  enter(): void {
    if (this.depth >= LIMITS.depth) throw new LimitError(`call depth exceeded (${LIMITS.depth})`);
    this.depth += 1;
  }

  leave(): void {
    this.depth -= 1;
  }
}

const INVALID = "a value the adapter cannot see was passed in";

/** Copy host data in as values, refusing anything that is not plain JSON data. */
export function valuesIn(m: Machine, x: unknown, at: Pos, tooBig = `string too long (${LIMITS.chars} characters)`, depth = 0): Value {
  if (depth > LIMITS.nest) throw new RuntimeError("a value is nested too deeply", at.line, at.column);
  if (x === undefined || x === null) return x;
  if (typeof x === "string") {
    if (x.length > LIMITS.chars) throw new LimitError(tooBig);
    m.take(x.length);
    return x;
  }
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x;
  if (Array.isArray(x)) {
    const a: VArray = newArray();
    m.cells(x.length);
    for (const item of x) a.items.push(valuesIn(m, item, at, tooBig, depth + 1));
    return a;
  }
  if (typeof x === "object") {
    const o: VObject = newObject();
    const entries = Object.entries(x as Record<string, unknown>);
    m.entries(entries.length);
    for (const [key, item] of entries) {
      o.entries.set(guarded(key, at), valuesIn(m, item, at, tooBig, depth + 1));
    }
    return o;
  }
  throw new RuntimeError(INVALID, at.line, at.column);
}

/** Copy a value out as plain JSON data: what a call to an adapter returns. */
export function valuesOut(v: Value, depth = 0): unknown {
  if (depth > LIMITS.nest) throw new RuntimeError("a value is nested too deeply");
  if (v === undefined || v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  if (v.t === "array") return v.items.map((item) => valuesOut(item, depth + 1));
  if (v.t === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of v.entries) out[key] = valuesOut(item, depth + 1);
    return out;
  }
  throw new RuntimeError("an adapter cannot return a function");
}
