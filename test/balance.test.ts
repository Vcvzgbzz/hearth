/**
 * One name spread over two local backends by a flow's `fastest`. The failures worth catching:
 *
 *   - every request going to the first backend while the second sits idle
 *   - the backend being sent the flow's name instead of its own
 *   - a backend that fails taking the request down with it while the other could run it
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

/** A backend that holds each chat until it is let go, and remembers what it was asked for. */
function fake(broken = false) {
  const asked: string[] = [];
  const waiting: (() => void)[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      const say = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url === "/v1/models") return say(200, { data: [{ id: "the-weights" }] });
      if (req.url !== "/v1/chat/completions") return say(404, {});
      asked.push(String((JSON.parse(raw) as { model?: unknown }).model));
      if (broken) return say(500, { error: "out of memory" });
      waiting.push(() => say(200, { choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  return { asked, waiting, server, url: async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; } };
}

async function nodeOver(a: ReturnType<typeof fake>, b: ReturnType<typeof fake>) {
  const node = createNode(parseConfig({
    name: "node-under-test",
    backends: {
      gpu0: { url: await a.url(), kind: "none", concurrency: 1, serves: ["chat-0"] },
      gpu1: { url: await b.url(), kind: "none", concurrency: 1, serves: ["chat-1"] },
    },
    // Both backends know the weights by the one name; here each is a place of its own.
    models: { "chat-0": { backend: "gpu0", as: "the-weights" }, "chat-1": { backend: "gpu1", as: "the-weights" } },
    flows: {
      chat: { inputs: ["chat"], steps: [{ to: { fastest: ["chat-0", "chat-1"] } }] },
      rest: { inputs: ["*"], steps: [{ to: { refuse: "ask for chat" } }] },
    },
  }), silentLogger);
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const chat = () => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "hi" }] }) });
  return { node, chat };
}
const until = async (ok: () => boolean) => { for (let i = 0; !ok() && i < 200; i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(ok(), "timed out waiting"); };

// Two at once: one each.
{
  const [a, b] = [fake(), fake()];
  const { node, chat } = await nodeOver(a, b);
  const first = chat();
  await until(() => a.waiting.length === 1);
  const second = chat();
  await until(() => b.waiting.length === 1);
  assert.deepEqual([a.asked, b.asked], [["the-weights"], ["the-weights"]], "the busy one is passed over, and each is asked by its own name");
  a.waiting[0]!(); b.waiting[0]!();
  assert.deepEqual([(await first).status, (await second).status], [200, 200]);
  // With both idle again, a tie stays with the one listed first.
  const third = chat();
  await until(() => a.waiting.length === 2);
  a.waiting[1]!();
  assert.equal((await third).status, 200);
  assert.equal(b.asked.length, 1);
  await node.close(); a.server.close(); b.server.close();
}

// One broken: the next line runs it on the other.
{
  const [a, b] = [fake(true), fake()];
  const { node, chat } = await nodeOver(a, b);
  const r = chat();
  await until(() => b.waiting.length === 1);
  b.waiting[0]!();
  assert.equal((await r).status, 200, "a backend's failure is not the request's while another line can run it");
  assert.equal(a.asked.length, 1);
  await node.close(); a.server.close(); b.server.close();
}

console.log("balance.test.ts ok");
