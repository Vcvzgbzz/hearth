/**
 * Lending limits per peer, and the count of what was lent and borrowed. Each limit is asserted from
 * the peer's side, since one that only shows on the lender's own page lends anyway.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import { closedWhy, termsFor } from "../src/lending.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

const at = (s: Server): string => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const listen = (s: Server): Promise<void> => new Promise((r) => s.listen(0, "127.0.0.1", r));

/* ------------------------------------------------------------- the terms, alone */

const ran = (tokens: number) => ({ requests: 1, failed: 0, in: tokens, out: 0 });

{
  const cfg = parseConfig({
    backends: { card: { url: "http://127.0.0.1:1", kind: "none", serves: ["big", "small"] } },
    lending: { models: ["small"], tokensPerDay: 100 },
    peers: {
      close: { accept: "a", lend: { models: ["big", "small"], tokensPerDay: 0, maxConcurrent: 4 } },
      other: { accept: "b" },
    },
  });
  const close = termsFor(cfg, "close");
  assert.deepEqual(close.models, ["big", "small"], "a peer's own list replaces the node's");
  assert.equal(close.tokensPerDay, 0, "and its own limit, even where that is none");
  assert.equal(close.maxConcurrent, 4);
  assert.equal(close.rateLimit, 600, "what it does not restate stays the node's");
  assert.match(closedWhy({ ...close, off: true }, ran(0))!, /lending to this peer is off/);
  const other = termsFor(cfg, "other");
  assert.deepEqual(other.models, ["small"], "a peer with no limits of its own gets the node's");
  assert.equal(closedWhy(other, ran(99)), null);
  assert.match(closedWhy(other, ran(100))!, /today's 100 tokens are used/);
  assert.equal(closedWhy(close, ran(1_000_000)), null, "no limit is no limit");
}

{
  const bad = (peers: unknown, lending: unknown = {}) => () => parseConfig({
    backends: { card: { url: "http://127.0.0.1:1", kind: "none", serves: ["m"] }, paid: { url: "https://provider.example/v1", cloud: true, key: "k", serves: ["theirs"] } },
    lending, peers,
  });
  assert.throws(bad({ p: { url: "http://127.0.0.1:2", token: "t", lend: { models: ["m"] } } }), /peers\.p\.lend .*needs its accept/, "terms for a peer that cannot borrow are a mistake");
  assert.throws(bad({ p: { accept: "a", lend: { model: ["m"] } } }), /did you mean models/);
  assert.throws(bad({ p: { accept: "a", lend: { models: ["theirs"] } } }), (e: unknown) => e instanceof ConfigError && /peers\.p\.lend\.models/.test(e.message) && /cloud/.test(e.message),
    "a provider's model is no more lendable to one peer than to all");
  assert.throws(bad({}, { tokensPerDay: -1 }), /lending\.tokensPerDay must be a whole number >= 0/);
}

/* ------------------------------------------------- and from the peer's side, over HTTP */

const backend = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "big" }, { id: "small" }] }));
    return;
  }
  // An answer is kept back while `held` is set, so a request can be found still in flight.
  void (held ?? Promise.resolve()).then(() => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 40, completion_tokens: 20 } }));
  });
});
let held: Promise<void> | null = null;
await listen(backend);

// The other end of borrowing: a peer that serves what this node sends it.
const friend = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url === "/peer/hello") return void res.end(JSON.stringify({ name: "close", protocol: 2, models: ["theirs"], lanes: ["chat"] }));
  if (req.url === "/peer/state") {
    return void res.end(JSON.stringify({ free: 1, slots: 1, queued: {}, resident: null, loaded: [], serves: ["theirs"], models: { theirs: { free: 1, slots: 1, queued: 0, warm: true } } }));
  }
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "theirs" } }], usage: { prompt_tokens: 30, completion_tokens: 10 } }));
});
await listen(friend);

const node = createNode(parseConfig({
  name: "lender",
  backends: { card: { url: at(backend), kind: "none", serves: ["big", "small"] } },
  lending: { models: ["small"] },
  peers: {
    close: { url: at(friend), token: "t", accept: "close-token", models: { away: "theirs" }, lend: { models: ["big", "small"] } },
    capped: { accept: "capped-token", lend: { tokensPerDay: 50 } },
    shut: { accept: "shut-token", lend: { off: true } },
    brisk: { accept: "brisk-token", lend: { rateLimit: 1 } },
    single: { accept: "single-token", lend: { maxConcurrent: 1 } },
  },
  flows: { away: { inputs: ["away"], steps: [{ to: { peer: "close" } }, { to: { refuse: "not run here" } }] } },
}), silentLogger);
await listen(node.server);
const url = at(node.server);

const as = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const chat = (token: string, model: string) =>
  fetch(`${url}/v1/chat/completions`, { method: "POST", headers: as(token), body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });
const serves = async (token: string): Promise<string[]> => ((await (await fetch(`${url}/peer/state`, { headers: as(token) })).json()) as { serves: string[] }).serves;
type Ledger = { peers: { peer: string; byModel: { lent: Record<string, { requests: number }> }; byDay: { lent: Record<string, number>; borrowed: Record<string, number> }; closed?: string | null; lent: { month: { in: number; out: number } }; borrowed: { month: { in: number; out: number } } }[] };
const ledger = async (peer: string) => ((await (await fetch(`${url}/lending`)).json()) as Ledger).peers.find((p) => p.peer === peer)!;

try {
  // To whom: each peer is shown, and may run, its own list.
  assert.deepEqual(await serves("close-token"), ["big", "small"]);
  assert.deepEqual(await serves("capped-token"), ["small"]);
  assert.equal((await chat("capped-token", "big")).status, 403, "a model lent to one peer is not lent to another");

  // A peer turned off is shown nothing and refused as one that was lent nothing, its limits kept for later.
  assert.deepEqual(await serves("shut-token"), []);
  assert.equal((await chat("shut-token", "small")).status, 403);
  assert.match((await ledger("shut")).closed!, /lending to this peer is off/);

  // How much in a day: 60 tokens an answer against 50 a day lets one through.
  assert.equal((await chat("capped-token", "small")).status, 200);
  assert.equal((await chat("capped-token", "small")).status, 429, "the day's tokens are spent");
  assert.deepEqual(await serves("capped-token"), [], "and it is shown nothing until tomorrow");
  assert.match((await ledger("capped")).closed!, /today's 50 tokens are used/);

  // How often: a peer's own requests an hour, where the node's 600 would have let the second through.
  assert.equal((await chat("brisk-token", "small")).status, 200);
  assert.equal((await chat("brisk-token", "small")).status, 429, "its hour's requests are spent");

  // How many at once: with one answer still in flight, a peer held to one job is refused a second.
  let release = (): void => {};
  held = new Promise<void>((r) => { release = r; });
  const first = chat("single-token", "small");
  await new Promise((r) => setTimeout(r, 100));
  // Raced with a clock: a second job let in would wait on the answer kept back, and never be refused.
  const second = await Promise.race([chat("single-token", "small").then((r) => r.status), new Promise<number>((r) => setTimeout(() => r(0), 3000))]);
  held = null;
  release();
  assert.deepEqual([(await first).status, second], [200, 429], "its one job is taken");

  // What was lent and what was borrowed are counted apart, per peer.
  assert.equal((await chat("close-token", "big")).status, 200);
  const sent = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "away", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(sent.status, 200);
  const row = await ledger("close");
  assert.deepEqual([row.lent.month.in + row.lent.month.out, row.borrowed.month.in + row.borrowed.month.out, row.closed], [60, 40, null]);
  assert.equal(row.byModel.lent.big?.requests, 1, "by model");
  assert.deepEqual([Object.values(row.byDay.lent), Object.values(row.byDay.borrowed)], [[60], [40]], "and by day");
  assert.equal((await fetch(`${url}/ui/lending`)).status, 200, "the page reads the same from its own route");

  // A model taken back is taken from a peer's own list too, in the file as well: that list would go on lending it.
  const file = join(mkdtempSync(join(tmpdir(), "hearth-lending-")), "hearth.yaml");
  writeFileSync(file, `name: lender
backends:
  card: {url: "${at(backend)}", kind: none, serves: [big, small]}
lending:
  models: [small, big]
peers:
  close: {accept: close-token, lend: {models: [big, small], tokensPerDay: 9}}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
`);
  const filed = createNode(loadConfig(file), silentLogger);
  await listen(filed.server);
  try {
    const held = await fetch(`${at(filed.server)}/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ share: { big: false } }) });
    assert.equal(held.status, 200);
    assert.deepEqual(((await (await fetch(`${at(filed.server)}/peer/state`, { headers: as("close-token") })).json()) as { serves: string[] }).serves, ["small"]);
    const after = loadConfig(file);
    assert.deepEqual([after.share, after.peerTerms.close], [["small"], { models: ["small"], tokensPerDay: 9 }], "and the rest of its limits stand");
  } finally {
    await filed.close();
  }
} finally {
  await node.close();
  backend.close();
  friend.close();
}

console.log("lending.test.ts ok");
