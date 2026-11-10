/**
 * Self-check for `scheduler.lanes.<lane>.concurrency` — a ceiling on how many of
 * a backend's slots one lane may hold at once.
 *
 * The arrangement this exists for: background work that arrives in bulk (a
 * memory service summarising every finished chat) next to interactive work on
 * a seat that batches. Priority orders the QUEUE, and there is no preemption,
 * so without a ceiling the background lane takes every slot that happens to be
 * free and keeps it until its call ends. The interactive work then shares the
 * card with sixteen summaries.
 *
 *     npx tsx test/lanecap.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { ConfigError } from "../src/config/read.js";
import { silentLogger } from "../src/observe/log.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

const lanes = {
  chat: { priority: 0 },
  memory: { priority: 100, concurrency: 2 },
};

/** Let admitted jobs reach their `run`, which the scheduler calls a few microtasks after admitting. */
const settle = () => new Promise<void>((r) => setTimeout(r, 5));

interface Held {
  name: string;
  done: Promise<void>;
  started: () => boolean;
  release: () => void;
}

/** A job that holds its slot until released, and says when it actually started. */
function hold(s: Scheduler, lane: string, name: string, log: string[]): Held {
  let release: (() => void) | null = null;
  const done = s.submit({ lane, model: "seat", caller: name }, () => {
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
async function drain(jobs: Held[]): Promise<void> {
  const left = new Set(jobs);
  while (left.size > 0) {
    await settle();
    const ready = [...left].filter((j) => j.started());
    assert.ok(ready.length > 0, `nothing can start, ${left.size} job(s) stuck: ${[...left].map((j) => j.name).join(", ")}`);
    for (const j of ready) {
      j.release();
      await j.done;
      left.delete(j);
    }
  }
}

// --- the ceiling holds ------------------------------------------------------
// Eight slots free, five background jobs arrive at once: two run, three wait.
{
  const s = new Scheduler({ lanes, concurrency: 8 });
  const log: string[] = [];
  const jobs = ["m1", "m2", "m3", "m4", "m5"].map((n) => hold(s, "memory", n, log));
  await settle();

  assert.deepEqual(log, ["m1", "m2"], "only the lane's two may start, though six more slots are free");
  assert.equal(s.capacity().running, 2);
  assert.equal(s.capacity().queued["memory"], 3);

  jobs[0]!.release();
  await jobs[0]!.done;
  await settle();
  assert.deepEqual(log, ["m1", "m2", "m3"], "a freed lane slot goes to the longest waiter of that lane");
  assert.equal(s.capacity().running, 2, "and the lane is back at its ceiling, not above it");

  await drain(jobs.slice(1));
  assert.deepEqual(log, ["m1", "m2", "m3", "m4", "m5"]);
}

// --- a capped job never holds up the lanes behind it ------------------------
// The case the ceiling would otherwise make worse. A background job that has
// waited long enough outranks a fresh chat turn (aging), so it sits at the head
// of the queue — blocked by its own lane, with slots free. The chat turn behind
// it must start anyway.
{
  const s = new Scheduler({ lanes: { chat: { priority: 0 }, memory: { priority: 100, concurrency: 1 } }, concurrency: 4, agePerSecond: 1000 });
  const log: string[] = [];
  const running = hold(s, "memory", "memory-running", log);
  const waiting = hold(s, "memory", "memory-waiting", log);
  await new Promise((r) => setTimeout(r, 150));
  const chat = hold(s, "chat", "chat", log);
  await settle();

  assert.deepEqual(
    log,
    ["memory-running", "chat"],
    "the chat turn starts while an older, capped background job is ahead of it in the queue",
  );
  await drain([running, waiting, chat]);
}

// --- a lane without a ceiling is untouched ----------------------------------
{
  const s = new Scheduler({ lanes, concurrency: 8 });
  const log: string[] = [];
  const jobs = ["c1", "c2", "c3", "c4", "c5"].map((n) => hold(s, "chat", n, log));
  await settle();
  assert.equal(log.length, 5, "chat declares no ceiling, so it may fill the backend");
  await drain(jobs);
}

// --- the two lanes share the backend ----------------------------------------
// The ceiling is a maximum, not a reservation: sixteen chat turns take all
// sixteen slots and the background lane waits for one like anybody else.
{
  const s = new Scheduler({ lanes, concurrency: 3 });
  const log: string[] = [];
  const chats = ["c1", "c2", "c3"].map((n) => hold(s, "chat", n, log));
  const memory = hold(s, "memory", "m1", log);
  await settle();
  assert.deepEqual(log, ["c1", "c2", "c3"], "no slot is held back for the capped lane");

  chats[0]!.release();
  await chats[0]!.done;
  await settle();
  assert.deepEqual(log, ["c1", "c2", "c3", "m1"]);
  await drain([...chats.slice(1), memory]);
}

// --- a ceiling above the backend's number changes nothing -------------------
{
  const s = new Scheduler({ lanes: { chat: { priority: 0 }, memory: { priority: 100, concurrency: 10 } }, concurrency: 2 });
  const log: string[] = [];
  const jobs = ["m1", "m2", "m3"].map((n) => hold(s, "memory", n, log));
  await settle();
  assert.deepEqual(log, ["m1", "m2"], "the backend's own concurrency still binds");
  await drain(jobs);
}

// --- off-box work holds no slot, so it does not count -----------------------
{
  const s = new Scheduler({ lanes, concurrency: 8 });
  const log: string[] = [];
  let finishAway!: () => void;
  const away = s.submit({ lane: "memory", model: "seat", caller: "peer-job", offbox: true }, () => {
    log.push("away");
    return new Promise<void>((r) => {
      finishAway = r;
    });
  });
  const jobs = ["m1", "m2"].map((n) => hold(s, "memory", n, log));
  await settle();
  assert.deepEqual(log, ["away", "m1", "m2"], "a job running on a peer takes none of this backend's lane slots");
  finishAway();
  await away;
  await drain(jobs);
}

// --- config -----------------------------------------------------------------
{
  const base = { backend: { url: "http://127.0.0.1:9292" } };
  const cfg = parseV1({ ...base, scheduler: { lanes: { chat: { priority: 0 }, memory: { priority: 100, concurrency: 2 } } } });
  assert.equal(cfg.scheduler.lanes["memory"]!.concurrency, 2);
  assert.equal(cfg.scheduler.lanes["chat"]!.concurrency, undefined, "unset means no ceiling");
  assert.equal(cfg.scheduler.lanes["warm"]!.concurrency, undefined, "the lane hearth adds itself has none");
  assert.equal(parseV1(base).scheduler.lanes["batch"]!.concurrency, undefined, "nor do the default lanes");

  for (const bad of [0, -1, 1.5, "2", true]) {
    assert.throws(
      () => parseV1({ ...base, scheduler: { lanes: { chat: { priority: 0 }, memory: { priority: 100, concurrency: bad } } } }),
      (e: unknown) => e instanceof ConfigError && /scheduler\.lanes\.memory\.concurrency/.test(e.message),
      `concurrency: ${JSON.stringify(bad)} must be refused, naming the key`,
    );
  }
}

// --- through a real node ----------------------------------------------------
// The number in the config is the one that binds on the wire: an id pinned to
// the capped lane gets one slot of four, and a chat turn sent after two of them
// reaches the backend while the second is still waiting.
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

  const node = createNode(
    parseV1({
      name: "me",
      backends: [{ name: "swap", url: beUrl, kind: "none", concurrency: 4 }],
      scheduler: { lanes: { chat: { priority: 0 }, memory: { priority: 100, concurrency: 1 } } },
      models: {
        seat: { backend: "swap" },
        recall: { backend: "swap", as: "seat", lane: "memory" },
      },
    }),
    silentLogger,
  );
  const url = await new Promise<string>((ready) => {
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`),
    );
  });
  await node.pool.first().state.refresh();

  const send = (model: string) =>
    fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [] }),
    });
  const sent = [send("recall"), send("recall"), send("seat")];
  for (let i = 0; i < 200 && held.length < 2; i++) await settle();
  await settle();

  const view = node.pool.first().scheduler.view();
  assert.equal(held.length, 2, "the backend holds one background call and the chat turn, not three");
  assert.deepEqual(
    view.filter((j) => j.state === "running").map((j) => j.lane).sort(),
    ["chat", "memory"],
  );
  assert.deepEqual(
    view.filter((j) => j.state === "queued").map((j) => j.lane),
    ["memory"],
    "the second background call waits for its lane, with two slots of the backend still free",
  );

  let finished = false;
  const all = Promise.all(sent).then((rs) => {
    finished = true;
    return rs;
  });
  while (!finished) {
    while (held.length > 0) held.shift()!();
    await settle();
  }
  for (const r of await all) assert.equal(r.status, 200);

  node.server.closeAllConnections();
  node.server.close();
  be.closeAllConnections();
  be.close();
}

console.log("lanecap.test.ts ok");
