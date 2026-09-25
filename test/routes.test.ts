/**
 * Queueing backends that don't speak the OpenAI API.
 *
 * The catch-all passthrough deliberately doesn't queue: scheduling work you
 * can't identify is guesswork, and the comment saying so is load-bearing. But
 * that leaves out a whole class of backend that fits hearth perfectly and is
 * excluded purely by its URL — A1111's /sdapi/v1/txt2img, a whisper server's
 * /asr, any FastAPI in front of diffusers. Request-scoped, GPU-bound, one at a
 * time.
 *
 * `routes:` is the operator naming the path, which is what makes it
 * identifiable. What's asserted here is that naming it queues it, that NOT
 * naming it changes nothing, and the two things that make it usable in
 * practice: a declared path beats the body/path model heuristics, and a
 * `queue: false` path stays unqueued so a progress endpoint still answers
 * while the render it's reporting on holds the slot.
 *
 *     npx tsx test/routes.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { ConfigError, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { BackendPool } from "../src/pool.js";
import { createNode } from "../src/server.js";

// --- config: shorthand, defaults, and the mistakes worth naming ------------
{
  const cfg = parseConfig({
    name: "t",
    backends: [{ name: "sd", url: "http://127.0.0.1:7860", routes: ["/sdapi/v1/txt2img"] }],
  });
  const [r] = cfg.backends[0]!.routes;
  assert.equal(r!.path, "/sdapi/v1/txt2img", "a bare string is a path");
  assert.equal(r!.queue, true, "and it is work by default");
  assert.equal(r!.model, "sd", "reported under the backend's name");
  // The stock lanes are chat: 0 and batch: 100. A named path is nearly always
  // the heavy half of the box and the thing it shares a GPU with is nearly
  // always someone waiting on a chat response, so it yields.
  assert.equal(r!.lane, "batch", "and yields to the interactive lane by default");
}

{
  const cfg = parseConfig({
    name: "t",
    scheduler: { lanes: { chat: { priority: 0 }, video: { priority: 150 } } },
    backends: [
      {
        name: "v",
        url: "http://127.0.0.1:1",
        routes: [{ path: "/generate", lane: "video", model: "wan" }, { path: "/concat", queue: false }],
      },
    ],
  });
  const [gen, cat] = cfg.backends[0]!.routes;
  assert.equal(gen!.lane, "video");
  assert.equal(gen!.model, "wan");
  assert.equal(cat!.queue, false);
  assert.equal(cat!.lane, "video", "an unqueued route still gets the defaults filled in");
}

for (const [bad, why] of [
  [{ routes: ["sdapi/txt2img"] }, "a path that cannot match must fail at startup"],
  [{ routes: ["/x?a=1"] }, "a query string in a path is a mistake"],
  [{ routes: [{ path: "/x", lane: "nope" }] }, "an unknown lane is a typo, not a new lane"],
] as const) {
  assert.throws(
    () => parseConfig({ name: "t", backends: [{ name: "b", url: "http://127.0.0.1:1", ...bad }] }),
    ConfigError,
    why,
  );
}

assert.throws(
  () =>
    parseConfig({
      name: "t",
      backends: [
        { name: "a", url: "http://127.0.0.1:1", routes: ["/gen"] },
        { name: "b", url: "http://127.0.0.1:2", routes: ["/gen"] },
      ],
    }),
  ConfigError,
  "one path cannot mean two backends",
);

// --- a backend that blocks until told, so 'did it queue?' is answerable ----
function blocker() {
  let release: () => void = () => {};
  const gate = () => new Promise<void>((r) => (release = r));
  let waiting: Promise<void> | null = null;
  const seen: string[] = [];
  let concurrent = 0;
  let peak = 0;

  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const done = () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: req.url }));
    };
    if (req.url === "/progress" || req.url === "/v1/models") {
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [] }));
      return done();
    }
    concurrent++;
    peak = Math.max(peak, concurrent);
    waiting ??= gate();
    void waiting.then(() => {
      concurrent--;
      done();
    });
  });
  return {
    server,
    seen,
    peak: () => peak,
    inflight: () => concurrent,
    open: () => release(),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

const b = blocker();
await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", r));

// A SECOND server for the other backend, so "which backend served it" is a
// question the test can actually answer. Both pointing at one server makes
// every routing assertion below vacuously true.
const otherHits: string[] = [];
const other = createServer((req, res) => {
  otherHits.push(`${req.method} ${req.url}`);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url === "/v1/models" ? { data: [] } : { ok: "other" }));
});
await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

const node = createNode(
  parseConfig({
    name: "routes",
    scheduler: { lanes: { chat: { priority: 0 }, video: { priority: 150 } } },
    backends: [
      { name: "llm", url: otherUrl, serves: ["chat-model"], concurrency: 1 },
      {
        name: "video",
        url: b.url(),
        kind: "none",
        concurrency: 1,
        routes: [
          { path: "/generate", lane: "video", model: "wan" },
          { path: "/progress", queue: false },
        ],
      },
    ],
  }),
  silentLogger,
);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

const post = (p: string, body: unknown = {}, signal?: AbortSignal) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

// Wait for a condition instead of guessing a delay. The fixed 80ms this
// replaces was enough for the first render to reach the backend on CI and not
// on a loaded machine, where the request had simply not arrived yet and
// inflight read 0. Polling removes the guess without weakening the check: the
// race-free over-commit guard is b.peak() at the end of the block, which no
// snapshot can beat.
const until = async (cond: () => boolean, what: string, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

// --- a declared route is queued -------------------------------------------
// The backend's concurrency is 1, so if this is queued the second request
// cannot reach it while the first is in flight. Unqueued, both arrive at once,
// which is the over-commit the whole feature exists to stop.
{
  const a = post("/generate", { prompt: "one" });
  const c = post("/generate", { prompt: "two" });
  await until(() => b.inflight() >= 1, "the first render to reach the backend");
  assert.equal(b.inflight(), 1, "only one render reaches the backend at a time");

  // --- and an unqueued route answers WHILE it does --------------------------
  // The progress-bar case: this is what a caller polls during the render it is
  // asking about, so queueing it behind that render is worse than not having it.
  // Deadline, not just a status check. If this route were queued it would wait
  // behind the render above — which is only released further down — so the
  // failure mode is an infinite hang, and a test that hangs reports nothing.
  // Five seconds is far beyond a passthrough and far below "forever".
  const prog = await post("/progress", {}, AbortSignal.timeout(5_000)).catch((e: Error) => e);
  assert.ok(
    prog instanceof Response,
    `a queue:false route must answer while the queue is busy (got ${String(prog)})`,
  );
  assert.equal(prog.status, 200);

  b.open();
  assert.equal((await a).status, 200);
  assert.equal((await c).status, 200);
  assert.equal(b.peak(), 1, "never more than one at the backend");
}

// --- a declared path beats the model heuristics ----------------------------
// The passthrough guesses a backend from `model` in the body. A declared route
// is the only statement the operator actually made, so it has to win — or
// naming the path would work right up until someone put a model field in the
// body.
{
  b.seen.length = 0;
  otherHits.length = 0;
  const r = await post("/generate", { model: "chat-model", prompt: "x" });
  b.open();
  await r.text();
  assert.ok(
    b.seen.some((x) => x.includes("/generate")),
    "the declared backend served it",
  );
  // Filtered rather than deepEqual([]): the other backend also gets background
  // /v1/models polls from its BackendState, and a poll landing mid-assertion
  // would fail a test that has nothing to say about polling.
  assert.ok(
    !otherHits.some((x) => x.includes("/generate")),
    `the backend the body named never saw it (got ${otherHits.join(", ")})`,
  );
}

// --- an undeclared path is untouched ---------------------------------------
// Every config that predates this has no routes at all, and the passthrough's
// promise to those is that it forwards and does not schedule.
{
  const r = await post("/some/other/path", {});
  assert.notEqual(r.status, 404, "still forwarded");
  b.open();
  await r.text();
}

// closeAllConnections on the FAKE backends too, not just hearth's listener.
// hearth holds keep-alive sockets to them, so a plain close() waits forever on
// connections nothing is going to end, and the process hangs after printing ok.
node.server.closeAllConnections();
node.server.close();
b.server.closeAllConnections();
b.server.close();
other.closeAllConnections();
other.close();
console.log("routes.test.ts ok");

// --- {model} routes --------------------------------------------------------
// The model is IN the path for a backend fronted by llama-swap
// (/upstream/<model>/generate), so an exact route would need one entry per
// model — and a model added later would silently go back to being unqueued,
// which is the failure this whole feature exists to prevent.
//
// The narrowness is the point. The old comment refused wildcards because "a
// pattern that matches more than the operator pictured would silently pull
// unrelated traffic into a queue", and that objection is answered rather than
// overridden: the captured segment IS the model id, and the route only matches
// when the backend actually serves it.
{
  const cfg = parseConfig({
    name: "pat",
    backends: [
      {
        name: "img", url: "http://127.0.0.1:1",
        serves: ["image", "image-lora"],
        routes: [{ path: "/upstream/{model}/generate", lane: "batch" }],
      },
      { name: "llm", url: "http://127.0.0.1:2", serves: ["coder"] },
    ],
  });
  const pool = new BackendPool(cfg, silentLogger);

  const hit = pool.forPath("/upstream/image-lora/generate");
  assert.ok(hit, "a served model matches the pattern");
  assert.equal(hit.slot.name, "img");
  assert.equal(hit.rule.model, "image-lora", "the captured segment IS the model id");
  assert.equal(hit.rule.lane, "batch");
  assert.equal(hit.rule.queue, true);

  // The whole objection to wildcards, answered.
  assert.equal(pool.forPath("/upstream/coder/generate"), undefined,
    "a model this backend does not serve must fall through to the passthrough");
  assert.equal(pool.forPath("/upstream/image/generate/extra"), undefined,
    "{model} is one segment, not a prefix");
  assert.equal(pool.forPath("/upstream/image"), undefined,
    "and the rest of the path still has to match");

  // A pattern route reports under the requested model, never the backend name.
  assert.notEqual(pool.forPath("/upstream/image/generate")!.rule.model, "img");
}

// --- a pattern route matches the id we ADVERTISE ---------------------------
// The captured segment is whatever the caller typed, and `declaredBy` asks
// what the backend serves -- which is the raw id. For an aliased model those
// are different, and the advertised one is the ONLY name a client has: the raw
// id is hidden from the catalog precisely because it exists to be renamed. So
// the route never fired for it, the request fell through to the unqueued
// passthrough, and a `routes:` entry silently did nothing on the model it was
// written for -- while the console drew an idle backend and a free card.
{
  const cfg = parseConfig({
    name: "alias-pat",
    backends: [{
      name: "img", url: "http://127.0.0.1:1", serves: ["image"],
      routes: [{ path: "/upstream/{model}/generate", lane: "batch" }],
    }],
    models: { "image-hq": { backend: "img", as: "image" } },
  });
  const pool = new BackendPool(cfg, silentLogger);

  assert.deepEqual(pool.catalog(), ["image-hq"], "the raw id is not offered to anyone");
  const hit = pool.forPath("/upstream/image-hq/generate");
  assert.ok(hit, "the advertised id matches the route");
  assert.equal(hit.rule.model, "image-hq", "and is reported in OUR vocabulary, not the wire's");
  assert.ok(pool.forPath("/upstream/image/generate"), "the raw id still matches");
  assert.equal(pool.forPath("/upstream/coder/generate"), undefined,
    "and a model this backend does not serve still falls through");
}

// A path may carry at most one placeholder, as a whole segment, and may not
// also name a model — the path already supplies it.
for (const bad of [
  { path: "/a/{model}/b/{model}", why: "two placeholders" },
  { path: "/a/x{model}/b", why: "glued to a segment" },
  { path: "/a/{lane}/b", why: "an unknown placeholder" },
]) {
  assert.throws(
    () => parseConfig({
      name: "n", backends: [{ name: "b", url: "http://127.0.0.1:1", routes: [{ path: bad.path }] }],
    }),
    /at most one \{model\}|whole path segment|only placeholder is \{model\}/,
    bad.why,
  );
}
assert.throws(
  () => parseConfig({
    name: "n",
    backends: [{
      name: "b", url: "http://127.0.0.1:1",
      routes: [{ path: "/upstream/{model}/go", model: "pinned" }],
    }],
  }),
  /both \{model\} in the path and model:/,
  "naming a model as well as capturing one is two answers to one question",
);

// --- a routed model still gets renamed on the wire -------------------------
// `as:` exists because a backend's real id is often unusable — ollama's
// `nomic-embed-text-v2-moe:latest`, a bare llama-server's gguf path — and the
// passthrough has always rewritten it on the way out. Declaring a route for
// that same path used to switch that off: the id that selects a BACKEND has to
// be empty once a route has chosen one, and the rewrite was reading the same
// value. So queueing an embedder cost you its alias, and the backend answered
// 404 for a name only hearth ever knew.
{
  const wire = "nomic-embed-text-v2-moe:latest";
  const asked: (string | undefined)[] = [];
  let raw = "";
  const backend = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: wire }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/rerank") {
        raw = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.url !== "/v1/embeddings") { res.writeHead(404); res.end(); return; }
      const m = (JSON.parse(body || "{}") as { model?: string }).model;
      asked.push(m);
      // Exactly what ollama does with a name it doesn't have.
      if (m !== wire) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `model '${m}' not found` }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.1] }] }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

  const node = createNode(
    parseConfig({
      name: "alias",
      backends: [{
        name: "ollama", url, serves: [wire, "plain"],
        routes: [
          { path: "/v1/embeddings", model: "nomic-embed", lane: "chat" },
          { path: "/v1/rerank", model: "plain", lane: "chat" },
        ],
      }],
      models: { "nomic-embed": { backend: "ollama", as: wire } },
    }),
    silentLogger,
  );
  node.start();
  const base = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
  );

  const res = await fetch(`${base}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed", input: "hi" }),
  });
  assert.equal(res.status, 200, "a routed alias reaches the backend under its real id");
  assert.deepEqual(asked, [wire], "the advertised id never went out on the wire");

  // And the route still did its job: this was queued, not forwarded blind.
  const d = (await (await fetch(`${base}/ui/data`)).json()) as {
    calls?: { model: string; backend: string; ok: boolean }[];
  };
  const call = d.calls?.at(-1);
  assert.equal(call?.model, "nomic-embed", "recorded under the id the operator declared");
  assert.equal(call?.backend, "ollama");
  assert.equal(call?.ok, true);

  // ...and a model with no alias is still forwarded byte for byte. Translating
  // is the ONE exception to that promise, so it must not fire when there is
  // nothing to translate: rebuilding the body would change its bytes and its
  // length for every routed request on the box.
  {
    const sent = '{\n  "model": "plain",\n  "query":  "hi"\n}';
    await fetch(`${base}/v1/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: sent,
    });
    assert.equal(raw, sent, "an un-aliased routed body reaches the backend untouched");
  }

  await node.close();
  backend.closeAllConnections();
  backend.close();
}

// --- one routed path, two models: scheduled as the one that was asked for ---
// A route names a model because most routed paths carry none — a render, a
// transcription. /v1/embeddings does: two embedders share that one path, and
// scheduling every call as the route's model meant `gemma-embed` was queued,
// counted and recorded as `nomic-embed`. Harmless while a backend had one
// number; wrong the moment each model has its own ceiling, because the two then
// share ONE model's slot instead of having one each.
{
  const wires: Record<string, string> = {
    "nomic-embed": "nomic-embed-text-v2-moe:latest",
    "gemma-embed": "embeddinggemma:latest",
  };
  const inFlight: string[] = [];
  const held: (() => void)[] = [];
  const backend = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url !== "/v1/embeddings") {
        // /api/ps and friends: a quiet ollama with nothing to report.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [], data: [] }));
        return;
      }
      inFlight.push((JSON.parse(body) as { model: string }).model);
      held.push(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ embedding: [0.1] }] }));
      });
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

  const node = createNode(
    parseConfig({
      name: "two-embedders",
      backends: [{
        name: "ollama", url, kind: "ollama", concurrency: 2,
        routes: [{ path: "/v1/embeddings", model: "nomic-embed", lane: "chat" }],
      }],
      models: {
        "nomic-embed": { backend: "ollama", as: wires["nomic-embed"], concurrency: 1 },
        "gemma-embed": { backend: "ollama", as: wires["gemma-embed"], concurrency: 1 },
      },
    }),
    silentLogger,
  );
  node.start();
  const base = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
  );
  const embed = (model: string) =>
    fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: "hi" }),
    });
  const settle = () => new Promise((r) => setTimeout(r, 60));

  const first = embed("nomic-embed");
  await settle();
  const second = embed("nomic-embed");
  const gemma = embed("gemma-embed");
  await settle();
  assert.deepEqual(
    inFlight,
    [wires["nomic-embed"], wires["gemma-embed"]],
    "gemma runs beside nomic, and the second nomic call waits its turn",
  );

  held.shift()!();
  await first;
  await settle();
  assert.equal(inFlight.length, 3, "the second nomic call goes once the first is done");
  for (const release of held.splice(0)) release();
  await Promise.all([second, gemma]);

  const d = (await (await fetch(`${base}/ui/data`)).json()) as { calls?: { model: string }[] };
  assert.deepEqual(
    d.calls?.map((c) => c.model).sort(),
    ["gemma-embed", "nomic-embed", "nomic-embed"],
    "and each call is recorded as the model it actually ran",
  );

  // An id this backend does not serve is NOT taken on the caller's say-so: the
  // route's own model still stands, as it always did.
  const stranger = embed("not-a-model-here");
  await settle();
  held.shift()!();
  await stranger;
  const after = (await (await fetch(`${base}/ui/data`)).json()) as { calls?: { model: string }[] };
  assert.equal(after.calls?.at(-1)?.model, "nomic-embed", "an unknown id falls back to the route's model");

  await node.close();
  backend.closeAllConnections();
  backend.close();
}

console.log("routes.test.ts alias ok");
