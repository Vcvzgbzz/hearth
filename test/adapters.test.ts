/**
 * Adapters: a `trust: code` plugin a flow line names with `adapt:`, which reshapes what that
 * line's plugin is sent, and the answer that plugin gives back.
 *
 *   - config: an unknown adapter, a plugin that does not run code, `adapt:` beside a model, and
 *     `fallback.adapt` still refused with a pointer to `adapt:`
 *   - `null` from request() means "no counterpart": the line fails and the next one is tried
 *   - a line that answers is not adapted, and its adapter does not run
 *   - a non-2xx answer is never adapted; a response() that throws is a 502 naming the adapter
 *   - a hung async adapter is held to its plugin's timeoutMs, on either side
 *   - no credentials reach the adapter, and the target still gets its own headers
 *   - an adapter plugin whose setup returns no adapt fails to start, and a plugin a line names as
 *     its adapter is not warned about as one that runs nowhere
 *   - a failed line goes on to the next one, and `strict: true` turns that off
 *   - the searxng-to-degoog example, against two stub servers
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "../src/config/config.js";
import { ConfigError } from "../src/config/read.js";
import { silentLogger, type Logger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

/** A config refusal whose sentence says this. */
const refuses = (fn: () => unknown, re: RegExp, why?: string) => assert.throws(fn, (e: unknown) => e instanceof ConfigError && re.test(e.message), why);

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const svc = (more: object = {}) => ({ serves: "http://127.0.0.1:2", trust: "http", ...more });
const code = (more: object = {}) => ({ use: "file:./adapt.mjs", trust: "code", ...more });
/** A config with one flow whose first step is `to`, and a last step that always answers. */
const line = (to: unknown, plugins: unknown = { alt: svc(), gate: code() }) =>
  parseConfig({ ...base, plugins, flows: { f: { inputs: ["*"], steps: [{ when: { variant: ["p"] }, to }, { to: { refuse: "no" } }] } } });
// An adapter must be a plugin, and one that runs code from a file or a package.
refuses(() => line({ plugin: "alt", adapt: "nope" }), /names nope, which is not a plugin under plugins:/);
refuses(() => line({ plugin: "alt", adapt: "svc" }, { alt: svc(), svc: svc() }), /names svc, which is not a trust: code plugin/);
// An adapter reshapes a plugin's request and answer, so a model target cannot carry one.
refuses(() => line({ model: "m", adapt: "gate" }), /sends to a plugin/);
// The accepted shapes keep the adapter on the line's target.
assert.deepEqual(line({ plugin: "alt", adapt: "gate" }).flows.f!.steps[0]!.to, { plugin: "alt", adapt: "gate" });
assert.deepEqual(line({ asked: true, adapt: "gate" }).flows.f!.steps[0]!.to, { asked: true, adapt: "gate" });
assert.deepEqual(line({ plugin: "alt" }).flows.f!.steps[0]!.to, { plugin: "alt" });
// `fallback.adapt` is gone: an adapter is a line's `adapt:` now, and a file that still carries it is told so.
refuses(
  () => parseConfig({ ...base, plugins: { a: svc({ fallback: { plugin: "b", adapt: "x" } }), b: svc() } }),
  /fallback\.adapt[\s\S]*adapt:/,
  "fallback.adapt points at adapt: on a flow line",
);

// --- a node with an adapter plugin ------------------------------------------
const seenAt: { path: string; query: Record<string, string>; authorization?: string | string[]; key?: string | string[] }[] = [];
const api = createServer((rq, rs) => {
  const at = new URL(rq.url!, "http://here");
  const say = (status: number, body: unknown) => rs.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  seenAt.push({ path: at.pathname, query: Object.fromEntries(at.searchParams), authorization: rq.headers.authorization, key: rq.headers["x-api-key"] });
  if (at.pathname.startsWith("/search/")) {
    const q = at.searchParams.get("q") ?? "";
    if (q === "ok") return say(200, { from: "primary" });
    return say(503, { error: "busy" });
  }
  if (at.pathname.startsWith("/alt/")) {
    const q = at.searchParams.get("q") ?? "";
    if (q === "bad") return say(200, { oops: true });
    if (q === "gone") return say(404, { error: "nope" });
    if (q === "slow-answer") return say(200, { hang: true });
    return say(200, { results: [{ url: "https://a.test" }] });
  }
  if (at.pathname.startsWith("/twin/")) return say(200, { from: "twin" });
  rs.writeHead(404).end();
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
const port = () => new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });

const GATE = `export default {
  apiVersion: 1,
  kinds: {},
  setup() {
    return {
      adapt: {
        request(req) {
          // No counterpart on the target's API: this line cannot serve the request.
          if (req.query.q === "nocounterpart") return null;
          // A request that never settles: held to the plugin's timeoutMs.
          if (req.query.q === "slow-request") return new Promise(() => {});
          return { path: "/alt" + req.path, query: { q: req.query.q, via: Object.keys(req).sort().join(",") } };
        },
        response(res, req) {
          // An answer that never settles: held to the plugin's timeoutMs too.
          if (req.query.q === "slow-answer") return new Promise(() => {});
          const d = JSON.parse(res.body);
          if (!Array.isArray(d.results)) throw new Error("no results list");
          return { contentType: "application/json", body: JSON.stringify({ from: "adapted", q: req.query.q, n: d.results.length }) };
        },
      },
    };
  },
};
`;
/** A code plugin whose setup hooks nothing: an adapter a line names must not start like this. */
const HOLLOW = "export default { apiVersion: 1, kinds: {}, setup() { return {}; } };\n";

const dir = mkdtempSync(join(tmpdir(), "hearth-adapters-"));
const gatePath = join(dir, "gate.mjs");
writeFileSync(gatePath, GATE);
const hollowPath = join(dir, "hollow.mjs");
writeFileSync(hollowPath, HOLLOW);

const said: { msg: string; fields: Record<string, unknown> }[] = [];
const kept: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, fields) => said.push({ msg, fields: fields ?? {} }),
  error: (msg, fields) => said.push({ msg, fields: fields ?? {} }),
};

const tools = `      plugins:
        inputs: [API]
        steps:
          - when: {variant: [search]}
            to: {plugin: primary}
          - when: {variant: [search]}
            to: {plugin: alt, adapt: gate}
          - when: {variant: [search]}
            to: {plugin: twin}
          - when: {variant: [search]}
            to: {plugin: alt, adapt: hollow}
          - to: {refuse: "only search"}
      rest: {inputs: ["*"], steps: [{to: {asked: true}}]}`;
const free = await port();
const dir2 = mkdtempSync(join(tmpdir(), "hearth-adapters-cfg-"));
const cfgPath = join(dir2, "hearth.yaml");
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
  tools:
    flows:
${tools}
  strict:
    strict: true
    flows:
${tools}
apiKeys:
  - {key: k-app, label: app}
  - {key: k-strict, label: strict}
callers: {app: tools, strict: strict}
plugins:
  primary: {serves: "${apiUrl}/search", trust: http}
  alt: {serves: "${apiUrl}", trust: http, headers: {X-Api-Key: alt-key}}
  twin: {serves: "${apiUrl}/twin", trust: http}
  gate: {use: 'file:${gatePath}', trust: code, timeoutMs: 200}
  hollow: {use: 'file:${hollowPath}', trust: code}
  lonely: {use: 'file:${hollowPath}', trust: code}
`);
const node = createNode(loadConfig(cfgPath), kept);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));
const call = async (path: string, key = "k-app") => {
  const r = await fetch(`http://127.0.0.1:${free}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

try {
  // A plugin a line names as an adapter must return an adapt with both sides, or it does not start.
  const shown = node.plugins.status();
  const hollow = shown.find((p) => p.name === "hollow");
  assert.equal(hollow!.state, "failed");
  assert.match(String(hollow!.error), /named as an adapter \(a line's `adapt:`\)/, "an adapter plugin without an adapt fails to start");
  assert.equal(shown.find((p) => p.name === "gate")!.state, "running", "an adapter that hooks nothing runs");
  // An adapter runs where a line that names it does, so it is not a plugin that runs nowhere: only a
  // code plugin no line and no adapter naming reaches is warned about.
  const warned = said.filter((s) => s.msg === "plugin.on_no_line").map((s) => s.fields["plugin"]);
  assert.deepEqual(warned, ["lonely"], "the adapters are not warned about; a plugin on no line still is");
  // With its adapter down, the line cannot serve the request: the next line is asked.
  assert.deepEqual(await call("/plugins/search/page?q=ok"), { status: 200, body: { from: "primary" } });

  // A line that answers is not adapted, and its adapter does not run.
  assert.ok(!seenAt.some((r) => r.path.startsWith("/alt/")), "the adapter's target is not asked");

  // The first line fails: the second sends the request to the next target through the adapter.
  assert.deepEqual(await call("/plugins/search/page?q=fail"), { status: 200, body: { from: "adapted", q: "fail", n: 1 } });
  const alt = seenAt.find((r) => r.path === "/alt/page");
  assert.ok(alt !== undefined, "the adapter chose the path on the target's API");
  assert.equal(alt!.query.via, "body,contentType,method,path,query", "the code sees the request's shape, never the caller's headers");
  assert.equal(alt!.key, "alt-key", "the target still gets its own headers");
  assert.equal(alt!.authorization, undefined, "and not the caller's credentials");

  // No counterpart on that API: the line fails and the next one is tried.
  assert.deepEqual(await call("/plugins/search/page?q=nocounterpart"), { status: 200, body: { from: "twin" } });

  // A response() that cannot read the answer is a 502 naming the adapter, not another line.
  const unreadable = await call("/plugins/search/page?q=bad");
  assert.equal(unreadable.status, 502);
  assert.match(String(unreadable.body.error), /adapter gate could not read alt's answer: no results list/);

  // An async request() that never settles is a failed line, within the plugin's timeoutMs.
  const hungRequestAt = Date.now();
  assert.deepEqual(await call("/plugins/search/page?q=slow-request"), { status: 200, body: { from: "twin" } }, "a request() that never settles fails its line");
  assert.ok(Date.now() - hungRequestAt < 2_000, `a hung request() is cut off at its deadline (took ${Date.now() - hungRequestAt} ms)`);

  // An async response() that never settles is a 502 within the same deadline.
  const hungAnswerAt = Date.now();
  const hung = await call("/plugins/search/page?q=slow-answer");
  assert.equal(hung.status, 502);
  assert.match(String(hung.body.error), /adapter gate could not read alt's answer: adapter gate gave no answer in 200 ms/);
  assert.ok(Date.now() - hungAnswerAt < 2_000, `a hung response() is cut off at its deadline (took ${Date.now() - hungAnswerAt} ms)`);

  // A non-2xx from the target is the caller's answer: it is never adapted.
  assert.deepEqual(await call("/plugins/search/page?q=gone"), { status: 404, body: { error: "nope" } });

  // A strict router's caller gets the line it names or its failure: no next line, and the target's own
  // answer where it gave one.
  const before = seenAt.filter((r) => r.path.startsWith("/alt")).length;
  const strict = await call("/plugins/search/page?q=fail", "k-strict");
  assert.deepEqual(strict, { status: 503, body: { error: "busy" } });
  assert.equal(seenAt.filter((r) => r.path.startsWith("/alt")).length, before, "a strict router tries no next line");
} finally {
  await node.close();
  api.close();
}

// --- the example, end to end -------------------------------------------------
const example = join(import.meta.dirname, "../examples/adapters/searxng-to-degoog.mjs");
const search = createServer((rq, rs) => {
  const at = new URL(rq.url!, "http://here");
  const say = (status: number, body: unknown) => rs.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (at.pathname.startsWith("/searxng/")) return say(503, { error: "searxng is down" });
  if (at.pathname === "/degoog/api/search") {
    return say(200, {
      query: at.searchParams.get("q"),
      results: [{ title: "T", url: "https://a.test", snippet: "S", source: "Bing", sources: ["Bing"] }],
      relatedSearches: ["hearth stone"],
      engineTimings: [{ name: "Brave", status: "timeout" }],
    });
  }
  rs.writeHead(404).end();
});
await new Promise<void>((r) => search.listen(0, "127.0.0.1", r));
const searchUrl = `http://127.0.0.1:${(search.address() as AddressInfo).port}`;
const free2 = await port();
const dir3 = mkdtempSync(join(tmpdir(), "hearth-adapters-example-"));
const cfg2 = join(dir3, "hearth.yaml");
writeFileSync(cfg2, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free2}}
backends:
  main: {url: http://127.0.0.1:1, serves: [m]}
models:
  m: {backend: main}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
routers:
  tools:
    flows:
      plugins:
        inputs: [API]
        steps:
          - when: {variant: [websearch]}
            to: {plugin: searxng}
          - when: {variant: [websearch]}
            to: {plugin: degoog, adapt: searxng-to-degoog}
          - to: {refuse: "only websearch"}
      rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: k-app, label: app}
callers: {app: tools}
plugins:
  searxng: {serves: "${searchUrl}/searxng", trust: http}
  degoog: {serves: "${searchUrl}/degoog", trust: http}
  searxng-to-degoog: {use: 'file:${example}', trust: code}
`);
const node2 = createNode(loadConfig(cfg2), silentLogger);
node2.start();
await node2.startPlugins();
await new Promise<void>((r) => node2.server.listen(free2, "127.0.0.1", r));
try {
  const r = await fetch(`http://127.0.0.1:${free2}/plugins/websearch/search?q=hearth&format=json`, { headers: { Authorization: "Bearer k-app" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    query: "hearth",
    number_of_results: 1,
    results: [{ url: "https://a.test", title: "T", content: "S", engine: "bing", engines: ["bing"], category: "general" }],
    answers: [],
    corrections: [],
    infoboxes: [],
    suggestions: ["hearth stone"],
    unresponsive_engines: [["Brave", "timeout"]],
  }, "the example carries the request to the other API and its answer back");
} finally {
  await node2.close();
  search.close();
}
console.log("adapters: ok");
