/**
 * Joining by invite code. Two real nodes, each with its own hearth.yaml: the lender mints a code,
 * the borrower redeems it, and each file gains the other as a peer with one fresh token between
 * them, live, with no secret ever typed by a person. Asserted: the borrower can then read the
 * lender's state with that token; a code works once; a wrong secret, a taken name and malformed
 * input are refused without writing anything; and two nodes already linked either way, under any
 * names, join the entries they have instead of adding a second one for the same friend.
 *
 *     npx tsx test/invite.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

const backend = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "my-model" }] } : {}));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const beUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const dir = mkdtempSync(join(tmpdir(), "hearth-invite-"));
async function boot(name: string, extra = "") {
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, `name: ${name}
backends:
  gpu: { url: "${beUrl}", kind: none, serves: [my-model] }
flows:
  anything-else:
    inputs: ["*"]
    steps:
      - to: { asked: true }
${extra}`);
  const node = createNode(loadConfig(path), silentLogger);
  node.start();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const post = async (route: string, body: unknown) => {
    const r = await fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { node, url, path, post };
}

const lender = await boot("lender", "lending:\n  models: [my-model]\n");
const borrower = await boot("borrower");
const secretOf = (code: string) => (JSON.parse(Buffer.from(code.slice("hearth-invite:".length), "base64url").toString()) as { s: string }).s;

// Minting.
assert.equal((await lender.post("/peers/invite", { url: "not a url" })).status, 400, "an invite needs an address to reach the lender at");
const minted = await lender.post("/peers/invite", { url: lender.url + "/" });
assert.equal(minted.status, 200);
const code = minted.body.code as string;
assert.match(code, /^hearth-invite:[A-Za-z0-9_-]+$/, "a code is one pasteable token");
assert.ok(Date.parse(minted.body.expiresAt as string) > Date.now(), "and says when it stops working");

// Redeeming.
assert.equal((await borrower.post("/peers/join", { code: "hello" })).status, 400, "a code that is not one is refused before anything is sent");
const joined = await borrower.post("/peers/join", { code });
assert.equal(joined.status, 200, JSON.stringify(joined.body));
assert.deepEqual(joined.body, { peer: "lender", url: lender.url }, "the lender is added under its own name, at the address in the code");

// Both files, one token between them.
const onLender = loadConfig(lender.path);
const onBorrower = loadConfig(borrower.path);
const token = onLender.peerTokens.borrower;
assert.match(token ?? "", /^hpeer_[0-9a-f]{48}$/, "the lender accepts the borrower with a fresh token");
assert.deepEqual(onBorrower.peers.map((p) => [p.name, p.url, p.token]), [["lender", lender.url, token]], "and the borrower presents that same token");
assert.deepEqual(onLender.peers, [], "the lender borrows nothing back: an invite lends one way");
assert.ok(!readFileSync(borrower.path, "utf8").includes(secretOf(code)), "the invite secret is never written down");

// Live on both sides: the borrower reads the lender's state with the new token, no restart.
await fetch(`${borrower.url}/network`);
const health = (await (await fetch(`${borrower.url}/healthz`)).json()) as { peers: { total: number; up: number } };
assert.deepEqual(health.peers, { total: 1, up: 1 }, "the borrower sees the lender up straight away");

// Spent.
const again = await lender.post("/peer/join", { secret: secretOf(code), name: "someone-else" });
assert.equal(again.status, 403, "a code works once");
assert.equal((await lender.post("/peer/join", { secret: "guess", name: "x" })).status, 403, "a wrong secret gets nothing");
assert.deepEqual(Object.keys(loadConfig(lender.path).peerTokens), ["borrower"], "and neither wrote a peer");

// A name the lender already has is refused, and the code is not spent on it.
const second = (await lender.post("/peers/invite", { url: lender.url })).body.code as string;
assert.equal((await lender.post("/peer/join", { secret: secretOf(second), name: "borrower" })).status, 409, "a taken name is refused");
assert.equal((await lender.post("/peer/join", { secret: secretOf(second), name: "bad name!" })).status, 400, "so is a name that cannot be a peer's");
assert.equal((await lender.post("/peer/join", { secret: secretOf(second), name: "third" })).status, 200, "and the code still works for a good one");

// A name this node borrows from at another address is another node: refused before the code is spent.
const stranger = await boot("stranger", 'peers:\n  lender: { url: "http://127.0.0.1:9", token: not-the-lender }\n');
const third = (await lender.post("/peers/invite", { url: lender.url })).body.code as string;
assert.equal((await stranger.post("/peers/join", { code: third, as: "lender" })).status, 409, "joining as a name already in use is refused");
assert.equal((await stranger.post("/peers/join", { code: third })).status, 409, "and without as, the inviter's own name is checked the same way");
assert.equal((await lender.post("/peer/join", { secret: secretOf(third), name: "fourth" })).status, 200, "before the lender is ever asked, so its code is unspent");
assert.deepEqual(loadConfig(stranger.path).peers.map((p) => [p.name, p.token]), [["lender", "not-the-lender"]], "the peer it has is untouched");
await stranger.node.close();

// Joining a node it is already linked with adds nothing on either side, whatever name is asked for.
const lending = Object.keys(loadConfig(lender.path).peerTokens);
const fifth = (await lender.post("/peers/invite", { url: lender.url })).body.code as string;
const rejoin = await borrower.post("/peers/join", { code: fifth, as: "another-name" });
assert.equal(rejoin.status, 200, JSON.stringify(rejoin.body));
assert.equal(rejoin.body.peer, "lender", "the entry at the code's address is the inviter");
assert.deepEqual(Object.keys(loadConfig(lender.path).peerTokens), lending, "the lender finds its entry for the borrower instead of adding one");
assert.equal(loadConfig(lender.path).peerTokens.borrower, token, "and keeps the token it accepts");
assert.deepEqual(loadConfig(borrower.path).peers.map((p) => [p.name, p.url, p.token]), [["lender", lender.url, token]], "the borrower still has one entry for it");

// The other way round: each node already has an entry for the other, and that one entry gains the reverse direction.
const back = (await borrower.post("/peers/invite", { url: borrower.url })).body.code as string;
const reverse = await lender.post("/peers/join", { code: back });
assert.equal(reverse.status, 200, JSON.stringify(reverse.body));
assert.equal(reverse.body.peer, "borrower");
{
  const onL = loadConfig(lender.path);
  const onB = loadConfig(borrower.path);
  assert.equal(onL.peerTokens.borrower, token, "the lender still lends to the borrower with its token");
  assert.deepEqual(onL.peers.map((p) => [p.name, p.url, p.token]), [["borrower", borrower.url, onB.peerTokens.lender]], "and now borrows from it in the same entry");
  assert.match(onB.peerTokens.lender ?? "", /^hpeer_[0-9a-f]{48}$/, "with a fresh token the borrower accepts");
  assert.deepEqual(Object.keys(onB.peerTokens), ["lender"], "in its entry for the lender, not a new one");
  assert.deepEqual(onB.peers.map((p) => [p.name, p.token]), [["lender", token]], "which still borrows as before");
}

// The same with a name of its own for the inviter: the entry it already has is still the one that gains it.
{
  const a = await boot("alpha");
  const b = await boot("beta");
  assert.equal((await b.post("/peers/join", { code: (await a.post("/peers/invite", { url: a.url })).body.code })).status, 200);
  const named = await a.post("/peers/join", { code: (await b.post("/peers/invite", { url: b.url })).body.code, as: "my-friend" });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(named.body.peer, "beta", "the inviter recognised the joiner, so its entry here is the one it joins");
  const onA = loadConfig(a.path);
  const onB = loadConfig(b.path);
  assert.deepEqual(Object.keys(onA.peerTokens), ["beta"]);
  assert.deepEqual(onA.peers.map((p) => [p.name, p.token]), [["beta", onB.peerTokens.alpha]], "one entry on each side, linked both ways");
  assert.deepEqual(Object.keys(onB.peerTokens), ["alpha"]);
  assert.deepEqual(onB.peers.map((p) => [p.name, p.token]), [["alpha", onA.peerTokens.beta]]);
  await a.node.close();
  await b.node.close();
}

// A proof made for one code is worth nothing with another.
{
  const sixth = (await lender.post("/peers/invite", { url: lender.url })).body.code as string;
  const stale = createHmac("sha256", "some-other-secret").update(`join:${token ?? ""}`).digest("hex");
  const replay = await lender.post("/peer/join", { secret: secretOf(sixth), name: "borrower", knows: [stale] });
  assert.equal(replay.status, 409, "a proof keyed with another secret is not recognised");
}

// A node that already lends to the inviter keeps that, and gains the way to borrow back.
const friend = await boot("friend", "peers:\n  lender: { accept: friend-lends-to-lender }\n");
const seventh = (await lender.post("/peers/invite", { url: lender.url })).body.code as string;
assert.equal((await friend.post("/peers/join", { code: seventh })).status, 200);
const onFriend = loadConfig(friend.path);
assert.equal(onFriend.peerTokens.lender, "friend-lends-to-lender", "what it lends the inviter stays as it was");
assert.deepEqual(onFriend.peers.map((p) => [p.name, p.url, p.token]), [["lender", lender.url, loadConfig(lender.path).peerTokens.friend]], "and the same entry now borrows from it");
await friend.node.close();

// An inviter that passes back a proof it was shown, holding none of the tokens, moves no entry here.
{
  let shown: string[] = [];
  const echo = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/healthz") return void res.end(JSON.stringify({ ok: true, name: "echo" }));
      shown = ((JSON.parse(raw || "{}") as { knows?: string[] }).knows) ?? [];
      res.end(JSON.stringify({ name: "echo", token: "hpeer_from-echo", knew: shown.at(-1) }));
    });
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  const victim = await boot("victim", "peers:\n  trusted: { url: \"http://127.0.0.1:9\", token: real-token, accept: trusted-accept }\n");
  const code = "hearth-invite:" + Buffer.from(JSON.stringify({ u: echoUrl, s: "a-secret" })).toString("base64url");
  assert.equal((await victim.post("/peers/join", { code })).status, 200);
  assert.ok(shown.length > 0, "the joiner offered its proofs");
  const onVictim = loadConfig(victim.path);
  assert.deepEqual(onVictim.peers.find((p) => p.name === "trusted")?.url, "http://127.0.0.1:9", "an echoed proof does not move another peer to the inviter");
  assert.equal(onVictim.peers.find((p) => p.url === echoUrl)?.name, "echo", "the inviter is added as a new peer instead");
  await victim.node.close();
  echo.close();
}

await lender.node.close();
await borrower.node.close();
backend.close();
console.log("invite.test.ts ok");
