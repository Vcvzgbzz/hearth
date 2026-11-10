/**
 * The contract every backend kind meets. It loops over KINDS, so a new kind is held to it
 * the moment it is added: answer warm state or say it cannot, never load a cold model to
 * learn its stats, and either clear the card on request or be refused where it would have to.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { ConfigError } from "../src/config/read.js";
import { KIND_SPECS, type KindName } from "../src/config/kinds.js";
import { KINDS } from "../src/queue/kinds.js";
import { silentLogger } from "../src/observe/log.js";
import { parseV1 } from "./v1.js";

/** Paths the fake backend was asked, and how it answers an unload. */
const asked: string[] = [];
let unloadStatus = 200;

const server = createServer((req, res) => {
  const path = req.url ?? "/";
  asked.push(path);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (path === "/v1/models") return json({ data: [{ id: "warm", max_model_len: 4096 }] });
  if (path === "/running") return json({ running: [{ model: "warm", state: "ready", cmd: "llama-server --n-cpu-moe 4" }] });
  if (path === "/api/ps") return json({ models: [{ model: "warm" }] });
  if (path === "/api/show") return json({ model_info: { "x.context_length": 4096 } });
  if (path === "/api/models/unload") return json({}, unloadStatus);
  if (path.startsWith("/api/models/unload/")) return json({}, unloadStatus);
  if (path.endsWith("/props")) return json({ default_generation_settings: { n_ctx: 4096 } });
  json({ error: "not found" }, 404);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

for (const [name, k] of Object.entries(KINDS) as [KindName, (typeof KINDS)[KindName]][]) {
  // --- warm state: an answer exactly when the kind claims to know ------------------
  const reading = await k.readWarm(url, ["warm"]);
  assert.equal(reading !== null, k.knowsWarm, `${name}: readWarm answers iff knowsWarm`);
  if (reading) assert.ok(reading.loaded.includes("warm"), `${name}: sees the loaded model`);

  // --- stats: asking about a cold model must not reach that model -------------------
  asked.length = 0;
  await k.stats(url, "cold", ["warm"]).catch(() => ({}));
  if (!k.single) {
    assert.ok(!asked.some((p) => p.includes("/upstream/cold")), `${name}: a stats probe would load a cold model`);
  }

  // --- unload: a refusal throws, a down backend does not ----------------------------
  if (k.unload) {
    unloadStatus = 500;
    await assert.rejects(k.unload(url, silentLogger), `${name}: a refused unload must throw`);
    unloadStatus = 200;
    assert.equal(await k.unload(url, silentLogger), true, `${name}: a clean unload says so`);
    assert.equal(await k.unload("http://127.0.0.1:1", silentLogger), false, `${name}: a down backend is not cleared`);
  }

  // --- dropping ONE model: what the canary's recovery is built on ------------------
  // Unloading the whole card to recover one broken model would evict a neighbour
  // that was working, so a recovery needs a per-model drop or none at all.
  // llama-swap has one (`POST /api/models/unload/:model_id`) and the canary's
  // gentle recovery is the reason it must keep having one.
  if (name === "llama-swap") {
    assert.ok(k.unloadModel, `${name}: a swapping backend must offer a per-model drop`);
  }
  if (k.unloadModel) {
    asked.length = 0;
    unloadStatus = 500;
    assert.equal(await k.unloadModel(url, "warm", silentLogger), false,
      `${name}: a refused per-model unload is not a drop`);
    unloadStatus = 200;
    assert.equal(await k.unloadModel(url, "warm", silentLogger), true,
      `${name}: a clean per-model unload says so`);
    assert.ok(asked.includes("/api/models/unload/warm"),
      `${name}: the model is named in the path, and only that model is dropped`);
    // An id with a slash stays ONE path segment, or llama-swap reads it as a different route.
    await k.unloadModel(url, "author/model", silentLogger);
    assert.ok(asked.includes("/api/models/unload/author%2Fmodel"),
      `${name}: a slashed id is encoded, not left to become a deeper path`);
    assert.equal(await k.unloadModel("http://127.0.0.1:1", "warm", silentLogger), false,
      `${name}: a down backend is not dropped`);
  }

  // --- config: a kind that holds a model it cannot unload never shares a contested card
  const shared = () => parseV1({
    name: "t",
    resources: { gpu0: { kind: "gpu" } },
    backends: [
      { name: "a", url, kind: name, serves: ["a"], resources: ["gpu0"] },
      { name: "b", url, kind: "llama-swap", serves: ["b"], resources: ["gpu0"] },
    ],
  });
  if (k.knowsWarm && !k.unload) assert.throws(shared, ConfigError, `${name}: refused on a contested card`);
  else shared();
}

// --- the escape hatches the refusal names both work ---------------------------------
parseV1({
  name: "t",
  resources: { gpu0: { kind: "gpu" } },
  backends: [
    { name: "a", url, kind: "single", serves: ["a"], resources: ["gpu0"], resident: true },
    { name: "b", url, kind: "llama-swap", serves: ["b"], resources: ["gpu0"] },
  ],
});
parseV1({
  name: "t",
  resources: { cpu: { kind: "cpu", shared: true } },
  backends: [
    { name: "a", url, kind: "single", serves: ["a"], resources: ["cpu"] },
    { name: "b", url, kind: "single", serves: ["b"], resources: ["cpu"] },
  ],
});

server.closeAllConnections();
server.close();
// config/kinds.ts states two facts about each kind for validation; the kind itself must agree.
for (const [name, spec] of Object.entries(KIND_SPECS) as [KindName, (typeof KIND_SPECS)[KindName]][]) {
  assert.equal(KINDS[name].knowsWarm, spec.knowsWarm, `${name}: knowsWarm agrees with config/kinds.ts`);
  assert.equal(typeof KINDS[name].unload === "function", spec.unloads, `${name}: unloads agrees with config/kinds.ts`);
}

console.log("kinds.test.ts ok");
