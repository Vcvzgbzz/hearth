/**
 * `onlyAs` on a canary model: watch an id only while it goes out as one backend id.
 *
 * A `follow` id goes out as whatever its card holds. The canary's question, its token budget
 * and above all the cost of a wrong verdict were chosen for one model; while the card holds
 * another, the id is neither probed, nor judged on real traffic, nor refused for a verdict it
 * earned as the first, nor dropped by recovery.
 *
 *   npx tsx test/canary-onlyas.test.ts
 */
import assert from "node:assert/strict";

import { Canary, type ProbeTarget, type Verdict } from "../src/observe/canary.js";
import type { CanaryProbe } from "../src/config/canary.js";
import { silentLogger } from "../src/observe/log.js";
import { parseV1 } from "./v1.js";

const OK: Verdict = { reason: "ok", ok: true, failure: false, detail: "answered as expected", sample: "Paris" };
const BAD: Verdict = { reason: "degenerate", ok: false, failure: true, detail: "the same character 200 times in a row", sample: "!!!!" };

const config = (model: Record<string, unknown>) => parseV1({
  name: "c",
  backends: [{ name: "card", url: "http://127.0.0.1:9", kind: "llama-swap", serves: ["seat-a", "seat-b"] }],
  models: { anyone: { backend: "card", as: "seat-a", follow: true } },
  canary: { models: { anyone: model }, recovery: { unload: true, cooldownMs: 1000 } },
}).canary!;

// --- config -----------------------------------------------------------------
{
  assert.equal(config({ onlyAs: "seat-a" }).models["anyone"]!.onlyAs, "seat-a");
  assert.equal(config({}).models["anyone"]!.onlyAs, undefined, "unset leaves the default");
  assert.equal(config({}).defaults.onlyAs, null, "and the default watches always");
  assert.throws(() => config({ onlyAs: " " }), /onlyAs must not be empty/);
}

/** One followed id on a card whose loaded model the test switches. */
function mk(model: Record<string, unknown>) {
  let clock = 1_000_000;
  const state = { wire: "seat-a", verdict: OK, calls: 0, unloads: 0 };
  const target = (): ProbeTarget => ({
    model: "anyone", backend: "card", wire: state.wire, canUnload: true, warm: true, idle: true, ready: true, loadedCount: 1,
    probe: async (_p: CanaryProbe, _s: AbortSignal, _load: boolean) => { state.calls++; return state.verdict; },
    unload: async () => { state.unloads++; return true; },
  });
  const canary = new Canary({ cfg: config(model), log: silentLogger, targets: () => [target()], wireOf: () => state.wire, now: () => clock });
  return { canary, state, advance: (ms: number) => { clock += ms; } };
}

// --- watched as the named model, left alone as any other ---------------------
{
  const h = mk({ onlyAs: "seat-a" });
  assert.equal(h.canary.watches("anyone", "card"), true);
  await h.canary.tick();
  assert.equal(h.state.calls, 1, "probed while the card holds the named model");

  h.state.wire = "seat-b";
  h.advance(60_000);
  assert.equal(h.canary.watches("anyone", "card"), false, "another model on the card: real traffic is not judged");
  await h.canary.tick();
  assert.equal(h.state.calls, 1, "and it is not probed");

  h.state.wire = "seat-a";
  await h.canary.tick();
  assert.equal(h.state.calls, 2, "back on the named model, the overdue probe runs at once");
}

// --- a verdict earned as one model is not held against another ---------------
{
  const h = mk({ onlyAs: "seat-a" });
  h.state.verdict = BAD;
  await h.canary.tick();
  h.advance(60_000);
  await h.canary.tick();
  assert.ok(h.canary.refuse("anyone"), "two bad answers as seat-a degrade the id");

  h.state.wire = "seat-b";
  assert.equal(h.canary.refuse("anyone"), null, "while seat-b answers under that id, it is served");
  h.advance(60_000);
  await h.canary.tick();
  assert.equal(h.state.unloads, 0, "and recovery does not drop the model that is working");

  h.state.wire = "seat-a";
  assert.ok(h.canary.refuse("anyone"), "seat-a back under that id: still out of rotation until it answers");
}

// --- without onlyAs nothing changes ------------------------------------------
{
  const h = mk({});
  h.state.wire = "seat-b";
  assert.equal(h.canary.watches("anyone", "card"), true);
  await h.canary.tick();
  assert.equal(h.state.calls, 1, "an entry without onlyAs is asked whatever the card holds");
}

console.log("canary-onlyas: ok");
