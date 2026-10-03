/**
 * A sidecar pinned beside a swapping model on ONE llama-swap, and where its work goes when
 * that card is down.
 *
 * llama-swap can keep a small model (a reranker) loaded in a persistent group while the big
 * seats swap beside it. To hearth that is one URL reporting two loaded models, and "the
 * resident model" stops being a single answer: a `follow` id could go out as the reranker.
 * Two backends on the one URL split it: the sidecar declares what it `serves`, and the
 * swapping backend stops seeing those ids.
 *
 * The second half is the route fallback: the sidecar's path names another backend to try
 * when this one cannot answer, so the work survives the card being reloaded.
 *
 *     npx tsx test/sidecar.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { ConfigError, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

/** A llama-swap stand-in: /running is ours to set, POST bodies are recorded, `status` is what it answers. */
function fakeSwap(ids: string[]) {
  let running: { model: string; state: string }[] = [];
  let status = 200;
  const seen: Record<string, unknown>[] = [];
  /** hearth's own calls to a resident, which are not a client's work. */
  const asked: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      if (req.url === "/yield" || req.url === "/resume") asked.push(req.url);
      else if (req.method === "POST") seen.push(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200, served: body.model }));
    });
  });
  return {
    seen,
    asked,
    load: (models: string[]) => { running = models.map((m) => ({ model: m, state: "ready" })); },
    answer: (s: number) => { status = s; },
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

const card = fakeSwap(["main", "trial", "rerank-gpu"]);
const cpu = fakeSwap(["rerank-cpu"]);
await card.listen();
await cpu.listen();

const config = (cardUrl: string) => parseConfig({
  name: "sidecar",
  resources: { gpu: { kind: "gpu" }, cpu: { kind: "cpu", shared: true } },
  backends: [
    { name: "card", url: cardUrl, kind: "llama-swap", concurrency: 2, resources: ["gpu"] },
    {
      name: "side",
      url: cardUrl,
      kind: "llama-swap",
      serves: ["rerank-gpu"],
      resources: ["gpu"],
      resident: { yield: false },
      routes: [{ path: "/v1/rerank", lane: "chat", model: "rerank-gpu", fallback: { backend: "cpu", model: "rerank-cpu" } }],
    },
    { name: "cpu", url: cpu.url(), kind: "none", serves: ["rerank-cpu"], resources: ["cpu"] },
  ],
  models: {
    loaded: { backend: "card", as: "main", follow: true },
    rerank: { backend: "side", as: "rerank-gpu" },
  },
});

const node = createNode(config(card.url()), silentLogger);
node.start();
const url = await new Promise<string>((ready) =>
  node.server.listen(0, "127.0.0.1", () =>
    ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
);
const refresh = () => Promise.all(node.pool.all().map((b) => b.state.refresh()));
const post = async (path: string, body: Record<string, unknown>) => {
  const r = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await r.text();
  return r.status;
};

try {
  // --- one URL, two backends: each sees only its own models ----------------------------
  {
    card.load(["rerank-gpu", "trial"]);
    await refresh();
    const swap = node.pool.get("card")!.state;
    const side = node.pool.get("side")!.state;
    assert.deepEqual(swap.loaded(), ["trial"], "the swapping backend does not count the sidecar as loaded");
    assert.equal(swap.resident(), "trial", "so its resident is the seat, whatever order the URL reports");
    assert.deepEqual(swap.catalog(), ["main", "trial"], "nor as something it could load");
    assert.ok(side.loaded().includes("rerank-gpu"), "the sidecar still sees itself");
    assert.ok(node.pool.loaded().includes("rerank"), "and it is still warm to the node, under the id it is advertised as");
  }

  // --- THE POINT: a follow id rides the seat, never the sidecar -------------------------
  {
    card.seen.length = 0;
    assert.equal(await post("/v1/chat/completions", { model: "loaded", messages: [] }), 200);
    assert.equal(card.seen.at(-1)!.model, "trial", "the reranker is listed first and is not what gets followed");

    card.load(["rerank-gpu"]);
    await refresh();
    assert.equal(await post("/v1/chat/completions", { model: "loaded", messages: [] }), 200);
    assert.equal(card.seen.at(-1)!.model, "main", "only the sidecar loaded means no seat: `as` loads the default");
    assert.deepEqual(card.asked, [], "`yield: false`: the seat took its turns without asking the sidecar for anything");
  }

  // --- the route runs on the sidecar while it answers -----------------------------------
  {
    card.seen.length = 0;
    cpu.seen.length = 0;
    assert.equal(await post("/v1/rerank", { model: "rerank", query: "q", documents: ["d"] }), 200);
    assert.equal(card.seen.at(-1)!.model, "rerank-gpu");
    assert.equal(cpu.seen.length, 0, "the fallback is not touched while the first backend answers");
  }

  // --- an id only the fallback serves is a choice, and goes straight there ---------------
  {
    card.seen.length = 0;
    cpu.seen.length = 0;
    assert.equal(await post("/v1/rerank", { model: "rerank-cpu", query: "q", documents: ["d"] }), 200);
    assert.equal(cpu.seen.at(-1)!.model, "rerank-cpu");
    assert.equal(card.seen.length, 0, "the card is never asked for a model it does not have");
  }

  // --- a 4xx is the caller's answer and is relayed, not retried elsewhere ----------------
  {
    card.seen.length = 0;
    cpu.seen.length = 0;
    card.answer(400);
    assert.equal(await post("/v1/rerank", { model: "rerank", query: "q", documents: ["d"] }), 400);
    assert.equal(cpu.seen.length, 0, "a bad request would be just as bad on the fallback");
  }

  // --- a 5xx before any byte: the same work, on the fallback, under its id ---------------
  {
    card.seen.length = 0;
    cpu.seen.length = 0;
    card.answer(503);
    assert.equal(await post("/v1/rerank", { model: "rerank", query: "q", documents: ["d"] }), 200);
    assert.equal(card.seen.length, 1, "the card was tried first");
    assert.deepEqual(cpu.seen.at(-1), { model: "rerank-cpu", query: "q", documents: ["d"] },
      "the body is forwarded whole, with only the model renamed");
    card.answer(200);
  }
} finally {
  await node.close();
}

// --- the card is gone entirely: connection refused falls back the same way ---------------
{
  const dead = createNode(config("http://127.0.0.1:1"), silentLogger);
  const deadUrl = await new Promise<string>((ready) =>
    dead.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(dead.server.address() as AddressInfo).port}`)),
  );
  cpu.seen.length = 0;
  const r = await fetch(`${deadUrl}/v1/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "rerank", query: "q", documents: ["d"] }),
  });
  await r.text();
  assert.equal(r.status, 200, "an unreachable card is not the caller's problem");
  assert.equal(cpu.seen.at(-1)!.model, "rerank-cpu");
  await dead.close();
}

// --- config ---------------------------------------------------------------------------
{
  const side = config(card.url()).backends.find((b) => b.name === "side")!;
  assert.deepEqual(side.resident, { yield: null, resume: null }, "a resident that is never asked to move");
  const [r] = side.routes;
  assert.deepEqual(r!.fallback, { backend: "cpu", model: "rerank-cpu" });
  const one = (route: Record<string, unknown>) => () => parseConfig({
    name: "t",
    backends: [
      { name: "a", url: "http://127.0.0.1:1", kind: "none", routes: [{ path: "/x", ...route }] },
      { name: "b", url: "http://127.0.0.1:2", kind: "none" },
    ],
  });
  assert.equal(one({})().backends[0]!.routes[0]!.fallback, null, "absent means none, as before");
  assert.throws(one({ fallback: { backend: "nope", model: "m" } }), ConfigError, "a fallback names a real backend");
  assert.throws(one({ fallback: { backend: "a", model: "m" } }), ConfigError, "and not the one that just failed");
  assert.throws(one({ fallback: { backend: "b" } }), ConfigError, "and the id it serves there");
  assert.throws(one({ queue: false, fallback: { backend: "b", model: "m" } }), ConfigError, "only queued work falls back");
}

card.close();
cpu.close();
console.log("sidecar.test.ts ok");
