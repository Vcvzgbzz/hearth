/**
 * Self-check for the routing decision, the answer to "under what conditions
 * does a prompt leave this machine?"
 *
 * Weighted toward the refusals. Sending work to a peer that cannot take it, or
 * that was never meant to have it, is the failure with real consequences; making
 * a job wait at home is merely slow.
 */
import assert from "node:assert/strict";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { PeerRegistry, type PeerCapacity } from "../src/peers.js";
import { decide } from "../src/route.js";

const base = {
  name: "me",
  backend: { url: "http://127.0.0.1:9292" },
  peers: [
    { name: "friend", url: "http://10.0.0.2:4141", token: "t", models: { big: "their-big" } },
    { name: "other", url: "http://10.0.0.3:4141", token: "t", models: { big: "big-2" } },
  ],
};

const idle: PeerCapacity = {
  slots: 1,
  free: 1,
  running: 0,
  offbox: 0,
  queued: {},
  resident: null,
};

/** A registry with peers forced up or down, so routing can be tested without a
 *  network. Reaches past the poller deliberately: this file is about the
 *  decision, and peers.test.ts covers how health is established. */
function registry(cfg: ReturnType<typeof parseConfig>, up: Record<string, PeerCapacity | null>) {
  const r = new PeerRegistry(cfg, silentLogger);
  const inner = r as unknown as {
    status: Map<string, Record<string, unknown>>;
  };
  for (const [name, cap] of Object.entries(up)) {
    const s = inner.status.get(name);
    if (!s) throw new Error(`no such peer ${name}`);
    s.up = cap !== null;
    s.capacity = cap;
    s.lastOkAt = cap !== null ? Date.now() : null;
  }
  return r;
}

const busy = { queued: 3, free: 0, slots: 1, loaded: ["big"] };
const free = { queued: 0, free: 1, slots: 1, loaded: ["big"] };
/** Idle here, but holding a different model, so a swap stands in the way. */
const cold = { queued: 0, free: 1, slots: 1, loaded: ["something-else"] };

// --- default is local ------------------------------------------------------
// A model nobody configured must never leave, however healthy the peers are.
{
  const cfg = parseConfig({ ...base, models: {} });
  const r = registry(cfg, { friend: idle, other: idle });
  const d = decide("big", cfg, r, busy);
  assert.equal(d.target, "local");
}

// --- policy: peer ----------------------------------------------------------
{
  const cfg = parseConfig({ ...base, models: { big: { policy: "peer", peers: ["friend"] } } });
  const r = registry(cfg, { friend: idle, other: null });
  const d = decide("big", cfg, r, free);
  assert.equal(d.target, "peer");
  assert.equal(d.target === "peer" && d.peer, "friend");
  // Their id, not ours. Getting this wrong produces a 404 from a machine you do
  // not own.
  assert.equal(d.target === "peer" && d.theirModel, "their-big");
}

// --- a down peer falls back locally ----------------------------------------
{
  const cfg = parseConfig({ ...base, models: { big: { policy: "peer", peers: ["friend"] } } });
  const r = registry(cfg, { friend: null, other: null });
  assert.equal(decide("big", cfg, r, free).target, "local");
}

// --- an unmapped model is never routed -------------------------------------
// The model map is the allowlist. A local-only variant stays home because it is
// simply not in it, which is why config rejects a policy that can never fire.
{
  assert.throws(
    () => parseConfig({ ...base, models: { "big-high": { policy: "peer" } } }),
    /no peer maps/,
    "a policy pointing at a model no peer maps must fail at startup",
  );
}

// --- fallbackLocal: false actually refuses ---------------------------------
// It used to only change a reason string, so the one knob meaning "never run
// this here" was honoured when a peer errored and ignored when a peer was down
// which is the more common half. People set this because the box would OOM.
{
  const cfg = parseConfig({
    ...base,
    models: { big: { policy: "peer", peers: ["friend"], fallbackLocal: false } },
  });
  assert.equal(decide("big", cfg, registry(cfg, { friend: idle, other: null }), free).target, "peer");
  const d = decide("big", cfg, registry(cfg, { friend: null, other: null }), free);
  assert.equal(d.target, "unavailable", "a down peer must not silently run it locally");

  // With the default (true), the same situation falls home as before.
  const lenient = parseConfig({
    ...base,
    models: { big: { policy: "peer", peers: ["friend"] } },
  });
  assert.equal(
    decide("big", lenient, registry(lenient, { friend: null, other: null }), free).target,
    "local",
  );
}

// --- spillover -------------------------------------------------------------
{
  const cfg = parseConfig({
    ...base,
    models: { big: { policy: "spillover", peers: ["friend"], spilloverAt: 2 } },
  });
  const r = registry(cfg, { friend: idle, other: null });
  assert.equal(decide("big", cfg, r, { queued: 0, free: 1, slots: 1, loaded: ["big"] }).target, "local");
  assert.equal(decide("big", cfg, r, { queued: 1, free: 0, slots: 1, loaded: ["big"] }).target, "local");
  assert.equal(decide("big", cfg, r, { queued: 2, free: 0, slots: 1, loaded: ["big"] }).target, "peer");
}

// --- fastest ---------------------------------------------------------------
// Both sides warm unless a case says otherwise, so these isolate queue depth.
{
  const cfg = parseConfig({ ...base, models: { big: { policy: "fastest" } } });
  const warmIdle: PeerCapacity = { ...idle, loaded: ["their-big"] };

  // Local idle, peer backed up: stay home. This is the case that matters to
  // anyone asking "will it still use my GPU when my friend is busy".
  const warmBusy: PeerCapacity = { ...warmIdle, free: 0, running: 1, queued: { chat: 4 } };
  assert.equal(decide("big", cfg, registry(cfg, { friend: warmBusy, other: null }), free).target, "local");

  // Local backed up, peer idle: go.
  assert.equal(decide("big", cfg, registry(cfg, { friend: warmIdle, other: null }), busy).target, "peer");

  // A tie stays home. The hop is real and a peer that merely matches us is not
  // worth the prompt leaving the machine.
  assert.equal(decide("big", cfg, registry(cfg, { friend: warmIdle, other: null }), free).target, "local");
}

// --- fastest weighs a cold start, not just a queue -------------------------
// The term that actually decides most real comparisons: an idle GPU holding the
// wrong model is slower to start than a warm one with work in front of it.
{
  const cfg = parseConfig({ ...base, models: { big: { policy: "fastest" } } });
  const warmIdle: PeerCapacity = { ...idle, loaded: ["their-big"] };
  const coldIdle: PeerCapacity = { ...idle, loaded: ["their-other"] };

  // We're idle but cold, they're warm. Go, since we'd pay a load first.
  assert.equal(
    decide("big", cfg, registry(cfg, { friend: warmIdle, other: null }), cold).target,
    "peer",
    "a warm peer beats a cold local, even with both queues empty",
  );

  // Both cold and both idle: stay home. No reason to cross the network to pay
  // the same load somewhere else.
  assert.equal(
    decide("big", cfg, registry(cfg, { friend: coldIdle, other: null }), cold).target,
    "local",
  );

  // We're cold and they're warm, but they have four jobs queued. coldPenalty is
  // 2, so their 4 outweighs our load and it stays home.
  const warmQueued: PeerCapacity = { ...warmIdle, queued: { chat: 4 } };
  assert.equal(
    decide("big", cfg, registry(cfg, { friend: warmQueued, other: null }), cold).target,
    "local",
  );

  // Warmth judged on THEIR id. A peer whose loaded list holds our id rather
  // than theirs must read as cold, not warm.
  const mislabelled: PeerCapacity = { ...idle, loaded: ["big"] };
  assert.equal(
    decide("big", cfg, registry(cfg, { friend: mislabelled, other: null }), cold).target,
    "local",
    "our id in their loaded list is not evidence they have it warm",
  );

  // coldPenalty: 0 turns warmth off entirely and restores depth-only ordering.
  const flat = parseConfig({ ...base, coldPenalty: 0, models: { big: { policy: "fastest" } } });
  assert.equal(
    decide("big", flat, registry(flat, { friend: warmIdle, other: null }), cold).target,
    "local",
    "with the penalty off, cold local ties warm peer and ties stay home",
  );
}

// --- preference order is honoured ------------------------------------------
{
  const cfg = parseConfig({
    ...base,
    models: { big: { policy: "peer", peers: ["other", "friend"] } },
  });
  const r = registry(cfg, { friend: idle, other: idle });
  const d = decide("big", cfg, r, free);
  assert.equal(d.target === "peer" && d.peer, "other");
  assert.equal(d.target === "peer" && d.theirModel, "big-2");
}

// --- the first listed peer being down skips to the next --------------------
{
  const cfg = parseConfig({
    ...base,
    models: { big: { policy: "peer", peers: ["other", "friend"] } },
  });
  const r = registry(cfg, { friend: idle, other: null });
  assert.equal(decide("big", cfg, r, free).target === "peer" && true, true);
  const d = decide("big", cfg, r, free);
  assert.equal(d.target === "peer" && d.peer, "friend");
}

console.log("route.test.ts ok");
