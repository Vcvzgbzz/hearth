/**
 * Usage per caller. The failures worth catching:
 *
 *   - a backend's own `usage` ignored, or read out of the answer's text
 *   - a stream with no `usage` counted as nothing
 *   - a day older than the window still summed, or a saved ledger not coming back
 *   - a request that never ran counted as used
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { Meter, Usage } from "../src/usage.js";
import { parseV1 } from "./v1.js";

// The meter.
const whole = new Meter();
whole.feed(Buffer.from('{"choices":[{"message":{"content":"say \\"prompt_tokens\\": 9"}}],'));
whole.feed('"usage":{"prompt_tokens":41,"completion_tokens":7,"total_tokens":48}}');
assert.deepEqual(whole.read(999), { in: 41, out: 7, est: false }, "the backend's count wins");

const stream = new Meter();
stream.feed('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\nda');
stream.feed('ta: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"data: b"}}]}\n\n');
stream.feed("data: [DONE]\n\n");
assert.deepEqual(stream.read(30), { in: 30, out: 2, est: true }, "a stream that does not say is counted by its events");

const said = new Meter();
said.feed('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
assert.deepEqual(said.read(), { in: 5, out: 1, est: false });
assert.equal(new Meter().read(), null, "nothing written, nothing read");

// The ledger.
let now = Date.UTC(2030, 0, 10, 12);
const ledger = new Usage(() => now);
ledger.add("key:app", "chat", true, { in: 10, out: 4, est: false });
ledger.add("key:app", "chat", false, null);
ledger.add("local", "voice", true, { in: 1, out: 1, est: true });
assert.deepEqual(ledger.total("key:app"), { requests: 2, failed: 1, in: 10, out: 4 });
now += 86_400_000;
ledger.add("key:app", "voice", true, { in: 2, out: 2, est: false });
assert.deepEqual(ledger.total("key:app"), { requests: 1, failed: 0, in: 2, out: 2 }, "today is today");
assert.deepEqual(ledger.total("key:app", 2), { requests: 3, failed: 1, in: 12, out: 6 });
assert.deepEqual(ledger.callers(), ["key:app", "local"]);

const back = new Usage(() => now);
back.restore(JSON.parse(JSON.stringify(ledger.snapshot())));
back.restore({ nonsense: 1, "2030-01-11": { "key:app": { chat: "x" } } });
assert.deepEqual(back.total("key:app", 2), { requests: 3, failed: 1, in: 12, out: 6 }, "a saved ledger comes back");
now += 40 * 86_400_000;
assert.deepEqual(back.since(), {}, "a day past the window is gone");

// Through a node.
const backend = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(req.url === "/v1/models"
    ? JSON.stringify({ data: [{ id: "chat" }] })
    : JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const node = createNode(parseV1({
  backend: { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, kind: "none", serves: ["chat"] },
  apiKeys: [{ key: "k", label: "app" }],
}), silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const auth = { Authorization: "Bearer k", "Content-Type": "application/json" };
const chat = (model: string) => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });

assert.equal((await chat("chat")).status, 200);
await (await chat("chat")).text();
assert.notEqual((await chat("no-such-model")).status, 200);
const got = (await (await fetch(`${url}/usage?days=1`, { headers: auth })).json()) as { days: number; usage: Record<string, Record<string, Record<string, unknown>>> };
assert.equal(got.days, 1);
const [today] = Object.values(got.usage);
assert.deepEqual(today, { "key:app": { chat: { requests: 2, failed: 0, in: 24, out: 6 } } }, "what ran is counted to its key, and what was refused is not");
assert.equal((await fetch(`${url}/usage`)).status, 401, "it takes a key");

await node.close();
backend.close();
console.log("usage.test.ts ok");
