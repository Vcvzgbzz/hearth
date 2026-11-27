/**
 * The adapter as the console reads it: the source of each side, the lines that hand it a request,
 * the last call through it, and the "try it" route that runs one side on a sample.
 *
 * The adapter is a `trust: code` plugin, so the panel only ever reads it: the code is the operator's
 * file, and a restart is what reads a change. What the console can do is run one side against a
 * sample, which is what `/ui/adapters/try` is for: a logged-in operator's alone, since it runs the plugin's
 * code, and held to the adapter plugin's own `timeoutMs`.
 *
 *     npx tsx test/adapterui.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashPassword } from "../src/access/login.js";
import { loadConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { splitAdapterSource } from "../src/routing/adapterSource.js";
import { createNode } from "../src/server.js";

/** A module whose two sides both pass the value through, and whose response side can be made to fail. */
const GATE = `export default {
  apiVersion: 1,
  kinds: {},
  setup() {
    return {
      adapt: {
        request(req) {
          return { path: "/alt" + req.path, query: { q: req.query.q ?? "" } };
        },
        response(res, req) {
          const d = JSON.parse(res.body);
          if (!Array.isArray(d.results)) throw new Error("no results list");
          return { contentType: "application/json", body: JSON.stringify({ from: "adapted", n: d.results.length }) };
        },
      },
    };
  },
};
`;
/** A request side that throws: the error the panel shows is the code's own words. */
const BOOM = `export default {
  apiVersion: 1,
  kinds: {},
  setup() {
    return {
      adapt: {
        request() { throw new Error("no counterpart in this module"); },
        response(res) { return res; },
      },
    };
  },
};
`;
/** A side that never settles: the plugin's timeoutMs is what cuts it off. */
const SLOW = `export default {
  apiVersion: 1,
  kinds: {},
  setup() {
    return {
      adapt: {
        request() { return new Promise(() => {}); },
        response(res) { return res; },
      },
    };
  },
};
`;

/** A stub plugin service: the target the adapter carries requests to. */
const upstream = createServer((rq, rs) => {
  const at = new URL(rq.url!, "http://here");
  if (at.pathname.startsWith("/alt/")) {
    const q = at.searchParams.get("q") ?? "";
    rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(q === "bad" ? { oops: true } : { results: [{ url: "https://a.test" }] }));
    return;
  }
  rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ results: [{ url: "https://a.test" }] }));
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
const port = () => new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });

const dir = mkdtempSync(join(tmpdir(), "hearth-adapterui-"));
for (const [name, body] of [["gate.mjs", GATE], ["boom.mjs", BOOM], ["slow.mjs", SLOW]] as const) writeFileSync(join(dir, name), body);

const free = await port();
const cfgPath = join(dir, "hearth.yaml");
const passHash = await hashPassword("right-horse");
writeFileSync(cfgPath, `version: 3
operator: {user: op, passHash: "${passHash}"}
name: t
listen: {host: 127.0.0.1, port: ${free}}
backends:
  main: {url: http://127.0.0.1:1, serves: [m]}
models:
  m: {backend: main}
flows:
  plugins:
    inputs: [API]
    steps:
      - when: {variant: [search]}
        to: {plugin: search, adapt: gate}
      - to: {refuse: "only a JSON search"}
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: k-app, label: app}
  - {key: k-chat, label: chat, models: [m]}
plugins:
  search: {serves: "${upstreamUrl}", trust: http}
  gate: {use: 'file:${join(dir, "gate.mjs")}', trust: code, timeoutMs: 1500}
  boom: {use: 'file:${join(dir, "boom.mjs")}', trust: code}
  slow: {use: 'file:${join(dir, "slow.mjs")}', trust: code, timeoutMs: 120}
`);

const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await node.startPlugins();
await new Promise<void>((r) => node.server.listen(free, "127.0.0.1", r));

const base = `http://127.0.0.1:${free}`;
type Ui = { adapters?: { adapters: { name: string; use: string; timeoutMs: number; state: string; request: string | null; response: string | null; whole: string; note?: string; used: { router: string | null; flow: string; step: number }[]; last?: { side: string; ok: boolean; error?: string; t: number } }[] } };
const ui = async (): Promise<Ui> => (await fetch(`${base}/ui/data`)).json() as Promise<Ui>;
/** A run of one side. This node has keys, so a local caller presents one, as the console does. */
// The console's own session: trying an adapter runs its code, which an api key may not.
const login = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: "op", pass: "right-horse" }) });
assert.equal(login.status, 200, "the operator logs in");
const session = (login.headers.get("Set-Cookie") ?? "").split(";")[0]!;
const tryIt = async (body: unknown, headers: Record<string, string> = { Cookie: session }) => {
  const r = await fetch(`${base}/ui/adapters/try`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
const found = async (name: string) => (await ui()).adapters!.adapters.find((a) => a.name === name);
/** Why a route said no: a plain refusal carries the sentence itself, a config refusal puts it under `message`. */
const why = (body: Record<string, unknown>): string => {
  const e = body["error"];
  return typeof e === "string" ? e : String((e as { message?: unknown } | undefined)?.message ?? e);
};

try {
  // --- what the console is given -------------------------------------------------------------
  const { adapters } = (await ui()).adapters!;
  assert.deepEqual(adapters.map((a) => a.name).sort(), ["boom", "gate", "slow"], "every adapter plugin a line could name, and none of the services");
  const gate = (await found("gate"))!;
  assert.equal(gate.timeoutMs, 1500, "the deadline each side is held to");
  assert.match(gate.use, /gate\.mjs$/, "where it comes from, as the config writes it");
  assert.equal(gate.state, "running");
  // IN and OUT are the file's two declarations, read out of it: the panel shows them, and never writes them.
  assert.match(String(gate.request), /^request\(req\) \{/, "IN is request(), as the file holds it");
  assert.match(String(gate.response), /^response\(res, req\) \{/, "OUT is response(), as the file holds it");
  assert.match(gate.whole, /export default \{/, "and the whole module is there for when the sides cannot be told apart");
  assert.deepEqual(gate.used, [{ router: null, flow: "plugins", step: 0 }], "the one line that hands it a request");
  assert.equal(gate.last, undefined, "nothing has gone through it yet");

  // The line that names it serves a request: the answer is the adapter's, and the console is told how it went.
  const served = await fetch(`${base}/plugins/search/page?q=ok&format=json`, { headers: { Authorization: "Bearer k-app" } });
  assert.equal(served.status, 200);
  assert.deepEqual(await served.json(), { from: "adapted", n: 1 }, "the target's answer came back through the adapter");
  const after = (await found("gate"))!;
  assert.deepEqual([after.last?.ok, after.last?.side], [true, "response"], "the last call is remembered, with the side that ran");
  assert.ok(Date.now() - after.last!.t < 60_000, "and when it ran");

  // A failed call is remembered with the code's own words, which is what the block reddens from.
  const failed = await fetch(`${base}/plugins/search/page?q=bad&format=json`, { headers: { Authorization: "Bearer k-app" } });
  assert.equal(failed.status, 502);
  const reddened = (await found("gate"))!;
  assert.deepEqual([reddened.last?.ok, reddened.last?.side], [false, "response"], "a failed call is remembered too");
  assert.match(String(reddened.last?.error), /no results list/, "with the reason it gave");

  // --- try it: a logged-in operator's alone ----------------------------------------------------
  const anonymous = await tryIt({ adapter: "gate", side: "request", req: { method: "GET", path: "/page", query: {} } }, {});
  assert.equal(anonymous.status, 403, "no session, no run, even from this machine once an operator exists");
  const scoped = await tryIt({ adapter: "gate", side: "request", req: { method: "GET", path: "/page", query: {} } }, { Authorization: "Bearer k-chat" });
  assert.equal(scoped.status, 403, "a key scoped to chat does not run it");
  const unscoped = await tryIt({ adapter: "gate", side: "request", req: { method: "GET", path: "/page", query: {} } }, { Authorization: "Bearer k-app" });
  assert.equal(unscoped.status, 403, "an unscoped key does not run it either: it runs the plugin's code");
  assert.match(why(unscoped.body), /logged-in operator/, "and is told why");
  const operator = await tryIt({ adapter: "gate", side: "request", req: { method: "GET", path: "/page", query: {} } });
  assert.equal(operator.status, 200, "the operator's session runs it");

  // --- try it: an ok run ---------------------------------------------------------------------
  const ran = await tryIt({ adapter: "gate", side: "request", req: { method: "GET", path: "/page", query: { q: "hearth" }, contentType: null, body: null } });
  assert.equal(ran.status, 200);
  assert.deepEqual(ran.body["ok"], true);
  assert.deepEqual(ran.body["value"], { path: "/alt/page", query: { q: "hearth" } }, "what request() returned, as a line would have sent it");
  assert.equal(typeof ran.body["ms"], "number");
  // The answer side is given the target's answer and the caller's request.
  const out = await tryIt({ adapter: "gate", side: "response", req: { method: "GET", path: "/page", query: { q: "x" } }, res: { status: 200, contentType: "application/json", body: JSON.stringify({ results: [{ url: "https://a.test" }, { url: "https://b.test" }] }) } });
  assert.deepEqual(out.body["value"], { contentType: "application/json", body: JSON.stringify({ from: "adapted", n: 2 }) });
  // Trying it is not traffic: the block still shows the last real call.
  assert.equal((await found("gate"))!.last!.ok, false, "a try does not touch the last-call state the map draws");

  // --- try it: an error, and a side that never settles ---------------------------------------
  const threw = await tryIt({ adapter: "boom", side: "request", req: { method: "GET", path: "/" } });
  assert.equal(threw.status, 200, "the route answered: what went wrong is the code's, not the form's");
  assert.deepEqual([threw.body["ok"], threw.body["error"]], [false, "no counterpart in this module"], "the code's own words");
  const hung = await tryIt({ adapter: "slow", side: "request", req: { method: "GET", path: "/" } });
  assert.equal(hung.body["ok"], false);
  assert.match(String(hung.body["error"]), /gave no answer in 120 ms/, "the plugin's own timeoutMs cuts it off");

  // --- try it: what is not an adapter, and what is not there ----------------------------------
  const notOne = await tryIt({ adapter: "search", side: "request", req: { method: "GET", path: "/" } });
  assert.equal(notOne.status, 409, "a service plugin is not an adapter");
  assert.match(why(notOne.body), /is not an adapter/);
  const missing = await tryIt({ adapter: "nope", side: "request", req: { method: "GET", path: "/" } });
  assert.equal(missing.status, 404, "and no plugin by that name at all");
  const badSide = await tryIt({ adapter: "gate", side: "both", req: { method: "GET", path: "/" } });
  assert.equal(badSide.status, 400, "a side that is neither request nor response");
  const noRequest = await tryIt({ adapter: "gate", side: "request" });
  assert.equal(noRequest.status, 400, "a sample is required");

  // --- an adapter module the split cannot read -----------------------------------------------
  // Nothing sane writes one, but a file that cannot be read as two sides is shown whole instead.
  const unsplit = splitAdapterSource("export default { adapt: { request: (r) => r, response: (s) => s } };\n");
  assert.deepEqual([unsplit.request, unsplit.response], [null, null], "the sides of a module written another way are not guessed at");
  assert.match(String(unsplit.note), /no request\(\) or response\(\) could be read out of the file/, "and the panel says why it shows the whole file");
  assert.match(unsplit.whole, /export default/, "the whole module is always there to show");
} finally {
  await node.close();
  await new Promise<void>((r) => upstream.close(() => r()));
}
console.log("adapterui.test.ts ok");
