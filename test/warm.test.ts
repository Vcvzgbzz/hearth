/**
 * Self-check for POST /v1/warm.
 *
 * The claim under test is not "it loads a model" — it is that warming CANNOT
 * jump the queue. On a llama-swap backend a warm is an eviction, so a warm that
 * dispatched ahead of queued work would be a button that steals the GPU from a
 * turn already in flight. That property comes from going through the scheduler,
 * and this asserts it rather than trusting the comment.
 *
 *     npx tsx test/warm.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode, type HearthNode } from "../src/server.js";

/** llama-swap enough for this: /running, and an /upstream/<m>/health that both
 *  answers and marks the model loaded, the way starting a server does. */
function swapBackend() {
  let loaded: string | null = null;
  const seen: string[] = [];
  let hold: Promise<void> | null = null;
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: loaded ? [{ model: loaded, state: "ready" }] : [] }));
      return;
    }
    if (url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
      return;
    }
    const warm = /^\/upstream\/([^/]+)\/health$/.exec(url);
    if (warm) {
      seen.push("warm:" + warm[1]);
      loaded = warm[1]!;               // starting the server IS the load
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    // a generation: slow if held, so we can occupy the single slot
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        seen.push("chat");
        if (hold) await hold;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"ok":true}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      })();
    });
  });
  return {
    seen,
    setLoaded: (m: string | null) => { loaded = m; },
    hold: (p: Promise<void> | null) => { hold = p; },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

function listen(node: HearthNode): Promise<string> {
  return new Promise((ready) => {
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`));
  });
}
const warmReq = (url: string, model: string) =>
  fetch(`${url}/v1/warm`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });

const be = swapBackend();
await be.listen();
const cfg = parseConfig({
  name: "me",
  backend: { url: be.url(), kind: "llama-swap" },
  scheduler: { concurrency: 1, lanes: { chat: { priority: 0 } } },
});
const node = createNode(cfg, silentLogger);
const url = await listen(node);
await node.pool.first().state.refresh();

// --- the warm lane exists even though the config declared only `chat` --------
// Declaring lanes REPLACES the defaults, so without an explicit add a warm
// would land on the unknown-lane fallback and be indistinguishable from a typo.
assert.ok(cfg.scheduler.lanes.warm, "a warm lane is ensured regardless of config");
assert.ok(
  cfg.scheduler.lanes.warm!.priority > cfg.scheduler.lanes.chat!.priority,
  "and yields to chat, since a warm is speculative",
);

// --- it warms, and says what it did -----------------------------------------
{
  const r = await warmReq(url, "alpha");
  assert.equal(r.status, 200);
  const b = (await r.json()) as { warmed: boolean; model: string; note: string };
  assert.equal(b.warmed, true);
  assert.equal(b.model, "alpha");
  assert.ok(/evict/i.test(b.note), "the response admits warmth is not reserved");
  assert.ok(be.seen.includes("warm:alpha"), "it probed the model's own upstream");
  assert.ok(!be.seen.includes("chat"), "and generated nothing to do it");
}

// --- already resident is not a lie -------------------------------------------
{
  const r = await warmReq(url, "alpha");
  const b = (await r.json()) as { warmed: boolean; note: string };
  assert.equal(b.warmed, false, "a resident model is not warmed again");
  assert.match(b.note, /already resident/);
}

// --- THE POINT: a warm waits behind work already in flight -------------------
{
  be.setLoaded(null);
  await node.pool.first().state.refresh();
  let release!: () => void;
  be.hold(new Promise<void>((r) => (release = r)));

  const chat = fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "alpha", messages: [] }),
  });
  await new Promise((r) => setTimeout(r, 60));   // let it take the only slot

  const before = be.seen.length;
  const warming = warmReq(url, "beta");
  await new Promise((r) => setTimeout(r, 120));  // a queue-jumper would land here
  assert.ok(
    !be.seen.slice(before).includes("warm:beta"),
    "a warm must NOT dispatch while the single slot is held by a generation",
  );

  release();
  be.hold(null);
  await chat;
  const b = (await (await warming).json()) as { warmed: boolean; waitedMs: number };
  assert.equal(b.warmed, true, "and it still runs once the slot frees");
  assert.ok(b.waitedMs >= 0, "it reports how long it waited");
  assert.ok(be.seen.includes("warm:beta"), "the probe happened, after the chat");
}

// --- a non-evicting backend has nothing to do --------------------------------
{
  const be2 = swapBackend();
  await be2.listen();
  const c2 = parseConfig({ name: "s", backend: { url: be2.url(), kind: "single" }, });
  const n2 = createNode(c2, silentLogger);
  const u2 = await listen(n2);
  await n2.pool.first().state.refresh();
  const b = (await (await warmReq(u2, "alpha")).json()) as { warmed: boolean; note: string };
  assert.equal(b.warmed, false, "a single backend keeps its model resident");
  assert.match(b.note, /nothing to warm/);
  await n2.close(); be2.close();
}

// --- the warm lane must not capture peer traffic -----------------------------
// peerLane defaults to the lowest-priority lane, and warm IS the lowest by
// construction — so adding it silently filed every peer's inference behind
// speculative preloading until this was excluded.
{
  const c = parseConfig({
    name: "h", backend: { url: be.url() },
    peerTokens: { g: "t" }, share: ["alpha"],
    scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 } } },
  });
  assert.equal(c.peerLane, "batch", "peers go to the lowest REAL lane, not warm");
  const explicit = parseConfig({
    name: "h", backend: { url: be.url() },
    peerTokens: { g: "t" }, share: ["alpha"], peerLane: "warm",
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  assert.equal(explicit.peerLane, "warm", "but you can still say so on purpose");
}

// --- a peer may ASK, and may be DECLINED -------------------------------------
// The asymmetry is the design: a local warm queues happily because it is your
// box, but a peer holding a connection open across your queue for speculative
// work — and evicting your resident model at a moment you did not choose — is
// something you get to refuse.
{
  const hostBe = swapBackend();
  await hostBe.listen();
  const hostCfg = parseConfig({
    name: "host", backend: { url: hostBe.url(), kind: "llama-swap" },
    peerTokens: { guest: "gtok" }, share: ["alpha"],
    scheduler: { concurrency: 1, lanes: { chat: { priority: 0 } } },
  });
  const host = createNode(hostCfg, silentLogger);
  const hostUrl = await listen(host);
  await host.pool.first().state.refresh();

  const asGuest = (model: string) =>
    fetch(`${hostUrl}/v1/warm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer gtok" },
      body: JSON.stringify({ model }),
    });

  // shared + idle -> honoured
  hostBe.setLoaded(null);
  await host.pool.first().state.refresh();
  {
    const r = await asGuest("alpha");
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { warmed: boolean }).warmed, true, "an idle host honours it");
  }

  // not shared -> refused, same gate chat uses
  {
    const r = await asGuest("beta");
    assert.equal(r.status, 403, "a peer cannot warm what you did not lend");
  }

  // busy -> declined, not queued
  {
    hostBe.setLoaded(null);
    await host.pool.first().state.refresh();
    let rel!: () => void;
    hostBe.hold(new Promise<void>((r) => (rel = r)));
    const busy = fetch(`${hostUrl}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "alpha", messages: [] }),
    });
    await new Promise((r) => setTimeout(r, 60));

    const t0 = Date.now();
    const r = await asGuest("alpha");
    const waited = Date.now() - t0;
    assert.equal(r.status, 503, "a busy host declines rather than queueing a peer");
    const b = (await r.json()) as { declined: boolean; warmed: boolean };
    assert.equal(b.declined, true);
    assert.equal(b.warmed, false);
    assert.ok(waited < 300, `declined promptly, not held on the queue (waited ${waited}ms)`);

    rel(); hostBe.hold(null); await busy;
  }

  // and the capability is advertised, so a caller can tell support from a 404
  {
    const r = await fetch(`${hostUrl}/peer/hello`, { headers: { Authorization: "Bearer gtok" } });
    const b = (await r.json()) as { capabilities?: string[] };
    assert.ok(b.capabilities?.includes("warm"), "hello advertises warm support");
  }

  await host.close(); hostBe.close();
}

// --- a full lane is 429, not 502 ---------------------------------------------
// A caller that retries on rate limits but not on server errors would give up
// on a queue that only needed a moment.
{
  const be3 = swapBackend();
  await be3.listen();
  const c3 = parseConfig({
    name: "f", backend: { url: be3.url(), kind: "llama-swap" },
    scheduler: { concurrency: 1, maxPerLane: 1, lanes: { chat: { priority: 0 } } },
  });
  const n3 = createNode(c3, silentLogger);
  const u3 = await listen(n3);
  await n3.pool.first().state.refresh();

  let rel!: () => void;
  be3.hold(new Promise<void>((r) => (rel = r)));
  // occupy the slot, then fill the warm lane past maxPerLane
  const busy = fetch(`${u3}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "alpha", messages: [] }),
  });
  await new Promise((r) => setTimeout(r, 60));
  const first = warmReq(u3, "beta");
  await new Promise((r) => setTimeout(r, 40));
  const second = await warmReq(u3, "beta");
  assert.equal(second.status, 429, "a full warm lane is retryable, not a server error");
  const err = (await second.json()) as { error: { type: string } };
  assert.equal(err.error.type, "rate_limit_error");

  rel(); be3.hold(null);
  await busy; await first.catch(() => {});
  await n3.close(); be3.close();
}

// --- unknown callers and empty bodies ----------------------------------------
{
  const r = await fetch(`${url}/v1/warm`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(r.status, 400, "model is required");
}

await node.close();
be.close();
console.log("warm.test.ts ok");
