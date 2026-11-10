/** The Logs page: failed requests count as warnings, and a row's key survives the ring rotating. */
import assert from "node:assert/strict";

import { failed, keysOf, passes, type LogEntry } from "../src/console/logfilter.js";

const line = (msg: string, fields: Record<string, unknown>, level: LogEntry["level"] = "info", t = "2026-01-01T00:00:00Z"): LogEntry => ({ t, level, msg, fields });

const bad = line("request", { ok: false, id: "a" });
assert.equal(failed(bad), true);
assert.equal(failed(line("request", { ok: true })), false);
assert.equal(passes(bad, "warn"), true, "a failed request is a warning");
assert.equal(passes(bad, "error"), false, "but not an error unless logged as one");
assert.equal(passes(line("request", { ok: true }), "warn"), false);
assert.equal(passes(line("peer.down", {}, "warn"), "warn"), true);

const a = line("x", {}), b = line("x", {}), c = line("y", { id: "q" }, "info", "2026-01-01T00:00:01Z");
const full = keysOf([a, b, c]);
assert.equal(new Set(full).size, 3, "identical lines still get distinct keys");

// Same time and message, different fields: distinct keys with no repeat index, so no line's key depends on its neighbours.
const w1 = line("pool.yield_failed", { backend: "a" }, "warn", "2026-01-01T00:00:02Z"), w2 = line("pool.yield_failed", { backend: "b" }, "warn", "2026-01-01T00:00:02Z");
const old = [a, b, c, w1, w2];
const keys = keysOf(old);
assert.equal(new Set(keys).size, 5);
const later = line("pool.yield_failed", { backend: "a" }, "warn", "2026-01-01T00:00:03Z");
assert.deepEqual(keysOf([...old, later, later]).slice(0, 5), keys, "newer lines, repeats included, leave earlier keys alone");
assert.deepEqual(keysOf(old.slice(3)), keys.slice(3), "dropping the oldest lines leaves the survivors' keys alone");
console.log("logs.test.ts ok");
