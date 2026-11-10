/**
 * A derived value is rebuilt when a config part it reads is replaced, and only then: an unchanged
 * part, or a part it does not read, leaves it as it was.
 */
import assert from "node:assert/strict";

import { derived } from "../src/config/derived.js";

const cfg = { a: [1], b: { x: 1 }, other: "z" };
let builds = 0;
const sum = derived(() => [cfg.a, cfg.b], () => { builds++; return cfg.a.length + cfg.b.x; });

assert.equal(sum(), 2);
assert.equal(sum(), 2);
assert.equal(builds, 1, "read twice, built once");
cfg.other = "y";
sum();
assert.equal(builds, 1, "a part it does not read changes nothing");
cfg.a = [1, 2];
assert.equal(sum(), 3, "a replaced part rebuilds it");
assert.equal(builds, 2);

let parts: unknown[] = [cfg.a];
const count = derived(() => parts, () => parts.length);
assert.equal(count(), 1);
parts = [cfg.a, cfg.b];
assert.equal(count(), 2, "a different number of parts rebuilds it");

console.log("derived.test.ts ok");
