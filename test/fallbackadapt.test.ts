/**
 * A plugin's fallback through an adapter: `plugins.<name>.fallback: { plugin, adapt }`. When the plugin
 * cannot answer, the adapter carries the caller's request over to the fallback's API and its 2xx answer
 * back, with no routing line of its own.
 *
 *   - config: `adapt` must name a trust: code plugin; the accepted shape keeps it on the fallback
 *   - the plugin fails: the fallback answers through the adapter
 *   - `null` from request(): the plugin's own failure stands
 *   - a response() that throws is a 502 naming the adapter
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

const refuses = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ConfigError && re.test(e.message));
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const svc = (more: object = {}) => ({ serves: "http://127.0.0.1:2", trust: "http", ...more });

// --- config -----------------------------------------------------------------
refuses(() => parseConfig({ ...base, plugins: { a: svc({ fallback: { plugin: "b", adapt: "nope" } }), b: svc() } }), /names nope, which is not a plugin under plugins:/);
refuses(() => parseConfig({ ...base, plugins: { a: svc({ fallback: { plugin: "b", adapt: "c" } }), b: svc(), c: svc() } }), /names c, which is not a trust: code plugin/);
const ok = parseConfig({ ...base, plugins: { a: svc({ fallback: { plugin: "b", adapt: "g" } }), b: svc(), g: { use: "file:./g.mjs", trust: "code" } } });
assert.deepEqual(ok.plugins.a!.fallback, { plugin: "b", adapt: "g" }, "the adapter stays on the fallback");

// --- a node whose plugin falls back through an adapter ----------------------
const api = createServer((rq, rs) => {
  const at = new URL(rq.url!, "http://here");
  const say = (status: number, body: unknown) => rs.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (at.pathname.startsWith("/primary/")) return say(503, { error: "busy" });
  if (at.pathname.startsWith("/other/")) {
    const q = at.searchParams.get("q") ?? "";
    if (q === "bad") return say(200, { oops: true });
    return say(200, { items: [{ link: "https://a.test" }], q });
  }
  rs.writeHead(404).end();
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
const free = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });

const dir = mkdtempSync(join(tmpdir(), "hearth-fallback-adapt-"));
const gate = join(dir, "gate.mjs");
writeFileSync(gate, `export default {
  apiVersion: 1,
  kinds: {},
  setup() {
    return {
      adapt: {
        request(req) {
          if (req.query.q === "none") return null;
          return { path: "/find", query: { q: req.query.q } };
        },
        response(res) {
          const d = JSON.parse(res.body);
          if (!Array.isArray(d.items)) throw new Error("no items list");
          return { contentType: "application/json", body: JSON.stringify({ results: d.items.map((i) => ({ url: i.link })), q: d.q }) };
        },
      },
    };
  },
};
`);
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
  primary: {serves: "${apiUrl}/primary", trust: http, fallback: {plugin: other, adapt: gate}}
  other: {serves: "${apiUrl}/other", trust: http}
  gate: {use: 'file:${gate}', trust: code, timeoutMs: 500}
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
  assert.equal(node.plugins.status().find((p) => p.name === "gate")!.state, "running", "a fallback's adapter starts like a line's");
  // The plugin answers 503: its fallback answers through the adapter, with no second line.
  assert.deepEqual(await call("/plugins/primary/search?q=hearth"), { status: 200, body: { results: [{ url: "https://a.test" }], q: "hearth" } });
  // No counterpart on the fallback's API: the plugin's own failure is the caller's.
  assert.equal((await call("/plugins/primary/search?q=none")).status, 502, "null from request() leaves the plugin's failure");
  // An answer the adapter cannot read is a 502 that names it.
  const bad = await call("/plugins/primary/search?q=bad");
  assert.equal(bad.status, 502);
  assert.match(String(bad.body.error), /adapter gate could not read other's answer/);
} finally {
  await node.close();
  api.close();
}
console.log("fallbackadapt: ok");
