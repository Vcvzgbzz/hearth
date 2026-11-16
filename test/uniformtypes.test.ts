/**
 * Uniform types: every type a rule can take goes through the same code path, whether it is a model,
 * a router's own name, or a type a plugin serves. Nothing in the engine decides by a literal list of
 * type names: the set of types comes from the config, the plugins declared and the names a section's
 * flows are entered by.
 *
 *   - two plugins, a type each, and two rules of the same shape, one per type: each rule decides its own
 *   - the same rule shape for a model type:variant decides the model, through the same resolve()
 *   - a router's own type reaches a plugin through a rule that names what it takes
 *   - config: `takes` accepts a type this node offers, whichever it is, and refuses a name that is none
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { resolve, type World } from "../src/routing/route.js";
import { createNode } from "../src/server.js";

// --- config: takes names a type this node offers, and no literal list decides which -------------------
const base = {
  version: 3, name: "t",
  backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } },
  models: { m: { backend: "main" } },
  plugins: {
    plain: { serves: "http://127.0.0.1:1/x", trust: "http" },
    speaking: { serves: "http://127.0.0.1:1/y", trust: "http", mcp: true },
  },
};
const rest = { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } };
const takesWith = (takes: unknown[]) => ({
  ...base,
  flows: { door: { inputs: ["Door"], takes, steps: [{ to: { refuse: "no" } }] }, ...rest },
});
// A type a plugin serves, from either kind of plugin.
assert.doesNotThrow(() => parseConfig(takesWith(["MCP"])), "a takes entry naming a type a plugin serves is accepted");
assert.doesNotThrow(() => parseConfig(takesWith(["API"])));
// A router's own type: a name its own flows are entered by.
assert.doesNotThrow(() => parseConfig({
  ...base,
  flows: { door: { inputs: ["Door"], takes: ["Widget"], steps: [{ to: { refuse: "no" } }] }, widget: { inputs: ["Widget"], steps: [{ to: { refuse: "no" } }] }, ...rest },
}), "a takes entry naming a type this section offers is accepted");
// A name that is no type and no path is refused, and the words name no kind of request.
let refusal = "";
try { parseConfig(takesWith(["SMTP"])); } catch (e) { refusal = (e as Error).message; }
assert.match(refusal, /neither a path a backend declares/, "an unknown takes entry is refused");
assert.ok(!/plugin request/i.test(refusal), `the refusal names no kind of request: ${refusal}`);

// --- one rule shape for every type, through the same resolve() ---------------------------------------
const cfg = parseConfig({
  ...base,
  flows: {
    chat: { inputs: ["m"], steps: [{ to: { asked: true } }] },
    rest: { inputs: ["*"], steps: [{ to: { asked: true } }] },
  },
  routers: {
    kinds: {
      flows: {
        byMcp: { inputs: ["MCP"], steps: [{ when: { variant: ["speaking"] }, to: { asked: true } }, { to: { refuse: "only speaking over MCP" } }] },
        byApi: { inputs: ["API"], steps: [{ when: { variant: ["plain"] }, to: { asked: true } }, { to: { refuse: "only plain over API" } }] },
        rest: { inputs: ["*"], steps: [{ to: { refuse: "no plugins for this caller" } }] },
      },
    },
    mcpOnly: {
      flows: {
        byMcp: { inputs: ["MCP"], steps: [{ when: { variant: ["speaking"] }, to: { asked: true } }, { to: { refuse: "only speaking over MCP" } }] },
        rest: { inputs: ["*"], steps: [{ to: { refuse: "no plugins for this caller" } }] },
      },
    },
    mixed: {
      flows: {
        llm: { inputs: ["LLM"], steps: [{ when: { variant: ["fast"] }, to: { model: "m" } }, { when: { variant: ["slow"] }, to: { refuse: "no such variant" } }] },
        widget: { inputs: ["Widget"], steps: [{ when: { variant: ["gadget"] }, to: { plugin: "speaking" } }, { to: { refuse: "no such widget" } }] },
        rest: { inputs: ["*"], steps: [{ to: { asked: true } }] },
      },
    },
  },
  callers: { a: "kinds", b: "mcpOnly", c: "mixed" },
});

const rules = (caller: string) => ({ ...cfg, flows: cfg.routers[cfg.callers[caller]!]!.flows });
const world = (caller: string, more: Partial<World> = {}): World => ({
  cfg: rules(caller), peers: { candidates: () => [], statsFor: () => null, theirModelId: () => undefined, loadFor: () => undefined } as unknown as World["peers"],
  caller, lane: "chat", local: () => ({ queued: 0, free: 1, slots: 1, loaded: [] }), held: () => false, ...more,
});

// A type a plugin serves, each rule deciding by the variant it names: the same shape, one per type.
assert.equal(resolve("MCP:speaking", world("a", { plugin: "speaking", kind: "MCP" })).plugin, "speaking");
assert.equal(resolve("API:plain", world("a", { plugin: "plain", kind: "API" })).plugin, "plain");
// A router with a rule for one type only has no rule for the other: that request meets the flow for every other name.
assert.equal(resolve("API:plain", world("b", { plugin: "plain", kind: "API" })).reason, "no plugins for this caller");

// The same rule shape for a model type:variant: one code path, the type's own rules deciding.
assert.equal(resolve("LLM:fast", world("c")).model, "m");
assert.equal(resolve("LLM:slow", world("c")).reason, "no such variant");

// A router's own type reaches a plugin by the same steps as any other type.
assert.equal(resolve("Widget:gadget", world("c", { plugin: "Widget:gadget" })).plugin, "speaking");
assert.equal(resolve("Widget:gadget", world("c", { plugin: "Widget:gadget" })).reason, "widget step 1");
console.log("uniformtypes: config and routing ok");

// --- the same rules over HTTP ---------------------------------------------------------------------
const backend = createServer((rq, rs) => {
  const say = (body: unknown) => rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (rq.url === "/v1/models") return say({ data: [{ id: "m" }] });
  if (rq.url === "/running") return say({ running: [] });
  if (rq.url === "/v1/chat/completions") return say({ choices: [{ message: { role: "assistant", content: "from the model" } }] });
  rs.writeHead(404).end();
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
const service = createServer((rq, rs) => {
  rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ at: rq.url }));
});
await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
const serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
const free = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const dir = mkdtempSync(join(tmpdir(), "hearth-uniform-types-"));
const cfgPath = join(dir, "hearth.yaml");
writeFileSync(cfgPath, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free}}
backends:
  main: {url: ${backendUrl}, serves: [m]}
models:
  m: {backend: main}
flows:
  chat: {inputs: [m], steps: [{to: {asked: true}}]}
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
routers:
  kinds:
    flows:
      byMcp: {inputs: [MCP], steps: [{when: {variant: [speaking]}, to: {asked: true}}, {to: {refuse: "only speaking over MCP"}}]}
      byApi: {inputs: [API], steps: [{when: {variant: [plain]}, to: {asked: true}}, {to: {refuse: "only plain over API"}}]}
      rest: {inputs: ["*"], steps: [{to: {refuse: "no plugins for this caller"}}]}
  mcpOnly:
    flows:
      byMcp: {inputs: [MCP], steps: [{when: {variant: [speaking]}, to: {asked: true}}, {to: {refuse: "only speaking over MCP"}}]}
      rest: {inputs: ["*"], steps: [{to: {refuse: "no plugins for this caller"}}]}
apiKeys:
  - {key: k-kinds, label: kinds}
  - {key: k-mcpOnly, label: mcpOnly}
callers: {kinds: kinds, mcpOnly: mcpOnly}
plugins:
  plain: {serves: "${serviceUrl}/plain", trust: http}
  mcp-other: {serves: "${serviceUrl}/other", trust: http, mcp: true}
  speaking: {serves: "${serviceUrl}/speaking", trust: http, mcp: true}
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
  // Each type's rule decides its own plugin, by the same variant test.
  assert.deepEqual(await call("/plugins/speaking/x", "k-kinds"), { status: 200, body: { at: "/speaking/x" } }, "the rule that takes MCP takes its plugin");
  assert.deepEqual(await call("/plugins/plain/x", "k-kinds"), { status: 200, body: { at: "/plain/x" } }, "the rule that takes API takes its plugin");
  // A router with the MCP rule alone takes an MCP request and decides it by the variant, and passes an API
  // request over to its flow for every other name: the kind is the request's type, as any other type is.
  assert.deepEqual(await call("/plugins/mcp-other/x", "k-mcpOnly"), { status: 403, body: { error: "only speaking over MCP" } }, "the MCP rule takes another MCP plugin's request, and refuses it in its own words");
  assert.deepEqual(await call("/plugins/speaking/x", "k-mcpOnly"), { status: 200, body: { at: "/speaking/x" } });
  assert.deepEqual(await call("/plugins/plain/x", "k-mcpOnly"), { status: 403, body: { error: "no plugins for this caller" } }, "an API request meets the flow for every other name");
} finally {
  await node.close();
  backend.close();
  service.close();
}
console.log("uniformtypes: ok");
