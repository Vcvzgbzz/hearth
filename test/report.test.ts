/**
 * `hearth report`. The failures worth catching:
 *
 *   - a secret in the report: one written in the file, one the file reads from the environment,
 *     or one a log line happened to carry
 *   - a node that is down taking the whole report with it, when the config alone still helps
 *   - a config that does not load reported as if it did
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { bugReport } from "../src/report.js";
import { createNode } from "../src/server.js";

const free = async (): Promise<number> => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};

process.env.REPORT_TEST_BACKEND_KEY = "from-the-environment-1234";
const secrets = ["full-key-in-the-file", "scoped-key-in-the-file", "peer-token-in-the-file", "accept-token-in-the-file", "from-the-environment-1234"];
const port = await free();
const path = join(mkdtempSync(join(tmpdir(), "hearth-report-")), "hearth.yaml");
writeFileSync(path, `name: node-under-test
listen: {host: 127.0.0.1, port: ${port}}
backends:
  gpu0: {url: "http://127.0.0.1:1", kind: none, serves: [my-model], key: "env:REPORT_TEST_BACKEND_KEY"}
peers:
  friend: {url: "http://127.0.0.1:2", token: peer-token-in-the-file, accept: accept-token-in-the-file, models: {my-model: my-model}}
models:
  my-model: {backend: gpu0}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: scoped-key-in-the-file, label: app, models: [my-model]}
  - {key: full-key-in-the-file, label: me}
`);

// With the node running.
{
  const node = createNode(loadConfig(path), silentLogger);
  await new Promise<void>((r) => node.server.listen(port, "127.0.0.1", r));
  node.log.warn("test.leak", { said: "full-key-in-the-file and from-the-environment-1234" });
  const report = await bugReport(path, "9.9.9");
  await node.close();

  for (const s of secrets) assert.ok(!report.includes(s), `${s} must not be in the report`);
  assert.match(report, /hearth 9\.9\.9/);
  assert.match(report, /loads: ok/);
  assert.match(report, /name: node-under-test/, "the config is there, minus its secrets");
  assert.match(report, /### \/healthz\n\n```json\n\{/);
  assert.match(report, /"name": "node-under-test"/, "/network answered, with the unscoped key");
  assert.match(report, /test\.leak/, "the log lines are there");
  assert.match(report, /<secret \d+>/, "a secret a log line carried is replaced, not dropped");
}

// With the node down: the config still comes through.
{
  const report = await bugReport(path, "9.9.9");
  assert.match(report, /loads: ok/);
  assert.match(report, /no answer/);
  for (const s of secrets) assert.ok(!report.includes(s), `${s} must not be in the report`);
}

// A config that does not load says why, and still shows the file.
{
  delete process.env.REPORT_TEST_BACKEND_KEY;
  const report = await bugReport(path, "9.9.9");
  assert.match(report, /does not load: .*REPORT_TEST_BACKEND_KEY/);
  assert.match(report, /name: node-under-test/);
  for (const s of secrets.slice(0, 4)) assert.ok(!report.includes(s), `${s} must not be in the report`);
}

console.log("report.test.ts ok");
