/**
 * Self-check for per-model concurrency.
 *
 * The reason this exists: llama.cpp decodes one request at a time, so one GPU
 * meant one job. A vLLM entry behind the same llama-swap does not — it answers
 * a batch of sequences in about the time it answers one — and the queue that
 * protects the GPU from thrashing was also throttling that away.
 *
 * The property worth holding onto is that a RAISE never causes a swap. Extra
 * jobs go only to the model already running, so the expensive thing (evicting
 * weights) is as serialized as it ever was.
 *
 * The second half is the same knob pointing down. One llama-swap seat runs its
 * entries with different `--parallel`, so a backend that can hold 4 jobs fronts
 * an 8B started with 2 slots. Dispatching 4 there does not make it serve 4: two
 * queue inside llama.cpp, invisible to this scheduler, which goes on counting
 * them as running and tells a peer the seat is emptier than it is.
 */
import assert from "node:assert/strict";

import { Scheduler } from "../src/scheduler.js";

const lanes = { chat: { priority: 0 }, batch: { priority: 100 } };
const batched = (m: string) => (m === "vllm" ? 4 : null);

/** A job that runs until released, so the next submit has something to pile up
 *  behind. `started` settles only once it is genuinely running. */
function job(s: Scheduler, model: string, log: string[], lane = "chat") {
  let release!: () => void;
  const started = new Promise<void>((ready) => {
    void s.submit({ lane, model, caller: "test" }, () => {
      log.push(model);
      ready();
      return new Promise<void>((done) => {
        release = done;
      });
    });
  });
  return { started, release: () => release() };
}

const tick = () => new Promise((r) => setImmediate(r));

// --- same model batches ----------------------------------------------------
// Four vLLM requests on a concurrency-1 backend all run at once. Serializing
// them is the bug this fixes.
{
  const s = new Scheduler({ lanes, concurrency: 1, slots: batched });
  const log: string[] = [];
  const jobs = [job(s, "vllm", log), job(s, "vllm", log), job(s, "vllm", log), job(s, "vllm", log)];
  await Promise.all(jobs.map((j) => j.started));
  assert.equal(log.length, 4, "all four should be running together");
  assert.equal(s.capacity().running, 4);
  for (const j of jobs) j.release();
}

// --- the ceiling holds -----------------------------------------------------
// batch is a limit, not an invitation. The fifth waits.
{
  const s = new Scheduler({ lanes, concurrency: 1, slots: batched });
  const log: string[] = [];
  const jobs = [job(s, "vllm", log), job(s, "vllm", log), job(s, "vllm", log), job(s, "vllm", log)];
  await Promise.all(jobs.map((j) => j.started));
  const fifth = job(s, "vllm", log);
  await tick();
  assert.equal(log.length, 4, "the fifth must wait for a slot");
  jobs[0]!.release();
  await fifth.started;
  assert.equal(log.length, 5, "and start as soon as one frees up");
  for (const j of jobs.slice(1)) j.release();
  fifth.release();
}

// --- a second model never joins the batch ----------------------------------
// THE safety property. Admitting this one would evict the weights the running
// jobs are using, which is the thrash the queue exists to prevent.
{
  const s = new Scheduler({ lanes, concurrency: 1, slots: batched });
  const log: string[] = [];
  const first = job(s, "vllm", log);
  await first.started;
  const other = job(s, "coder", log);
  await tick();
  assert.deepEqual(log, ["vllm"], "the other model must not run alongside");
  first.release();
  await other.started;
  assert.deepEqual(log, ["vllm", "coder"], "it runs once the batch drains");
  other.release();
}

// --- and a batched model does not jump the queue ---------------------------
// A cold chat turn outranks a warm batch job even though the batch job could
// start immediately. Otherwise `batch` would quietly become priority inversion.
{
  const s = new Scheduler({ lanes, concurrency: 1, slots: batched });
  const log: string[] = [];
  const first = job(s, "vllm", log);
  await first.started;
  const chat = job(s, "coder", log, "chat");
  const more = job(s, "vllm", log, "batch");
  await tick();
  assert.deepEqual(log, ["vllm"], "neither queued job should have started");
  first.release();
  await chat.started;
  assert.deepEqual(log, ["vllm", "coder"], "the chat turn goes first");
  chat.release();
  await more.started;
  more.release();
}

// --- unbatched models are exactly as they were -----------------------------
{
  const s = new Scheduler({ lanes, concurrency: 1, slots: batched });
  const log: string[] = [];
  const first = job(s, "coder", log);
  await first.started;
  const second = job(s, "coder", log);
  await tick();
  assert.deepEqual(log, ["coder"], "concurrency 1 still means one at a time");
  first.release();
  await second.started;
  second.release();
}

// --- capacity is answered per model ----------------------------------------
// A peer scoring its own copy asks about ONE model, and the flat number would
// tell it we are full when we could take 3 more.
{
  const s = new Scheduler({ lanes, concurrency: 1, slots: batched });
  const log: string[] = [];
  assert.deepEqual(
    [s.capacityFor("vllm").slots, s.capacityFor("vllm").free],
    [4, 4],
    "idle backend offers the batched ceiling",
  );
  assert.deepEqual([s.capacityFor("coder").slots, s.capacityFor("coder").free], [1, 1]);
  const first = job(s, "vllm", log);
  await first.started;
  assert.equal(s.capacityFor("vllm").free, 3, "room for three more of the same");
  assert.equal(s.capacity().free, 0, "while the backend as a whole is busy");
  assert.equal(s.capacityFor("coder").free, 0, "and a swap still has to wait");
  first.release();
}

// --- a model may declare FEWER slots than its backend ----------------------
// The mixed `--parallel` seat: concurrency 4 is right for the 3B, and exactly
// 2x too many for the 8B next to it.
{
  const seat = (m: string) => (m === "g8b" ? 2 : m === "g3b" ? 4 : null);
  const s = new Scheduler({ lanes, concurrency: 4, slots: seat });
  const log: string[] = [];
  const jobs = [job(s, "g8b", log), job(s, "g8b", log)];
  await Promise.all(jobs.map((j) => j.started));
  const third = job(s, "g8b", log);
  await tick();
  assert.equal(log.length, 2, "-np 2 means two, even where the backend says four");
  jobs[0]!.release();
  await third.started;
  assert.equal(log.length, 3, "and the third goes as soon as one of its own frees up");
  jobs[1]!.release();
  third.release();
}

// --- its neighbour on the same backend keeps all four ----------------------
{
  const seat = (m: string) => (m === "g8b" ? 2 : m === "g3b" ? 4 : null);
  const s = new Scheduler({ lanes, concurrency: 4, slots: seat });
  const log: string[] = [];
  const jobs = [job(s, "g3b", log), job(s, "g3b", log), job(s, "g3b", log), job(s, "g3b", log)];
  await Promise.all(jobs.map((j) => j.started));
  assert.equal(log.length, 4, "capping one model must not cap the seat");
  for (const j of jobs) j.release();
}

// --- and a model that declares nothing is the backend's number -------------
{
  const seat = (m: string) => (m === "g8b" ? 2 : m === "g3b" ? 4 : null);
  const s = new Scheduler({ lanes, concurrency: 4, slots: seat });
  const log: string[] = [];
  const jobs = [job(s, "plain", log), job(s, "plain", log), job(s, "plain", log), job(s, "plain", log)];
  await Promise.all(jobs.map((j) => j.started));
  assert.equal(log.length, 4, "undeclared inherits concurrency, unchanged");
  for (const j of jobs) j.release();
}

// --- a peer is never told the backend's larger number ----------------------
// The over-commit this is for: 4 free on a model with 2 slots is how a shared
// GPU gets 2x the work it can hold.
{
  const seat = (m: string) => (m === "g8b" ? 2 : null);
  const s = new Scheduler({ lanes, concurrency: 4, slots: seat });
  const log: string[] = [];
  assert.deepEqual(
    [s.capacityFor("g8b").slots, s.capacityFor("g8b").free],
    [2, 2],
    "idle seat offers what the model actually has",
  );
  const other = job(s, "plain", log);
  await other.started;
  assert.deepEqual(
    [s.capacityFor("g8b").slots, s.capacityFor("g8b").free],
    [2, 1],
    "and still its own number with something else resident",
  );
  assert.equal(s.capacity().free, 3, "while the backend as a whole has three");
  other.release();
}

// --- slots never read below the jobs already holding them ------------------
// A number that arrives (or shrinks) mid-flight would otherwise render as
// "4 busy of 2", which reads as a bug in the queue rather than a tightened cap.
{
  let np = 4;
  const s = new Scheduler({ lanes, concurrency: 4, slots: () => np });
  const log: string[] = [];
  const jobs = [job(s, "g8b", log), job(s, "g8b", log), job(s, "g8b", log), job(s, "g8b", log)];
  await Promise.all(jobs.map((j) => j.started));
  np = 2;
  assert.deepEqual(
    [s.capacityFor("g8b").slots, s.capacityFor("g8b").free],
    [4, 0],
    "clamped up to what is in flight, and nothing free",
  );
  for (const j of jobs) j.release();
}

console.log("batch: ok");
