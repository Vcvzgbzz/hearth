/**
 * Self-check for config validation.
 *
 * The point of this file is that mistakes surface at startup, in a sentence a
 * person can act on, instead of at 2am as a 404 from a machine they do not own.
 * Every case below is a config someone will plausibly write.
 */
import assert from "node:assert/strict";

import { ConfigError, parseConfig, peersMapping, type PeerConfig } from "../src/config.js";

const minimal = { backends: { main: { url: "http://127.0.0.1:9292" } } };
const friend = (models: Record<string, string> = {}) => ({ url: "http://10.0.0.2:4141", token: "t", models });

// --- defaults are safe -----------------------------------------------------
{
  const cfg = parseConfig(minimal);
  assert.equal(cfg.listen.host, "127.0.0.1", "must default to loopback, never 0.0.0.0");
  assert.equal(cfg.scheduler.concurrency, 1, "one GPU, one job");
  assert.deepEqual(cfg.peers, [], "no peers unless asked for");
  assert.deepEqual(cfg.share, [], "lending capacity is opt-in");
  assert.deepEqual(cfg.models, {}, "nothing is routed away by default");
}

// --- servers: a backend on another machine takes its address from the machine --------------
{
  const servers = { box: { host: "10.0.0.5" } };
  const cfg = parseConfig({ servers, backends: { far: { server: "box", port: 8000 }, near: { url: "http://127.0.0.1:9292" } } });
  assert.equal(cfg.backends[0]!.url, "http://10.0.0.5:8000", "host and port make the url");
  assert.equal(cfg.backends[0]!.server, "box");
  assert.equal(cfg.backends[1]!.server, null, "no server is the machine hearth is on");
  assert.deepEqual(parseConfig(minimal).servers, {}, "a config that names none is unchanged");

  // A url of its own wins the address; the server is then only where it is drawn.
  const own = parseConfig({ servers, backends: { far: { server: "box", url: "https://box.lan/llm/" } } });
  assert.equal(own.backends[0]!.url, "https://box.lan/llm");
  assert.equal(parseConfig({ servers: { six: { host: "fd00::5" } }, backends: { far: { server: "six", port: 1 } } }).backends[0]!.url,
    "http://[fd00::5]:1", "a bare IPv6 host is bracketed");

  const refuse = (backends: Record<string, unknown>, re: RegExp, s: Record<string, unknown> = servers) =>
    assert.throws(() => parseConfig({ servers: s, backends }), re);
  refuse({ far: { server: "bix", port: 8000 } }, /backends\.far\.server names "bix", which is not in servers/);
  refuse({ far: { server: "box" } }, /backends\.far\.url is required, or set server and port/);
  refuse({ far: { port: 8000 } }, /backends\.far\.port needs server/);
  refuse({ far: { server: "box", port: 8000, url: "http://10.0.0.5:8000" } }, /port is set beside url/);
  refuse({ far: { server: "box", port: 0 } }, /port must be a whole number >= 1/);
  refuse({ far: { server: "box", port: 1 } }, /host must be an IP or hostname/, { box: { host: "http://10.0.0.5" } });
  refuse({ far: { server: "box", port: 1 } }, /servers\.box\.hots is not a setting/, { box: { hots: "10.0.0.5" } });

  // One card is in one machine; a shared resource is arbitrated nowhere, so it may span them.
  refuse({ far: { server: "box", port: 1, resources: ["gpu0"] }, near: { url: "http://127.0.0.1:2", resources: ["gpu0"] } },
    /"far" \(server "box"\) and "near" \(this machine\) both use gpu0/);
  assert.doesNotThrow(() => parseConfig({
    servers, resources: { cpu: { kind: "cpu", shared: true } },
    backends: { far: { server: "box", port: 1, resources: ["cpu"] }, near: { url: "http://127.0.0.1:2", resources: ["cpu"] } },
  }));
}

// --- a backend is mandatory, and must be a url -----------------------------
{
  assert.throws(() => parseConfig({}), /backends is required/);
  assert.throws(() => parseConfig({ backends: {} }), /must not be empty/);
  assert.throws(() => parseConfig({ backends: { main: { url: "127.0.0.1:9292" } } }), /must start with http/);
  // A trailing slash would otherwise produce //v1/chat/completions.
  assert.equal(parseConfig({ backends: { main: { url: "http://x:1/" } } }).backends[0]!.url, "http://x:1");
  assert.equal(parseConfig(minimal).backends[0]!.name, "main", "the key is the name");
  // A removed key fails loudly instead of quietly closing the port it used to open.
  assert.throws(() => parseConfig({ ...minimal, uiListen: { host: "127.0.0.1", port: 4142 } }),
    /uiListen was removed.*set-operator/);
}

// --- a v1 file is named as one, with the way out --------------------------
{
  assert.throws(() => parseConfig({ backend: { url: "http://x:1" } }), /v1 layout \(it has backend\).*hearth migrate/);
  // A file may say its layout: the current one loads, a later one is refused by name, an earlier one is sent to migrate.
  assert.doesNotThrow(() => parseConfig({ ...minimal, version: 3 }));
  assert.throws(() => parseConfig({ ...minimal, version: 4 }), /version is 4, a layout newer than this hearth reads \(3\)/);
  assert.throws(() => parseConfig({ ...minimal, version: 2 }), /version is 2, an older layout.*hearth migrate/);
  assert.throws(() => parseConfig({ ...minimal, share: [] }), /v1 layout \(it has share\)/);
  assert.throws(() => parseConfig({ backends: [{ name: "a", url: "http://x:1" }] }), /v1 layout \(it has backends as a list\)/);
}

// --- one entry per peer: borrow, lend, or both -------------------------------
{
  process.env.HEARTH_TEST_ACCEPT = "from-them";
  const cfg = parseConfig({
    ...minimal,
    peers: {
      both: { ...friend({ m: "m" }), accept: "env:HEARTH_TEST_ACCEPT" },
      borrowOnly: friend(),
      lendOnly: { accept: "lend-token" },
    },
  });
  assert.deepEqual(cfg.peers.map((p) => p.name), ["both", "borrowOnly"], "only peers with a url are borrowed from");
  assert.deepEqual(cfg.peerTokens, { both: "from-them", lendOnly: "lend-token" }, "accept is who may borrow from us");
  delete process.env.HEARTH_TEST_ACCEPT;

  assert.throws(() => parseConfig({ ...minimal, peers: { x: {} } }), /peers\.x needs url .* or accept/);
  assert.throws(() => parseConfig({ ...minimal, peers: { x: { accept: "a", token: "t" } } }),
    /peers\.x\.token is only used to borrow from x, which needs its url/);
  assert.throws(() => parseConfig({ ...minimal, peers: { x: { url: "http://x:1" } } }), /peers\.x\.token/,
    "borrowing needs the token you present");
}

// --- a peer with no model map is legal, and is a state you can click into ---
// The console's "unlink" leaves exactly this, and the poll is what feeds the list of things
// you could borrow next.
{
  const cfg = parseConfig({ ...minimal, peers: { friend: friend() } });
  assert.deepEqual(cfg.peers[0]!.models, {}, "an empty map loads");
  assert.equal(cfg.peers[0]!.token, "t", "and the trust decision it holds is untouched");
}

// --- an alias and a peer policy are two destinations, not a conflict -------
// `as` is applied by pool.outboundId() and only on the way to a local backend;
// a peer dispatch takes its id from that peer's own map.
{
  const cfg = parseConfig({
    ...minimal,
    peers: { friend: friend({ coder: "their-coder" }) },
    models: { coder: { as: "qwen3-coder:latest" } },
    flows: { coder: { inputs: ["coder"], steps: [{ to: { fastest: ["coder", { peer: "friend" }] } }] } },
  });
  assert.equal(cfg.models.coder!.as, "qwen3-coder:latest");
  assert.deepEqual(cfg.flows.coder!.steps[0]!.to, { fastest: [{ model: "coder" }, { peer: "friend", model: null }] });
}

// --- a note describes a model; alone it is not a route ----------------------
{
  const cfg = parseConfig({ ...minimal, models: { a: { note: " for long documents " }, b: { concurrency: 1, note: "x" } } });
  assert.deepEqual(cfg.notes, { a: "for long documents", b: "x" });
  assert.deepEqual(Object.keys(cfg.models), ["b"], "a note-only entry routes nothing");
  assert.throws(() => parseConfig({ ...minimal, models: { a: { note: "x".repeat(10_000) } } }), /models\.a\.note is \d+ characters/);
}

// --- pool: a bare number, or tokens plus an output cap ---------------------
{
  const cfg = parseConfig({ ...minimal, models: { a: { pool: 1000 }, b: { pool: { tokens: 1000, output: 64 } } } });
  assert.deepEqual(cfg.models.a!.pool, { tokens: 1000, output: null });
  assert.deepEqual(cfg.models.b!.pool, { tokens: 1000, output: 64 });
  assert.throws(() => parseConfig({ ...minimal, models: { c: { pool: 0 } } }), /models\.c\.pool/);
}

// --- findings carry their field explicitly ----------------------------------
{
  const thrown = (raw: unknown): ConfigError => {
    try {
      parseConfig(raw);
    } catch (e) {
      if (e instanceof ConfigError) return e;
      throw e;
    }
    throw new Error("expected a ConfigError");
  };
  const path = (raw: unknown): string | null => thrown(raw).path;
  assert.equal(path({ backends: { main: { url: "127.0.0.1:9292" } } }), "backends.main.url");
  assert.equal(path({ ...minimal, listen: { port: -1 } }), "listen.port");
  assert.equal(path({ ...minimal, lending: { models: 5 } }), "lending.models");
  assert.equal(path({ ...minimal, models: { n: { note: 5 } } }), "models.n.note");
  assert.equal(path({ ...minimal, scheduler: { lanes: {} } }), "scheduler.lanes");
  assert.equal(path({ ...minimal, models: { m: { lane: "nope" } } }), "models.m.lane");
  assert.equal(path({ ...minimal, lending: { lane: "nope" } }), "lending.lane");
  assert.equal(path({ ...minimal, models: ["m"] }), "models", "a whole-section finding names the section");
  assert.equal(path({ ...minimal, models: { m: { params: { model: "x" } } } }), "models.m.params.model");
  assert.equal(path({ ...minimal, models: { m: { polcy: "peer" } } }), "models.m.polcy", "an unknown key is named");
  assert.equal(path({ backend: { url: "http://x" } }), null, "a whole-config one carries none");
  assert.equal(thrown({ ...minimal, models: { c: { pool: 0 } } }).message, "models.c.pool must be a whole number >= 1 (got 0)", "and the sentence keeps the field for a journal line");
}

// --- a flow step that can never fire is a typo, not a preference -----------
{
  assert.throws(
    () => parseConfig({ ...minimal, peers: { friend: friend({ a: "a" }) }, flows: { b: { inputs: ["b"], steps: [{ to: { peer: "friend" } }, { to: "b" }] } } }),
    /sends "b" to friend, which does not map it/,
  );
}

// --- naming a peer that does not exist -------------------------------------
{
  assert.throws(
    () => parseConfig({
      ...minimal,
      peers: { friend: friend({ a: "a" }) },
      flows: { a: { inputs: ["a"], steps: [{ to: { peer: "freind" } }, { to: "a" }] } },
    }),
    /not a peer you borrow from/,
    "a misspelled peer name must be caught, not silently ignored",
  );
}

// --- routing written on a model is refused, with the command that moves it --
{
  for (const key of ["policy", "peers", "spilloverAt", "fallbackLocal", "whenHeld"]) {
    assert.throws(
      () => parseConfig({ ...minimal, peers: { f: friend({ m: "m" }) }, models: { m: { [key]: "peer" } } }),
      new RegExp(`models\\.m\\.${key} is routing, which now lives under flows: — run \`hearth migrate\``),
    );
  }
}

// --- env: indirection ------------------------------------------------------
{
  process.env.HEARTH_TEST_TOKEN = "s3cret";
  const cfg = parseConfig({ ...minimal, peers: { f: { ...friend({ m: "m" }), token: "env:HEARTH_TEST_TOKEN" } } });
  assert.equal(cfg.peers[0]!.token, "s3cret");

  // A missing variable is fatal: starting with an empty token would mean every
  // call to that peer silently 401s.
  delete process.env.HEARTH_TEST_TOKEN;
  assert.throws(
    () => parseConfig({ ...minimal, peers: { f: { ...friend({ m: "m" }), token: "env:HEARTH_TEST_TOKEN" } } }),
    /is not set/,
  );
}

// --- the per-caller cap only means something when callers differ -----------
// With no apiKeys every local request is the identity "local", so a per-caller
// cap is really a global one. Defaulting it to 2 there would 429 the second
// concurrent request from the operator's own app on a fresh install.
{
  assert.equal(parseConfig(minimal).scheduler.maxPerCaller, 0, "off when callers are one identity");
  assert.equal(
    parseConfig({ ...minimal, apiKeys: ["k1", "k2"] }).scheduler.maxPerCaller,
    2,
    "a real per-user cap once keys distinguish callers",
  );
  // An explicit value always wins, in both directions.
  assert.equal(parseConfig({ ...minimal, scheduler: { maxPerCaller: 5 } }).scheduler.maxPerCaller, 5);
  assert.equal(
    parseConfig({ ...minimal, apiKeys: ["k"], scheduler: { maxPerCaller: 0 } }).scheduler.maxPerCaller,
    0,
  );
}

// --- the operator login: a hash in the file, never a password ---------------
{
  // The shape `hearth set-operator` writes: 16-byte salt and 64-byte scrypt, both hex.
  const passHash = `${"a1".repeat(16)}:${"b2".repeat(64)}`;
  const cfg = parseConfig({ ...minimal, operator: { user: "jadeyn", passHash } });
  assert.deepEqual(cfg.operator, { user: "jadeyn", passHash }, "a well-formed login loads");

  assert.equal(parseConfig(minimal).operator, null, "no operator block means no login");

  assert.throws(
    () => parseConfig({ ...minimal, operator: { user: "", passHash } }),
    /operator\.user/,
    "an empty username is a config error, not a silent no-login",
  );
  assert.throws(
    () => parseConfig({ ...minimal, operator: { user: "jadeyn", passHash: "not-a-hash" } }),
    /operator\.passHash/,
    "a raw password in the file must not parse — only the set-operator output does",
  );
  assert.throws(
    () => parseConfig({ ...minimal, operator: { user: "jadeyn" } }),
    /operator\.passHash/,
    "and a missing hash too",
  );
}

// --- lanes -----------------------------------------------------------------
{
  const cfg = parseConfig({ ...minimal, scheduler: { lanes: { now: { priority: 0 } } } });
  // Declaring lanes REPLACES the defaults — except `warm`, which /v1/warm needs
  // and which is added back. Without that a warm would land on the unknown-lane
  // fallback of 1000, where a deliberate lane is indistinguishable from a typo.
  assert.deepEqual(Object.keys(cfg.scheduler.lanes), ["now", "warm"]);
  assert.ok(
    cfg.scheduler.lanes.warm!.priority > cfg.scheduler.lanes.now!.priority,
    "warm yields to a declared lane, since it is speculative work",
  );
  // But the operator still owns it if they say so.
  const owned = parseConfig({
    ...minimal,
    scheduler: { lanes: { now: { priority: 0 }, warm: { priority: 5 } } },
  });
  assert.equal(owned.scheduler.lanes.warm!.priority, 5, "an explicit warm lane wins");
  assert.throws(() => parseConfig({ ...minimal, scheduler: { lanes: {} } }), /at least one lane/);
}

// --- backendDefaults is what every backend takes unless it says otherwise ---
{
  const cfg = parseConfig({
    backends: { a: { url: "http://x:1" }, b: { url: "http://x:2", concurrency: 9, idleMs: 5 } },
    backendDefaults: { concurrency: 2, idleMs: 1000 },
  });
  assert.deepEqual(cfg.backends.map((b) => b.concurrency), [2, 9]);
  assert.equal(cfg.backendIdleMs, 1000);
  assert.deepEqual(cfg.backends.map((b) => b.idleMs), [null, 5], "an override is kept as its own value");
}

// --- tuning weights are checked, not just typed ----------------------------
//
// The ones plain type-checking waves straight through. A negative agePerSecond
// inverts aging into guaranteed starvation, a negative warmBonus makes the
// scheduler prefer to swap models, and a negative coldPenalty sends `fastest`
// looking for whichever node has to load the weights.
{
  assert.throws(() => parseConfig({ ...minimal, scheduler: { agePerSecond: -1 } }), /agePerSecond must be >= 0/);
  assert.throws(() => parseConfig({ ...minimal, scheduler: { warmBonus: -40 } }), /warmBonus must be >= 0/);
  assert.throws(() => parseConfig({ ...minimal, borrowing: { coldPenalty: -2 } }), /borrowing\.coldPenalty must be >= 0/);
  assert.throws(() => parseConfig({ ...minimal, borrowing: { firstByteMs: -1 } }), /borrowing\.firstByteMs must be >= 0/);
  // Fractions are still fine. Half a point of aging per second is a real ask.
  assert.equal(parseConfig({ ...minimal, scheduler: { agePerSecond: 0.5 } }).scheduler.agePerSecond, 0.5);
  // 0 keeps its meaning: no deadline.
  assert.equal(parseConfig({ ...minimal, borrowing: { firstByteMs: 0 } }).peerFirstByteMs, 0);
}

// --- a model's own slot count ----------------------------------------------
{
  const with_ = (entry: unknown) => parseConfig({ ...minimal, models: { m: entry } }).models.m!.concurrency;
  assert.equal(with_({ lane: "chat" }), null, "undeclared inherits the backend");
  assert.equal(with_({ concurrency: 2 }), 2, "and may be lower than one");
  assert.throws(() => with_({ concurrency: 0 }), /whole number >= 1/);
  assert.throws(() => with_({ batch: 4 }), /models\.m\.batch is not a setting/, "the old name is migrated, not read");
}

// --- one rule for "which peers could serve this": empty `peers` means any --
{
  const peers: PeerConfig[] = [
    { name: "a", url: "http://a", token: "t", models: { x: "their-x" } },
    { name: "b", url: "http://b", token: "t", models: {} },
    { name: "c", url: "http://c", token: "t", models: { x: "x" } },
  ];
  assert.deepEqual(peersMapping("x", [], peers), ["a", "c"], "no named peers means every peer that maps it");
  assert.deepEqual(peersMapping("x", ["c", "b", "a"], peers), ["c", "a"], "named peers keep their order");
  assert.deepEqual(peersMapping("y", [], peers), []);
  assert.throws(
    () => parseConfig({ ...minimal, peers: { a: { url: "http://a", token: "t", models: { x: "" } } } }),
    /peers\.a\.models\.x is empty/,
  );
}

console.log("config.test.ts ok");
