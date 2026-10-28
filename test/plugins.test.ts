/**
 * Plugins: what they may see and change, and the guarantees hearth keeps whatever they do.
 *
 *   - config: code runs only with `trust: code`, and a router can neither name an unknown plugin nor turn off a locked one
 *   - a plugin is called only for the kinds it declares; config cannot widen that
 *   - `request` and `routed` change what reaches the backend; `log` gets the reply
 *   - a refusal never reaches the backend; a plugin that fails or hangs follows its onError
 *   - a plugin's own call back into the node runs no plugins, and does not deadlock a one-slot backend
 *   - a router can turn a plugin off; `--no-plugins` starts with none; a required plugin that fails stops startup
 *   - a service is sent only what it reads
 *   - the console can pause a plugin until a restart, never a locked one, and reads a service's manifest before it is added
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import { createLogger, silentLogger } from "../src/log.js";
import { matches, replyText } from "../src/plugins.js";
import { createNode, type HearthNode } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "hearth-plugins-"));

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const parses = (extra: Record<string, unknown>) => parseConfig({ ...base, ...extra });
assert.throws(() => parses({ plugins: { p: { use: "file:./p.js", trust: "http" } } }), ConfigError, "a file runs inside hearth: trust must say code");
assert.throws(() => parses({ plugins: { p: { use: "file:./p.js" } } }), ConfigError, "and leaving trust out is not consent");
assert.throws(() => parses({ plugins: { p: { use: "http://x:1/h", trust: "code" } } }), ConfigError, "a URL is a service");
assert.throws(() => parses({ plugins: { p: { use: "npm:some-plugin@^1.0.0", trust: "code" } } }), ConfigError, "a package is pinned to one exact version");
assert.throws(() => parses({ plugins: { p: { use: "http://x:1/h", trust: "http", kinds: { pictures: ["request"] } } } }), ConfigError, "an unknown kind");
assert.throws(() => parses({ plugins: { p: { use: "http://x:1/h", trust: "http", kinds: { chat: ["before"] } } } }), ConfigError, "an unknown stage");
assert.throws(() => parses({ plugins: { p: { use: "http://x:1/h", trust: "http", peers: true } } }), ConfigError, "plugins on peers' requests are not built");
assert.throws(() => parses({ plugins: { p: { use: "file:./p.js", trust: "code", key: "x" } } }), ConfigError, "a key is for a service");
assert.throws(() => parses({ plugins: { p: { use: "http://x:1/h", trust: "http", key: "env:NO_SUCH_VAR_SET" } } }), ConfigError, "a key names a variable that is set");
const flows = { flows: { r: { inputs: ["*"], steps: [{ to: { asked: true } }] } } };
assert.throws(() => parses({ plugins: { p: { use: "http://x:1/h", trust: "http", locked: true } }, routers: { a: { ...flows, plugins: { p: "off" } } } }), ConfigError, "a locked plugin cannot be turned off");
assert.throws(() => parses({ routers: { a: { ...flows, plugins: { nope: "off" } } } }), ConfigError, "a router names only plugins that exist");
assert.equal(parses({ plugins: { p: { use: "npm:@acme/x@1.2.3", trust: "code" } } }).plugins.p!.onError, "skip", "fails open unless told otherwise");

// --- pure parts -------------------------------------------------------------
assert.equal(replyText('{"choices":[{"message":{"content":"hi there"}}]}'), "hi there");
assert.equal(replyText('data: {"choices":[{"delta":{"content":"hi "}}]}\n\ndata: {"choices":[{"delta":{"content":"there"}}]}\n\ndata: [DONE]\n\n'), "hi there");
const req = { id: "r", kind: "chat" as const, asked: "m", caller: "local", router: "default", lane: "chat", headers: { "x-a": "1" }, body: {} };
assert.equal(matches({ target: ["peer"] }, req), false, "a target condition waits for routing");
assert.equal(matches({ header: { "x-a": [] } }, req), true);
assert.equal(matches({ callerNot: ["local"] }, req), false);

// --- a node with plugins ------------------------------------------------------
let backendCalls = 0;
const seen: { messages: { role: string; content: string }[] }[] = [];
const backend = createServer(async (rq, rs) => {
  let raw = "";
  for await (const c of rq) raw += c;
  const say = (body: unknown) => rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (rq.url === "/v1/models") return say({ data: [{ id: "m" }] });
  if (rq.url === "/running") return say({ running: [] });
  if (rq.url === "/v1/chat/completions") {
    backendCalls++;
    seen.push(JSON.parse(raw));
    await new Promise((r) => setTimeout(r, 20));
    return say({ choices: [{ message: { role: "assistant", content: "the answer" } }] });
  }
  rs.writeHead(404).end();
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

// A service plugin: says what it handles, and records what it was sent.
const serviceGot: Record<string, unknown>[] = [];
const service = createServer(async (rq, rs) => {
  let raw = "";
  for await (const c of rq) raw += c;
  if (rq.headers.authorization !== "Bearer svc-secret") return rs.writeHead(401).end();
  if (rq.url === "/manifest") return rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ apiVersion: 1, kinds: { chat: ["request"] } }));
  serviceGot.push(JSON.parse(raw));
  rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ decision: { headers: { "x-seen-by": "service" } } }));
});
await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
const serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

const g = globalThis as unknown as { pluginLog: Record<string, unknown[]> };
g.pluginLog = {};
const note = (k: string, v: unknown) => { (g.pluginLog[k] ??= []).push(v); };
(globalThis as unknown as { note: typeof note }).note = note;

const plugin = (name: string, src: string) => {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, src);
  return path;
};
plugin("memory", `export default { apiVersion: 1, kinds: { chat: ["request", "routed", "log"] }, setup: (ctx) => ({
  request: (r) => ({ body: { ...r.body, messages: [{ role: "system", content: "remembered: " + ctx.config.fact }, ...r.body.messages] } }),
  routed: (r) => { globalThis.note("routed", r.target + ":" + r.model); },
  log: (x) => { globalThis.note("log", x.reply); },
}) };`);
plugin("where", `export default { apiVersion: 1, kinds: { chat: ["routed"] }, setup: () => ({
  routed: (r) => { globalThis.note("where", r.model + ":" + r.backend + ":" + r.leaves); },
}) };`);
plugin("keeper", `export default { apiVersion: 1, kinds: { chat: ["request"] }, setup: () => ({
  request: (r) => (r.headers["x-keep"] === "1" ? { stayLocal: true } : undefined),
}) };`);
plugin("imageonly", `export default { apiVersion: 1, kinds: { image: ["request"] }, setup: () => ({ request: () => { globalThis.note("imageonly", 1); } }) };`);
plugin("wrongkind", `export default { apiVersion: 1, kinds: { chat: ["request"] }, setup: () => ({ request: () => {} }) };`);
plugin("guard", `export default { apiVersion: 1, kinds: { chat: ["request"] }, setup: () => ({
  request: (r) => r.body.messages.some((m) => String(m.content).includes("forbidden")) ? { refuse: { status: 403, message: "not allowed" } } : undefined,
}) };`);
plugin("flaky", `export default { apiVersion: 1, kinds: { chat: ["request"] }, setup: () => ({
  request: (r) => { if (r.headers["x-break"] === "throw") throw new Error("boom"); if (r.headers["x-break"] === "hang") return new Promise(() => {}); },
}) };`);
plugin("strict", `export default { apiVersion: 1, kinds: { chat: ["request"] }, setup: () => ({
  request: (r) => { if (r.headers["x-break"] === "strict") throw new Error("down"); },
}) };`);
// Calls the same one-slot model back through the node from inside its own hook.
plugin("caller", `export default { apiVersion: 1, kinds: { chat: ["request"] }, setup: (ctx) => ({
  request: async (r) => {
    if (r.headers["x-call-back"] !== "1") return;
    globalThis.note("caller", 1);
    const res = await fetch(ctx.internal.url + "/v1/chat/completions", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + ctx.internal.token, "x-call-back": "1" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "inner" }] }) });
    globalThis.note("inner", res.status);
  },
}) };`);

process.env.TEST_PLUGIN_KEY = "svc-secret";
const integrity = (name: string) => "sha256-" + createHash("sha256").update(readFileSync(join(dir, `${name}.mjs`))).digest("hex");
const cfgPath = join(dir, "hearth.yaml");
const writeCfg = (port: number, extra = "") => writeFileSync(cfgPath, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${port}}
backends:
  main: {url: ${backendUrl}, kind: llama-swap, serves: [m], concurrency: 1}
  provider: {url: ${backendUrl}, cloud: true, serves: [c]}
models:
  m: {backend: main}
  c: {backend: provider}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
routers:
  quiet:
    flows: {rest: {inputs: ["*"], steps: [{to: {asked: true}}]}}
    plugins: {memory: off}
apiKeys:
  - {key: k-app, label: app}
  - {key: k-quiet, label: quiet}
callers: {quiet: quiet}
plugins:
  where: {use: "file:./where.mjs", trust: code, everyLine: true}
  keeper: {use: "file:./keeper.mjs", trust: code, everyLine: true}
  memory: {use: "file:./memory.mjs", trust: code, integrity: "${integrity("memory")}", config: {fact: "likes tea"}, everyLine: true}
  imageonly: {use: "file:./imageonly.mjs", trust: code, everyLine: true}
  wrongkind: {use: "file:./wrongkind.mjs", trust: code, kinds: {image: [request]}, everyLine: true}
  guard: {use: "file:./guard.mjs", trust: code, locked: true, everyLine: true}
  flaky: {use: "file:./flaky.mjs", trust: code, timeoutMs: 100, everyLine: true}
  strict: {use: "file:./strict.mjs", trust: code, onError: refuse, everyLine: true}
  caller: {use: "file:./caller.mjs", trust: code, timeoutMs: 5000, everyLine: true}
  service: {use: "${serviceUrl}", trust: http, reads: [headers], key: "env:TEST_PLUGIN_KEY", everyLine: true}
${extra}`);

/** A port nothing has used, so a pooled connection to an earlier node is never reused against a new one. */
const freePort = () => new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
let free = await freePort();
writeCfg(free);

async function up(opts: { plugins?: boolean } = {}): Promise<{ node: HearthNode; url: string }> {
  free = await freePort();
  writeCfg(free);
  const node = createNode(loadConfig(cfgPath), process.env.DEBUG_PLUGINS ? createLogger("debug") : silentLogger, opts);
  node.start();
  await node.startPlugins();
  await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));
  return { node, url: `http://127.0.0.1:${free}` };
}
const chat = (url: string, content: string, headers: Record<string, string> = {}, key = "k-app", model = "m") =>
  fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify({ model, messages: [{ role: "user", content }] }) });
const settle = () => new Promise((r) => setTimeout(r, 60));

{
  const { node, url } = await up();
  try {
    const status = Object.fromEntries(node.plugins.status().map((p) => [p.name, p]));
    assert.equal(status.wrongkind!.state, "failed", "config naming a kind the plugin does not declare stops that plugin");
    assert.match(status.wrongkind!.error ?? "", /handles chat; image is not one of its kinds/);
    assert.equal(status.memory!.state, "running");

    // request changes what the backend gets; routed sees where it went; log gets the reply.
    const r1 = await chat(url, "hello");
    assert.equal(r1.status, 200);
    await r1.text();
    await settle();
    assert.deepEqual(seen.at(-1)!.messages[0], { role: "system", content: "remembered: likes tea" });
    assert.deepEqual(g.pluginLog.routed, ["local:m"]);
    assert.deepEqual(g.pluginLog.log, ["the answer"]);
    assert.equal(g.pluginLog.imageonly, undefined, "a plugin for images is never called on chat");

    // A service is sent only what it reads: headers, not the messages.
    const sent = serviceGot.at(-1)! as { kind: string; request: Record<string, unknown> };
    assert.equal(sent.kind, "chat");
    assert.ok(sent.request.headers && sent.request.body === undefined, "a plugin that reads headers is never sent the messages");

    // A plugin is told when a request leaves this machine: a cloud provider is as far away as a peer.
    const toCloud = await chat(url, "hi", {}, "k-app", "c");
    assert.equal(toCloud.status, 200);
    await toCloud.text();
    assert.deepEqual(g.pluginLog.where!.slice(-2), ["m:main:false", "c:provider:true"]);

    // Kept here means no cloud provider either: with nothing on this machine to run it, it is refused.
    const calls = backendCalls;
    const kept = await chat(url, "hi", { "x-keep": "1" }, "k-app", "c");
    assert.equal(kept.status, 503);
    assert.match(await kept.text(), /kept here/);
    assert.equal(backendCalls, calls, "and the provider never sees it");
    const keptLocal = await chat(url, "hi", { "x-keep": "1" });
    assert.equal(keptLocal.status, 200, "a model on this machine still runs");
    await keptLocal.text();

    // A refusal never reaches the backend.
    const before = backendCalls;
    const no = await chat(url, "this is forbidden");
    assert.equal(no.status, 403);
    assert.match(await no.text(), /not allowed/);
    assert.equal(backendCalls, before);

    // A plugin that throws, or never answers, is skipped: the request goes on.
    const thrown = await chat(url, "x", { "x-break": "throw" });
    assert.equal(thrown.status, 200);
    await thrown.text();
    const t0 = Date.now();
    const hung = await chat(url, "x", { "x-break": "hang" });
    assert.equal(hung.status, 200);
    await hung.text();
    assert.ok(Date.now() - t0 < 2000, "a hung plugin costs its timeout, not the request");
    assert.equal(Object.fromEntries(node.plugins.status().map((p) => [p.name, p])).flaky!.failOpens, 2, "and each skip is counted");

    // One that refuses on error fails closed.
    const closed = await chat(url, "x", { "x-break": "strict" });
    assert.equal(closed.status, 503);
    await closed.text();

    // A hook that calls the same one-slot model back in: no plugin runs on the inner call, and nothing waits forever.
    const back = await chat(url, "outer", { "x-call-back": "1" });
    assert.equal(back.status, 200);
    await back.text();
    assert.deepEqual(g.pluginLog.caller, [1], "the inner call ran no plugins, so the hook ran once");
    assert.deepEqual(g.pluginLog.inner, [200]);

    // A router can turn a plugin off for its callers.
    const n = g.pluginLog.routed!.length;
    const quiet = await chat(url, "hi", {}, "k-quiet");
    assert.equal(quiet.status, 200);
    await quiet.text();
    assert.equal(g.pluginLog.routed!.length, n, "memory is off for the quiet router");
    assert.equal(seen.at(-1)!.messages[0]!.role, "user");

    const listed = await fetch(`${url}/plugins`, { headers: { Authorization: "Bearer k-app" } });
    assert.equal(listed.status, 200);
    assert.ok(((await listed.json()) as { plugins: unknown[] }).plugins.length >= 10);

    // The console pauses a plugin until a restart; a locked one runs on regardless.
    const pause = (name: string, paused: boolean) => fetch(`${url}/plugins`, { method: "POST", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json" }, body: JSON.stringify({ name, paused }) });
    assert.equal((await pause("guard", true)).status, 409, "a locked plugin is never paused");
    assert.equal((await pause("memory", true)).status, 200);
    const paused = await chat(url, "hi");
    await paused.text();
    assert.equal(seen.at(-1)!.messages[0]!.role, "user", "a paused plugin does not run");
    const shown = node.plugins.status().find((p) => p.name === "memory")!;
    assert.equal(shown.paused, true);
    assert.equal(shown.use, "file:./memory.mjs");
    assert.equal(node.plugins.status().find((p) => p.name === "service")!.use, serviceUrl, "a service shows its address and nothing it was given");
    assert.equal((await pause("memory", false)).status, 200);
    const back2 = await chat(url, "hi");
    await back2.text();
    assert.deepEqual(seen.at(-1)!.messages[0], { role: "system", content: "remembered: likes tea" }, "and runs again once resumed");

    // The page's view: who goes by each router, and nothing waiting on a restart.
    const ui = (await (await fetch(`${url}/ui/data`)).json()) as { plugins: { pending: unknown[]; routers: Record<string, { callers: string[]; plugins: Record<string, string> }> } };
    assert.deepEqual(ui.plugins.pending, []);
    assert.deepEqual(ui.plugins.routers.quiet, { plugins: { memory: "off" }, changes: {}, callers: ["quiet"] });
    assert.ok(ui.plugins.routers.default!.callers.includes("*") && ui.plugins.routers.default!.callers.includes("local"));
    // A plugin written to the file waits for a restart, and the page says so.
    const added = await fetch(`${url}/config`, { method: "PATCH", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json" }, body: JSON.stringify({ ops: [{ path: ["plugins", "later"], value: { use: serviceUrl, trust: "http", key: "env:TEST_PLUGIN_KEY" } }] }) });
    assert.equal(added.status, 200, await added.text());
    const after = (await (await fetch(`${url}/ui/data`)).json()) as { plugins: { pending: unknown[] } };
    assert.deepEqual(after.plugins.pending, [{ name: "later", change: "added" }]);

    // The console checks a service before adding it: what it declares, or why it cannot be read.
    const probe = (body: unknown) => fetch(`${url}/plugins/probe`, { method: "POST", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ ok: boolean; kinds?: unknown; problem?: string }>);
    assert.deepEqual(await probe({ url: serviceUrl, key: "env:TEST_PLUGIN_KEY" }), { ok: true, url: serviceUrl, kinds: { chat: ["request"] }, needs: {} });
    const keyless = await probe({ url: serviceUrl });
    assert.equal(keyless.ok, false);
    assert.match(keyless.problem ?? "", /wants a key/);
  } finally {
    await node.close();
  }
}

// --no-plugins: none load, and requests pass untouched.
{
  const { node, url } = await up({ plugins: false });
  try {
    const r = await chat(url, "plain");
    await r.text();
    assert.equal(seen.at(-1)!.messages[0]!.role, "user");
    assert.ok(node.plugins.status().every((p) => p.state === "off"));
  } finally {
    await node.close();
  }
}

// A file that is not the one its integrity names is not loaded; a required plugin that fails stops startup.
writeFileSync(join(dir, "memory.mjs"), readFileSync(join(dir, "memory.mjs"), "utf8") + "\n// changed\n");
{
  const node = createNode(loadConfig(cfgPath), silentLogger);
  await node.startPlugins();
  const m = node.plugins.status().find((p) => p.name === "memory")!;
  assert.equal(m.state, "failed");
  assert.match(m.error ?? "", /is not the file its integrity names/);
  await node.close();
}
writeCfg(free, "  broken: {use: \"file:./missing.mjs\", trust: code, required: true}\n");
{
  const node = createNode(loadConfig(cfgPath), silentLogger);
  await assert.rejects(node.startPlugins(), /broken is required/);
  await node.close();
}

backend.close();
service.close();
console.log("plugins ok");
