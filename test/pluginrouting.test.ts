/**
 * Plugins on the router: a request to /plugins/<name>/* is asked of the caller's router as MCP:<name> or
 * API:<name>, and the steps decide, as they do for a model.
 *
 *   - config: `to: { plugin }` is a step's target; it is not one `fastest` can choose between
 *   - "as asked" lets a plugin request through to its plugin; `refuse` turns it away with the step's words
 *   - a step that names a plugin sends the request there; a step that names a model is passed over
 *   - on a model request, a step that names a plugin is passed over
 *   - a name a router gives a plugin, that is no plugin's own, reaches the plugin its step names
 *   - with no rule for MCP or API, a router's flow for every other name decides: running as itself lets plugins
 *     through, refusing refuses them
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
const flows = (steps: unknown[]) => ({ flows: { rest: { inputs: ["*"], steps } } });
assert.deepEqual(parseConfig({ ...base, ...flows([{ to: { plugin: "tools" } }, { to: { asked: true } }]) }).flows.rest!.steps[0]!.to, { plugin: "tools" });
assert.throws(() => parseConfig({ ...base, ...flows([{ to: { plugin: "tools" } }]) }), ConfigError, "a model request passes a plugin step over, so it cannot be the last");
assert.throws(() => parseConfig({ ...base, ...flows([{ to: { fastest: [{ plugin: "a" }, "m"] } }]) }), ConfigError, "fastest chooses between models and peers");
assert.throws(() => parseConfig({ ...base, ...flows([{ to: { plugin: "tools", model: "m" } }, { to: { asked: true } }]) }), /a plugin/, "a step says a plugin or a model, not both");
assert.throws(() => parseConfig({ ...base, ...flows([{ to: { plugin: "tools", refuse: "no" } }, { to: { asked: true } }]) }), /a plugin/);

// --- a node with plugins and routers -------------------------------------------
const backend = createServer((rq, rs) => {
  const say = (body: unknown) => rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (rq.url === "/v1/models") return say({ data: [{ id: "m" }] });
  if (rq.url === "/running") return say({ running: [] });
  if (rq.url === "/v1/chat/completions") return say({ choices: [{ message: { role: "assistant", content: "from the model" } }] });
  rs.writeHead(404).end();
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const got: string[] = [];
const service = createServer((rq, rs) => {
  got.push(rq.url!);
  rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ at: rq.url }));
});
await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
const serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

const free = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const dir = mkdtempSync(join(tmpdir(), "hearth-plugin-routing-"));
const cfgPath = join(dir, "hearth.yaml");
writeFileSync(cfgPath, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free}}
backends:
  main: {url: ${backendUrl}, serves: [m]}
models:
  m: {backend: main}
flows:
  chat:
    inputs: [m]
    steps:
      - {to: {plugin: crawl}}
      - {to: {model: m}}
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
routers:
  closed:
    flows:
      rest: {inputs: ["*"], steps: [{to: {refuse: "not for this caller"}}]}
  shut:
    flows:
      none: {inputs: [MCP, API], steps: [{to: {refuse: "no plugins for this caller"}}]}
      rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
  picky:
    flows:
      tools-only:
        inputs: [MCP, API]
        steps:
          - {when: {variant: [tools]}, to: {asked: true}}
          - {when: {variant: [old-search]}, to: {plugin: crawl}}
          - {when: {variant: [web-get]}, to: {plugin: crawl}}
          - {when: {variant: [crawl]}, to: {model: m}}
          - {to: {refuse: "only the tools are open to you"}}
      rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: k-app, label: app}
  - {key: k-closed, label: closed}
  - {key: k-picky, label: picky}
  - {key: k-shut, label: shut}
callers: {closed: closed, picky: picky, shut: shut}
plugins:
  crawl: {serves: "${serviceUrl}/crawl", trust: http}
  old-search: {serves: "${serviceUrl}/old", trust: http}
  tools: {serves: "${serviceUrl}/tools", trust: http, mcp: true}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));
const url = `http://127.0.0.1:${free}`;
const call = async (path: string, key: string) => {
  const r = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, body: await r.json() as { at?: string; error?: string } };
};

try {
  // The default rules run a plugin request as asked: today's behaviour, for every caller on them.
  assert.deepEqual(await call("/plugins/crawl/x", "k-app"), { status: 200, body: { at: "/crawl/x" } });

  // A router with no rule for MCP or API decides plugins as it does every other name: this one refuses them.
  assert.deepEqual(await call("/plugins/crawl/x", "k-closed"), { status: 403, body: { error: "not for this caller" } });
  // One with such a rule decides them, in its own words.
  assert.deepEqual(await call("/plugins/crawl/x", "k-shut"), { status: 403, body: { error: "no plugins for this caller" } });
  assert.equal((await call("/plugins/tools/mcp", "k-shut")).status, 403);

  // Variants pick the plugin: MCP:tools runs as asked, API:old-search is sent to crawl, API:crawl to a model is passed over.
  assert.deepEqual(await call("/plugins/tools/mcp", "k-picky"), { status: 200, body: { at: "/tools/mcp" } });
  assert.deepEqual(await call("/plugins/old-search/q", "k-picky"), { status: 200, body: { at: "/crawl/q" } }, "a step that names a plugin sends it there");
  const passed = await call("/plugins/crawl/x", "k-picky");
  assert.equal(passed.status, 403);
  assert.match(passed.body.error!, /step 4 sends to a model.*only the tools are open to you/, "a step that names a model is passed over, and the refusal says so");

  // A name the router gives a plugin, that no plugin has, is asked of it as API:<name> or MCP:<name>.
  assert.deepEqual(await call("/plugins/web-get/page", "k-picky"), { status: 200, body: { at: "/crawl/page" } }, "a router's own name for a plugin reaches it");
  assert.deepEqual(await call("/plugins/web-put/page", "k-picky"), { status: 403, body: { error: "only the tools are open to you" } }, "a name no step gives is refused in the router's words");
  assert.equal((await call("/plugins/web-put/page", "k-app")).status, 404, "on rules that run names as asked, a name no plugin has is not found");

  // On a model request, the step that names a plugin is passed over and the model runs.
  const chat = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { Authorization: "Bearer k-app", "Content-Type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(chat.status, 200);
  assert.match(JSON.stringify(await chat.json()), /from the model/);
  assert.ok(!got.some((u) => u.startsWith("/crawl/") && u !== "/crawl/x" && u !== "/crawl/q" && u !== "/crawl/page"), "the plugin never got the model request");
} finally {
  await node.close();
  backend.close();
  service.close();
}
console.log("pluginrouting: ok");
