/**
 * The smoke's fire follows the node's load: banked coals at idle, a full glow
 * and a steady run of embers when the queue is full, and nothing out of range
 * in between; each finished request sends up the thing that says where it ran.
 */
import assert from "node:assert/strict";

import { fire, seedOf, STOKE, stokeOf } from "../src/console/fire.js";

// --- idle is banked, not out; full is full -------------------------------------------
{
  const idle = fire(0);
  const full = fire(1);
  assert.ok(idle.heat > 0 && idle.heat < 0.25, `idle keeps a faint banked glow, got ${idle.heat}`);
  assert.equal(full.heat, 1, "a full queue is a full glow");
  assert.ok(idle.embers > 0 && idle.embers < 0.1, `a stray ember at idle, got ${idle.embers}`);
  assert.ok(full.embers > idle.embers && full.embers <= 1, `more embers under load, never past every lane, got ${full.embers}`);
}

// --- more load is never less fire ----------------------------------------------------
{
  let last = fire(0);
  for (let i = 1; i <= 20; i++) {
    const now = fire(i / 20);
    assert.ok(now.heat >= last.heat, `heat falls between ${(i - 1) / 20} and ${i / 20}`);
    assert.ok(now.embers >= last.embers, `embers fall between ${(i - 1) / 20} and ${i / 20}`);
    last = now;
  }
}

// --- out of range reads as the nearest end -------------------------------------------
{
  assert.deepEqual(fire(-1), fire(0), "below idle is idle");
  assert.deepEqual(fire(2), fire(1), "past full is full");
  assert.deepEqual(fire(Number.NaN), fire(0), "a load that is not a number is idle");
}

// --- a node burns its own way, the same way every time -------------------------------
{
  const a = seedOf("demo");
  assert.deepEqual(seedOf("demo"), a, "the same name seeds the same fire");
  assert.notDeepEqual(seedOf("friend"), a, "another name seeds another fire");
  assert.equal(a.length, 4, "four knobs");
  for (const name of ["", "demo", "friend", "a-very-long-node-name-indeed"]) {
    for (const v of seedOf(name)) assert.ok(v >= 0 && v < 1, `${name}: ${v} is outside [0, 1)`);
  }
}

// --- each finished request sends up what says where it ran ---------------------------
{
  const clouds = new Set(["provider"]);
  const req = (r: Partial<{ ok: boolean; caller: string; backend: string; peer: string }>) => stokeOf({ ok: true, caller: "me", ...r }, clouds);
  assert.equal(req({ backend: "local" }), STOKE.request, "a request this node ran is its own spark");
  assert.equal(req({ backend: "provider" }), STOKE.cloud, "a request a provider answered leaves through the top");
  assert.equal(req({ peer: "friend" }), STOKE.peerOut, "a request sent to a peer drifts off the side");
  assert.equal(req({ caller: "peer:friend", backend: "local" }), STOKE.peerIn, "a request in from a peer is blue-hot");
  assert.equal(req({ caller: "peer:friend", backend: "provider" }), STOKE.peerIn, "a peer's request a provider answered stays blue-hot");
  assert.equal(req({ peer: "friend", backend: "provider" }), STOKE.peerOut, "a request sent to a peer drifts off the side whatever backend it names");
  assert.equal(req({ ok: false, backend: "provider" }), STOKE.rain, "a provider's failure is rain like any other");
  assert.equal(req({ ok: false }), null, "a refusal that never ran sends nothing");
  assert.equal(new Set(Object.values(STOKE)).size, Object.keys(STOKE).length, "every kind is its own number");
}

console.log("smoke: ok");
