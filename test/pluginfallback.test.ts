/**
 * A plugin's fallback: another plugin that answers /plugins/<name>/* when this one cannot.
 *
 *   - config: a fallback is a plugin that serves an API other than MCP, not the plugin itself; `adapt` is an adapter hearth has
 *   - the searxng-to-degoog adapter carries a SearXNG JSON search over and brings degoog's answer back as SearXNG's
 *   - a plugin that cannot be reached, answers 5xx or 429 hands the request to its fallback; one that answers 4xx does not
 *   - a request its adapter has no counterpart for is not carried over: the caller gets the plugin's own failure
 *   - without `adapt`, the fallback is sent the same request
 *   - a host that never answers the connection falls back after the connect deadline, not the OS's
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ADAPTERS } from "../src/adapt.js";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const withPlugins = (plugins: unknown) => parseConfig({ ...base, plugins });
const svc = (more: object = {}) => ({ serves: "http://127.0.0.1:2", trust: "http", ...more });
assert.deepEqual(withPlugins({ a: svc({ fallback: "b" }), b: svc() }).plugins.a!.fallback, { plugin: "b", adapt: null });
assert.deepEqual(withPlugins({ a: svc({ fallback: { plugin: "b", adapt: "searxng-to-degoog" } }), b: svc() }).plugins.a!.fallback, { plugin: "b", adapt: "searxng-to-degoog" });
assert.throws(() => withPlugins({ a: svc({ fallback: "nope" }) }), ConfigError, "a fallback names a plugin");
assert.throws(() => withPlugins({ a: svc({ fallback: "a" }) }), ConfigError, "not the plugin itself");
assert.throws(() => withPlugins({ a: svc({ fallback: { plugin: "b", adapt: "nope" } }), b: svc() }), ConfigError, "an adapter hearth has");
assert.throws(() => withPlugins({ a: svc({ mcp: true, fallback: "b" }), b: svc() }), ConfigError, "an MCP server has no fallback");
assert.throws(() => withPlugins({ a: svc({ fallback: "b" }), b: svc({ mcp: true }) }), ConfigError, "a fallback serves an API other than MCP");

// --- the adapter ----------------------------------------------------------------
const sx = ADAPTERS["searxng-to-degoog"]!;
const ask = (path: string, q: string, method = "GET") => sx.request(method, path, new URLSearchParams(q));
assert.deepEqual(ask("/search", "q=hearth&format=json&pageno=2&categories=images&language=en"), { path: "/api/search", query: new URLSearchParams("q=hearth&page=2&type=images") });
assert.deepEqual(ask("/", "q=a+b&format=json"), { path: "/api/search", query: new URLSearchParams("q=a+b") });
assert.equal(ask("/search", "q=hearth"), null, "only the JSON format has a counterpart");
assert.equal(ask("/search", "format=json"), null, "a search with no query has none");
assert.equal(ask("/config", "format=json&q=x"), null);
assert.equal(ask("/search", "q=x&format=json", "POST"), null);
const back = JSON.parse(sx.response(Buffer.from(JSON.stringify({
  query: "hearth",
  results: [{ title: "T", url: "https://a.test", snippet: "S", source: "Bing", sources: ["Bing", "DuckDuckGo"], score: 3 }, { title: "no url" }],
  relatedSearches: ["hearth stone"],
  engineTimings: [{ name: "Bing", status: "ok" }, { name: "Brave", status: "timeout" }],
}))).toString());
assert.deepEqual(back, {
  query: "hearth", number_of_results: 1,
  results: [{ url: "https://a.test", title: "T", content: "S", engine: "bing", engines: ["bing", "duckduckgo"], score: 3, category: "general" }],
  answers: [], corrections: [], infoboxes: [], suggestions: ["hearth stone"], unresponsive_engines: [["Brave", "timeout"]],
});
assert.throws(() => sx.response(Buffer.from("<html>")), "an answer that is not degoog's JSON is not passed off as SearXNG's");

// --- a node --------------------------------------------------------------------------
let mode: "ok" | "busy" | "full" | "gone" = "ok";
const got: string[] = [];
const service = createServer((rq, rs) => {
  got.push(rq.url!);
  const say = (status: number, body: unknown) => rs.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (rq.url!.startsWith("/search/")) {
    if (mode === "busy") return say(503, { error: "busy" });
    if (mode === "full") return say(429, { error: "slow down" });
    if (mode === "gone") return say(404, { error: "no such page" });
    return say(200, { from: "search", results: [] });
  }
  if (rq.url!.startsWith("/backup/api/search")) return say(200, { query: "q", results: [{ title: "B", url: "https://b.test", snippet: "from backup", source: "Bing" }] });
  if (rq.url!.startsWith("/twin/")) return say(200, { from: "twin", at: rq.url });
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
apiKeys:
  - {key: k-app, label: app}
plugins:
  search: {serves: "${serviceUrl}/search", trust: http, fallback: {plugin: backup, adapt: searxng-to-degoog}}
  backup: {serves: "${serviceUrl}/backup", trust: http}
  lost: {serves: "http://127.0.0.1:${closed}", trust: http, fallback: twin}
  dark: {serves: "http://10.255.255.1:9", trust: http, fallback: twin}
  twin: {serves: "${serviceUrl}/twin", trust: http}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));
const call = async (path: string) => {
  const r = await fetch(`http://127.0.0.1:${free}${path}`, { headers: { Authorization: "Bearer k-app" } });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

try {
  const q = "/plugins/search/search?q=hearth&format=json";
  assert.deepEqual(await call(q), { status: 200, body: { from: "search", results: [] } }, "a plugin that answers is not replaced");
  assert.ok(!got.some((u) => u.startsWith("/backup/")), "and its fallback is not asked");

  for (const m of ["busy", "full"] as const) {
    mode = m;
    const r = await call(q);
    assert.equal(r.status, 200, `${m}: the fallback answers`);
    assert.deepEqual((r.body.results as unknown[])[0], { url: "https://b.test", title: "B", content: "from backup", engine: "bing", engines: ["bing"], category: "general" }, "in SearXNG's shape");
  }
  assert.ok(got.includes("/backup/api/search?q=hearth"), "the fallback was asked on its own API");

  mode = "gone";
  assert.equal((await call(q)).status, 404, "a 4xx is the plugin's answer, not a failure");
  mode = "busy";
  assert.equal((await call("/plugins/search/search?q=hearth")).status, 503, "a request the adapter cannot carry gets the plugin's own failure");

  // With no adapter, the same request goes to the fallback; here the plugin cannot be reached at all.
  assert.deepEqual(await call("/plugins/lost/a/b?c=1"), { status: 200, body: { from: "twin", at: "/twin/a/b?c=1" } });

  // A host that never answers the connection is given up on in seconds, not when the OS stops trying.
  const t0 = Date.now();
  assert.deepEqual(await call("/plugins/dark/x"), { status: 200, body: { from: "twin", at: "/twin/x" } });
  assert.ok(Date.now() - t0 < 6_000, `a silent host falls back within the connect deadline (took ${Date.now() - t0} ms)`);
} finally {
  await node.close();
  service.close();
}
console.log("pluginfallback: ok");
