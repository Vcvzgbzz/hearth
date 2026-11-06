/**
 * Plugins that speak MCP: a served endpoint hearth checks, and a program hearth runs behind `/plugins/<name>/mcp`.
 *
 *   - config: `mcp` needs `serves`; `run` is code (trust: code) and stands alone; its env takes `env:NAME`
 *   - a served MCP endpoint is asked who it is and how many tools it has, with the plugin's key
 *   - a program hearth runs is initialized once; each caller's initialize is answered from that, with a session
 *   - two callers using the same request id each get their own answer
 *   - a notification is 202, a GET is 405, and a request the program makes of hearth is refused
 *   - a program that exits is started again, and answers again
 *   - an answer whose id comes back as a string is still matched to its request
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { rpcAnswer } from "../src/mcp.js";
import { createNode } from "../src/server.js";

// A served server's answer is matched to its request by id, also when it sends a number id back as a string.
assert.equal(rpcAnswer('{"jsonrpc":"2.0","id":"1","result":{}}', 1)?.id, "1");
assert.equal(rpcAnswer('data: {"jsonrpc":"2.0","id":2,"result":{}}\n', 2)?.id, 2);
assert.equal(rpcAnswer('{"jsonrpc":"2.0","id":"12","result":{}}', 1), null);

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const parses = (extra: Record<string, unknown>) => parseConfig({ ...base, ...extra });
process.env.TEST_MCP_SECRET = "from-env";
assert.equal(parses({ plugins: { t: { serves: "http://x:1", trust: "http", mcp: true } } }).plugins.t!.mcp, "/mcp", "mcp: true is /mcp");
assert.equal(parses({ plugins: { t: { serves: "http://x:1", trust: "http", mcp: "/v2/mcp" } } }).plugins.t!.mcp, "/v2/mcp");
assert.throws(() => parses({ plugins: { t: { serves: "http://x:1", trust: "http", mcp: "v2" } } }), ConfigError, "a path starts with /");
assert.throws(() => parses({ plugins: { t: { use: "http://x:1/h", trust: "http", mcp: true } } }), ConfigError, "mcp needs serves");
const ran = parses({ plugins: { t: { run: { command: "node", args: ["s.mjs"], env: { KEY: "env:TEST_MCP_SECRET" } }, trust: "code" } } }).plugins.t!;
assert.equal(ran.mcp, "/mcp", "a program hearth runs is an MCP server");
assert.deepEqual(ran.run, { command: "node", args: ["s.mjs"], env: { KEY: "from-env" }, cwd: null }, "its env takes env:NAME");
assert.throws(() => parses({ plugins: { t: { run: { command: "node" }, trust: "http" } } }), ConfigError, "run starts a program: trust: code");
assert.throws(() => parses({ plugins: { t: { run: { command: "node" } } } }), ConfigError, "and leaving trust out is not consent");
assert.throws(() => parses({ plugins: { t: { run: { command: "node" }, serves: "http://x:1", trust: "code" } } }), ConfigError, "run stands alone");
assert.throws(() => parses({ plugins: { t: { run: { command: "node" }, use: "file:./p.js", trust: "code" } } }), ConfigError, "run is a plugin of its own");

// --- a served MCP endpoint ------------------------------------------------------
const backend = createServer((rq, rs) => {
  const say = (body: unknown) => rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (rq.url === "/v1/models") return say({ data: [{ id: "m" }] });
  if (rq.url === "/running") return say({ running: [] });
  rs.writeHead(404).end();
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const asked: string[] = [];
const served = createServer(async (rq, rs) => {
  let raw = "";
  for await (const c of rq) raw += c;
  if (rq.headers.authorization !== "Bearer mcp-key") return rs.writeHead(401).end();
  if (rq.method === "DELETE") { asked.push("DELETE"); return rs.writeHead(200).end(); }
  const m = JSON.parse(raw) as { id?: number; method: string };
  asked.push(m.method);
  if (m.method === "initialize") {
    // Answered as a stream of events, as many servers do.
    rs.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s-1" });
    return rs.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "served-tools", version: "2.0" } } })}\n\n`);
  }
  if (m.id === undefined) return rs.writeHead(202).end();
  if (rq.headers["mcp-session-id"] !== "s-1") return rs.writeHead(400).end();
  rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] } }));
});
await new Promise<void>((r) => served.listen(0, "127.0.0.1", r));
const servedUrl = `http://127.0.0.1:${(served.address() as AddressInfo).port}`;

// --- a program that is an MCP server ---------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "hearth-mcp-"));
const program = join(dir, "server.mjs");
writeFileSync(program, `
import { createInterface } from "node:readline";
const say = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let inits = 0;
let refused = null;
const notes = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === 900) { refused = m.error?.message ?? null; return; }
  if (m.method?.startsWith("notifications/note")) { notes.push(m.params.n); return; }
  if (m.method === "tools/call" && m.params.name === "notes") return say({ id: m.id, result: { content: [{ type: "text", text: notes.join(",") }] } });
  if (m.method === "initialize") { inits++; return say({ id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "run-tools", version: "1.0" } } }); }
  if (m.method === "notifications/initialized") return say({ method: "roots/list", id: 900 });
  if (m.method === "tools/list") return say({ id: m.id, result: { tools: [{ name: "echo" }, { name: "inits" }] } });
  if (m.method === "tools/call" && m.params.name === "echo") return setTimeout(() => say({ id: m.id, result: { content: [{ type: "text", text: m.params.arguments.text + " " + process.env.SECRET }] } }), m.params.arguments.wait ?? 0);
  if (m.method === "tools/call" && m.params.name === "inits") return say({ id: m.id, result: { content: [{ type: "text", text: inits + " " + refused }] } });
  if (m.method === "tools/call" && m.params.name === "exit") process.exit(3);
  if (m.method === "tools/call" && m.params.name === "strid") return say({ id: String(m.id), result: { content: [{ type: "text", text: "id came back as a string" }] } });
});
`);

const free = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const cfgPath = join(dir, "hearth.yaml");
process.env.TEST_MCP_KEY = "mcp-key";
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
  tools: {serves: "${servedUrl}", trust: http, key: "env:TEST_MCP_KEY", mcp: true}
  runner:
    run: {command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(program)}], env: {SECRET: "env:TEST_MCP_SECRET"}}
    trust: code
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));
const url = `http://127.0.0.1:${free}`;
const status = () => Object.fromEntries(node.plugins.status().map((p) => [p.name, p]));
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(ok(), what); };
const rpc = async (body: unknown, session?: string) => {
  const r = await fetch(`${url}/plugins/runner/mcp`, { method: "POST", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, session: r.headers.get("mcp-session-id"), body: r.status === 200 ? await r.json() as { id: number; result?: { content?: { text: string }[]; serverInfo?: { name: string } }; error?: unknown } : null };
};

try {
  // The served endpoint, asked who it is with its own key.
  await until(() => (status().tools!.mcp?.checkedAt ?? 0) > 0, "the served MCP endpoint is checked at startup");
  assert.deepEqual({ server: status().tools!.mcp!.server, tools: status().tools!.mcp!.tools, error: status().tools!.mcp!.error }, { server: "served-tools 2.0", tools: 3, error: null });
  assert.deepEqual(asked.slice(0, 3), ["initialize", "notifications/initialized", "tools/list"], "the handshake a client makes");
  await until(() => asked.includes("DELETE"), "and the session it opened is ended");

  // The console checks an MCP server the same way before adding it.
  const probe = (b: Record<string, unknown>) => fetch(`${url}/plugins/probe`, { method: "POST", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<Record<string, unknown>>);
  assert.deepEqual(await probe({ url: servedUrl, mcp: "/mcp", key: "env:TEST_MCP_KEY" }), { ok: true, url: servedUrl, server: "served-tools 2.0", tools: 3 });
  assert.match(String((await probe({ url: servedUrl, mcp: "/mcp" })).problem), /answered 401: it wants a key/, "without its key it says so");

  // The program hearth runs.
  await until(() => status().runner!.mcp?.tools === 2, "the program is initialized and its tools counted");
  assert.equal(status().runner!.mcp!.server, "run-tools 1.0");
  assert.equal(status().runner!.run, `${process.execPath} ${program}`, "its command line is shown, never its env");
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "0" } } });
  assert.equal(init.status, 200);
  assert.equal(init.body!.result!.serverInfo!.name, "run-tools", "a caller's initialize is answered from hearth's own");
  assert.ok(init.session, "with a session id");
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session!)).status, 202);

  // Two callers, the same id, overlapping: each gets its own answer.
  const [slow, fast] = await Promise.all([
    rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { text: "slow", wait: 150 } } }),
    rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { text: "fast" } } }),
  ]);
  assert.deepEqual([slow.body!.id, slow.body!.result!.content![0]!.text], [7, "slow from-env"]);
  assert.deepEqual([fast.body!.id, fast.body!.result!.content![0]!.text], [7, "fast from-env"], "and the program got its env");
  const counted = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "inits", arguments: {} } });
  assert.match(counted.body!.result!.content![0]!.text, /^1 hearth does not answer/, "initialized once for every caller, and its own request refused");

  const strid = await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "strid", arguments: {} } });
  assert.deepEqual([strid.status, strid.body!.id, strid.body!.result!.content![0]!.text], [200, 11, "id came back as a string"], "a program that sends the id back as a string is still answered");
  // A batch reaches the program in its own order: the request sees the note before it and not the one after.
  const batch = await fetch(`${url}/plugins/runner/mcp`, { method: "POST", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify([
    { jsonrpc: "2.0", method: "notifications/note", params: { n: 1 } },
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "notes", arguments: {} } },
    { jsonrpc: "2.0", method: "notifications/note", params: { n: 2 } },
  ]) });
  assert.equal(((await batch.json()) as { result: { content: { text: string }[] } }[])[0]!.result.content[0]!.text, "1", "notifications and requests keep their order in a batch");

  const get = await fetch(`${url}/plugins/runner/mcp`, { headers: { Authorization: "Bearer k-app" } });
  assert.equal(get.status, 405, "no stream of its own to open");
  assert.equal((await fetch(`${url}/plugins/runner/mcp`, { method: "POST", body: "{}" })).status, 401, "callers need a key, as for a served API");

  // It exits, and is started again.
  await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "exit", arguments: {} } });
  await until(() => (status().runner!.mcp!.error ?? "").includes("exited"), "an exit is shown");
  await until(() => status().runner!.mcp!.error === null, "and the program is started again");
  const again = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "echo", arguments: { text: "back" } } });
  assert.equal(again.body!.result!.content![0]!.text, "back from-env");
} finally {
  await node.close();
  await node.plugins.stop();
  backend.close();
  served.close();
}
console.log("pluginmcp: ok");
