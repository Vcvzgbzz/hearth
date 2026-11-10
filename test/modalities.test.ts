/**
 * Self-check for input_modalities reporting on /v1/models.
 *
 * The claim under test: a model hearth knows to take images, or knows not to, says so on
 * /v1/models, so a client reads what it may send instead of having it ticked by hand. The
 * running process's own word wins, a declared `stats.vision` covers a model that has not
 * loaded or a backend that cannot say (vLLM), and a model nobody has spoken for carries no
 * field at all: unknown is not "text only".
 *
 *     npx tsx test/modalities.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseV1 } from "./v1.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode, type HearthNode } from "../src/server.js";

/** A mock llama-swap backend whose loaded model answers /props as llama.cpp does. */
function swapBackend(vision: boolean) {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url === "/running") return json({ running: [{ model: "alpha", state: "ready" }] });
    if (url === "/v1/models") return json({ data: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] });
    if (url === "/upstream/alpha/props") {
      return json({
        default_generation_settings: { n_ctx: 131072 },
        modalities: { vision, video: false, audio: false },
      });
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

type Entry = { id: string; context_length?: number; input_modalities?: string[] };

/** The listing once alpha's stats have landed (learning them is fire-and-forget). */
async function listing(url: string, timeout = 3000): Promise<Entry[]> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const data = ((await (await fetch(`${url}/v1/models`)).json()) as { data?: Entry[] }).data ?? [];
    if (data.find((m) => m.id === "alpha")?.context_length !== undefined || Date.now() > deadline) return data;
    await new Promise((r) => setTimeout(r, 50));
  }
}

for (const vision of [true, false]) {
  const be = swapBackend(vision);
  await be.listen();
  const cfg = parseV1({
    name: "me",
    backend: { url: be.url(), kind: "llama-swap" },
    scheduler: { lanes: { chat: { priority: 0 } } },
    // alpha is declared the opposite of what it reports, so the test shows which one wins.
    models: { alpha: { stats: { vision: !vision } }, beta: { stats: { vision: true } } },
  });
  const node = createNode(cfg, silentLogger);
  const url = await listen(node);
  await node.pool.first().state.ensureFresh();

  const data = await listing(url);
  const of = (id: string) => data.find((m) => m.id === id);

  assert.deepEqual(
    of("alpha")?.input_modalities,
    vision ? ["text", "image"] : ["text"],
    "a loaded model reports what its own process says, over the declaration",
  );
  assert.deepEqual(
    of("beta")?.input_modalities,
    ["text", "image"],
    "a cold model reports its declared stats.vision",
  );
  assert.ok(of("gamma") !== undefined, "the undeclared model is still listed");
  assert.ok(
    !("input_modalities" in of("gamma")!),
    "a model nobody has spoken for carries no input_modalities field",
  );

  await node.close();
  be.close();
}

console.log("modalities: ok");
