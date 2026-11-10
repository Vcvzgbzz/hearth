/**
 * Every door into a failed seat, not just the chat one.
 *
 * `/v1/chat/completions` is the route hearth owns, and it was the only one a
 * degraded model was refused on. Everything else — `/v1/completions`, an
 * embeddings-shaped call, llama-swap's `/upstream/<model>/…` — went down the
 * passthrough, which forwards first and asks questions later. A seat emitting
 * `!` is exactly as broken through those, so the same refusal has to be in
 * front of them. It uses the model the passthrough already resolves; nothing
 * new is parsed to find it.
 *
 * The second half is the other direction: a completion relayed through the
 * passthrough is now WATCHED too, so a legacy `/v1/completions` answer of
 * `! ! ! !` is counted rather than passed by.
 *
 *   npx tsx test/canary-passthrough.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseV1 } from "./v1.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

/** bad: every answer is junk. split: only the canary's own question is answered. good: all fine. */
type Mode = "bad" | "split" | "good";

function fakeSwap() {
  let mode: Mode = "bad";
  const counts = { completions: 0, upstream: 0, embeddings: 0, canaryChats: 0 };
  const s = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const j = (b: unknown, code = 200) => {
      const t = JSON.stringify(b);
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(t) });
      res.end(t);
    };
    const body = (cb: (b: { messages?: { content?: string }[]; model?: string }) => void) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* ignore */ }
        cb(parsed as { messages?: { content?: string }[]; model?: string });
      });
    };
    if (path === "/api/events") { res.writeHead(404); res.end(); return; }
    if (path === "/running") return j({ running: [{ model: "m", state: "ready" }] });
    if (path === "/v1/models") return j({ data: [{ id: "m" }] });
    if (path.startsWith("/api/models/unload/")) return j({ ok: true });
    if (path === "/v1/chat/completions") {
      return body((b) => {
        const asked = b.messages?.[0]?.content ?? "";
        const fromCanary = /capital of France/i.test(asked);
        if (fromCanary) counts.canaryChats++;
        const bad = mode === "bad" ? true : mode === "split" ? !fromCanary : false;
        j({ choices: [{ message: { content: bad ? "!".repeat(200) : "Paris is the capital of France." }, finish_reason: bad ? "length" : "stop" }] });
      });
    }
    // A legacy completion: the shape the passthrough carries, spaced out so only
    // a content-aware reader can call it degenerate.
    if (path === "/v1/completions") {
      counts.completions++;
      return j({ choices: [{ text: mode === "good" ? "Paris." : "! ".repeat(60), finish_reason: "stop" }] });
    }
    if (path === "/v1/embeddings") { counts.embeddings++; return j({ data: [{ embedding: [0.1, 0.2], index: 0 }] }); }
    if (path.startsWith("/upstream/")) {
      counts.upstream++;
      return j({ choices: [{ message: { content: mode === "good" ? "Paris." : "!" }, finish_reason: "stop" }] });
    }
    res.writeHead(404);
    res.end();
  });
  return {
    s, counts,
    setMode: (m: Mode) => { mode = m; },
    url: async () => {
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
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

const until = async <T>(want: () => Promise<T | null>, ms = 20_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const got = await want().catch(() => null);
    if (got !== null) return got;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the canary to catch up");
    await new Promise((r) => setTimeout(r, 100));
  }
};

const statusOf = async (base: string, id: string) => {
  const body = (await (await fetch(`${base}/v1/models`)).json()) as {
    data: { id: string; status?: { value: string } }[];
  };
  return body.data.find((m) => m.id === id)?.status?.value ?? null;
};

/** POST anywhere on the passthrough, returning status and parsed body. */
async function post(base: string, path: string, payload: unknown) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, text, body };
}

const degradedCfg = (url: string, extra: Record<string, unknown> = {}) => ({
  name: "pt",
  backends: [{ name: "swap", url, kind: "llama-swap", serves: ["m"] }],
  canary: { models: { m: { intervalMs: 100 } }, ...extra },
});

// ===========================================================================
// A degraded model is refused on every door
// ===========================================================================
{
  const swap = fakeSwap();
  const url = await swap.url();
  const { node, base } = await start(degradedCfg(url));

  await until(async () => ((await statusOf(base, "m")) === "degraded" ? true : null));

  // The OpenAI legacy completion endpoint.
  const legacy = await post(base, "/v1/completions", { model: "m", prompt: "hello" });
  assert.equal(legacy.status, 503, "/v1/completions must be refused for a degraded model");
  const err = legacy.body.error as Record<string, unknown>;
  assert.equal(err.code, "model_degraded");
  assert.equal(err.model, "m");
  assert.equal(err.reason, "degenerate");
  assert.ok(String(err.sample).startsWith("!"), "and it names what the seat actually returned");
  assert.equal(swap.counts.completions, 0, "the backend was never asked");

  // An embeddings-shaped call: not a completion, but still that seat.
  const emb = await post(base, "/v1/embeddings", { model: "m", input: "hello" });
  assert.equal(emb.status, 503, "an embeddings path must be refused too");
  assert.equal(swap.counts.embeddings, 0, "and never reaches the backend");

  // llama-swap's own upstream door. (The counter is zeroed first: hearth's own
  // context probe reads `/upstream/m/props` directly and is not this traffic.)
  swap.counts.upstream = 0;
  const upstream = await post(base, "/upstream/m/v1/chat/completions", { messages: [] });
  assert.equal(upstream.status, 503, "/upstream/<model>/... must be refused too");
  assert.equal(swap.counts.upstream, 0, "and never reaches the backend");

  // A request that names no model is not this gate's business, and still passes.
  const running = await fetch(`${base}/running`);
  assert.equal(running.status, 200, "a path with no model in it is untouched");
  await running.text();
  await node.close();
  swap.s.closeAllConnections();
  swap.s.close();
}

// ===========================================================================
// A healthy seat is not touched
// ===========================================================================
{
  const swap = fakeSwap();
  const url = await swap.url();
  swap.setMode("good");
  const { node, base } = await start(degradedCfg(url));

  const legacy = await post(base, "/v1/completions", { model: "m", prompt: "hello" });
  assert.equal(legacy.status, 200, "a working seat's legacy completion passes through");
  assert.ok(legacy.text.includes("Paris"), "verbatim");
  const upstream = await post(base, "/upstream/m/v1/chat/completions", { messages: [] });
  assert.equal(upstream.status, 200);
  assert.equal(await statusOf(base, "m"), "loaded");

  await node.close();
  swap.s.closeAllConnections();
  swap.s.close();
}

// ===========================================================================
// Junk relayed through the passthrough is evidence too
// ===========================================================================
// The canary's own question is answered correctly here, and a probe is an hour
// away: a legacy completion a client actually asked for, watched as it is
// relayed, brings that probe forward — and the probe, not the traffic, decides.
{
  const swap = fakeSwap();
  swap.setMode("split");          // the canary's question is answered; only client traffic is junk
  const url = await swap.url();
  const { node, base } = await start({
    name: "pt-passive",
    backends: [{ name: "swap", url, kind: "llama-swap", serves: ["m"] }],
    canary: { models: { m: { intervalMs: 3_600_000 } }, passive: true },
  });

  // The first tick probes, gets a good answer, and then nothing for an hour.
  await until(async () => (swap.counts.canaryChats >= 1 && (await statusOf(base, "m")) === "loaded" ? true : null));
  assert.equal(swap.counts.completions, 0);

  const first = await post(base, "/v1/completions", { model: "m", prompt: "hello" });
  assert.equal(first.status, 200, "the junk still reaches the client, unchanged");
  assert.ok(first.text.includes("! !"), "which is the point: hearth observes, it does not filter");
  assert.equal(await statusOf(base, "m"), "loaded", "one degenerate completion is not yet the threshold");

  const second = await post(base, "/v1/completions", { model: "m", prompt: "hello" });
  assert.equal(second.status, 200);

  await until(async () => (swap.counts.canaryChats >= 2 ? true : null));
  assert.equal(await statusOf(base, "m"), "loaded", "the seat answered its own question: two odd replies do not refuse it to everyone");

  // Now the seat really is broken: its own question fails too. The relayed junk
  // keeps pulling the probe forward, and two failed probes degrade it.
  swap.setMode("bad");
  await post(base, "/v1/completions", { model: "m", prompt: "hello" });
  await until(async () => (swap.counts.canaryChats >= 3 ? true : null));
  await post(base, "/v1/completions", { model: "m", prompt: "hello" });
  await until(async () => ((await statusOf(base, "m")) === "degraded" ? true : null));
  assert.equal(swap.counts.canaryChats, 4, "two probes, brought forward by the traffic, did it");

  await node.close();
  swap.s.closeAllConnections();
  swap.s.close();
}

console.log("canary-passthrough.test.ts ok");
