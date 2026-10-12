/**
 * The id a request is answered with, and its line in the log. The failures worth catching:
 *
 *   - an answer with no id, or two requests sharing one
 *   - a backend's own id reaching the caller in place of this node's
 *   - a log line that cannot be matched to the answer, or that leaves out the header a rule tested
 *   - a header no rule tests, or a credential, written to the log
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger, type Logger } from "../src/log.js";
import { createNode } from "../src/server.js";

const backend = createServer((req, res) => {
  const say = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "X-Request-Id": "theirs" }); res.end(JSON.stringify(body)); };
  req.resume();
  if (req.url === "/v1/models") return say(200, { data: [{ id: "big" }, { id: "small" }] });
  if (req.url === "/running") return say(200, { running: [] });
  if (req.url === "/v1/chat/completions") return say(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
  say(404, {});
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));

const cfgPath = join(mkdtempSync(join(tmpdir(), "hearth-request-id-")), "hearth.yaml");
writeFileSync(cfgPath, `name: node-under-test
backends:
  main:
    url: http://127.0.0.1:${(backend.address() as AddressInfo).port}
    kind: llama-swap
    serves: [big, small]
models:
  big: {backend: main}
  small: {backend: main}
flows:
  chat:
    inputs: [chat]
    steps:
      - {when: {header: {x-stay: [local]}}, to: {model: small}}
      - {when: {headerNot: {authorization: []}}, to: {model: big}}
      - {to: {model: big}}
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: a-secret, label: app}
`);

const lines: Record<string, unknown>[] = [];
const logger: Logger = { ...silentLogger, info: (msg, fields) => { if (msg === "request") lines.push(fields ?? {}); } };
const node = createNode(loadConfig(cfgPath), logger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

const chat = (headers: Record<string, string> = {}) =>
  fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "hi" }] }) });

/** The line is written once the answer has gone out, which the caller may see first. */
const logged = async (n: number) => { for (let i = 0; i < 100 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };

try {
  const a = await chat({ "X-Stay": "local", "X-Other": "untested", Authorization: "Bearer a-secret" });
  await a.text();
  const idA = a.headers.get("x-request-id");
  assert.match(idA ?? "", /^req_[0-9a-f]{16}$/, "a relayed answer carries this node's id, not the backend's");
  await logged(1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.id, idA, "the log line carries the id the caller was given");
  assert.equal(lines[0]!.model, "small");
  assert.deepEqual(lines[0]!.headers, { "x-stay": "local" }, "a tested header is logged; an untested one and a credential are not");

  const b = await chat({ Authorization: "Bearer a-secret" });
  await b.text();
  await logged(2);
  assert.notEqual(b.headers.get("x-request-id"), idA, "each request has its own id");
  assert.equal(lines[1]!.id, b.headers.get("x-request-id"));
  assert.equal(lines[1]!.headers, undefined, "a request that sent none of the tested headers logs none");

  assert.equal(lines[1]!.model, "big");

  const c = await fetch(`${url}/healthz`);
  await c.text();
  assert.match(c.headers.get("x-request-id") ?? "", /^req_/, "every answer has one, not only chat");
  console.log("request-id: ok");
} finally {
  await node.close();
  backend.close();
}
