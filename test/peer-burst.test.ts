/**
 * Two requests in quick succession, `fastest` over two peers that each report one free slot. A
 * reading is reused for freshMs, so without counting what was just sent, both would see the
 * first peer free and land there while the second sits idle.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

/** A peer with one free slot that holds each chat until it is let go. */
function friend() {
  const waiting: (() => void)[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/peer/state" || req.url === "/peer/hello") {
        return void res.end(JSON.stringify({ free: 1, slots: 1, queued: {}, resident: null, loaded: ["theirs"], serves: ["theirs"], models: { theirs: { free: 1, slots: 1, queued: 0, warm: true } } }));
      }
      waiting.push(() => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] })));
    });
  });
  return { waiting, server };
}
const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
const until = async (ok: () => boolean) => { for (let i = 0; !ok() && i < 200; i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(ok(), "timed out waiting"); };

const [a, b] = [friend(), friend()];
const node = createNode(parseConfig({
  name: "borrower",
  backends: { card: { url: "http://127.0.0.1:1", kind: "none", serves: ["here"] } },
  peers: {
    a: { url: await listen(a.server), token: "t", models: { chat: "theirs" } },
    b: { url: await listen(b.server), token: "t", models: { chat: "theirs" } },
  },
  flows: { chat: { inputs: ["chat"], steps: [{ to: { fastest: [{ peer: "a" }, { peer: "b" }] } }, { to: { refuse: "no peer" } }] } },
}), silentLogger);
const url = await listen(node.server);
const chat = () => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "hi" }] }) });

const first = chat();
await until(() => a.waiting.length === 1);
const second = chat();
await until(() => a.waiting.length + b.waiting.length === 2);
assert.deepEqual([a.waiting.length, b.waiting.length], [1, 1], "the second goes to the peer that is still free");
a.waiting[0]!(); b.waiting[0]!();
assert.deepEqual([(await first).status, (await second).status], [200, 200]);

await node.close();
a.server.close(); b.server.close();
console.log("peer-burst.test.ts ok");
