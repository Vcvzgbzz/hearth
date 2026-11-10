/**
 * `/flows/replay`: the recent routed requests decided again under a draft, against the rules in
 * force, with the ones that would go somewhere else grouped by where. A draft that matches the
 * file changes nothing, a re-pointed name moves its requests, a refusal is counted, attempts of
 * one request count once, and the route is gated as `/flows/try` is.
 *
 *     npx tsx test/flows-replay.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import type { RequestTrace } from "../src/observe/uidata.js";
import { createNode } from "../src/server.js";

const trace = (id: string, t: number, more: Partial<RequestTrace> = {}): RequestTrace =>
  ({ id, t, asked: "auto", model: "small", caller: "local", lane: "chat", target: "local", backend: "main", ok: true, waitedMs: 0, runMs: 1, path: [], actions: [], router: "default", ...more });

const flows = {
  front: { inputs: ["auto"], steps: [{ to: "small" }] },
  heavy: { inputs: ["big"], steps: [{ to: "big" }] },
};
const file = join(mkdtempSync(join(tmpdir(), "hearth-replay-")), "history.json");
writeFileSync(file, JSON.stringify({
  v: 1,
  requests: [
    trace("req_1", 1, { ok: false, status: 500 }),
    // The same request's second attempt: one request, decided once.
    trace("req_1", 2, { model: "big", backend: "spare", fallbackFrom: "small" }),
    trace("req_2", 3),
    trace("req_3", 4, { asked: "big", model: "big", backend: "spare" }),
    // Turned away before routing: nothing to replay.
    trace("req_4", 5, { target: "refused", router: undefined }),
    trace("req_5", 6, { caller: "key:app" }),
  ],
}));

const node = createNode(parseConfig({
  backends: { main: { url: "http://127.0.0.1:1", kind: "none", serves: ["small"] }, spare: { url: "http://127.0.0.1:1", kind: "none", serves: ["big"] } },
  scheduler: { lanes: { chat: { priority: 0 } } },
  apiKeys: ["local-key"],
  lending: { models: ["small"] },
  peers: { friend: { accept: "peer-token" } },
  flows,
  historyFile: file,
}), silentLogger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const at = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

const post = async (path: string, body: unknown, token: string | null = "local-key") => {
  const r = await fetch(`${at}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
type Replayed = { considered: number; same: number; changed: { from: string; to: string; count: number; example: string; asked: string }[]; refusedNow: number; note: string };
const replay = async (body: Record<string, unknown>) => {
  const r = await post("/flows/replay", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as unknown as Replayed;
};

// The rules in force, as a draft: every request goes where it goes now.
{
  const r = await replay({ flows, actions: {} });
  assert.deepEqual([r.considered, r.same, r.changed, r.refusedNow], [4, 4, [], 0], "attempts count once and an unrouted request is passed over");
  assert.match(r.note, /state now/);
}

// One name sent elsewhere: its requests move, grouped, newest as the example.
{
  const r = await replay({ flows: { ...flows, front: { inputs: ["auto"], steps: [{ to: "big" }] } } });
  assert.equal(r.same, 1);
  assert.deepEqual(r.changed, [{ from: "small on main", to: "big on spare", count: 3, example: "req_5", asked: "auto" }]);
  assert.equal(r.refusedNow, 0);
  assert.equal((await replay({ flows: { ...flows, front: { inputs: ["auto"], steps: [{ to: "big" }] } }, limit: 1 })).considered, 1, "limit keeps the newest");
}

// One name refused: counted as refused now.
{
  const r = await replay({ flows: { ...flows, heavy: { inputs: ["big"], steps: [{ to: { refuse: "not today" } }] } } });
  assert.deepEqual(r.changed, [{ from: "big on spare", to: "refused", count: 1, example: "req_3", asked: "big" }]);
  assert.equal(r.refusedNow, 1);
}

// A router in the draft: only the callers it is given go by it.
{
  const r = await replay({ flows, routers: { app: { flows: { rest: { inputs: ["*"], steps: [{ to: "big" }] } } } }, callers: { app: "app" } });
  assert.deepEqual(r.changed.map((c) => [c.example, c.count, c.to]), [["req_5", 1, "big on spare"]]);
}

// A draft that does not load is refused as /flows/try refuses it, and the route is gated the same.
{
  const bad = { model: "auto", flows: { front: { inputs: ["auto"], steps: [] } } };
  const tried = await post("/flows/try", bad);
  const replayed = await post("/flows/replay", bad);
  assert.equal(replayed.status, 400);
  assert.deepEqual(replayed.body, tried.body, "the same error envelope");
  for (const token of [null, "peer-token", "wrong"]) {
    assert.equal((await post("/flows/replay", { flows }, token)).status, (await post("/flows/try", { model: "auto" }, token)).status, `token ${token}`);
  }
  assert.equal((await post("/flows/replay", { flows }, null)).status, 401);
}

await node.close();
