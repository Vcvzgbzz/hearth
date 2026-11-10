/**
 * What an app's own GPU queue needs from hearth to stop keeping one: a head start before turns
 * share a card, a guard that fails a stuck lane but not a slow one, and queue position on the wire.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/observe/log.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { QueueTimeoutError } from "../src/errors.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

const lanes = { chat: { priority: 0 } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- shareAfter: a second turn joins only once the first has had its head start ------
{
  const s = new Scheduler({ lanes, concurrency: 2, shareAfter: () => 200 });
  const t0 = Date.now();
  let joined = 0;
  const first = s.submit({ lane: "chat", model: "m", caller: "a" }, () => sleep(400));
  const second = s.submit({ lane: "chat", model: "m", caller: "b" }, async () => { joined = Date.now() - t0; });
  await Promise.all([first, second]);
  assert.ok(joined >= 190 && joined < 380, `the second turn waited for the head start, not the whole turn (${joined}ms)`);

  const open = new Scheduler({ lanes, concurrency: 2 });
  const u0 = Date.now();
  let at = -1;
  await Promise.all([
    open.submit({ lane: "chat", model: "m", caller: "a" }, () => sleep(200)),
    open.submit({ lane: "chat", model: "m", caller: "b" }, async () => { at = Date.now() - u0; }),
  ]);
  assert.ok(at < 50, "unset, turns share at once as before");
}

// --- maxWaitMs: a stuck backend fails its queue; a slow but moving one does not -------
{
  const stuck = new Scheduler({ lanes: { chat: { priority: 0, maxWaitMs: 150 } } });
  const hold = stuck.submit({ lane: "chat", model: "m", caller: "a" }, () => sleep(500));
  const t0 = Date.now();
  await assert.rejects(stuck.submit({ lane: "chat", model: "m", caller: "b" }, async () => {}), QueueTimeoutError);
  assert.ok(Date.now() - t0 < 400, "it fails when nothing has started for the window");
  await hold;

  const moving = new Scheduler({ lanes: { chat: { priority: 0, maxWaitMs: 150 } } });
  const jobs = Array.from({ length: 5 }, (_, i) => moving.submit({ lane: "chat", model: "m", caller: `c${i}` }, () => sleep(100)));
  await Promise.all(jobs);
  // The last of five waited ~400ms in total, well past 150ms, and still ran: the backend kept starting work.
}

// --- queue position on the wire, opt-in --------------------------------------------
{
  // A turn the backend has received is running, so the next request is sure to queue behind it.
  let hits = 0;
  const waiting: { n: number; resolve: () => void }[] = [];
  const reached = (n: number) => new Promise<void>((resolve) => (hits >= n ? resolve() : waiting.push({ n, resolve })));
  const backend = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ data: [{ id: "m" }] }));
    }
    hits++;
    for (const w of waiting.filter((w) => w.n <= hits)) w.resolve();
    for await (const _ of req) { /* drain */ }
    await sleep(300);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const node = createNode(parseV1({
    name: "n", backend: { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, kind: "none", serves: ["m"] },
  }), silentLogger);
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}/v1/chat/completions`;
  const ask = (headers: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "x" }] }),
  });

  const first = ask();
  await reached(1);
  const second = await ask({ "x-hearth-queue": "stream" });
  assert.equal(second.status, 200);
  const text = await second.text();
  assert.match(text, /^: hearth-queue \{"position":1\}\n\n: hearth-queue \{"position":0\}\n\n/,
    "the position arrives first, as comments counting who is ahead (the running turn included)");
  assert.match(text, /data: \[DONE\]/, "then the answer streams through on the same response");
  assert.ok(!(await (await first).text()).includes("hearth-queue"), "a client that did not ask sees nothing new");

  // --- /queue/events: one stream, the caller's own jobs, pushed as they change ----------
  const base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const ctrl = new AbortController();
  const events = await fetch(`${base}/queue/events`, { signal: ctrl.signal });
  assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = events.body!.getReader();
  const seen: { event: string; jobs: { id: string; state: string; position: number }[] }[] = [];
  let buf = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += new TextDecoder().decode(value);
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (\w+)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev && data) seen.push({ event: ev, ...(JSON.parse(data) as { jobs: [] }) });
      }
    }
  })();
  await sleep(50);
  const tagged = (id: string) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", "x-hearth-job": id },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "x" }] }),
  }).then((r) => r.text());
  await Promise.all([tagged("app-1"), (async () => { await reached(3); await tagged("app-2"); })()]);
  await sleep(50);
  ctrl.abort();
  await pump;

  assert.equal(seen[0]?.event, "snapshot", "a snapshot first");
  assert.deepEqual(seen[0]?.jobs, [], "with nothing in flight");
  const flat = seen.flatMap((e) => e.jobs.map((j) => `${j.id}:${j.state}:${j.position}`));
  assert.ok(flat.includes("app-1:running:0"), "the caller's own id comes back on its job");
  assert.ok(flat.some((x) => x.startsWith("app-2:queued:")), "a waiting job is pushed with its place in line");
  assert.ok(flat.includes("app-2:running:0"), "and pushed again when it starts");
  assert.deepEqual(seen.at(-1)?.jobs, [], "and the list empties when both finish");
  assert.ok(seen.length <= 8, `pushed on change only, not on a timer (${seen.length} updates)`);

  await node.close();
  backend.closeAllConnections();
  backend.close();
}

console.log("parity.test.ts ok");
