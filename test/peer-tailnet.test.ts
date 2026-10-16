/**
 * `peers.<name>.tailnet`: a peer's token is honoured only from the machine it is bound to, as the
 * local tailscaled names the caller. A stand-in tailscaled answers whois on a socket. Asserted:
 * the bound machine gets in, any other machine and an off-tailnet address get 403 even with the
 * right token, a tailscaled that cannot be asked fails closed, and a peer without `tailnet` keeps
 * the token-only door it always had.
 *
 *     npx tsx test/peer-tailnet.test.ts
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
import { tailscaleWhois } from "../src/tailscale.js";

const socket = process.platform === "win32"
  ? `\\\\.\\pipe\\hearth-tailnet-test-${process.pid}`
  : join(tmpdir(), `hearth-tailnet-test-${process.pid}.sock`);

// What the stand-in says is at every address: a node id, null for "not on the tailnet", or "fail".
let answer: string | null | "fail" = "n-friend";
const asked: string[] = [];
const tailscaled = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local-tailscaled.sock");
  asked.push(`${req.headers.host} ${url.pathname} ${url.searchParams.get("addr")}`);
  if (answer === "fail") {
    res.writeHead(500);
    return res.end("broken");
  }
  if (answer === null) {
    res.writeHead(404);
    return res.end("no match for IP:port");
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ Node: { StableID: answer, Name: `${answer}.example.ts.net.` }, UserProfile: { LoginName: "someone@example" } }));
});
await new Promise<void>((r) => tailscaled.listen(socket, r));

// --- the helper on its own ---------------------------------------------------
{
  const who = tailscaleWhois(socket);
  answer = "n-friend";
  assert.deepEqual(await who("100.64.0.1", 41641), { id: "n-friend", name: "n-friend.example.ts.net", login: "someone@example" });
  assert.equal(asked.at(-1), "local-tailscaled.sock /localapi/v0/whois 100.64.0.1:41641", "asks with ip:port and the Host tailscaled expects");
  await who("::ffff:100.64.0.2", 1);
  assert.equal(asked.at(-1)?.split(" ").at(-1), "100.64.0.2:1", "an IPv4-mapped address is asked as IPv4");
  await who("fd7a::1", 2);
  assert.equal(asked.at(-1)?.split(" ").at(-1), "[fd7a::1]:2", "IPv6 is bracketed");
  answer = null;
  assert.equal(await who("192.0.2.1", 3), null, "off the tailnet is null, not an error");
  answer = "fail";
  await assert.rejects(who("100.64.0.1", 4), /500/, "a broken answer is an error, never a guess");
  await assert.rejects(tailscaleWhois(socket + "-missing")("100.64.0.1", 5), "no tailscaled is an error");
}

// --- config ---------------------------------------------------------------------
const base = {
  name: "lender",
  backends: { gpu: { url: "http://127.0.0.1:9", kind: "none", serves: ["my-model"] } },
  flows: { "anything-else": { inputs: ["*"], steps: [{ to: { asked: true } }] } },
};
assert.throws(() => parseConfig({ ...base, peers: { friend: { url: "http://127.0.0.1:9", tailnet: "n-friend" } } }), ConfigError, "tailnet without accept binds nothing");
assert.deepEqual(parseConfig({ ...base, peers: { friend: { accept: "t", tailnet: "" } } }).peerTailnet, {}, "an empty tailnet is unset, as a new setting starts");
assert.equal(parseConfig(base).tailscaleSocket, "/var/run/tailscale/tailscaled.sock", "the Linux default when unset");

// --- the gate -------------------------------------------------------------------
const node = createNode(
  parseConfig({
    ...base,
    tailscaleSocket: socket,
    peers: {
      friend: { accept: "friend-token", tailnet: "n-friend" },
      other: { accept: "other-token" },
    },
  }),
  silentLogger,
);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const hello = async (token: string) => (await fetch(`${url}/peer/hello`, { headers: { Authorization: `Bearer ${token}` } })).status;

answer = "n-friend";
assert.equal(await hello("friend-token"), 200, "the bound machine with its token gets in");
answer = "n-somewhere-else";
assert.equal(await hello("friend-token"), 403, "the right token from another machine does not");
answer = null;
assert.equal(await hello("friend-token"), 403, "nor from an address off the tailnet");
answer = "fail";
assert.equal(await hello("friend-token"), 403, "a tailscaled that cannot answer fails closed");
const before = asked.length;
assert.equal(await hello("other-token"), 200, "a peer without tailnet keeps the token-only door");
assert.equal(asked.length, before, "and tailscaled is never asked about it");
assert.equal(await hello("wrong"), 401, "an unknown token is still a 401, before any machine check");
const chat = await fetch(`${url}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: "Bearer friend-token", "content-type": "application/json" },
  body: JSON.stringify({ model: "my-model", messages: [] }),
});
assert.equal(chat.status, 403, "the check covers work a peer sends, not only the peer protocol");

// --- the machine a peer calls from, for the console to offer a binding ----------
{
  type Machine = { peer: string; bound: string | null; seen: { ip: string; node: { id: string; name: string } | null; error?: string } | null };
  const machine = async (peer: string) => {
    const r = await fetch(`${url}/peers/machine?peer=${peer}`);
    return { status: r.status, body: (await r.json()) as Machine };
  };
  assert.equal((await machine("stranger")).status, 404, "only a peer that borrows from this node");
  answer = "n-other";
  assert.equal(await hello("other-token"), 200);
  const other = (await machine("other")).body;
  assert.equal(other.bound, null, "not bound yet");
  assert.equal(other.seen?.ip, "127.0.0.1", "the address it last called from");
  assert.equal(other.seen?.node?.id, "n-other", "and the machine tailscaled says that is");
  assert.equal((await machine("friend")).body.bound, "n-friend", "a bound peer says what it is bound to");
  answer = "fail";
  assert.match((await machine("other")).body.seen?.error ?? "", /500/, "a tailscaled that cannot answer is said, not guessed");
  answer = "n-friend";
}

await node.close();

// --- a peer added by a live edit is bound from its first request -----------------
// The token applies without a restart, so the binding must too, or the new peer gets in from anywhere.
{
  const path = join(mkdtempSync(join(tmpdir(), "hearth-tailnet-")), "hearth.yaml");
  const yaml = `name: lender
tailscaleSocket: ${JSON.stringify(socket)}
backends:
  gpu: {url: "http://127.0.0.1:9", kind: none, serves: [my-model]}
flows:
  anything-else: {inputs: ["*"], steps: [{to: {asked: true}}]}
peers:
  other: {accept: other-token}
`;
  writeFileSync(path, yaml);
  const live = createNode(loadConfig(path), silentLogger);
  await new Promise<void>((r) => live.server.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(live.server.address() as AddressInfo).port}`;
  const edit = await fetch(`${at}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `${yaml}  friend: {accept: friend-token, tailnet: n-friend}\n` }),
  });
  assert.deepEqual(((await edit.json()) as { restartPending: string[] }).restartPending, [], "the binding needs no restart");
  answer = "n-somewhere-else";
  assert.equal((await fetch(`${at}/peer/hello`, { headers: { Authorization: "Bearer friend-token" } })).status, 403, "a peer added live is checked from its first request");
  answer = "n-friend";
  assert.equal((await fetch(`${at}/peer/hello`, { headers: { Authorization: "Bearer friend-token" } })).status, 200);
  await live.close();
}
tailscaled.close();
console.log("peer-tailnet.test.ts ok");
