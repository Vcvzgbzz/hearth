/**
 * A finished request read back on the console: its verdict, the rule lines that decided it as the
 * rules stand now, the tried shape the map lights, and its attempts in order.
 *
 *     npx tsx test/trace.test.ts
 */
import assert from "node:assert/strict";

import type { RequestTrace } from "../src/observe/uidata.js";
import { asTried, attemptsOf, hops, routerOf, verdict, where } from "../src/console/trace.js";

const base: RequestTrace = { id: "r1", t: 1000, asked: "chat", model: "chat", caller: "local", target: "local", backend: "gpu0", ok: true, waitedMs: 200, runMs: 3000, path: [], actions: [] };
const flows = {
  front: { steps: [{ when: { images: true }, to: { flow: "big" } }, { to: "small-model" }] },
  big: { steps: [{ when: { tokensOver: 8000 }, to: { peer: "friend", model: "my-model" } }, { to: "big-model" }] },
};

// A two-hop path: each hop names its line and condition in the rules as they are, and where the line sends.
{
  const t: RequestTrace = { ...base, model: "big-model", path: [{ flow: "front", step: 0 }, { flow: "big", step: 1 }], router: "default" };
  assert.equal(verdict(t), "chat ran as big-model on gpu0 in 3.2 s");
  const h = hops(t, flows);
  assert.deepEqual(h.map((x) => [x.flow, x.line, x.gone, x.sends]), [["front", "line 1", false, "hands it to the rule big"], ["big", "its Otherwise line", false, "runs it as big-model"]]);
  assert.deepEqual(h[0]!.when, { images: true });
  assert.deepEqual(h[1]!.when, {}, "an Otherwise line has no conditions");
  assert.equal(routerOf(t), null, "default is the rules everyone goes by");
  assert.deepEqual(asTried(t), { target: "local", model: "big-model", reason: "", path: t.path, actions: [], backend: "gpu0" });
}

// A refused request: the verdict is the refusal, and it ran nowhere.
{
  const t: RequestTrace = { ...base, target: "refused", backend: undefined, ok: false, error: "no such model", runMs: 0, waitedMs: 0 };
  assert.equal(verdict(t), "refused: no such model");
  assert.equal(where(t), "refused");
  assert.equal(asTried(t).target, "refused");
}

// A peer run: said as the peer, and the tried shape carries the peer the map lights.
{
  const t: RequestTrace = { ...base, target: "peer", backend: undefined, peer: "friend", model: "my-model", router: "team", path: [{ flow: "big", step: 0 }] };
  assert.equal(verdict(t), "chat ran as my-model on the peer friend in 3.2 s");
  assert.equal(where(t), "peer friend");
  assert.equal(asTried(t).peer, "friend");
  assert.equal(routerOf(t), "team");
  assert.equal(hops(t, flows)[0]!.sends, "sends it to the peer friend as my-model");
}

// A rule or a line that no longer exists is said to have changed, not read from what stands there now.
{
  const t: RequestTrace = { ...base, path: [{ flow: "gone", step: 0 }, { flow: "front", step: 5 }] };
  assert.deepEqual(hops(t, flows).map((x) => x.gone), [true, true]);
  assert.deepEqual(hops(t, undefined).map((x) => x.gone), [true, true], "no rules read at all");
}

// Attempts with the same id come back first attempt first, and nothing of another id.
{
  const first: RequestTrace = { ...base, t: 1000, ok: false, error: "500" };
  const second: RequestTrace = { ...base, t: 2000, model: "small-model", fallbackFrom: "chat" };
  const other: RequestTrace = { ...base, id: "r2", t: 1500 };
  assert.deepEqual(attemptsOf([second, other, first], "r1"), [first, second]);
  assert.equal(verdict(first), "chat failed on gpu0 after 3.2 s: 500");
}

console.log("trace.test.ts ok");
