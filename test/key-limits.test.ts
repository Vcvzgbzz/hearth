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

import { loadConfig, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
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
console.log("key-limits.test.ts ok");
