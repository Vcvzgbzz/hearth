/**
 * The console's config editor: edits become the fewest path ops (so untouched keys keep their
 * comments), and the review diff shows exactly what changed.
 */
import assert from "node:assert/strict";

import { lineDiff, opsBetween } from "../src/console/diff.js";

// --- only what changed becomes an op -------------------------------------------------
{
  const from = { backends: [{ name: "a", url: "u", serves: ["x"] }, { name: "b", url: "v" }], share: ["x"] };
  const to = { backends: [{ name: "a", url: "u2", serves: ["x", "y"] }, { name: "b", url: "v" }, { name: "c", url: "w" }], share: ["x"] };
  assert.deepEqual(opsBetween(from, to), [
    { path: ["backends", 0, "url"], value: "u2" },
    { path: ["backends", 0, "serves"], value: ["x", "y"] },
    { path: ["backends", 2], value: { name: "c", url: "w" } },
  ], "a leaf edit, a scalar list replaced whole, an item appended");
  assert.deepEqual(opsBetween(to, from), [
    { path: ["backends", 0, "url"], value: "u" },
    { path: ["backends", 0, "serves"], value: ["x"] },
    { path: ["backends", 2], delete: true },
  ], "and trimmed from the end on the way back");
  assert.deepEqual(opsBetween({ a: 1, b: 2 }, { a: 1 }), [{ path: ["b"], delete: true }], "a removed key is a delete");
  assert.deepEqual(opsBetween({ a: 1, b: 2 }, { a: null, b: 2 }), [{ path: ["a"], delete: true }], "a cleared field is a delete, not a null written");
  assert.deepEqual(opsBetween({ a: null, b: 2 }, { a: null, b: 2 }), [], "an already-null key stays put");
  assert.deepEqual(opsBetween({ a: 1 }, { a: 1 }), [], "no change, no ops");
}

// --- the review diff folds what did not change ---------------------------------------
{
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const b = a.replace("line 10", "line ten");
  const d = lineDiff(a, b);
  assert.deepEqual(d.filter((l) => l.kind === "-").map((l) => l.text), ["line 10"]);
  assert.deepEqual(d.filter((l) => l.kind === "+").map((l) => l.text), ["line ten"]);
  assert.equal(d.filter((l) => l.kind === "…").length, 2, "unchanged runs before and after are folded");
  assert.equal(d.filter((l) => l.kind === " ").length, 6, "with three lines of context either side");
  const changed = d.filter((l) => l.kind === "-" || l.kind === "+").map((l) => l.kind);
  assert.deepEqual(changed, ["-", "+"], "the old line reads before its replacement");
}

console.log("diff.test.ts ok");
