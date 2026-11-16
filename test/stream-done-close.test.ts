/**
 * A client that hangs up as soon as a stream says `data: [DONE]` has had its whole answer.
 *
 * OpenAI-style SDKs stop reading at `[DONE]` and close the connection, while the backend may
 * keep its own response open a moment longer. A close in that gap is not an abort: the request
 * is recorded as answered, and the next one still runs. A close before `[DONE]` still is one.
 *
 *     npx tsx test/stream-done-close.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config/config.js";
import { silentLogger, type Logger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

/** How long the backend keeps its body open after the last event it sends. */
const HOLD_MS = 300;

const backend = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "done" }, { id: "cut" }] }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { model?: string };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
    if (body.model === "done") {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      // `[DONE]` split across two writes, as a socket may deliver it.
      res.write("data: [DO");
      setTimeout(() => res.write("NE]\n\n"), 20);
    }
    setTimeout(() => res.end(), HOLD_MS);
  });
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));

const lines: Record<string, unknown>[] = [];
const logger: Logger = { ...silentLogger, info: (msg, fields) => { if (msg === "request") lines.push(fields ?? {}); } };
const node = createNode(parseConfig({
  listen: { host: "127.0.0.1" },
  backends: { main: { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, kind: "none", serves: ["done", "cut"], concurrency: 1, routes: [{ path: "/generate", model: "done", lane: "chat" }] } },
  flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } },
}), logger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

/** Read the stream until `stopAt` shows up (or the first event, when null), then hang up. */
async function askAndHangUp(path: string, model: string, stopAt: string | null): Promise<string> {
  const ctrl = new AbortController();
  const r = await fetch(url + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
    body: JSON.stringify({ model, stream: true, ...(path.includes("chat") ? { messages: [{ role: "user", content: "hi" }] } : { prompt: "hi" }) }),
  });
  assert.equal(r.status, 200);
  const id = r.headers.get("x-request-id") ?? "";
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    if (stopAt === null ? seen.includes("\n\n") : seen.includes(stopAt)) break;
  }
  ctrl.abort();
  return id;
}

/** The request's log line, once the node has finished it. */
async function outcome(id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + HOLD_MS * 10;
  for (;;) {
    const line = lines.find((l) => l.id === id);
    if (line) return line;
    assert.ok(Date.now() < deadline, `request ${id} never finished`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

try {
  const done = await outcome(await askAndHangUp("/v1/chat/completions", "done", "data: [DONE]"));
  assert.equal(done.ok, true, `a hang-up after [DONE] is an answered request (${String(done.error)})`);
  assert.equal(done.error, undefined);

  const cut = await outcome(await askAndHangUp("/v1/chat/completions", "cut", null));
  assert.equal(cut.ok, false, "a hang-up before [DONE] is still an abort");

  const passed = await outcome(await askAndHangUp("/generate", "done", "data: [DONE]"));
  assert.equal(passed.ok, true, `the passthrough counts a hang-up after [DONE] as answered too (${String(passed.error)})`);

  // One slot in the lane: a request that never settled would leave this one queued forever.
  const next = await Promise.race([
    fetch(`${url}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "done", stream: true, messages: [{ role: "user", content: "hi" }] }),
    }).then((r) => r.text()),
    new Promise<never>((_, no) => setTimeout(() => no(new Error("the lane never freed its slot")), HOLD_MS * 10)),
  ]);
  assert.ok(next.includes("[DONE]"));
  console.log("stream-done-close: ok");
} finally {
  await node.close();
  backend.close();
}
