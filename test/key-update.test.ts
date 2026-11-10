/**
 * POST /keys/update, and minting with a router. The failures worth catching:
 *
 *   - a save touching a key's secret, or a neighbour's entry
 *   - empty maps left in the file after the last limit is taken out
 *   - a malformed value reaching the file
 *   - an awkward model id written somewhere it cannot be read back
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

const cfgPath = join(mkdtempSync(join(tmpdir(), "hearth-key-update-")), "hearth.yaml");
writeFileSync(cfgPath, `name: node-under-test
# a comment that has to survive
backends:
  main: {url: "http://127.0.0.1:1", kind: none, serves: [mine]}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
routers:
  other:
    flows:
      rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: full-secret, label: admin}
  - key: agent-secret
    label: agent
    limits: {tokensPerDay: 500}
  - bare-secret
  - key: noted-secret
    label: noted
    limits:
      # why this cap
      tokensPerDay: 900
      models:
        # and this one
        mine: {requestsPerMinute: 4}
callers:
  ghost: other
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const post = (route: string, body: unknown, key = "full-secret") =>
  fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
const file = () => readFileSync(cfgPath, "utf8");
const update = (body: Record<string, unknown>) => post("/keys/update", { label: "agent", ...body });
const entry = () => (loadConfig(cfgPath).apiKeyRules[1]!);

// Settings land under that label, and nothing else moves.
assert.equal((await update({ lane: "batch", limits: { maxConcurrent: 6 } })).status, 200);
assert.equal(entry().lane, "batch");
assert.equal(entry().maxConcurrent, 6);
assert.equal(entry().tokensPerDay, 500, "a limit not mentioned stays");
assert.match(file(), /# a comment that has to survive/);
assert.match(file(), /key: agent-secret/, "the secret stays as it was written");
assert.match(file(), /key: full-secret, label: admin/);

// A model id with odd characters writes, and reads back.
assert.equal((await update({ model: { id: "my-model:latest", limits: { maxConcurrent: 2 } } })).status, 200);
assert.equal((await update({ model: { id: "my.model", limits: { tokensPerDay: 100 } } })).status, 200);
assert.deepEqual(entry().models, { "my-model:latest": { maxConcurrent: 2 }, "my.model": { tokensPerDay: 100 } });

// The last value takes the model's entry with it, then the map, then limits.
assert.equal((await update({ model: { id: "my-model:latest", limits: { maxConcurrent: null } } })).status, 200);
assert.deepEqual(Object.keys(entry().models), ["my.model"]);
assert.equal((await update({ model: { id: "my.model", limits: { tokensPerDay: 0 } } })).status, 200);
assert.equal((await update({ lane: null, limits: { maxConcurrent: null, tokensPerDay: null } })).status, 200);
assert.equal(entry().lane, null);
const agentBlock = () => file().slice(file().indexOf("label: agent"), file().indexOf("- bare-secret"));
assert.doesNotMatch(agentBlock(), /limits|lane/, "nothing is left empty");

// A save changes the values it names, and what a person wrote beside them stays.
const noted = (body: Record<string, unknown>) => post("/keys/update", { label: "noted", ...body });
assert.equal((await noted({ limits: { maxConcurrent: 3 } })).status, 200);
assert.equal((await noted({ model: { id: "mine", limits: { tokensPerDay: 50 } } })).status, 200);
assert.match(file(), /# why this cap/);
assert.match(file(), /# and this one/);
assert.deepEqual(loadConfig(cfgPath).apiKeyRules[3]!.models, { mine: { requestsPerMinute: 4, tokensPerDay: 50 } });
assert.equal(loadConfig(cfgPath).apiKeyRules[3]!.tokensPerDay, 900);
assert.equal(loadConfig(cfgPath).apiKeyRules[3]!.maxConcurrent, 3);

// A router is the callers: entry, and default is no entry at all.
assert.equal((await update({ router: "other" })).status, 200);
assert.match(file(), /agent: other/);
assert.equal((await update({ router: "default" })).status, 200);
assert.doesNotMatch(file(), /agent: /, "default is the absence of a line");
const star = file();
writeFileSync(cfgPath, star.replace("callers:", 'callers:\n  "*": other'));
const star2 = createNode(loadConfig(cfgPath), silentLogger);
await new Promise<void>((r) => star2.server.listen(0, "127.0.0.1", r));
const starUrl = `http://127.0.0.1:${(star2.server.address() as AddressInfo).port}`;
const starred = await fetch(`${starUrl}/keys/update`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer full-secret" }, body: JSON.stringify({ label: "agent", router: "default" }) });
assert.equal(starred.status, 200);
assert.match(file(), /agent: default/, "where everyone else goes by a router, default has to be said");
await star2.close();
writeFileSync(cfgPath, star);

// A bad value is refused, and the file is as it was.
const before = file();
assert.equal((await post("/keys/update", { label: "nobody", lane: "chat" })).status, 404);
assert.equal((await post("/keys/update", { label: "", lane: "chat" })).status, 400, "a key with no label is changed in the file");
assert.ok((await update({ router: "nope" })).status >= 400);
assert.ok((await update({ lane: "nope" })).status >= 400);
assert.ok((await update({ limits: { maxConcurrent: 1.5 } })).status >= 400);
assert.equal((await update({})).status, 400, "nothing to change");
assert.equal(file(), before);

// A key with no limits yet takes them, and a mint that says default clears a line an old key left.
assert.equal((await post("/keys/mint", { label: "ghost", router: "default" })).status, 200);
assert.doesNotMatch(file(), /ghost: other/);
assert.equal((await post("/keys/update", { label: "ghost", model: { id: "mine", limits: { maxConcurrent: 2 } } })).status, 200);
assert.deepEqual(loadConfig(cfgPath).apiKeyRules.at(-1)!.models, { mine: { maxConcurrent: 2 } });

// A mint can say which router, in one write.
assert.equal((await post("/keys/mint", { label: "fresh", router: "other" })).status, 200);
assert.match(file(), /label: fresh/);
assert.match(file(), /fresh: other/);
assert.ok((await post("/keys/mint", { label: "stale", router: "nope" })).status >= 400);
assert.doesNotMatch(file(), /label: stale/);

await node.close();
console.log("key-update.test.ts ok");
