/**
 * Two backends on ONE llama-swap that take turns on one card: a chat backend that declares
 * nothing, and an app backend that declares what it `serves`.
 *
 * The URL reports every model it holds, so unless each backend reads only its own ids the app
 * backend looks resident whenever the chat model is loaded. Every chat job then "evicts" it,
 * and clearing the whole URL unloads the chat model the job is about to use. What is asserted
 * here: on a shared URL each backend counts only its own ids, and evicting either one drops
 * only its own ids, one by one, so the other keeps its weights.
 *
 *     npx tsx test/shared-swap.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

/**
 * A llama-swap stand-in: /running is ours to set (a `~` prefix marks a model still starting),
 * every unload is recorded, and a per-model unload of a model it does not hold answers 404.
 */
let running: string[] = [];
let refuse = false;
const unloads: string[] = [];
const swap = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/running") {
    const rows = running.map((m) => m.startsWith("~") ? { model: m.slice(1), state: "starting" } : { model: m, state: "ready" });
    return void res.end(JSON.stringify({ running: rows }));
  }
  if (req.url === "/v1/models") {
    return void res.end(JSON.stringify({ data: [{ id: "chat-model" }, { id: "image-app" }] }));
  }
  if (req.url === "/api/models/unload") {
    unloads.push(req.url);
    running = [];
    return void res.end("ok");
  }
  if (req.url?.startsWith("/api/models/unload/")) {
    unloads.push(req.url);
    const id = decodeURIComponent(req.url.slice("/api/models/unload/".length));
    const held = running.some((m) => m === id || m === `~${id}`);
    if (refuse || !held) {
      res.statusCode = refuse ? 500 : 404;
      return void res.end("{}");
    }
    running = running.filter((m) => m !== id && m !== `~${id}`);
    return void res.end("ok");
  }
  res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
});
await new Promise<void>((r) => swap.listen(0, "127.0.0.1", r));
const swapUrl = `http://127.0.0.1:${(swap.address() as AddressInfo).port}`;

const node = createNode(
  parseV1({
    name: "shared-swap",
    backends: [
      { name: "chat", url: swapUrl, kind: "llama-swap", concurrency: 4, resources: ["gpu1"] },
      { name: "app", url: swapUrl, kind: "llama-swap", serves: ["image-app"], resources: ["gpu1"] },
    ],
  }),
  silentLogger,
);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const refresh = () => Promise.all(node.pool.all().map((b) => b.state.refresh()));
const chat = async (model: string) => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }] }),
  });
  await r.text();
  return r.status;
};
const app = node.pool.get("app")!.state;
const chatState = node.pool.get("chat")!.state;

try {
  // --- the declaring backend does not count its sibling's model --------------------------
  {
    running = ["chat-model"];
    await refresh();
    assert.deepEqual(app.loaded(), [], "the app backend does not see the chat model as its own");
    assert.equal(app.resident(), null, "so it is not resident");
    assert.equal(app.isWarm("chat-model"), false);
    assert.deepEqual(app.catalog(), ["image-app"], "nor as something it could load");
    assert.deepEqual(chatState.loaded(), ["chat-model"], "the chat backend still sees its own model");
  }

  // --- THE POINT: a chat job never unloads the chat model --------------------------------
  {
    unloads.length = 0;
    assert.equal(await chat("chat-model"), 200);
    assert.deepEqual(unloads, [], "nothing was unloaded: the app backend held nothing");
    assert.deepEqual(running, ["chat-model"]);
  }

  // --- evicting the app backend drops only its own model ---------------------------------
  {
    running = ["chat-model", "image-app"];
    await refresh();
    assert.equal(app.resident(), "image-app");
    unloads.length = 0;
    assert.equal(await chat("chat-model"), 200);
    assert.deepEqual(unloads, ["/api/models/unload/image-app"], "a per-model unload, never the whole URL");
    assert.deepEqual(running, ["chat-model"], "the chat model stayed loaded");
    assert.equal(app.resident(), null, "and the app backend reads as cleared");
  }

  // --- the other way round: evicting the chat backend leaves the app model loaded ---------
  {
    running = ["chat-model", "image-app"];
    await refresh();
    unloads.length = 0;
    assert.equal(await chat("image-app"), 200);
    assert.deepEqual(unloads, ["/api/models/unload/chat-model"], "the backend without `serves` drops its own model by id too");
    assert.deepEqual(running, ["image-app"], "the app model stayed loaded");
  }

  // --- a model still loading is dropped as well, or the next one loads on top of it -------
  {
    running = ["chat-model", "~image-app"];
    await refresh();
    unloads.length = 0;
    assert.equal(await chat("chat-model"), 200);
    assert.deepEqual(unloads, ["/api/models/unload/image-app"]);
    assert.deepEqual(running, ["chat-model"]);
  }

  // --- a drop refused because the model is already gone does not fail the job ------------
  {
    running = ["chat-model", "image-app"];
    await refresh();
    running = ["chat-model"]; // gone behind hearth's back
    unloads.length = 0;
    assert.equal(await chat("chat-model"), 200, "the re-read shows the card clear");
    assert.deepEqual(unloads, ["/api/models/unload/image-app"]);
  }

  // --- a drop refused while the model is still loaded fails the job -----------------------
  {
    running = ["chat-model", "image-app"];
    await refresh();
    refuse = true;
    assert.notEqual(await chat("chat-model"), 200, "nothing loads on top of a model that would not go");
    assert.equal(app.resident(), "image-app");
    refuse = false;
  }
} finally {
  node.server.closeAllConnections();
  node.server.close();
  swap.closeAllConnections();
  swap.close();
}

console.log("shared-swap.test.ts ok");
