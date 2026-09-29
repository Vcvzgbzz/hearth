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
import { BackendState } from "../src/backend.js";
import { BackendPool } from "../src/pool.js";
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

// --- a blocked backend reports NO free slots -------------------------------
// This is not a display detail. `capacity()` is what /peer/state serves, so a
// peer scores us on it: reporting 16 free while another backend holds the card
// sends us work that then sits in the queue, which is precisely the over-commit
// the arbiter exists to prevent. `slots` still describes the backend; `free`
// has to describe this second.
{
  const arbiter = new ResourceArbiter();
  const busy = new Scheduler({ lanes, concurrency: 1, resources: ["gpu0"], arbiter });
  // `batchy` has its own ceiling ABOVE the backend's, which is the only way
  // capacityFor takes its own path — with no override it returns capacity()
  // unchanged and would prove nothing. It is also the dangerous direction: 32
  // advertised free slots on a card somebody else is holding.
  const blocked = new Scheduler({
    lanes,
    concurrency: 16,
    resources: ["gpu0"],
    arbiter,
    slots: (m) => (m === "batchy" ? 32 : null),
  });

  assert.equal(blocked.capacity().free, 16, "idle, so all of them");
  assert.equal(blocked.capacityFor("batchy").free, 32, "and a batching model gets its own ceiling");

  const g = gate();
  const held = busy.submit({ lane: "chat", model: "m", caller: "c" }, async () => {
    await g.wait();
    return 1;
  });
  await tick();

  const cap = blocked.capacity();
  assert.equal(cap.free, 0, "no free slots while another backend holds the card");
  assert.equal(cap.slots, 16, "but it still has 16 slots — free is the live number");
  assert.equal(cap.running, 0, "and it is not running anything, which is the point");
  assert.equal(blocked.capacityFor("batchy").free, 0, "nor does a batching model advertise 32 of them");

  g.open();
  await held;
  await tick();
  assert.equal(blocked.capacity().free, 16, "and they come back when the card does");
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
    if (req.url === "/api/models/unload") {
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

// --- a backend that answers the unload with a refusal has NOT cleared the card
// llama-swap v255 answers 405 to the old POST /unload. Treating that as "done"
// once loaded a 20 GiB model onto a card still holding 17 GiB and hung the
// host. A refusal must surface as a failed eviction, never a silent success.
{
  const refusing = createServer((req, res) => {
    if (req.url === "/api/models/unload") {
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => refusing.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`;
  const b = new BackendState(url, "llama-swap", silentLogger);
  await assert.rejects(b.unload(), /405/, "a refused unload throws");
  refusing.close();
}

// --- a neighbour whose unload never lands is still on the card ------------
// An unload that cannot reach its backend used to be logged and walked past, so
// the load went ahead onto a card that was never cleared. It must fail the job.
{
  const chats: string[] = [];
  const neighbour = createServer((req, res) => {
    if (req.url === "/api/models/unload") {
      req.socket.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/running") res.end(JSON.stringify({ running: [{ model: "resident", state: "ready" }] }));
    else res.end(JSON.stringify({ data: [{ id: "resident" }] }));
  });
  const spanning = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/running") return void res.end(JSON.stringify({ running: [] }));
    if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "big" }] }));
    chats.push(req.url ?? "");
    res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
  });
  const at = async (s: ReturnType<typeof createServer>) => {
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const node = createNode(
    parseConfig({
      name: "stuck",
      backends: [
        { name: "cards", url: await at(neighbour), kind: "llama-swap", resources: ["gpu0"] },
        { name: "spanning", url: await at(spanning), kind: "llama-swap", serves: ["big"], resources: ["gpu0"] },
      ],
    }),
    silentLogger,
  );
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  await Promise.all(node.pool.all().map((b) => b.state.refresh()));

  const r = await fetch(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "big", messages: [{ role: "user", content: "x" }] }),
  });
  await r.text();
  assert.notEqual(r.status, 200, "the job fails while the neighbour is still resident");
  assert.deepEqual(chats, [], "and nothing was loaded on top of it");

  node.server.closeAllConnections();
  node.server.close();
  neighbour.closeAllConnections();
  neighbour.close();
  spanning.close();
}

console.log("resources.test.ts ok");

// --- declared resources: shared hardware is not arbitrated -----------------
// The hazard this removes: `resources:` has always meant "must not share", so
// the only safe way to describe a CPU that six sidecars sit on was to say
// nothing — which is why the console could not draw what they run on. Saying it
// under the old rules would have SERIALIZED them and, worse, unloaded each
// other's models on every dispatch, since taking a resource evicts everyone
// else holding it.
{
  const cfg = parseConfig({
    name: "shared",
    resources: { gpu0: { kind: "gpu" }, cpu: { kind: "cpu", shared: true } },
    backends: [
      { name: "guard", url: "http://127.0.0.1:1", serves: ["guard"], resources: ["cpu"] },
      { name: "judge", url: "http://127.0.0.1:2", serves: ["judge"], resources: ["cpu"] },
      { name: "swapA", url: "http://127.0.0.1:3", serves: ["a"], resources: ["gpu0"] },
      { name: "swapB", url: "http://127.0.0.1:4", serves: ["b"], resources: ["gpu0"] },
    ],
  });
  assert.equal(cfg.resources.cpu!.shared, true);
  assert.equal(cfg.resources.gpu0!.shared, false, "shared is opt-in");

  const p = new BackendPool(cfg, silentLogger);
  const byName = (n: string) => p.resources().find((r) => r.name === n)!;

  // Still DISPLAYED — the whole point. The console must be able to draw what a
  // sidecar runs on.
  assert.deepEqual(byName("cpu").backends.sort(), ["guard", "judge"]);
  assert.equal(byName("cpu").kind, "cpu");
  assert.equal(byName("cpu").shared, true);

  // ...and never arbitrated. Hold the CPU with one backend; the other still
  // starts. This goes through the pool's own schedulers, so it is testing the
  // filtering pool.ts does rather than a list assembled by the test.
  const held = gate();
  let judgeRan = false;
  void p.get("guard")!.scheduler.submit(
    { lane: "chat", model: "guard", caller: "t" }, () => held.wait());
  await tick();
  void p.get("judge")!.scheduler.submit(
    { lane: "chat", model: "judge", caller: "t" }, async () => { judgeRan = true; });
  await tick();
  assert.equal(judgeRan, true, "a shared resource must not serialize the backends on it");
  assert.equal(byName("cpu").holder, null, "and nobody ever holds it");
  held.open();

  // The control: gpu0 was NOT declared shared, so it still excludes.
  const gpuHeld = gate();
  let bRan = false;
  void p.get("swapA")!.scheduler.submit(
    { lane: "chat", model: "a", caller: "t" }, () => gpuHeld.wait());
  await tick();
  void p.get("swapB")!.scheduler.submit(
    { lane: "chat", model: "b", caller: "t" }, async () => { bRan = true; });
  await tick();
  assert.equal(bRan, false, "exclusive hardware still excludes — that is the default");
  gpuHeld.open();
  await tick();

  // An undeclared name keeps meaning what it always did.
  const bare = new BackendPool(parseConfig({
    name: "bare",
    backends: [{ name: "a", url: "http://127.0.0.1:1", serves: ["m"], resources: ["gpuX"] }],
  }), silentLogger);
  assert.equal(bare.resources()[0]!.kind, "gpu", "undeclared is a gpu");
  assert.equal(bare.resources()[0]!.shared, false, "and exclusive");
}

// kind is validated at startup, not discovered as a wrong icon weeks later.
assert.throws(
  () => parseConfig({
    name: "n", resources: { x: { kind: "quantum" } },
    backends: [{ name: "a", url: "http://127.0.0.1:1", serves: ["m"] }],
  }),
  /kind must be gpu, cpu or other/,
);

// --- a busy backend must not starve the one beside it ----------------------
//
// A backend lets go of its hardware every time it goes idle between its own
// jobs, and the arbiter wakes every waiter at once. Take the card back on the
// releasing scheduler's own wake-up and a backend under sustained load holds it
// forever: its neighbour is woken, finds it taken again, and waits — for as
// long as there is work, which under saturation is always.
//
// The bound is a turn. Keep the card while there is work to do, so weights stay
// put and a queue drains at full speed, and yield once the turn is up and
// somebody has actually been waiting.
{
  const order: string[] = [];
  /** Feed A continuously; B asks once, early, and then just waits. */
  const race = async (maxHoldMs: number): Promise<string[]> => {
    order.length = 0;
    const arbiter = new ResourceArbiter({ maxHoldMs });
    const A = new Scheduler({ lanes, concurrency: 1, resources: ["gpu0"], arbiter });
    const B = new Scheduler({ lanes, concurrency: 1, resources: ["gpu0"], arbiter });
    const job = (s: Scheduler, who: string) =>
      s.submit({ lane: "chat", model: "m", caller: who }, async () => {
        await new Promise((r) => setTimeout(r, 4));
        order.push(who);
      });
    const all = [job(A, "A"), job(B, "B")];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3));
      all.push(job(A, "A"));
    }
    await Promise.all(all);
    return [...order];
  };

  // A turn short enough to expire under this load: B gets in part way through.
  const bounded = await race(15);
  const at = bounded.indexOf("B");
  assert.ok(at >= 0, "B must run at all");
  assert.ok(
    at < bounded.length - 1,
    `a saturated neighbour must not hold the card until it runs dry (B ran last of ${bounded.length})`,
  );

  // A turn nothing reaches: the card is never taken away, which is the other
  // half of the policy. Handing it over per job would cost a cold load each
  // time — the tax the queue exists to avoid, moved up a level.
  const sticky = await race(60_000);
  assert.equal(sticky.indexOf("B"), sticky.length - 1,
    "with no expiry, A keeps its weights and drains its queue first");
}

// --- every job of a turn waits for the eviction, not just the first --------
//
// Clearing the neighbours off a card belongs to TAKING the card, not to the one
// job that happened to trigger it. Gate only that job and a backend with room
// for two dispatches the second straight past the eviction and onto hardware
// that has not been cleared — which is the exact over-commit `resources` is for.
{
  const seen: string[] = [];
  const arbiter = new ResourceArbiter();
  const s = new Scheduler({
    lanes, concurrency: 2, resources: ["gpu0"], arbiter,
    evict: async () => {
      seen.push("evict:start");
      await new Promise((r) => setTimeout(r, 15));
      seen.push("evict:done");
    },
  });
  const job = () => s.submit({ lane: "chat", model: "m", caller: "t" }, async () => {
    seen.push("ran");
    await new Promise((r) => setTimeout(r, 2));
  });
  await Promise.all([job(), job()]);
  assert.deepEqual(seen, ["evict:start", "evict:done", "ran", "ran"],
    "nothing may reach the backend while the card is still being cleared");
}

// --- an eviction that fails must not leave us holding the card -------------
//
// The hardware was never actually freed, so continuing to act as its owner
// would put the next job on a card somebody else's weights are still on. The
// jobs that were waiting on it fail (they never reached the backend) and the
// hold goes back, so the next attempt re-evicts rather than inheriting a lie.
{
  const arbiter = new ResourceArbiter();
  let attempts = 0;
  const s = new Scheduler({
    lanes, concurrency: 1, resources: ["gpu0"], arbiter,
    evict: async () => {
      attempts++;
      if (attempts === 1) throw new Error("unload refused");
    },
  });
  await assert.rejects(
    s.submit({ lane: "chat", model: "m", caller: "t" }, async () => {}),
    /unload refused/,
    "a job must fail rather than run on hardware that was not cleared",
  );
  await tick();
  assert.equal(arbiter.available(["gpu0"], {}), true,
    "and the card goes back, so a neighbour is not blocked by our failure");

  // The next attempt is a fresh turn: it evicts again rather than assuming the
  // card is still ours from the attempt that failed.
  let ran = false;
  await s.submit({ lane: "chat", model: "m", caller: "t" }, async () => { ran = true; });
  assert.equal(attempts, 2, "the next turn tries the eviction again");
  assert.equal(ran, true);
}
