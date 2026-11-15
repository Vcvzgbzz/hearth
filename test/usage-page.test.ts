import assert from "node:assert/strict";
import { byDay, callerName, costOf, daysEnding, topN, totalsBy, type UsageSnapshot } from "../src/console/tally.js";

const usage: UsageSnapshot = {
  "2026-01-01": { "key:a": { m1: { requests: 2, failed: 1, in: 100, out: 50 }, m2: { requests: 1, failed: 0, in: 10, out: 5, cached: 4 } }, local: { m1: { requests: 1, failed: 0, in: 1, out: 1 } } },
  "2026-01-03": { "key:a": { m1: { requests: 1, failed: 0, in: 20, out: 0 } }, "peer:x": { m2: { requests: 3, failed: 2, in: 500, out: 500 } } },
};
const prices = { m1: { in: 1, out: 2 }, m2: { in: 10, out: 10, cached: 1 } };

const callers = totalsBy(usage, prices, "caller");
assert.deepEqual(callers.map((g) => g.name), ["peer:x", "key:a", "local"]);
assert.equal(callers[1]!.in, 130);
assert.equal(callers[1]!.requests, 4);
assert.deepEqual(callers[1]!.parts.map((p) => p.name), ["m1", "m2"]);
assert.equal(callers[1]!.parts[0]!.in, 120);
const models = totalsBy(usage, prices, "model");
assert.deepEqual(models.map((g) => g.name), ["m2", "m1"]);
assert.deepEqual(models[0]!.parts.map((p) => p.name), ["peer:x", "key:a"]);
assert.equal(models[0]!.cached, 4);

// cost: cached input at the cached price, the rest at the input price
assert.equal(costOf("m2", { requests: 1, failed: 0, in: 10, out: 5, cached: 4 }, prices), (6 * 10 + 4 * 1 + 5 * 10) / 1e6);
assert.equal(costOf("none", { requests: 1, failed: 0, in: 10, out: 5 }, prices), 0);
// input written to the cache at the write price; without one, at the input price
const writes = { m3: { in: 10, out: 10, cached: 1, cacheWrite: 20 } };
assert.equal(costOf("m3", { requests: 1, failed: 0, in: 10, out: 5, cached: 4, written: 3 }, writes), (3 * 10 + 4 * 1 + 3 * 20 + 5 * 10) / 1e6);
assert.equal(costOf("m2", { requests: 1, failed: 0, in: 10, out: 5, cached: 4, written: 3 }, prices), (6 * 10 + 4 * 1 + 5 * 10) / 1e6);
// a count that says more was written than there was input is held to the input
assert.equal(costOf("m3", { requests: 1, failed: 0, in: 10, out: 0, cached: 4, written: 50 }, writes), (4 * 1 + 6 * 20) / 1e6);
const withWrites: UsageSnapshot = { "2026-01-01": { "key:a": { m3: { requests: 1, failed: 0, in: 10, out: 5, written: 3 } } }, "2026-01-02": { "key:a": { m3: { requests: 1, failed: 0, in: 10, out: 5, written: 2 } } } };
assert.equal(totalsBy(withWrites, writes, "model")[0]!.written, 5, "writes are summed across days");

// stacking: the named parts plus others equal the day's total
const days = ["2026-01-01", "2026-01-02", "2026-01-03"];
const top = topN(callers, 1);
assert.deepEqual(top, ["peer:x"]);
const bars = byDay(usage, "caller", top, days);
for (const b of bars) assert.equal(Object.values(b.parts).reduce((a, n) => a + n, 0) + b.others, b.total);
assert.equal(bars[0]!.total, 167);
assert.equal(bars[0]!.others, 167);
assert.equal(bars[1]!.total, 0);
assert.equal(bars[2]!.parts["peer:x"], 1000);
assert.equal(bars[2]!.others, 20);
assert.equal(bars[2]!.failed, 2);
assert.equal(byDay(usage, "model", ["m1"], days)[0]!.others, 15);

// empty
assert.deepEqual(totalsBy({}, {}, "caller"), []);
assert.deepEqual(topN([], 5), []);
assert.ok(byDay({}, "model", [], days).every((b) => b.total === 0 && b.others === 0));

assert.deepEqual(daysEnding(3, Date.UTC(2026, 0, 3)), days);
assert.equal(callerName("local"), "this machine, no key");
assert.equal(callerName("peer:x"), "peer x");
assert.equal(callerName("key:a"), "a");
console.log("usage-page.test.ts ok");
