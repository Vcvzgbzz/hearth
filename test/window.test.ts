/**
 * The sliding window behind every per-minute and per-hour limit: a limit is a ceiling over any
 * window, a refusal is not counted against the caller, and keys do not share a budget.
 */
import assert from "node:assert/strict";

import { SlidingWindow } from "../src/access/window.js";

const w = new SlidingWindow(1_000);
assert.equal(w.take("a", 2, 0), true);
assert.equal(w.take("a", 2, 100), true);
assert.equal(w.take("a", 2, 200), false, "a third inside the window is refused");
assert.equal(w.take("b", 2, 200), true, "another key has its own budget");
assert.equal(w.take("a", 2, 1_000), true, "the first has left the window at exactly windowMs");
assert.equal(w.take("a", 2, 1_050), false, "the refusal at 200 was not counted, but 100 and 1000 still are");
assert.equal(w.take("a", 2, 1_100), true, "100 has left");

w.prune(10_000);
assert.equal((w as unknown as { hits: Map<string, number[]> }).hits.size, 0, "prune drops keys with nothing in the window");

console.log("window.test.ts ok");
