/**
 * Adapters: named code that sits on a line and reshapes what its plugin target is sent, and the
 * answer, in a sandbox that can reach nothing but the value it is given.
 *
 *   - config: an unknown adapter name, `adapt` on a model target, a syntax error naming the adapter
 *     and its line, a module exporting neither side, a timeoutMs out of range
 *   - a side a module does not export is passed through unchanged
 *   - null from request() means "no counterpart": the line fails and the next one is tried
 *   - a non-2xx answer is never adapted; a response() that throws is a 502 naming the adapter; one
 *     stuck in a loop is a 502 within timeoutMs
 *   - the sandbox cannot see process, require, fetch or any other host global; an endless loop and
 *     an array that grows without end are both cut off
 *   - no credentials reach the adapter, and the target still gets its own headers
 *   - a failed line goes on to the next one, and `strict: true` turns that off
 *   - a live edit to `code` takes effect without a restart
 *   - the searxng-to-degoog example, against two stub servers
 */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "../src/config/config.js";
import { ConfigError } from "../src/config/read.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";
import { Adapter, type AdapterRequest } from "../src/routing/adapters.js";

const ask = (more: Partial<AdapterRequest> = {}): AdapterRequest => ({ method: "GET", path: "/search", query: {}, contentType: null, body: null, ...more });
/** A config refusal whose sentence says this. */
const refuses = (fn: () => unknown, re: RegExp, why?: string) => assert.throws(fn, (e: unknown) => e instanceof ConfigError && re.test(e.message), why);

// --- config -----------------------------------------------------------------
const base = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" } } };
const withAdapters = (adapters: unknown) => parseConfig({ ...base, adapters });
const plain = "export function request(req) { return { path: req.path }; }";
assert.deepEqual(withAdapters({ a: { code: plain } }).adapters.a, { code: plain, timeoutMs: 1000 });
assert.equal(withAdapters({ a: { code: plain, timeoutMs: 250 } }).adapters.a!.timeoutMs, 250);
refuses(() => withAdapters({ a: { code: plain, timeoutMs: 0 } }), /timeoutMs/);
refuses(() => withAdapters({ a: { code: plain, timeoutMs: 10_001 } }), /timeoutMs/);
refuses(() => withAdapters({ a: {} }), /code/);
refuses(() => withAdapters({ "not_allowed": { code: plain } }), /name/);
refuses(() => withAdapters({ a: { code: plain, extra: 1 } }), /extra/);
// A syntax error names the adapter and the line its module broke on.
assert.throws(
  () => withAdapters({ sx: { code: "export function request(req) {\n  return req.\n}" } }),
  (e: unknown) => e instanceof ConfigError && e.path === "adapters.sx.code" && /line 3/.test(e.message),
  "a syntax error names the adapter and the line",
);
// An adapter that exports neither side does nothing, so it is refused rather than silently doing it.
refuses(() => withAdapters({ empty: { code: "export const unused = 1;" } }), /exports neither request nor response/);
refuses(() => withAdapters({ wrong: { code: "export const request = 1;" } }), /request is not a function/);
// The top level holds only consts and functions, so a loop written there is refused, not run.
refuses(() => withAdapters({ loops: { code: "for (;;) {}" } }), /only for\.\.\.of loops/);
// A const's initializer does run at load, and is held to a deadline like a call.
refuses(() => withAdapters({ spin: { code: "const x = (() => { while (true) {} })();" } }), /step budget exceeded/);

const flow = (to: unknown) => ({ ...base, adapters: { a: { code: plain } }, flows: { f: { inputs: ["*"], steps: [{ when: { variant: ["p"] }, to }, { to: { asked: true } }] } } });
// A line that names an adapter must name one under adapters:.
refuses(() => parseConfig(flow({ plugin: "x", adapt: "nope" })), /not under adapters/);
// An adapter reshapes a plugin's request and answer, so a model target cannot carry one.
refuses(() => parseConfig(flow({ model: "m", adapt: "a" })), /sends to a plugin/);
assert.deepEqual(parseConfig(flow({ plugin: "x", adapt: "a" })).flows.f!.steps[0]!.to, { plugin: "x", adapt: "a" });
assert.deepEqual(parseConfig(flow({ asked: true, adapt: "a" })).flows.f!.steps[0]!.to, { asked: true, adapt: "a" });
assert.deepEqual(parseConfig(flow({ plugin: "x" })).flows.f!.steps[0]!.to, { plugin: "x" });

// --- the sandbox ------------------------------------------------------------
const unit = (code: string, timeoutMs = 1000) => new Adapter("a", code, timeoutMs);

// A side the module does not export is passed through unchanged.
const responseOnly = unit("export function response(res) { return { body: 'no' }; }");
assert.deepEqual(await responseOnly.request(ask()), {}, "an unexported request() passes the request through");
assert.deepEqual(await responseOnly.response({ status: 200, contentType: "text/plain", body: "x" }, ask()), { body: "no" });
responseOnly.close();

// request() reshapes what the target is sent; null is "no counterpart here".
const reshape = unit("export function request(req) {\n  if (req.path === \"/none\") return null;\n  return { path: \"/api\" + req.path, query: { q: req.query.q ?? \"/\" } };\n}");
assert.deepEqual(await reshape.request(ask({ path: "/search", query: { q: "hearth" } })), { path: "/api/search", query: { q: "hearth" } });
assert.equal(await reshape.request(ask({ path: "/none" })), null, "null means this line has no counterpart");
reshape.close();

// Both sides see the caller's original request, and each may set only its own fields.
const both = unit(`
export function request(req) { return { method: "POST", body: req.body === null ? null : req.body.toUpperCase() }; }
export function response(res, req) { return { body: res.body + " for " + req.path, status: 201 }; }
`);
assert.deepEqual(await both.request(ask({ method: "GET", body: "hello", contentType: "text/plain" })), { method: "POST", body: "HELLO" });
assert.deepEqual(
  await both.response({ status: 200, contentType: "text/plain", body: "answer" }, ask({ path: "/original" })),
  { status: 201, body: "answer for /original" },
  "response() is given the request the caller sent",
);
both.close();

// A response() that throws says why; one stuck in a loop is cut off at its deadline.
const throwing = unit("export function response(res) { throw new Error('cannot read ' + res.status); }");
await assert.rejects(throwing.response({ status: 404, contentType: null, body: "" }, ask()), /cannot read 404/);
throwing.close();
const hanging = unit("export function response() { while (true) {} }", 150);
const hungAt = Date.now();
await assert.rejects(hanging.response({ status: 200, contentType: null, body: "" }, ask()), /step budget exceeded \(150 ms\)/);
assert.ok(Date.now() - hungAt < 2_000, `a response() that never ends is cut off (took ${Date.now() - hungAt} ms)`);
hanging.close();

// The sandbox has nothing of the host in it, and nothing that can wait on anything.
const probe = unit(`
export function request() {
  return { body: JSON.stringify({
    process: typeof process, require: typeof require, fetch: typeof fetch, module: typeof module,
    window: typeof window, document: typeof document, console: typeof console, Buffer: typeof Buffer,
    globalThis: typeof globalThis, Promise: typeof Promise, setTimeout: typeof setTimeout,
  }) };
}`);
const seen = JSON.parse(String((await probe.request(ask()))!.body));
assert.deepEqual(
  seen,
  {
    process: "undefined", require: "undefined", fetch: "undefined", module: "undefined",
    window: "undefined", document: "undefined", console: "undefined", Buffer: "undefined",
    globalThis: "undefined", Promise: "undefined", setTimeout: "undefined",
  },
  "no host globals reach the code",
);
probe.close();

const spinning = unit("export function request() { while (true) {} }", 200);
await assert.rejects(spinning.request(ask()), /step budget exceeded \(200 ms\)/, "a loop that never ends is cut off");
spinning.close();
const bloating = unit("export function request() { const a = []; while (true) { a.push(1); } }", 5000);
const blewUpAt = Date.now();
await assert.rejects(bloating.request(ask()), /array too long/, "an array that grows without end is cut off");
assert.ok(Date.now() - blewUpAt < 5_000, `the array cap ends it before the deadline (took ${Date.now() - blewUpAt} ms)`);
bloating.close();

// --- a node with an adapter -------------------------------------------------
const seenAt: { path: string; query: Record<string, string>; authorization?: string | string[]; key?: string | string[] }[] = [];
const api = createServer((rq, rs) => {
  const at = new URL(rq.url!, "http://here");
  const say = (status: number, body: unknown) => rs.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  seenAt.push({ path: at.pathname, query: Object.fromEntries(at.searchParams), authorization: rq.headers.authorization, key: rq.headers["x-api-key"] });
  if (at.pathname.startsWith("/search/")) {
    const q = at.searchParams.get("q") ?? "";
    if (q === "gone") return say(404, { error: "nope" });
    if (/^(fail|bad|hang|nocounterpart)/.test(q)) return say(503, { error: "busy" });
    return say(200, { from: "primary" });
  }
  if (at.pathname.startsWith("/alt2/")) return say(200, { results: [1] });
  if (at.pathname.startsWith("/alt/")) {
    const q = at.searchParams.get("q") ?? "";
    if (q === "bad") return say(200, { oops: true });
    if (q === "hang") return say(200, { hang: true });
    return say(200, { results: [{ url: "https://a.test" }] });
  }
  if (at.pathname.startsWith("/twin/")) return say(200, { from: "twin" });
  rs.writeHead(404).end();
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
const port = () => new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });

const GATE = `export function request(req) {
  if (req.query.q === "nocounterpart") return null;
  return { path: "/alt" + req.path, query: { q: req.query.q, via: Object.keys(req).sort((a, b) => (a < b ? -1 : 1)).join(",") } };
}
export function response(res, req) {
  if (res.body.includes("hang")) { while (true) {} }
  const d = JSON.parse(res.body);
  if (!Array.isArray(d.results)) throw new Error("no results list");
  return { contentType: "application/json", body: JSON.stringify({ from: "adapted", q: req.query.q, n: d.results.length }) };
}`;
// The same adapter after a live edit: a new path, and an answer of its own.
const GATE_LIVE = `export function request(req) { return { path: "/alt2" + req.path, query: { q: req.query.q } }; }
export function response(res, req) { return { body: JSON.stringify({ from: "live", q: req.query.q }) }; }`;

const block = (text: string, indent = "      ") => text.split("\n").map((line) => (line === "" ? "" : indent + line)).join("\n");
const tools = `      plugins:
        inputs: [API]
        steps:
          - when: {variant: [search]}
            to: {plugin: primary}
          - when: {variant: [search]}
            to: {plugin: alt, adapt: gate}
          - when: {variant: [search]}
            to: {plugin: twin}
          - to: {refuse: "only search"}
      rest: {inputs: ["*"], steps: [{to: {asked: true}}]}`;
const free = await port();
const dir = mkdtempSync(join(tmpdir(), "hearth-adapters-"));
const cfgPath = join(dir, "hearth.yaml");
writeFileSync(cfgPath, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free}}
backends:
  main: {url: http://127.0.0.1:1, serves: [m]}
models:
  m: {backend: main}
adapters:
  gate:
    timeoutMs: 200
    code: |
${block(GATE)}
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
  // A line that answers is not adapted, and its adapter does not run.
  assert.deepEqual(await call("/plugins/search/page?q=ok"), { status: 200, body: { from: "primary" } });
  assert.ok(!seenAt.some((r) => r.path.startsWith("/alt/")), "the adapter's target is not asked");

  // The first line fails: the second sends the request to the next target, through the adapter.
  const adapted = await call("/plugins/search/page?q=fail");
  assert.deepEqual(adapted, { status: 200, body: { from: "adapted", q: "fail", n: 1 } });
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

  // A response() stuck in a loop is a 502 within its timeoutMs.
  const hungAt2 = Date.now();
  const hung = await call("/plugins/search/page?q=hang");
  assert.equal(hung.status, 502);
  assert.match(String(hung.body.error), /step budget exceeded \(200 ms\)/);
  assert.ok(Date.now() - hungAt2 < 2_000, `a response() stuck in a loop is cut off at its deadline (took ${Date.now() - hungAt2} ms)`);

  // A non-2xx from the target is the caller's answer: it is never adapted.
  assert.deepEqual(await call("/plugins/search/page?q=gone"), { status: 404, body: { error: "nope" } });

  // A strict router's caller gets the line it names or its failure: no next line, and the target's own
  // answer where it gave one.
  const before = seenAt.filter((r) => r.path.startsWith("/alt")).length;
  const strict = await call("/plugins/search/page?q=fail", "k-strict");
  assert.deepEqual(strict, { status: 503, body: { error: "busy" } });
  assert.equal(seenAt.filter((r) => r.path.startsWith("/alt")).length, before, "a strict router tries no next line");

  // A live edit to the code is used by the next request, with no restart.
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(block(GATE), block(GATE_LIVE)));
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(await call("/plugins/search/page?q=fail2"), { status: 200, body: { from: "live", q: "fail2" } });
  assert.ok(seenAt.some((r) => r.path === "/alt2/page"), "the edited code chose the new path");
} finally {
  await node.close();
  api.close();
}

// --- the example, end to end -------------------------------------------------
const example = readFileSync(join(import.meta.dirname, "../examples/adapters/searxng-to-degoog.mjs"), "utf8");
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
const dir2 = mkdtempSync(join(tmpdir(), "hearth-adapters-example-"));
const cfg2 = join(dir2, "hearth.yaml");
writeFileSync(cfg2, `version: 3
name: t
listen: {host: 127.0.0.1, port: ${free2}}
backends:
  main: {url: http://127.0.0.1:1, serves: [m]}
models:
  m: {backend: main}
adapters:
  searxng-to-degoog:
    code: |
${block(example)}
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
