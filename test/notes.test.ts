/**
 * `notes:` — the lender's own words about a model, carried to peers on the
 * stats they already exchange.
 *
 *     npx tsx test/notes.test.ts
 */
import assert from "node:assert/strict";

import { ConfigError } from "../src/config/read.js";
import { cleanStats } from "../src/routing/stats.js";
import { NOTE_MAX } from "../src/config/models.js";
import { parseV1 } from "./v1.js";

const base = { backend: { url: "http://x:1" } };

assert.deepEqual(parseV1(base).notes, {});
assert.deepEqual(
  parseV1({ ...base, notes: { coder: "  fast agent model  ", empty: "" } }).notes,
  { coder: "fast agent model" },
  "trimmed, and an empty note is no note",
);
assert.throws(() => parseV1({ ...base, notes: { coder: 3 } }), ConfigError);
assert.throws(() => parseV1({ ...base, notes: { coder: "x".repeat(NOTE_MAX + 1) } }), /keep it under/);

// A note alone is worth sending, and a peer's is capped rather than trusted.
assert.deepEqual(cleanStats({ note: "use for code" }), { note: "use for code" });
assert.equal(cleanStats({ note: "y".repeat(NOTE_MAX * 2) })!.note!.length, NOTE_MAX);
assert.equal(cleanStats({ note: 7 }), undefined);

console.log("notes.test.ts ok");
