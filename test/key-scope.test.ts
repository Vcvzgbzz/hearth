/**
 * A key held to a type. The failures worth catching:
 *
 *   - a config that scopes a key to a name a flow takes being refused
 *   - a key scoped to a type refused its variants, or let at a model the scope does not name
 *   - a model id with a colon in it being read as a variant of a model the scope names
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inScope } from "../src/admit.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

const type = (n: string) => n === "chat";
assert.equal(inScope(["chat"], "chat", type), true);
assert.equal(inScope(["chat"], "chat:fast", type), true, "a variant of a type the scope names");
assert.equal(inScope(["small"], "small:8b", type), false, "a colon in a model id is not a variant of a model");
assert.equal(inScope(["chat"], "other:fast", type), false);

const backend = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "big" }, { id: "small" }] } : { choices: [{ message: { role: "assistant", content: "ok" } }] }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const cfgPath = join(mkdtempSync(join(tmpdir(), "hearth-scope-")), "hearth.yaml");
writeFileSync(cfgPath, `name: node-under-test
backends:
  main: {url: "http://127.0.0.1:${(backend.address() as AddressInfo).port}", kind: none, serves: [big, small]}
flows:
  chat:
    inputs: [chat]
    steps:
      - {when: {variant: [fast]}, to: small}
      - {to: big}
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: full-secret, label: admin}
  - {key: chat-secret, label: talker, models: [chat]}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const ask = async (model: string) => (await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { Authorization: "Bearer chat-secret", "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })).status;

try {
  assert.deepEqual([await ask("chat"), await ask("chat:fast")], [200, 200], "the type and its variants");
  assert.deepEqual([await ask("big"), await ask("small")], [403, 403], "not the models behind it by their own names");
  const listed = ((await (await fetch(`${url}/v1/models`, { headers: { Authorization: "Bearer chat-secret" } })).json()) as { data: { id: string }[] }).data.map((m) => m.id).sort();
  assert.deepEqual(listed, ["chat", "chat:fast"], "and its list of models is what it may ask for");
  console.log("key-scope.test.ts ok");
} finally {
  await node.close();
  backend.close();
}
