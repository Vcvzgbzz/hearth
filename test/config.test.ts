/**
 * Self-check for config validation.
 *
 * The point of this file is that mistakes surface at startup, in a sentence a
 * person can act on, instead of at 2am as a 404 from a machine they do not own.
 * Every case below is a config someone will plausibly write.
 */
import assert from "node:assert/strict";

import { ConfigError, parseConfig } from "../src/config.js";

const minimal = { backend: { url: "http://127.0.0.1:9292" } };

// --- defaults are safe -----------------------------------------------------
{
  const cfg = parseConfig(minimal);
  assert.equal(cfg.listen.host, "127.0.0.1", "must default to loopback, never 0.0.0.0");
  assert.equal(cfg.scheduler.concurrency, 1, "one GPU, one job");
  assert.deepEqual(cfg.peers, [], "no peers unless asked for");
  assert.deepEqual(cfg.share, [], "lending capacity is opt-in");
  assert.deepEqual(cfg.models, {}, "nothing is routed away by default");
}

// --- backend is mandatory, and must be a url -------------------------------
{
  assert.throws(() => parseConfig({}), ConfigError);
  assert.throws(() => parseConfig({ backend: { url: "127.0.0.1:9292" } }), /must start with http/);
  // A trailing slash would otherwise produce //v1/chat/completions.
  assert.equal(parseConfig({ backend: { url: "http://x:1/" } }).backends[0]!.url, "http://x:1");
}

// --- a peer with no model map is legal, and is a state you can click into ---
// This used to refuse, on the reasoning that polling a peer nothing can route
// to is pointless. The console changed that: unlinking a peer's last model is
// one click, the poll is what feeds the list of things you could borrow next,
// and refusing left you unable to save a state you had reached in the UI.
{
  const cfg = parseConfig({
    ...minimal,
    peers: [{ name: "friend", url: "http://10.0.0.2:4141", token: "t", models: {} }],
  });
  assert.deepEqual(cfg.peers[0]!.models, {}, "an empty map loads");
  assert.equal(cfg.peers[0]!.token, "t", "and the trust decision it holds is untouched");
}

// --- an alias and a peer policy are two destinations, not a conflict -------
// `as` is applied by pool.outboundId() and only on the way to a local backend;
// a peer dispatch takes its id from that peer's own map. No request is subject
// to both, and `fastest` across the two is the case that wants it.
{
  const cfg = parseConfig({
    ...minimal,
    peers: [{ name: "friend", url: "http://10.0.0.2:4141", token: "t", models: { coder: "their-coder" } }],
    models: { coder: { as: "qwen3-coder:latest", policy: "fastest" } },
  });
  assert.equal(cfg.models.coder!.as, "qwen3-coder:latest");
  assert.equal(cfg.models.coder!.policy, "fastest");
}

// --- a policy that can never fire is a typo, not a preference --------------
{
  assert.throws(
    () =>
      parseConfig({
        ...minimal,
        peers: [{ name: "friend", url: "http://10.0.0.2:4141", token: "t", models: { a: "a" } }],
        models: { b: { policy: "peer" } },
      }),
    /no peer maps "b"/,
  );
}

// --- naming a peer that does not exist -------------------------------------
{
  assert.throws(
    () =>
      parseConfig({
        ...minimal,
        peers: [{ name: "friend", url: "http://10.0.0.2:4141", token: "t", models: { a: "a" } }],
        models: { a: { policy: "peer", peers: ["freind"] } },
      }),
    /not a configured peer/,
    "a misspelled peer name must be caught, not silently ignored",
  );
}

// --- duplicate peer names --------------------------------------------------
{
  assert.throws(
    () =>
      parseConfig({
        ...minimal,
        peers: [
          { name: "a", url: "http://1.1.1.1:1", token: "t", models: { m: "m" } },
          { name: "a", url: "http://1.1.1.2:1", token: "t", models: { m: "m" } },
        ],
      }),
    /both named/,
  );
}

// --- an unknown policy is refused with the valid set -----------------------
{
  assert.throws(
    () =>
      parseConfig({
        ...minimal,
        peers: [{ name: "f", url: "http://1.1.1.1:1", token: "t", models: { m: "m" } }],
        models: { m: { policy: "remote" } },
      }),
    /expected local, peer, spillover or fastest/,
  );
}

// --- env: indirection ------------------------------------------------------
{
  process.env.HEARTH_TEST_TOKEN = "s3cret";
  const cfg = parseConfig({
    ...minimal,
    peers: [
      {
        name: "f",
        url: "http://1.1.1.1:1",
        token: "env:HEARTH_TEST_TOKEN",
        models: { m: "m" },
      },
    ],
  });
  assert.equal(cfg.peers[0]!.token, "s3cret");

  // A missing variable is fatal: starting with an empty token would mean every
  // call to that peer silently 401s.
  delete process.env.HEARTH_TEST_TOKEN;
  assert.throws(
    () =>
      parseConfig({
        ...minimal,
        peers: [
          { name: "f", url: "http://1.1.1.1:1", token: "env:HEARTH_TEST_TOKEN", models: { m: "m" } },
        ],
      }),
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

// --- tuning weights are checked, not just typed ----------------------------
//
// The ones plain type-checking waves straight through. A negative agePerSecond
// inverts aging into guaranteed starvation, a negative warmBonus makes the
// scheduler prefer to swap models, and a negative coldPenalty sends `fastest`
// looking for whichever node has to load the weights. All three used to start
// up fine and then misbehave quietly.
{
  assert.throws(
    () => parseConfig({ ...minimal, scheduler: { agePerSecond: -1 } }),
    /agePerSecond must be >= 0/,
  );
  assert.throws(
    () => parseConfig({ ...minimal, scheduler: { warmBonus: -40 } }),
    /warmBonus must be >= 0/,
  );
  assert.throws(() => parseConfig({ ...minimal, coldPenalty: -2 }), /coldPenalty must be >= 0/);
  assert.throws(
    () => parseConfig({ ...minimal, peerFirstByteMs: -1 }),
    /peerFirstByteMs must be >= 0/,
  );
  // Fractions are still fine. Half a point of aging per second is a real ask.
  assert.equal(parseConfig({ ...minimal, scheduler: { agePerSecond: 0.5 } }).scheduler.agePerSecond, 0.5);
  // 0 keeps its meaning in each case: no aging, no warm preference, no
  // deadline.
  assert.equal(parseConfig({ ...minimal, peerFirstByteMs: 0 }).peerFirstByteMs, 0);
}

// --- a model's own slot count, under either spelling -----------------------
//
// `batch` was the name when it could only raise a model above its backend.
// `concurrency` is the name now that it can lower one too, and old configs
// keep working — but a file saying both is a ceiling that reads as one number
// and enforces the other.
{
  const with_ = (entry: unknown) =>
    parseConfig({ ...minimal, models: { m: entry } }).models.m!.concurrency;
  assert.equal(with_({ policy: "local" }), null, "undeclared inherits the backend");
  assert.equal(with_({ concurrency: 2 }), 2, "and may be lower than one");
  assert.equal(with_({ batch: 32 }), 32, "the old name still lands in the same field");
  assert.throws(
    () => with_({ concurrency: 2, batch: 4 }),
    /same setting/,
    "two different numbers for one ceiling is a mistake, not a merge",
  );
  // Saying both and agreeing is somebody mid-rename. Nothing is ambiguous.
  assert.equal(with_({ concurrency: 4, batch: 4 }), 4);
  assert.throws(() => with_({ concurrency: 0 }), /whole number >= 1/);
}

console.log("config.test.ts ok");
