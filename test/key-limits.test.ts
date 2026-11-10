/**
 * A key's expiry day and limits. The failures worth catching:
 *
 *   - a key past its day still working, or one on its last day refused
 *   - a limit that counts refused requests, or never lets up
 *   - a minted key losing the limits it was minted with
 *   - a malformed day or limit accepted into the file
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

const backend = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(req.url === "/v1/models"
    ? JSON.stringify({ data: [{ id: "chat" }] })
    : JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));

const today = new Date().toISOString().slice(0, 10);
const cfgPath = join(mkdtempSync(join(tmpdir(), "hearth-limits-")), "hearth.yaml");
const base = `name: node-under-test
backends:
  main:
    url: http://127.0.0.1:${(backend.address() as AddressInfo).port}
    kind: none
    serves: [chat]
models:
  chat: {price: {in: 100000, out: 200000}}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
`;
writeFileSync(cfgPath, `${base}apiKeys:
  - {key: admin-secret, label: admin}
  - {key: old-secret, label: old, expires: "2000-01-01"}
  - {key: last-day-secret, label: last-day, expires: "${today}"}
  - {key: slow-secret, label: slow, limits: {requestsPerMinute: 2}}
  - {key: small-secret, label: small, limits: {tokensPerDay: 20}}
  - {key: paid-secret, label: paid, limits: {dollarsPerDay: 3.5}}
`);

const bad = (entry: string, path: RegExp) => assert.throws(() => parseConfig({ ...loadYaml(), apiKeys: [JSON.parse(entry)] }), path);
const loadYaml = (): Record<string, unknown> => ({ name: "n", backends: { main: { url: "http://127.0.0.1:1", kind: "none", serves: ["chat"] } }, flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } } });
bad('{"key":"k","label":"a","expires":"next week"}', /expires/);
bad('{"key":"k","label":"a","limits":{"requestsPerMinute":-1}}', /requestsPerMinute/);
bad('{"key":"k","label":"a","limits":{"perHour":5}}', /perHour/);
bad('{"key":"k","label":"a","limits":{"models":{"":{"maxConcurrent":1}}}}', /limits\.models/);
bad('{"key":"k","label":"a","limits":{"models":{"  ":{"maxConcurrent":1}}}}', /limits\.models/);

// A key's lane, its jobs at once, and a model's own limits.
const ruleFor = (entry: unknown) => parseConfig({ ...loadYaml(), apiKeys: [entry] }).apiKeyRules[0]!;
const full = ruleFor({ key: "k", label: "a", lane: "batch", limits: { maxConcurrent: 6, models: { "my-model:latest": { maxConcurrent: 2, tokensPerDay: 100, requestsPerMinute: 5 } } } });
assert.equal(full.lane, "batch");
assert.equal(full.maxConcurrent, 6);
assert.deepEqual(full.models, { "my-model:latest": { maxConcurrent: 2, tokensPerDay: 100, requestsPerMinute: 5 } });
const plain = ruleFor({ key: "k", label: "a" });
assert.deepEqual([plain.lane, plain.maxConcurrent, plain.models], [null, 0, {}], "a key that names none of them is held to none of them");
assert.deepEqual(ruleFor({ key: "k", label: "a", limits: { models: { gone: { tokensPerDay: 5 } } } }).models, { gone: { tokensPerDay: 5 } }, "a limit on a model no longer here loads: a router can change under it");
bad('{"key":"k","label":"a","lane":"nope"}', /apiKeys\[0\]\.lane.*nope.*chat, batch/);
bad('{"key":"k","label":"a","limits":{"maxConcurrent":0}}', /apiKeys\[0\]\.limits\.maxConcurrent/);
bad('{"key":"k","label":"a","limits":{"maxConcurrent":1.5}}', /apiKeys\[0\]\.limits\.maxConcurrent/);
bad('{"key":"k","label":"a","limits":{"models":{"m":{"tokensPerDay":-1}}}}', /apiKeys\[0\]\.limits\.models\.m\.tokensPerDay/);
bad('{"key":"k","label":"a","limits":{"models":{"m":{"perHour":5}}}}', /perHour/);

const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const post = (route: string, key: string, body: unknown) =>
  fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
const chat = async (key: string, model = "chat") => {
  const r = await post("/v1/chat/completions", key, { model, messages: [{ role: "user", content: "hi" }] });
  const body = await r.text();
  return { status: r.status, body };
};

assert.equal((await chat("old-secret")).status, 401, "past its day, a key is no key");
assert.equal((await chat("last-day-secret")).status, 200, "it works through its last day");

assert.equal((await chat("slow-secret")).status, 200);
assert.notEqual((await chat("slow-secret", "no-such-model")).status, 200);
assert.equal((await chat("slow-secret")).status, 200, "a request refused for another reason is not counted");
const third = await chat("slow-secret");
assert.equal(third.status, 429);
assert.match(third.body, /2 requests a minute/);
assert.equal((await chat("admin-secret")).status, 200, "one key's limit is its own");

assert.equal((await chat("small-secret")).status, 200);
assert.equal((await chat("small-secret")).status, 200, "15 of 20 used: there is still room");
const spent = await chat("small-secret");
assert.equal(spent.status, 429);
assert.match(spent.body, /20 tokens for today/);

// Dollars: each call here is 10 tokens in at $0.10 and 5 out at $0.20, so $2. Two fit under $3.50, as the page and /usage say.
assert.equal((await chat("paid-secret")).status, 200);
assert.equal((await chat("paid-secret")).status, 200, "$2 of $3.50 spent: there is still room");
const broke = await chat("paid-secret");
assert.equal(broke.status, 429);
assert.match(broke.body, /spent its \$3\.5 for today/);
const told = (await (await fetch(`${url}/usage?days=1`, { headers: { Authorization: "Bearer admin-secret" } })).json()) as { prices: Record<string, { in: number; out: number }> };
assert.deepEqual(told.prices, { chat: { in: 100000, out: 200000 } });
const page = (await (await fetch(`${url}/ui/data`, { headers: { Authorization: "Bearer admin-secret" } })).json()) as { keys: { label: string; today: { cost: number } }[] };
assert.equal(page.keys.find((k) => k.label === "paid")!.today.cost, 4, "what it spent, the refused call not among it");

// Minting carries them into the file, and the file's parser judges them.
const minted = await post("/keys/mint", "admin-secret", { label: "guest", expires: "2099-12-31", limits: { requestsPerMinute: 1 } });
assert.equal(minted.status, 200);
const guest = ((await minted.json()) as { key: string }).key;
assert.match(readFileSync(cfgPath, "utf8"), /expires: "?2099-12-31/);
assert.equal((await chat(guest)).status, 200);
assert.equal((await chat(guest)).status, 429, "the minted key is held to what it was minted with");
assert.equal((await post("/keys/mint", "admin-secret", { label: "bad", expires: "soon" })).status, 422);
assert.ok(!readFileSync(cfgPath, "utf8").includes("label: bad"), "and nothing malformed reaches the file");

await node.close();
backend.close();

// --- a key's lane and jobs at once, on a backend that answers when told to -----------
const gates: (() => void)[] = [];
const slow = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [] })); return; }
  gates.push(() => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })));
});
await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
const heldPath = join(mkdtempSync(join(tmpdir(), "hearth-held-")), "hearth.yaml");
writeFileSync(heldPath, `name: held-under-test
scheduler:
  maxPerCaller: 1
  lanes: {chat: {priority: 0}, batch: {priority: 100}}
backends:
  main:
    url: ${slowUrl}
    kind: none
    serves: [one, pinned, free, stepped-to]
    concurrency: 8
    routes:
      - {path: /v1/rank, model: ranker, lane: chat}
  second:
    url: ${slowUrl}
    kind: none
    serves: [two]
    concurrency: 8
models:
  pinned: {lane: chat}
flows:
  stepped: {inputs: [stepped], steps: [{to: stepped-to, lane: chat}]}
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: boss-secret, label: boss}
  - {key: uncapped-secret, label: uncapped, limits: {maxConcurrent: 3}}
  - {key: single-secret, label: single, limits: {maxConcurrent: 1}}
  - {key: bulk-secret, label: bulk, lane: batch}
  - {key: thrifty-secret, label: thrifty, limits: {models: {one: {tokensPerDay: 20, requestsPerMinute: 3}, two: {maxConcurrent: 1}}}}
  - {key: ranker-secret, label: rankers, lane: batch, limits: {maxConcurrent: 1}}
`);
const heldNode = createNode(loadConfig(heldPath), silentLogger);
heldNode.start();
await new Promise<void>((r) => heldNode.server.listen(0, "127.0.0.1", r));
const heldUrl = `http://127.0.0.1:${(heldNode.server.address() as AddressInfo).port}`;
const ask = (key: string, model: string, extra: Record<string, unknown> = {}) =>
  fetch(`${heldUrl}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }) });
const queue = async () => ((await (await fetch(`${heldUrl}/queue`, { headers: { Authorization: "Bearer boss-secret" } })).json()) as { jobs: { caller: string; lane: string; model: string; state: string; held?: string }[] }).jobs;
const settle = () => new Promise<void>((r) => setTimeout(r, 40));
const open = async (n: number) => { for (let i = 0; i < 100 && gates.length < n; i++) await settle(); assert.equal(gates.length, n); };
const letGo = async () => { while (gates.length > 0) gates.shift()!(); await settle(); };

// A key over its jobs at once waits, on any backend, and is answered.
const waits = [ask("single-secret", "one"), ask("single-secret", "two")];
await open(1);
await settle();
assert.deepEqual((await queue()).filter((j) => j.state === "queued").map((j) => [j.caller, j.held]), [["key:single", "key"]], "held across backends, and the queue says why");
const row = async (label: string) => ((await (await fetch(`${heldUrl}/ui/data`, { headers: { Authorization: "Bearer boss-secret" } })).json()) as { keys: { label: string; router: string; lane: string | null; now: Record<string, { running: number; waiting: number }>; reach: { type: string; ends: { id: string }[] }[]; byModel: { today: Record<string, { in: number }> } }[] }).keys.find((k) => k.label === label)!;
const single = await row("single");
assert.equal(single.router, "default");
assert.equal(single.lane, null);
assert.deepEqual(single.reach.map((t) => t.type), ["stepped", "anything else"], "what its rulebook names, and that the rest runs as asked");
const busy = Object.values(single.now);
assert.deepEqual([busy.reduce((n, m) => n + m.running, 0), busy.reduce((n, m) => n + m.waiting, 0)], [1, 1], "what the page shows as running and waiting; either may have started first");
await letGo();
await open(1);
await letGo();
assert.deepEqual((await Promise.all(waits)).map((r) => r.status), [200, 200], "waiting is not a refusal");

// scheduler.maxPerCaller refuses, unless the key says how many it may run.
const capped = [ask("boss-secret", "one"), ask("uncapped-secret", "one")];
await open(2);
const overCap = await ask("boss-secret", "one");
assert.equal(overCap.status, 429, "a key with no limit of its own still meets the node's cap");
assert.equal((await Promise.race([ask("uncapped-secret", "one").then((r) => r.status), settle().then(() => "still running")])), "still running", "a key with its own limit does not");
await open(3);
await letGo();
await Promise.all(capped);

// A key's lane sits under a model's or a step's own, and over the request's.
const lanesAre = async (key: string, model: string, extra?: Record<string, unknown>) => {
  const r = ask(key, model, extra);
  await open(1);
  const lane = (await queue()).find((j) => j.state === "running")!.lane;
  await letGo();
  await r;
  return lane;
};
assert.equal(await lanesAre("bulk-secret", "free"), "batch", "the key's lane");
assert.equal((await row("bulk")).lane, "batch");
assert.equal((await row("bulk")).byModel.today.free!.in, 10, "its use, model by model");
assert.equal(await lanesAre("bulk-secret", "free", { lane: "chat" }), "batch", "a key's lane beats the request's");
assert.equal(await lanesAre("bulk-secret", "pinned"), "chat", "a model's own lane beats the key's");
assert.equal(await lanesAre("bulk-secret", "stepped"), "chat", "and so does a step's");
assert.equal(await lanesAre("boss-secret", "free", { lane: "batch" }), "batch", "a key with no lane leaves it to the request");

// A route keeps its lane under a key with one, and the key's jobs at once holds there too.
const rank = () => fetch(`${heldUrl}/v1/rank`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ranker-secret" }, body: "{}" });
const ranks = [rank(), rank()];
await open(1);
await settle();
const ranking = await queue();
assert.equal(ranking.find((j) => j.state === "running")!.lane, "chat", "a route's lane beats the key's");
assert.equal(ranking.find((j) => j.state === "queued")?.held, "key", "and its limit holds on a route as well");
await letGo();
await open(1);
await letGo();
await Promise.all(ranks);

// A model's own limits: tokens and requests refuse, and name the model.
const once = async (model: string) => { const r = ask("thrifty-secret", model); await open(1); await letGo(); return (await r).status; };
assert.equal(await once("one"), 200);
assert.equal(await once("one"), 200);
const noTokens = await ask("thrifty-secret", "one");
assert.equal(noTokens.status, 429);
assert.match(await noTokens.text(), /20 tokens of one for today/);
assert.equal(await once("two"), 200, "one model's limit is not another's");

// A change frees a waiter at once, and a lane a key names cannot be taken away.
const patch = (ops: unknown[]) => fetch(`${heldUrl}/config`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer boss-secret" }, body: JSON.stringify({ ops }) });
const first = ask("single-secret", "one");
await open(1);
const second = ask("single-secret", "one");
await settle();
assert.equal(gates.length, 1);
const raised = await patch([{ path: ["apiKeys", 2, "limits", "maxConcurrent"], value: 2 }]);
assert.equal(raised.status, 200);
await open(2);
await letGo();
await Promise.all([first, second]);
const orphan = await patch([{ path: ["scheduler", "lanes", "batch"], delete: true }]);
assert.ok(orphan.status >= 400 && orphan.status < 500);
assert.match(await orphan.text(), /apiKeys\[\d\]\.lane of key .{0,2}bulk/, "the refusal names the key");

await heldNode.close();
slow.close();
console.log("key-limits.test.ts ok");
