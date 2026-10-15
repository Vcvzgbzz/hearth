/**
 * Shutting down without taking work with it.
 *
 * `close()` called `closeAllConnections()`, which destroys every socket the
 * instant it is asked to stop -- including the ones with a request half
 * answered on them. The caller sees a response that simply stops: not a status
 * it can act on, not an error the client library reports as retryable, just a
 * truncated body. On a box where a restart is how you deploy, and where the
 * work in flight is a chat turn or a render several GPU-minutes in, that is the
 * one failure hearth causes rather than manages.
 *
 * So: stop accepting, drop the idle connections, and let what is already
 * running finish. Bounded, because a deploy that hangs is its own outage.
 *
 *     npx tsx test/drain.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

/** A backend that takes `delay` ms to answer, so a request is genuinely in
 *  flight when the shutdown starts rather than racing it. */
const slowBackend = (delay: number) => {
  const s = Object.assign(createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    req.resume();
    if (req.url === "/v1/chat/completions") s.hits++;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "finished" } }] }));
    }, delay);
  }), { hits: 0 });
  return s;
};

/** Resolves once `n` chat requests reached the backend, so a close starts with them in flight. */
const arrived = async (backend: { hits: number }, n = 1) => {
  for (let i = 0; i < 500 && backend.hits < n; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(backend.hits >= n, `the backend received ${n} request(s)`);
};

const nodeOn = async (url: string) => {
  const node = createNode(
    parseV1({
      name: "drain",
      backends: [{ name: "b", url, serves: ["m"], concurrency: 4 }],
    }),
    silentLogger,
  );
  node.start();
  const base = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
  );
  return { node, base };
};

const chat = (base: string) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });

// --- a request in flight is finished, not destroyed ------------------------
{
  const backend = slowBackend(300);
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const { node, base } = await nodeOn(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);

  const inFlight = chat(base);
  await arrived(backend);

  const t0 = Date.now();
  await node.close(5_000);
  const closeMs = Date.now() - t0;

  // Caught rather than awaited bare: the failure this exists to catch is a
  // DESTROYED socket, and letting that surface as an uncaught "fetch failed"
  // tells whoever broke it nothing about which promise it came from.
  const out = await inFlight.then(
    async (r) => ({ status: r.status, body: (await r.json()) as { choices: { message: { content: string } }[] } }),
    (e: Error) => ({ cut: String((e as { cause?: unknown }).cause ?? e) }),
  );
  assert.ok(!("cut" in out), `the in-flight request was answered, not cut (${"cut" in out ? out.cut : ""})`);
  assert.equal(out.status, 200);
  assert.equal(out.body.choices[0]!.message.content, "finished", "and its body arrived whole");
  // It reached the backend with most of its 300ms left. Returning sooner than
  // that would mean close() did not wait for it and the assertions passed by luck.
  assert.ok(closeMs >= 150, `close waited for the request (took ${closeMs}ms)`);
  assert.ok(closeMs < 4_000, `and did not sit out the full grace (took ${closeMs}ms)`);

  backend.closeAllConnections();
  backend.close();
}

// --- the wait is bounded ---------------------------------------------------
// A drain that never ends is a deploy that never ends. Past the grace the
// remaining connections are destroyed exactly as they always were.
{
  const backend = slowBackend(10_000);
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const { node, base } = await nodeOn(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);

  const doomed = chat(base).then(
    (r) => `status ${r.status}`,
    () => "destroyed",
  );
  await arrived(backend);

  const t0 = Date.now();
  await node.close(200);
  const closeMs = Date.now() - t0;

  assert.ok(closeMs < 3_000, `close gave up on schedule (took ${closeMs}ms)`);
  assert.equal(await doomed, "destroyed", "and the request it could not wait for was cut");

  backend.closeAllConnections();
  backend.close();
}

// --- 0 is still the old behaviour ------------------------------------------
// Every existing caller passes nothing, including tests that deliberately
// leave a request hanging. Those must not start waiting.
{
  const backend = slowBackend(10_000);
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const { node, base } = await nodeOn(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);

  const doomed = chat(base).then(() => "answered", () => "destroyed");
  await arrived(backend);

  const t0 = Date.now();
  await node.close();
  assert.ok(Date.now() - t0 < 1_000, "close() with no grace does not wait");
  assert.equal(await doomed, "destroyed");

  backend.closeAllConnections();
  backend.close();
}

// --- an idle keep-alive connection is not work -----------------------------
// The client that made a request and is holding the socket open for the next
// one would otherwise pace every drain at the full grace period.
{
  const backend = slowBackend(10);
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const { node, base } = await nodeOn(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);

  await (await chat(base)).json();      // undici keeps the socket pooled after this

  const t0 = Date.now();
  await node.close(10_000);
  assert.ok(Date.now() - t0 < 1_000, "an idle connection did not hold the drain open");

  backend.closeAllConnections();
  backend.close();
}

// --- a request still QUEUED gets its turn ----------------------------------
// The README says so, which is reason enough to pin it: the caller is holding
// a connection either way, so waiting only for what already reached a backend
// would drop the one job that never got to start. `pool.stop()` deliberately
// stops the state POLLERS and not the schedulers, and that is the line this
// depends on -- it is not obvious from either name.
{
  const backend = slowBackend(250);
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const node = createNode(
    parseV1({
      name: "queued",
      // One at a time, so the second request is provably still in the queue
      // when the shutdown starts.
      backends: [{ name: "b", url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, serves: ["m"], concurrency: 1 }],
    }),
    silentLogger,
  );
  node.start();
  const base = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
  );

  const first = chat(base);
  const second = chat(base);
  await arrived(backend);
  for (let i = 0; i < 500 && !node.pool.jobs().some((j) => j.state === "queued"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(node.pool.jobs().filter((j) => j.state === "queued").length, 1,
    "the second request is genuinely waiting, not running");

  await node.close(5_000);
  for (const [name, p] of [["first", first], ["second", second]] as const) {
    const out = await p.then((r) => r.status, (e: Error) => String((e as { cause?: unknown }).cause ?? e));
    assert.equal(out, 200, `the ${name} request finished`);
  }

  backend.closeAllConnections();
  backend.close();
}

console.log("drain.test.ts ok");
