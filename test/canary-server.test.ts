/**
 * A model that answers 200 with nothing, end to end, through a real hearth on a
 * loopback socket.
 *
 * A fake llama-swap answers every completion with HTTP 200 and 200 `!`.
 * Everything around the model is healthy: the backend is up, the model is
 * resident, the stream connected. The only thing that can tell that from a
 * working seat is asking it something with a right answer, which is what this
 * asserts:
 *
 *   detect -> degraded -> a fast, explicit 503 to the next client -> notify ->
 *   one gentle unload -> the model answered again -> back in rotation.
 *
 * The rest is the safety half: a healthy seat is never touched, the notification
 * is fire-and-forget, and the unauthenticated /healthz reports a count rather
 * than the name of a model.
 *
 *   npx tsx test/canary-server.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { parseV1 } from "./v1.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

type Mode = "bad" | "good" | "split";

/** A llama-swap that polls (no /api/events) and can be switched between broken and healthy. */
function fakeSwap() {
  let mode: Mode = "bad";
  const counts = { chats: 0, unloads: 0, canaryChats: 0, clientChats: 0 };
  const s = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    // Force the polling path: no event stream here.
    if (path === "/api/events") return fail(res, 404);
    if (path === "/running") {
      return json(res, { running: [{ model: "m", state: "ready", cmd: "llama-server --port 1" }] });
    }
    if (path === "/v1/models") return json(res, { data: [{ id: "m" }] });
    if (path.startsWith("/api/models/unload/")) {
      counts.unloads++;
      return json(res, { ok: true });
    }
    if (path === "/v1/chat/completions") {
      counts.chats++;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: { messages?: { content?: string }[]; stream?: boolean } = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body; } catch { /* ignore */ }
        const prompt = body.messages?.[0]?.content ?? "";
        const fromCanary = /capital of France/i.test(prompt);
        if (fromCanary) counts.canaryChats++; else counts.clientChats++;
        const broken = mode === "bad" || (mode === "split" && !fromCanary);
        const content = broken ? "!".repeat(200) : "Paris is the capital of France.";
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          // Ten deltas, exactly how the real thing streamed its `!`.
          for (let i = 0; i < 10; i++) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "!".repeat(20) }, finish_reason: null }] })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        json(res, {
          choices: [{ message: { content }, finish_reason: broken ? "length" : "stop" }],
        });
      });
      return;
    }
    fail(res, 404);
  });
  return {
    s,
    counts,
    setMode: (m: Mode) => { mode = m; },
    url: async () => {
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    },
  };
}

function json(res: ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function fail(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

/** Where the notification hook posts; records what it was told. */
function sink() {
  const got: Record<string, unknown>[] = [];
  const headers: Record<string, string | undefined>[] = [];
  const s = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { got.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>); } catch { /* ignore */ }
      headers.push({ key: req.headers["x-api-key"] as string | undefined });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return {
    s, got, headers,
    url: async () => {
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}/hook`;
    },
  };
}

const start = async (cfg: Record<string, unknown>) => {
  const node = createNode(parseV1(cfg), silentLogger);
  node.start();
  const base = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
  );
  return { node, base };
};

/** Poll until the predicate holds, so a slow first tick is not a failure. */
async function until<T>(want: () => Promise<T | null>, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const got = await want().catch(() => null);
    if (got !== null) return got;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the canary to catch up");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The /v1/models entry for one id. */
const entry = async (base: string, id: string) => {
  const body = (await (await fetch(`${base}/v1/models`)).json()) as {
    data: { id: string; status?: { value: string } }[];
  };
  return body.data.find((m) => m.id === id) ?? null;
};

const statusOf = (base: string, id: string) => entry(base, id).then((m) => m?.status?.value ?? null);

/** One client chat. Returns the status and the parsed body (or text). */
async function chat(base: string, stream = false) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello there" }], stream }),
  });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* streams are not json */ }
  return { status: r.status, text, body };
}

// ===========================================================================
// 200 `!` must stop being called healthy
// ===========================================================================
{
  const swap = fakeSwap();
  const url = await swap.url();
  const hook = sink();
  const hookUrl = await hook.url();

  const { node, base } = await start({
    name: "canary-e2e",
    backends: [{ name: "cardb", url, kind: "llama-swap", serves: ["m"] }],
    canary: {
      models: { m: { intervalMs: 100 } },
      notify: { url: hookUrl, headers: { "x-api-key": "test-key" } },
      recovery: { cooldownMs: 60_000 },
    },
  });

  // --- it notices, and says so on /v1/models --------------------------------
  await until(async () => ((await statusOf(base, "m")) === "degraded" ? true : null));

  // --- and tells a human ----------------------------------------------------
  const told = await until(async () => (hook.got.length > 0 ? hook.got[0]! : null));
  assert.equal(told.event, "degraded");
  assert.equal(told.model, "m");
  assert.equal(told.reason, "degenerate");
  // The event as data, and nothing phrased for one receiver: whoever takes the
  // hook builds their own title or sentence from these.
  assert.deepEqual(
    Object.keys(told).sort(),
    ["backend", "detail", "event", "failures", "model", "node", "reason", "sample", "since"],
  );
  assert.equal(told.node, "canary-e2e");
  assert.equal(told.backend, "cardb");
  assert.ok(String(told.sample).startsWith("!"), "the sample is the bad output");
  assert.ok(!Number.isNaN(Date.parse(String(told.since))), "since is an ISO timestamp");
  assert.equal(told.failures, 2);
  assert.equal(hook.headers[0]!.key, "test-key", "the configured header is sent");

  // --- the client gets an explicit error, not junk --------------------------
  const refused = await chat(base);
  assert.equal(refused.status, 503, "a degraded model refuses fast instead of serving junk");
  const err = refused.body.error as Record<string, unknown>;
  assert.equal(err.code, "model_degraded");
  assert.equal(err.model, "m");
  assert.equal(err.backend, "cardb");
  assert.equal(err.reason, "degenerate");
  assert.ok(String(err.sample).startsWith("!"), `the error carries the bad output, got ${JSON.stringify(err.sample)}`);
  assert.ok(!Number.isNaN(Date.parse(String(err.since))), `since is a timestamp, got ${JSON.stringify(err.since)}`);
  assert.ok(String(err.message).includes("m"), "the message names the model");

  // --- one gentle unload, and only the one model ----------------------------
  await until(async () => (swap.counts.unloads >= 1 ? true : null));
  assert.equal(swap.counts.unloads, 1, "recovery drops the model once, not on every tick");

  // --- the seat answers again, and comes back -------------------------------
  swap.setMode("good");
  await until(async () => ((await statusOf(base, "m")) === "loaded" ? true : null));

  const served = await chat(base);
  assert.equal(served.status, 200, "a recovered seat serves clients again");
  assert.ok(served.text.includes("Paris"), "with a real answer");

  const recovered = await until(async () =>
    (hook.got.find((e) => e.event === "recovered") ?? null));
  assert.equal(recovered.model, "m");
  assert.ok(Number(recovered.downMs) >= 0, "and can say how long it was out");
  assert.deepEqual(
    Object.keys(recovered).sort(),
    ["backend", "downMs", "event", "model", "node", "probes", "since"],
  );

  // --- the unauthenticated health endpoint counts, and does not name --------
  const hz = (await (await fetch(`${base}/healthz`)).json()) as {
    ok: boolean; canary?: { degraded: number };
  };
  assert.deepEqual(hz.canary, { degraded: 0 }, "with a canary configured, healthz carries its count and nothing else");
  const rawHz = await (await fetch(`${base}/healthz`)).text();
  assert.ok(!rawHz.includes("\"m\""), "and never as a model name");

  // --- the page gets the tile ----------------------------------------------
  const ui = (await (await fetch(`${base}/ui/data`)).json()) as {
    canary?: { enabled: boolean; models: Record<string, { health: string; reason: string | null }> };
  };
  assert.ok(ui.canary, "the dashboard payload carries the canary");
  assert.equal(ui.canary!.enabled, true);
  assert.ok(ui.canary!.models.m, "with one entry per watched model");

  await node.close();
  swap.s.closeAllConnections();
  swap.s.close();
  hook.s.closeAllConnections();
  hook.s.close();
}

// ===========================================================================
// Real traffic is a suspicion: a degenerate stream brings the probe forward
// ===========================================================================
{
  const swap = fakeSwap();
  const url = await swap.url();
  // The canary's own question is answered correctly; only CLIENT traffic is junk.
  swap.setMode("split");

  const { node, base } = await start({
    name: "canary-passive",
    backends: [{ name: "cardb", url, kind: "llama-swap", serves: ["m"] }],
    canary: {
      // A probe an hour away, so nothing here can be a probe's doing.
      models: { m: { intervalMs: 3_600_000 } },
      passive: true,
    },
  });

  // Let the first tick happen, and confirm the seat reads healthy first.
  await until(async () => ((await swap.counts.canaryChats) >= 1 ? true : null));
  assert.equal(await statusOf(base, "m"), "loaded", "the canary alone finds this seat healthy");

  // Two streaming clients get 200 `!`. The bytes must still reach them: the
  // watcher observes, it does not filter, buffer or delay.
  const first = await chat(base, true);
  assert.equal(first.status, 200);
  assert.ok(first.text.includes("!!!!"), "the client still receives the stream, unchanged");
  const second = await chat(base, true);
  assert.equal(second.status, 200);

  await until(async () => (swap.counts.canaryChats >= 2 ? true : null));
  assert.equal(await statusOf(base, "m"), "loaded", "the seat answered its own question: two odd streams do not refuse it to everyone");

  // The seat really breaks: its own question fails too. Each relayed `!` stream
  // pulls the probe forward, and two failed probes degrade it.
  swap.setMode("bad");
  await chat(base, true);
  await until(async () => (swap.counts.canaryChats >= 3 ? true : null));
  await chat(base, true);
  await until(async () => ((await statusOf(base, "m")) === "degraded" ? true : null));
  assert.equal(swap.counts.canaryChats, 4, "two probes, brought forward by the traffic, did it");

  const refused = await chat(base);
  assert.equal(refused.status, 503, "and the next client is refused rather than fed junk");
  assert.equal((refused.body.error as Record<string, unknown>).code, "model_degraded");

  await node.close();
  swap.s.closeAllConnections();
  swap.s.close();
}

// ===========================================================================
// A healthy seat is never touched
// ===========================================================================
{
  const swap = fakeSwap();
  const url = await swap.url();
  swap.setMode("good");
  const { node, base } = await start({
    name: "canary-healthy",
    backends: [{ name: "cardb", url, kind: "llama-swap", serves: ["m"] }],
    canary: { models: { m: { intervalMs: 100 } } },
  });

  // Several probe intervals in, the model is still fine and no unload happened.
  await until(async () => ((await swap.counts.canaryChats) >= 3 ? true : null));
  assert.equal(await statusOf(base, "m"), "loaded", "a working seat stays in rotation");
  assert.equal(swap.counts.unloads, 0, "and is never unloaded");
  const served = await chat(base);
  assert.equal(served.status, 200);

  await node.close();
  swap.s.closeAllConnections();
  swap.s.close();
}

// ===========================================================================
// A canary hook that is down must not take the proxy with it
// ===========================================================================
{
  const swap = fakeSwap();
  const url = await swap.url();
  const { node, base } = await start({
    name: "canary-badhook",
    backends: [{ name: "cardb", url, kind: "llama-swap", serves: ["m"] }],
    canary: {
      models: { m: { intervalMs: 100 } },
      // Nothing is listening here.
      notify: { url: "http://127.0.0.1:9/hook", timeoutMs: 200 },
    },
  });

  await until(async () => ((await statusOf(base, "m")) === "degraded" ? true : null));
  const refused = await chat(base);
  assert.equal(refused.status, 503, "the model is still refused, and the node is still answering");

  await node.close();
  swap.s.closeAllConnections();
  swap.s.close();
}

// ===========================================================================
// No canary configured: nothing changes, nothing is inspected
// ===========================================================================
{
  const swap = fakeSwap();
  const url = await swap.url();
  const { node, base } = await start({
    name: "canary-off",
    backends: [{ name: "cardb", url, kind: "llama-swap", serves: ["m"] }],
  });

  const served = await chat(base);
  assert.equal(served.status, 200);
  assert.ok(served.text.includes("!"), "with no canary, a 200 `!` still passes through — opt-in means opt-in");
  assert.equal(await statusOf(base, "m"), "loaded", "and nothing is ever degraded");
  assert.equal(swap.counts.canaryChats, 0, "no probe is ever sent");

  const ui = (await (await fetch(`${base}/ui/data`)).json()) as { canary?: { enabled: boolean } };
  assert.equal(ui.canary?.enabled, false, "the page is told the canary is off");

  await node.close();
  swap.s.closeAllConnections();
  swap.s.close();
}

console.log("canary-server.test.ts ok");
