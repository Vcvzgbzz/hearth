/**
 * Self-check for `models.<id>.follow` — an id that means "whatever this
 * backend has loaded right now".
 *
 * The arrangement this exists for: a card whose seat gets swapped by hand for
 * testing, and clients (agent harnesses, memory services) pinned to one model
 * id. Pinned to the old id, every one of their requests swaps the card back,
 * and the test and the clients fight over it. A `follow` id goes out as the
 * backend's resident model, so the clients ride along with whatever is loaded;
 * `as` is only the model to load when nothing is.
 *
 *     npx tsx test/follow.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { ConfigError, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

/** A llama-swap stand-in: /running is ours to set, chat bodies are recorded. */
function fakeSwap(ids: string[]) {
  let running: { model: string; state: string }[] = [];
  const seen: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      // Only what a client sent: hearth's own probes of a loaded model are not chat.
      if (req.method === "POST") seen.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, served: body.model }));
    });
  });
  return {
    seen,
    load: (model: string | string[] | null) => {
      running = (model === null ? [] : [model].flat()).map((m) => ({ model: m, state: "ready" }));
    },
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

const card = fakeSwap(["main", "trial"]);
await card.listen();

const cfg = parseConfig({
  name: "follow",
  backends: [{ name: "card", url: card.url(), kind: "llama-swap", concurrency: 2, serves: ["main", "trial"] }],
  models: {
    main: { backend: "card", pool: 1000 },
    trial: { backend: "card", pool: { tokens: 2000, output: 64 } },
    loaded: { backend: "card", as: "main", follow: true },
    "loaded-off": { backend: "card", as: "main", follow: true, params: { reasoning_effort: "none" } },
  },
});
const node = createNode(cfg, silentLogger);
node.start();
const url = await new Promise<string>((ready) =>
  node.server.listen(0, "127.0.0.1", () =>
    ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
);

async function send(model: string): Promise<Record<string, unknown>> {
  await node.pool.first().state.refresh();
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 200, `${model} must reach the backend`);
  await r.text();
  return card.seen.at(-1)!;
}

try {
  // --- config -----------------------------------------------------------------
  {
    assert.equal(cfg.models.loaded!.follow, true);
    assert.equal(cfg.models.main!.follow, false, "absent means off");
    const base = { name: "x", backends: [{ name: "card", url: card.url(), kind: "llama-swap" }] };
    assert.throws(
      () => parseConfig({ ...base, models: { f: { as: "main", follow: true } } }),
      (e: unknown) => e instanceof ConfigError && /backend/.test((e as Error).message),
      "following needs a backend to follow",
    );
    assert.throws(
      () => parseConfig({ ...base, models: { f: { backend: "card", follow: true } } }),
      (e: unknown) => e instanceof ConfigError && /as/.test((e as Error).message),
      "following needs a model to load when nothing is",
    );
    assert.throws(() => parseConfig({ ...base, models: { f: { backend: "card", as: "main", follow: "yes" } } }), ConfigError);
  }

  // --- nothing loaded: `as` is what goes out, so the default seat loads ---------
  card.load(null);
  assert.equal((await send("loaded")).model, "main");

  // --- THE POINT: a hand-swapped seat is followed, not swapped back -------------
  card.load("trial");
  assert.equal((await send("loaded")).model, "trial", "goes out as the resident model");
  const off = await send("loaded-off");
  assert.equal(off.model, "trial");
  assert.equal(off.reasoning_effort, "none", "params still stamp on the followed model");

  // --- and back again: the default seat is followed too ------------------------
  card.load("main");
  assert.equal((await send("loaded")).model, "main");

  // --- several loaded: `as` wins when it is one of them, so the pick is never arbitrary ---
  card.load(["trial", "main"]);
  assert.equal((await send("loaded")).model, "main", "`as` is preferred among several resident models");
  card.load(["trial"]);
  assert.equal((await send("loaded")).model, "trial");

  // --- a plain id is unaffected: asking for `trial` by name still means trial ---
  assert.equal((await send("trial")).model, "trial");

  // --- the catalogue advertises the follow ids --------------------------------
  {
    const r = await fetch(`${url}/v1/models`);
    const ids = ((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id);
    for (const want of ["loaded", "loaded-off", "main", "trial"]) assert.ok(ids.includes(want), `catalog advertises ${want}`);
  }
  // --- a follow id is warm whenever its backend has ANYTHING loaded -----------
  // It never costs a load while something is resident, so it must not read cold
  // (and lose the warm bonus) just because the resident model is not its `as`.
  {
    card.load("trial");
    await node.pool.first().state.refresh();
    const loaded = node.pool.loaded();
    assert.ok(loaded.includes("loaded") && loaded.includes("loaded-off"), "follow ids warm on the trial seat");
    assert.ok(!loaded.includes("main"), "and the default seat is still honestly cold");
    card.load(null);
    await node.pool.first().state.refresh();
    assert.ok(!node.pool.loaded().includes("loaded"), "nothing resident, nothing warm");
  }

  // --- the shared pool is the followed seat's, like its slots -----------------
  // The scheduler counts a pool per wire id, so a follow id must size it from
  // the model it goes out as, not from the `as` it would load on an empty card.
  {
    const need = { tokens: 500, output: 200, images: false, tools: false };
    card.load("trial");
    await node.pool.first().state.refresh();
    assert.equal(node.pool.poolTokens("loaded", need), 364, "the trial seat's output cap applies");
    card.load("main");
    await node.pool.first().state.refresh();
    assert.equal(node.pool.poolTokens("loaded", need), 500, "and the default seat's pool when that is loaded");
  }

  // --- the way back from the backend's vocabulary never lands on a follow id --
  // The status page and history name a resident model by its advertised id; a
  // follow id is not a name for `main`, it is a name for "whatever is loaded".
  assert.equal(node.pool.advertised("main"), "main");
  console.log("follow: ok");
} finally {
  await node.close();
  card.close();
}
