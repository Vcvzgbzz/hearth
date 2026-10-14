/**
 * A backend with a key of its own, and one marked as a provider's. The failures worth catching:
 *
 *   - a call reaching the backend without its key, or with the caller's key for this node
 *   - a literal key in the file reaching the console
 *   - a backend's own headers left off a call, shown to the console, or standing in for its key
 *   - a cloud backend given hardware, a kind that reads warm state, or no list of models
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

// A provider: nothing is answered without its key, and it lists more models than this node offers.
const seen: { url: string; auth: string | undefined; unit: unknown; pass: unknown; model?: string; wantsUsage?: boolean }[] = [];
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const say = (status: number, o: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  const sent = (body ? JSON.parse(body) : {}) as { model?: string; stream?: boolean; stream_options?: { include_usage?: boolean } };
  seen.push({ url: req.url ?? "", auth: req.headers.authorization, unit: req.headers["x-unit"], pass: req.headers["x-pass"], ...(body ? { model: sent.model, wantsUsage: sent.stream_options?.include_usage === true } : {}) });
  if (req.headers.authorization !== "Bearer provider-secret") return say(401, { error: { message: "no key" } });
  if (req.url === "/v1/models") return say(200, { data: [{ id: "their-large" }, { id: "their-small" }, { id: "their-other" }] });
  if (req.url === "/v1/chat/completions" && sent.stream) {
    // As a provider streams: what it cost comes only when asked for, in an event of its own with no choices.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    ev({ choices: [{ index: 0, delta: { role: "assistant" } }] });
    for (const w of ["from ", "afar ", "é✓"]) ev({ choices: [{ index: 0, delta: { content: w } }] });
    ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    if (sent.stream_options?.include_usage) ev({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } });
    return res.end("data: [DONE]\n\n");
  }
  if (req.url === "/v1/chat/completions") return say(200, { choices: [{ message: { role: "assistant", content: "from afar" } }] });
  if (req.url === "/v1/embeddings") return say(200, { data: [{ embedding: [0.1] }] });
  say(404, {});
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const there = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

process.env.CLOUD_TEST_UNIT = "unit-7";
const file = (backend: string) => `name: node-under-test
backends:
  away:
${backend}
models:
  large: {backend: away, as: their-large}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: ours-secret, label: app}
`;
const good = `    url: ${there}
    cloud: true
    key: provider-secret
    headers: {X-Unit: "env:CLOUD_TEST_UNIT", x-pass: header-secret, Authorization: Bearer not-the-key}
    serves: [their-large, their-small]
    routes:
      - {path: /v1/embeddings, queue: false}`;

const refused = (backend: string, path: string) => assert.throws(() => parseConfig(parse(file(backend))), (e) => e instanceof ConfigError && e.path === path, path);
refused(`${good}\n    resources: [gpu0]`, "backends.away.resources");
refused(`${good}\n    kind: llama-swap`, "backends.away.kind");
refused(`    url: ${there}\n    cloud: true\n    key: provider-secret`, "backends.away.serves");
assert.throws(() => parseConfig(parse(`${file(good)}canary:\n  models: {large: {}}\n`)), (e) => e instanceof ConfigError && e.path === "canary.models.large", "nor probed");
assert.throws(() => parseConfig(parse(`${file(good)}canary:\n  backends: {away: {}}\n`)), (e) => e instanceof ConfigError && e.path === "canary.backends.away");
assert.throws(() => parseConfig(parse(`${file(good)}lending:\n  models: [large]\n`)), (e) => e instanceof ConfigError && e.path === "lending.models", "a provider's model is not lent");
const parsed = parseConfig(parse(file(good))).backends[0]!;
assert.deepEqual([parsed.cloud, parsed.kind, parsed.key], [true, "none", "provider-secret"], "a cloud backend reads no warm state unless told to");

const cfgPath = join(mkdtempSync(join(tmpdir(), "hearth-cloud-")), "hearth.yaml");
writeFileSync(cfgPath, file(good));
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const ours = { Authorization: "Bearer ours-secret", "Content-Type": "application/json" };

try {
  const chat = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: ours, body: JSON.stringify({ model: "large", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(chat.status, 200, await chat.clone().text());
  assert.equal(((await chat.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content, "from afar");
  const sent = seen.find((s) => s.url === "/v1/chat/completions")!;
  assert.deepEqual([sent.auth, sent.model], ["Bearer provider-secret", "their-large"], "chat goes out with the backend's key, under the provider's name for the model");

  const embed = await fetch(`${url}/v1/embeddings`, { method: "POST", headers: ours, body: JSON.stringify({ model: "their-small", input: "hi" }) });
  assert.equal(embed.status, 200, await embed.clone().text());
  assert.equal(seen.find((s) => s.url === "/v1/embeddings")!.auth, "Bearer provider-secret", "another path it answers carries the key too");

  assert.ok(seen.every((s) => s.auth === "Bearer provider-secret"), "nothing reaches it without its key, the catalogue read included");
  assert.ok(seen.some((s) => s.url === "/v1/models"));
  assert.ok(seen.every((s) => s.unit === "unit-7" && s.pass === "header-secret"), "its own headers ride on every call, one read from the environment, and none stands in for the key");

  // What the console is told: that it is a provider's, and never the key.
  const net = await (await fetch(`${url}/network`, { headers: ours })).text();
  const cfg = await (await fetch(`${url}/config`, { headers: ours })).text();
  assert.match(net, /"cloud":true/);
  for (const page of [net, cfg]) assert.ok(!page.includes("provider-secret") && !page.includes("header-secret"), "the key and a header's value stay out of what the console reads");
  assert.match(cfg, /hearth-secret/, "a literal key is shown as a stand-in");
  // A stream's cost is asked of the provider whoever is calling, and the report reaches only a caller who asked for it.
  const used = async () => ((await (await fetch(`${url}/usage?days=1`, { headers: ours })).json()) as { usage: Record<string, Record<string, Record<string, { in: number; out: number }>>> }).usage;
  const large = async () => Object.values(await used())[0]!["key:app"]!["large"]!;
  const stream = async (more: Record<string, unknown> = {}) => {
    const r = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: ours, body: JSON.stringify({ model: "large", stream: true, messages: [{ role: "user", content: "hi" }], ...more }) });
    return r.text();
  };
  const before = await large();
  const plain = await stream();
  assert.equal(seen.at(-1)!.wantsUsage, true, "the provider is asked for the count");
  assert.ok(!/"choices":\[\]/.test(plain), "a caller who did not ask is not sent the report");
  assert.equal(plain.match(/^data:/gm)!.length, 6, "every other event arrives");
  assert.ok(plain.includes("é✓") && plain.endsWith("data: [DONE]\n\n"));
  await new Promise((r) => setTimeout(r, 50));
  const after = await large();
  assert.deepEqual([after.in - before.in, after.out - before.out], [21, 9], "counted from the provider's own numbers, not estimated");
  const asked = await stream({ stream_options: { include_usage: true } });
  assert.match(asked, /"choices":\[\],"usage"/, "a caller who asked gets it as the provider sent it");

  // Nor from the page: a peer's requests would be paid for with this node's key.
  const lend = await fetch(`${url}/control`, { method: "POST", headers: ours, body: JSON.stringify({ share: { large: true } }) });
  assert.equal(lend.status, 400);
  assert.match(await lend.text(), /cloud backend/);

  // A url copied with its /v1 is the same server.
  assert.equal(parseConfig(parse(file(good.replace(there, `${there}/v1/`)))).backends[0]!.url, there);

  // Asked before it is a backend: what it serves with this key, or why nothing came back.
  const probe = async (body: unknown) => (await (await fetch(`${url}/backends/probe`, { method: "POST", headers: ours, body: JSON.stringify(body) })).json()) as { ok: boolean; models?: string[]; problem?: string };
  assert.deepEqual(await probe({ url: `${there}/v1`, key: "provider-secret" }), { ok: true, url: there, models: ["their-large", "their-other", "their-small"] });
  assert.equal((await probe({ url: there, key: "wrong" })).problem, "key refused");
  assert.equal((await probe({ url: there })).problem, "key refused");
  assert.equal((await probe({ url: "http://127.0.0.1:1" })).problem, "not reachable");
  assert.equal((await fetch(`${url}/backends/probe`, { method: "POST", headers: ours, body: JSON.stringify({ url: "nowhere" }) })).status, 400);

  // With a key the provider refuses, the caller is told whose key it was, and the page what is wrong.
  const badPath = join(mkdtempSync(join(tmpdir(), "hearth-cloud-")), "hearth.yaml");
  writeFileSync(badPath, file(good.replace("key: provider-secret", "key: stale-secret")));
  const stale = createNode(loadConfig(badPath), silentLogger);
  stale.start();
  await new Promise<void>((r) => stale.server.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(stale.server.address() as AddressInfo).port}`;
  try {
    const no = await fetch(`${at}/v1/chat/completions`, { method: "POST", headers: ours, body: JSON.stringify({ model: "large", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(no.status, 502, "not the provider's 401, which would read as this node refusing the caller");
    assert.match(await no.text(), /refused the key this node sends it/);
    const emb = await fetch(`${at}/v1/embeddings`, { method: "POST", headers: ours, body: JSON.stringify({ model: "their-small", input: "hi" }) });
    assert.equal(emb.status, 502);
    assert.match(await (await fetch(`${at}/network`, { headers: ours })).text(), /"trouble":"key refused"/);
  } finally {
    await stale.close();
  }
  assert.ok(!net.includes('"trouble"'), "a provider that answers has none");
  console.log("cloud.test.ts ok");
} finally {
  await node.close();
  provider.close();
}
