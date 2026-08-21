/**
 * Several local backends behind one node.
 *
 * Two properties carry this feature, and both are easy to lose in a refactor.
 *
 * The first is isolation: a model on backend B must start while backend A's
 * slot is held. That is the entire reason for the feature. A small always-on
 * model that queues behind a 40s generation is worse than not having it.
 *
 * The second is that a protocol-1 peer still routes correctly against a node
 * that now speaks 2. The wire format grew a per-model capacity map; if the
 * aggregate ever stops being sent alongside it, every older peer on the network
 * scores this node on `undefined` and quietly stops using it.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

/** A backend that can be told to hold a generation open. */
function fake(label: string, models: string[]) {
  let release: (() => void) | null = null;
  let hold = false;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    if (req.url === "/running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: [{ model: models[0], state: "ready" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { model?: string };
      seen.push(`${req.url}:${body.model ?? ""}`);
      const finish = () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: {"by":"${label}"}\n\ndata: [DONE]\n\n`);
      };
      if (hold) release = finish;
      else finish();
    });
  });
  return {
    server,
    seen,
    holdNext: () => { hold = true; },
    releaseHeld: () => { hold = false; release?.(); release = null; },
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

const gpu = fake("gpu", ["big-chat"]);
const side = fake("side", ["tiny-embed"]);
await gpu.listen();
await side.listen();

const node = createNode(
  parseConfig({
    name: "two-backends",
    backends: [
      { name: "gpu", url: gpu.url(), kind: "llama-swap", concurrency: 1 },
      { name: "side", url: side.url(), kind: "llama-swap", concurrency: 4 },
    ],
    peerTokens: { friend: "tok" },
    share: ["big-chat", "tiny-embed"],
  }),
  silentLogger,
);
node.start();
const base = await new Promise<string>((ready) =>
  node.server.listen(0, "127.0.0.1", () =>
    ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
);
// Let both catalogs land, so resolution has something to work with.
await Promise.all(node.pool.all().map((b) => b.state.ensureFresh()));

const chat = (model: string) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [] }),
  }).then((r) => r.text());

// --- each model reaches its own backend ------------------------------------
{
  assert.match(await chat("big-chat"), /"by":"gpu"/);
  assert.match(await chat("tiny-embed"), /"by":"side"/);

  // An id nobody lists goes to the first backend, which is where a
  // single-backend node would always have sent it. Refusing here would break
  // llama-swap, which will happily load an id missing from a stale catalog.
  assert.match(await chat("never-heard-of-it"), /"by":"gpu"/);
}

// --- THE property: the side backend does not wait on the GPU ---------------
{
  gpu.holdNext();
  const heldGeneration = chat("big-chat");
  await new Promise((r) => setTimeout(r, 80));

  const gpuCap = node.pool.get("gpu")!.scheduler.capacity();
  assert.equal(gpuCap.free, 0, "the gpu slot must actually be held for this to prove anything");

  // With one shared queue this would block until the generation finished.
  const embed = await Promise.race([
    chat("tiny-embed"),
    new Promise<"BLOCKED">((r) => setTimeout(() => r("BLOCKED"), 1_500)),
  ]);
  assert.notEqual(embed, "BLOCKED", "the side backend queued behind the gpu");
  assert.match(embed as string, /"by":"side"/);

  gpu.releaseHeld();
  await heldGeneration;
}

// --- /v1/models is the union ------------------------------------------------
{
  const r = (await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] };
  assert.deepEqual(r.data.map((m) => m.id).sort(), ["big-chat", "tiny-embed"]);
}

// --- the peer protocol -----------------------------------------------------
{
  const state = (await (
    await fetch(`${base}/peer/state`, { headers: { Authorization: "Bearer tok" } })
  ).json()) as {
    slots: number; free: number; queued: Record<string, number>; loaded?: string[];
    models?: Record<string, { slots: number; free: number; queued: number; warm: boolean }>;
  };

  // Protocol 2: per-model capacity, which is the backend that serves it.
  assert.ok(state.models, "a v2 node must publish per-model capacity");
  assert.equal(state.models!["big-chat"]!.slots, 1, "the gpu's own slot count");
  assert.equal(state.models!["tiny-embed"]!.slots, 4, "the side backend's own slot count");

  // ...and the aggregate is STILL sent. A protocol-1 peer reads only these, and
  // peers.ts rejects an answer missing them, so dropping them would make every
  // older node on the network mark this one down.
  assert.equal(typeof state.slots, "number", "v1 peers still need the aggregate");
  assert.equal(typeof state.free, "number");
  assert.equal(typeof state.queued, "object");
  assert.equal(state.slots, 5, "aggregate slots is the sum across backends");

  const hello = (await (
    await fetch(`${base}/peer/hello`, { headers: { Authorization: "Bearer tok" } })
  ).json()) as { protocol: number };
  assert.equal(hello.protocol, 2);
}

// --- status surfaces know which backend ------------------------------------
{
  const q = (await (await fetch(`${base}/queue`)).json()) as {
    backends: { name: string; slots: number }[];
  };
  assert.deepEqual(q.backends.map((b) => b.name), ["gpu", "side"]);
  assert.deepEqual(q.backends.map((b) => b.slots), [1, 4]);

  const d = (await (await fetch(`${base}/ui/data`)).json()) as {
    net: { nodes: { self?: boolean; backends?: { name: string }[] }[] };
    hist: { residents: string[] }[];
  };
  const self = d.net.nodes.find((n) => n.self)!;
  assert.deepEqual(self.backends!.map((b) => b.name), ["gpu", "side"]);

  await Promise.all(node.pool.all().map((b) => b.state.ensureFresh()));
  node.history.sample();
  const after = (await (await fetch(`${base}/ui/data`)).json()) as { hist: { residents: string[] }[] };
  // Two backends means two models warm at once. Collapsing that to one name
  // would draw swaps in the lane chart that never happened.
  assert.deepEqual(after.hist.at(-1)!.residents.sort(), ["big-chat", "tiny-embed"]);
}

await node.close();
gpu.close();
side.close();

// --- warm state from something that is not llama-swap --------------------------
//
// Ollama has a direct equivalent of /running at /api/ps, and it reports a SET:
// several models resident at once under keep_alive, all servable together. The
// llama-swap assumption of one resident model would credit only the first.
//
// The other half matters as much: a backend that CANNOT report warmth must not
// be rendered as cold. "Nothing is warm" and "we cannot see" are different
// claims, and only one of them is ours to make.
{
  const ollama = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "embed-a" }, { id: "embed-b" }, { id: "cold-one" }] }));
      return;
    }
    if (req.url === "/api/ps") {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Two resident at once, which llama-swap could never report.
      res.end(JSON.stringify({ models: [
        { name: "embed-a", model: "embed-a", size_vram: 0, context_length: 512 },
        { name: "embed-b", model: "embed-b", size_vram: 0, context_length: 512 },
      ] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
  const ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;

  const mute = fake("mute", ["mystery"]);   // serves /running, but told not to look
  await mute.listen();

  const n4 = createNode(
    parseConfig({
      name: "warmth",
      backends: [
        { name: "oll", url: ollamaUrl, kind: "ollama" },
        { name: "mute", url: mute.url(), kind: "none" },
      ],
    }),
    silentLogger,
  );
  n4.start();
  const b4 = await new Promise<string>((ready) =>
    n4.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(n4.server.address() as AddressInfo).port}`)),
  );
  await Promise.all(n4.pool.all().map((b) => b.state.ensureFresh()));

  const oll = n4.pool.get("oll")!;
  assert.deepEqual(oll.state.loaded().sort(), ["embed-a", "embed-b"],
    "/api/ps reports a set, and every member of it is warm");
  assert.ok(oll.state.isWarm("embed-a") && oll.state.isWarm("embed-b"),
    "not just the first one: ollama serves them concurrently");
  assert.ok(!oll.state.isWarm("cold-one"), "listed but not resident is genuinely cold");
  assert.equal(oll.state.knowsWarm(), true);

  // kind: none reports nothing AND says it cannot see.
  const m = n4.pool.get("mute")!;
  assert.deepEqual(m.state.loaded(), [], "we did not look, so we know nothing");
  assert.equal(m.state.knowsWarm(), false, "and it must admit that");

  const net = (await (await fetch(`${b4}/network`)).json()) as {
    readyNow: string[]; available: string[]; unknownWarm: string[]; evicts: boolean;
  };
  assert.deepEqual(net.readyNow, ["embed-a", "embed-b"]);
  assert.deepEqual(net.unknownWarm, ["mystery"],
    "a model we cannot judge is neither warm nor cold");
  assert.ok(!net.readyNow.includes("mystery"));
  // ...and it is kept OUT of the cold bucket the page derives from `available`.
  assert.ok(net.available.includes("mystery"));
  assert.equal(net.evicts, false,
    "nothing here evicts, so the page must not warn about thrash");

  await n4.close();
  ollama.closeAllConnections();
  ollama.close();
  mute.close();
}

// --- a backend that names its own models ---------------------------------------
//
// A bare llama-server reports the gguf path it was launched with, so discovery
// would put "/root/models/Llama-Guard-3-1B-Q8_0.gguf" in the catalogue and hand
// the filesystem layout to anyone who reads /v1/models. Declaring `serves`
// replaces discovery for that backend: your name, and nothing else routes there.
{
  const swap = fake("swap", ["chat-model"]);
  const bare = fake("bare", ["/root/models/Llama-Guard-3-1B-Q8_0.gguf"]);
  await swap.listen();
  await bare.listen();

  const n3 = createNode(
    parseConfig({
      name: "declared",
      backends: [
        { name: "swap", url: swap.url(), llamaSwapExtras: false },
        { name: "guard", url: bare.url(), llamaSwapExtras: false, serves: ["guard"] },
      ],
    }),
    silentLogger,
  );
  n3.start();
  const b3 = await new Promise<string>((ready) =>
    n3.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(n3.server.address() as AddressInfo).port}`)),
  );
  await Promise.all(n3.pool.all().map((b) => b.state.ensureFresh()));

  const ask = (model: string) =>
    fetch(`${b3}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [] }),
    }).then((r) => r.text());

  assert.match(await ask("guard"), /"by":"bare"/, "the declared name must route there");

  const cat = ((await (await fetch(`${b3}/v1/models`)).json()) as { data: { id: string }[] })
    .data.map((m) => m.id).sort();
  assert.deepEqual(cat, ["chat-model", "guard"], "the gguf path must not reach the catalogue");
  assert.ok(!JSON.stringify(cat).includes("/root/"), "no filesystem paths in the catalogue");

  // The path it actually reports is not a routable name either: declaring is an
  // allowlist, so this falls through to the first backend like any unknown id.
  assert.match(
    await ask("/root/models/Llama-Guard-3-1B-Q8_0.gguf"),
    /"by":"swap"/,
    "a declared backend answers to its declared names only",
  );

  await n3.close();
  swap.close();
  bare.close();
}

// --- a protocol-1 peer still works --------------------------------------------
//
// The wire format grew a per-model `models` map. An older node does not send
// one, and peers.ts must fall back to the node-level numbers rather than
// scoring it on undefined and routing around a perfectly healthy peer. This
// stands up a peer that speaks ONLY the old shape and checks work still leaves.
{
  const oldPeer = createServer((req, res) => {
    if (req.url === "/peer/hello") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "vintage", protocol: 1, models: ["their-id"] }));
      return;
    }
    if (req.url === "/peer/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Exactly the v1 body: aggregate only, no `models`.
      res.end(JSON.stringify({
        slots: 4, free: 4, running: 0, offbox: 0, queued: { chat: 0, batch: 0 },
        resident: "their-id", loaded: ["their-id"], serves: ["their-id"],
      }));
      return;
    }
    const c: Buffer[] = [];
    req.on("data", (d: Buffer) => c.push(d));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"by":"vintage-peer"}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => oldPeer.listen(0, "127.0.0.1", r));
  const peerPort = (oldPeer.address() as AddressInfo).port;

  const local = fake("local", ["something-else"]);
  await local.listen();

  const n2 = createNode(
    parseConfig({
      name: "borrower",
      backend: { url: local.url(), llamaSwapExtras: false },
      peers: [{ name: "vintage", url: `http://127.0.0.1:${peerPort}`, token: "t",
                models: { "borrowed": "their-id" } }],
      // `fastest` is the policy that actually reads capacity, so it is the one
      // that breaks if the fallback is missing.
      models: { borrowed: { policy: "fastest", peers: ["vintage"] } },
    }),
    silentLogger,
  );
  n2.start();
  const b2 = await new Promise<string>((ready) =>
    n2.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(n2.server.address() as AddressInfo).port}`)),
  );
  await n2.peers.probeAll();
  assert.equal(n2.peers.get("vintage")?.up, true, "a v1 peer must still come up");

  const out = await fetch(`${b2}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "borrowed", messages: [] }),
  }).then((r) => r.text());
  // Peer is warm with four free slots; we are cold. It should win on pressure,
  // which it can only do if the aggregate fallback produced real numbers.
  assert.match(out, /vintage-peer/, "a v1 peer was scored on nothing and skipped");

  await n2.close();
  local.close();
  oldPeer.closeAllConnections();
  oldPeer.close();
}

// --- config validation ------------------------------------------------------
{
  const url = "http://127.0.0.1:9292";
  assert.throws(
    () => parseConfig({ backend: { url }, backends: [{ name: "a", url }] }),
    /not both/,
    "backend and backends together is ambiguous, so it is refused",
  );
  assert.throws(() => parseConfig({ backends: [] }), /must not be empty/);
  assert.throws(
    () => parseConfig({ backends: [{ name: "a", url }, { name: "a", url }] }),
    /both named/,
  );
  assert.throws(
    () => parseConfig({ backends: [{ name: "a", url }], models: { m: { backend: "b" } } }),
    /not a configured backend/,
    "a typo'd backend name must fail at startup, not at request time",
  );
  assert.throws(
    () => parseConfig({ backends: [
      { name: "a", url, serves: ["m"] }, { name: "b", url, serves: ["m"] }] }),
    /both declare they serve/,
    "one id cannot mean two backends",
  );

  // The old boolean still maps onto the new kinds, and mixing the two spellings
  // is refused rather than silently resolved.
  assert.equal(parseConfig({ backend: { url, llamaSwapExtras: true } }).backends[0]!.kind, "llama-swap");
  assert.equal(parseConfig({ backend: { url, llamaSwapExtras: false } }).backends[0]!.kind, "none");
  assert.equal(parseConfig({ backend: { url } }).backends[0]!.kind, "llama-swap", "unchanged default");
  assert.throws(
    () => parseConfig({ backend: { url, kind: "ollama", llamaSwapExtras: false } }),
    /not both/,
  );
  assert.throws(() => parseConfig({ backend: { url, kind: "vllm" } }),
    /expected llama-swap, ollama, single, none/);

  // Back-compat: a bare `backend:` is exactly a list of one, still named.
  const one = parseConfig({ backend: { url }, scheduler: { concurrency: 3 } });
  assert.equal(one.backends.length, 1);
  assert.equal(one.backends[0]!.name, "default");
  assert.equal(one.backends[0]!.concurrency, 3, "scheduler.concurrency is the default per backend");

  // Per-backend concurrency overrides it.
  const many = parseConfig({
    scheduler: { concurrency: 2 },
    backends: [{ name: "a", url }, { name: "b", url, concurrency: 9 }],
  });
  assert.equal(many.backends[0]!.concurrency, 2, "inherits the scheduler default");
  assert.equal(many.backends[1]!.concurrency, 9, "and can be overridden");
}

console.log("backends.test.ts ok");
