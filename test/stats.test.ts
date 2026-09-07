/**
 * Self-check for model stats: what a model can take, and what happens to a
 * request that asks for more.
 *
 * The claim under test, in three parts:
 *
 *   1. a request is measured before it is dispatched, images and reserved
 *      output included;
 *   2. a limit somebody actually reported is enforced HERE, with both numbers,
 *      rather than by a stranger's llama.cpp after the prompt has crossed the
 *      network;
 *   3. silence is never a limit. A model nobody has loaded reports nothing, and
 *      nothing must never refuse anything.
 *
 * Weighted toward part 3. A wrong refusal breaks a request that would have
 * worked, and it breaks it on OUR side of the network where the backend never
 * gets a say.
 *
 *     npx tsx test/stats.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { PeerRegistry, type PeerCapacity } from "../src/peers.js";
import { decide } from "../src/route.js";
import { createNode, type HearthNode } from "../src/server.js";
import { cleanStats, needsOf, statsFromProps, unfit } from "../src/stats.js";

/* ------------------------------------------------------------ reading props */

// The shape a real llama.cpp answers with, trimmed. Captured from a running
// server rather than invented, because every field here is one we do not own.
{
  const s = statsFromProps({
    default_generation_settings: { n_ctx: 131072, params: { temperature: 1 } },
    modalities: { vision: true, video: true, audio: false },
    chat_template_caps: {
      supports_tools: true, supports_system_role: true, supports_reasoning_effort: true,
    },
    model_ftype: "Q5_K - Medium",
    total_slots: 4,
  });
  assert.deepEqual(s, {
    context: 131072, vision: true, tools: true, thinking: true, quant: "Q5_K - Medium",
  });
}

// An older build answers with the window and nothing else. Each field stands
// alone: one missing key must not cost us the others.
{
  const s = statsFromProps({ default_generation_settings: { n_ctx: 4096 } });
  assert.deepEqual(s, { context: 4096 }, "a props with no modalities still yields the window");
  assert.deepEqual(statsFromProps({}), {}, "and an empty props yields no claims at all");
  assert.deepEqual(statsFromProps(null), {}, "including when it is not an object");
}

/* ------------------------------------------------- reading a peer's answer */

// A peer's stats are input from another machine. Anything that is not the type
// it claims to be is dropped rather than compared: a `context` arriving as a
// string would otherwise be measured against a number and silently decide where
// somebody's prompt runs.
{
  assert.deepEqual(cleanStats({ context: 8192, vision: true }), { context: 8192, vision: true });
  assert.equal(cleanStats({ context: "lots" }), undefined, "a string window is not a window");
  assert.equal(cleanStats({ context: 0 }), undefined, "and neither is zero");
  assert.equal(cleanStats("nope"), undefined);
  assert.equal(cleanStats(null), undefined);
  assert.equal(cleanStats({ nothing: "useful" }), undefined, "an object with no fields we know is no claim");
  assert.deepEqual(cleanStats({ vision: false }), { vision: false }, "but a NEGATIVE claim is a claim");
}

/* ------------------------------------------------------- measuring a request */

{
  const small = needsOf({ messages: [{ role: "user", content: "hello" }] });
  assert.ok(small.tokens < 20, `a short prompt is a few tokens, got ${small.tokens}`);
  assert.equal(small.images, false);
  assert.equal(small.tools, false);

  // Reserved output comes out of the same window as the prompt. A check that
  // looked only at the prompt would let a 30k+8k request into a 32k model.
  const reserved = needsOf({
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8000,
  });
  assert.ok(reserved.tokens > 8000, "max_tokens is counted, not ignored");
  assert.ok(
    needsOf({ messages: [{ role: "user", content: "hi" }], max_completion_tokens: 8000 }).tokens > 8000,
    "and so is its newer spelling",
  );

  // An image is charged flat. Its base64 runs to tens of thousands of
  // characters, so counting those would put every vision request over every
  // window — the check would refuse precisely the traffic it exists to protect.
  const withImage = needsOf({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(200_000)}` } },
      ],
    }],
  });
  assert.equal(withImage.images, true);
  assert.ok(withImage.tokens < 5_000, `an image is charged flat, got ${withImage.tokens}`);

  const withTools = needsOf({
    messages: [{ role: "user", content: "go" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
  });
  assert.equal(withTools.tools, true);
  assert.ok(withTools.tokens > 10, "and the schema itself is part of the prompt");

  // A body with nothing recognisable in it must not throw, whatever it is.
  assert.equal(needsOf({}).tokens, 0);
  assert.equal(needsOf({ messages: "not an array" }).tokens, 0);
  assert.equal(needsOf({ messages: [null, { content: null }] }).tokens > 0, true);
}

/* -------------------------------------------------------------- the verdict */

{
  const big = { tokens: 100_000, images: false, tools: false };
  const tiny = { tokens: 10, images: false, tools: false };

  assert.equal(unfit(null, big), null, "an unknown model refuses nothing");
  assert.equal(unfit({}, big), null, "and neither does one that reported no window");
  assert.equal(unfit({ quant: "Q4_K" }, big), null, "a stat that says nothing about fit is not a limit");

  assert.equal(unfit({ context: 131072 }, big), null, "a window that fits says nothing");
  const why = unfit({ context: 32768 }, big);
  assert.ok(why?.includes("32768") && why.includes("100000"), `both numbers are in the message: ${why}`);

  assert.ok(unfit({ vision: false }, { ...tiny, images: true }), "a text-only model refuses an image");
  assert.equal(unfit({ vision: true }, { ...tiny, images: true }), null);
  assert.equal(unfit({}, { ...tiny, images: true }), null, "unknown vision refuses nothing");

  assert.ok(unfit({ tools: false }, { ...tiny, tools: true }), "a model with no tool template refuses tools");
  assert.equal(unfit({ tools: true }, { ...tiny, tools: true }), null);

  // Thinking is reported and never enforced. A reasoning_effort a template
  // cannot express is ignored downstream and the request still answers, so
  // refusing it would break working traffic to protect nobody.
  assert.equal(unfit({ thinking: false }, tiny), null, "a model with no thinking lever refuses nothing");
  assert.deepEqual(cleanStats({ thinking: false }), { thinking: false }, "but it is still reported");
}

/* ------------------------------------------------------------------ routing */

const peerCap = (ctx: number | null): PeerCapacity => ({
  slots: 1, free: 1, running: 0, offbox: 0, queued: {}, resident: null,
  loaded: ["their-big"], serves: ["their-big"],
  models: {
    "their-big": {
      slots: 1, free: 1, queued: 0, warm: true,
      ...(ctx === null ? {} : { stats: { context: ctx } }),
    },
  },
});

function registry(cfg: ReturnType<typeof parseConfig>, up: Record<string, PeerCapacity | null>) {
  const r = new PeerRegistry(cfg, silentLogger);
  const inner = r as unknown as { status: Map<string, Record<string, unknown>> };
  for (const [name, cap] of Object.entries(up)) {
    const s = inner.status.get(name)!;
    s.up = cap !== null;
    s.capacity = cap;
    s.lastOkAt = cap !== null ? Date.now() : null;
  }
  return r;
}

const base = {
  name: "me",
  backend: { url: "http://127.0.0.1:9292" },
  peers: [{ name: "friend", url: "http://10.0.0.2:4141", token: "t", models: { big: "their-big" } }],
  models: { big: { policy: "peer" as const, peers: ["friend"] } },
};
const here = { queued: 0, free: 1, slots: 1, loaded: ["big"] };
const huge = { tokens: 100_000, images: false, tools: false };

// A peer whose model is too small for THIS request is not a candidate for it.
// The work comes home instead of crossing the network to be refused there.
{
  const cfg = parseConfig(base);
  const d = decide("big", cfg, registry(cfg, { friend: peerCap(32768) }), here, huge);
  assert.equal(d.target, "local", "an oversized request stays home");
  assert.ok(d.reason.includes("friend"), `and says which peer could not take it: ${d.reason}`);
}

// Same peer, same window, a request that fits: policy wins as it always did.
{
  const cfg = parseConfig(base);
  const d = decide("big", cfg, registry(cfg, { friend: peerCap(32768) }), here,
                   { tokens: 100, images: false, tools: false });
  assert.equal(d.target, "peer");
}

// A peer that reported no window is not filtered out. This is the regression
// that matters: every peer on protocol 1, and every model they have not loaded,
// reports nothing — and reading that as "too small" would silently end
// federation for everyone who has not upgraded.
{
  const cfg = parseConfig(base);
  const d = decide("big", cfg, registry(cfg, { friend: peerCap(null) }), here, huge);
  assert.equal(d.target, "peer", "silence is not a limit");
}

// And with no `need` at all — every caller that does not deal in chat payloads
// — the decision is exactly what it was before this existed.
{
  const cfg = parseConfig(base);
  const d = decide("big", cfg, registry(cfg, { friend: peerCap(32768) }), here);
  assert.equal(d.target, "peer");
}

// fallbackLocal:false still means what it says. Nowhere to run is a refusal,
// not a quiet local run, and the reason names the fit rather than pretending
// the peer is down.
{
  const cfg = parseConfig({
    ...base,
    models: { big: { policy: "peer" as const, peers: ["friend"], fallbackLocal: false } },
  });
  const d = decide("big", cfg, registry(cfg, { friend: peerCap(32768) }), here, huge);
  assert.equal(d.target, "unavailable");
  assert.ok(d.reason.includes("context window"), `and says why: ${d.reason}`);
}

/* ----------------------------------------------------------- end to end */

/** A llama-swap that reports a 4k window and counts completions it is asked to run. */
function swapBackend() {
  let completions = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: [{ model: "alpha", state: "ready" }] }));
      return;
    }
    if (url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "alpha" }] }));
      return;
    }
    if (url === "/upstream/alpha/props") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        default_generation_settings: { n_ctx: 4096 },
        modalities: { vision: false },
        chat_template_caps: { supports_tools: false },
        model_ftype: "Q4_K - Small",
      }));
      return;
    }
    if (url === "/v1/chat/completions") {
      completions++;
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  return {
    ran: () => completions,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

function listen(node: HearthNode): Promise<string> {
  return new Promise((ready) => {
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`));
  });
}

{
  const be = swapBackend();
  await be.listen();
  const cfg = parseConfig({
    name: "me",
    backend: { url: be.url(), kind: "llama-swap" },
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  // learnContext is fire-and-forget, so wait for the window to land the same way
  // a client would: by looking at /v1/models.
  const deadline = Date.now() + 3000;
  let ctx: number | undefined;
  while (Date.now() < deadline && ctx === undefined) {
    const r = await fetch(`${url}/v1/models`);
    const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
    ctx = data.data?.find((m) => m.id === "alpha")?.context_length;
    if (ctx === undefined) await new Promise((r2) => setTimeout(r2, 50));
  }
  assert.equal(ctx, 4096, "the window reaches /v1/models as it always did");

  const chat = (body: Record<string, unknown>) =>
    fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "alpha", ...body }),
    });

  // A prompt that fits runs, and the backend sees it.
  const ok = await chat({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(ok.status, 200);
  assert.equal(be.ran(), 1);

  // One that does not is refused here, and the backend never hears about it.
  const over = await chat({ messages: [{ role: "user", content: "x".repeat(200_000) }] });
  assert.equal(over.status, 400, "an oversized prompt is a 400, not a 502 from downstream");
  const body = (await over.json()) as { error?: { message?: string } };
  assert.ok(body.error?.message?.includes("4096"), `and the message names the window: ${body.error?.message}`);
  assert.equal(be.ran(), 1, "the backend was never asked to run it");

  // Same for the two capability refusals, on the same evidence.
  const img = await chat({
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
  });
  assert.equal(img.status, 400, "a text-only model refuses an image before dispatch");
  const tools = await chat({
    messages: [{ role: "user", content: "go" }],
    tools: [{ type: "function", function: { name: "ls" } }],
  });
  assert.equal(tools.status, 400, "and a template with no tool support refuses tools");
  assert.equal(be.ran(), 1);

  await node.close();
  be.close();
}

/* ---------------------------------------------- a bare llama-server's window */

// A `single` backend reports the gguf PATH as its model id while `serves`
// advertises a human name, so the two never match. Stats filed under the wire id
// were therefore filed under a name nothing would ever look up, and every
// sidecar — guard, judge, the embedder — reported an unknown window forever.
// One backend, one model, one answer, whatever it is asked under.
{
  const server = createServer((req, res) => {
    const u = req.url ?? "";
    if (u === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "/root/models/nomic-embed.gguf" }] }));
      return;
    }
    if (u === "/props") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: 512 } }));
      return;
    }
    res.writeHead(404); res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url0 = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const cfg = parseConfig({
    name: "me",
    backends: [{ name: "embed", url: url0, kind: "single", serves: ["embed"] }],
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  const deadline = Date.now() + 3000;
  let ctx: number | undefined;
  while (Date.now() < deadline && ctx === undefined) {
    const r = await fetch(`${url}/v1/models`);
    const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
    ctx = data.data?.find((m) => m.id === "embed")?.context_length;
    if (ctx === undefined) await new Promise((r2) => setTimeout(r2, 50));
  }
  assert.equal(ctx, 512, "a single backend's window is reported under the id it is advertised as");

  await node.close();
  server.closeAllConnections();
  server.close();
}

console.log("stats ok");
