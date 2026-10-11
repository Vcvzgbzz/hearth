/**
 * POST /keys/mint, /keys/revoke and /v1/evict. The failures worth catching:
 *
 *   - a second key minted before a restart replacing the first
 *   - a revoke after another revoke removing a neighbour
 *   - a key held to some models minting one held to none
 *   - a model evicted while it is answering
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

// A model swapper with one resident model, a chat that answers when let go, and a per-model unload.
let resident = ["mine"];
let release: (() => void) | null = null;
const unloaded: string[] = [];
const backend = createServer((req, res) => {
  const say = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  req.resume();
  if (req.url === "/v1/models") return say(200, { data: [{ id: "mine" }, { id: "spare" }] });
  if (req.url === "/running") return say(200, { running: resident.map((model) => ({ model, state: "ready" })) });
  if (req.url?.startsWith("/api/models/unload/")) {
    const id = decodeURIComponent(req.url.slice("/api/models/unload/".length));
    unloaded.push(id);
    resident = resident.filter((m) => m !== id);
    return say(200, {});
  }
  if (req.url === "/v1/chat/completions") { release = () => say(200, { choices: [{ message: { role: "assistant", content: "ok" } }] }); return; }
  say(404, {});
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));

const cfgPath = join(mkdtempSync(join(tmpdir(), "hearth-keys-")), "hearth.yaml");
writeFileSync(cfgPath, `name: node-under-test
backends:
  main:
    url: http://127.0.0.1:${(backend.address() as AddressInfo).port}
    kind: llama-swap
    serves: [mine, spare]
models:
  mine: {backend: main}
  spare: {backend: main}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: full-secret, label: admin}
  - {key: narrow-secret, label: narrow, models: [spare]}
`);

const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const post = (route: string, key: string, body: unknown) =>
  fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
const labels = () => [...readFileSync(cfgPath, "utf8").matchAll(/label: ([\w-]+)/g)].map((m) => m[1]);

assert.equal((await post("/keys/mint", "narrow-secret", { label: "more" })).status, 403, "a scoped key mints nothing");
assert.equal((await post("/keys/revoke", "narrow-secret", { label: "admin" })).status, 403, "and revokes nothing");

const first = (await (await post("/keys/mint", "full-secret", { label: "one" })).json()) as { key: string };
assert.match(first.key, /^hkey_[0-9a-f]{40}$/);
assert.equal((await post("/keys/mint", "full-secret", { label: "two" })).status, 200);
assert.deepEqual(labels(), ["admin", "narrow", "one", "two"], "the second mint sits after the first");
assert.ok(readFileSync(cfgPath, "utf8").includes(first.key), "and the first key is still in the file");
assert.equal((await post("/keys/mint", "full-secret", { label: "two" })).status, 409, "a label is used once");

// A key works from the moment it is minted and stops the moment it is revoked.
assert.equal((await post("/keys/mint", first.key, { label: "three" })).status, 200, "a minted key authenticates at once");
assert.equal((await post("/keys/revoke", "full-secret", { label: "one" })).status, 200);
assert.equal((await post("/keys/revoke", "full-secret", { label: "three" })).status, 200);
assert.deepEqual(labels(), ["admin", "narrow", "two"], "each revoke removes the key it named");
assert.equal((await post("/keys/revoke", "full-secret", { label: "one" })).status, 404);
assert.equal((await post("/keys/mint", first.key, { label: "four" })).status, 401, "a revoked key is turned away at once");

// Evict.
assert.equal((await post("/v1/evict", "narrow-secret", { model: "mine" })).status, 403, "a scoped key drops only what it may run");

const chat = post("/v1/chat/completions", "full-secret", { model: "mine", messages: [{ role: "user", content: "hi" }] });
for (let i = 0; release === null && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
assert.ok(release, "the chat reached the backend");
const busy = await post("/v1/evict", "full-secret", { model: "mine" });
assert.equal(busy.status, 409, "a model that is answering stays");
assert.match(((await busy.json()) as { error: { message: string } }).error.message, /answering 1 request/);
assert.deepEqual(unloaded, [], "and the backend was not asked");

release!();
assert.equal((await chat).status, 200);
const gone = await post("/v1/evict", "full-secret", { model: "mine" });
assert.equal(gone.status, 200, "idle, it goes");
assert.deepEqual(unloaded, ["mine"]);
assert.equal((await post("/v1/evict", "full-secret", { model: "mine" })).status, 409, "nothing left to evict");

await node.close();
backend.close();
console.log("keys.test.ts ok");
