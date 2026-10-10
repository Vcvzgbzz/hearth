/**
 * A backend can `hold:` its hardware for an app hearth forwards to but does not schedule. While
 * the app is in use (read off its `activity:` path) the named lanes of every backend sharing
 * that hardware stay queued, or run as `models.<id>.whenHeld`; other lanes take the card as
 * before. The hold ends once the app has been idle for `idleMs`, or stops answering.
 *
 *     npx tsx test/hold.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/log.js";
import { BackendPool } from "../src/pool.js";
import { createNode } from "../src/server.js";
import { Scheduler } from "../src/scheduler.js";
import { parseV1 } from "./v1.js";

const settle = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

/** An app with a queue endpoint, whose running count the test sets. */
function fakeApp() {
  const state = { running: 0 };
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ running: state.running, queued: 0 }));
  });
  return {
    state,
    listen: () => new Promise<string>((ready) =>
      server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

const config = (appUrl: string, idleMs: number, extra: Record<string, unknown> = {}) => parseV1({
  name: "hold",
  resources: { gpu: { kind: "gpu" }, cpu: { kind: "cpu", shared: true } },
  scheduler: { lanes: { chat: { priority: 0 }, memory: { priority: 90 } } },
  backends: [
    { name: "card", url: "http://127.0.0.1:1", kind: "none", serves: ["main"], resources: ["gpu"] },
    {
      name: "app", url: appUrl, kind: "none", resources: ["gpu"],
      activity: { path: "/queue", running: "running", queued: "queued" },
      hold: { lanes: ["memory"], idleMs },
      ...extra,
    },
    { name: "spare", url: "http://127.0.0.1:1", kind: "none", serves: ["small"], resources: ["cpu"] },
  ],
  models: {
    background: { backend: "card", as: "main", lane: "memory", whenHeld: "elsewhere" },
    waits: { backend: "card", as: "main", lane: "memory" },
    elsewhere: { backend: "spare", as: "small" },
  },
});

// --- config ----------------------------------------------------------------
{
  const cfg = config("http://127.0.0.1:1", 60_000);
  assert.deepEqual(cfg.backends[1]!.hold, { lanes: ["memory"], idleMs: 60_000, seat: null }, "the block parses whole");
  assert.equal(cfg.backends[0]!.hold, null, "absent means null");
  assert.equal(cfg.models["background"]!.whenHeld, "elsewhere");
  assert.equal(cfg.models["waits"]!.whenHeld, null, "a model without one waits");

  const app = (over: Record<string, unknown>) => () => parseV1({
    name: "t",
    resources: { gpu: { kind: "gpu" }, cpu: { kind: "cpu", shared: true } },
    backends: [{
      name: "app", url: "http://127.0.0.1:1", kind: "none", resources: ["gpu"],
      activity: { path: "/queue", running: "running" }, hold: { lanes: ["chat"], idleMs: 1000 }, ...over,
    }],
  });
  assert.doesNotThrow(app({}));
  assert.throws(app({ activity: undefined }), /hold needs backends\.app\.activity/, "nothing to read the hold off");
  assert.throws(app({ resources: ["cpu"] }), /needs an exclusive resource/, "shared hardware is never held");
  assert.throws(app({ hold: { lanes: ["nope"], idleMs: 1000 } }), /"nope", which is not in scheduler\.lanes/, "a lane that does not exist");
  assert.throws(app({ hold: { lanes: [], idleMs: 1000 } }), /at least one lane/, "a hold on no lane holds nothing");
  assert.throws(app({ hold: { lanes: ["chat"] } }), /idleMs is required/, "no default for how long idle is idle");

  const model = (whenHeld: string, more: Record<string, unknown> = {}) => () => parseV1({
    name: "t",
    backend: { url: "http://127.0.0.1:1", kind: "none" },
    models: { a: { as: "x", whenHeld }, b: { as: "y", ...more } },
  });
  assert.doesNotThrow(model("b"));
  assert.throws(model("a"), /not another id under models/, "an id cannot stand in for itself");
  assert.throws(model("missing"), /not another id under models/, "the stand-in must be declared");
  assert.throws(model("b", { whenHeld: "a" }), /has a whenHeld of its own/, "no chains");
}

// --- scheduler: a held lane waits without holding up the others -------------
{
  let held = true;
  const s = new Scheduler({
    lanes: { chat: { priority: 0 }, memory: { priority: 90 } },
    concurrency: 4,
    // Aged far past the chat lane, so the held job sits at the head of the queue.
    agePerSecond: 100_000,
    heldOff: (lane) => held && lane === "memory",
  });
  const log: string[] = [];
  const job = (lane: string, name: string) => s.submit({ lane, model: "seat", caller: name }, async () => { log.push(name); });

  const background = job("memory", "background");
  await settle(20);
  const chat = job("chat", "chat");
  await chat;
  assert.deepEqual(log, ["chat"], "the lane that is not held starts past the held job at the head of the queue");
  assert.equal(s.capacity().queued["memory"], 1, "the held job is still queued, not refused");

  held = false;
  s.kick();
  await background;
  assert.deepEqual(log, ["chat", "background"], "once the hold ends, a kick starts it");
}

// --- scheduler: maxWaitMs does not run against a held job --------------------
{
  let held = true;
  const s = new Scheduler({
    lanes: { memory: { priority: 90, maxWaitMs: 40 } },
    concurrency: 1,
    heldOff: () => held,
  });
  let outcome = "waiting";
  void s.submit({ lane: "memory", model: "seat", caller: "a" }, async () => {}).then(
    () => { outcome = "ran"; },
    (e: Error) => { outcome = e.name; },
  );
  await settle(150);
  assert.equal(outcome, "waiting", "held for several times maxWaitMs, and still queued");

  // Hold over, but nothing kicks the queue: the backend is not moving, which is what the guard is for.
  held = false;
  await settle(150);
  assert.equal(outcome, "QueueTimeoutError", "once the hold ends the guard runs again");
}

// --- pool: the hold follows the app's own busy signal -----------------------
{
  const app = fakeApp();
  const url = await app.listen();
  const cfg = config(url, 150);
  const pool = new BackendPool(cfg, silentLogger);
  const [card, holder] = [pool.get("card")!, pool.get("app")!];
  const read = () => holder.state.sampleActivity(holder.cfg.activity!);

  assert.equal(pool.heldOff(card.cfg, "memory"), false, "an app nobody has heard from holds nothing");
  assert.equal(pool.whenHeld("background", "memory"), null);

  // Up and idle is what a restart of hearth or of the app looks like: no one is using it.
  const idle = new BackendPool(cfg, silentLogger);
  const quiet = idle.get("app")!;
  await quiet.state.sampleActivity(quiet.cfg.activity!);
  assert.equal(idle.heldOff(idle.get("card")!.cfg, "memory"), false, "an idle app answering for the first time holds nothing");
  const sinceUp = idle.holds()[0]!.quietMs;
  assert.ok(sinceUp !== null && sinceUp < 1_000, "and is quiet since it began answering");
  idle.stop();

  app.state.running = 1;
  await read();
  app.state.running = 0;
  assert.equal(pool.heldOff(card.cfg, "memory"), true, "a reading that shows work starts the hold");
  assert.equal(pool.heldOff(card.cfg, "chat"), false, "only the lanes it names");
  assert.equal(pool.heldOff(pool.get("spare")!.cfg, "memory"), false, "only backends on its hardware");
  assert.equal(pool.heldOff(holder.cfg, "memory"), false, "never the holder itself");
  assert.equal(pool.whenHeld("background", "memory"), "elsewhere", "a model that names a stand-in runs as it");
  assert.equal(pool.whenHeld("waits", "memory"), null, "one that names none stays queued as itself");
  assert.equal(pool.whenHeld("background", "chat"), null, "and only in a held lane");
  const [view] = pool.holds();
  assert.deepEqual({ backend: view!.backend, resources: view!.resources, lanes: view!.lanes, active: view!.active },
    { backend: "app", resources: ["gpu"], lanes: ["memory"], active: true });
  assert.ok(view!.quietMs !== null && view!.quietMs < 150);

  await settle(200);
  assert.equal(pool.heldOff(card.cfg, "memory"), false, "idle for idleMs: the lanes may start again");
  assert.equal(pool.whenHeld("background", "memory"), null);
  assert.equal(pool.holds()[0]!.active, false);

  // A job showing up renews it. The path is read at most every two seconds.
  app.state.running = 1;
  await settle(2_100);
  await read();
  assert.equal(pool.heldOff(card.cfg, "memory"), true, "work on the app takes the card back for its lanes");

  app.close();
  pool.stop();
}

// --- end to end: a held request is answered by its stand-in ------------------
{
  /** A chat server that says which one it is and which id it was asked for. */
  const fakeChat = (name: string) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const asked = body ? (JSON.parse(body) as { model?: string }).model : undefined;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: asked, choices: [{ message: { role: "assistant", content: name } }] }));
      });
    });
    return {
      listen: () => new Promise<string>((ready) =>
        server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
      close: () => { server.closeAllConnections(); server.close(); },
    };
  };
  const [app, card, spare] = [fakeApp(), fakeChat("card"), fakeChat("spare")];
  const [appUrl, cardUrl, spareUrl] = [await app.listen(), await card.listen(), await spare.listen()];
  const cfg = config(appUrl, 60_000);
  cfg.backends[0]!.url = cardUrl;
  cfg.backends[2]!.url = spareUrl;
  const node = createNode(cfg, silentLogger);
  const url = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));
  const ask = async (model: string) => {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
    return { status: r.status, body: (await r.json()) as { model?: string; choices?: { message: { content: string } }[] } };
  };

  const before = await ask("background");
  assert.equal(before.body.choices?.[0]?.message.content, "card", "no hold: the request runs on its own backend");
  assert.equal(before.body.model, "main");

  // start() begins reading the app, whose work starts the hold.
  app.state.running = 1;
  node.start();
  for (let i = 0; i < 100 && !node.pool.heldOff(node.pool.get("card")!.cfg, "memory"); i++) await settle(20);
  const during = await ask("background");
  assert.equal(during.body.choices?.[0]?.message.content, "spare", "held: the same id is answered by its stand-in");
  assert.equal(during.body.model, "small", "under the id the stand-in goes out as");

  const net = (await (await fetch(`${url}/network`)).json()) as { holds?: { backend: string; active: boolean }[] };
  assert.deepEqual(net.holds?.map((h) => [h.backend, h.active]), [["app", true]], "/network says who holds what");

  await node.close();
  for (const f of [app, card, spare]) f.close();
}

// --- a seat in a model swapper: held from the moment it starts loading -------
// The app answers nothing until its seat is up, a load later. Without `seat` the held lanes
// would get their card back in that window and swap the half-loaded app straight out.
{
  let running: { model: string; state: string }[] = [];
  const swap = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/running" ? { running } : { data: [{ id: "main" }, { id: "image-seat" }] }));
  });
  const swapUrl = await new Promise<string>((ready) =>
    swap.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(swap.address() as AddressInfo).port}`)));
  const cfg = parseV1({
    name: "seat",
    resources: { gpu: { kind: "gpu" } },
    scheduler: { lanes: { chat: { priority: 0 }, memory: { priority: 90 } } },
    backends: [
      { name: "card", url: swapUrl, kind: "llama-swap", resources: ["gpu"] },
      { name: "loader", url: swapUrl, kind: "llama-swap", serves: ["image-seat"], resources: ["gpu"], resident: { yield: false } },
      {
        name: "app", url: "http://127.0.0.1:1", kind: "none", resources: ["gpu"],
        activity: { path: "/queue", running: "running" },
        hold: { lanes: ["memory"], idleMs: 60_000, seat: "image-seat" },
      },
    ],
  });
  assert.equal(cfg.backends[2]!.hold!.seat, "image-seat");
  const pool = new BackendPool(cfg, silentLogger);
  const [card, loader] = [pool.get("card")!, pool.get("loader")!];

  await loader.state.refresh();
  assert.equal(pool.heldOff(card.cfg, "memory"), false, "nothing loading, nothing answering: no hold");

  running = [{ model: "image-seat", state: "starting" }];
  await loader.state.refresh();
  assert.equal(pool.heldOff(card.cfg, "memory"), true, "the seat is loading: the lanes are held before the app can answer");
  assert.equal(pool.heldOff(card.cfg, "chat"), false, "still only the lanes it names");
  assert.equal(pool.holds()[0]!.active, true, "and /network says so");

  running = [{ model: "image-seat", state: "ready" }];
  await loader.state.refresh();
  assert.equal(pool.heldOff(card.cfg, "memory"), true, "just loaded: the hold bridges the moment before the app's first answer");

  const since = loader.state.sinceLoading("image-seat");
  await settle(40);
  pool.holds();
  assert.ok(loader.state.sinceLoading("image-seat") >= since + 30, "the bridge is timed from the load, and reading the status does not restart it");

  // Another model loading on that swapper is not this app's business.
  const other = new BackendPool(cfg, silentLogger);
  running = [{ model: "main", state: "starting" }];
  await other.get("loader")!.state.refresh();
  await other.get("card")!.state.refresh();
  assert.equal(other.heldOff(other.get("card")!.cfg, "memory"), false, "a different model loading holds nothing");

  assert.throws(() => parseV1({
    name: "t", resources: { gpu: { kind: "gpu" } },
    backends: [{ name: "app", url: "http://127.0.0.1:1", kind: "none", resources: ["gpu"],
      activity: { path: "/queue", running: "running" }, hold: { lanes: ["chat"], idleMs: 1000, seat: "nobody" } }],
  }), /which no backend declares in serves/, "a seat nobody loads");

  swap.closeAllConnections();
  swap.close();
  pool.stop();
  other.stop();
}

// --- one backend that is both the swapper's entry and the app ----------------
// Its activity path goes through the swapper, which loads whatever it is asked for: the path
// is read only while the seat is up, and the hold ends the moment the swapper drops the seat.
{
  let running: { model: string; state: string }[] = [];
  let reads = 0;
  const swap = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/running") return void res.end(JSON.stringify({ running }));
    if (req.url === "/upstream/image-seat/queue") { reads++; return void res.end(JSON.stringify({ running: 1 })); }
    res.end(JSON.stringify({ data: [{ id: "main" }, { id: "image-seat" }] }));
  });
  const swapUrl = await new Promise<string>((ready) =>
    swap.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(swap.address() as AddressInfo).port}`)));
  const cfg = parseV1({
    name: "one",
    resources: { gpu: { kind: "gpu" } },
    scheduler: { lanes: { chat: { priority: 0 }, memory: { priority: 90 } } },
    backends: [
      { name: "card", url: swapUrl, kind: "llama-swap", resources: ["gpu"] },
      {
        name: "app", url: swapUrl, kind: "llama-swap", serves: ["image-seat"], resources: ["gpu"], resident: { yield: false },
        activity: { path: "/upstream/image-seat/queue", running: "running" },
        hold: { lanes: ["memory"], idleMs: 60_000, seat: "image-seat" },
      },
    ],
  });
  const pool = new BackendPool(cfg, silentLogger);
  const [card, app] = [pool.get("card")!, pool.get("app")!];

  await app.state.refresh();
  await pool.sampleActivity(app);
  assert.equal(reads, 0, "seat down: the path is not read, so reading it cannot start the app");
  assert.equal(pool.heldOff(card.cfg, "memory"), false);

  running = [{ model: "image-seat", state: "ready" }];
  await app.state.refresh();
  await pool.sampleActivity(app);
  assert.equal(reads, 1, "seat up: the path is read through the swapper");
  assert.equal(pool.heldOff(card.cfg, "memory"), true, "and the app's work holds the card");

  running = [{ model: "main", state: "ready" }];
  await app.state.refresh();
  assert.equal(pool.heldOff(card.cfg, "memory"), false, "the swapper dropped the seat: the hold ends at once, not when the app's last reading ages out");

  swap.closeAllConnections();
  swap.close();
  pool.stop();
}

console.log("hold: ok");
