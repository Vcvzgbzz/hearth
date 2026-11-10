/**
 * Self-check for changing lanes and order settings while a scheduler runs: `Scheduler.retune`
 * takes new lanes, `agePerSecond`, `warmBonus` and `maxPerLane` without stopping anything, and
 * `PATCH /config` reaches it with no restart.
 *
 *     npx tsx test/live-scheduler.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { QueueFullError, QueueTimeoutError } from "../src/errors.js";
import { createNode } from "../src/server.js";

const settle = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

interface Held {
  name: string;
  done: Promise<void>;
  started: () => boolean;
  release: () => void;
}

/** A job that holds its slot until released, and says when it started. */
function hold(s: Scheduler, lane: string, name: string, log: string[], model = "seat"): Held {
  let release: (() => void) | null = null;
  const done = s.submit({ lane, model, caller: name }, () => {
    log.push(name);
    return new Promise<void>((r) => {
      release = r;
    });
  });
  return {
    name,
    done,
    started: () => release !== null,
    release: () => {
      assert.ok(release, `${name} was released before it started`);
      release();
    },
  };
}

/** Finish everything, in whatever order the scheduler starts it. */
async function finish(jobs: Held[]): Promise<void> {
  const left = new Set(jobs);
  while (left.size > 0) {
    await settle();
    const ready = [...left].filter((j) => j.started());
    assert.ok(ready.length > 0, `nothing can start, stuck: ${[...left].map((j) => j.name).join(", ")}`);
    for (const j of ready) {
      j.release();
      await j.done.catch(() => {});
      left.delete(j);
    }
  }
}

// --- a raised ceiling starts waiting jobs ------------------------------------
{
  const s = new Scheduler({ lanes: { memory: { priority: 0, concurrency: 1 } }, concurrency: 4 });
  const log: string[] = [];
  const jobs = ["m1", "m2", "m3"].map((n) => hold(s, "memory", n, log));
  await settle();
  assert.deepEqual(log, ["m1"], "the ceiling holds the other two");

  s.retune({ lanes: { memory: { priority: 0, concurrency: 3 } } });
  s.kick();
  await settle();
  assert.deepEqual(log, ["m1", "m2", "m3"], "a raised ceiling starts all three");
  await finish(jobs);
}

// --- a lowered ceiling drains -----------------------------------------------
{
  const s = new Scheduler({ lanes: { memory: { priority: 0, concurrency: 3 } }, concurrency: 4 });
  const log: string[] = [];
  const jobs = ["m1", "m2", "m3", "m4"].map((n) => hold(s, "memory", n, log));
  await settle();
  assert.deepEqual(log, ["m1", "m2", "m3"]);

  s.retune({ lanes: { memory: { priority: 0, concurrency: 1 } } });
  s.kick();
  await settle();
  assert.equal(s.capacity().running, 3, "nothing running is stopped");

  jobs[0]!.release();
  jobs[1]!.release();
  await settle();
  assert.equal(s.capacity().running, 1, "two finished and the lane is at its new ceiling");
  assert.deepEqual(log, ["m1", "m2", "m3"], "the queued job has not started");
  await finish(jobs.slice(2));
  assert.deepEqual(log, ["m1", "m2", "m3", "m4"]);
}

// --- a new priority reorders the queue --------------------------------------
{
  const s = new Scheduler({ lanes: { chat: { priority: 0 }, batch: { priority: 100 } }, concurrency: 1, agePerSecond: 0 });
  const log: string[] = [];
  const first = hold(s, "chat", "first", log);
  await settle();
  const batch = hold(s, "batch", "batch", log);
  const chat = hold(s, "chat", "chat", log);
  await settle();

  s.retune({ lanes: { chat: { priority: 100 }, batch: { priority: 0 } }, agePerSecond: 0 });
  first.release();
  await first.done;
  await settle();
  assert.deepEqual(log, ["first", "batch"], "the lane that now ranks first starts next");
  await finish([batch, chat]);
}

// --- warmBonus and agePerSecond change the order ----------------------------
{
  const lanes = { chat: { priority: 0 }, batch: { priority: 30 } };
  const s = new Scheduler({ lanes, concurrency: 1, agePerSecond: 0, warmBonus: 40, warm: (m) => m === "warm-model" });
  const log: string[] = [];
  const running = hold(s, "chat", "running", log, "warm-model");
  await settle();
  const warmBatch = hold(s, "batch", "warm-batch", log, "warm-model");
  const coldChat = hold(s, "chat", "cold-chat", log, "cold-model");
  await settle();

  s.retune({ lanes, agePerSecond: 0, warmBonus: 0 });
  running.release();
  await running.done;
  await settle();
  assert.deepEqual(log, ["running", "cold-chat"], "with no warm bonus the cold chat job outranks the warm batch one");
  await finish([warmBatch, coldChat]);
}
{
  const lanes = { chat: { priority: 0 }, batch: { priority: 100 } };
  const s = new Scheduler({ lanes, concurrency: 1, agePerSecond: 0 });
  const log: string[] = [];
  const running = hold(s, "chat", "running", log);
  await settle();
  const old = hold(s, "batch", "old-batch", log);
  await settle(300);
  const fresh = hold(s, "chat", "fresh-chat", log);
  await settle();

  s.retune({ lanes, agePerSecond: 1000 });
  running.release();
  await running.done;
  await settle();
  assert.deepEqual(log, ["running", "old-batch"], "a higher aging weight lets the older job overtake");
  await finish([old, fresh]);
}

// --- maxPerLane reaches new jobs --------------------------------------------
{
  const s = new Scheduler({ lanes: { chat: { priority: 0 } }, concurrency: 1, maxPerLane: 5 });
  const log: string[] = [];
  const running = hold(s, "chat", "running", log);
  await settle();
  const queued = hold(s, "chat", "queued", log);
  await settle();

  s.retune({ lanes: { chat: { priority: 0 } }, maxPerLane: 1 });
  await assert.rejects(
    s.submit({ lane: "chat", model: "seat", caller: "late" }, async () => {}),
    (e: unknown) => e instanceof QueueFullError && e.reason === "lane_full",
    "the lane already holds one waiting job, which is the new limit",
  );
  await finish([running, queued]);
}

// --- maxWaitMs reaches new jobs only ----------------------------------------
{
  const s = new Scheduler({ lanes: { chat: { priority: 0 } }, concurrency: 1 });
  const log: string[] = [];
  const running = hold(s, "chat", "running", log);
  await settle();
  const before = hold(s, "chat", "before", log);
  await settle();

  s.retune({ lanes: { chat: { priority: 0, maxWaitMs: 20 } } });
  const after = hold(s, "chat", "after", log);
  const afterFailed = after.done.then(() => null, (e: unknown) => e);
  await settle(80);
  assert.ok((await afterFailed) instanceof QueueTimeoutError, "a job queued after the change times out");
  assert.equal(s.view().filter((j) => j.state === "queued").length, 1, "the job queued before it is still waiting");

  running.release();
  await settle();
  assert.deepEqual(log, ["running", "before"], "the earlier job survived 80 ms and starts when the slot frees");
  await finish([before]);
}

// --- a removed lane's job still runs ----------------------------------------
{
  const s = new Scheduler({ lanes: { old: { priority: 0 }, chat: { priority: 50 } }, concurrency: 1, agePerSecond: 0 });
  const log: string[] = [];
  const running = hold(s, "chat", "running", log);
  await settle();
  const orphan = hold(s, "old", "orphan", log);
  const known = hold(s, "chat", "known", log);
  await settle();

  s.retune({ lanes: { chat: { priority: 50 } }, agePerSecond: 0 });
  running.release();
  await running.done;
  await settle();
  assert.deepEqual(log, ["running", "known"], "an unknown lane sorts behind every known one");
  await finish([orphan, known]);
  assert.deepEqual(log, ["running", "known", "orphan"], "and its job still runs once a slot frees");
}

// --- PATCH /config reaches a running node -----------------------------------
{
  const held: Array<() => void> = [];
  const be = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "seat" }] }));
      return;
    }
    req.resume();
    req.on("end", () => {
      held.push(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
  });
  await new Promise<void>((r) => be.listen(0, "127.0.0.1", r));
  const beUrl = `http://127.0.0.1:${(be.address() as AddressInfo).port}`;

  const dir = mkdtempSync(join(tmpdir(), "hearth-live-sched-"));
  const cfgPath = join(dir, "hearth.yaml");
  writeFileSync(cfgPath, `name: node-under-test

backends:
  swap:
    url: ${beUrl}
    kind: none
    concurrency: 4

scheduler:
  lanes:
    chat: { priority: 0 }
    memory: { priority: 100, concurrency: 1 }

models:
  seat: { backend: swap }
  recall: { backend: swap, as: seat, lane: memory }

flows:
  rest: { inputs: ["*"], steps: [{ to: { asked: true } }] }
`);

  const cfg = loadConfig(cfgPath);
  const node = createNode(cfg, silentLogger);
  node.start();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  await node.pool.first().state.refresh();

  const sent = [1, 2].map(() =>
    fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "recall", messages: [] }),
    }),
  );
  for (let i = 0; i < 200 && held.length < 1; i++) await settle();
  await settle(50);
  assert.equal(held.length, 1, "the lane's ceiling lets one memory job reach the backend");

  const file = (await (await fetch(`${url}/config`)).json()) as { hash: string };
  const r = await fetch(`${url}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseHash: file.hash, ops: [{ path: ["scheduler", "lanes", "memory", "concurrency"], value: 2 }] }),
  });
  assert.equal(r.status, 200);
  const out = (await r.json()) as { restartPending: string[] };
  assert.deepEqual(out.restartPending, [], "lanes apply without a restart");
  assert.equal(cfg.scheduler.lanes["memory"]!.concurrency, 2, "the node's config holds the new ceiling");
  assert.ok(Object.isFrozen(cfg.scheduler) && Object.isFrozen(cfg.scheduler.lanes["memory"]), "and it stays frozen after the live apply");
  for (let i = 0; i < 200 && held.length < 2; i++) await settle();
  assert.equal(held.length, 2, "the raised ceiling started the waiting job");

  let finished = false;
  const all = Promise.all(sent).then((rs) => {
    finished = true;
    return rs;
  });
  while (!finished) {
    while (held.length > 0) held.shift()!();
    await settle();
  }
  for (const res of await all) assert.equal(res.status, 200);

  await node.close();
  be.closeAllConnections();
  be.close();
}

console.log("live-scheduler.test.ts ok");
