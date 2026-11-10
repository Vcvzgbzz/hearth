/**
 * The state machine: one bad answer is not an outage, and one good one is.
 *
 * Everything about the backend — is the model resident, is the seat busy, how do
 * I call it, can I unload it — is injected, so all of this runs with no HTTP and
 * no clock. That is deliberate: the interesting failures here are timing and
 * ordering ones (does a skipped probe still count? does recovery fire while a
 * job is running? does one clean probe beat two required?), and those are
 * miserable to test through a real socket.
 *
 * The two rules that keep it safe, both asserted below: a canary never loads a
 * cold model and never probes a saturated seat, and recovery never touches a
 * backend that is busy.
 *
 *   npx tsx test/canary-state.test.ts
 */
import assert from "node:assert/strict";

import { Canary, type CanaryEvent, type ProbeTarget, type Verdict } from "../src/observe/canary.js";
import type { CanaryProbe } from "../src/config/canary.js";
import { parseV1 } from "./v1.js";
import { silentLogger } from "../src/observe/log.js";

const OK: Verdict = { reason: "ok", ok: true, failure: false, detail: "answered as expected", sample: "Paris" };
const BAD: Verdict = {
  reason: "degenerate", ok: false, failure: true,
  detail: "the same character \"!\" 200 times in a row", sample: "!!!!",
};
const THINKING: Verdict = {
  reason: "thinking", ok: false, failure: false,
  detail: "the model spent its whole token budget reasoning", sample: "",
};

/** A config through the real parser, so the defaults under test are the shipped ones. */
const canaryConfig = (over: Record<string, unknown> = {}) =>
  parseV1({
    name: "c",
    backends: [{ name: "cardb", url: "http://127.0.0.1:9", kind: "llama-swap", serves: ["m"] }],
    canary: { models: { m: {} }, ...over },
  }).canary!;

/** One controllable model, standing in for a backend slot. */
interface Fake extends ProbeTarget {
  calls: number;
  unloads: number;
  loads: boolean[];
  verdict: Verdict;
  unloadOk: boolean;
}

/** The overrides a test may set: the target's own fields, plus the fake's controls. */
type FakeOver = Partial<ProbeTarget> & { verdict?: Verdict; unloadOk?: boolean };

function fake(over: FakeOver = {}): Fake {
  const t = {
    model: "m",
    backend: "cardb",
    wire: "m",
    canUnload: true,
    warm: true,
    idle: true,
    ready: true,
    loadedCount: 1,
    verdict: OK,
    unloadOk: true,
    calls: 0,
    unloads: 0,
    loads: [] as boolean[],
    probe: async (_probe: CanaryProbe, _signal: AbortSignal, load: boolean): Promise<Verdict> => {
      t.calls++;
      t.loads.push(load);
      return t.verdict;
    },
    unload: async (): Promise<boolean> => {
      t.unloads++;
      return t.unloadOk;
    },
    ...over,
  };
  return t as unknown as Fake;
}

/** One fake model, one canary, one clock the test owns. */
function mk(over: Record<string, unknown> = {}, target: FakeOver = {}) {
  let clock = 1_000_000;
  const t = fake(target);
  const events: CanaryEvent[] = [];
  const canary = new Canary({
    cfg: canaryConfig(over),
    log: silentLogger,
    targets: () => [t],
    notify: (e) => { events.push(e); },
    now: () => clock,
  });
  return {
    canary, t, events,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
  };
}

// --- one failure is not an outage ------------------------------------------
// The default threshold is two, so a single blip — a dropped connection, a
// transient 500 — must leave the seat serving.
{
  const h = mk({}, { verdict: BAD });
  h.t.verdict = BAD;
  await h.canary.tick();
  assert.equal(h.t.calls, 1, "the first tick probes");
  assert.equal(h.canary.refuse("m"), null, "one bad answer is not yet an outage");
  assert.equal(h.canary.stateOf("m")!.health, "ok");

  h.advance(60_000);
  h.t.verdict = OK;
  await h.canary.tick();
  assert.equal(h.canary.refuse("m"), null, "and a good answer clears the count");
  assert.equal(h.canary.stateOf("m")!.failures, 0);
}

// --- two in a row is --------------------------------------------------------
{
  const h = mk({}, { verdict: BAD });
  await h.canary.tick();
  h.advance(60_000);
  await h.canary.tick();

  const info = h.canary.refuse("m");
  assert.ok(info, "the second failure in a row degrades the model");
  assert.equal(info.reason, "degenerate", "and the reason rides along");
  assert.equal(info.sample, "!!!!", "with the bad output, for whoever has to read the error");
  assert.equal(info.since, h.now(), "and since when");
  assert.equal(h.canary.stateOf("m")!.health, "degraded");
  assert.equal(h.canary.degradedCount(), 1);
}

// --- a clean probe brings it back ------------------------------------------
{
  const h = mk({}, { verdict: BAD });
  await h.canary.tick();
  h.advance(60_000);
  await h.canary.tick();
  assert.ok(h.canary.refuse("m"));

  h.advance(60_000);
  h.t.verdict = OK;
  await h.canary.tick();
  assert.equal(h.canary.refuse("m"), null, "one clean probe restores the default");
  assert.equal(h.canary.stateOf("m")!.health, "ok");

  assert.deepEqual(h.events.map((e) => e.event), ["degraded", "recovered"], "both changes are announced");
  const first = h.events[0] as Extract<CanaryEvent, { event: "degraded" }>;
  const second = h.events[1] as Extract<CanaryEvent, { event: "recovered" }>;
  assert.equal(first.model, "m");
  assert.equal(first.reason, "degenerate");
  assert.equal(second.downMs, 60_000, "the notice can say how long it was out, from the degrade to the clean probe");
}

// --- recoverAfter is honoured ----------------------------------------------
{
  const h = mk({ models: { m: { recoverAfter: 2 } } }, { verdict: BAD });
  await h.canary.tick();
  h.advance(60_000);
  await h.canary.tick();
  assert.ok(h.canary.refuse("m"));

  h.advance(60_000);
  h.t.verdict = OK;
  await h.canary.tick();
  assert.ok(h.canary.refuse("m"), "one clean probe is not enough when two are asked for");

  h.advance(60_000);
  await h.canary.tick();
  assert.equal(h.canary.refuse("m"), null, "the second clean probe restores it");
}

// --- a cold model is never probed -----------------------------------------
// Probing a cold model on a swapping backend LOADS it, which is exactly the
// eviction a canary must never cause.
{
  const h = mk({}, { warm: false, loadedCount: 0 });
  await h.canary.tick();
  assert.equal(h.t.calls, 0, "a canary must never load a seat");
  assert.equal(h.canary.stateOf("m")!.health, "ok", "and never knowing is not a fault");

  h.advance(60_000);
  await h.canary.tick();
  assert.equal(h.t.calls, 0);
}

// --- a saturated seat is skipped, not queued -------------------------------
{
  const h = mk({}, { ready: false });
  await h.canary.tick();
  h.advance(60_000);
  await h.canary.tick();
  assert.equal(h.t.calls, 0, "a probe must not queue behind real work");
}

// --- recovery: one unload, then a cooldown ---------------------------------
{
  const h = mk({ recovery: { cooldownMs: 300_000 } }, { verdict: BAD });
  await h.canary.tick();          // fail 1
  h.advance(30_000);
  await h.canary.tick();          // fail 2 -> degraded
  assert.ok(h.canary.refuse("m"));

  h.advance(30_000);
  await h.canary.tick();          // recovery tick
  assert.equal(h.t.unloads, 1, "the degraded model is dropped once");
  assert.equal(h.canary.stateOf("m")!.reloadPending, true, "and the next probe may reload it");

  // It is still broken; inside the cooldown the seat is left alone.
  h.t.warm = true;
  h.t.loadedCount = 1;
  h.t.verdict = BAD;
  h.advance(30_000);
  await h.canary.tick();
  h.advance(30_000);
  await h.canary.tick();
  assert.equal(h.t.unloads, 1, "no second unload inside the cooldown");

  h.advance(300_000);
  await h.canary.tick();
  assert.equal(h.t.unloads, 2, "and after the cooldown it tries once more");
}

// --- recovery never touches a busy seat ------------------------------------
{
  const h = mk({ recovery: {} }, { verdict: BAD });
  await h.canary.tick();
  h.advance(30_000);
  await h.canary.tick();
  assert.ok(h.canary.refuse("m"));

  h.t.idle = false;               // something is running on the seat
  h.t.ready = false;
  h.advance(30_000);
  await h.canary.tick();
  assert.equal(h.t.unloads, 0, "a busy seat is never unloaded");
}

// --- recovery only where the backend can do it -----------------------------
{
  const h = mk({ recovery: {} }, { verdict: BAD, canUnload: false });
  await h.canary.tick();
  h.advance(30_000);
  await h.canary.tick();
  h.advance(30_000);
  await h.canary.tick();
  assert.equal(h.t.unloads, 0, "a kind that cannot unload is never asked to");
  assert.ok(h.canary.refuse("m"), "and the model stays degraded, with a notification instead");
}

// --- the reload the recovery needs -----------------------------------------
// After the drop the model is cold. The one exception to "never load a seat" is
// the probe that proves the recovery worked — and only while the card is empty,
// so it cannot evict a neighbour that real traffic loaded in the meantime.
{
  const h = mk({ recovery: { cooldownMs: 1_000 } }, { verdict: BAD });
  await h.canary.tick();
  h.advance(30_000);
  await h.canary.tick();
  h.advance(30_000);
  await h.canary.tick();
  assert.equal(h.t.unloads, 1);

  // The drop lands: the model is gone and the card is empty.
  h.t.warm = false;
  h.t.loadedCount = 0;
  h.t.verdict = OK;
  h.advance(30_000);
  await h.canary.tick();
  assert.equal(h.t.loads.at(-1), true, "the recovery probe is allowed to load it");
  assert.equal(h.canary.refuse("m"), null, "and a good answer restores the model");
  assert.equal(h.canary.stateOf("m")!.reloadPending, false);

  // The harder case: a neighbour is resident, so a reload would evict it.
  const n = mk({ recovery: { cooldownMs: 1_000 } }, { verdict: BAD });
  await n.canary.tick();
  n.advance(30_000);
  await n.canary.tick();
  n.advance(30_000);
  await n.canary.tick();
  assert.equal(n.t.unloads, 1);
  n.t.warm = false;
  n.t.loadedCount = 2;           // something else is on the card
  n.advance(30_000);
  await n.canary.tick();
  assert.equal(n.t.calls, 2, "no probe runs while a reload would evict a neighbour");
  assert.ok(n.canary.refuse("m"), "so the model stays degraded rather than thrashing the card");
}

// --- passive traffic is a suspicion, and the probe decides -----------------
// Two clients can legitimately ask for a wall of one character. That must not
// take the model away from everyone: it brings the probe forward, no more.
{
  const h = mk({ passive: true });
  await h.canary.tick();
  assert.equal(h.t.calls, 1, "a warm, idle, ready model is probed");
  await h.canary.tick();
  assert.equal(h.t.calls, 1, "and not again inside the interval");

  // Two degenerate completions relayed to real clients, with the seat answering
  // the canary's own question correctly.
  h.canary.observePassive("m", "cardb", BAD);
  h.canary.observePassive("m", "cardb", BAD);
  assert.equal(h.canary.refuse("m"), null, "real traffic alone never degrades a model");
  assert.equal(h.canary.stateOf("m")!.failures, 0, "and never moves the failure counter");
  await h.canary.tick();
  assert.equal(h.t.calls, 2, "it brings the next probe forward to the next tick");
  assert.equal(h.canary.refuse("m"), null, "a clean probe settles it: the seat stays in rotation");

  // The same two sightings on a seat that fails its own question too: the
  // probes do the counting, so two of them are still needed.
  h.t.verdict = BAD;
  h.canary.observePassive("m", "cardb", BAD);
  await h.canary.tick();
  assert.equal(h.t.calls, 3);
  assert.equal(h.canary.stateOf("m")!.failures, 1, "one failed probe, not a sighting plus a probe");
  assert.equal(h.canary.refuse("m"), null);
  h.canary.observePassive("m", "cardb", BAD);
  await h.canary.tick();
  assert.equal(h.t.calls, 4);
  assert.ok(h.canary.refuse("m"), "the second failed probe degrades it");
  assert.equal(h.canary.stateOf("m")!.lastVerdict!.reason, "degenerate");
}

// --- passive is ignored for a model nobody watches -------------------------
// A model outside `canary:` must never be degraded by traffic: the feature is
// opt-in, and refusing traffic for a model nobody asked about would be exactly
// the "healthy seat made worse" failure.
{
  const h = mk({ passive: true });
  h.canary.observePassive("unwatched", "cardb", BAD);
  h.canary.observePassive("unwatched", "cardb", BAD);
  assert.equal(h.canary.refuse("unwatched"), null, "an unwatched model is never degraded");
  assert.equal(h.canary.has("unwatched"), false);
  assert.equal(h.canary.has("m"), true);
}

// --- passive off means traffic is not inspected ----------------------------
{
  const h = mk();                 // passive defaults to false
  h.canary.observePassive("m", "cardb", BAD);
  h.canary.observePassive("m", "cardb", BAD);
  assert.equal(h.canary.refuse("m"), null, "with passive off, relayed traffic changes nothing");
}

// --- per-model and per-backend overrides reach the probe -------------------
{
  const cfg = parseV1({
    name: "c",
    backends: [{ name: "cardb", url: "http://127.0.0.1:9", kind: "llama-swap", serves: ["m", "n"] }],
    canary: {
      intervalMs: 10_000,
      backends: { cardb: { maxTokens: 256 } },
      models: { m: { maxTokens: 1024, intervalMs: 5_000 }, n: {} },
    },
  }).canary!;
  const canary = new Canary({ cfg, log: silentLogger, targets: () => [], now: () => 0 });
  const m = canary.probeFor("m", "cardb");
  const n = canary.probeFor("n", "cardb");
  assert.equal(m.maxTokens, 1024, "the model's own override wins");
  assert.equal(m.intervalMs, 5_000, "field by field");
  assert.equal(n.maxTokens, 256, "and falls back to its backend's");
  assert.equal(n.intervalMs, 10_000, "then to the global default");
}

// --- an inconclusive probe changes nothing ---------------------------------
// `thinking` is our probe being too small, not the seat being broken: it must
// neither degrade the model nor clear a failure count that is already running.
{
  const h = mk({}, { verdict: BAD });
  await h.canary.tick();
  assert.equal(h.canary.stateOf("m")!.failures, 1);

  h.advance(60_000);
  h.t.verdict = THINKING;
  await h.canary.tick();
  assert.equal(h.canary.stateOf("m")!.failures, 1, "an inconclusive probe neither fails nor forgives");
  assert.equal(h.canary.refuse("m"), null);
}

// --- and neither does a probe that never got a lane ------------------------
// A full queue or a shutting-down node is OUR scheduling, not the seat's health.
// Counting it would degrade a working model the moment the box got busy.
{
  const SKIPPED: Verdict = {
    reason: "skipped", ok: false, failure: false, sample: "",
    detail: "the probe did not get a lane: queue full",
  };
  const h = mk({ models: { m: { failureThreshold: 1 } } }, { verdict: BAD });
  await h.canary.tick();
  assert.ok(h.canary.refuse("m"), "a real failure still degrades");

  h.advance(60_000);
  h.t.verdict = SKIPPED;
  await h.canary.tick();
  h.advance(60_000);
  await h.canary.tick();
  assert.equal(h.canary.stateOf("m")!.failures, 1, "a skipped probe is not counted as a failure");
}

// --- the snapshot the page and /healthz read -------------------------------
{
  const h = mk({}, { verdict: BAD });
  await h.canary.tick();
  h.advance(60_000);
  await h.canary.tick();
  const snap = h.canary.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0]!.model, "m");
  assert.equal(snap[0]!.backend, "cardb");
  assert.equal(snap[0]!.health, "degraded");
  assert.equal(snap[0]!.probes, 2);
}

// --- how long a probe took, so its cost is measurable ----------------------
// A health check that is expensive is a health check that gets switched off.
// The duration belongs on the reading, not only in a log line.
{
  let clock = 1_000_000;
  const t = fake({
    probe: async (): Promise<Verdict> => {
      clock += 250;
      return OK;
    },
  });
  const canary = new Canary({ cfg: canaryConfig(), log: silentLogger, targets: () => [t], now: () => clock });
  await canary.tick();
  assert.equal(canary.stateOf("m")!.lastProbeMs, 250, "the probe's own duration is recorded");
}

console.log("canary-state.test.ts ok");
