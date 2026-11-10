/**
 * x-hearth-hops: a request to /plugins/<name>/* carries how many plugins it has already been through,
 * refused `508 Loop Detected` once it has reached `pluginsMaxHops` (default 3).
 *
 *   - a missing or blank header is zero hops; a malformed one is a 400
 *   - the count is incremented by one for the plugin, so a plugin that passes it on is counted
 *   - a count at or above the limit is refused before any plugin is asked
 *   - x-hearth-caller and x-hearth-hops set by the caller are replaced, not passed on
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

let serviceCalls: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
let servicePort = 0;

const svc = createServer((req, res) => {
  serviceCalls.push({ url: req.url ?? "", headers: req.headers });
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});
await new Promise<void>((resolve) => svc.listen(0, "127.0.0.1", resolve));
servicePort = (svc.address() as AddressInfo).port;

const dir = mkdtempSync(join(tmpdir(), "hearth-hops-"));
const cfgPath = join(dir, "hearth.yaml");
writeFileSync(cfgPath, `version: 3
name: hops
backends:
  main: {url: "http://127.0.0.1:1", serves: [m]}
models:
  m: {backend: main}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
plugins:
  tool: {serves: "http://127.0.0.1:${servicePort}/api", trust: http}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((resolve) => node.server.listen(0, "127.0.0.1", resolve));
const nodePort = (node.server.address() as AddressInfo).port;

const call = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${nodePort}${path}`, { method: "POST", headers, body: "x" }).then(async (res) => ({ status: res.status, text: await res.text() }));

try {
  // A request with no hop header arrives as the first hop.
  serviceCalls = [];
  {
    const r = await call("/plugins/tool/run");
    assert.equal(r.status, 200);
    assert.equal(serviceCalls.length, 1);
    assert.equal(serviceCalls[0]!.headers["x-hearth-hops"], "1");
  }

  // The count is incremented by one on the way to the plugin.
  serviceCalls = [];
  {
    const r = await call("/plugins/tool/run", { "x-hearth-hops": "2" });
    assert.equal(r.status, 200);
    assert.equal(serviceCalls.length, 1);
    assert.equal(serviceCalls[0]!.headers["x-hearth-hops"], "3");
  }

  // A count at the limit is refused before any plugin is asked.
  serviceCalls = [];
  {
    const r = await call("/plugins/tool/run", { "x-hearth-hops": "3" });
    assert.equal(r.status, 508);
    assert.match(r.text, /looping/);
    assert.equal(serviceCalls.length, 0, "no plugin was asked");
  }

  // A malformed hop header is a 400.
  serviceCalls = [];
  {
    const r = await call("/plugins/tool/run", { "x-hearth-hops": "two" });
    assert.equal(r.status, 400);
    assert.equal(serviceCalls.length, 0);
  }

  // A blank hop header is treated as zero.
  serviceCalls = [];
  {
    const r = await call("/plugins/tool/run", { "x-hearth-hops": "" });
    assert.equal(r.status, 200);
    assert.equal(serviceCalls.length, 1);
    assert.equal(serviceCalls[0]!.headers["x-hearth-hops"], "1");
  }

  // A caller's x-hearth-hops at the limit is refused (cannot be spoofed to bypass).
  serviceCalls = [];
  {
    const r = await call("/plugins/tool/run", { "x-hearth-hops": "99" });
    assert.equal(r.status, 508);
    assert.equal(serviceCalls.length, 0);
  }

  // pluginsMaxHops can be configured.
  {
    const cfg = parseConfig({ version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } }, pluginsMaxHops: 1 });
    assert.equal(cfg.pluginsMaxHops, 1);
  }

  console.log("pluginhops: all tests passed");
} catch (e) {
  console.error("pluginhops: FAILED");
  console.error(e);
  process.exit(1);
} finally {
  await node.close();
  svc.close();
}
