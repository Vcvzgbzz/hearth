/**
 * A plugin's fallback: another plugin that answers /plugins/<name>/* when this one cannot.
 *
 *   - config: a fallback is a plugin that serves an API other than MCP, not the plugin itself
 *   - config: `adapt` names a trust: code plugin that translates between the two APIs; it is
 *     validated at load (must be a code plugin, not the plugin itself, not the fallback)
 *   - the example searxng-to-degoog adapter translates the request path/query and rewrites the 2xx body
 *   - a plugin that cannot be reached, answers 5xx or 429 hands the request to its fallback; one that answers 4xx does not
 *   - a request its adapter has no counterpart for is not carried over: the caller gets the plugin's own failure
 *   - without `adapt`, the fallback is sent the same request
 *   - the caller's router is asked about the fallback too: one it would refuse does not answer
 *   - a host that never answers the connection falls back after the connect deadline, not the OS's
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, parseConfig } from "../src/config/config.js";
import { ConfigError } from "../src/config/read.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const withPlugins = (plugins: unknown) => parseConfig({ ...base, plugins });
const svc = (more: object = {}) => ({ serves: "http://127.0.0.1:2", trust: "http", ...more });
assert.deepEqual(withPlugins({ a: svc({ fallback: "b" }), b: svc() }).plugins.a!.fallback, { plugin: "b", adapt: null });
assert.deepEqual(withPlugins({ a: svc({ fallback: { plugin: "b" } }), b: svc() }).plugins.a!.fallback, { plugin: "b", adapt: null });
// An adapter names a trust: code plugin with a file: or npm: use
assert.deepEqual(
  withPlugins({
    a: svc({ fallback: { plugin: "b", adapt: "x" } }),
    b: svc(),
    x: { use: "file:./adapters/x.mjs", trust: "code" },
  }).plugins.a!.fallback,
  { plugin: "b", adapt: "x" },
  "adapt names a code plugin"
);
// adapt naming an http plugin is refused
assert.throws(() => withPlugins({
  a: svc({ fallback: { plugin: "b", adapt: "y" } }),
  b: svc(),
  y: { serves: "http://127.0.0.1:9", trust: "http" },
}), ConfigError, "adapt names a plugin under plugins:");
// adapt naming a plugin that has no use (serves only) is refused
assert.throws(() => withPlugins({
  a: svc({ fallback: { plugin: "b", adapt: "z" } }),
  b: svc(),
  z: { serves: "http://127.0.0.1:9", trust: "http" },
}), ConfigError, "adapt names a plugin with use file: or npm:");
// adapt naming itself is refused
assert.throws(() => withPlugins({
  a: svc({ fallback: { plugin: "b", adapt: "a" } }),
  b: svc(),
}), ConfigError, "adapt does not name the plugin itself");
// adapt naming the fallback is refused
assert.throws(() => withPlugins({
  a: svc({ fallback: { plugin: "b", adapt: "b" } }),
  b: svc(),
}), ConfigError, "adapt does not name the fallback");
// adapt naming a missing plugin is refused
assert.throws(() => withPlugins({
  a: svc({ fallback: { plugin: "b", adapt: "nope" } }),
  b: svc(),
}), ConfigError, "adapt names a plugin under plugins:");
assert.throws(() => withPlugins({ a: svc({ fallback: "nope" }) }), ConfigError, "a fallback names a plugin");
assert.throws(() => withPlugins({ a: svc({ fallback: "a" }) }), ConfigError, "not the plugin itself");
assert.throws(() => withPlugins({ a: svc({ mcp: true, fallback: "b" }), b: svc() }), ConfigError, "an MCP server has no fallback");
assert.throws(() => withPlugins({ a: svc({ fallback: "b" }), b: svc({ mcp: true }) }), ConfigError, "a fallback serves an API other than MCP");

// --- the example adapter module ------------------------------------------------------
const adapterPath = join(import.meta.dirname, "../examples/adapters/searxng-to-degoog.mjs");
assert.ok(readFileSync(adapterPath).length > 0, "the example adapter exists");
const adapterMod = (await import(pathToFileURL(adapterPath).href)).default;
assert.equal(adapterMod.apiVersion, 1);
assert.deepEqual(adapterMod.kinds, {}, "an adapter-only plugin hooks nothing");
const adapterHooks = adapterMod.setup({ name: "searxng-to-degoog", config: {}, log: silentLogger, internal: { url: "", token: "" } });
const sx = adapterHooks.adapt;
assert.ok(sx !== null && sx.request !== undefined && sx.response !== undefined, "the example exports an adapter");
const ask = (path: string, q: string, method = "GET") => sx!.request(method, path, new URLSearchParams(q));
assert.deepEqual(ask("/search", "q=hearth&format=json&pageno=2&categories=images&language=en"), { path: "/api/search", query: new URLSearchParams("q=hearth&page=2&type=images") });
assert.deepEqual(ask("/", "q=a+b&format=json"), { path: "/api/search", query: new URLSearchParams("q=a+b") });
assert.equal(ask("/search", "q=hearth"), null, "only the JSON format has a counterpart");
assert.equal(ask("/search", "format=json"), null, "a search with no query has none");
assert.equal(ask("/config", "format=json&q=x"), null);
assert.equal(ask("/search", "q=x&format=json", "POST"), null);
const back = JSON.parse(sx!.response(Buffer.from(JSON.stringify({
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
assert.throws(() => sx!.response(Buffer.from("<html>")), "an answer that is not the fallback's JSON is not passed off as the primary's");

// --- a node with an adapter -----------------------------------------------------
let mode: "ok" | "busy" | "full" | "gone" = "ok";
const got: string[] = [];
const encodings: (string | undefined)[] = [];
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
  if (rq.url!.startsWith("/twin/")) return say(200, { from: "twin", at: rq.url, key: rq.headers["x-api-key"] });
  if (rq.url!.startsWith("/other/")) {
    encodings.push(rq.headers["accept-encoding"] as string | undefined);
    if (rq.url!.startsWith("/other/bad")) return rs.writeHead(200, { "Content-Type": "text/plain" }).end("not json");
    if (rq.url!.startsWith("/other/hang")) return say(200, { hang: true });
    if (rq.url!.startsWith("/other/missing")) return say(404, { error: "the other API has no such thing" });
    return say(200, { v: 1 });
  }
  rs.writeHead(404).end();
});
await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
const serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
const port = () => new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const free = await port();
const closed = await port();
const dir = mkdtempSync(join(tmpdir(), "hearth-plugin-fallback-"));
const cfgPath = join(dir, "hearth.yaml");
// An adapter that carries /<x> over to /other/<x> and wraps the answer, refusing one that is not JSON.
const wrapPath = join(dir, "wrap.mjs");
writeFileSync(wrapPath, `export default { apiVersion: 1, kinds: {}, setup: () => ({ adapt: {
  request: (method, path, query) => { globalThis.wrapAsked = (globalThis.wrapAsked ?? 0) + 1; return { path: "/other" + path, query }; },
  response: async (body) => body.includes("hang") ? new Promise(() => {}) : Buffer.from(JSON.stringify({ wrapped: JSON.parse(body.toString("utf8")) })),
} }) };`);
// A plugin named as an adapter that does not adapt.
const hollowPath = join(dir, "hollow.mjs");
writeFileSync(hollowPath, "export default { apiVersion: 1, kinds: {}, setup: () => ({}) };");
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
apiKeys:
  - {key: k-app, label: app}
  - {key: k-narrow, label: narrow}
callers: {narrow: narrow}
plugins:
  search: {serves: "${serviceUrl}/search", trust: http, fallback: {plugin: backup, adapt: searxng-to-degoog}}
  backup: {serves: "${serviceUrl}/backup", trust: http}
  lost: {serves: "http://127.0.0.1:${closed}", trust: http, fallback: twin, headers: {X-Api-Key: lost-key}}
  dark: {serves: "http://10.255.255.1:9", trust: http, fallback: twin}
  twin: {serves: "${serviceUrl}/twin", trust: http, headers: {X-Api-Key: twin-key}}
  wrapped: {serves: "${serviceUrl}/search", trust: http, fallback: {plugin: other, adapt: wrap}}
  other: {serves: "${serviceUrl}", trust: http}
  hollowed: {serves: "${serviceUrl}/search", trust: http, fallback: {plugin: twin, adapt: hollow}}
  wrap: {use: 'file:${wrapPath}', trust: code, timeoutMs: 200}
  hollow: {use: 'file:${hollowPath}', trust: code}
  searxng-to-degoog: {use: 'file:${adapterPath}', trust: code}
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
  const q = "/plugins/search/search?q=hearth&format=json";
  assert.deepEqual(await call(q), { status: 200, body: { from: "search", results: [] } }, "a plugin that answers is not replaced");
  assert.ok(!got.some((u) => u.startsWith("/backup/")), "and its fallback is not asked");

  for (const m of ["busy", "full"] as const) {
    mode = m;
    const r = await call(q);
    assert.equal(r.status, 200, `${m}: the fallback answers`);
    assert.deepEqual((r.body.results as unknown[])[0], { url: "https://b.test", title: "B", content: "from backup", engine: "bing", engines: ["bing"], category: "general" }, "in the primary's shape, via the adapter");
  }
  assert.ok(got.includes("/backup/api/search?q=hearth"), "the fallback was asked on its own API");

  // A caller whose router reaches search but not backup gets search's failure, not backup's answer.
  mode = "busy";
  const narrow = await call(q, "k-narrow");
  assert.equal(narrow.status, 502);
  assert.match(String(narrow.body.error), /fallback backup is not open to this caller/);

  mode = "gone";
  assert.equal((await call(q)).status, 404, "a 4xx is the plugin's answer, not a failure");
  mode = "busy";
  assert.equal((await call("/plugins/search/search?q=hearth")).status, 503, "a request the adapter cannot carry gets the plugin's own failure");

  // With no adapter, the same request goes to the fallback; here the plugin cannot be reached at all.
  assert.deepEqual(await call("/plugins/lost/a/b?c=1"), { status: 200, body: { from: "twin", at: "/twin/a/b?c=1", key: "twin-key" } }, "sent its own headers, not the plugin's");

  // An adapted answer is rewritten; one the adapter cannot read is a 502 naming it; a non-2xx passes as it is.
  const asked = () => (globalThis as { wrapAsked?: number }).wrapAsked ?? 0;
  mode = "ok";
  assert.deepEqual(await call("/plugins/wrapped/ok?x=1"), { status: 200, body: { from: "search", results: [] } });
  assert.equal(asked(), 0, "an adapter is not run on a request the plugin answers");
  mode = "busy";
  assert.deepEqual(await call("/plugins/wrapped/ok?x=1"), { status: 200, body: { wrapped: { v: 1 } } });
  assert.equal(asked(), 1, "it runs once the plugin has failed");
  assert.ok(got.includes("/other/ok?x=1"), "the adapter chose the path on the fallback's API");
  assert.equal(encodings[0], undefined, "an answer the adapter reads is asked for uncompressed");
  const bad = await call("/plugins/wrapped/bad");
  assert.equal(bad.status, 502);
  assert.match(String(bad.body.error), /adapter wrap could not read its fallback other's answer/);
  const hung = await call("/plugins/wrapped/hang");
  assert.equal(hung.status, 502, "an adapter that never answers is held to its timeoutMs");
  assert.match(String(hung.body.error), /adapter wrap could not read .*gave no answer in 200 ms/);
  assert.deepEqual(await call("/plugins/wrapped/missing"), { status: 404, body: { error: "the other API has no such thing" } }, "a non-2xx is not given to the adapter");

  // A plugin named as an adapter that returns no adapt does not start, and the plugin it adapts for has no fallback.
  const shown = Object.fromEntries(node.plugins.status().map((p) => [p.name, p]));
  assert.equal(shown.hollow!.state, "failed");
  assert.match(String(shown.hollow!.error), /named as an adapter \(plugins\.hollowed\.fallback\.adapt\)/);
  assert.equal(shown.wrap!.state, "running", "an adapter that hooks nothing runs");
  assert.equal((await call("/plugins/hollowed/x")).status, 503, "with its adapter down, the caller gets the plugin's own failure");

  // A host that never answers the connection is given up on in seconds, not when the OS stops trying.
  const t0 = Date.now();
  assert.deepEqual(await call("/plugins/dark/x"), { status: 200, body: { from: "twin", at: "/twin/x", key: "twin-key" } });
  assert.ok(Date.now() - t0 < 6_000, `a silent host falls back within the connect deadline (took ${Date.now() - t0} ms)`);
} finally {
  await node.close();
  service.close();
}
console.log("pluginfallback: ok");
