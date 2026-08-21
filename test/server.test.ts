/**
 * End to end: two hearth nodes and two fake backends in one process.
 *
 * The unit tests prove each piece in isolation, which is exactly how a system
 * ships broken. Every part correct, wired to the wrong thing. So this one
 * asserts the claims a user would actually make: my prompt ran on his GPU, it
 * came back streamed, it didn't queue behind my own work, I never noticed when
 * his box died, and he can't reach anything I didn't offer him.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode, type HearthNode } from "../src/server.js";

/** Pretend inference server. Records what it was asked for, streams SSE back
 *  the way llama.cpp does, and can be told to break. */
function fakeBackend(label: string, catalog: { id: string; state: string }[] = []) {
  const seen: { model: string }[] = [];
  let mode: "ok" | "500" | "hang" = "ok";
  let holdUntil: Promise<void> | null = null;
  // Generations in flight at once. A real GPU can only honestly serve
  // `concurrency` of these, so this is where a queue bypass shows up.
  let live = 0;
  let peak = 0;

  const server = createServer((req, res) => {
    // llama-swap's shape: /running lists what's ready to serve.
    if (req.url === "/running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          running: catalog.filter((m) => m.state === "ready").map((m) => ({ model: m.id, state: "ready" })),
        }),
      );
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: catalog.length > 0 ? catalog.map((m) => ({ id: m.id })) : [{ id: label }],
        }),
      );
      return;
    }
    if (req.url?.startsWith("/upstream/") || req.url === "/unload") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ model: `passthrough:${req.method}:${req.url}` });
        // Echo back a header the client sent and set one only a real backend
        // would, so we can see forwarding work in both directions.
        res.writeHead(200, {
          "Content-Type": "application/json",
          ETag: '"abc123"',
          "Content-Disposition": 'attachment; filename="thing.png"',
        });
        res.end(
          JSON.stringify({
            path: req.url,
            method: req.method,
            body: Buffer.concat(chunks).toString(),
            sawAccept: req.headers.accept ?? null,
            sawRange: req.headers.range ?? null,
          }),
        );
      });
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { model?: string };
        seen.push({ model: body.model ?? "" });
        if (mode === "hang") return;
        if (mode === "500") {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("backend exploded");
          return;
        }
        live++;
        peak = Math.max(peak, live);
        if (holdUntil) await holdUntil;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: {"served_by":"${label}"}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        live--;
      })();
    });
  });

  return {
    server,
    seen,
    setMode: (m: typeof mode) => {
      mode = m;
    },
    hold: (p: Promise<void> | null) => {
      holdUntil = p;
    },
    peak: () => peak,
    resetPeak: () => {
      peak = 0;
    },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function listen(node: HearthNode): Promise<string> {
  return new Promise((ready) => {
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`),
    );
  });
}

async function chat(url: string, body: unknown, token?: string) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------------------
const mine = fakeBackend("my-gpu");
const theirs = fakeBackend("their-gpu");
await mine.listen();
await theirs.listen();

// THEIR node: shares one model, and only that one.
const theirCfg = parseConfig({
  name: "friend",
  backend: { url: theirs.url(), llamaSwapExtras: false },
  peerTokens: { me: "token-from-me" },
  share: ["their-big"],
});
const theirNode = createNode(theirCfg, silentLogger);
const theirUrl = await listen(theirNode);

// MY node: routes `big` to them, under their id.
const myCfg = parseConfig({
  name: "me",
  backend: { url: mine.url(), llamaSwapExtras: false },
  peers: [{ name: "friend", url: theirUrl, token: "token-from-me", models: { big: "their-big" } }],
  models: { big: { policy: "peer", peers: ["friend"], fallbackLocal: true } },
  scheduler: { concurrency: 1, maxPerCaller: 5 },
});
const myNode = createNode(myCfg, silentLogger);
const myUrl = await listen(myNode);
const step = (m: string) => process.stderr.write(`  .. ${m}\n`);
step("nodes up");

// --- the offload actually offloads -----------------------------------------
{
  step("offload");
  await myNode.peers.pollAll();
  const r = await chat(myUrl, { model: "big", messages: [] });
  assert.equal(r.status, 200);
  assert.match(r.text, /their-gpu/, "the answer must come from their backend");
  assert.match(r.text, /\[DONE\]/, "and arrive as the SSE stream the client expects");
  assert.equal(mine.seen.length, 0, "my GPU must not have been touched");
  // Their id, not mine. Getting it wrong 404s against a box you don't own.
  assert.equal(theirs.seen.at(-1)?.model, "their-big");
}

// --- an off-box turn does not wait for my own GPU --------------------------
// The claim the whole design rests on: my long local job must not delay a turn
// that runs on someone else's hardware.
{
  step("no-wait");
  let release!: () => void;
  mine.hold(new Promise<void>((r) => (release = r)));

  const localTurn = chat(myUrl, { model: "local-only", messages: [] });
  await new Promise((r) => setTimeout(r, 50));

  const t0 = Date.now();
  const remoteTurn = await chat(myUrl, { model: "big", messages: [] });
  const waited = Date.now() - t0;

  assert.match(remoteTurn.text, /their-gpu/);
  assert.ok(waited < 300, `off-box turn waited ${waited}ms behind a busy local GPU`);

  release();
  mine.hold(null);
  await localTurn;
}

// --- a peer that fails before the first byte is retried locally ------------
// This is what a dumb TCP forwarder cannot do. The client sees a normal answer
// and never learns the peer was involved.
{
  step("fallback-500");
  theirs.setMode("500");
  const before = mine.seen.length;
  const r = await chat(myUrl, { model: "big", messages: [] });
  assert.equal(r.status, 200, "the client must still get an answer");
  assert.match(r.text, /my-gpu/, "served from my backend after the peer failed");
  assert.equal(mine.seen.length, before + 1);
  // Falling back means asking my backend for MY id, not theirs.
  assert.equal(mine.seen.at(-1)?.model, "big");
  theirs.setMode("ok");
}

// --- falling back from a peer still goes through the queue -----------------
// The off-box job that routed to the peer holds no slot, by design. Running the
// local retry inline would inherit that exemption, so a peer that is up but
// failing would turn every request into an unscheduled local generation,
// concurrency 1 serving two at once, which is the thrash this exists to stop.
{
  step("fallback-queued");
  mine.resetPeak();
  theirs.setMode("500");

  let release!: () => void;
  mine.hold(new Promise<void>((r) => (release = r)));

  // A plain local job takes the only slot.
  const blocker = chat(myUrl, { model: "local-only", messages: [] });
  await new Promise((r) => setTimeout(r, 60));

  // A peer-routed job whose peer fails: the retry must WAIT, not barge in.
  const fell = chat(myUrl, { model: "big", messages: [] });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mine.peak(), 1, `local backend ran ${mine.peak()} generations at once, expected 1`);

  release();
  mine.hold(null);
  const r = await fell;
  assert.equal(r.status, 200);
  assert.match(r.text, /my-gpu/);
  await blocker;
  assert.equal(mine.peak(), 1, "still one at a time after both finished");

  theirs.setMode("ok");
}

// --- a down peer routes home, quietly --------------------------------------
{
  step("peer-down");
  // node.close(), not server.close(): the latter leaves keep-alive sockets open,
  // so my node would happily keep using a connection to a "closed" server. That
  // is how this test first hung, and it is worth knowing it can happen.
  await theirNode.close();
  theirs.setMode("hang");
  await myNode.peers.pollAll();
  await myNode.peers.pollAll();

  const before = mine.seen.length;
  const r = await chat(myUrl, { model: "big", messages: [] });
  assert.equal(r.status, 200);
  assert.match(r.text, /my-gpu/);
  assert.equal(mine.seen.length, before + 1);
}

// --- lending is opt-in, per model ------------------------------------------
// A peer must not reach a model that was never offered, even holding a valid
// token. Checked against a fresh node since the last block closed the other.
{
  step("share-gate");
  // Its own backend: `theirs` is still wedged from the block above, and a guard
  // test should fail on the gate, not on a hung upstream.
  const guardBackend = fakeBackend("guard-gpu");
  await guardBackend.listen();
  const guardCfg = parseConfig({
    name: "guarded",
    backend: { url: guardBackend.url(), llamaSwapExtras: false },
    peerTokens: { me: "token-from-me" },
    share: ["offered"],
  });
  const guard = createNode(guardCfg, silentLogger);
  const guardUrl = await listen(guard);

  const refused = await chat(guardUrl, { model: "not-offered", messages: [] }, "token-from-me");
  assert.equal(refused.status, 403, "an unshared model must be refused");
  assert.match(refused.text, /does not share/);

  const wrongToken = await chat(guardUrl, { model: "offered", messages: [] }, "nope");
  assert.equal(wrongToken.status, 401, "an unknown token must be refused");

  // No credential at all, over loopback, with no apiKeys configured: allowed,
  // and served locally. This is the "just me on this box" default.
  const bare = await chat(guardUrl, { model: "offered", messages: [] });
  assert.equal(bare.status, 200, "loopback with no keys configured is the local default");
  assert.match(bare.text, /guard-gpu/);

  await guard.close();
  guardBackend.close();
}

// --- unknown paths pass through to the backend -----------------------------
// A backend is more than /v1: llama-swap serves /unload and
// /upstream/<model>/<anything>, and an app already using those must not break
// just because it now points here. Verbatim means verbatim: method and body.
{
  step("passthrough");
  const gen = await fetch(`${myUrl}/upstream/some-image-model/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "a cat" }),
  });
  assert.equal(gen.status, 200);
  const got = (await gen.json()) as { path: string; method: string; body: string };
  assert.equal(got.path, "/upstream/some-image-model/generate");
  assert.equal(got.method, "POST", "the method must survive the hop");
  assert.equal(JSON.parse(got.body).prompt, "a cat", "and so must the body, byte for byte");

  // A GET with no body, and a query string that has to survive too.
  const unload = await fetch(`${myUrl}/unload`);
  assert.equal(unload.status, 200);
  assert.equal(((await unload.json()) as { method: string }).method, "GET");

  // "Verbatim" has to mean headers too, in both directions. Dropping them was
  // invisible on /v1/* and broke exactly the paths this passthrough exists for.
  const hdr = await fetch(`${myUrl}/upstream/x/thing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "image/png", Range: "bytes=0-99" },
    body: "{}",
  });
  assert.equal(hdr.headers.get("etag"), '"abc123"', "upstream response headers must survive");
  assert.equal(hdr.headers.get("content-disposition"), 'attachment; filename="thing.png"');
  const echoed = (await hdr.json()) as { sawAccept: string | null; sawRange: string | null };
  assert.equal(echoed.sawAccept, "image/png", "request headers must survive");
  assert.equal(echoed.sawRange, "bytes=0-99");
}

// --- /network: who has what, and what is warm ------------------------------
// The question this answers: I run A/B/C with A loaded, my friend runs S/A/G
// with G loaded, tell me A and G are available right now.
{
  step("network");
  const mineBe = fakeBackend("mine", [
    { id: "A", state: "ready" },
    { id: "B", state: "stopped" },
    { id: "C", state: "stopped" },
  ]);
  const theirBe = fakeBackend("theirs", [
    { id: "S", state: "stopped" },
    { id: "their-A", state: "stopped" },
    { id: "G", state: "ready" },
  ]);
  await mineBe.listen();
  await theirBe.listen();

  const themCfg = parseConfig({
    name: "friend",
    backend: { url: theirBe.url(), llamaSwapExtras: true },
    peerTokens: { me: "tok" },
    share: ["S", "their-A", "G"],
  });
  const them = createNode(themCfg, silentLogger);
  const themUrl = await listen(them);
  await them.pool.first().state.refresh();

  const usCfg = parseConfig({
    name: "me",
    backend: { url: mineBe.url(), llamaSwapExtras: true },
    // G is mapped; S deliberately is NOT, to prove unmapped capacity is
    // reported rather than silently dropped.
    peers: [{ name: "friend", url: themUrl, token: "tok", models: { A: "their-A", G: "G" } }],
  });
  const us = createNode(usCfg, silentLogger);
  const usUrl = await listen(us);
  await us.pool.first().state.refresh();

  const net = (await (await fetch(`${usUrl}/network`)).json()) as {
    nodes: { name: string; self: boolean; up: boolean; loaded: string[]; serves: string[]; unmapped?: string[]; configured: string[] }[];
    readyNow: string[];
    available: string[];
  };

  assert.deepEqual(net.readyNow, ["A", "G"], "A is warm here, G is warm there");
  assert.ok(net.available.includes("B"), "cold local models are still available");

  const friend = net.nodes.find((n) => n.name === "friend")!;
  assert.equal(friend.up, true);
  assert.deepEqual(friend.loaded, ["G"]);
  // Reported in MY namespace: their `their-A` is my `A`.
  assert.ok(friend.serves.includes("A"), "peer models are translated to my ids");
  assert.deepEqual(friend.unmapped, ["S"], "capacity I cannot reach yet is surfaced, not hidden");

  assert.deepEqual(
    friend.configured,
    ["A", "G"],
    "the configured mapping is reported in my ids",
  );

  // A down peer contributes nothing to readyNow, even though we know its catalog.
  await them.close();
  await us.peers.probeAll();
  await us.peers.probeAll();
  const net2 = (await (await fetch(`${usUrl}/network`)).json()) as {
    readyNow: string[];
    nodes: {
      name: string;
      up: boolean;
      serves: string[];
      configured: string[];
    }[];
  };
  assert.deepEqual(net2.readyNow, ["A"], "an unreachable peer's warm models are not available");

  // THE POINT: unreachable must mean "shown red", never "removed". The node has
  // to survive, and it has to still say WHICH models lost their off-box route —
  // otherwise a peer that is merely down looks identical to one offering
  // nothing, and you cannot tell what the outage actually cost you.
  const downFriend = net2.nodes.find((n) => n.name === "friend");
  assert.ok(downFriend, "an unreachable peer keeps its node instead of vanishing");
  assert.equal(downFriend!.up, false, "and is marked down so the UI draws it red");
  assert.deepEqual(
    downFriend!.configured,
    ["A", "G"],
    "its configured models survive the outage — this is config, not a live claim",
  );
  // `serves` here is STALE, not empty: peers.ts keeps the last good capacity
  // when a probe fails, so a peer that was up still reports what it last said.
  // That is exactly why `configured` had to be its own field — it is the only
  // one that survives the case that actually loses the models: hearth
  // RESTARTING while the peer is down, where capacity was never populated at
  // all. Asserted so nobody "fixes" networkView by falling back to serves.
  assert.ok(
    downFriend!.serves.length > 0,
    "a previously-up peer keeps its last reading, so serves is stale not empty",
  );

  await us.close();
  mineBe.close();
  theirBe.close();
}

// --- a peer does not get to choose your lane, or queue without limit -------
// Lanes express what matters to the operator. A borrower putting `lane: chat`
// in the body used to land ahead of the host's own work, and with no apiKeys
// configured maxPerCaller defaulted to 0, so nothing bounded them but an
// hourly rate a serialized GPU cannot retire.
{
  step("peer-lane");
  const be = fakeBackend("lane-gpu");
  await be.listen();
  const cfg = parseConfig({
    name: "host",
    backend: { url: be.url(), llamaSwapExtras: false },
    peerTokens: { guest: "gtok" },
    share: ["m"],
    scheduler: { concurrency: 1, lanes: { chat: { priority: 0 }, batch: { priority: 100 } } },
  });
  // Defaulted, not configured: the lowest-priority lane.
  assert.equal(cfg.peerLane, "batch");
  assert.equal(cfg.scheduler.maxPerCaller, 0, "no apiKeys, so local callers are uncapped");

  const node = createNode(cfg, silentLogger);
  const url = await listen(node);

  let release!: () => void;
  be.hold(new Promise<void>((r) => (release = r)));

  // A guest asks for the interactive lane. It must not get it.
  void chat(url, { model: "m", lane: "chat", messages: [] }, "gtok");
  await new Promise((r) => setTimeout(r, 60));
  const q1 = node.pool.first().scheduler.view();
  assert.deepEqual(q1.map((j) => j.lane), ["batch"], "peer work is pinned to peerLane");

  // And it is capped, despite maxPerCaller being 0 for local callers.
  const extra = [1, 2, 3, 4].map(() => chat(url, { model: "m", messages: [] }, "gtok"));
  await new Promise((r) => setTimeout(r, 120));
  const mine = node.pool.first().scheduler.view().filter((j) => j.caller === "guest");
  assert.ok(mine.length <= cfg.peerMaxConcurrent, `guest holds ${mine.length}, cap is ${cfg.peerMaxConcurrent}`);

  release();
  be.hold(null);
  await Promise.allSettled(extra);
  await node.close();
  be.close();
}

// --- capacity polling does not spend the inference budget ------------------
// A peer polls /peer/state on a timer. If that shares a budget with real work,
// a healthy peer locks itself out doing nothing but asking whether you are busy
// — and being refused does not stop its poller, so the lockout sustains itself.
{
  step("budgets");
  // A catalogue with something shared and something not, so the filtering
  // assertions below are exercising a real difference rather than an empty set.
  const be = fakeBackend("budget-gpu", [
    { id: "m", state: "stopped" },
    { id: "private-thing", state: "ready" },
  ]);
  await be.listen();
  const cfg = parseConfig({
    name: "tight",
    backend: { url: be.url(), llamaSwapExtras: false },
    peerTokens: { me: "tok" },
    share: ["m"],
    // Deliberately tiny: one inference request and the work budget is spent.
    peerRateLimit: 1,
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.refresh();

  // Well past peerRateLimit, and every one must still be answered.
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${url}/peer/state`, { headers: { Authorization: "Bearer tok" } });
    assert.equal(r.status, 200, `capacity poll ${i + 1} must not be rate capped`);
  }

  // /v1/models is an inventory, and a peer only gets the part it may use.
  const list = (await (
    await fetch(`${url}/v1/models`, { headers: { Authorization: "Bearer tok" } })
  ).json()) as { data: { id: string }[] };
  assert.deepEqual(list.data.map((m) => m.id), ["m"], "a peer must not enumerate the whole catalogue");
  // A local caller still sees everything.
  const localList = (await (await fetch(`${url}/v1/models`)).json()) as { data: { id: string }[] };
  assert.deepEqual(localList.data.map((m) => m.id).sort(), ["m", "private-thing"]);

  // A peer is told nothing about models it cannot use — including which one we
  // happen to have loaded.
  const st = (await (
    await fetch(`${url}/peer/state`, { headers: { Authorization: "Bearer tok" } })
  ).json()) as { serves: string[]; loaded: string[]; resident: string | null };
  assert.deepEqual(st.serves, ["m"]);
  // private-thing IS loaded here, and must appear in neither field.
  assert.deepEqual(st.loaded, [], "an unshared loaded model must not be listed");
  assert.equal(st.resident, null, "nor named as resident");

  // The work budget is still enforced, and separately.
  const first = await chat(url, { model: "m", messages: [] }, "tok");
  assert.equal(first.status, 200);
  const second = await chat(url, { model: "m", messages: [] }, "tok");
  assert.equal(second.status, 429, "inference is still capped at peerRateLimit");

  await node.close();
  be.close();
}

// --- /queue and /healthz ---------------------------------------------------
{
  step("endpoints");
  const health = await fetch(`${myUrl}/healthz`);
  assert.equal(health.status, 200);

  const q = (await (await fetch(`${myUrl}/queue`)).json()) as {
    jobs: unknown[];
    capacity: { slots: number };
  };
  assert.equal(q.capacity.slots, 1);
  assert.ok(Array.isArray(q.jobs));
}

// --- a peer's REFUSAL keeps its own status ---------------------------------
// Regression, 2026-08-15. His node answers `429 too many concurrent jobs in the
// batch lane` when a fan-out exceeds his batch cap. We reported that as 502,
// and a 502 is RETRYABLE by design — it is how a turn survives a model swap —
// so every borrowing client dutifully retried a rate limit. Three refusals
// became six requests aimed at someone else's GPU.
//
// The status class is the whole payload here: 4xx means "stop", 5xx means "try
// again", and collapsing them inverts what the caller does next.
{
  step("peer refusal passthrough");

  let asked = 0;
  const stubborn = createServer((req, res) => {
    if (req.url === "/peer/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          slots: 4, free: 4, running: 0, offbox: 0,
          queued: { chat: 0 }, resident: "their-big",
          loaded: ["their-big"], serves: ["their-big"],
        }),
      );
      return;
    }
    if (req.url === "/peer/hello") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "stubborn", capabilities: [] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      asked++;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "too many concurrent jobs in the batch lane", type: "rate_limit_error" },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => stubborn.listen(0, "127.0.0.1", r));
  const stubbornUrl = `http://127.0.0.1:${(stubborn.address() as AddressInfo).port}`;

  const be = fakeBackend("local-gpu");
  await be.listen();
  const cfg = parseConfig({
    name: "borrower",
    backend: { url: be.url(), llamaSwapExtras: false },
    peers: [{ name: "stubborn", url: stubbornUrl, token: "t", models: { big: "their-big" } }],
    // fallbackLocal FALSE, matching the real fable-711 route: there is no local
    // copy, so the refusal has to reach the caller instead of being absorbed.
    models: { big: { policy: "peer", peers: ["stubborn"], fallbackLocal: false } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.peers.pollAll();

  const r = await chat(url, { model: "big", messages: [] });
  assert.equal(r.status, 429, "a peer's 429 must arrive as 429, NOT as a retryable 502");
  const body = JSON.parse(r.text) as { error: { type: string; message: string } };
  assert.equal(body.error.type, "rate_limit_error", "and be typed as a rate limit");
  assert.match(body.error.message, /stubborn/, "naming which peer refused");
  assert.match(body.error.message, /batch lane/, "and passing their reason through");
  assert.equal(asked, 1, "asked once — a refusal is not retried");

  // The other half of the contract: a genuine peer FAILURE is still ours to
  // report as 502, or a client would stop retrying the swap blips it should.
  const failing = createServer((req, res) => {
    if (req.url === "/peer/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        slots: 4, free: 4, running: 0, offbox: 0,
        queued: { chat: 0 }, resident: "their-big",
        loaded: ["their-big"], serves: ["their-big"],
      }));
      return;
    }
    if (req.url === "/peer/hello") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "failing", capabilities: [] }));
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "it broke", type: "server_error" } }));
  });
  await new Promise<void>((r) => failing.listen(0, "127.0.0.1", r));
  const failingUrl = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;

  const cfg2 = parseConfig({
    name: "borrower2",
    backend: { url: be.url(), llamaSwapExtras: false },
    peers: [{ name: "failing", url: failingUrl, token: "t", models: { big: "their-big" } }],
    models: { big: { policy: "peer", peers: ["failing"], fallbackLocal: false } },
  });
  const node2 = createNode(cfg2, silentLogger);
  const url2 = await listen(node2);
  await node2.peers.pollAll();

  const r2 = await chat(url2, { model: "big", messages: [] });
  assert.equal(r2.status, 502, "a peer's 5xx is still an upstream failure from here");

  await node.close();
  await node2.close();
  be.close();
  stubborn.close();
  failing.close();
}

await myNode.close();
mine.close();
theirs.close();
console.log("server.test.ts ok");
