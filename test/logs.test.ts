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
assert.deepEqual(keysOf([b, c]), full.slice(1).map((k, i) => (i === 0 ? full[0]!.replace(/\|1$/, "|0") : k)).slice(0, 2), "dropping the oldest keeps the rest by key, repeats renumbered");
console.log("logs.test.ts ok");
