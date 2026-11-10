/**
 * Every queued job says why it waits.
 *
 *   - why?: WaitReason | undefined on running jobs,
 *     and on queued jobs that have no blocker.
 *   - held?: "key" is set only on queued jobs whose key is full.
 *   - WaitReason = "key" | "card" | "hold" | "lane" | "model" | "pool" | "share" | "slots"
 */

import assert from "node:assert/strict";
import { KeyTally, type KeyLimit } from "../src/queue/keytally.js";
import { ResourceArbiter } from "../src/queue/resources.js";
import { Scheduler, type SchedulerOptions } from "../src/queue/scheduler.js";

const lanes = { chat: { priority: 0 }, batch: { priority: 100 } };
const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
const KEY = "key:agent";
const limited = (total: number, model = 0) => (): KeyLimit => ({ total, model });

/** A job that runs until it is let go, and says whether it has started. */
function job(s: Scheduler, opts: { caller?: string; model?: string; limit?: () => KeyLimit; lane?: string; signal?: AbortSignal; offbox?: boolean; fail?: boolean; tokens?: number; claimHardware?: boolean } = {}) {
  let finish!: () => void;
  const out: { started: boolean; finish: () => void; result: Promise<void> } = {
    started: false,
    finish: () => finish(),
    result: undefined as unknown as Promise<void>,
  };
  out.result = s.submit(
    { lane: opts.lane ?? "chat", model: opts.model ?? "m", caller: opts.caller ?? KEY, ...(opts.limit ? { keyLimit: opts.limit } : {}), ...(opts.tokens !== undefined ? { tokens: opts.tokens } : {}), ...(opts.claimHardware !== undefined ? { claimHardware: opts.claimHardware } : {}) },
    () => {
      out.started = true;
      return new Promise<void>((done, fail) => { finish = opts.fail ? () => fail(new Error("backend went away")) : done; });
    },
  );
  out.result.catch(() => {});
  return out;
}

/** Schedulers sharing one tally, woken the way the pool wakes them. */
function fleet(n: number, opts: Partial<SchedulerOptions> = {}) {
  const tally = new KeyTally();
  const list = Array.from({ length: n }, () => new Scheduler({ lanes, concurrency: 2, tally, ...opts }));
  tally.onEnded(() => { for (const s of list) s.kick(); });
  return { tally, list };
}

// Helper to get queued jobs from view
function getQueuedWhy(s: Scheduler | undefined): WaitReason | undefined {
  if (!s) return undefined;
  const view = s.view();
  const queued = view.filter((j) => j.state === "queued");
  if (queued.length === 0) return undefined;
  return queued[0]!.why as WaitReason | undefined;
}

// WaitReason type
type WaitReason = "key" | "card" | "hold" | "lane" | "model" | "pool" | "share" | "slots";

// --- Test: key waits when keyLimit is at 1, one running --------------------------------
{
  const s = fleet(1).list[0]!;
  const first = job(s!, { limit: limited(1) });
  const second = job(s!, { limit: limited(1) });
  await tick();
  assert.equal(first.started, true);
  assert.equal(second.started, false, "the key's second job waits");
  assert.deepEqual(s!.view().filter((j) => j.state === "queued").map((j) => j.held), ["key"], "the queue says why it waits");
  assert.equal(getQueuedWhy(s), "key", "why is key when key is full");
  first.finish();
  await tick();
  assert.equal(second.started, true, "it runs once its key has room");
  second.finish();
}

// --- Test: key beats card -----------------------------------------------------
// Another scheduler holds the card, so both checks block; `key` is the one reported.
{
  const arbiter = new ResourceArbiter();
  const { list: [a, b] } = fleet(2, {
    lanes: { chat: { priority: 0 }, memory: { priority: 90 } },
    resources: ["gpu0"],
    arbiter,
  });
  const here = job(a!, { limit: limited(1), model: "m" });
  await tick();
  assert.equal(here.started, true, "the first job takes the card");
  const there = job(b!, { limit: limited(1), model: "m" });
  await tick();
  assert.equal(there.started, false, "key job waits even when card held elsewhere");
  assert.equal(getQueuedWhy(b!), "key", "why is key even when card held elsewhere");
  here.finish();
  await tick();
  assert.equal(there.started, true, "it runs once its key has room");
  there.finish();
}

// --- Test: card waits when two schedulers on one ResourceArbiter --------------
{
  const arbiter = new ResourceArbiter();
  const { list: [a, b] } = fleet(2, { lanes: { chat: { priority: 0 } }, resources: ["gpu0"], arbiter });
  const aRunner = job(a!, { claimHardware: true });
  const bWaiting = job(b!, { claimHardware: true });
  await tick();
  assert.equal(bWaiting.started, false, "second job waits for the card");
  const view = b!.view();
  const queued = view.filter((j) => j.state === "queued");
  assert.equal(queued.length > 0 ? queued[0]!.why : undefined, "card", "why is card when card is held");
  aRunner.finish();
  await tick();
  assert.equal(bWaiting.started, true, "second job can now start");
  bWaiting.finish();
}

// --- Test: hold waits when heldOff ------------------------------------------
{
  const s = fleet(1, { lanes: { chat: { priority: 0, maxWaitMs: 20 } }, heldOff: (lane: string) => lane === "chat" }).list[0]!;
  const held = job(s!);
  await tick();
  assert.equal(held.started, false, "held job waits when heldOff");
  const view = s.view();
  const queued = view.filter((j) => j.state === "queued");
  assert.equal(queued.length > 0 ? queued[0]!.why : undefined, "hold", "why is hold when heldOff");
}

// --- Test: lane waits when lane ceiling is 1 --------------------------------
{
  const s = fleet(1, { lanes: { memory: { priority: 90, concurrency: 1 } } }).list[0]!;
  const first = job(s!, { lane: "memory" });
  const second = job(s!, { lane: "memory" });
  await tick();
  assert.equal(second.started, false, "second lane job waits");
  const view = s.view();
  const queued = view.filter((j) => j.state === "queued");
  assert.equal(queued.length > 0 ? queued[0]!.why : undefined, "lane", "why is lane when lane is full");
  first.finish();
  await tick();
  assert.equal(second.started, true, "second lane job can now start");
  second.finish();
}

// --- Test: model waits when slots limit is 1 --------------------------------
{
  const s = fleet(1, { concurrency: 4, slots: (model: string) => model === "a" ? 1 : null }).list[0]!;
  const first = job(s!, { model: "a" });
  const second = job(s!, { model: "a" });
  await tick();
  assert.equal(second.started, false, "second model job waits");
  const view = s.view();
  const queued = view.filter((j) => j.state === "queued");
  assert.equal(queued.length > 0 ? queued[0]!.why : undefined, "model", "why is model when slots are full");
  first.finish();
  await tick();
  assert.equal(second.started, true, "second model job can now start");
  second.finish();
}

// --- Test: pool waits when tokens exceed limit --------------------------------
{
  const s = fleet(1, { concurrency: 4, pool: () => 10 }).list[0]!;
  const first = job(s!, { tokens: 8 });
  const second = job(s!, { tokens: 8 });
  await tick();
  assert.equal(second.started, false, "second pool job waits");
  const view = s.view();
  const queued = view.filter((j) => j.state === "queued");
  assert.equal(queued.length > 0 ? queued[0]!.why : undefined, "pool", "why is pool when tokens exceed limit");
  first.finish();
  await tick();
  assert.equal(second.started, true, "second pool job can now start");
  second.finish();
  await tick();
}

// --- Test: share waits when shareAfter is set --------------------------------
{
  const s = fleet(1, { lanes: { chat: { priority: 0, maxWaitMs: 20 } }, shareAfter: () => 60000 }).list[0]!;
  const first = job(s!);
  const second = job(s!);
  await tick();
  assert.equal(second.started, false, "second share job waits");
  const view = s.view();
  const queued = view.filter((j) => j.state === "queued");
  assert.equal(queued.length > 0 ? queued[0]!.why : undefined, "share", "why is share when shareAfter is set");
  first.finish();
  await tick();
  assert.equal(second.started, true, "second share job can now start");
  second.finish();
  await tick();
}

// --- Test: slots waits when concurrency is 1 --------------------------------
// No model declares a ceiling, so the model's own limit is the backend's: the blocks below it
// are not what stops this job, and it is the slots that are taken.
{
  const s = fleet(1, { lanes: { chat: { priority: 0 } }, concurrency: 1 }).list[0]!;
  const first = job(s!, { model: "a" });
  const second = job(s!, { model: "b" });
  await tick();
  assert.equal(second.started, false, "second slots job waits");
  const view = s.view();
  const queued = view.filter((j) => j.state === "queued");
  assert.equal(queued.length > 0 ? queued[0]!.why : undefined, "slots", "why is slots when concurrency is full");
  first.finish();
  await tick();
  assert.equal(second.started, true, "second slots job can now start");
  second.finish();
  await tick();
}

// --- Test: a declared model ceiling is still the model's own ---------------
// The backend has slots going spare and the model declares one: that ceiling is what holds it.
{
  const s = fleet(1, { lanes: { chat: { priority: 0 } }, concurrency: 4, slots: () => 1 }).list[0]!;
  const first = job(s!, { model: "a" });
  const second = job(s!, { model: "b" });
  await tick();
  assert.equal(second.started, false, "second job waits");
  const view = s.view();
  const queued = view.filter((j) => j.state === "queued");
  assert.equal(queued.length > 0 ? queued[0]!.why : undefined, "model", "why is model when the model declares a ceiling");
  first.finish();
  await tick();
  second.finish();
  await tick();
}

// --- Test: running job has no why ------------------------------------------
{
  const s = fleet(1).list[0]!;
  const running = job(s!, {});
  await tick();
  const view = s.view();
  const runningInView = view.find((j) => j.state === "running");
  assert.equal(runningInView?.why, undefined, "running job has no why");
  running.finish();
  await tick();
}

// --- Test: view arms nothing ------------------------------------------
// `next` stops at the model-blocked job and never reaches the share-blocked one, so no share
// timer is pending when `view` reads it. `view` must still schedule nothing.
{
  const s = fleet(1, {
    concurrency: 2,
    slots: (model: string) => model === "a" ? 1 : null,
    shareAfter: () => 60000,
  }).list[0]!;
  const first = job(s, { model: "a" });
  await tick();
  job(s, { model: "a" });
  job(s, { model: "b", lane: "batch" });
  await tick();
  let armed = 0;
  let why: (string | undefined)[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    armed++;
    return real(...args);
  }) as typeof setTimeout;
  try {
    why = s.view().filter((j) => j.state === "queued").map((j) => j.why);
    for (let i = 0; i < 100; i++) s.view();
  } finally {
    globalThis.setTimeout = real;
  }
  assert.deepEqual(why, ["model", "share"], "the view names both blockers");
  assert.equal(armed, 0, "view arms no timer");
  first.finish();
  await tick();
}

// --- Test: position skips held jobs ------------------------------------------
// A key-held job is passed over, so it must not hold a place in line either.
{
  // `spare` declares a ceiling, and a job alone always fits: the free job waits on its own
  // ceiling, which is not the backend the held job shares.
  const s = fleet(1, { slots: (m: string) => m === "spare" ? 1 : null }).list[0]!;
  const limit = limited(1);
  const running = job(s, { limit });
  await tick();
  job(s, { limit });
  job(s, { caller: "key:other", lane: "batch", model: "spare" });
  await tick();
  const queued = s.view().filter((j) => j.state === "queued");
  const heldView = queued.find((j) => j.caller === KEY);
  const freeView = queued.find((j) => j.caller === "key:other");
  assert.equal(heldView?.held, "key", "the same key's job is held");
  assert.equal(freeView?.position, 1, "the free job does not count the held one in front of it");
  running.finish();
  await tick();
}

// --- Test: one view reads each key once, not once per pair -------------------
// `view` runs on every job change and a key read can hash the API keys, so a pass
// must cost one read per queued job, not one per pair.
{
  // Each queued job outranks the one after it, so every pair reaches the score test.
  const measure = async (n: number): Promise<number> => {
    const lanes: Record<string, { priority: number }> = { chat: { priority: 0 } };
    for (let i = 0; i < n; i++) lanes[`q${i}`] = { priority: i + 1 };
    const s = fleet(1, { concurrency: 1, lanes }).list[0]!;
    const blocker = job(s, { model: "hold" });
    await tick();
    let reads = 0;
    const counted = () => {
      reads++;
      return { total: 0, model: 0 };
    };
    for (let i = 0; i < n; i++) job(s, { lane: `q${i}`, model: "m", limit: counted });
    await tick();
    assert.equal(s.view().filter((j) => j.state === "queued").length, n, "every job is queued");
    reads = 0;
    s.view();
    const seen = reads;
    blocker.finish();
    await tick();
    return seen;
  };
  const small = await measure(6);
  const big = await measure(24);
  assert.ok(big <= small * 6, `a view of 24 queued jobs reads ${big} keys (${small} for 6): linear, not square`);
}

console.log("wait-reasons.test.ts ok");
