/**
 * Callers looks keys up by digest from an index it builds once. The index must follow a live edit,
 * which swaps the key lists whole, and a key past its expiry must stop working without one.
 */
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";

import { Callers } from "../src/access/callers.js";
import { parseV1 } from "./v1.js";

const req = (key: string, ip = "10.0.0.5") =>
  ({ headers: key ? { authorization: `Bearer ${key}` } : {}, socket: { remoteAddress: ip } }) as unknown as IncomingMessage;

const cfg = parseV1({
  backend: { url: "http://127.0.0.1:9" },
  apiKeys: [{ key: "k-one", label: "one", limits: { requestsPerMinute: 5 } }, "k-two"],
});
const callers = new Callers(cfg);

assert.deepEqual(callers.local(req("k-one")), { caller: "key:one", models: null });
assert.match(callers.local(req("k-two"))!.caller, /^key:[0-9a-f]{8}$/, "an unlabeled key goes by its hash prefix");
assert.equal(callers.local(req("nope")), null);
assert.equal(callers.local(req("")), null, "with keys configured, loopback alone is not enough");
assert.equal(callers.ruleOf("key:one")?.requestsPerMinute, 5);
assert.ok(callers.lastSeen("key:one") !== null, "a key that authenticated is seen");

// A live edit replaces the arrays; the next lookup must see the new set.
cfg.apiKeys = ["k-three"];
cfg.apiKeyLabels = ["three"];
cfg.apiKeyModels = [null];
cfg.apiKeyRules = [];
assert.equal(callers.local(req("k-one")), null, "a revoked key stops working at once");
assert.equal(callers.local(req("k-three"))?.caller, "key:three", "a minted key works at once");
assert.equal(callers.ruleOf("key:one"), null);
assert.equal(callers.isOurKey("k-three"), true);

// Peers by token, from the same kind of index.
cfg.peerTokens = { friend: "p-token", empty: "" };
assert.equal(callers.peer(req("p-token")), "friend");
assert.equal(callers.peer(req("")), null, "an empty token names no peer");

// With no keys at all, this machine and nobody else.
cfg.apiKeys = [];
assert.deepEqual(callers.local(req("", "127.0.0.1")), { caller: "local", models: null });
assert.equal(callers.local(req("", "10.0.0.5")), null);

console.log("callers.test.ts ok");
