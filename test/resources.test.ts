/**
 * Backends that share hardware taking turns.
 *
 * A backend is an admission domain, which is the right model right up until two
 * of them are one GPU. Two llama-swap instances pinned to different cards are
 * genuinely independent; a backend running a model that spans both cards is
 * independent of neither, and nothing in the per-backend queues can see that.
 * Both dispatch, both load, and the card is over-committed.
 *
 * `resources:` is the declaration that fixes it, and what is asserted here is
 * that it does so WITHOUT becoming the cross-backend scheduler this project
 * deliberately doesn't have: overlapping backends serialize, disjoint ones are
 * untouched, and a config that declares nothing behaves exactly as before.
 *
 * The two easy things to get wrong, both covered below: a backend must not
 * block on hardware it is already holding (its own concurrency governs that,
 * not the arbiter), and it must not release while a sibling job is still
 * running (or a competitor loads on top of live work).
 *
 *     npx tsx test/resources.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { ResourceArbiter } from "../src/resources.js";
import { Scheduler } from "../src/scheduler.js";
import { createNode } from "../src/server.js";

const lanes = { chat: { priority: 0 } };

/** A job that runs until you let it, so "did B start?" is a real question. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { open, wait: () => p };
}

const tick = () => new Promise((r) => setImmediate(r));

/** Schedulers over one shared arbiter, which is the shape pool.ts builds. */
function pool(concurrency = 1) {
  const arbiter = new ResourceArbiter();
  return (resources: string[]) => new Scheduler({ lanes, concurrency, resources, arbiter });
}

// --- disjoint resources don't interfere -----------------------------------
// The whole point of a second backend is usually something small and
// latency-sensitive. If declaring resources made everything queue behind
// everything, it would have taken that away.
{
  const mk = pool();
  const [s1, s2] = [mk(["gpu0"]), mk(["gpu1"])];
  const g1 = gate();
  let ran2 = false;

  const j1 = s1.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    await g1.wait();
    return 1;
  });
  const j2 = s2.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    ran2 = true;
    return 2;
  });

  await tick();
  assert.equal(ran2, true, "a backend on other hardware runs while the first is busy");
  g1.open();
  assert.deepEqual(await Promise.all([j1, j2]), [1, 2]);
}

// --- overlapping resources serialize --------------------------------------
{
  const mk = pool();
  // The asymmetric case, and the one that motivated all of this: one backend
  // owns a card, the other spans both.
  const [oneCard, bothCards] = [mk(["gpu0"]), mk(["gpu0", "gpu1"])];
  const g = gate();
  let ranBig = false;

  const small = oneCard.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    await g.wait();
    return "small";
  });
  const big = bothCards.submit({ lane: "chat", model: "M", caller: "c" }, async () => {
    ranBig = true;
    return "big";
  });

  await tick();
  await tick();
  assert.equal(ranBig, false, "a backend needing busy hardware waits");

  g.open();
  assert.equal(await small, "small");
  await tick();
  assert.equal(ranBig, true, "and goes as soon as the hardware is released");
  assert.equal(await big, "big");
}

// --- a backend is not blocked by itself -----------------------------------
// The holder is the backend, not the job. `concurrency: 2` already says two
// jobs may run here at once, and the second must not sit waiting on a resource
// the first one is holding on its behalf.
{
  const s = pool(2)(["gpu0"]);
  const g = gate();
  let running = 0;
  const run = async () => {
    running++;
    await g.wait();
    return running;
  };

  const a = s.submit({ lane: "chat", model: "m", caller: "c" }, run);
  const b = s.submit({ lane: "chat", model: "m", caller: "c" }, run);
  await tick();
  assert.equal(running, 2, "both of one backend's own slots are usable");
  g.open();
  await Promise.all([a, b]);
}

// --- and does not release while a sibling still runs -----------------------
// One job finishing is not the backend going idle. Releasing there would let a
// competitor load on top of work that is still in flight.
{
  const arbiter = new ResourceArbiter();
  const mine = new Scheduler({ lanes, concurrency: 2, resources: ["gpu0"], arbiter });
  const other = new Scheduler({ lanes, concurrency: 1, resources: ["gpu0"], arbiter });
  const first = gate();
  const second = gate();
  let ranOther = false;

  const a = mine.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    await first.wait();
    return "a";
  });
  const b = mine.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    await second.wait();
    return "b";
  });
  const c = other.submit({ lane: "chat", model: "n", caller: "c" }, async () => {
    ranOther = true;
    return "c";
  });

  await tick();
  first.open();
  await a;
  await tick();
  await tick();
  assert.equal(ranOther, false, "one job of two finishing does not free the hardware");

  second.open();
  await b;
  await tick();
  assert.equal(ranOther, true, "the last one out releases it");
  assert.equal(await c, "c");
}

// --- eviction runs on the idle->busy edge, before the job ------------------
// Winning the arbitration means nobody else is RUNNING on the hardware, not
// that it is free: a swapping neighbour that finished a minute ago still has
// weights resident. So the hook has to fire before the load, and only when the
// backend actually takes hold.
{
  const arbiter = new ResourceArbiter();
  const order: string[] = [];
  const s = new Scheduler({
    lanes,
    concurrency: 2,
    resources: ["gpu0"],
    arbiter,
    evict: async () => {
      order.push("evict");
    },
  });

  const g = gate();
  const a = s.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    order.push("job-a");
    await g.wait();
    return "a";
  });
  await tick();
  const b = s.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    order.push("job-b");
    return "b";
  });
  g.open();
  await Promise.all([a, b]);

  assert.deepEqual(
    order,
    ["evict", "job-a", "job-b"],
    "evicted once, before the first job, and not again for the second",
  );
}

// --- no resources declared is the old behaviour ----------------------------
// Every config that predates this declares nothing, and none of them should
// gain a way to block.
{
  const arbiter = new ResourceArbiter();
  const s1 = new Scheduler({ lanes, concurrency: 1, arbiter });
  const s2 = new Scheduler({ lanes, concurrency: 1, arbiter });
  const g = gate();
  let ran2 = false;

  const a = s1.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    await g.wait();
    return "a";
  });
  const b = s2.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    ran2 = true;
    return "b";
  });
  await tick();
  assert.equal(ran2, true, "backends that declare nothing compete for nothing");
  g.open();
  await Promise.all([a, b]);
}

// --- the arbiter takes all or nothing --------------------------------------
// A partial take is how two backends each holding half of what they need wait
// on each other forever.
{
  const arbiter = new ResourceArbiter();
  const owner = {};
  const other = {};
  assert.equal(arbiter.acquire(["gpu1"], other), true);
  assert.equal(arbiter.acquire(["gpu0", "gpu1"], owner), false, "contended set is refused");
  assert.equal(arbiter.available(["gpu0"], owner), true, "and nothing was taken from it");
  arbiter.release(other);
  assert.equal(arbiter.acquire(["gpu0", "gpu1"], owner), true);
}

// --- end to end: the overlapping backend is unloaded before we load ---------
{
  let unloaded = 0;
  const backend = createServer((req, res) => {
    if (req.url === "/unload") {
      unloaded++;
      res.end("ok");
      return;
    }
    if (req.url === "/running") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ running: [{ model: "resident", state: "ready" }] }));
      return;
    }
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "resident" }] }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const port = (backend.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  const node = createNode(
    parseConfig({
      name: "resources",
      backends: [
        { name: "cards", url, kind: "llama-swap", resources: ["gpu0"] },
        { name: "spanning", url, kind: "llama-swap", serves: ["big"], resources: ["gpu0", "gpu1"] },
      ],
    }),
    silentLogger,
  );
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

  // Make the neighbour's residency known, so eviction has something to do.
  await Promise.all(node.pool.all().map((b) => b.state.refresh()));

  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "big", messages: [{ role: "user", content: "x" }] }),
  });
  await r.text();
  assert.equal(r.status, 200);
  assert.ok(unloaded >= 1, "the backend sharing gpu0 was unloaded before the spanning model ran");

  node.server.closeAllConnections();
  node.server.close();
  backend.close();
}

console.log("resources.test.ts ok");
