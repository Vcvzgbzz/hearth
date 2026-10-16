/**
 * The recent requests the console's rail draws: what this node asked for and where it ran,
 * newest first, a bounded number of them, on the page's data.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

const backend = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method !== "POST") return void res.end(JSON.stringify({ data: [{ id: "my-model" }, { id: "chat" }] }));
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const node = createNode(parseV1({ backend: { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, serves: ["my-model", "chat"] } }), silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const chat = (model: string) => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) }).then((r) => r.text());
type Recent = { model: string; caller: string; backend?: string; peer?: string; ok: boolean; t: number; ms: number };
const recent = async () => ((await (await fetch(`${url}/ui/data`)).json()) as { recent: Recent[] }).recent;

assert.deepEqual(await recent(), [], "nothing asked, nothing listed");
await chat("my-model");
await chat("chat");
const two = await recent();
assert.deepEqual(two.map((r) => r.model), ["chat", "my-model"], "newest first");
assert.equal(two[0]!.caller, "local", "this machine with no key is the local caller");
assert.ok(two[0]!.backend && two[0]!.peer === undefined, "it ran on a backend here");
assert.equal(two[0]!.ok, true);

for (let i = 0; i < 12; i++) await chat("my-model");
assert.equal((await recent()).length, 12, "a bounded number are kept");

// An open page hears about a new request: the stream sends it as a change, not only a fresh load.
{
  const ctrl = new AbortController();
  const res = await fetch(`${url}/ui/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let held = "";
  const frame = async (want: (event: string, data: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    const until = Date.now() + 8000;
    for (;;) {
      for (let end = held.indexOf("\n\n"); end >= 0; end = held.indexOf("\n\n")) {
        const block = held.slice(0, end);
        held = held.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data && want(event, JSON.parse(data) as Record<string, unknown>)) return JSON.parse(data) as Record<string, unknown>;
      }
      assert.ok(Date.now() < until, "timed out waiting for the frame");
      const { value, done } = await reader.read();
      assert.ok(!done, "the stream ended");
      held += decoder.decode(value, { stream: true });
    }
  };
  await frame((e) => e === "snapshot");
  await chat("chat");
  const patch = await frame((e, d) => e === "patch" && "recent" in ((d.set as Record<string, unknown> | undefined) ?? {}));
  assert.equal(((patch.set as { recent: Recent[] }).recent)[0]!.model, "chat", "the new request is pushed to the open page");
  ctrl.abort();
}

await node.close();
backend.close();
console.log("recent.test.ts ok");
