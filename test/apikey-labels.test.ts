/**
 * `apiKeys` can be `{ key, label }`, and a labeled key shows up as `key:<label>`
 * in the request log and the queue instead of the sha256 prefix. Bare keys are
 * unchanged, and a label is never a secret: it is not resolved through `env:`,
 * not hashed, and a blank one is a config error rather than a silent fall back
 * to the hash.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import type { Logger } from "../src/log.js";
import { createNode } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "hearth-labels-"));

// Answers anything with 200, so a chat completion actually runs and is logged
// with its caller.
const backend = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(req.url === "/v1/models"
    ? JSON.stringify({ data: [{ id: "mine" }] })
    : JSON.stringify({ served_by: "mine" }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const beUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

/* ------------------------------------------------------ parsing */

process.env.HEARTH_LABEL_TEST_KEY = "env-secret-key";
const cfgPath = join(dir, "hearth.yaml");
writeFileSync(cfgPath, `name: labels
backends: { main: { url: "${beUrl}", kind: none, serves: [mine] } }
apiKeys:
  - plain-key
  - { key: labeled-key, label: dsh }
  - { key: "env:HEARTH_LABEL_TEST_KEY", label: nova }
flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } }
`);
const cfg = loadConfig(cfgPath);
assert.deepEqual(cfg.apiKeys, ["plain-key", "labeled-key", "env-secret-key"],
  "keys resolve (env: included) and order is preserved");
assert.deepEqual(cfg.apiKeyLabels, ["", "dsh", "nova"],
  "labels are index-aligned; a bare key has an empty label");

/* ------------------------------------------------ parse errors */

const bad = (line: string, re: RegExp, why: string) => {
  const p = join(dir, "bad.yaml");
  writeFileSync(p, `name: bad\nbackends: { main: { url: "${beUrl}", kind: none, serves: [mine] } }\n${line}\nflows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } }\n`);
  assert.throws(() => loadConfig(p), re, why);
};
bad(`apiKeys: [{ key: k, label: "" }]`, /label must not be empty/,
  "a blank label is a typo, not a way to say no-label");
bad(`apiKeys: [{ label: dsh }]`, /\.key is required/,
  "the object form still needs a key");
// A caller id is an identity, not a decoration: maxPerCaller counts against it,
// so two keys under one name quietly share a single budget. And a repeated
// secret makes every later entry unreachable, label included — a name the
// operator sees in the config and never in a log.
bad(`apiKeys: [{ key: a, label: dsh }, { key: b, label: dsh }]`,
  /label "dsh" is already used by apiKeys\[0\]/,
  "two keys cannot share one name");
bad(`apiKeys: [{ key: same, label: one }, { key: same, label: two }]`,
  /key repeats apiKeys\[0\]/,
  "a repeated secret makes the later entry unreachable");
bad(`apiKeys: [same, same]`, /key repeats apiKeys\[0\]/,
  "bare keys too — the first match wins there as well");

/* ------------------------------------------- caller in the log */

const logs: { msg: string; fields: Record<string, unknown> }[] = [];
const capture: Logger = {
  debug: () => {}, warn: () => {}, error: () => {},
  info: (msg, fields) => logs.push({ msg, fields: fields ?? {} }),
};
const node = createNode(cfg, capture);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

async function callerFor(key: string): Promise<string | undefined> {
  logs.length = 0;
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "mine", messages: [{ role: "user", content: "hi" }] }),
  });
  await r.text();
  const req = logs.find((l) => l.msg === "request" && typeof l.fields.caller === "string");
  return req?.fields.caller as string | undefined;
}

assert.equal(await callerFor("labeled-key"), "key:dsh",
  "a labeled key logs the operator's own name");
assert.equal(await callerFor("env-secret-key"), "key:nova",
  "the label rides an env: secret too");
assert.equal(
  await callerFor("plain-key"),
  "key:" + createHash("sha256").update("plain-key").digest("hex").slice(0, 8),
  "an unlabeled key keeps the sha256 prefix — no key bytes in the log",
);

// A wrong credential is nobody, labels or not.
{
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
    body: JSON.stringify({ model: "mine", messages: [] }),
  });
  assert.equal(r.status, 401, "an unknown key is refused");
  await r.text();
}

await node.close();
await new Promise<void>((r) => backend.close(() => r()));
console.log("apikey-labels.test.ts ok");
