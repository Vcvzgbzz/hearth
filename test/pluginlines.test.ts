/**
 * Plugins placed on routing lines, and the models wired into their slots.
 *
 *   - config: a step names only plugins that exist, never an everyLine one, and never on a step that does not send to a model
 *   - a plugin on a line runs for that line's requests and no other; a router without it never runs it
 *   - each hook is told the models wired into its slots (the line's over the plugin's) and the line it is on
 *   - a plugin whose required slot is empty on a line does not run there; the request carries on
 *   - on a line, a plugin with only a `request` hook runs it as its turn before the model
 *   - a slot wired to a model of the wrong kind, or a plugin placed on a line of a kind it does not handle, stops that plugin
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

const dir = mkdtempSync(join(tmpdir(), "hearth-pluginlines-"));

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const plugin = { p: { use: "http://x:1/h", trust: "http" } };
const line = (step: Record<string, unknown>) => ({ flows: { r: { inputs: ["*"], steps: [step] } } });
const parses = (extra: Record<string, unknown>) => parseConfig({ ...base, ...extra });
assert.throws(() => parses(line({ to: { asked: true }, plugins: ["nope"] })), ConfigError, "a step names only plugins under plugins:");
assert.throws(() => parses({ plugins: { p: { ...plugin.p, everyLine: true } }, ...line({ to: { asked: true }, plugins: ["p"] }) }), ConfigError, "an everyLine plugin is already on every line");
assert.throws(() => parses({ plugins: plugin, ...line({ to: { refuse: "no" }, plugins: ["p"] }) }), ConfigError, "a refusing step sends nothing to a model");
assert.throws(() => parses({ plugins: plugin, ...line({ to: { asked: true }, plugins: ["p", "p"] }) }), ConfigError, "once per line");
assert.throws(() => parses({ plugins: plugin, routers: { a: { ...line({ to: { asked: true } }), plugins: { p: "off" } } } }), ConfigError, "a router turns off only an everyLine plugin");
assert.throws(() => parses({ models: { m: { backend: "main" }, e: { kind: "pictures" } } }), ConfigError, "a model's kind is a request kind");
const ok = parses({ plugins: plugin, models: { m: { backend: "main" }, e: { kind: "embeddings" } }, ...line({ to: { asked: true }, plugins: [{ use: "p", models: { embed: "e" } }] }) });
assert.deepEqual(ok.flows.r!.steps[0]!.plugins, [{ name: "p", models: { embed: "e" } }]);
assert.equal(ok.modelKinds.e, "embeddings");
assert.equal(ok.models.e, undefined, "a kind alone describes a model; it is not a route");

// --- a node with plugins on lines ---------------------------------------------
const seen: { messages: { role: string; content: string }[] }[] = [];
const backend = createServer(async (rq, rs) => {
  let raw = "";
  for await (const c of rq) raw += c;
  const say = (body: unknown) => rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (rq.url === "/v1/models") return say({ data: [{ id: "m" }, { id: "n" }] });
  if (rq.url === "/v1/chat/completions") { seen.push(JSON.parse(raw)); return say({ choices: [{ message: { role: "assistant", content: "ok" } }] }); }
  rs.writeHead(404).end();
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const g = globalThis as unknown as { lines: Record<string, unknown[]> };
g.lines = {};
const code = (name: string, src: string) => writeFileSync(join(dir, `${name}.mjs`), src);
// Adds a system message naming what it was told, so the backend shows where it ran.
code("liner", `export default { apiVersion: 1, kinds: { chat: ["routed", "log"] }, needs: { embed: { kind: "embeddings" }, rerank: { kind: "rerank", optional: true } },
  setup: () => ({
    routed: (r) => { (globalThis.lines.routed ??= []).push({ models: r.models, line: r.line }); return { body: { ...r.body, messages: [{ role: "system", content: "liner:" + r.models.embed }, ...r.body.messages] } }; },
    log: (x) => { (globalThis.lines.log ??= []).push(x.line.flow); },
  }) };`);
code("misfit", `export default { apiVersion: 1, kinds: { chat: ["routed"] }, needs: { embed: { kind: "embeddings" } }, setup: () => ({ routed: () => {} }) };`);
// Hooks only `request`: placed on a line, that is its turn before the model.
code("early", `export default { apiVersion: 1, kinds: { chat: ["request"] }, setup: () => ({ request: (r) => ({ body: { ...r.body, messages: [{ role: "system", content: "early" }, ...r.body.messages] } }) }) };`);
code("pictures", `export default { apiVersion: 1, kinds: { image: ["request"] }, setup: () => ({ request: () => {} }) };`);

const free = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const cfgPath = join(dir, "hearth.yaml");
writeFileSync(cfgPath, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free}}
backends:
  main: {url: ${backendUrl}, serves: [m, n]}
models:
  m: {backend: main}
  n: {backend: main}
  e: {kind: embeddings}
  e2: {kind: embeddings}
  r: {kind: rerank}
flows:
  rest:
    inputs: ["*"]
    steps:
      - {when: {asked: [n]}, to: {model: n}, plugins: [liner]}
      - {to: {asked: true}, plugins: [{use: liner, models: {embed: e2}}]}
routers:
  quiet:
    flows: {rest: {inputs: ["*"], steps: [{to: {asked: true}}]}}
  bare:
    flows: {rest: {inputs: ["*"], steps: [{to: {asked: true}, plugins: [unwired]}]}}
  early:
    flows: {rest: {inputs: ["*"], steps: [{to: {asked: true}, plugins: [early]}]}}
apiKeys:
  - {key: k-app, label: app}
  - {key: k-quiet, label: quiet}
  - {key: k-bare, label: bare}
  - {key: k-early, label: early}
callers: {quiet: quiet, bare: bare, early: early}
plugins:
  liner: {use: "file:./liner.mjs", trust: code, models: {embed: e, rerank: r}}
  unwired: {use: "file:./liner.mjs", trust: code}
  misfit: {use: "file:./misfit.mjs", trust: code, models: {embed: m}}
  pictures: {use: "file:./pictures.mjs", trust: code}
  early: {use: "file:./early.mjs", trust: code}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));
const url = `http://127.0.0.1:${free}`;
const chat = (key: string, model = "m") => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) }).then((r) => r.text());
const settle = () => new Promise((r) => setTimeout(r, 60));

try {
  const status = Object.fromEntries(node.plugins.status().map((p) => [p.name, p]));
  assert.equal(status.liner!.state, "running");
  assert.deepEqual(status.liner!.needs, { embed: { kind: "embeddings" }, rerank: { kind: "rerank", optional: true } });
  assert.equal(status.misfit!.state, "failed", "a slot wired to a model of another kind stops the plugin");
  assert.match(status.misfit!.error ?? "", /embed slot takes embeddings models; m is a chat model/);
  assert.equal(status.pictures!.state, "running", "placed nowhere, it starts and runs nowhere");

  // The plugin's own wiring on one line, the line's own on the other; each hook told which line it is on.
  await chat("k-app", "n");
  await chat("k-app", "m");
  await settle();
  assert.equal(seen.at(-2)!.messages[0]!.content, "liner:e");
  assert.equal(seen.at(-1)!.messages[0]!.content, "liner:e2", "a line's wiring wins over the plugin's");
  assert.deepEqual(g.lines.routed, [
    { models: { embed: "e", rerank: "r" }, line: { router: "default", flow: "rest", step: 0 } },
    { models: { embed: "e2", rerank: "r" }, line: { router: "default", flow: "rest", step: 1 } },
  ]);
  assert.deepEqual(g.lines.log, ["rest", "rest"], "its after-the-reply hook runs too");

  // A router whose lines do not place it never runs it.
  await chat("k-quiet");
  assert.equal(seen.at(-1)!.messages[0]!.role, "user");

  // A required slot with nothing wired: the plugin does not run there, and the request still goes through.
  const before = g.lines.routed!.length;
  const r = await chat("k-bare");
  assert.match(r, /"ok"/);
  assert.equal(g.lines.routed!.length, before);
  assert.equal(seen.at(-1)!.messages[0]!.role, "user");

  // A plugin with only a request hook, placed on a line, runs it there.
  await chat("k-early");
  assert.equal(seen.at(-1)!.messages[0]!.content, "early");
} finally {
  await node.close();
  backend.close();
}

// A plugin placed on a line of a kind it does not handle stops at startup.
{
  writeFileSync(cfgPath, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free}}
backends:
  main: {url: ${backendUrl}, serves: [m]}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}, plugins: [pictures]}]}
plugins:
  pictures: {use: "file:./pictures.mjs", trust: code}
`);
  const n2 = createNode(loadConfig(cfgPath), silentLogger);
  await n2.startPlugins();
  const p = n2.plugins.status()[0]!;
  assert.equal(p.state, "failed");
  assert.match(p.error ?? "", /placed on rest line 1, which carries chat requests; it handles image/);
  await n2.close();
}

console.log("pluginlines ok");
