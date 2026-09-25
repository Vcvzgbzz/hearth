/**
 * A health check that can say no.
 *
 * `/healthz` answered `{ok: true}` unconditionally: every backend dead, every
 * peer gone, and it still read healthy. The only thing it could tell a probe
 * was that the socket accepts connections, which the probe already knew from
 * having got a reply at all.
 *
 * What it is built on matters as much as that it exists. The tempting signal is
 * `answering()` -- "something came back from this backend lately" -- and it is
 * wrong: on a quiet box nothing comes back from anything, so a healthy node
 * reads silent across the board, even with a model resident. A probe built on that would have gone red and stayed red.
 *
 * The event stream is the real signal. Where one is held open, a backend going
 * away drops it; where there is none, hearth does not probe and says so rather
 * than inventing a verdict.
 *
 *     npx tsx test/healthz.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

interface Health {
  ok: boolean;
  name: string;
  backends: { total: number; watched: number; connected: number };
  peers: { total: number; up: number };
}

/** A llama-swap that pushes one snapshot and then holds the stream open. */
const swapBackend = () => {
  let live: ServerResponse | null = null;
  const s = createServer((req, res) => {
    if (req.url === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const snapshot = JSON.stringify([{ model: "m", state: "ready" }]);
      res.write(`data: ${JSON.stringify({ type: "modelStatus", data: snapshot })}\n\n`);
      live = res;
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { s, drop: () => live?.destroy() };
};

const start = async (cfg: Record<string, unknown>) => {
  const node = createNode(parseConfig(cfg), silentLogger);
  node.start();
  const base = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
  );
  return { node, base };
};

const health = async (base: string) => {
  const r = await fetch(`${base}/healthz`);
  return { status: r.status, body: (await r.json()) as Health };
};

/** Poll until the predicate holds or we give up, so a reconnect race cannot
 *  make this flaky in either direction. */
const until = async (base: string, want: (h: Health) => boolean, ms = 4_000) => {
  const t0 = Date.now();
  for (;;) {
    const h = await health(base);
    // Guarded, so an endpoint that answers a DIFFERENT shape (the unconditional
    // `{ok, name}` this replaced) fails as an assertion naming the shape rather
    // than as a TypeError inside a predicate.
    assert.ok(h.body.backends, `/healthz must report backend counts, got ${JSON.stringify(h.body)}`);
    if (want(h.body) || Date.now() - t0 > ms) return h;
    await new Promise((r) => setTimeout(r, 50));
  }
};

// --- a watched backend, connected ------------------------------------------
{
  const { s, drop } = swapBackend();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const { node, base } = await start({
    name: "hz",
    backends: [{ name: "swap", url, kind: "llama-swap" }],
  });

  const up = await until(base, (h) => h.backends.connected > 0);
  assert.equal(up.status, 200);
  assert.equal(up.body.ok, true);
  assert.deepEqual(up.body.backends, { total: 1, watched: 1, connected: 1 });

  // --- and the same backend, gone ------------------------------------------
  // The stream drops. Nothing was asked of the backend to discover that, which
  // is the point: the connection was already there being maintained.
  drop();
  const down = await until(base, (h) => !h.ok);
  assert.equal(down.status, 503, "a probe can finally learn something it did not know");
  assert.equal(down.body.ok, false);
  assert.equal(down.body.backends.connected, 0);
  assert.equal(down.body.backends.watched, 1, "still watching it — it is lost, not unwatched");

  await node.close();
  s.closeAllConnections();
  s.close();
}

// --- nothing watchable is not the same as nothing working ------------------
// A box of CPU sidecars is a legitimate config. hearth never contacts one
// unless something is being asked of it, so it has no evidence either way and
// must not manufacture a verdict — an alert that fires on a working box is
// worse than the unconditional `true` this replaced.
{
  const { node, base } = await start({
    name: "hz2",
    backends: [
      { name: "guard", url: "http://127.0.0.1:9", kind: "single", serves: ["guard"] },
      { name: "tts", url: "http://127.0.0.1:9", kind: "none", serves: ["tts"] },
    ],
  });

  const h = await health(base);
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true, "no evidence is not evidence of failure");
  assert.deepEqual(h.body.backends, { total: 2, watched: 0, connected: 0 },
    "and it says plainly that it is watching nothing, so the check is weak here");

  await node.close();
}

// --- counts, never names ---------------------------------------------------
// Unauthenticated, on a port that may be bound wide. What is loaded, what is
// served and who the peers are stay behind the page's gate.
{
  const { s } = swapBackend();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { node, base } = await start({
    name: "hz3",
    backends: [{
      name: "secret-backend", kind: "llama-swap",
      url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
      serves: ["secret-model"],
    }],
    peers: [{ name: "secret-peer", url: "http://127.0.0.1:9", token: "t", models: { "secret-model": "x" } }],
  });

  const raw = await (await fetch(`${base}/healthz`)).text();
  for (const leak of ["secret-backend", "secret-model", "secret-peer"]) {
    assert.ok(!raw.includes(leak), `${leak} must not appear in an unauthenticated body`);
  }
  const h = JSON.parse(raw) as Health;
  assert.equal(h.peers.total, 1, "the count is fine; the name is not");
  assert.equal(h.name, "hz3", "our own name stays — a peer already knows it");

  await node.close();
  s.closeAllConnections();
  s.close();
}

// --- and the same signal, as the page reads it -----------------------------
// `answering` is the page-facing half of this finding, and it had the same
// bug: frames arrive only when something CHANGES, so a connected backend on a
// quiet box went silent by the clock after a minute and the console drew it a
// red "nothing back in a minute". An open stream is a live fact about the
// backend regardless of how long it has been since it said anything.
{
  const { s, drop } = swapBackend();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { node, base } = await start({
    name: "hz4",
    backends: [
      { name: "swap", url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, kind: "llama-swap" },
      { name: "side", url: "http://127.0.0.1:9", kind: "single", serves: ["side"] },
    ],
  });

  const backends = async () => {
    const d = (await (await fetch(`${base}/ui/data`)).json()) as {
      net: { nodes: { self?: boolean; backends?: { name: string; answering?: boolean }[] }[] };
    };
    const list = d.net.nodes.find((n) => n.self)!.backends!;
    return Object.fromEntries(list.map((b) => [b.name, b]));
  };

  await until(base, (h) => h.backends.connected > 0);
  assert.equal((await backends()).swap!.answering, true);
  assert.ok(!("answering" in (await backends()).side!),
    "a backend we never contact is not reported quiet — we simply cannot tell");

  // Two minutes on, with nothing having happened. The old measure was purely
  // this clock, so it read false here while the stream was open and fine.
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    assert.equal((await backends()).swap!.answering, true,
      "an idle stream is still a connected backend");
  } finally {
    Date.now = realNow;
  }

  // And when it genuinely goes, it still says so -- but only once the clock
  // agrees. A dropped stream alone is NOT enough: we heard from it a moment
  // ago, and the timestamp is the fallback precisely so that a reconnect in
  // progress does not flash a fault. Both have to be true, which is why this
  // needs the stream gone AND time moved on.
  drop();
  await until(base, (h) => h.backends.connected === 0);
  assert.equal((await backends()).swap!.answering, true,
    "a stream that just dropped is not yet a backend we have not heard from");

  Date.now = () => realNow() + 120_000;
  try {
    assert.equal((await backends()).swap!.answering, false,
      "gone, and long enough ago to say so");
  } finally {
    Date.now = realNow;
  }

  await node.close();
  s.closeAllConnections();
  s.close();
}

console.log("healthz.test.ts ok");
