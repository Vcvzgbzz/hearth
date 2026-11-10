/**
 * Lane defaults, as the console's Scheduler page needs them: which lane borrowed work and a
 * backend route land in by default, and what a dry run would move those defaults to.
 *
 *     npx tsx test/scheduler-view.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

import { laneDefaults, loadConfig, lowestLane, parseConfig, type HearthConfig, type LaneDefaults } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";
import type { SchedulerView } from "../src/observe/uidata.js";
import { parseV1 } from "./v1.js";
import { migrate } from "../src/config/migrate.js";

// --- lowestLane ------------------------------------------------------------
{
  const lanes = { a: { priority: 0 }, b: { priority: 100 }, c: { priority: 100 }, warm: { priority: 200 } };
  assert.equal(lowestLane(lanes), "b", "with warm left out, the highest priority number wins, and a tie goes to the first declared");
  assert.equal(lowestLane({ a: { priority: 0 }, z: { priority: 0 } }), "a", "a tie with no other lane still takes the first declared");
}

// --- laneDefaults ----------------------------------------------------------
{
  const cfg = parseConfig({ backends: { main: { url: "http://127.0.0.1:1" } } });
  assert.deepEqual(
    laneDefaults(cfg),
    { first: "chat", peers: "batch", routes: "batch" },
    "nothing said: routes and borrowed work take the lowest-priority lane, and an empty flow step the first declared",
  );

  const lending = parseConfig({ backends: { main: { url: "http://127.0.0.1:1" } }, lending: { lane: "chat" } });
  const d = laneDefaults(lending);
  assert.equal(d.peers, "chat", "lending.lane puts borrowed work where it says");
  assert.equal(d.routes, "batch", "and leaves the route default alone");
  assert.equal(d.first, "chat");
}

const dir = mkdtempSync(join(tmpdir(), "hearth-sched-"));
const cfgPath = join(dir, "hearth.yaml");

/** A backend that answers its model list and nothing else. */
const backend = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: [] }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const seed = (routes = "") => `version: 3
name: sched
backends:
  main:
    url: ${backendUrl}
    kind: none
${routes}scheduler:
  lanes:
    chat: {priority: 0}
    batch: {priority: 100}
flows:
  anything-else: {inputs: ["*"], steps: [{to: {asked: true}}]}
${routes ? "  gen: {inputs: [gen], steps: [{to: {asked: true}}]}\n" : ""}`;

const start = async (cfg: HearthConfig) => {
  const node = createNode(cfg, silentLogger);
  node.start();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await (await fetch(`${url}${p}`)).json()) as Record<string, any>;
  const patch = async (body: unknown) => {
    const r = await fetch(`${url}/config`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { node, get, patch };
};

/** A node on the seeded file, at the layout the editor reads and writes, so a dry run that writes nothing leaves the file byte for byte. */
const boot = async (routes = "") => {
  const text = seed(routes);
  writeFileSync(cfgPath, text);
  writeFileSync(cfgPath, stringify(migrate(parse(text))));
  const a = await start(loadConfig(cfgPath));
  return { ...a, hash: (await a.get("/config")).hash };
};

const EDIT = { path: ["scheduler", "lanes", "archive"], value: { priority: 300 } };

{
  const a = await boot();
  const before = readFileSync(cfgPath, "utf8");

  const r = await a.patch({ baseHash: a.hash, ops: [EDIT], dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const defaults = r.body.defaults as { before: LaneDefaults; after: LaneDefaults };
  assert.equal(defaults.before.peers, "batch", "the default borrowed work lands in now");
  assert.equal(defaults.after.peers, "archive", "and would land in once the lane is declared");
  assert.equal(defaults.before.routes, "batch");
  assert.equal(defaults.after.routes, "archive", "a route that names no lane would follow it");
  assert.equal(defaults.before.first, "chat");
  assert.equal(defaults.after.first, "chat", "an empty flow step still takes the first declared lane");
  assert.equal(readFileSync(cfgPath, "utf8"), before, "a dry run writes nothing");
  await a.node.close();
}

{
  // The route wrote the old default into the file, and only a restart replaces a backend.
  const a = await boot("    routes:\n      - path: /gen\n");
  const r = await a.patch({ baseHash: a.hash, ops: [EDIT], dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.restartPending, ["backends"], "a route holding the old default waits on a restart");
  assert.equal((r.body.defaults as { after: LaneDefaults }).after.routes, "archive", "which is the move the dry run reports");
  await a.node.close();
}

{
  // No route, and nothing in the file chose a lane, so every step makes the choice afresh.
  const a = await boot();
  const r = await a.patch({ baseHash: a.hash, ops: [EDIT], dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.restartPending, [], "no route picked a lane, so none is stale");
  assert.equal((r.body.defaults as { after: LaneDefaults }).after.peers, "archive");
  await a.node.close();
}

{
  // What is written takes effect at once, so there is no before and after to report.
  const a = await boot();
  const before = readFileSync(cfgPath, "utf8");
  const r = await a.patch({ baseHash: a.hash, ops: [EDIT] });
  assert.equal(r.status, 200);
  assert.equal("defaults" in r.body, false, "a real patch has no defaults");
  assert.notEqual(readFileSync(cfgPath, "utf8"), before, "and it wrote the lane into the file");
  assert.equal(loadConfig(cfgPath).peerLane, "archive", "which the next load reads as the default for borrowed work");
  await a.node.close();
}

// --- /ui/data carries the lanes and the order settings ---------------------
{
  const a = await start(parseV1({ name: "sched", backends: [{ name: "main", url: backendUrl, kind: "none" }] }));
  const page = (await a.get("/ui/data")) as { scheduler: SchedulerView };
  assert.deepEqual(
    page.scheduler.lanes,
    [
      { name: "chat", priority: 0 },
      { name: "batch", priority: 100 },
      { name: "warm", priority: 200, builtIn: true },
    ],
    "every lane by priority, lowest number first, with warm marked as the one nothing declared",
  );
  assert.deepEqual(page.scheduler.order, { agePerSecond: 1, warmBonus: 40, maxPerLane: 100, maxPerCaller: 0 },
    "the four order settings, as the config holds them");
  assert.deepEqual(page.scheduler.defaults, { first: "chat", peers: "batch", routes: "batch" }, "where a request that names no lane lands");
  await a.node.close();
}

{
  // A ceiling, a wait and a declared warm lane are reported as the config has them.
  const a = await start(parseV1({
    name: "sched",
    backends: [{ name: "main", url: backendUrl, kind: "none" }],
    scheduler: { lanes: { warm: { priority: 150 }, batch: { priority: 100, concurrency: 2, maxWaitMs: 5000 }, chat: { priority: 0 } } },
  }));
  const page = (await a.get("/ui/data")) as { scheduler: SchedulerView };
  assert.deepEqual(page.scheduler.lanes, [
    { name: "chat", priority: 0 },
    { name: "batch", priority: 100, ceiling: 2, maxWaitMs: 5000 },
    { name: "warm", priority: 150, builtIn: true },
  ], "sorted out of the file's own order; a ceiling and a wait are reported, and warm is builtIn whether or not the file declares it");
  assert.equal(page.scheduler.defaults.peers, "batch", "and a declared warm lane is still not where borrowed work lands by default");
  await a.node.close();
}

backend.close();
