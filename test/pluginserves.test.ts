/**
 * A plugin that `serves` an API: hearth answers `/plugins/<name>/*` by forwarding to it.
 *
 *   - config: `serves` alone needs no `use` and no manifest; it is for services only; `probe` is taken
 *   - the path under the plugin, the query, the method and the body reach the service as sent
 *   - the caller's key for this node stays here; the plugin's own key goes on, with who is calling
 *   - a streamed answer reaches the caller as it is written, before the service has finished
 *   - a paused plugin, an unknown name, a peer or a key scoped to models are refused
 *   - a service that cannot be reached is a 502, counted on the plugin
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const parses = (extra: Record<string, unknown>) => parseConfig({ ...base, ...extra });
const only = parses({ plugins: { crawl: { serves: "http://x:1/api/", trust: "http" } } }).plugins.crawl!;
assert.equal(only.use, null, "a plugin that only serves names no hook endpoint");
assert.equal(only.serves, "http://x:1/api", "a trailing slash is dropped, so paths join cleanly");
assert.throws(() => parses({ plugins: { p: { trust: "http" } } }), ConfigError, "a plugin needs use or serves");
assert.throws(() => parses({ plugins: { p: { serves: "x:1", trust: "http" } } }), ConfigError, "serves is a URL");
assert.throws(() => parses({ plugins: { p: { serves: "http://x:1" } } }), ConfigError, "a service still says trust: http");
assert.throws(() => parses({ plugins: { p: { use: "file:./p.js", trust: "code", serves: "http://x:1" } } }), ConfigError, "code answers no forwarded API");
assert.throws(() => parses({ plugins: { probe: { serves: "http://x:1", trust: "http" } } }), ConfigError, "/plugins/probe is the console's");

// --- a node with a serving plugin ---------------------------------------------
const backend = createServer((rq, rs) => {
  const say = (body: unknown) => rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (rq.url === "/v1/models") return say({ data: [{ id: "m" }] });
  if (rq.url === "/running") return say({ running: [] });
  rs.writeHead(404).end();
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

let release: () => void = () => {};
const hung: import("node:http").ServerResponse[] = [];
const got: { method: string; url: string; auth: string | undefined; caller: string | undefined; body: string }[] = [];
const service = createServer(async (rq, rs) => {
  let body = "";
  for await (const c of rq) body += c;
  got.push({ method: rq.method!, url: rq.url!, auth: rq.headers.authorization, caller: rq.headers["x-hearth-caller"] as string | undefined, body });
  // Takes the request and never answers it.
  if (rq.url === "/api/silent") { hung.push(rs); return; }
  if (rq.url === "/api/stream") {
    // The first event goes out at once; the rest only once the test has read it.
    rs.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s1" });
    rs.write("data: one\n\n");
    await new Promise<void>((r) => { release = r; });
    rs.end("data: two\n\n");
    return;
  }
  rs.writeHead(201, { "Content-Type": "application/json", "X-Service": "yes" }).end(JSON.stringify({ echoed: body }));
});
await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
const serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

const free = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const dir = mkdtempSync(join(tmpdir(), "hearth-serves-"));
const cfgPath = join(dir, "hearth.yaml");
process.env.TEST_SERVES_KEY = "svc-secret";
writeFileSync(cfgPath, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free}}
backends:
  main: {url: ${backendUrl}, serves: [m]}
models:
  m: {backend: main}
backendDefaults: {firstByteMs: 400}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: k-app, label: app}
  - {key: k-narrow, label: narrow, models: [m]}
plugins:
  crawl: {serves: "${serviceUrl}/api", trust: http, key: "env:TEST_SERVES_KEY"}
  gone: {serves: "http://127.0.0.1:1", trust: http}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));
const url = `http://127.0.0.1:${free}`;
const call = (path: string, init: RequestInit & { key?: string } = {}) =>
  fetch(`${url}${path}`, { ...init, headers: { ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}), ...(init.headers as Record<string, string> | undefined) } });

try {
  const status = Object.fromEntries(node.plugins.status().map((p) => [p.name, p]));
  assert.equal(status.crawl!.state, "running", "no manifest is fetched for a plugin that only serves");
  assert.equal(status.crawl!.serves, `${serviceUrl}/api`);

  // Path, query, method, body and the service's own status and headers, each way.
  const r1 = await call("/plugins/crawl/crawl?depth=2", { method: "POST", key: "k-app", headers: { "Content-Type": "application/json", "X-Hearth-Caller": "forged" }, body: '{"urls":["a"]}' });
  assert.equal(r1.status, 201);
  assert.equal(r1.headers.get("x-service"), "yes");
  assert.deepEqual(await r1.json(), { echoed: '{"urls":["a"]}' });
  assert.deepEqual(got.at(-1), { method: "POST", url: "/api/crawl?depth=2", auth: "Bearer svc-secret", caller: "key:app", body: '{"urls":["a"]}' },
    "the caller's key stays here, the plugin's goes on, and who is calling cannot be forged");

  // A request just served stays in `live` long enough for the map to draw it, then is let go.
  const live = () => node.plugins.status().find((p) => p.name === "crawl")!.live;
  assert.equal(live().length, 1, "the map sees even a quick request");
  await new Promise((r) => setTimeout(r, 1_700));
  assert.deepEqual(live(), [], "and it is gone once it has been seen");

  // A stream reaches the caller before the service has finished writing it.
  const r2 = await call("/plugins/crawl/stream", { key: "k-app" });
  assert.equal(r2.headers.get("mcp-session-id"), "s1");
  const reader = r2.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /data: one/, "the first event arrives while the service still holds the stream open");
  release();
  let rest = "";
  for (let c = await reader.read(); !c.done; c = await reader.read()) rest += new TextDecoder().decode(c.value);
  assert.match(rest, /data: two/);

  // Who may not reach it.
  assert.equal((await call("/plugins/crawl/crawl", { key: "k-narrow" })).status, 403, "a key scoped to models reaches no service");
  assert.equal((await call("/plugins/crawl/crawl", { key: "wrong" })).status, 401);
  assert.equal((await call("/plugins/nope/x", { key: "k-app" })).status, 404);

  // A service that takes the request and never starts answering is let go after the first-byte deadline,
  // while the stream above, which answered at once, stayed open past it.
  const t0 = Date.now();
  const silent = await call("/plugins/crawl/silent", { key: "k-app" });
  assert.equal(silent.status, 502, "no first byte within backendDefaults.firstByteMs");
  assert.ok(Date.now() - t0 < 5_000, "and it is let go at the deadline, not when the caller gives up");

  // Down or paused.
  const r3 = await call("/plugins/gone/x", { key: "k-app" });
  assert.equal(r3.status, 502);
  assert.match(((await r3.json()) as { error: string }).error, /gone could not be reached/);
  assert.deepEqual(node.plugins.status().find((p) => p.name === "gone")!.served, { calls: 1, errors: 1 });
  assert.equal(node.plugins.pause("crawl", true), null);
  const r4 = await call("/plugins/crawl/crawl", { key: "k-app" });
  assert.equal(r4.status, 503);
  assert.match(((await r4.json()) as { error: string }).error, /crawl is paused/);
} finally {
  for (const rs of hung) rs.destroy();
  await node.close();
  backend.close();
  service.close();
}
console.log("pluginserves: ok");
