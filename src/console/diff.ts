/** Line diffs for the review step, and the smallest set of path ops that turns one value into another. */

export type Line = { kind: " " | "+" | "-" | "…"; text: string };

/** LCS line diff, with unchanged runs folded to `context` lines either side of a change. */
export function lineDiff(a: string, b: string, context = 3): Line[] {
  const x = a.split("\n");
  const y = b.split("\n");
  // ponytail: O(n*m) table; fine for a config file, swap for Myers if files reach thousands of lines.
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const all: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { all.push({ kind: " ", text: x[i]! }); i++; j++; }
    // Removals before additions, as unified diffs read: the old line, then what replaces it.
    else if (i < x.length && (j >= y.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) all.push({ kind: "-", text: x[i++]! });
    else all.push({ kind: "+", text: y[j++]! });
  }
  const near = all.map((l, k) => l.kind !== " " || all.slice(Math.max(0, k - context), k + context + 1).some((m) => m.kind !== " "));
  const out: Line[] = [];
  all.forEach((l, k) => {
    if (near[k]) out.push(l);
    else if (out.at(-1)?.kind !== "…") out.push({ kind: "…", text: "" });
  });
  return out;
}

export type Op = { path: (string | number)[]; value?: unknown; delete?: true; rename?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Leaf-level ops from `from` to `to`, so untouched keys (and the comments on them) are never rewritten.
 * Lists of scalars are replaced whole; lists of maps are diffed per item, appended, or trimmed from the end.
 */
export function opsBetween(from: unknown, to: unknown, path: (string | number)[] = []): Op[] {
  if (to === null) return from === undefined || from === null ? [] : [{ path, delete: true }];
  if (from === null) return to === undefined ? [] : [{ path, value: to }];
  if (same(from, to)) return [];
  if (isObj(from) && isObj(to)) {
    const ops: Op[] = [];
    for (const [k, v] of Object.entries(to)) ops.push(...(k in from ? opsBetween(from[k], v, [...path, k]) : [{ path: [...path, k], value: v }]));
    for (const k of Object.keys(from)) if (!(k in to)) ops.push({ path: [...path, k], delete: true });
    return ops;
  }
  if (Array.isArray(from) && Array.isArray(to) && to.some(isObj)) {
    const ops: Op[] = [];
    const n = Math.min(from.length, to.length);
    for (let i = 0; i < n; i++) ops.push(...opsBetween(from[i], to[i], [...path, i]));
    for (let i = n; i < to.length; i++) ops.push({ path: [...path, i], value: to[i] });
    for (let i = from.length - 1; i >= to.length; i--) ops.push({ path: [...path, i], delete: true });
    return ops;
  }
  return [{ path, value: to }];
}
