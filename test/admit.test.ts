/**
 * Admission: every refusal and its status, and the same gates on every route that queues work.
 * A route that skips one is how a key ends up flooding a queue the others guard.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { admitModel, callerCap } from "../src/access/admit.js";
import { BodyTooLargeError, PeerStatusError, QueueFullError, Refusal, refusalOf } from "../src/errors.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

// --- the model gates, in order -------------------------------------------------------
{
  const policy = { name: "n", shared: () => ["lent"], unknown: (m: string) => (m === "ghost" ? "lent, mine" : null) };
  const status = (model: string, peer: string | null, scope: string[] | null = null) =>
    admitModel({ model, peer, scope }, policy)?.status ?? 0;
  assert.equal(status("", null), 400, "a model is required");
  assert.equal(status("mine", "p"), 403, "a peer reaches only what is lent");
  assert.equal(status("lent", "p"), 0);
  assert.equal(status("mine", null, ["other"]), 403, "a scoped key reaches only its models");
  assert.equal(status("ghost", null), 404, "an id nothing serves is refused before queueing");
  assert.equal(status("mine", null), 0);
}

// --- every failure maps to one status ------------------------------------------------
{
  assert.equal(refusalOf(new BodyTooLargeError(1)).status, 413);
  assert.equal(refusalOf(new QueueFullError("lane_full", "chat")).status, 429);
  assert.equal(refusalOf(new PeerStatusError("p", 429, "")).status, 429, "a peer's refusal keeps its status");
  assert.equal(refusalOf(new PeerStatusError("p", 500, "")).status, 502, "a peer's failure is ours to report");
  assert.equal(refusalOf(new Refusal(503, "x")).status, 503);
  assert.equal(refusalOf(new Error("boom")).status, 502);
  const cfg = { peerMaxConcurrent: 3, scheduler: { maxPerCaller: 0 } };
  assert.equal(callerCap("p", cfg), 3, "peers are always capped");
  assert.equal(callerCap(null, cfg), undefined, "local callers only when configured");
  assert.equal(callerCap(null, { ...cfg, scheduler: { maxPerCaller: 2 } }), 2);
}

// --- a queued passthrough route honours the caller cap like chat does ---------------
{
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const atBackend = new Promise<void>((r) => (reached = r));
  const backend = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [] }));
    if (req.url === "/render") {
      reached();
      return void held.then(() => res.end("{}"));
    }
    res.end("{}");
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const cfg = parseV1({
    name: "t",
    apiKeys: ["k"],
    scheduler: { maxPerCaller: 1 },
    backends: [{ name: "sd", url, kind: "none", serves: ["sd"], routes: ["/render"] }],
  });
  const node = createNode(cfg, silentLogger);
  // What only a restart changes is fixed once the node exists, so a stray write fails loudly.
  assert.throws(() => { cfg.scheduler.maxPerCaller = 9; }, TypeError);
  assert.throws(() => { cfg.backends[0]!.url = "x"; }, TypeError);
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const first = post("/render", {});
  // Once the backend has the first render it is running, so it counts against the cap.
  await atBackend;
  const second = await Promise.race([
    post("/render", {}),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the second render queued: no caller cap")), 2_000)),
  ]);
  assert.equal(second.status, 429, "a second render from the same key is over its cap");
  await second.text();

  // --- ...and warm refuses an id nothing serves, as chat does ---
  const warm = await post("/v1/warm", { model: "ghost" });
  assert.equal(warm.status, 404, "warm meets the same unknown-model gate as chat");
  await warm.text();

  release();
  assert.equal((await first).status, 200);
  node.server.closeAllConnections();
  node.server.close();
  backend.closeAllConnections();
  backend.close();
}

console.log("admit.test.ts ok");
