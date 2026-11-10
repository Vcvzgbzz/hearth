/**
 * Per-model ceilings on a backend that keeps several models resident (ollama):
 * a model's `concurrency` counts its own jobs, not the backend's.
 *
 *     npx tsx test/coresident.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/observe/log.js";
import { BackendPool } from "../src/queue/pool.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { parseV1 } from "./v1.js";

const lanes = { chat: { priority: 0 }, batch: { priority: 100 } };
/** Two embedders, one request each at a time. */
const one = (m: string) => (m === "nomic" || m === "gemma" ? 1 : null);

/** A job that runs until released. `started` settles only once it is running. */
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

// --- two models run side by side -------------------------------------------
// The bug: gemma was refused because nomic's job was counted against gemma's
// ceiling of 1, so a two-stream backend served one stream.
{
  const s = new Scheduler({ lanes, concurrency: 2, slots: one, coresident: true });
  const log: string[] = [];
  const nomic = job(s, "nomic", log);
  await nomic.started;
  const gemma = job(s, "gemma", log);
  await tick();
  assert.deepEqual(log, ["nomic", "gemma"], "a different model has its own slot");
  nomic.release();
  gemma.release();
}

// --- the same model still takes turns ---------------------------------------
// One request per model is the whole point: the second nomic call waits HERE,
// as a wait hearth can see, instead of inside ollama as a slow call.
{
  const s = new Scheduler({ lanes, concurrency: 2, slots: one, coresident: true });
  const log: string[] = [];
  const first = job(s, "nomic", log);
  await first.started;
  const second = job(s, "nomic", log);
  await tick();
  assert.deepEqual(log, ["nomic"], "a model with one slot runs one job");
  first.release();
  await second.started;
  assert.deepEqual(log, ["nomic", "nomic"], "and the next goes when it frees up");
  second.release();
}

// --- a job waiting on its own model does not hold up the other model --------
// nomic#2 is older, so it ranks first — but it is waiting for NOMIC's slot, not
// for the backend. Stopping the queue at it leaves gemma's slot idle for a
// whole nomic call, which is the wait this exists to remove. Letting gemma past
// costs nomic#2 nothing: it becomes runnable the moment a nomic job ends, and
// that same moment frees the backend slot it needs.
{
  const s = new Scheduler({ lanes, concurrency: 2, slots: one, coresident: true });
  const log: string[] = [];
  const first = job(s, "nomic", log);
  await first.started;
  const second = job(s, "nomic", log);
  await tick();
  const gemma = job(s, "gemma", log);
  await tick();
  assert.deepEqual(log, ["nomic", "gemma"], "gemma runs past the queued nomic job");
  first.release();
  await second.started;
  assert.deepEqual(log, ["nomic", "gemma", "nomic"], "and nomic#2 still goes the moment nomic frees up");
  second.release();
  gemma.release();
}

// --- capacity is answered for the model that was asked about ----------------
// gemma being busy says nothing about nomic: reporting nomic full while its
// slot sits idle is the same miscount, told to the status page and to peers.
{
  const s = new Scheduler({ lanes, concurrency: 2, slots: one, coresident: true });
  const log: string[] = [];
  assert.deepEqual([s.capacityFor("nomic").slots, s.capacityFor("nomic").free], [1, 1]);
  const gemma = job(s, "gemma", log);
  await gemma.started;
  assert.deepEqual(
    [s.capacityFor("nomic").slots, s.capacityFor("nomic").free],
    [1, 1],
    "nomic's slot is still free while gemma runs",
  );
  assert.deepEqual(
    [s.capacityFor("gemma").slots, s.capacityFor("gemma").free],
    [1, 0],
    "and gemma's is the one that is taken",
  );
  const nomic = job(s, "nomic", log);
  await nomic.started;
  assert.deepEqual(
    [s.capacityFor("nomic").slots, s.capacityFor("nomic").free],
    [1, 0],
    "one slot, not the backend's two, once both are busy",
  );
  gemma.release();
  nomic.release();
}

// --- a free model slot is still bounded by the backend -----------------------
// Three models behind a backend of two: with two of them busy the third has an
// idle slot of its own and nowhere to run. Its ceiling is the smaller of the two.
{
  const three = (m: string) => (m === "a" || m === "b" || m === "c" ? 1 : null);
  const s = new Scheduler({ lanes, concurrency: 2, slots: three, coresident: true });
  const log: string[] = [];
  const a = job(s, "a", log);
  const b = job(s, "b", log);
  await Promise.all([a.started, b.started]);
  assert.equal(s.capacityFor("c").free, 0, "the backend is full, whatever c has spare");
  const c = job(s, "c", log);
  await tick();
  assert.deepEqual(log, ["a", "b"], "and admission agrees: c waits for a backend slot");
  a.release();
  await c.started;
  b.release();
  c.release();
}

// --- without the flag, nothing changes --------------------------------------
// llama-swap loads one model at a time, so another model's job really does
// occupy the seat this one needs. Same config, no `coresident`: serialized.
{
  const s = new Scheduler({ lanes, concurrency: 2, slots: one });
  const log: string[] = [];
  const nomic = job(s, "nomic", log);
  await nomic.started;
  const gemma = job(s, "gemma", log);
  await tick();
  assert.deepEqual(log, ["nomic"], "the default reading is the backend's total, as before");
  nomic.release();
  await gemma.started;
  gemma.release();
}

// --- the config that needs it gets it ---------------------------------------
// Nobody writes `coresident` in a config: `kind: ollama` already says the
// backend serves a resident set. Through parseConfig and the pool's own
// schedulers, so this tests the wiring rather than a flag the test set itself.
{
  const embedders = (kind: string) => new BackendPool(parseV1({
    name: "n",
    backends: [{ name: "embed", url: "http://127.0.0.1:1", kind, concurrency: 2 }],
    models: {
      nomic: { backend: "embed", concurrency: 1 },
      gemma: { backend: "embed", concurrency: 1 },
    },
  }), silentLogger).get("embed")!.scheduler;

  const ollama = embedders("ollama");
  const log: string[] = [];
  const nomic = job(ollama, "nomic", log);
  await nomic.started;
  const gemma = job(ollama, "gemma", log);
  await tick();
  assert.deepEqual(log, ["nomic", "gemma"], "kind: ollama serves its models side by side");
  nomic.release();
  gemma.release();

  // The control: the same models behind a llama-swap still take turns.
  const swap = embedders("llama-swap");
  const swapLog: string[] = [];
  const first = job(swap, "nomic", swapLog);
  await first.started;
  const other = job(swap, "gemma", swapLog);
  await tick();
  assert.deepEqual(swapLog, ["nomic"], "kind: llama-swap is read exactly as before");
  first.release();
  await other.started;
  other.release();
}

// --- the status page states the backend's streams, not one model's ----------
// The page narrows a backend's headline number to "what the loaded model can
// hold", which is the right figure for a seat that holds ONE model. Ollama holds
// a set: with both embedders loaded at 1 each, picking one of them and showing
// its ceiling drew a two-stream backend as 0/1 while two calls ran side by side.
{
  const fake = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/ps"
      ? { models: [{ name: "nomic:latest" }, { name: "gemma:latest" }] }
      : { models: [], data: [] }));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const pool = new BackendPool(parseV1({
    name: "n",
    backends: [{ name: "embed", url, kind: "ollama", concurrency: 2 }],
    models: {
      nomic: { backend: "embed", as: "nomic:latest", concurrency: 1 },
      gemma: { backend: "embed", as: "gemma:latest", concurrency: 1 },
    },
  }), silentLogger);
  const slot = pool.get("embed")!;
  await slot.state.ensureFresh();
  assert.notEqual(slot.state.resident(), null, "the fake ollama reports a loaded model");
  assert.deepEqual(
    [pool.loadedCapacity(slot).slots, pool.loadedCapacity(slot).free],
    [2, 2],
    "two models loaded side by side are two streams, whatever each one's own ceiling is",
  );
  assert.equal(pool.loadedAggregate().slots, 2, "and the node's headline number agrees");
  fake.closeAllConnections();
  fake.close();
}

console.log("coresident: ok");
