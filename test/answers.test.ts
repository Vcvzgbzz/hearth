/**
 * Answers kept for a model that says so. The failures worth catching:
 *
 *   - an identical request run twice, or a different one given another's answer
 *   - a failure, or a stream cut short, kept and handed out
 *   - an answer outliving its time
 *   - a model that did not ask for it being answered from memory
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Answers } from "../src/answers.js";
import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

// Its time.
let now = 1000;
const kept = new Answers(() => now);
assert.notEqual(kept.key("chat", { a: 1 }), kept.key("chat", { a: 2 }));
assert.notEqual(kept.key("chat", { a: 1 }), kept.key("voice", { a: 1 }));
assert.equal(kept.get(kept.key("chat", { a: 1 })), null);

// Through a node.
let runs = 0;
let mode: "ok" | "fail" | "cut" = "ok";
const backend = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += String(c); });
  req.on("end", () => {
    if (req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "chat" }, { id: "fresh" }] })); return; }
    runs++;
    const body = JSON.parse(raw) as { stream?: boolean };
    if (mode === "fail") { res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"error":"no"}'); return; }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: {"choices":[{"delta":{"content":"run ${runs}"}}]}\n\n`);
      res.end(mode === "cut" ? "" : "data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `run ${runs}` } }] }));
  });
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const node = createNode(parseConfig({
  name: "node-under-test",
  backends: { main: { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, kind: "none", serves: ["chat", "fresh"] } },
  models: { chat: { cacheMs: 60_000 } },
  flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } },
}), silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const ask = async (body: Record<string, unknown>) => {
  const r = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, hit: r.headers.get("x-hearth-cache") === "hit", text: await r.text() };
};
const q = (content: string, more: Record<string, unknown> = {}) => ({ model: "chat", messages: [{ role: "user", content }], ...more });

const first = await ask(q("one"));
const again = await ask(q("one"));
assert.deepEqual([first.hit, again.hit, runs], [false, true, 1], "the same request is answered from what was kept");
assert.equal(again.text, first.text);
assert.equal((await ask(q("two"))).hit, false, "a different request runs");
assert.equal((await ask(q("one", { temperature: 0.2 }))).hit, false, "and so does one with another field");
assert.equal(runs, 3);

await ask({ ...q("one"), model: "fresh" });
assert.equal((await ask({ ...q("one"), model: "fresh" })).hit, false, "a model that keeps nothing always runs");

const streamed = await ask(q("three", { stream: true }));
const replayed = await ask(q("three", { stream: true }));
assert.equal(replayed.hit, true, "a stream that reached its end is kept whole");
assert.equal(replayed.text, streamed.text);

mode = "cut";
await ask(q("four", { stream: true }));
assert.equal((await ask(q("four", { stream: true }))).hit, false, "a stream cut short is not an answer");
mode = "fail";
assert.equal((await ask(q("five"))).status, 500);
mode = "ok";
const after = await ask(q("five"));
assert.deepEqual([after.status, after.hit], [200, false], "a failure is not kept");

await node.close();
backend.close();

// Out of time, it is gone.
const res = { statusCode: 200, write: () => true, end: () => res, getHeader: () => "application/json", once: (_: string, fn: () => void) => { done = fn; } } as never as import("node:http").ServerResponse;
let done = (): void => {};
kept.keep(res, "k", 500);
res.end('{"ok":true}');
done();
assert.equal(String(kept.get("k")?.body), '{"ok":true}');
now += 500;
assert.equal(kept.get("k"), null);

console.log("answers.test.ts ok");
