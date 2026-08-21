/**
 * Self-check for `models.<id>.as` — advertising one id while a backend serves
 * another.
 *
 * The failure this guards against is a HALF-APPLIED alias. hearth has two
 * dispatch paths: chat completions go through the router, and everything else
 * (notably /v1/embeddings) goes through the verbatim passthrough. An alias that
 * only rewrites one of them is worse than no alias at all — the model appears
 * to work until you hit the other endpoint, and the 404 comes from a backend
 * complaining about a name the user never typed.
 *
 *     npx tsx test/alias.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode, type HearthNode } from "../src/server.js";

/** A backend that only answers to its OWN id, like the real thing. */
function pickyBackend(realId: string) {
  const seen: { path: string; model: string | null }[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: realId }] }));
      return;
    }
    // Ollama reports warm state on /api/ps, not /running — the alias has to
    // survive translation from whatever vocabulary the backend uses.
    if (req.url === "/api/ps") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: realId }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let model: string | null = null;
      try {
        model = (JSON.parse(Buffer.concat(chunks).toString() || "{}") as { model?: string }).model ?? null;
      } catch {
        model = null;
      }
      seen.push({ path: req.url ?? "", model });
      // The point of "picky": a name it does not know is a 404, exactly as
      // Ollama would answer for an id that is not in its catalog.
      if (model !== null && model !== realId) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`model "${model}" not found`);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, served: realId }));
    });
  });
  return {
    seen,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

function listen(node: HearthNode): Promise<string> {
  return new Promise((ready) => {
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`),
    );
  });
}

const REAL = "nomic-embed-text-v2-moe:latest";
const NICE = "nomic-embed";

const be = pickyBackend(REAL);
await be.listen();

const cfg = parseConfig({
  name: "me",
  backends: [{ name: "ollama", url: be.url(), kind: "ollama" }],
  models: { [NICE]: { backend: "ollama", as: REAL } },
});
const node = createNode(cfg, silentLogger);
const url = await listen(node);
await node.pool.first().state.refresh();

// --- the catalog advertises OUR name, not the backend's --------------------
{
  const r = await fetch(`${url}/v1/models`);
  const body = (await r.json()) as { data: { id: string }[] };
  const ids = body.data.map((m) => m.id);
  assert.ok(ids.includes(NICE), "the alias is what clients see");
  assert.ok(!ids.includes(REAL), "the backend's raw id does not leak to clients");
}

// --- chat dispatch rewrites the id ----------------------------------------
{
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: NICE, messages: [] }),
  });
  assert.equal(r.status, 200, "a request for the alias must not 404");
  assert.equal(be.seen.at(-1)?.model, REAL, "the backend was asked in its own vocabulary");
}

// --- THE ONE THAT MOTIVATED THIS: the passthrough rewrites it too ----------
// /v1/embeddings never touches the chat router. Before this, the alias worked
// for chat and 404'd here, which is the half-applied failure.
{
  const r = await fetch(`${url}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: NICE, input: "hello" }),
  });
  assert.equal(r.status, 200, "embeddings must be rewritten too, not forwarded verbatim");
  const last = be.seen.at(-1)!;
  assert.equal(last.path, "/v1/embeddings");
  assert.equal(last.model, REAL, "the passthrough sent the backend's id");
}

// --- warm state is reported under the advertised id ------------------------
// Not cosmetic: `loaded` feeds the scheduler's warm bonus and readyNow. Left
// untranslated an aliased model reads as permanently cold.
{
  assert.ok(node.pool.loaded().includes(NICE), "warm state uses the advertised id");
  assert.ok(!node.pool.loaded().includes(REAL), "and not the raw one");
  assert.equal(node.pool.capacityFor(NICE).warm, true, "capacityFor agrees");
}

// --- resolution still finds the right backend ------------------------------
{
  assert.equal(node.pool.outboundId(NICE), REAL, "one place owns the rewrite");
  assert.equal(node.pool.outboundId("something-else"), "something-else", "identity otherwise");
  assert.equal(node.pool.for(NICE).name, "ollama");
}

// --- a model without `as` is completely unaffected -------------------------
{
  const plain = parseConfig({ name: "p", backend: { url: be.url() } });
  assert.equal(plain.models["anything"]?.as ?? null, null);
}

// --- `as` and a peer policy are two destinations, not two rewrites ---------
// These were refused together, on the reasoning that two rewrites of one id
// with no way to see which applied is a bug factory. They are not two rewrites
// of one dispatch: outboundId() above is the local path and nothing else calls
// it, while a peer dispatch takes its id from that peer's map. `fastest` across
// a model you serve under one name and borrow under another is the case that
// wants both, and refusing it made the console's link button unusable for
// exactly the models most worth linking.
{
  const both = parseConfig({
    name: "x",
    backend: { url: be.url() },
    peers: [{ name: "f", url: "http://127.0.0.1:1", token: "t", models: { m: "their-m" } }],
    models: { m: { policy: "peer", as: "local-m" } },
  });
  assert.equal(both.models.m!.as, "local-m", "the local rewrite survives");
  assert.equal(both.peers[0]!.models.m, "their-m", "and so does the peer's own id for it");
}

await node.close();
be.close();
console.log("alias.test.ts ok");
