/**
 * `headers` on a plugin service: sent on every call hearth makes to it, for a service that takes its key in a
 * header other than Authorization.
 *
 *   - config: values may be `env:NAME`; headers are for services only; `key` may be left out
 *   - the MCP check, the passthrough, the console's probe and a hook service's manifest all carry them
 *   - a caller's header of the same name is replaced, and the caller's hearth key never goes on
 *   - a value written into the file is masked in the console like any other secret
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "../src/config/config.js";
import { pluginAuth } from "../src/config/plugins.js";
import { ConfigError } from "../src/config/read.js";
import { maskedText } from "../src/config/configfile.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

const SECRET = "svc-header-secret";
process.env.TEST_HDR_KEY = SECRET;

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const parses = (extra: Record<string, unknown>) => parseConfig({ ...base, ...extra });
const svc = parses({ plugins: { s: { serves: "http://x:1", trust: "http", headers: { "X-Api-Key": "env:TEST_HDR_KEY", "X-Plain": "v" } } } }).plugins.s!;
assert.deepEqual(svc.headers, { "X-Api-Key": SECRET, "X-Plain": "v" }, "env:NAME is read from the environment");
assert.equal(svc.key, null, "no key is needed when the headers carry the credential");
assert.deepEqual(parses({ plugins: { s: { serves: "http://x:1", trust: "http" } } }).plugins.s!.headers, {}, "none by default");
assert.throws(() => parses({ plugins: { s: { serves: "http://x:1", trust: "http", headers: { "X-Api-Key": 5 } } } }), ConfigError, "a value is a string");
assert.throws(() => parses({ plugins: { s: { serves: "http://x:1", trust: "http", headers: { "X-Api-Key": "env:TEST_HDR_NOPE" } } } }), ConfigError, "a missing variable is a config error");
assert.throws(() => parses({ plugins: { c: { use: "file:./p.js", trust: "code", headers: { a: "b" } } } }), ConfigError, "code needs no headers");
assert.deepEqual(pluginAuth({ key: "k", headers: { "X-Api-Key": "a" } }), { authorization: "Bearer k", "x-api-key": "a" }, "beside the key, names lowercased");
assert.deepEqual(pluginAuth({ key: "k", headers: { Authorization: "Token t" } }), { authorization: "Token t" }, "an Authorization header takes the key's place");

// The console never sees a header value or key written into the file.
const file = `plugins:\n  s:\n    serves: http://x:1\n    trust: http\n    key: literal-plugin-key\n    headers:\n      X-Api-Key: literal-header-key\n      X-Env: env:TEST_HDR_KEY\n`;
const shown = maskedText(file);
assert.ok(!shown.includes("literal-plugin-key") && !shown.includes("literal-header-key"), "secrets are stand-ins in the console");
assert.match(shown, /X-Env: env:TEST_HDR_KEY/, "an env: reference is shown as written");

// --- a service that only takes its key as X-Api-Key ---------------------------------
const backend = createServer((rq, rs) => {
  const say = (body: unknown) => rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (rq.url === "/v1/models") return say({ data: [{ id: "m" }] });
  if (rq.url === "/running") return say({ running: [] });
  rs.writeHead(404).end();
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const seen: { method: string; url: string; apiKey: unknown; auth: unknown }[] = [];
const service = createServer(async (rq, rs) => {
  let raw = "";
  for await (const c of rq) raw += c;
  seen.push({ method: rq.method!, url: rq.url!, apiKey: rq.headers["x-api-key"], auth: rq.headers.authorization });
  // As some hosted APIs do: a bearer token is refused, only the header is a key.
  if (rq.headers.authorization !== undefined) return rs.writeHead(401).end("Expected OAuth 2 access token");
  if (rq.headers["x-api-key"] !== SECRET) return rs.writeHead(403).end();
  if (rq.url === "/hooks/manifest") return rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ apiVersion: 1, kinds: { chat: ["log"] } }));
  if (rq.url === "/mcp" && rq.method === "DELETE") return rs.writeHead(200).end();
  if (rq.url === "/mcp") {
    const m = JSON.parse(raw) as { id?: number; method: string };
    if (m.id === undefined) return rs.writeHead(202).end();
    const result = m.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "header-tools", version: "1.0" } } : { tools: [{ name: "a" }] };
    return rs.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s-1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  }
  rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ path: rq.url }));
});
await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
const serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

const free = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const dir = mkdtempSync(join(tmpdir(), "hearth-headers-"));
const cfgPath = join(dir, "hearth.yaml");
writeFileSync(cfgPath, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free}}
backends:
  main: {url: ${backendUrl}, serves: [m]}
models:
  m: {backend: main}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: k-app, label: app}
plugins:
  tools:
    serves: ${serviceUrl}
    trust: http
    mcp: true
    headers: {X-Api-Key: "env:TEST_HDR_KEY"}
  hooked:
    use: ${serviceUrl}/hooks
    trust: http
    everyLine: true
    headers: {X-Api-Key: "env:TEST_HDR_KEY"}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));
const url = `http://127.0.0.1:${free}`;
const status = () => Object.fromEntries(node.plugins.status().map((p) => [p.name, p]));
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(ok(), what); };

try {
  // A hook service's manifest is read with its headers, or it would not be running.
  assert.equal(status().hooked!.state, "running", `the manifest is fetched with the header: ${status().hooked!.error}`);

  // The MCP check at startup.
  await until(() => (status().tools!.mcp?.checkedAt ?? 0) > 0, "the served MCP endpoint is checked at startup");
  assert.deepEqual({ server: status().tools!.mcp!.server, tools: status().tools!.mcp!.tools, error: status().tools!.mcp!.error }, { server: "header-tools 1.0", tools: 1, error: null },
    "the check is sent the header and no bearer token");

  // The passthrough: the caller's own copy of the header is replaced, and its hearth key stays here.
  seen.length = 0;
  const r = await fetch(`${url}/plugins/tools/v1/projects?x=1`, { headers: { Authorization: "Bearer k-app", "X-API-KEY": "forged" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { path: "/v1/projects?x=1" });
  assert.deepEqual(seen, [{ method: "GET", url: "/v1/projects?x=1", apiKey: SECRET, auth: undefined }], "the plugin's header goes on; the caller's key and its forged header do not");

  // MCP through the passthrough, as a client calls it.
  const m = await fetch(`${url}/plugins/tools/mcp`, { method: "POST", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) });
  assert.equal(m.status, 200);
  assert.deepEqual(((await m.json()) as { result: unknown }).result, { tools: [{ name: "a" }] });

  // The console's probe, before a plugin is added.
  const probe = (b: Record<string, unknown>) => fetch(`${url}/plugins/probe`, { method: "POST", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((x) => x.json() as Promise<Record<string, unknown>>);
  assert.deepEqual(await probe({ url: serviceUrl, mcp: "/mcp", headers: { "X-Api-Key": "env:TEST_HDR_KEY" } }), { ok: true, url: serviceUrl, server: "header-tools 1.0", tools: 1 });
  assert.match(String((await probe({ url: serviceUrl, mcp: "/mcp" })).problem), /answered 403/, "without the header it is refused");
  assert.equal((await probe({ url: `${serviceUrl}/hooks`, headers: { "X-Api-Key": "env:TEST_HDR_KEY" } })).ok, true, "a hook service's manifest too");
  const bad = await fetch(`${url}/plugins/probe`, { method: "POST", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json" }, body: JSON.stringify({ url: serviceUrl, headers: ["X-Api-Key"] }) });
  assert.equal(bad.status, 400, "headers is a map");

  // Nothing the console is shown carries the value.
  assert.ok(!JSON.stringify(node.plugins.status()).includes(SECRET), "plugin status never shows a header value");
} finally {
  await node.close();
  backend.close();
  service.close();
}
console.log("pluginheaders: ok");
