/**
 * Self-check for `models.<id>.params` — several advertised ids fronting ONE
 * resident backend model, each stamping its own request defaults.
 *
 * The arrangement this exists for: a one-GPU box whose single llama-swap seat
 * honours `reasoning_effort`, and a client (a chat UI with only a model picker)
 * that cannot set the field itself. `seat-low`, `seat-off` and friends all
 * resolve to the same backend model — no second process, so no seat swap — and
 * differ only in what they stamp. The failure this guards against is a stamp
 * that a client's own value could undo: the id IS the user's choice, so the
 * route's params must win over whatever the client sent.
 *
 *     npx tsx test/params.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { ConfigError, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode, type HearthNode } from "../src/server.js";

/** A backend that records exactly what it was sent. */
function recordingBackend(realIds: string[]) {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: realIds.map((id) => ({ id })) }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      } catch {
        body = {};
      }
      seen.push({ path: req.url ?? "", body });
      const model = typeof body.model === "string" ? body.model : "";
      if (model !== "" && !realIds.includes(model)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`model "${model}" not found`);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, served: model }));
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

async function chat(url: string, body: Record<string, unknown>) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SEAT = "seat";          // what the backend calls it, and also a first-class id here
const HIDDEN = "raw-hidden";  // a backend id that exists only to be renamed

const be = recordingBackend([SEAT, HIDDEN]);
await be.listen();

const cfg = parseConfig({
  name: "me",
  backends: [{ name: "swap", url: be.url(), kind: "none" }],
  models: {
    [SEAT]: { backend: "swap" },
    "seat-low": { backend: "swap", as: SEAT, params: { reasoning_effort: "low", temperature: 0.1 } },
    "seat-off": { backend: "swap", as: SEAT, params: { reasoning_effort: "none" } },
    nice: { backend: "swap", as: HIDDEN },
  },
});
const node = createNode(cfg, silentLogger);
const url = await listen(node);
await node.pool.first().state.refresh();

// --- config: params is parsed, and absent means null ------------------------
{
  assert.deepEqual(cfg.models["seat-low"]!.params, { reasoning_effort: "low", temperature: 0.1 });
  assert.equal(cfg.models["seat-low"]!.as, SEAT, "params rides alongside as");
  assert.equal(cfg.models[SEAT]!.params, null, "a plain route carries no params");
}

// --- config: the keys a request cannot function without are refused ----------
{
  const base = { name: "x", backend: { url: be.url() } };
  assert.throws(
    () => parseConfig({ ...base, models: { m: { params: { model: "other" } } } }),
    (e: unknown) => e instanceof ConfigError && /use `as`/.test((e as Error).message),
    "stamping `model` is what `as` is for",
  );
  assert.throws(() => parseConfig({ ...base, models: { m: { params: { messages: [] } } } }), ConfigError);
  assert.throws(() => parseConfig({ ...base, models: { m: { params: { stream: true } } } }), ConfigError);
  assert.throws(() => parseConfig({ ...base, models: { m: { params: { lane: "batch" } } } }), ConfigError);
  assert.throws(() => parseConfig({ ...base, models: { m: { params: "low" } } }), ConfigError, "must be an object");
  assert.equal(parseConfig({ ...base, models: { m: { params: {} } } }).models.m!.params, null, "empty is absent");
}

// --- the catalog lists every id that fronts the seat, AND the seat itself -----
// The raw id is a first-class route here, so hiding it (the plain-alias rule)
// would take away the id every other client already uses.
{
  const r = await fetch(`${url}/v1/models`);
  const ids = ((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id);
  for (const want of [SEAT, "seat-low", "seat-off", "nice"]) {
    assert.ok(ids.includes(want), `catalog advertises ${want}`);
  }
  assert.ok(!ids.includes(HIDDEN), "a raw id that exists only to be renamed still does not leak");
}

// --- THE POINT: params are stamped on the wire, and they win ----------------
{
  const r = await chat(url, {
    model: "seat-low",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "high",   // the client's habit; the id the user picked says low
    top_p: 0.9,                 // untouched fields ride through
    lane: "chat",               // hearth's own field, stripped before forwarding
  });
  assert.equal(r.status, 200, "a request for a params id must reach the backend");
  const sent = be.seen.at(-1)!.body;
  assert.equal(sent.model, SEAT, "the backend was asked in its own vocabulary");
  assert.equal(sent.reasoning_effort, "low", "the route's value wins over the client's");
  assert.equal(sent.temperature, 0.1, "every stamped field lands");
  assert.equal(sent.top_p, 0.9, "fields the route does not mention are untouched");
  assert.equal("lane" in sent, false, "hearth's lane field never reaches a backend");
  assert.deepEqual(sent.messages, [{ role: "user", content: "hi" }], "the conversation is untouched");
}

// --- two ids, one seat, different stamps ------------------------------------
{
  const r = await chat(url, { model: "seat-off", messages: [] });
  assert.equal(r.status, 200);
  const sent = be.seen.at(-1)!.body;
  assert.equal(sent.model, SEAT);
  assert.equal(sent.reasoning_effort, "none");
  assert.equal("temperature" in sent, false, "one id's params do not bleed into another's");
}

// --- the plain id is completely unaffected ----------------------------------
{
  const r = await chat(url, { model: SEAT, messages: [], reasoning_effort: "high" });
  assert.equal(r.status, 200);
  const sent = be.seen.at(-1)!.body;
  assert.equal(sent.model, SEAT);
  assert.equal(sent.reasoning_effort, "high", "no route params, so the client's value stands");
}

// --- pool: one place owns the body rewrite ----------------------------------
{
  const body = { model: "seat-low", messages: [], reasoning_effort: "high" };
  const out = node.pool.outboundBody("seat-low", body);
  assert.equal(out.model, SEAT);
  assert.equal(out.reasoning_effort, "low");
  assert.notEqual(out, body, "a stamped body is a copy");
  const plain = { model: SEAT, messages: [] };
  assert.equal(node.pool.outboundBody(SEAT, plain), plain, "identity for a route without as or params");
  assert.equal(node.pool.for("seat-low").name, "swap", "resolution follows the alias");
}

await node.close();
be.close();
console.log("params.test.ts ok");
