/**
 * Embeddings for a scoped key. The failures worth catching:
 *
 *   - a key scoped to an embedding type refused at /v1/embeddings
 *   - a key scoped to chat, or to nothing an embedding flow takes, let through
 *   - a scoped key reaching any other passthrough path because embeddings opened
 *   - an unscoped caller's embeddings changing at all
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

const seen: string[] = [];
const backend = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => { body += c; });
  req.on("end", () => {
    if (req.url === "/v1/embeddings") seen.push((JSON.parse(body) as { model: string }).model);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/v1/embeddings" ? { data: [{ embedding: [0.1, 0.2] }] } : { ok: true }));
  });
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const cfgPath = join(mkdtempSync(join(tmpdir(), "hearth-embed-")), "hearth.yaml");
writeFileSync(cfgPath, `name: node-under-test
backends:
  main:
    url: "http://127.0.0.1:${(backend.address() as AddressInfo).port}"
    kind: single
    serves: [small-embed, big]
    routes:
      - {path: /v1/embeddings, model: small-embed}
flows:
  Embed:
    takes: [/v1/embeddings]
    inputs: [Embed]
    steps:
      - {when: {variant: [text]}, to: small-embed}
      - {to: {refuse: "say which: Embed:text"}}
  chat: {inputs: [chat], steps: [{to: big}]}
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: full-secret, label: admin}
  - {key: embed-secret, label: memory, models: [Embed]}
  - {key: chat-secret, label: talker, models: [chat]}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const post = async (path: string, key: string, body: unknown) =>
  (await fetch(`${url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status;
const embed = (key: string, model: string) => post("/v1/embeddings", key, { model, input: "hello" });

try {
  assert.equal(await embed("embed-secret", "Embed:text"), 200, "a key scoped to the embedding type embeds");
  assert.equal(seen.at(-1), "small-embed", "through the flow, to the model its line names");
  assert.equal(await embed("embed-secret", "small-embed"), 403, "not by the model's own name");
  assert.equal(await embed("embed-secret", "chat"), 403, "nor a name outside its scope");
  assert.equal(await post("/v1/embeddings", "embed-secret", { input: "no model" }), 403, "nor without naming one");
  assert.equal(await embed("chat-secret", "Embed:text"), 403, "a key scoped to chat does not embed");
  assert.equal(await post("/v1/audio/speech", "embed-secret", { model: "Embed:text" }), 403, "other passthrough paths stay closed to scoped keys");
  assert.equal(await embed("full-secret", "Embed:text"), 200, "an unscoped caller embeds as before");
  console.log("embed-scope.test.ts ok");
} finally {
  await node.close();
  backend.close();
}
