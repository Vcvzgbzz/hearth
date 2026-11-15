// The console's counts: each size gets its own unit, up to trillions.
import assert from "node:assert/strict";
import { short } from "../src/console/count.js";

assert.equal(short(950), "950");
assert.equal(short(12_400), "12k");
assert.equal(short(3_100_000), "3.1M");
assert.equal(short(1_513_000_000), "1.51B", "a billion is B, not 1513.0M");
assert.equal(short(25_100_000_000), "25.1B");
assert.equal(short(2_040_000_000_000), "2.04T");
assert.equal(short(48_000_000_000_000), "48.0T");

console.log("short ok");
