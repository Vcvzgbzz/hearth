/**
 * A peer that rate-limits a request (429) is left alone for that model for a while: the requests
 * after it go straight to the fallback instead of each being refused by the peer first.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

// The peer: healthy to poll, but every chat is over its rate cap.
let peerChats = 0;
const peer = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url === "/peer/state" || req.url === "/peer/hello") return json(res, 200, { free: 4, slots: 4, queued: {}, resident: null, loaded: ["theirs"], serves: ["theirs"], models: { theirs: { free: 4, slots: 4, queued: 0, warm: true } } });
    peerChats++;
    json(res, 429, { error: { message: "rate capped for theirs", type: "rate_limit_error" } });
  });
});
// The fallback here answers everything.
let localChats = 0;
const local = createServer((req, res) => {
  req.resume();
  req.on("end", () => { localChats++; json(res, 200, { choices: [{ message: { role: "assistant", content: "ok" } }] }); });
});

const node = createNode(parseConfig({
  name: "borrower",
  backends: { card: { url: await listen(local), kind: "single", serves: ["here"] } },
  peers: { far: { url: await listen(peer), token: "t", models: { chat: "theirs" } } },
  flows: { chat: { inputs: ["chat"], steps: [{ to: { peer: "far" } }, { to: "here" }] } },
}), silentLogger);
const url = await listen(node.server);
const chat = () => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "hi" }] }) });

try {
  // Until the first reading, a peer is not a candidate; wait for it.
  for (let i = 0; i < 100 && peerChats === 0; i++) { assert.equal((await chat()).status, 200); if (peerChats === 0) await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(peerChats, 1, "the peer was tried once and refused it");
  const localBefore = localChats;
  for (let i = 0; i < 3; i++) assert.equal((await chat()).status, 200, "and the fallback answers");
  assert.equal(peerChats, 1, "while it is rate-limiting that model, it is not asked again");
  assert.equal(localChats, localBefore + 3, "everything goes straight to the fallback");
  console.log("peer-request-cap.test.ts ok");
} finally {
  await node.close();
  peer.close(); local.close();
}
