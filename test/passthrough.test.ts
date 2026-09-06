/**
 * Unqueued passthrough, and what the console is allowed to say about it.
 *
 * hearth forwards anything it does not claim — /upstream/<model>/generate is
 * the one that matters here, because that is how image generation arrives — and
 * deliberately does not schedule it. That decision is about ADMISSION, and it
 * used to be an accidental decision about VISIBILITY too: the backend drew idle
 * and its card drew free while the GPU was flat out.
 *
 * So there are two claims to pin, and the second is the one that keeps this
 * honest:
 *
 *   1. in-flight passthrough is reported, so the page can draw it
 *   2. it is STILL not a job, and the card is STILL not held — because we were
 *      never asked to admit it and cannot make anything wait for it
 *
 * Getting (1) without (2) would be worse than the bug: a page that draws the
 * arbiter holding a card it has no idea about is one that lies about the exact
 * thing the arbiter exists for.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

let release: () => void = () => {};
const held = () => new Promise<void>((r) => { release = r; });
let inFlight: Promise<void> | null = null;

const backend = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }));
    return;
  }
  if (req.url === "/running") {
    // Only m1 is resident. m2 is served and cold, which is the whole point of
    // the second assertion below.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ running: [{ model: "m1", state: "ready" }] }));
    return;
  }
  if (req.url === "/classify") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rating: "safe" }));
    return;
  }
  if (req.url === "/upstream/m1/generate") {
    // Answers only when the test says so, so the request is genuinely in flight
    // while /ui/data is read rather than racing it.
    inFlight = held().then(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

// No apiKeys: loopback is trusted, so the passthrough needs no credential here.
const node = createNode(
  parseConfig({
    name: "pt-test",
    backends: [{
      name: "img", url: backendUrl, kind: "llama-swap",
      concurrency: 4, serves: ["m1", "m2"], resources: ["gpu0"],
      routes: [{ path: "/classify", model: "classifier", lane: "chat" }],
    }],
  }),
  silentLogger,
);
node.start();
const base = await new Promise<string>((ready) =>
  node.server.listen(0, "127.0.0.1", () =>
    ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
);

interface Data {
  net: {
    nodes: { self?: boolean; backends?: {
      name: string; loaded?: string[]; free?: number;
      proxying?: { id: string; model: string | null }[];
    }[] }[];
    resources?: { name: string; holder: string | null }[];
  };
  q: { jobs: unknown[] };
  calls?: { t: number; model: string; backend: string; ms: number; waitedMs: number; ok: boolean }[];
}
const read = async (): Promise<Data> =>
  (await (await fetch(`${base}/ui/data`)).json()) as Data;
const img = (d: Data) =>
  d.net.nodes.find((n) => n.self)!.backends!.find((b) => b.name === "img")!;

await node.pool.first().state.ensureFresh();

// --- warmth is what is resident, not what is declared ----------------------
// This reported the whole `serves` list the moment ANYTHING was loaded, so a
// seven-model image backend called all seven warm while llama-swap held one.
// "Will this cost me a load" is the only question that indicator answers.
{
  const d = await read();
  assert.deepEqual(img(d).loaded, ["m1"],
    "only the resident model is warm — m2 is served and cold");
}

// --- an unqueued passthrough is visible, and is still not a job ------------
{
  const done = fetch(`${base}/upstream/m1/generate`, { method: "POST", body: "{}" });

  // Wait for it to actually reach the backend rather than sleeping and hoping.
  for (let i = 0; i < 200 && !inFlight; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(inFlight, "the passthrough must have reached the backend");

  const d = await read();
  const b = img(d);
  assert.equal(b.proxying?.length, 1, "the in-flight passthrough must be reported");
  assert.equal(b.proxying![0]!.model, "m1", "and it must say which model");

  // The honest half. Everything below here would be a lie if it changed.
  assert.deepEqual(d.q.jobs, [], "a passthrough is not a job");
  assert.equal(b.free, 4, "and it holds no slot");
  assert.equal(d.net.resources?.find((r) => r.name === "gpu0")?.holder, null,
    "the arbiter never admitted it, so it does not hold the card and must not claim to");

  release();
  await done;
  await inFlight;

  // Drains, or the page shows phantom traffic forever.
  for (let i = 0; i < 200; i++) {
    if ((img(await read()).proxying ?? []).length === 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(img(await read()).proxying, [], "and it clears when the request ends");
}

// --- a DECLARED route is queued AND recorded -------------------------------
// It always went through the scheduler; it just never reached the history ring,
// so it drew no spark and no bar. Sidecar calls finish in well under the 3s
// poll, which makes the history the only place they can ever appear.
{
  const d0 = await read();
  const before = (d0.calls ?? []).filter((c) => c.backend === "img").length;

  const r = await fetch(`${base}/classify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: "x" }),
  });
  assert.equal(r.status, 200, "the declared route must be served");

  const d1 = await read();
  const mine = (d1.calls ?? []).filter((c) => c.backend === "img");
  assert.equal(mine.length, before + 1, "a queued route must be recorded as a local use");
  assert.equal(mine.at(-1)!.model, "classifier", "under the model the route names");
  assert.equal(mine.at(-1)!.ok, true);

  // Still not a passthrough: it took a slot rather than being waved through.
  assert.deepEqual(img(d1).proxying, [], "a routed request is not counted as passed through");
}

await node.close();
await new Promise<void>((r) => backend.close(() => r()));
console.log("passthrough.test.ts ok");
