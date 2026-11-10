/**
 * Peers apply without a restart. An edit to `peers:` through PATCH /config adds a peer, points
 * one at another address, changes its token, or removes it, and the running node follows at
 * once: restartPending stays empty, the next probe goes where the file now says with the token
 * it now holds, and a removed peer is forgotten. Two stand-in peers answer /peer/state and log
 * who asked them, with what.
 *
 *     npx tsx test/peers-live.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { PeerRegistry } from "../src/peers/peers.js";
import { createNode } from "../src/server.js";

type Status = { hash: string; restartPending: string[] };

/** A stand-in peer: answers capacity and hello, and remembers each token it was shown. */
async function standIn(): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization ?? ""}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/peer/state") return res.end(JSON.stringify({ free: 1, slots: 1, queued: {}, serves: ["their-model"], loaded: [] }));
    if (req.url === "/peer/hello") return res.end(JSON.stringify({ protocol: 2, models: ["their-model"], capabilities: [] }));
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const a = await standIn();
const b = await standIn();
const backend = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "my-model" }] } : {}));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const beUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const dir = mkdtempSync(join(tmpdir(), "hearth-peers-live-"));
const cfgPath = join(dir, "hearth.yaml");
writeFileSync(cfgPath, `name: borrower
backends:
  gpu: { url: "${beUrl}", kind: none, serves: [my-model] }
flows:
  anything-else:
    inputs: ["*"]
    steps:
      - to: { asked: true }
`);

const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

let hash = ((await (await fetch(`${url}/config`)).json()) as Status).hash;
async function patch(ops: unknown[]): Promise<Status> {
  const r = await fetch(`${url}/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseHash: hash, ops }) });
  assert.equal(r.status, 200, await r.clone().text());
  const out = (await r.json()) as Status;
  hash = out.hash;
  return out;
}
/** /network asks every peer now; /healthz then says how many there are and how many are up. */
async function peersNow(): Promise<{ total: number; up: number }> {
  await fetch(`${url}/network`);
  return ((await (await fetch(`${url}/healthz`)).json()) as { peers: { total: number; up: number } }).peers;
}
const asked = (s: { seen: string[] }, token: string) => s.seen.some((x) => x === `/peer/state Bearer ${token}`);

assert.deepEqual(await peersNow(), { total: 0, up: 0 }, "no peers to begin with");

// Added: no restart, and probed at its address with its token.
let out = await patch([{ path: ["peers", "friend"], value: { url: a.url, token: "token-one", models: { "big-model": "their-model" } } }]);
assert.deepEqual(out.restartPending, [], "adding a peer needs no restart");
assert.deepEqual(await peersNow(), { total: 1, up: 1 }, "the new peer is known and up");
assert.ok(asked(a, "token-one"), "it was asked at its url with its token");

// Pointed elsewhere: the new address is asked, and it starts from nothing rather than inheriting.
out = await patch([{ path: ["peers", "friend", "url"], value: b.url }]);
assert.deepEqual(out.restartPending, [], "moving a peer needs no restart");
assert.deepEqual(await peersNow(), { total: 1, up: 1 });
assert.ok(asked(b, "token-one"), "the new url is asked");

// A new token is the one presented from then on.
out = await patch([{ path: ["peers", "friend", "token"], value: "token-two" }]);
assert.deepEqual(out.restartPending, [], "a new token needs no restart");
await peersNow();
assert.ok(asked(b, "token-two"), "the new token is presented");

// Removed: forgotten.
const beforeA = a.seen.length;
const beforeB = b.seen.length;
out = await patch([{ path: ["peers", "friend"], delete: true }]);
assert.deepEqual(out.restartPending, [], "removing a peer needs no restart");
assert.deepEqual(await peersNow(), { total: 0, up: 0 }, "a removed peer is gone");
assert.equal(a.seen.length + b.seen.length, beforeA + beforeB, "and nobody is asked about it");

await node.close();
for (const s of [a.server, b.server, backend]) s.close();

// --- the registry on its own: a probe hung on the old address does not hold up the new one -----
{
  let release: () => void = () => {};
  const hung = createServer((_req, res) => {
    void new Promise<void>((r) => (release = r)).then(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ free: 9, slots: 9, queued: {}, serves: [], loaded: [] }));
    });
  });
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
  const fresh = await standIn();
  const cfg = loadConfig(cfgPath);
  cfg.peers = [{ name: "friend", url: `http://127.0.0.1:${(hung.address() as AddressInfo).port}`, token: "t", models: {} }];
  const reg = new PeerRegistry(cfg, silentLogger);
  const old = reg.probeAll();
  await new Promise((r) => setTimeout(r, 100));
  cfg.peers = [{ name: "friend", url: fresh.url, token: "t", models: {} }];
  reg.sync();
  await reg.probeAll();
  assert.equal(reg.get("friend")?.capacity?.free, 1, "the new address is asked at once, not after the old probe gives up");
  release();
  await old;
  assert.equal(reg.get("friend")?.capacity?.free, 1, "and the old answer, arriving late, changes nothing");
  reg.stop();
  hung.closeAllConnections();
  hung.close();
  fresh.server.close();
}

// --- a rate-limit is about one address: removing the peer, or moving it, forgets it -------------
{
  const cfg = loadConfig(cfgPath);
  cfg.peers = [{ name: "friend", url: "http://127.0.0.1:1", token: "t", models: {} }];
  const reg = new PeerRegistry(cfg, silentLogger);
  reg.rateCapped("friend", "theirs");
  assert.ok(reg.cappedFor("friend", "theirs") > 0, "capped after a 429");
  cfg.peers = [];
  reg.sync();
  cfg.peers = [{ name: "friend", url: "http://127.0.0.1:1", token: "t", models: {} }];
  reg.sync();
  assert.equal(reg.cappedFor("friend", "theirs"), 0, "a removed and re-added peer starts uncapped");
  reg.rateCapped("friend", "theirs");
  cfg.peers = [{ name: "friend", url: "http://127.0.0.1:2", token: "t", models: {} }];
  reg.sync();
  assert.equal(reg.cappedFor("friend", "theirs"), 0, "so does one at a new address");
  reg.stop();
}

console.log("peers-live.test.ts ok");
