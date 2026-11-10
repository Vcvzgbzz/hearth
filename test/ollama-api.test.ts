/**
 * Ollama's own API (`/api/chat`, `/api/generate`) queued through `routes:`, as
 * docs/backends.md shows it. Nothing here is special-cased for Ollama: the test
 * holds the documented recipe to what it promises. Each request queues as the
 * model its body names against that model's own number, the NDJSON stream is
 * relayed whole, and an unqueued read reaches this backend even when another
 * backend is listed first.
 *
 *     npx tsx test/ollama-api.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stand-in for Ollama: answers each chat as three NDJSON lines, slowly enough that overlap is measurable.
let running = 0;
const peak: Record<string, number> = {};
const live: Record<string, number> = {};
const ollama = createServer(async (req, res) => {
  const json = (o: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(o));
  };
  if (req.url === "/v1/models") return json({ object: "list", data: [{ id: "model-a" }, { id: "model-b" }] });
  if (req.url === "/api/ps") return json({ models: [{ name: "model-a", model: "model-a" }, { name: "model-b", model: "model-b" }] });
  if (req.url === "/api/tags") return json({ models: [{ name: "model-a" }, { name: "model-b" }], from: "ollama" });
  if (req.url === "/api/chat" || req.url === "/api/generate") {
    let raw = "";
    for await (const c of req) raw += c;
    const model = (JSON.parse(raw) as { model: string }).model;
    running++;
    live[model] = (live[model] ?? 0) + 1;
    peak[model] = Math.max(peak[model] ?? 0, live[model]!);
    peak.all = Math.max(peak.all ?? 0, running);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (let i = 0; i < 3; i++) {
      await wait(60);
      res.write(JSON.stringify({ model, message: { role: "assistant", content: `w${i}` }, done: false }) + "\n");
    }
    running--;
    live[model]!--;
    res.end(JSON.stringify({ model, done: true }) + "\n");
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;

// Listed first, so an unclaimed path with no model would land here.
const firstHits: string[] = [];
const first = createServer((req, res) => {
  firstHits.push(req.url ?? "");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "other-model" }] } : { from: "first" }));
});
await new Promise<void>((r) => first.listen(0, "127.0.0.1", r));
const firstUrl = `http://127.0.0.1:${(first.address() as AddressInfo).port}`;

const node = createNode(
  parseConfig({
    name: "ollama-api",
    backends: {
      first: { url: firstUrl, kind: "single", serves: ["other-model"] },
      ollama: {
        url: ollamaUrl,
        kind: "ollama",
        concurrency: 2,
        serves: ["model-a", "model-b"],
        routes: [
          { path: "/api/chat", lane: "chat" },
          { path: "/api/generate", lane: "chat" },
          { path: "/api/tags", queue: false },
        ],
      },
    },
    models: {
      "other-model": { backend: "first" },
      "model-a": { backend: "ollama", concurrency: 1 },
      "model-b": { backend: "ollama", concurrency: 1 },
    },
    flows: { "anything-else": { inputs: ["*"], steps: [{ to: { asked: true } }] } },
  }),
  silentLogger,
);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

const chat = async (model: string, path = "/api/chat") => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: r.status, type: r.headers.get("content-type"), lines: (await r.text()).trim().split("\n") };
};

// An unqueued read declared on this backend reaches it, not the backend listed first.
{
  const r = await fetch(`${base}/api/tags`);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { from: string }).from, "ollama", "/api/tags goes to the backend that declares it");
  assert.ok(!firstHits.includes("/api/tags"), "and never to the first backend");
}

// The stream arrives whole and in Ollama's own shape.
{
  const r = await chat("model-a");
  assert.equal(r.status, 200);
  assert.equal(r.type, "application/x-ndjson", "the content type is relayed as Ollama sent it");
  assert.equal(r.lines.length, 4, "every NDJSON line reaches the caller");
  assert.equal((JSON.parse(r.lines.at(-1)!) as { done: boolean }).done, true);
}

// Each model queues against its own number: two models run side by side, a second call to one waits.
{
  for (const k of Object.keys(peak)) delete peak[k];
  const all = await Promise.all([chat("model-a"), chat("model-a"), chat("model-b"), chat("model-b", "/api/generate")]);
  assert.ok(all.every((r) => r.status === 200), "every request is answered");
  assert.equal(peak["model-a"], 1, "a model with concurrency 1 never has two requests at once");
  assert.equal(peak["model-b"], 1, "and that holds across /api/chat and /api/generate");
  assert.equal(peak.all, 2, "while two different models run side by side");
}

await node.close();
ollama.closeAllConnections();
ollama.close();
first.close();
console.log("ollama-api.test.ts ok");
