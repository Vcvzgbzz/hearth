/**
 * A key at its jobs at once waits in line. The failures worth catching:
 *
 *   - a key over its limit refused, or let through on a second backend
 *   - a held job blocking other callers, claiming a card, or filling a lane
 *   - a waiter stranded: by a limit raised or gone, or a slot freed on another backend
 *   - the count leaking when a job fails or is cancelled
 */
import assert from "node:assert/strict";

import { KeyTally, type KeyLimit } from "../src/queue/keytally.js";
import { ResourceArbiter } from "../src/queue/resources.js";
import { Scheduler, type SchedulerOptions } from "../src/queue/scheduler.js";
import { QueueFullError } from "../src/errors.js";

const lanes = { chat: { priority: 0 }, batch: { priority: 100 } };
const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
const KEY = "key:agent";
const limited = (total: number, model = 0) => (): KeyLimit => ({ total, model });

/** A job that runs until it is let go, and says whether it has started. */
function job(s: Scheduler, opts: { caller?: string; model?: string; limit?: () => KeyLimit; lane?: string; signal?: AbortSignal; offbox?: boolean; fail?: boolean } = {}) {
  let finish!: () => void;
  const out = { started: false, finish: () => finish(), result: undefined as unknown as Promise<void> };
  out.result = s.submit(
    { lane: opts.lane ?? "chat", model: opts.model ?? "m", caller: opts.caller ?? KEY, ...(opts.limit ? { keyLimit: opts.limit } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.offbox ? { offbox: true } : {}) },
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

// --- a key at its limit waits, and others pass it ----------------------------
{
  const { list: [s] } = fleet(1);
  const first = job(s!, { limit: limited(1) });
  const second = job(s!, { limit: limited(1) });
  const other = job(s!, { caller: "key:other" });
  await tick();
  assert.equal(first.started, true);
  assert.equal(second.started, false, "the key's second job waits");
  assert.equal(other.started, true, "another caller passes it");
  assert.deepEqual(s!.view().filter((j) => j.state === "queued").map((j) => j.held), ["key"], "the queue says why it waits");
  first.finish();
  await tick();
  assert.equal(second.started, true, "it runs once its key has room");
  second.finish();
  other.finish();
}

// --- the limit holds across backends ------------------------------------------
{
  const { list: [a, b] } = fleet(2);
  const here = job(a!, { limit: limited(1) });
  const there = job(b!, { limit: limited(1) });
  await tick();
  assert.equal(here.started, true);
  assert.equal(there.started, false, "one limit, whichever backend the job lands on");
  here.finish();
  await tick();
  assert.equal(there.started, true, "a finish on one backend wakes a waiter on the other");
  there.finish();
}

// --- a model's limit -----------------------------------------------------------
{
  const { list: [s] } = fleet(1, { concurrency: 4 });
  const a1 = job(s!, { model: "a", limit: limited(0, 1) });
  const a2 = job(s!, { model: "a", limit: limited(0, 1) });
  const b1 = job(s!, { model: "b", limit: limited(0, 1) });
  await tick();
  assert.deepEqual([a1.started, a2.started, b1.started], [true, false, true], "one of a at a time, and b is another model");
  a1.finish();
  b1.finish();
  await tick();
  a2.finish();
}

// --- both limits at once ----------------------------------------------------------
{
  const { list: [s] } = fleet(1, { concurrency: 4 });
  const limit = limited(2, 1);
  const jobs = [job(s!, { model: "a", limit }), job(s!, { model: "a", limit }), job(s!, { model: "b", limit }), job(s!, { model: "b", limit })];
  await tick();
  assert.deepEqual(jobs.map((j) => j.started), [true, false, true, false]);
  jobs[0]!.finish();
  jobs[2]!.finish();
  await tick();
  jobs[1]!.finish();
  jobs[3]!.finish();
}

// --- a held job claims no card it cannot use -----------------------------------------
{
  const tally = new KeyTally();
  const arbiter = new ResourceArbiter();
  const elsewhere = new Scheduler({ lanes, tally });
  const a = new Scheduler({ lanes, tally, resources: ["gpu0"], arbiter });
  const b = new Scheduler({ lanes, tally, resources: ["gpu0"], arbiter });
  const running = job(elsewhere, { limit: limited(1) });
  await tick();
  const held = job(a, { limit: limited(1) });
  await tick();
  const other = job(b, { caller: "key:other" });
  await tick();
  assert.equal(held.started, false);
  assert.equal(other.started, true, "the card goes to work that can use it");
  running.finish();
  other.finish();
  await tick();
  a.kick();
  await tick();
  held.finish();
}

// --- a card is not kept for jobs that cannot run ---------------------------------------
{
  const tally = new KeyTally();
  const arbiter = new ResourceArbiter();
  const elsewhere = new Scheduler({ lanes, tally });
  const a = new Scheduler({ lanes, concurrency: 2, tally, resources: ["gpu0"], arbiter });
  const b = new Scheduler({ lanes, tally, resources: ["gpu0"], arbiter });
  const running = job(elsewhere, { limit: limited(1) });
  await tick();
  const passing = job(a, { caller: "key:other" });
  await tick();
  const held = job(a, { limit: limited(1) });
  await tick();
  const waiting = job(b, { caller: "key:third" });
  await tick();
  assert.equal(waiting.started, false, "the card is in use");
  passing.finish();
  await tick();
  assert.equal(waiting.started, true, "with only held jobs left, the card goes to work that can use it");
  waiting.finish();
  running.finish();
  await tick();
  a.kick();
  await tick();
  assert.equal(held.started, true, "and the held job takes it back once its key has room");
  held.finish();
}

// --- a limit raised frees a waiter ----------------------------------------------------
{
  const { list: [s] } = fleet(1);
  let total = 1;
  const limit = () => ({ total, model: 0 });
  const first = job(s!, { limit });
  const second = job(s!, { limit });
  await tick();
  assert.equal(second.started, false);
  total = 2;
  s!.kick();
  await tick();
  assert.equal(second.started, true);
  first.finish();
  second.finish();
}

// --- a limit lowered kills nothing, and starts nothing until under it --------------------
{
  const { list: [s] } = fleet(1, { concurrency: 3 });
  let total = 2;
  const limit = () => ({ total, model: 0 });
  const first = job(s!, { limit });
  const second = job(s!, { limit });
  await tick();
  assert.deepEqual([first.started, second.started], [true, true]);
  total = 1;
  const third = job(s!, { limit });
  await tick();
  assert.equal(third.started, false);
  first.finish();
  await tick();
  assert.equal(third.started, false, "one is still running, and one is the limit");
  second.finish();
  await tick();
  assert.equal(third.started, true);
  third.finish();
}

// --- a key revoked while its jobs wait: they run ---------------------------------------
{
  const { list: [s] } = fleet(1);
  let total = 1;
  const limit = () => ({ total, model: 0 });
  const first = job(s!, { limit });
  const waiting = job(s!, { limit });
  await tick();
  total = 0;
  s!.kick();
  await tick();
  assert.equal(waiting.started, true, "no limit left means nothing to wait for");
  first.finish();
  waiting.finish();
}

// --- waiting on a key is not a stuck backend ------------------------------------------
{
  const { list: [busy, idle] } = fleet(2, { lanes: { chat: { priority: 0, maxWaitMs: 20 } } });
  const running = job(busy!, { limit: limited(1) });
  await tick();
  const waiting = job(idle!, { limit: limited(1) });
  let failed: unknown = null;
  waiting.result.catch((e) => { failed = e; });
  await tick(80);
  assert.equal(failed, null, "the wedged-lane guard does not run against a job its key holds");
  running.finish();
  await tick();
  assert.equal(waiting.started, true);
  waiting.finish();
}

// --- held jobs are not load, and a key's own line has an end ---------------------------
{
  const { list: [s] } = fleet(1, { concurrency: 1, maxPerLane: 2 });
  const limit = limited(1);
  const first = job(s!, { limit });
  await tick();
  const held = [job(s!, { limit }), job(s!, { limit })];
  await tick();
  assert.equal(s!.capacity().queued.chat, 0, "a job its key holds is not queue pressure on this backend");
  const refused = await job(s!, { limit }).result.catch((e: unknown) => e);
  assert.ok(refused instanceof QueueFullError);
  assert.equal(refused.reason, "key_full");
  assert.match(refused.message, /this key's queue is full in the chat lane/);
  const other = job(s!, { caller: "key:other" });
  const another = job(s!, { caller: "key:third" });
  await tick();
  const third = await job(s!, { caller: "key:fourth" }).result.catch((e: unknown) => e);
  assert.ok(third instanceof QueueFullError && third.reason === "lane_full", "the lane still fills, with work that can run");
  // Once its key has room a waiter is simply the oldest job, so the key's two go first.
  first.finish();
  await tick();
  held[0]!.finish();
  await tick();
  held[1]!.finish();
  await tick();
  other.finish();
  await tick();
  another.finish();
}

// --- cancelled while held: no count left behind ----------------------------------------
{
  const { tally, list: [s] } = fleet(1);
  const first = job(s!, { limit: limited(1) });
  const ctrl = new AbortController();
  const waiting = job(s!, { limit: limited(1), signal: ctrl.signal });
  await tick();
  ctrl.abort();
  await assert.rejects(waiting.result);
  first.finish();
  await tick();
  assert.equal(tally.full(KEY, "m", { total: 1, model: 0 }), false);
}

// --- a job that fails gives its count back, and a retry is held the same ----------------
{
  const { tally, list: [a, b] } = fleet(2);
  const failing = job(a!, { limit: limited(1), fail: true });
  await tick();
  assert.equal(tally.full(KEY, "m", { total: 1, model: 0 }), true);
  failing.finish();
  await assert.rejects(failing.result);
  await tick();
  assert.equal(tally.full(KEY, "m", { total: 1, model: 0 }), false, "a failure leaks nothing");
  const retry = job(b!, { limit: limited(1) });
  const next = job(a!, { limit: limited(1) });
  await tick();
  assert.deepEqual([retry.started, next.started], [true, false], "the retry takes the count, and the limit still holds");
  retry.finish();
  await tick();
  next.finish();
}

// --- off-box work never queues, so it is not held or counted ----------------------------
{
  const { tally, list: [s] } = fleet(1);
  const first = job(s!, { limit: limited(1) });
  await tick();
  const away = job(s!, { limit: limited(1), offbox: true });
  await tick();
  assert.equal(away.started, true);
  first.finish();
  await tick();
  assert.equal(tally.full(KEY, "m", { total: 1, model: 0 }), false, "the peer's job holds no count here");
  away.finish();
}

console.log("key-holds.test.ts ok");
