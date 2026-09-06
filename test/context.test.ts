/**
 * Self-check for context_length reporting on /v1/models.
 *
 * The claim under test: every model hearth advertises carries the context window
 * its backend actually runs it with, so a client can size its own limit from
 * /v1/models instead of a hand-maintained number. A cold model must not be
 * probed (llama-swap loads a model to answer /props), and unknown is distinct
 * from a value — the field is absent, not null, when unknown.
 *
 *     npx tsx test/context.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode, type HearthNode } from "../src/server.js";

/** A mock llama-swap backend that tracks calls to /upstream/<id>/props. */
function swapBackend() {
  let loaded: string | null = null;
  let nCtx = 131072;
  const propsCalls: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        running: loaded ? [{ model: loaded, state: "ready" }] : [],
      }));
      return;
    }
    if (url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
      return;
    }
    const m = /^\/upstream\/([^/]+)\/props$/.exec(url);
    if (m) {
      propsCalls.push(m[1]!);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        default_generation_settings: { n_ctx: nCtx },
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  return {
    propsCalls,
    setLoaded: (m: string | null) => { loaded = m; },
    setCtx: (n: number) => { nCtx = n; },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

/** A mock ollama backend. */
function ollamaBackend() {
  let numCtx: string | null = "num_ctx 32768\n";
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
      return;
    }
    if (url === "/api/ps") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
      return;
    }
    if (url === "/api/show") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          model_info: { "qwen3.context_length": 40960 },
          parameters: numCtx,
        }));
      });
      return;
    }
    if (url === "/v1/models") {
      // Ollama itself does not serve /v1/models, but hearth queries it for
      // the catalog. Return an empty list so warm state still works from /api/ps.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  return {
    setNumCtx: (s: string | null) => { numCtx = s; },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

/** A mock single-model llama.cpp server. */
function singleBackend() {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "solo" }] }));
      return;
    }
    if (url === "/props") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  return {
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

/** Wait for context_length to appear (learnContext is fire-and-forget). */
async function waitForContext(url: string, id: string, timeout = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/v1/models`);
      const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
      const entry = data.data?.find((m) => m.id === id);
      if (entry?.context_length !== undefined) return true;
    } catch {
      // transient
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// --- loaded llama-swap model reports context_length ---------------------------
{
  const be = swapBackend();
  await be.listen();
  be.setLoaded("alpha");
  const cfg = parseConfig({
    name: "me",
    backend: { url: be.url(), kind: "llama-swap" },
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  const got = await waitForContext(url, "alpha");
  assert.ok(got, "a loaded llama-swap model reports context_length on /v1/models");

  const r = await fetch(`${url}/v1/models`);
  const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
  const alpha = data.data?.find((m) => m.id === "alpha");
  assert.equal(alpha?.context_length, 131072, "the value is the backend's n_ctx");

  // And it did not probe the cold model beta.
  assert.ok(
    !be.propsCalls.includes("beta"),
    "a cold llama-swap model is never probed for context_length",
  );

  await node.close();
  be.close();
}

// --- cold llama-swap model has NO context_length, not probed ------------------
{
  const be = swapBackend();
  await be.listen();
  be.setLoaded("alpha");
  const cfg = parseConfig({
    name: "me",
    backend: { url: be.url(), kind: "llama-swap" },
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  // Give alpha time to learn, beta never will.
  await waitForContext(url, "alpha");
  await new Promise((r) => setTimeout(r, 200));

  const r = await fetch(`${url}/v1/models`);
  const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
  const beta = data.data?.find((m) => m.id === "beta");
  assert.ok(
    beta?.context_length === undefined,
    "a cold llama-swap model has no context_length field",
  );
  assert.ok(
    !be.propsCalls.includes("beta"),
    "and the mock's /upstream/beta/props counter is 0",
  );

  await node.close();
  be.close();
}

// --- ollama: num_ctx wins over model max --------------------------------------
{
  const be = ollamaBackend();
  await be.listen();
  // Ollama does not serve /v1/models; declare the model explicitly so the
  // catalog is populated from config rather than a failed catalog query.
  const cfg = parseConfig({
    name: "me",
    backend: { url: be.url(), kind: "ollama", serves: ["qwen3:8b"] },
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  const got = await waitForContext(url, "qwen3:8b", 5000);
  assert.ok(got, "ollama reports context_length");

  const r = await fetch(`${url}/v1/models`);
  const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
  const entry = data.data?.find((m) => m.id === "qwen3:8b");
  assert.equal(
    entry?.context_length,
    32768,
    "num_ctx (32768) wins over the model's context_length (40960)",
  );

  await node.close();
  be.close();
}

// --- ollama without num_ctx reports the model max -----------------------------
{
  const be = ollamaBackend();
  await be.listen();
  be.setNumCtx(null);
  const cfg = parseConfig({
    name: "me",
    backend: { url: be.url(), kind: "ollama", serves: ["qwen3:8b"] },
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  const got = await waitForContext(url, "qwen3:8b");
  assert.ok(got, "ollama reports context_length even without num_ctx");

  const r = await fetch(`${url}/v1/models`);
  const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
  const entry = data.data?.find((m) => m.id === "qwen3:8b");
  assert.equal(
    entry?.context_length,
    40960,
    "without num_ctx, the model's context_length (40960) is reported",
  );

  await node.close();
  be.close();
}

// --- single backend: its model is always loaded, always reports context_length
{
  const be = singleBackend();
  await be.listen();
  const cfg = parseConfig({
    name: "me",
    backend: { url: be.url(), kind: "single" },
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  const got = await waitForContext(url, "solo");
  assert.ok(got, "a single backend model reports context_length");

  const r = await fetch(`${url}/v1/models`);
  const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
  const entry = data.data?.find((m) => m.id === "solo");
  assert.equal(entry?.context_length, 65536, "the value is the backend's n_ctx");

  await node.close();
  be.close();
}

// --- aliased id reports its wire's context_length -----------------------------
{
  const be = swapBackend();
  await be.listen();
  be.setLoaded("alpha");
  const cfg = parseConfig({
    name: "me",
    backend: { url: be.url(), kind: "llama-swap" },
    models: { fast: { as: "alpha" } },
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  // The pool learns context for the WIRE id (alpha); the advertised id (fast)
  // must report the same number.
  const got = await waitForContext(url, "fast");
  assert.ok(got, "an aliased id reports context_length");

  const r = await fetch(`${url}/v1/models`);
  const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
  const entry = data.data?.find((m) => m.id === "fast");
  assert.equal(
    entry?.context_length,
    131072,
    "the aliased id reports its wire's context_length",
  );

  await node.close();
  be.close();
}

// --- /ui/data.contexts carries known windows keyed by advertised id -----------
{
  const be = swapBackend();
  await be.listen();
  be.setLoaded("alpha");
  const cfg = parseConfig({
    name: "me",
    backend: { url: be.url(), kind: "llama-swap" },
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  await waitForContext(url, "alpha");
  await new Promise((r) => setTimeout(r, 200));

  const r = await fetch(`${url}/ui/data`);
  const data = (await r.json()) as { contexts?: Record<string, number> };
  const ctxs = data.contexts ?? {};
  assert.equal(
    ctxs.alpha,
    131072,
    "/ui/data.contexts carries the known window for a loaded model",
  );
  assert.ok(
    ctxs.beta === undefined,
    "/ui/data.contexts omits unknown (cold) models",
  );

  await node.close();
  be.close();
}

// --- a seat relaunched with a different -c is re-read on its next load -----
//
// The window is cached because it cannot change while the backend process
// lives. It CAN change between two of them: the operator swaps the seat's
// launch line and the same wire id comes back with a different n_ctx. If the
// cache survived that, hearth would advertise the old number for as long as it
// ran, which is the one thing this field exists to prevent.
{
  const be = swapBackend();
  await be.listen();
  be.setLoaded("alpha");
  const cfg = parseConfig({
    name: "me",
    backend: { url: be.url(), kind: "llama-swap" },
    scheduler: { lanes: { chat: { priority: 0 } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  const state = node.pool.first().state;
  await state.ensureFresh();
  assert.ok(await waitForContext(url, "alpha"), "learned once");

  // Unload, relaunch with a smaller window, load again.
  be.setLoaded(null);
  await state.refresh();
  be.setCtx(65536);
  be.setLoaded("alpha");
  await state.refresh();

  const deadline = Date.now() + 3000;
  let seen: number | undefined;
  while (Date.now() < deadline) {
    const r = await fetch(`${url}/v1/models`);
    const data = (await r.json()) as { data?: { id: string; context_length?: number }[] };
    seen = data.data?.find((m) => m.id === "alpha")?.context_length;
    if (seen === 65536) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(seen, 65536, "the window is re-read after the model is seen loaded again");

  await node.close();
  be.close();
}

console.log("context.test.ts ok");
