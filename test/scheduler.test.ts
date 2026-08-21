/**
 * Self-check for the scheduler.
 *
 * This is the code that only does anything when two clients arrive at once,
 * which means it is the code least likely to be exercised before it matters.
 * Each case below is a fairness property someone will eventually depend on.
 */
import assert from "node:assert/strict";

import { QueueFullError, Scheduler } from "../src/scheduler.js";

const lanes = {
  chat: { priority: 0 },
  batch: { priority: 100 },
};

/** Hold the slot open until released, so work piles up behind it. Resolves
 *  `started` only once it's genuinely running. Before that submit() dispatches
 *  instantly and nothing ever queues. */
function holdSlot(s: Scheduler, order: string[]) {
  let release!: () => void;
  const started = new Promise<void>((ready) => {
    void s.submit({ lane: "batch", model: "blocker", caller: "sys" }, () => {
      order.push("blocker");
      ready();
      return new Promise<void>((done) => {
        release = done;
      });
    });
  });
  return { started, release: () => release() };
}

// --- lane priority ---------------------------------------------------------
// A chat turn must not sit behind a batch job just because it arrived second.
{
  const s = new Scheduler({ lanes });
  const order: string[] = [];
  const slot = holdSlot(s, order);
  await slot.started;

  const a = s.submit({ lane: "batch", model: "m", caller: "A" }, async () => {
    order.push("batch");
  });
  const b = s.submit({ lane: "chat", model: "m", caller: "B" }, async () => {
    order.push("chat");
  });

  slot.release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["blocker", "chat", "batch"]);
}

// --- aging is the starvation bound -----------------------------------------
// Without it, a steady trickle of chat pins a batch job forever. Weight is
// cranked so the test costs milliseconds instead of the ~100s real tuning implies.
{
  const s = new Scheduler({ lanes, agePerSecond: 1000 });
  const order: string[] = [];
  const slot = holdSlot(s, order);
  await slot.started;

  const old = s.submit({ lane: "batch", model: "m", caller: "A" }, async () => {
    order.push("aged-batch");
  });
  await new Promise((r) => setTimeout(r, 150));
  const fresh = s.submit({ lane: "chat", model: "m", caller: "B" }, async () => {
    order.push("fresh-chat");
  });

  slot.release();
  await Promise.all([old, fresh]);
  assert.deepEqual(
    order,
    ["blocker", "aged-batch", "fresh-chat"],
    "a long-waiting batch job must overtake a newly arrived chat",
  );
}

// --- warm preference -------------------------------------------------------
// Same lane, same age: the job whose model is already loaded goes first, because
// the other one pays a model swap.
{
  const s = new Scheduler({ lanes, resident: () => "loaded-model" });
  const order: string[] = [];
  const slot = holdSlot(s, order);
  await slot.started;

  const cold = s.submit({ lane: "chat", model: "other", caller: "A" }, async () => {
    order.push("cold");
  });
  const warm = s.submit({ lane: "chat", model: "loaded-model", caller: "B" }, async () => {
    order.push("warm");
  });

  slot.release();
  await Promise.all([cold, warm]);
  assert.deepEqual(order, ["blocker", "warm", "cold"]);
}

// --- per-caller cap --------------------------------------------------------
{
  const s = new Scheduler({ lanes });
  const order: string[] = [];
  const slot = holdSlot(s, order);
  await slot.started;

  const first = s.submit(
    { lane: "chat", model: "m", caller: "C", maxPerCaller: 1 },
    async () => {
      order.push("first");
    },
  );
  await assert.rejects(
    s.submit({ lane: "chat", model: "m", caller: "C", maxPerCaller: 1 }, async () => {
      order.push("second");
    }),
    QueueFullError,
    "a second queued job for the same caller is refused",
  );
  // A different caller is unaffected, since the cap is per caller not global.
  const other = s.submit(
    { lane: "chat", model: "m", caller: "D", maxPerCaller: 1 },
    async () => {
      order.push("other");
    },
  );

  slot.release();
  await Promise.all([first, other]);
  assert.deepEqual(order.filter((o) => o === "second"), []);
}

// --- off-box jobs skip the slot -------------------------------------------
// The whole point of routing to a peer: it uses none of this GPU, so it must not
// wait for it.
{
  const s = new Scheduler({ lanes });
  const order: string[] = [];
  const slot = holdSlot(s, order);
  await slot.started;

  const local = s.submit({ lane: "chat", model: "m", caller: "A" }, async () => {
    order.push("local");
  });
  const remote = s.submit(
    { lane: "chat", model: "m", caller: "B", offbox: true },
    async () => {
      order.push("offbox");
    },
  );

  await remote;
  assert.deepEqual(order, ["blocker", "offbox"], "off-box ran while the GPU was held");

  slot.release();
  await local;
  assert.deepEqual(order, ["blocker", "offbox", "local"]);
}

// --- ...but still count against the cap ------------------------------------
// Otherwise "ask for the model that happens to be remote" is a way around the
// limit that governs every other request.
{
  const s = new Scheduler({ lanes });
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });

  const first = s.submit(
    { lane: "chat", model: "m", caller: "E", offbox: true, maxPerCaller: 1 },
    () => held,
  );
  await assert.rejects(
    s.submit(
      { lane: "chat", model: "m", caller: "E", offbox: true, maxPerCaller: 1 },
      async () => {},
    ),
    QueueFullError,
  );

  release();
  await first;

  // Released before the caller resolved, so this succeeds with no tick of grace.
  await s.submit(
    { lane: "chat", model: "m", caller: "E", offbox: true, maxPerCaller: 1 },
    async () => {},
  );
}

// --- concurrency > 1 -------------------------------------------------------
{
  const s = new Scheduler({ lanes, concurrency: 2 });
  let running = 0;
  let peak = 0;
  const jobs = Array.from({ length: 5 }, () =>
    s.submit({ lane: "chat", model: "m", caller: "A" }, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    }),
  );
  await Promise.all(jobs);
  assert.equal(peak, 2, `ran ${peak} at once, expected exactly 2`);
}

// --- abort drops a queued job ----------------------------------------------
{
  const s = new Scheduler({ lanes });
  const order: string[] = [];
  const slot = holdSlot(s, order);
  await slot.started;

  const ctrl = new AbortController();
  const dropped = s.submit(
    { lane: "chat", model: "m", caller: "A", signal: ctrl.signal },
    async () => {
      order.push("should-not-run");
    },
  );
  ctrl.abort();
  await assert.rejects(dropped, /aborted/);

  slot.release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["blocker"]);
}

// --- positions are reported and shrink -------------------------------------
{
  const s = new Scheduler({ lanes });
  const order: string[] = [];
  const slot = holdSlot(s, order);
  await slot.started;

  const seen: number[] = [];
  const job = s.submit(
    {
      lane: "chat",
      model: "m",
      caller: "A",
      onPosition: (p) => seen.push(p),
    },
    async () => {},
  );

  assert.equal(seen.at(-1), 1, "one job ahead: the blocker");
  slot.release();
  await job;
  assert.ok(seen.includes(1), `positions seen: ${seen.join(",")}`);
}

// --- capacity is what a peer polls -----------------------------------------
{
  const s = new Scheduler({ lanes, concurrency: 1, resident: () => "m" });
  const order: string[] = [];
  const slot = holdSlot(s, order);
  await slot.started;

  void s.submit({ lane: "chat", model: "m", caller: "A" }, async () => {});
  const cap = s.capacity();
  assert.equal(cap.slots, 1);
  assert.equal(cap.free, 0, "the blocker holds the only slot");
  assert.equal(cap.running, 1);
  assert.equal(cap.queued.chat, 1);
  assert.equal(cap.resident, "m");

  slot.release();
}

// --- off-box work is bounded too -------------------------------------------
//
// Off-box jobs hold no slot, so they skipped the lane-depth check completely,
// and maxPerCaller is off by default when no apiKeys tell callers apart. That
// left outstanding peer requests with no ceiling: a caller could just keep
// opening sockets until something ran out.
{
  const s = new Scheduler({ lanes, maxPerLane: 3 });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));

  const sent = Array.from({ length: 3 }, () =>
    s.submit({ lane: "chat", model: "m", caller: "A", offbox: true }, () => held),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.capacity().offbox, 3, "all three should be in flight off-box");

  await assert.rejects(
    s.submit({ lane: "chat", model: "m", caller: "A", offbox: true }, async () => {}),
    /queue is full/,
    "the fourth off-box job must be refused, not accepted silently",
  );

  // Off-box depth doesn't touch the local queue, so a peer failing over to a
  // local run never gets refused by the depth its own off-box job added.
  const local = s.submit({ lane: "chat", model: "m", caller: "A" }, async () => "home");
  assert.equal(await local, "home");

  release();
  await Promise.all(sent);
}

console.log("scheduler.test.ts ok");
