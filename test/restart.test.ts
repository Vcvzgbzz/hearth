/** POST /restart: local callers only, 501 without a supervisor hook, 202 and the hook with one. */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

const node = createNode(parseV1({ backend: { url: "http://127.0.0.1:9292" }, apiKeys: ["k"] }), silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}/restart`;
const post = (key?: string) => fetch(url, { method: "POST", headers: key ? { Authorization: `Bearer ${key}` } : {} });

assert.equal((await post()).status, 401, "a credential is needed");
assert.equal((await post("k")).status, 501, "nothing to restart it");

let called = 0;
node.onRestart = () => { called++; };
assert.equal((await post("k")).status, 202);
assert.equal(called, 1, "the hook ran");

await node.close();
console.log("restart.test.ts ok");
