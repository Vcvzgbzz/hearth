/**
 * Self-check for `models.<id>.lane` — an advertised id that carries its own
 * queue position, over whatever lane the client asked for.
 *
 * The arrangement this exists for: a client with only a model picker (a
 * voice assistant) that must never queue ahead of a person's chat turn. The
 * route says `lane: batch`, and a client that also says `lane: chat` does
 * not undo it.
 *
 *     npx tsx test/lane.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { ConfigError } from "../src/config/read.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode, type HearthNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

/** A backend that answers only when told, so a job can be seen while running. */
let arrived: (respond: () => void) => void = () => {};
const be = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "seat" }] }));
    return;
  }
  req.resume();
  req.on("end", () => {
    arrived(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
});
await new Promise<void>((r) => be.listen(0, "127.0.0.1", r));
const beUrl = `http://127.0.0.1:${(be.address() as AddressInfo).port}`;

function listen(node: HearthNode): Promise<string> {
  return new Promise((ready) => {
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`),
    );
  });
}

const lanes = { chat: { priority: 0 }, batch: { priority: 100 } };
const cfg = parseV1({
  name: "me",
  backends: [{ name: "swap", url: beUrl, kind: "none" }],
  scheduler: { lanes },
  models: {
    seat: { backend: "swap" },
    quiet: { backend: "swap", as: "seat", lane: "batch" },
  },
});
const node = createNode(cfg, silentLogger);
const url = await listen(node);
await node.pool.first().state.refresh();

// --- config: parsed, validated, absent means null ---------------------------
{
  assert.equal(cfg.models.quiet!.lane, "batch");
  assert.equal(cfg.models.seat!.lane, null, "a plain route carries no lane");
  assert.throws(
    () => parseV1({ name: "x", backend: { url: beUrl }, scheduler: { lanes }, models: { m: { lane: "vip" } } }),
    (e: unknown) => e instanceof ConfigError && /not in scheduler.lanes/.test((e as Error).message),
    "a lane nobody declared is refused at load",
  );
}

/** Lane of the one job in flight, as /queue would show it. */
async function runningLane(body: Record<string, unknown>): Promise<string> {
  // Wait for the backend to hold the request; the job shows as running before it lands.
  const held = new Promise<() => void>((r) => (arrived = r));
  const done = fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const respond = await held;
  const view = node.pool.first().scheduler.view();
  assert.equal(view.length, 1, "exactly one job in flight");
  const lane = view[0]!.lane;
  respond();
  assert.equal((await done).status, 200);
  return lane;
}

// --- THE POINT: the route's lane wins over the client's ---------------------
assert.equal(await runningLane({ model: "quiet", messages: [], lane: "chat" }), "batch");
assert.equal(await runningLane({ model: "quiet", messages: [] }), "batch");
// --- and a route without one leaves the client's choice alone ---------------
assert.equal(await runningLane({ model: "seat", messages: [], lane: "batch" }), "batch");
assert.equal(await runningLane({ model: "seat", messages: [] }), "chat", "default is the first lane");

node.server.closeAllConnections();
node.server.close();
be.closeAllConnections();
be.close();
console.log("lane: ok");
