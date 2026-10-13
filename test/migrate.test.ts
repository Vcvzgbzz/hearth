/**
 * hearth migrate: a v1 file in, a v2 file out that loads to the same running config, with
 * comments where they were. Plus the two v1 files it must refuse rather than guess about.
 *
 *     npx tsx test/migrate.test.ts
 */
import assert from "node:assert/strict";

import { parseDocument } from "yaml";

import { parseConfig } from "../src/config.js";
import { migrate, migrateDoc, v1Marker, routedMarker } from "../src/migrate.js";

const V1 = `# my box
name: box
backend:
  url: http://127.0.0.1:8080 # llama-swap
  llamaSwapExtras: false
scheduler:
  concurrency: 2
  lanes: { chat: { priority: 0 }, batch: { priority: 100 } }
share: [chat] # lend this
peerLane: batch
peerRateLimit: 300
peerFirstByteMs: 60000
coldPenalty: 3
backendIdleMs: 1000
peerTokens:
  friend: from-friend
  stranger: from-stranger
peers:
  # the friend's box
  - name: friend
    url: http://10.0.0.2:4141
    token: to-friend
    models: { big: big }
notes:
  chat: daily driver
models:
  chat: { batch: 4 }
  big: { policy: peer }
`;

// --- the rewrite --------------------------------------------------------------------------------
const doc = parseDocument(V1);
const moved = migrateDoc(doc);
const out = doc.toString();
const v2 = parseDocument(out).toJS() as Record<string, unknown>;
assert.equal(v1Marker(v2), null, "nothing v1 is left");
assert.ok(moved.length >= 10, "each move is reported");
assert.match(out, /^# my box\nversion: 3\nname: box\n/, "the file still opens the way it did, and says its layout");
assert.match(out, /url: http:\/\/127\.0\.0\.1:8080 # llama-swap/, "a comment stays on its value");
assert.match(out, /# the friend's box\n\s+friend:/, "and on its peer");
assert.match(out, /models: \[ ?chat ?\] # lend this/, "and on a moved key");
assert.ok(out.indexOf("backends:") < out.indexOf("models:") && out.indexOf("peers:") < out.indexOf("lending:"),
  "top-level keys come back in reading order");

// --- and it loads to the same node ----------------------------------------------------------------
const c = parseConfig(v2);
assert.deepEqual(c.backends.map((b) => [b.name, b.kind, b.concurrency]), [["default", "none", 2]]);
assert.equal(c.backendIdleMs, 1000);
assert.deepEqual(c.share, ["chat"]);
assert.equal(c.peerLane, "batch");
assert.equal(c.peerRateLimit, 300);
assert.equal(c.peerFirstByteMs, 60000);
assert.equal(c.coldPenalty, 3);
assert.deepEqual(c.peerTokens, { friend: "from-friend", stranger: "from-stranger" }, "both tokens kept");
assert.deepEqual(c.peers.map((p) => p.name), ["friend"], "a token-only peer lends but is not borrowed from");
assert.deepEqual(c.notes, { chat: "daily driver" });
assert.equal(c.models.chat!.concurrency, 4, "batch became concurrency");
// A model's own routing became the flow it described, and the model entry that held nothing else is gone.
assert.equal(routedMarker(v2), null, "no model routes by its own settings any more");
assert.deepEqual(c.flows.big, { inputs: ["big"], steps: [
  { when: null, to: { peer: "friend", model: null }, lane: null, params: null, do: [] },
  { when: null, to: { model: "big" }, lane: null, params: null, do: [] },
] });
assert.equal(c.models.big, undefined);
assert.ok(moved.includes("models.big routing → flows.big"));

// The same step on a file already in the v2 layout: every shape, and what a model keeps.
{
  const old = {
    backends: { main: { url: "http://127.0.0.1:1", kind: "none", serves: ["a", "b", "c", "d", "e"] } },
    peers: { p1: { url: "http://10.0.0.2:4141", token: "t", models: { a: "x", b: "x", c: "x" } }, p2: { url: "http://10.0.0.3:4141", token: "t", models: { a: "x" } }, lender: { accept: "k" } },
    models: {
      a: { policy: "fastest", peers: ["p2", "p1"], lane: "chat" },
      b: { policy: "spillover", spilloverAt: 3, fallbackLocal: false },
      c: { policy: "peer", whenHeld: "d" },
      d: { policy: "local", note: "plain" },
      e: { whenHeld: "a" },
    },
    scheduler: { lanes: { chat: { priority: 0 } } },
  };
  assert.equal(routedMarker(old), "models.a.policy");
  assert.throws(() => parseConfig(old), /models\.a\.policy is routing, which now lives under flows: — run `hearth migrate`/);
  const now = migrate(old) as { models: Record<string, unknown>; flows: Record<string, { steps: unknown[] }> };
  assert.deepEqual(now.models, { a: { lane: "chat" }, d: { note: "plain" } }, "a model keeps what was never routing");
  assert.deepEqual(now.flows["a"]!.steps, [{ to: { fastest: ["a", { peer: "p2" }, { peer: "p1" }] } }], "peers in the order the model named them");
  assert.deepEqual(now.flows["b"]!.steps, [
    { when: { down: ["p1"] }, to: { refuse: "no peer could take it, and it does not run here" } },
    { when: { queuedUnder: 3 }, to: "b" },
    { to: { peer: "p1" } },
    { to: { refuse: "no peer could take it, and it does not run here" } },
  ]);
  assert.deepEqual(now.flows["c"]!.steps, [{ when: { held: ["c"] }, to: "d" }, { to: { peer: "p1" } }, { to: "c" }], "a stand-in that only runs here is named as a model");
  assert.deepEqual(now.flows["e"]!.steps, [{ when: { held: ["e"] }, to: { flow: "a" } }, { to: "e" }], "one that is itself routed is handed to its flow");
  assert.equal(now.flows["d"], undefined, "a model that only ever ran here needs no flow");
  assert.doesNotThrow(() => parseConfig(now));
  assert.equal(migrate(now), now, "and a second run changes nothing");
  assert.throws(() => migrate({ ...old, flows: { a: { inputs: [], steps: [{ to: "a" }] } } }), /flows\.a already exists/);
}

// --- a second run changes nothing -------------------------------------------------------------
assert.equal(migrate(v2), v2, "a v2 config passes through untouched");

// --- what it refuses ------------------------------------------------------------------------------
assert.throws(() => migrate({ backends: [{ name: "a", url: "http://x:1" }, { name: "a", url: "http://x:2" }] }),
  /two backends are both named "a"/, "a map cannot hold both, so neither is dropped silently");
assert.throws(() => migrate({ backend: { url: "http://x:1", kind: "ollama", llamaSwapExtras: false } }),
  /kind and llamaSwapExtras, not both/);
// Both backend: and backends: is the operator's call; it is left for the parser to name.
assert.throws(() => parseConfig(migrate({ backend: { url: "http://x:1" }, backends: [{ name: "a", url: "http://x:1" }] })),
  /v1 layout \(it has backend\)/);

console.log("migrate.test.ts ok");
