/**
 * An action that waits to hear how a request ended is told even when the request is refused after
 * routing decided, before anything was queued: the caller gets the refusal, and the action runs.
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

const dir = mkdtempSync(join(tmpdir(), "hearth-chat-turn-"));
const hooks: Record<string, unknown>[] = [];
let backendCalls = 0;
const backend = createServer(async (rq, rs) => {
  let raw = "";
  for await (const c of rq) raw += c;
  if (rq.url === "/hook") {
    hooks.push(JSON.parse(raw));
    return rs.writeHead(204).end();
  }
  if (rq.url === "/v1/chat/completions") backendCalls++;
  rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

writeFileSync(join(dir, "gate.mjs"), `export default { apiVersion: 1, kinds: { chat: ["routed"] }, setup: () => ({
  routed: () => ({ refuse: { status: 403, message: "not after routing" } }),
}) };`);
writeFileSync(join(dir, "hearth.yaml"), `version: 3
listen: {host: 127.0.0.1, port: 4999}
backends:
  main: {url: "${url}", kind: none, serves: [m]}
actions:
  told: {call: "${url}/hook", on: failed}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}, do: [told]}]}
plugins:
  gate: {use: "file:./gate.mjs", trust: code, everyLine: true}
`);

const node = createNode(loadConfig(join(dir, "hearth.yaml")), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const at = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

try {
  const r = await fetch(`${at}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) });
  const body = (await r.json()) as { error?: { message?: string } };
  assert.equal(r.status, 403, "the caller gets the plugin's refusal, not an internal error");
  assert.match(body.error?.message ?? "", /not after routing/);
  assert.equal(backendCalls, 0, "nothing was sent to the backend");
  for (let i = 0; i < 100 && hooks.length === 0; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(hooks.length, 1, "the action waiting on a failure was told");
  assert.equal(hooks[0]!["outcome"], "failed");
  assert.equal(hooks[0]!["ranMs"], 0, "it never ran");
  console.log("chat-turn.test.ts ok");
} finally {
  await node.close();
  backend.close();
}
