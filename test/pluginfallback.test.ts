/**
 * A plugin's fallback: another plugin that answers /plugins/<name>/* when this one cannot.
 *
 *   - config: a fallback is a plugin that serves an API other than MCP, not the plugin itself
 *   - a fallback is one hop, with the same request unless it names an adapter: `fallback.adapt` is a
 *     `trust: code` adapter plugin, and a name that is no such plugin is refused (test/fallbackadapt.test.ts)
 *   - a plugin that cannot be reached, answers 5xx or 429 hands the request to its fallback; one
 *     that answers 4xx does not
 *   - the fallback is sent the same request and its own headers, not the plugin's
 *   - the caller's router is asked about the fallback too: one it would refuse does not answer
 *   - a host that never answers the connection falls back after the connect deadline, not the OS's
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "../src/config/config.js";
import { ConfigError } from "../src/config/read.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const withPlugins = (plugins: unknown) => parseConfig({ ...base, plugins });
const svc = (more: object = {}) => ({ serves: "http://127.0.0.1:2", trust: "http", ...more });
assert.deepEqual(withPlugins({ a: svc({ fallback: "b" }), b: svc() }).plugins.a!.fallback, { plugin: "b" });
assert.deepEqual(withPlugins({ a: svc({ fallback: { plugin: "b" } }), b: svc() }).plugins.a!.fallback, { plugin: "b" });
assert.throws(() => withPlugins({ a: svc({ fallback: "nope" }) }), ConfigError, "a fallback names a plugin");
assert.throws(() => withPlugins({ a: svc({ fallback: "a" }) }), ConfigError, "not the plugin itself");
assert.throws(() => withPlugins({ a: svc({ mcp: true, fallback: "b" }), b: svc() }), ConfigError, "an MCP server has no fallback");
assert.throws(() => withPlugins({ a: svc({ fallback: "b" }), b: svc({ mcp: true }) }), ConfigError, "a fallback serves an API other than MCP");
// An adapter is a line's `adapt:` now, so the removed key is refused with the way to write what it meant.
assert.throws(
  () => withPlugins({ a: svc({ fallback: { plugin: "b", adapt: "x" } }), b: svc() }),
  (e: unknown) => e instanceof ConfigError && /fallback\.adapt names x, which is not a plugin/.test(e.message),
  "a fallback's adapt must name an adapter plugin",
);

// --- a node with fallbacks ---------------------------------------------------
const got: string[] = [];
const service = createServer((rq, rs) => {
  got.push(rq.url!);
  const say = (status: number, body: unknown) => rs.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (rq.url!.startsWith("/search/")) {
    if (rq.url!.includes("busy")) return say(503, { error: "busy" });
    if (rq.url!.includes("full")) return say(429, { error: "slow down" });
    if (rq.url!.includes("gone")) return say(404, { error: "no such page" });
    return say(200, { from: "search", results: [] });
  }
  if (rq.url!.startsWith("/only/")) return say(503, { error: "the only plugin is busy" });
  if (rq.url!.startsWith("/backup/")) return say(200, { from: "backup", at: rq.url });
  if (rq.url!.startsWith("/twin/")) return say(200, { from: "twin", at: rq.url, key: rq.headers["x-api-key"] });
  rs.writeHead(404).end();
});
await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
const serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
const port = () => new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const free = await port();
const closed = await port();
const dir = mkdtempSync(join(tmpdir(), "hearth-plugin-fallback-"));
const cfgPath = join(dir, "hearth.yaml");
writeFileSync(cfgPath, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free}}
backends:
  main: {url: http://127.0.0.1:1, serves: [m]}
models:
  m: {backend: main}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
routers:
  narrow:
    flows:
      plugins: {inputs: [API], steps: [{when: {variant: [search]}, to: {asked: true}}, {to: {refuse: "only search"}}]}
      rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
  single:
    flows:
      plugins: {inputs: [API], steps: [{when: {variant: [only]}, to: {plugin: only}}, {to: {refuse: "only the one plugin"}}]}
      rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: k-app, label: app}
  - {key: k-narrow, label: narrow}
  - {key: k-single, label: single}
callers: {narrow: narrow, single: single}
plugins:
  search: {serves: "${serviceUrl}/search", trust: http, fallback: backup}
  backup: {serves: "${serviceUrl}/backup", trust: http, headers: {X-Api-Key: backup-key}}
  lost: {serves: "http://127.0.0.1:${closed}", trust: http, fallback: twin, headers: {X-Api-Key: lost-key}}
  dark: {serves: "http://10.255.255.1:9", trust: http, fallback: twin}
  twin: {serves: "${serviceUrl}/twin", trust: http, headers: {X-Api-Key: twin-key}}
  only: {serves: "${serviceUrl}/only", trust: http}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));
const call = async (path: string, key = "k-app") => {
  const r = await fetch(`http://127.0.0.1:${free}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

try {
  assert.deepEqual(await call("/plugins/search/page?q=1"), { status: 200, body: { from: "search", results: [] } }, "a plugin that answers is not replaced");
  assert.ok(!got.some((u) => u.startsWith("/backup/")), "and its fallback is not asked");

  for (const m of ["busy", "full"] as const) {
    const r = await call(`/plugins/search/${m}?q=hearth`);
    assert.deepEqual(r, { status: 200, body: { from: "backup", at: `/backup/${m}?q=hearth` } }, `${m}: the fallback answers the same request`);
  }

  // A caller whose router reaches search but not backup gets the line's failure, not backup's answer.
  const narrow = await call("/plugins/search/busy?q=1", "k-narrow");
  assert.equal(narrow.status, 502);
  assert.match(String(narrow.body.error), /fallback backup is not open to this caller/);

  // A 4xx is the plugin's own answer, not a failure: no fallback.
  assert.deepEqual(await call("/plugins/search/gone"), { status: 404, body: { error: "no such page" } });

  // A 5xx with no fallback and no next line is relayed as it always was: there is nowhere else to go.
  assert.deepEqual(await call("/plugins/only/x", "k-single"), { status: 503, body: { error: "the only plugin is busy" } });

  // With no adapter in reach, the same request goes to the fallback, which sends its own headers.
  assert.deepEqual(
    await call("/plugins/lost/a/b?c=1"),
    { status: 200, body: { from: "twin", at: "/twin/a/b?c=1", key: "twin-key" } },
    "the fallback's own headers, not the plugin's",
  );

  // A host that never answers the connection is given up on in seconds, not when the OS stops trying.
  const t0 = Date.now();
  assert.deepEqual(await call("/plugins/dark/x"), { status: 200, body: { from: "twin", at: "/twin/x", key: "twin-key" } });
  assert.ok(Date.now() - t0 < 6_000, `a silent host falls back within the connect deadline (took ${Date.now() - t0} ms)`);
} finally {
  await node.close();
  service.close();
}
console.log("pluginfallback: ok");
