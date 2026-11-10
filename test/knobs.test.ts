/**
 * The Scheduler page's logic: the lanes a file holds, what names a lane, what the live queue does
 * in them, what a removal is refused for, and what the review says a change does.
 *
 * Pure functions over the file as written and the running node's view, so this runs without a
 * browser. Only the two notes the design fixes word for word are pinned as text; the rest are
 * asserted on the case they name, so rewording one does not break a test. The last block runs the
 * sections' own edits through the page's own draft-to-ops path and saves them with a real node,
 * because only that parser says whether the file the page would write loads.
 *
 *     npx tsx test/knobs.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/config.js";
import { FIELDS } from "../src/config/fields.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";
import { backendRows, callersOf, callerRows, CLEARABLE, defaultJobs, draftLanes, editedAt, editedIn, hiddenModels, knobLanes, knobOps, LANE_DEFAULT_WORDS, laneCanClear, laneMenu, laneNameError, laneBadges, lanePinGroups, laneRows, laneText, lanesWithoutPriority, modelRows, pinLanes, pinRowsOf, numberText, overtakeSeconds, overtakeText, pageFor, PIN_WORDS, pinValueAt, pinsOf, priorityGaps, reasonText, removalBlock, reviewNotes, savePool, seeded, setAt, strayLane, valueAt, waitingOn, type Doc, type LanePin, type ModelRow, type Path, type PoolEdit, type PoolMode } from "../src/console/knobs.js";
import type { Job, LaneDefaults, SchedulerView } from "../src/observe/uidata.js";

const view = (): SchedulerView => ({
  lanes: [
    { name: "chat", priority: 0 },
    { name: "batch", priority: 100, ceiling: 2, maxWaitMs: 60_000 },
    { name: "archive", priority: 300 },
    { name: "warm", priority: 200, builtIn: true },
  ],
  order: { agePerSecond: 1, warmBonus: 40, maxPerLane: 100, maxPerCaller: 0 },
  defaults: { first: "chat", peers: "archive", routes: "archive" },
});
const defaults = (first: string, peers: string, routes: string): LaneDefaults => ({ first, peers, routes });
const lanesWith = (lanes: Record<string, unknown>) => ({ version: 3, scheduler: { lanes } });
const job = (id: string, lane: string, state: Job["state"], extra: Partial<Job> = {}): Job =>
  ({ id, lane, model: "m", caller: "app", state, position: 0, since: 0, backend: "b", ...extra });

/** The file with one of each thing that can name a lane. */
const doc = (): Record<string, unknown> => ({
  version: 3,
  name: "n",
  backends: {
    b: { url: "http://127.0.0.1:8080", routes: [{ path: "/speak", model: "say", lane: "batch" }, { path: "/plain", model: "say" }], hold: { lanes: ["chat"], idleMs: 5000 } },
  },
  models: { m: { backend: "b", lane: "chat" } },
  flows: { f: { inputs: ["auto"], steps: [{ to: "m" }, { to: "m", lane: "batch" }] } },
  routers: { r: { flows: { f: { inputs: ["auto"], steps: [{ to: "m", lane: "batch" }, { to: "m", lane: "archive" }] } } } },
  apiKeys: [{ key: "secret", label: "app", lane: "chat" }],
  lending: { lane: "batch" },
});

// --- an old link lands on the page that replaced it --------------------------------------------
{
  assert.equal(pageFor("queue"), "scheduler");
  assert.equal(pageFor("keys"), "keys", "every other name is itself");
}

// --- everything in the file that names a lane, each with the path it writes ---------------------
{
  const pins = pinsOf(doc());
  const at = (kind: string, name: string) => pins.find((p) => p.kind === kind && p.name === name)!;
  assert.deepEqual(at("model", "m").path, ["models", "m", "lane"]);
  assert.equal(at("model", "m").lane, "chat");
  // A route's lane needs a restart; the rest apply live.
  assert.deepEqual([at("route", "b").path, at("route", "b").lane, at("route", "b").restart], [["backends", "b", "routes", 0, "lane"], "batch", true]);
  assert.deepEqual([at("hold", "b").path, at("hold", "b").lane, at("hold", "b").restart], [["backends", "b", "hold", "lanes", 0], "chat", true]);
  assert.deepEqual(at("rule", "f").path, ["flows", "f", "steps", 1, "lane"]);
  // A key's name is its label, which is what the page and a removal message call it.
  assert.deepEqual([at("key", "app").path, at("key", "app").name], [["apiKeys", 0, "lane"], "app"]);
  // A key with no label is known only by its secret, so there is no name to show and nothing safe to write.
  // A label-less key cannot be given one here: the secret would become its name, so the pin can only be made by the first entry.
  const unnamed = pinsOf({ apiKeys: [{ key: "labelled", label: "app", lane: "chat" }, { key: "other", lane: "batch" }, "bare"] });
  assert.deepEqual(unnamed.map((p) => [p.kind, p.name, p.path]), [["key", "app", ["apiKeys", 0, "lane"]]], "no label, no pin");
  assert.deepEqual(at("lending", "lending").path, ["lending", "lane"]);
  assert.deepEqual(pins.filter((p) => p.restart).map((p) => p.kind).sort(), ["hold", "route"], "only the backend's own lanes wait for a restart");
  // A route, a step and a key that name no lane write nothing, and a router's rules are read as well as the file's own.
  assert.equal(pins.filter((p) => p.kind === "route").length, 1, "the path-only route has no lane to change");
  assert.equal(pins.filter((p) => p.kind === "rule" && p.path[0] === "flows").length, 1);
  assert.deepEqual(pins.find((p) => p.name === "f" && p.path[0] === "routers")!.path, ["routers", "r", "flows", "f", "steps", 0, "lane"]);
  // Every path reads to its own lane out of the doc, except a hold's, which is a list of them.
  const lanes = pins.filter((p) => p.kind !== "hold").map((p) => [p.kind, p.lane]);
  assert.deepEqual(lanes, [["model", "chat"], ["route", "batch"], ["rule", "batch"], ["rule", "batch"], ["rule", "archive"], ["key", "chat"], ["lending", "batch"]]);
  const holds = pins.filter((p) => p.kind === "hold");
  assert.deepEqual(holds.map((p) => p.path), [["backends", "b", "hold", "lanes", 0]], "a hold's lanes is a list, so its pin takes the index");
  assert.deepEqual(holds.map((p) => p.lane), ["chat"]);
}

// --- a rule's condition that tests a lane names it too ------------------------------------------
{
  const testing = (): Record<string, unknown> => ({
    version: 3,
    flows: {
      chatty: { inputs: ["auto"], steps: [
        { when: { lane: ["batch", "archive"] }, to: "m" },
        { when: { laneNot: "archive" }, to: "m" },
        { to: "m" },
      ] },
      plain: { inputs: ["other"], steps: [{ when: { caller: ["app"] }, to: "m" }, { to: "m" }] },
    },
    routers: { side: { flows: {
      other: { inputs: ["*"], steps: [{ when: { lane: "batch" }, to: "m" }, { to: "m" }] },
      picky: { inputs: ["x"], steps: [{ when: { lane: ["chat"], laneNot: ["batch", "archive"] }, to: "m" }, { to: "m" }] },
    } } },
  });
  const whens = pinsOf(testing()).filter((p) => p.kind === "when");
  // Every lane a condition names is a pin of its own, with the index of its entry: a rule that narrowed to one lane is not a list.
  assert.deepEqual(whens.map((p) => [p.lane, p.path]), [
    ["batch", ["flows", "chatty", "steps", 0, "when", "lane", 0]],
    ["archive", ["flows", "chatty", "steps", 0, "when", "lane", 1]],
    ["archive", ["flows", "chatty", "steps", 1, "when", "laneNot"]],
    ["batch", ["routers", "side", "flows", "other", "steps", 0, "when", "lane"]],
    ["chat", ["routers", "side", "flows", "picky", "steps", 0, "when", "lane", 0]],
    ["batch", ["routers", "side", "flows", "picky", "steps", 0, "when", "laneNot", 0]],
    ["archive", ["routers", "side", "flows", "picky", "steps", 0, "when", "laneNot", 1]],
  ]);
  // The rule a condition sits in is the pin's name, and a condition applies without a restart.
  assert.deepEqual(whens.filter((p) => p.name === "chatty").map((p) => p.restart), [false, false, false]);
  assert.equal(whens.find((p) => p.path[3] === "picky")!.name, "picky", "a rule inside a router is named as the rule it is");
  // A condition that tests no lane adds none.
  assert.equal(whens.filter((p) => p.name === "plain").length, 0);
  // Every path reads back the lane it names.
  for (const p of whens) {
    let here: unknown = testing();
    for (const step of p.path) here = (here as Record<string | number, unknown>)[step];
    assert.equal(here, p.lane);
  }
}

// --- and who waits on a lane's jobs: keys, peers, and the lending default ----------------------
{
  const d = {
    ...doc(),
    apiKeys: [
      { key: "one", label: "app", lane: "chat", limits: { maxConcurrent: 3, models: { m: { maxConcurrent: 1 } } } },
      { key: "two" },
      "three",
    ],
    peers: { p: { accept: "t", lend: { maxConcurrent: 4, limits: { m: { maxConcurrent: 2 }, say: {} } } }, q: { url: "http://127.0.0.1:1", token: "t" } },
    lending: { lane: "batch", maxConcurrent: 6 },
  };
  const callers = callersOf(d);
  const named = (name: string) => callers.find((c) => c.name === name)!;
  // A labelled key is a caller the node knows by name, and both its settings have a path to write.
  assert.deepEqual([named("app").kind, named("app").lanePath, named("app").jobsPath, named("app").jobs], ["key", ["apiKeys", 0, "lane"], ["apiKeys", 0, "limits", "maxConcurrent"], 3]);
  assert.equal(named("app").overrides, 1, "one model of its own");
  // An unlabelled key has no name the node would know it by, so it is shown for what it is and nothing of it can be edited.
  const anonymous = (i: number) => callers.filter((c) => c.kind === "key")[i]!;
  assert.deepEqual([anonymous(1).name, anonymous(1).lanePath, anonymous(1).jobsPath, anonymous(1).lane, anonymous(1).jobs], ["unlabelled key 2", null, null, null, null]);
  assert.deepEqual([anonymous(2).lanePath, anonymous(2).jobsPath], [null, null], "a bare secret names no one either");
  // A peer's jobs at once is what it may take here; it names no lane.
  assert.deepEqual([named("p").kind, named("p").lanePath, named("p").jobsPath, named("p").jobs, named("p").overrides], ["peer", null, ["peers", "p", "lend", "maxConcurrent"], 4, 2]);
  assert.deepEqual([named("q").jobs, named("q").jobsPath, named("q").overrides], [null, null, 0], "a peer it only borrows from lends nothing");
  // Borrowed work has a lane and jobs at once of its own, whatever peers are named.
  const lending = named("lending");
  assert.deepEqual([lending.kind, lending.lane, lending.lanePath, lending.jobs, lending.jobsPath, lending.overrides], ["lending", "batch", ["lending", "lane"], 6, ["lending", "maxConcurrent"], 0]);
  assert.equal(new Set(callers.map((c) => `${c.kind}:${c.name}`)).size, callers.length, "each caller is listed once");
  assert.deepEqual(callersOf({ peers: { p: { url: "http://127.0.0.1:1", token: "t" } } }).map((c) => c.kind), ["peer", "lending"], "lending is listed whether or not the file has it");
}

// --- the draft the page starts from ------------------------------------------------------------
{
  // A file with no lanes of its own runs on the built-in ones, so the draft writes them all, warm
  // included: editing one without the rest would drop every lane the node does have.
  const bare = { version: 3, name: "n" };
  const among = seeded(bare, view()).scheduler as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(among.lanes!), view().lanes.filter((l) => !l.builtIn).map((l) => l.name));
  assert.deepEqual(among.lanes!.batch, { priority: 100, concurrency: 2, maxWaitMs: 60_000 });
  assert.deepEqual(among.lanes!.chat, { priority: 0 }, "a lane that sets nothing else stays a priority alone");
  // Lanes only: the order settings are written when one of them is edited, not seeded into a file that never had them.
  assert.deepEqual(Object.keys(among).sort(), ["lanes"]);
  assert.deepEqual(bare, { version: 3, name: "n" }, "the file is not touched");
  // A scheduler block that is already there keeps everything else in it.
  const partly = { version: 3, scheduler: { maxPerLane: 7 } };
  assert.deepEqual(seeded(partly, view()).scheduler, { maxPerLane: 7, lanes: among.lanes });
  const untouched = { version: 3, scheduler: { lanes: { chat: { priority: 0 } }, maxPerLane: 7 } };
  assert.deepEqual(seeded(untouched, view()), untouched, "a file with lanes is its own, key for key");
  // A file that has them is its own: nothing the view says overrides it, and a warm it declares stays.
  const own = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, warm: { priority: 5 }, archive: { priority: 9, concurrency: 1 } }, maxPerLane: 7 } };
  const kept = seeded(own, view());
  assert.deepEqual(kept, own);
  assert.deepEqual(kept, { ...own, scheduler: { ...own.scheduler, lanes: { ...own.scheduler.lanes } } }, "what the seed writes is its own copy");
}

// --- what the live queue is doing in each lane -------------------------------------------------
{
  const jobs = [
    job("1", "chat", "running"),
    job("2", "chat", "running"),
    job("3", "chat", "queued", { position: 0 }),
    job("4", "chat", "queued", { held: "key", position: 1 }),
    job("5", "chat", "queued", { offbox: true, peer: "p", position: 2 }),
    job("6", "batch", "running"),
    job("7", "batch", "queued", { held: "key", position: 0 }),
    job("8", "gone", "queued", { position: 0 }),
  ];
  const rows = laneRows(view(), jobs);
  const row = (name: string) => rows.find((r) => r.name === name)!;
  // Off-box work runs on a peer: it is neither this lane's slots nor its line here.
  assert.deepEqual([row("chat").running, row("chat").queued, row("chat").heldByKey], [2, 1, 1]);
  assert.deepEqual([row("batch").running, row("batch").queued, row("batch").heldByKey], [1, 0, 1], "a job its key holds is not in the line");
  assert.deepEqual([row("chat").inFile, row("chat").priority, row("chat").ceiling], [true, 0, undefined]);
  assert.deepEqual([row("batch").ceiling, row("batch").maxWaitMs], [2, 60_000], "the view's own numbers come through");
  assert.deepEqual(rows.map((r) => r.name), ["chat", "batch", "warm", "archive", "gone"], "in priority order, with warm among them and no lane left out");
  // A lane the file no longer has still has jobs, which run at the priority an unknown lane sorts at.
  assert.deepEqual([row("gone").inFile, row("gone").priority, row("gone").queued], [false, 1000, 1]);
  // An empty lane is a row of zeros, not a missing row.
  assert.deepEqual([row("warm").running, row("warm").queued, row("warm").heldByKey, row("warm").builtIn], [0, 0, 0, true]);
}

// --- a name the Add lane box refuses ----------------------------------------------------------
{
  assert.match(laneNameError("", doc())!, /name/);
  assert.match(laneNameError("   ", doc())!, /name/, "a name of spaces is an empty one");
  assert.match(laneNameError("warm", doc())!, /warm/);
  assert.match(laneNameError("chat", lanesWith({ chat: { priority: 0 } }))!, /chat/, "the file already names it");
  assert.equal(laneNameError("archive", lanesWith({ chat: { priority: 0 } })), null);
  // A file that writes no lanes runs on the built-in ones, which are as taken as any it declares.
  const bare = doc();
  const withoutLanes = { ...bare, scheduler: { maxPerLane: 5 } };
  assert.match(laneNameError("chat", withoutLanes)!, /chat/);
  assert.match(laneNameError("batch", withoutLanes)!, /batch/);
  assert.equal(laneNameError("archive", withoutLanes), null);
}

// --- when a lane cannot be removed ------------------------------------------------------------
{
  const pins = pinsOf(doc());
  const none = defaults("chat", "batch", "batch");
  // Jobs come first: they are what is happening now, whatever the file says.
  const running = removalBlock("chat", [], none, [job("1", "chat", "running")])!;
  assert.match(running, /running/);
  assert.match(running, /chat/);
  assert.match(removalBlock("chat", [], none, [job("1", "chat", "queued")])!, /waiting|queued/);
  // Then the three defaults, each named for what it moves.
  const first = removalBlock("chat", [], none, [])!;
  assert.match(first, /first|default/);
  assert.match(first, /chat/);
  assert.match(removalBlock("batch", [], none, [])!, /lending|borrowed|peers/i);
  assert.match(removalBlock("archive", [], defaults("chat", "batch", "archive"), [])!, /Routes that name no lane land in archive/);
  // Then everything in the file that names it.
  const pinned = removalBlock("chat", pins, none, [])!;
  assert.match(pinned, /m/, "the model that pins it is named");
  const second = removalBlock("batch", pins, defaults("chat", "chat", "chat"), [])!;
  assert.match(second, /b/, "the backend whose route and hold pin it is named");
  assert.match(second, /lending/, "and lending, which sends borrowed work there");
  // A key is named by its label, so the message has something to point at.
  // A condition that sends requests away from a lane names it as surely as a step that queues in one.
  const only = pinsOf({ flows: { guard: { inputs: ["auto"], steps: [{ when: { lane: ["batch"] }, to: "m" }, { to: "m" }] } } });
  const stuck = removalBlock("batch", only, defaults("chat", "chat", "chat"), [])!;
  assert.match(stuck, /condition in rule guard/, "the rule the condition is in is named");
  assert.equal(removalBlock("archive", only, defaults("chat", "chat", "chat"), []), null, "another lane is free");

  assert.match(removalBlock("chat", pins, defaults("batch", "batch", "batch"), [])!, /key app/);
  // A lane nothing uses and nothing waits in can go.
  assert.equal(removalBlock("archive", pins.filter((p) => p.lane !== "archive"), defaults("chat", "batch", "batch"), []), null);
  // A saved lane change that is still waiting on a restart: routes keep the lane they were built with,
  // so the lane the rule picks now says nothing about what they are in.
  const fresh = defaults("chat", "batch", "batch");
  const pending = removalBlock("batch", [], fresh, [], ["backends"]);
  assert.match(pending!, /restart/i, "a lane waiting on a restart says so");
  assert.match(pending!, /batch/, "and names the lane");
  // Other keys waiting on their own restart do not hold a lane back.
  assert.equal(removalBlock("archive", [], fresh, [], ["plugins"]), null, "a plugin's restart is not a lane's");
  // Everything else is checked in the same order as before, restart or not.
  assert.match(removalBlock("chat", [], fresh, [job("1", "chat", "running")], ["backends"])!, /running/);
}

// --- what Review says a change will do --------------------------------------------------------
{
  const base = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 } } } };
  const changed = (lanes: Record<string, unknown>) => ({ version: 3, scheduler: { lanes } });
  const peersStill = defaults("chat", "batch", "batch");
  const peersMoved = defaults("chat", "archive", "archive");
  // The one change nobody asked for: work that follows a lane's place in the list follows it.
  const movedPeers = reviewNotes(base, changed({ chat: { priority: 0 }, batch: { priority: 100 }, archive: { priority: 300 } }), { before: peersStill, after: peersMoved });
  assert.ok(movedPeers.includes("Borrowed peer work moves from batch to archive."));
  assert.ok(movedPeers.includes("Any route that names no lane moves from batch to archive after a restart."));
  // The route's move is the one that waits for a restart, and only it says so.
  assert.deepEqual(movedPeers.filter((n) => /restart/i.test(n)), ["Any route that names no lane moves from batch to archive after a restart."]);
  // The defaults are the parser's to work out, so the move is said once and the page never guesses at it.
  assert.deepEqual(movedPeers, ["Borrowed peer work moves from batch to archive.", "Any route that names no lane moves from batch to archive after a restart."]);
  // A lane already last takes nothing new by moving further down, and so is not reported as moving anything.
  const up = changed({ chat: { priority: 0 }, batch: { priority: 400 } });
  assert.deepEqual(reviewNotes(base, up, { before: peersStill, after: peersStill }), []);
  assert.deepEqual(reviewNotes(base, up), [], "with no defaults reported, the page does not guess");
  // Nobody can see what a client asks for by name, so removing a lane always says so.
  // The page takes a lane out by writing null over it (setAt), and that is what counts as gone.
  const pageRemoval = setAt({ version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100, maxWaitMs: 60_000 } } } }, ["scheduler", "lanes", "batch"], null);
  const byNull = reviewNotes(base, pageRemoval, { before: peersStill, after: defaults("chat", "chat", "chat") });
  assert.ok(byNull.some((n) => /batch/.test(n) && /client|plugin|no longer/i.test(n)), "a lane the page cleared to null is a lane removed");
  // Its max wait is gone with it: a lane that is no longer there has no timer to report.
  assert.deepEqual(byNull.filter((n) => /new jobs/.test(n)), [], "a removed lane's max wait is not reported as changed");
  // And its name is free again, so it can be added back.
  assert.equal(laneNameError("batch", pageRemoval), null, "a lane taken out can be added again");
  assert.match(laneNameError("chat", pageRemoval)!, /chat/);
  const cut = reviewNotes(base, changed({ chat: { priority: 0 } }), { before: peersStill, after: defaults("chat", "chat", "chat") });
  assert.ok(cut.some((n) => /batch/.test(n) && /client|plugin|no longer|removed/i.test(n)), "removing a lane is noted against the clients that ask for it");
  assert.ok(cut.includes("Borrowed peer work moves from batch to chat."));
  assert.ok(cut.includes("Any route that names no lane moves from batch to chat after a restart."));
  // A max wait is read when a job is queued, so a change reaches the next ones only.
  const wait = reviewNotes(base, changed({ chat: { priority: 0, maxWaitMs: 30_000 }, batch: { priority: 100 } }));
  assert.deepEqual(wait.length, 1, "the max wait's own limit, and nothing else");
  assert.match(wait[0]!, /chat/);
  assert.match(wait[0]!, /new jobs/);
  assert.deepEqual(reviewNotes(base, base, { before: peersStill, after: peersStill }), []);
  assert.deepEqual(reviewNotes(base, base), []);
  assert.deepEqual(reviewNotes({ version: 3 }, { version: 3 }), []);
}

// --- a lane 100 apart at a weight of 1 overtakes after 100 seconds -----------------------------
{
  assert.equal(overtakeSeconds(100, 1), 100);
  assert.equal(overtakeSeconds(200, 4), 50);
  assert.equal(overtakeSeconds(100, 0), null, "nothing ages, so nothing is ever overtaken");
  assert.equal(overtakeSeconds(0, 1), 0, "a lane level with another needs no time at all");
}

// --- what a weight of earned priority says about the lanes' own gap ----------------------------
{
  const gapOf = (before: number, after: number) => ({ before, after });
  // Two lanes 100 apart: the lower one earned its way past after 100 seconds at a weight of 1.
  assert.deepEqual(overtakeText([0, 100, 300], 1), { gap: gapOf(0, 100), seconds: 100 });
  // The smallest gap is the one to quote, and it is between neighbours in priority order.
  assert.deepEqual(overtakeText([0, 100, 150], 1), { gap: gapOf(100, 150), seconds: 50 });
  assert.deepEqual(overtakeText([0, 100, 150], 2), { gap: gapOf(100, 150), seconds: 25 }, "the pair is quoted, its gap worked out at the weight");
  // Nothing ages: the pair is still there, and no time is quoted for it.
  assert.deepEqual(overtakeText([0, 100], 0), { gap: gapOf(0, 100), seconds: null }, "a weight of zero is a lane that never earns its way past");
  assert.deepEqual(overtakeText([0, 100], -1), { gap: gapOf(0, 100), seconds: null });
  // Level lanes are no gap to quote: a pair at the same priority never overtakes anything, so the
  // smallest gap that is not zero is the one to say. Add lane's default priority makes this at once.
  assert.deepEqual(overtakeText([0, 0, 100], 1), { gap: gapOf(0, 100), seconds: 100 }, "two lanes level beside a third: the 100 apart is the gap");
  assert.deepEqual(overtakeText([0, 0, 100, 400], 1), { gap: gapOf(0, 100), seconds: 100 }, "the nearest non-zero gap, not the level pair");
  // Only when every lane is level is there no gap at all to quote.
  assert.deepEqual(overtakeText([0, 0], 1), { gap: null, seconds: null }, "every lane level: nothing to overtake");
  assert.deepEqual(overtakeText([5, 5, 5], 2), { gap: null, seconds: null });
  // One lane, or none, has no gap at all.
  assert.deepEqual(overtakeText([0], 1), { gap: null, seconds: null });
  assert.deepEqual(overtakeText([], 1), { gap: null, seconds: null });

  // The priorities are the rows the page draws, so a warm the node runs on is not a lane with a gap.
  const rows = laneRows(view(), []);
  const running = seeded({ version: 3 }, view());
  assert.deepEqual(priorityGaps(rows, running), [0, 100, 300], "warm's own priority is left out of the gaps");
  assert.deepEqual(priorityGaps(rows, { version: 3, scheduler: { lanes: { chat: { priority: 0 }, bulk: { priority: 50 }, batch: { priority: 100 } } } }), [0, 50, 100], "a lane edited in the draft is where the draft puts it");
  // A lane the draft takes out is not in the gaps either.
  assert.deepEqual(priorityGaps(rows, setAt(running, ["scheduler", "lanes", "batch"], null)), [0, 300]);
}

// --- why a job waits, in the spec's own words --------------------------------------------------
{
  // Reason words are the design's, not a shortening of them.
  assert.equal(reasonText("key"), "the job's key is at its limit");
  assert.equal(reasonText("card"), "another backend has the card, or this one is handing it over");
  assert.equal(reasonText("hold"), "a neighbour's app has this lane kept off the card");
  assert.equal(reasonText("lane"), "the lane is at its ceiling");
  assert.equal(reasonText("model"), "the model is at its own ceiling");
  assert.equal(reasonText("pool"), "the model's shared context pool is full");
  assert.equal(reasonText("share"), "waiting out a running turn's head start");
  assert.equal(reasonText("slots"), "every slot on the backend is taken");
}

// --- which job is next in line, and which waits behind one that cannot start -------------------
{
  const queued = (id: string, lane: string, backend: string, position: number, extra: Partial<Job> = {}): Job =>
    job(id, lane, "queued", { backend, position, ...extra });
  // Position is per backend, so a lane's jobs on two backends are two lines.
  const two = [
    job("run", "chat", "running", { backend: "a" }),
    queued("a0", "chat", "a", 0),
    queued("b0", "batch", "b", 0),
    queued("b1", "batch", "b", 1),
    queued("a1", "chat", "a", 1),
  ];
  assert.equal(waitingOn(two.find((j) => j.id === "a0")!, two), "next in line", "the first on its own backend is next in line");
  assert.equal(waitingOn(two.find((j) => j.id === "b0")!, two), "next in line", "a batch job behind a blocked chat head is next in line on its own backend");
  assert.equal(waitingOn(two.find((j) => j.id === "b1")!, two), "behind a better-placed job that cannot start yet", "and the one behind it says so, as the spec's none row does");
  // A job its key holds holds no place in line, so it is not what the others wait behind.
  const held = [queued("h0", "chat", "a", 0, { held: "key" }), queued("a1", "chat", "a", 1)];
  assert.equal(waitingOn(held[0]!, held), reasonText("key"), "a held job says why it is held");
  assert.equal(waitingOn(held[1]!, held), "next in line", "the job behind it starts now, since the held one is passed over");
  // A job the node names a reason for says that reason, and it wins over its place.
  const blocked = [queued("a0", "chat", "a", 0, { why: "slots" }), queued("a1", "chat", "a", 1)];
  assert.equal(waitingOn(blocked[0]!, blocked), reasonText("slots"));
  // A running job is not waiting on anything.
  assert.equal(waitingOn(two[0]!, two), null);
}

// --- an edit to one path of the file ----------------------------------------------------------
{
  const before = { version: 3, scheduler: { lanes: { chat: { priority: 0 } } } };
  const after = setAt(before, ["scheduler", "lanes", "archive", "priority"], 300);
  assert.deepEqual(after, { version: 3, scheduler: { lanes: { chat: { priority: 0 }, archive: { priority: 300 } } } });
  assert.deepEqual(before, { version: 3, scheduler: { lanes: { chat: { priority: 0 } } } }, "the doc it was given is not changed");
  assert.notEqual(after.scheduler, before.scheduler, "and what it holds is not shared with it");
  // A key the file does not have yet is made on the way down.
  assert.deepEqual(setAt({}, ["backends", "b", "hold", "idleMs"], 5000), { backends: { b: { hold: { idleMs: 5000 } } } });
  // A cleared field is written as null, which the ops turn into a delete, so the key is gone rather than set empty.
  assert.deepEqual(setAt(before, ["scheduler", "warmBonus"], null), { version: 3, scheduler: { lanes: { chat: { priority: 0 } }, warmBonus: null } });
  assert.deepEqual(setAt(before, ["scheduler", "lanes", "chat", "concurrency"], 2), { version: 3, scheduler: { lanes: { chat: { priority: 0, concurrency: 2 } } } });
  // A list is written into by index, and a section that is not the shape the path wants is replaced.
  assert.deepEqual(setAt({ backends: { b: { routes: [{ path: "/a" }] } } }, ["backends", "b", "routes", 0, "lane"], "batch"), { backends: { b: { routes: [{ path: "/a", lane: "batch" }] } } });
  assert.deepEqual(setAt({ scheduler: 5 }, ["scheduler", "maxPerLane"], 10), { scheduler: { maxPerLane: 10 } });
  assert.deepEqual(setAt({ scheduler: { lanes: null } }, ["scheduler", "lanes", "chat", "priority"], 0), { scheduler: { lanes: { chat: { priority: 0 } } } });
  // A path that ends on a list entry replaces the entry itself: a hold's lanes is exactly that kind of path.
  const holds = { backends: { b: { hold: { lanes: ["chat", "batch"], idleMs: 5000 } } } };
  assert.deepEqual(setAt(holds, ["backends", "b", "hold", "lanes", 0], "archive").backends, { b: { hold: { lanes: ["archive", "batch"], idleMs: 5000 } } });
  assert.deepEqual(setAt(holds, ["backends", "b", "hold", "lanes", 1], null).backends, { b: { hold: { lanes: ["chat", null], idleMs: 5000 } } });
  assert.deepEqual(holds.backends, { b: { hold: { lanes: ["chat", "batch"], idleMs: 5000 } } }, "and the doc it was given is not changed");
  // A condition's lane list, reached one entry at a time, keeps the lanes beside the one written.
  const tested = { flows: { f: { steps: [{ when: { lane: ["chat", "batch"], laneNot: ["archive"] }, to: "m" }] } } };
  assert.deepEqual(setAt(tested, ["flows", "f", "steps", 0, "when", "lane", 1], "bulk").flows, { f: { steps: [{ when: { lane: ["chat", "bulk"], laneNot: ["archive"] }, to: "m" }] } });
  assert.deepEqual(setAt(tested, ["flows", "f", "steps", 0, "when", "laneNot", 0], null).flows, { f: { steps: [{ when: { lane: ["chat", "batch"], laneNot: [null] }, to: "m" }] } });
  assert.deepEqual(tested.flows.f.steps[0]!.when.lane, ["chat", "batch"], "and the doc it was given is not changed");
  // A list written past its end has the entries before it kept.
  assert.deepEqual(setAt({ lanes: ["chat"] }, ["lanes", 2], "batch").lanes, ["chat", undefined, "batch"]);
  // Writing one path leaves its siblings, and the key order of its parent, as they were.
  const wide = { version: 3, scheduler: { lanes: { chat: { priority: 0, concurrency: 2 } }, agePerSecond: 1 } };
  const edited = setAt(wide, ["scheduler", "lanes", "chat", "priority"], -10);
  assert.deepEqual(edited, { version: 3, scheduler: { lanes: { chat: { priority: -10, concurrency: 2 } }, agePerSecond: 1 } });
  assert.deepEqual(Object.keys((edited.scheduler as Record<string, unknown>).lanes as object), ["chat"]);
}

// --- the ops that write a draft, with the lanes a file never wrote going in whole -------------------
{
  const bare = { version: 3, name: "n" };
  const seed = seeded(bare, view());
  // Nothing edited, nothing written.
  assert.deepEqual(knobOps(bare, seed, seed), []);
  // An edit that leaves the lanes alone does not write them.
  const slower = setAt(seed, ["scheduler", "agePerSecond"], 2);
  assert.deepEqual(knobOps(bare, seed, slower), [{ path: ["scheduler", "agePerSecond"], value: 2 }]);
  // An edit to one lane writes every lane the file never had, or the edit would drop the rest of them.
  const edited = setAt(seed, ["scheduler", "lanes", "batch", "priority"], 120);
  const ops = knobOps(bare, seed, edited);
  const seededLanes = (seed.scheduler as Record<string, Record<string, unknown>>).lanes;
  assert.deepEqual(ops, [{ path: ["scheduler", "lanes"], value: seededLanes }, { path: ["scheduler", "lanes", "batch", "priority"], value: 120 }]);
  assert.deepEqual(Object.keys(ops[0]!.value as Record<string, unknown>), ["chat", "batch", "archive"]);
  // A file that has its own lanes is edited by the leaf, like any other part of the file.
  const own = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 } } } };
  const ownSeed = seeded(own, view());
  assert.deepEqual(knobOps(own, ownSeed, setAt(ownSeed, ["scheduler", "lanes", "batch", "priority"], 120)), [{ path: ["scheduler", "lanes", "batch", "priority"], value: 120 }]);
  // A lane added or removed is a leaf of its own key, not the block.
  const added = setAt(ownSeed, ["scheduler", "lanes", "archive", "priority"], 300);
  assert.deepEqual(knobOps(own, ownSeed, added), [{ path: ["scheduler", "lanes", "archive"], value: { priority: 300 } }]);
  // A key set to nothing is a value no file can hold, so it is never an op at all.
  assert.deepEqual(knobOps(bare, { a: 1 }, { a: undefined }), [], "no op carries a value the node cannot write");
}

// --- what a row clears, written as the node takes it: a key taken out, never a value the parser refuses ---
{
  // Clearing writes null into the draft, which the page turns into a deletion; writing the key
  // without a value, or a null the file never had, is refused by the node. These drafts are made
  // with the page's own setAt, so the test sees exactly what the row hands knobOps.
  const own = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100, concurrency: 2, maxWaitMs: 60_000 } } } };
  const start = seeded(own, view());
  const cleared = setAt(start, ["scheduler", "lanes", "batch", "concurrency"], null);
  assert.deepEqual(knobOps(own, start, cleared), [{ path: ["scheduler", "lanes", "batch", "concurrency"], delete: true }], "a ceiling the file writes is deleted, not sent as undefined");
  assert.deepEqual(knobOps(own, start, setAt(start, ["scheduler", "lanes", "batch", "maxWaitMs"], null)), [{ path: ["scheduler", "lanes", "batch", "maxWaitMs"], delete: true }]);
  // A key the file does not have, set and then cleared again, is no edit: a null op would be a value the parser refuses.
  const unset = setAt(start, ["scheduler", "warmBonus"], 50);
  assert.deepEqual(knobOps(own, start, unset), [{ path: ["scheduler", "warmBonus"], value: 50 }]);
  assert.deepEqual(knobOps(own, start, setAt(unset, ["scheduler", "warmBonus"], null)), [], "a key the file never had is not written as null");
  // The same for a key of a lane: set, then cleared, leaves nothing behind.
  const addedWait = setAt(start, ["scheduler", "lanes", "chat", "maxWaitMs"], 5000);
  assert.deepEqual(knobOps(own, start, addedWait), [{ path: ["scheduler", "lanes", "chat", "maxWaitMs"], value: 5000 }]);
  assert.deepEqual(knobOps(own, start, setAt(addedWait, ["scheduler", "lanes", "chat", "maxWaitMs"], null)), []);
  // One key cleared while another is set writes only the change.
  assert.deepEqual(knobOps(own, start, setAt(cleared, ["scheduler", "lanes", "batch", "priority"], 120)), [
    { path: ["scheduler", "lanes", "batch", "priority"], value: 120 },
    { path: ["scheduler", "lanes", "batch", "concurrency"], delete: true },
  ]);
}

// --- a file with no lanes of its own: a lane added, another, and the first taken back -----------
{
  const bare = { version: 3, name: "n" };
  const start = seeded(bare, view());
  const both = setAt(setAt(start, ["scheduler", "lanes", "x", "priority"], 0), ["scheduler", "lanes", "y", "priority"], 150);
  // One op per lane the file never wrote, and the block of the seeded lanes beside them, so the file
  // gains the new lanes without losing the ones the node runs on. A null entry would be a key the parser refuses.
  const ops = knobOps(bare, start, both);
  assert.deepEqual(ops.map((op) => op.path), [["scheduler", "lanes"], ["scheduler", "lanes", "x"], ["scheduler", "lanes", "y"]]);
  assert.deepEqual(ops.map((op) => op.value), [{ chat: { priority: 0 }, batch: { priority: 100, concurrency: 2, maxWaitMs: 60_000 }, archive: { priority: 300 } }, { priority: 0 }, { priority: 150 }], "the lanes the file never had go in whole, first, beside the lanes the page adds");
  // Taking x out again leaves it out of every op written, so it can be added once more.
  const back = setAt(both, ["scheduler", "lanes", "x"], null);
  const cut = knobOps(bare, start, back);
  assert.deepEqual(cut.map((op) => op.path), [["scheduler", "lanes"], ["scheduler", "lanes", "y"]]);
  assert.ok(cut.every((op) => (op.value as Record<string, unknown>).x === undefined), "a lane taken back leaves no entry anywhere");
  assert.deepEqual(Object.keys(cut[0]!.value as Record<string, unknown>), ["chat", "batch", "archive"]);
  // Taking both back is no edit at all.
  assert.deepEqual(knobOps(bare, start, setAt(back, ["scheduler", "lanes", "y"], null)), []);
  // A lane the file does write is removed by deleting its key, not by writing null over it.
  const own = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100, maxWaitMs: 60_000 } } } };
  const ownStart = seeded(own, view());
  assert.deepEqual(knobOps(own, ownStart, setAt(ownStart, ["scheduler", "lanes", "batch"], null)), [{ path: ["scheduler", "lanes", "batch"], delete: true }]);
}

// --- a lane the draft adds, with a field that was set and then cleared --------------------------
{
  // The page writes a cleared field as null. A lane the draft adds is a whole value of its own, so
  // the null sits inside it rather than beside it, and the node refuses a ceiling that is null.
  const noNulls = (ops: ReturnType<typeof knobOps>): void => {
    const walk = (v: unknown, where: string): void => {
      if (v === null) assert.fail(`a null at ${where}`);
      if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${where}.${k}`);
    };
    for (const op of ops) { assert.equal(op.delete, undefined, "an added lane is written, not deleted"); walk(op.value, op.path.join(".")); }
  };
  // A file that writes its own lanes.
  const own = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 } } } };
  const ownStart = seeded(own, view());
  for (const key of ["concurrency", "maxWaitMs"] as const) {
    const added = setAt(ownStart, ["scheduler", "lanes", "x", "priority"], 500);
    const set = setAt(added, ["scheduler", "lanes", "x", key], key === "concurrency" ? 2 : 60_000);
    const cleared = setAt(set, ["scheduler", "lanes", "x", key], null);
    const ops = knobOps(own, ownStart, cleared);
    noNulls(ops);
    assert.deepEqual(ops, [{ path: ["scheduler", "lanes", "x"], value: { priority: 500 } }], `an added lane with its ${key} cleared writes the priority alone`);
  }
  // A file that writes no lanes: the seeded block is beside the added lane, and neither carries a null.
  const bare = { version: 3, name: "n" };
  const bareStart = seeded(bare, view());
  for (const key of ["concurrency", "maxWaitMs"] as const) {
    const added = setAt(bareStart, ["scheduler", "lanes", "x", "priority"], 500);
    const cleared = setAt(setAt(added, ["scheduler", "lanes", "x", key], key === "concurrency" ? 2 : 60_000), ["scheduler", "lanes", "x", key], null);
    const ops = knobOps(bare, bareStart, cleared);
    noNulls(ops);
    assert.deepEqual(ops.map((op) => op.path), [["scheduler", "lanes"], ["scheduler", "lanes", "x"]], "the seeded block, then the lane added");
    assert.deepEqual(ops[1]!.value, { priority: 500 });
  }
  // A lane the draft adds with a ceiling kept is written with it, and still no null anywhere.
  const kept = setAt(setAt(ownStart, ["scheduler", "lanes", "x", "priority"], 500), ["scheduler", "lanes", "x", "concurrency"], 2);
  const keptOps = knobOps(own, ownStart, kept);
  noNulls(keptOps);
  assert.deepEqual(keptOps, [{ path: ["scheduler", "lanes", "x"], value: { priority: 500, concurrency: 2 } }]);
}

// --- what a row reads back out, and whether it was edited -------------------------------------
{
  const base = { version: 3, scheduler: { lanes: { chat: { priority: 0 } }, warmBonus: 40 } };
  assert.equal(valueAt(base, ["scheduler", "lanes", "chat", "priority"]), 0);
  assert.equal(valueAt(base, ["scheduler", "lanes", "gone", "priority"]), undefined, "a lane the doc does not have reads as nothing");
  assert.equal(valueAt({}, ["scheduler", "agePerSecond"]), undefined);
  // A row is edited when its own value moved, not when something beside it did.
  const draft = setAt(base, ["scheduler", "lanes", "chat", "concurrency"], 2);
  assert.equal(editedAt(base, draft, ["scheduler", "lanes", "chat", "concurrency"]), true);
  assert.equal(editedAt(base, draft, ["scheduler", "lanes", "chat", "priority"]), false, "one setting of a row does not edit its neighbours");
  assert.equal(editedAt(base, draft, ["scheduler", "warmBonus"]), false);
  // Clearing a value is an edit; so is a value the base never had.
  assert.equal(editedAt(base, setAt(base, ["scheduler", "warmBonus"], null), ["scheduler", "warmBonus"]), true);
  assert.equal(editedAt(base, setAt(base, ["scheduler", "lanes", "chat", "maxWaitMs"], 5000), ["scheduler", "lanes", "chat", "maxWaitMs"]), true);
  assert.equal(editedAt(base, base, ["scheduler", "lanes", "chat", "priority"]), false);
  // A field clears to null, and the file leaves a cleared key out: the two say the same thing.
  assert.equal(editedAt(base, setAt(base, ["scheduler", "lanes", "chat", "maxWaitMs"], null), ["scheduler", "lanes", "chat", "maxWaitMs"]), false,
    "clearing a key the file does not write is no edit");
  assert.equal(editedAt(setAt(base, ["scheduler", "lanes", "chat", "maxWaitMs"], null), base, ["scheduler", "lanes", "chat", "maxWaitMs"]), false,
    "and neither is a file that leaves it out beside a draft that clears it");
  // Clearing a number the file does set is an edit, and it is written: the ops delete the key.
  const set = setAt(base, ["scheduler", "warmBonus"], 40);
  const cleared = setAt(set, ["scheduler", "warmBonus"], null);
  assert.equal(editedAt(set, cleared, ["scheduler", "warmBonus"]), true, "clearing a key the file writes is an edit");
  // A whole lane is read the way its fields are: what the ops would not write marks no row.
  const lanePath = ["scheduler", "lanes", "chat"];
  assert.equal(editedAt(base, setAt(base, [...lanePath, "maxWaitMs"], null), lanePath), false, "a cleared field the file never set leaves the row unmarked");
  assert.equal(editedAt(base, setAt(base, [...lanePath, "priority"], 7), lanePath), true, "a changed field marks it");
  assert.equal(editedAt(base, setAt(base, lanePath, null), lanePath), true, "and so does taking the lane out");
  assert.equal(editedAt(base, setAt(base, ["scheduler", "lanes", "fresh", "priority"], 0), ["scheduler", "lanes", "fresh"]), true, "and adding one");
  assert.deepEqual(knobOps(set, set, cleared), [{ path: ["scheduler", "warmBonus"], delete: true }], "and it writes a delete");
  // A value as a field shows it survives the round trip the field makes of it.
  for (const n of [-10, 0, 0.5, 2, 100, -0.25]) assert.equal(Number(numberText(n)), n, `a field shows ${n} as something it reads back as ${n}`);
}

// --- a lane added or removed in the draft is a row while it is unsaved ------------------------------
{
  // The node's view has what runs now; the draft has what the page is about to write. A lane in the
  // draft that the node does not have yet is a row, or it could never be edited after it was added.
  const v = view();
  const rows = laneRows(v, []);
  const drafted = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100, concurrency: 2, maxWaitMs: 60_000 }, archive: { priority: 300 }, bulk: { priority: 0 } } } };
  const withBulk = draftLanes(rows, drafted);
  assert.deepEqual(withBulk.map((r) => r.name), ["chat", "bulk", "batch", "warm", "archive"], "the new lane sorts where its priority puts it");
  assert.deepEqual(withBulk.find((r) => r.name === "bulk"), { name: "bulk", priority: 0, running: 0, queued: 0, heldByKey: 0, inFile: true });
  // The live numbers a row already has are kept, and the file's priority replaces the seeded one.
  const busy = laneRows(v, [job("1", "batch", "running")]);
  assert.equal(draftLanes(busy, drafted).find((r) => r.name === "batch")!.running, 1, "what the queue is doing is not lost");
  assert.equal(draftLanes(laneRows(v, []), setAt(drafted, ["scheduler", "lanes", "batch", "priority"], -50)).find((r) => r.name === "batch")!.priority, -50, "an unsaved priority shows");
  // A lane taken out of the draft is gone, unless a job is in it, which says the node still runs it.
  const cut = draftLanes(rows, { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 } } } });
  assert.deepEqual(cut.map((r) => r.name), ["chat", "batch", "warm"], "warm is the node's own and stays");
  const held = draftLanes(laneRows(v, [job("1", "archive", "running")]), { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 } } } });
  assert.deepEqual([held.find((r) => r.name === "archive")!.inFile, held.find((r) => r.name === "archive")!.running], [false, 1], "a lane with jobs still runs, so its row stays");
  // A built-in lane keeps its mark, and the draft decides its place.
  assert.equal(draftLanes(rows, drafted).find((r) => r.name === "warm")!.builtIn, true);
  // A file that writes no lanes seeds every one of them, so nothing is added by drafting it.
  assert.deepEqual(draftLanes(rows, seeded({ version: 3 }, v)).map((r) => r.name), rows.map((r) => r.name));
  // Taking a lane out writes null where it was, and the row goes with it: that is why it is not simply absent.
  const cleared = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 }, archive: null } } };
  assert.deepEqual(draftLanes(rows, cleared).map((r) => r.name), ["chat", "batch", "warm"], "a lane cleared to null is gone");
  assert.deepEqual(draftLanes(rows, setAt(seeded({ version: 3 }, v), ["scheduler", "lanes", "chat"], null)).map((r) => r.name), ["batch", "warm", "archive"].filter((n) => n !== "chat"), "the same for one the seed wrote");
  // A row cleared to null is not a lane with no priority: it is a lane being taken out.
  assert.deepEqual(lanesWithoutPriority(cleared), [], "a cleared lane is not one waiting for a number");
  assert.deepEqual(lanesWithoutPriority({ scheduler: { lanes: { chat: { priority: null } } } }), ["chat"], "clearing a priority is");
  // A lane added and taken back is no edit at all: the null left behind would otherwise be written as a lane.
  const seededBase = seeded({ version: 3, scheduler: { lanes: { chat: { priority: 0 } } } }, v);
  const addedAgain = setAt(seededBase, ["scheduler", "lanes", "scratch", "priority"], 0);
  assert.deepEqual(knobOps({ version: 3, scheduler: { lanes: { chat: { priority: 0 } } } }, seededBase, setAt(addedAgain, ["scheduler", "lanes", "scratch"], null)), [], "what was never there is not written");
  // A lane a job is in stays even when it is cleared, because the node runs it until it drains.
  assert.deepEqual(draftLanes(laneRows(v, [job("1", "batch", "running")]), cleared).map((r) => r.name), ["chat", "batch", "warm"]);
  // With no draft the node's own lanes are the rows, idle ones included, and every one of them is in the file.
  const live = draftLanes(laneRows(v, [job("1", "chat", "running")]), null);
  assert.deepEqual(live.map((r) => r.name), ["chat", "batch", "warm", "archive"], "an idle lane is still a lane");
  assert.equal(live.every((r) => r.inFile), true, "and nothing the node runs is called missing");
  assert.equal(draftLanes(laneRows(v, [job("1", "gone", "running")]), null).find((r) => r.name === "gone")!.inFile, false, "a lane only a job is in still says so");
}

// --- a lane whose priority was cleared is named, because the file would refuse it ---------------------
{
  // A lane that never had a priority is a lane the parser runs at 0, not one waiting for a number.
  assert.deepEqual(lanesWithoutPriority({ scheduler: { lanes: { chat: { priority: 0 }, batch: { concurrency: 2 } } } }), [], "a lane with only a ceiling is legal");
  assert.deepEqual(lanesWithoutPriority({ scheduler: { lanes: { chat: { priority: -10 }, batch: { priority: 100 } } } }), [], "a negative priority is a number");
  assert.deepEqual(lanesWithoutPriority({ scheduler: { lanes: { chat: { priority: 0.5 } } } }), [], "and so is a decimal");
  assert.deepEqual(lanesWithoutPriority({ version: 3 }), [], "a file that writes no lanes has none to name");
  // Clearing a cleared field in the draft is what names it, so the page can hold the review back until it is a number.
  const base = { scheduler: { lanes: { chat: { priority: 0 } } } };
  assert.deepEqual(lanesWithoutPriority(setAt(base, ["scheduler", "lanes", "chat", "priority"], null)), ["chat"]);
  // `warm` is hearth's own lane and the page does not edit it, so a draft entry for it never holds a save back.
  assert.deepEqual(lanesWithoutPriority({ scheduler: { lanes: { chat: { priority: 0 }, warm: { priority: 200 } } } }), []);
  assert.deepEqual(lanesWithoutPriority({ scheduler: { lanes: { chat: { priority: 0 }, warm: null } } }), []);
}

// --- which lanes the page's menus offer, and how a row says a lane is none ------------------------
{
  const file = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 }, archive: { priority: 300 }, warm: { priority: 200 } } } };
  const start = seeded(file, view());
  // In priority order, with the node's own preload lane left out: nothing a person sends runs in it.
  assert.deepEqual(knobLanes(start), ["chat", "batch", "archive"]);
  // A lane the draft takes out is no longer offered.
  assert.deepEqual(knobLanes(setAt(start, ["scheduler", "lanes", "batch"], null)), ["chat", "archive"]);
  assert.deepEqual(knobLanes(setAt(start, ["scheduler", "lanes", "batch", "priority"], -5)), ["batch", "chat", "archive"], "a priority edited above follows into the menu's order");
  // A lane added but not saved is offered at once.
  assert.deepEqual(knobLanes(setAt(start, ["scheduler", "lanes", "voice", "priority"], 50)), ["chat", "voice", "batch", "archive"]);
  // A file that writes no lanes is seeded with the ones the node runs on, so they are what is offered.
  assert.deepEqual(knobLanes(seeded({ version: 3 }, view())), ["chat", "batch", "archive"]);
  // `warm` is offered only to the things that may hold it: the parser takes a model, a route or a hold
  // pinned to it, and a menu that left it out would report one as a lane that is not one.
  assert.deepEqual(knobLanes(start, { warm: true }), ["chat", "batch", "warm", "archive"], "a pin's menu offers warm, in its place");
  assert.deepEqual(knobLanes(setAt(start, ["scheduler", "lanes", "chat"], null), { warm: true }), ["batch", "warm", "archive"], "and a lane the draft took out is still gone");
  assert.deepEqual(strayLane("warm", knobLanes(start, { warm: true })), null, "a pin already on warm is one of the menu's own lanes");
  // The parser adds warm to a file that does not write it, so a menu cannot wait for the file to say so.
  const unwritten = { version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 }, archive: { priority: 300 } } }, models: { m: { lane: "warm" } } };
  assert.deepEqual(pinLanes(unwritten, "model"), ["chat", "batch", "warm", "archive"], "a model's menu has warm, in the place the parser gives it");
  assert.equal(strayLane("warm", pinLanes(unwritten, "model")), null, "so a model on it is on a lane");
  for (const kind of ["route", "rule", "when", "hold", "lending"] as const) assert.equal(pinLanes(unwritten, kind).includes("warm"), true, `a ${kind} may hold it`);
  assert.equal(pinLanes(unwritten, "key").includes("warm"), false, "a key may not");
  assert.equal(pinLanes(start, "key").includes("warm"), false, "not even in a file that writes it");
  // Only a model's lane, a key's lane and lending's lane offer none, which is written as null.
  const none = laneMenu(knobLanes(start), { canClear: true });
  assert.deepEqual(none.slice(0, 3), [{ lane: "chat", text: "chat", value: "chat" }, { lane: "batch", text: "batch", value: "batch" }, { lane: "archive", text: "archive", value: "archive" }]);
  assert.deepEqual(none.at(-1), { lane: null, text: "none", value: "" });
  // A hold's or a condition's list entry always holds a real lane, so its menu has no none.
  assert.equal(laneMenu(knobLanes(start)).some((o) => o.lane === null), false);
  // A condition may write its one lane as a bare string, which is a list of one of it.
  assert.deepEqual(laneText("batch"), { lane: "batch", text: "batch", value: "batch" });
  assert.deepEqual(laneText(["batch"]), { lane: "batch", text: "batch", value: "batch" });
  // Every lane a condition lists is in the words, so the row says which list it is one of.
  assert.deepEqual(laneText(["chat", "archive"]), { lane: null, text: "chat, archive", value: "" });
  assert.deepEqual(laneText(["chat", "archive"], "then acts").text, "then acts on chat, archive");
  assert.deepEqual(laneText(""), { lane: null, text: "—", value: "" });
  assert.deepEqual(laneText(undefined), { lane: null, text: "—", value: "" });
  // A value the menu offers is chosen with nothing written; one it does not keeps its own entry, so a row is not reset.
  assert.deepEqual(laneText(["chat", "batch"], undefined, ["chat", "batch"]), { lane: null, text: "chat, batch", value: "chat, batch" });
  assert.deepEqual(laneText(["chat", "batch"], undefined, ["chat"]), { lane: null, text: "chat, batch", value: "" });
  // The value is one lane, so the menu writes it back in place; a whole list is written as the entry it is.
  assert.deepEqual(laneText(["chat", "batch"], undefined, ["chat", "batch", "archive"]), { lane: null, text: "chat, batch", value: "" });
}

// --- a lane moved where a list holds it, given back as the shape it was written in ------------------
{
  // A condition of one lane is written as that lane, and reads back as a list of one.
  const one = { flows: { f: { steps: [{ when: { lane: ["chat"] }, to: "m" }] } } };
  assert.deepEqual(setAt(one, ["flows", "f", "steps", 0, "when", "lane"], "archive").flows, { f: { steps: [{ when: { lane: "archive" }, to: "m" }] } });
  // A list of several keeps its other entries where it is edited in place.
  assert.deepEqual(setAt(one, ["flows", "f", "steps", 0, "when", "lane", 0], "archive").flows, { f: { steps: [{ when: { lane: ["archive"] }, to: "m" }] } });
  const many = { flows: { f: { steps: [{ when: { lane: ["chat", "batch"] }, to: "m" }] } } };
  assert.deepEqual(setAt(many, ["flows", "f", "steps", 0, "when", "lane", 1], "archive").flows, { f: { steps: [{ when: { lane: ["chat", "archive"] }, to: "m" }] } });
  // A hold's lanes and a route's lane are each the shape the parser takes.
  const held = { backends: { b: { hold: { lanes: ["chat", "batch"], idleMs: 5000 } } } };
  assert.deepEqual(setAt(held, ["backends", "b", "hold", "lanes", 0], "archive").backends, { b: { hold: { lanes: ["archive", "batch"], idleMs: 5000 } } });
  const routed = { backends: { b: { routes: [{ path: "/a", model: "m", lane: "chat" }] } } };
  assert.deepEqual(setAt(routed, ["backends", "b", "routes", 0, "lane"], "archive").backends, { b: { routes: [{ path: "/a", model: "m", lane: "archive" }] } });
  // A lane a model, a key or lending's default is cleared to is no lane at all, so it leaves the file.
  const model = { models: { m: { backend: "b", lane: "chat" } } };
  assert.deepEqual(setAt(model, ["models", "m", "lane"], null), { models: { m: { backend: "b", lane: null } } });
  assert.deepEqual(knobOps(model, model, setAt(model, ["models", "m", "lane"], null)), [{ path: ["models", "m", "lane"], delete: true }]);
}

// --- the backends, each with the numbers it runs on -----------------------------------------------
{
  const file = {
    version: 3, name: "n",
    backendDefaults: { concurrency: 2 },
    resources: { gpu0: { kind: "gpu" }, cpu0: { kind: "cpu", shared: true } },
    backends: {
      b: { url: "http://127.0.0.1:1", kind: "none", serves: ["m"], concurrency: 3, resources: ["gpu0"], resident: true,
           activity: { path: "/status", running: "n" }, hold: { lanes: ["chat"], idleMs: 5000 } },
      c: { url: "http://127.0.0.1:2", kind: "none", serves: ["n"], resources: ["gpu0", "cpu0"] },
    },
    models: { m: { backend: "b", lane: "chat" }, n: { backend: "c" } },
    scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 } } },
  };
  const start = seeded(file, view());
  const rows = backendRows(start);
  const row = (name: string) => rows.find((r) => r.name === name)!;
  // A backend that sets its own count says so; the rest take the file's default, or the node's when it has none.
  assert.deepEqual(rows.map((r) => r.name), ["b", "c"]);
  assert.deepEqual([row("b").held, row("b").jobsPath, row("b").defaultsPath], [3, ["backends", "b", "concurrency"], ["backendDefaults", "concurrency"]]);
  assert.deepEqual([row("c").held, row("c").jobs], [null, 2], "a backend of its own takes the default, and the node says which");
  assert.deepEqual([row("b").resources, row("b").resident], [["gpu0"], true], "what it runs on is read, never edited");
  assert.deepEqual(row("c").resources, ["gpu0", "cpu0"]);
  // A backend holding no lanes has no hold to edit; the one that holds reads its lanes and its idle time.
  assert.deepEqual([row("c").holdPath, row("b").holdPath], [null, ["backends", "b", "hold"]]);
  assert.deepEqual([row("b").idleMs, row("b").idlePath], [5000, ["backends", "b", "hold", "idleMs"]]);
  // A count the draft holds at nothing is one nothing holds, so the backend takes whatever is above it.
  assert.deepEqual(backendRows(setAt(start, ["backends", "b", "concurrency"], null)).find((r) => r.name === "b")!.held, null);
  // The count is edited in the row, and the file's default in the card's own row.
  assert.deepEqual(knobOps(file, start, setAt(start, ["backends", "b", "concurrency"], 5)), [{ path: ["backends", "b", "concurrency"], value: 5 }]);
  assert.deepEqual(knobOps(file, start, setAt(start, ["backendDefaults", "concurrency"], 4)), [{ path: ["backendDefaults", "concurrency"], value: 4 }]);
  // A count cleared is a count the file no longer writes, so the backend takes the default again.
  assert.deepEqual(knobOps(file, start, setAt(start, ["backends", "b", "concurrency"], null)), [{ path: ["backends", "b", "concurrency"], delete: true }]);
  assert.deepEqual(knobOps(file, start, setAt(start, ["backendDefaults", "concurrency"], null)), [{ path: ["backendDefaults", "concurrency"], delete: true }]);
  // A hold's idle time is required where the hold is, and is edited where the file has one.
  assert.deepEqual(knobOps(file, start, setAt(start, ["backends", "b", "hold", "idleMs"], 10_000)), [{ path: ["backends", "b", "hold", "idleMs"], value: 10_000 }]);
  assert.equal(backendRows(setAt(start, ["backends", "c", "hold"], null)).find((r) => r.name === "c")!.holdPath, null, "a draft that holds nothing reads as no hold rather than a key to write");
}

// --- the models, and the filter box over them ----------------------------------------------------
{
  const file = {
    version: 3, name: "n",
    backends: { b: { url: "http://127.0.0.1:1", kind: "none", serves: ["mine", "Spare"] } },
    models: {
      mine: { backend: "b", lane: "chat", concurrency: 2, shareAfterMs: 3000, pool: { tokens: 144000, output: 8192 } },
      spare: { concurrency: 1, pool: 65536 },
      "long-model": {},
    },
    scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 } } },
  };
  const start = seeded(file, view());
  const rows = modelRows(start, "");
  const row = (id: string) => rows.find((r) => r.id === id)!;
  // Every id in `models:`, in the order the file writes them.
  assert.deepEqual(rows.map((r) => r.id), ["mine", "spare", "long-model"], "in the order the file writes them");
  assert.deepEqual(row("mine"), {
    id: "mine", jobs: 2, laneValue: "chat",
    shareMs: 3000, sharePath: ["models", "mine", "shareAfterMs"], pool: "map",
    // The shape the file wrote, and what the draft holds at `pool`: a save keeps the first and re-states the second.
    filePool: "map",
    poolValue: { tokens: 144_000, output: 8192 },
    tokens: 144_000, output: 8192, tokensPath: ["models", "mine", "pool", "tokens"], outputPath: ["models", "mine", "pool", "output"],
  });
  // A pool written as a bare number is its token budget, with nothing reserved for an answer, and its one
  // number is written where the parser takes it. A model with no pool has none to edit but a budget's.
  assert.deepEqual([row("spare").pool, row("spare").tokens, row("spare").tokensPath, row("spare").output, row("spare").shareMs], ["number", 65_536, ["models", "spare", "pool"], null, null]);
  assert.deepEqual([row("long-model").pool, row("long-model").tokens, row("long-model").tokensPath], ["none", null, ["models", "long-model", "pool"]]);
  // The filter is what a person types: any part of the id, in any case.
  assert.deepEqual(modelRows(start, "mi").map((r) => r.id), ["mine"]);
  assert.deepEqual(modelRows(start, "SPA").map((r) => r.id), ["spare"], "a capital in the box finds the id however either is written");
  assert.deepEqual(modelRows(start, " ").map((r) => r.id), rows.map((r) => r.id), "spaces only are not a filter");
  assert.deepEqual(modelRows(start, "nothing").map((r) => r.id), []);
  assert.equal(modelRows(setAt(start, ["models", "spare", "pool", "tokens"], 32_768), "").find((r) => r.id === "spare")!.tokens, 32_768, "an edited budget shows at once");
  // The three numbers are edited where the file keeps them, and a cleared answer's share is taken out.
  assert.deepEqual(knobOps(file, start, setAt(setAt(setAt(start, ["models", "mine", "concurrency"], 4), ["models", "mine", "pool", "output"], null), ["models", "mine", "shareAfterMs"], 1500)).map((op) => [op.path, op.value ?? op.delete]),
    [[["models", "mine", "concurrency"], 4], [["models", "mine", "shareAfterMs"], 1500], [["models", "mine", "pool", "output"], true]]);
}

// --- who waits on a lane, in the page's own order, with the words each kind of caller goes by ------
{
  const file = {
    version: 3, name: "n",
    apiKeys: [{ key: "one", label: "app", lane: "chat", limits: { maxConcurrent: 3 } }, { key: "two" }],
    peers: { p: { accept: "t", lend: { maxConcurrent: 4 } }, q: { url: "http://127.0.0.1:1", token: "t" } },
    lending: { maxConcurrent: 6 },
  };
  const rows = callerRows(file);
  // Keys first, then the peers, then the lending default that covers every peer.
  assert.deepEqual(rows.map((r) => `${r.caller.kind}:${r.caller.name}`), ["key:app", "key:unlabelled key 2", "peer:p", "peer:q", "lending:lending"]);
  // A key holds a lane of its own, and every peer's borrowed work lands in lending's.
  assert.deepEqual(rows.map((r) => r.words.lane), ["lane", "lane", "borrowed work's lane", "borrowed work's lane", "borrowed work's lane"]);
  assert.deepEqual(rows.map((r) => r.words.jobs), ["jobs at once", "jobs at once", "what it may run here", "what it may run here", "what every peer may run here"]);
  // A peer names no lane of its own, so its lane is read off lending and has no path to write.
  const peer = rows.find((r) => r.caller.name === "p")!.caller;
  assert.deepEqual([peer.lanePath, peer.lane], [null, null]);
}

// --- the lane a caller's cell shows, where the caller cannot pick one itself ------------------------
{
  // An unlabelled key is read-only here, so its cell says the lane the file gives it, not the word "lane".
  const unlabelled = callerRows({ apiKeys: [{ key: "two", lane: "batch" }] });
  assert.equal(unlabelled.find((r) => r.caller.name === "unlabelled key 1")!.laneText, "batch", "an unlabelled key shows the lane it is in");
  // A peer's borrowed work lands where lending sends it, so its cell is lending's lane.
  const borrowed = callerRows({ peers: { p: { accept: "t" } }, lending: { lane: "archive" } });
  assert.equal(borrowed.find((r) => r.caller.kind === "peer")!.laneText, "archive", "a peer shows lending's lane");
  // Lending with no lane of its own sends work to the node's own default, which is the lane it shows.
  const plain = callerRows({ peers: { p: { accept: "t" } } }, "batch");
  assert.equal(plain.find((r) => r.caller.kind === "peer")!.laneText, "batch", "no named lane is the node's default for it");
  assert.equal(plain.find((r) => r.caller.kind === "lending")!.laneText, "batch");
}

// --- the badges a lane row carries, one per default it is -----------------------------------------
{
  // A lane that takes two kinds of work says both, in one badge, rather than one badge per rule.
  const both = laneBadges("archive", defaults("chat", "archive", "archive"));
  assert.deepEqual(both, ["peers and unnamed routes"], "one lane that is two defaults carries one badge");
  // Lending names its own lane: then the lane that takes unnamed routes is a default of its own, and
  // the lane lending uses says only that.
  const split = defaults("chat", "chat", "batch");
  assert.deepEqual(laneBadges("chat", split), ["requests default", "borrowed peer work"]);
  assert.deepEqual(laneBadges("batch", split), ["unnamed routes"]);
  // The first lane is a default of its own, and says so beside whatever else it is.
  assert.deepEqual(laneBadges("chat", defaults("chat", "batch", "batch")), ["requests default"]);
  assert.deepEqual(laneBadges("chat", defaults("chat", "chat", "chat")), ["requests default", "peers and unnamed routes"], "a lane that is all three says all three");
  assert.deepEqual(laneBadges("batch", defaults("chat", "chat", "chat")), [], "a lane no rule picks carries nothing");
}

// --- the lane pins, grouped so each kind is said once --------------------------------------------
{
  const pins = pinsOf(doc());
  const groups = lanePinGroups(pins);
  // A row is said by its kind and its own pin, because a backend's routes and a flow's steps repeat their name.
  const words = (kind: string) => (name: string) => {
    const group = groups.find((g) => g.kind === kind)!;
    return group.words.what(name, group.pins.find((p) => p.name === name)!);
  };
  // A model is the model it is; a route and a hold are the backend's own, and apply only after a restart.
  assert.equal(words("model")("m"), "model m");
  assert.equal(words("route")("b"), "a route on backend b: /speak");
  assert.equal(words("hold")("b"), "a hold on backend b, lane 1");
  assert.equal(words("rule")("f"), "a rule step in flow f, step 2");
  assert.equal(words("key")("app"), "key app");
  assert.equal(words("lending")("lending"), "lending");
  // Every kind the page lists, in that order, and only the kinds the file has.
  assert.deepEqual(groups.map((g) => g.kind), ["model", "route", "rule", "hold", "key", "lending"]);
  assert.deepEqual(groups.filter((g) => g.restart).map((g) => g.kind), ["route", "hold"], "exactly the backend's own wait for a restart");
  // A condition that tests lanes is a group of its own, named for the rule it is in.
  const testing = pinsOf({ flows: { guard: { inputs: ["auto"], steps: [{ when: { lane: "batch" }, to: "m" }, { to: "m" }] } } });
  assert.deepEqual(lanePinGroups(testing).map((g) => g.kind), ["when"], "and lending has no lane to show until the file names one");
  assert.equal(lanePinGroups(testing)[0]!.pins[0]!.lane, "batch");
  assert.deepEqual(lanePinGroups(pinsOf({ version: 3 })), [], "a file that names no lane has no rows to group");
  // What a row reads is the draft's own entry, a list entry read where it sits.
  const draft = setAt(setAt(setAt(doc(), ["backends", "b", "hold", "lanes", 0], "archive"), ["models", "m", "lane"], "batch"), ["flows", "f", "steps", 1, "when", "lane"], "chat");
  const read = pinsOf(draft);
  assert.equal(pinValueAt(draft, read.find((p) => p.kind === "hold")!.path), "archive");
  assert.equal(pinValueAt(draft, read.find((p) => p.kind === "model")!.path), "batch");
  assert.deepEqual(pinValueAt(draft, read.find((p) => p.kind === "when")!.path), "chat", "a list of one is written back as the lane itself, which laneText reads as one lane");
  // A row is edited when its own path moved or was taken out, and not when a row beside it did.
  const moved = draft;
  assert.equal(editedIn(doc(), moved, [["models", "m", "lane"]]), true);
  assert.equal(editedIn(doc(), moved, [["backends", "b", "hold", "lanes", 0]]), true);
  assert.equal(editedIn(doc(), moved, [["apiKeys", 0, "lane"]]), false, "a key the draft left alone is not edited");
  assert.equal(editedIn(doc(), setAt(doc(), ["backends", "b", "hold", "lanes", 0], null), [["backends", "b", "hold", "lanes", 0]]), true, "a hold taken out is an edit");
}

// --- the pins a row is shown for, including one the draft has cleared to none ----------------------
{
  const base = doc();
  const all = pinRowsOf(base, base);
  // Nothing edited: every pin in the file is a row, once.
  assert.deepEqual(all.map((p) => p.path.join(".")), pinsOf(base).map((p) => p.path.join(".")), "each pin is a row");
  assert.equal(new Set(all.map((p) => p.path.join("."))).size, all.length, "and no row twice");
  // A cleared pin keeps its row, so it can be given a lane again, and it reads as the base's value.
  const cleared = setAt(setAt(base, ["models", "m", "lane"], null), ["apiKeys", 0, "lane"], null);
  const rows = pinRowsOf(cleared, base);
  const model = rows.find((p) => p.path.join(".") === "models.m.lane")!;
  assert.equal(model.lane, "chat", "a cleared pin still shows the lane the file has");
  assert.equal(rows.some((p) => p.path.join(".") === "apiKeys.0.lane"), true, "a cleared key's pin keeps its row");
  // A lane the draft took a pin away from altogether is still a row while it is unsaved.
  assert.equal(pinRowsOf(base, base).length, rows.length, "clearing one changes no count");
  // A pin the draft adds that the base does not have is a row too.
  const added = setAt(base, ["models", "fresh", "lane"], "batch");
  assert.equal(pinRowsOf(added, base).some((p) => p.path.join(".") === "models.fresh.lane"), true, "a pin the draft adds is a row");
}

// --- which lanes a lane menu may clear, and how a pool is written as one value --------------------
{
  // Only a model, a key and lending's default take no lane at all; a hold's lane and a condition's
  // never do, so their menus offer no none.
  assert.deepEqual(CLEARABLE.filter((k) => laneCanClear(k)), ["model", "key", "lending"]);
  assert.deepEqual(["route", "rule", "when", "hold"].filter((k) => laneCanClear(k as LanePin["kind"])), []);

  // A pool written as one value: the whole {tokens, output} at `pool` for a pool with no mapping to
  // write into, and the one number the file already keeps for a pool written as a bare number.
  // `pool` is what the draft holds at `models.<id>.pool`: the budget itself, the mapping, or nothing.
  // `pool` is the shape the file wrote and `held` what the draft holds; they are the same unless a draft is mid-edit.
  const poolPaths = (id: string, pool: PoolMode = "map", held?: unknown) => ({ id, pool, filePool: pool, held: held ?? (pool === "map" ? { tokens: 1000, output: 100 } : undefined), path: ["models", id, "pool"] as Path, tokensPath: ["models", id, "pool", "tokens"] as Path, outputPath: ["models", id, "pool", "output"] as Path });
  const bare = poolPaths("bare", "number", 65536), none = poolPaths("none", "none");

  assert.deepEqual(savePool(bare, []), [], "a pool written as one value is unchanged by no edits at all");
  // The budget the file already has is kept beside the answer's share the field sets.
  assert.deepEqual(savePool(bare, [{ path: bare.outputPath, value: 500, pool: bare.held }]), [{ path: ["models", "bare", "pool"], value: { tokens: 65536, output: 500 } }]);
  // A model with no pool has no budget to share an answer with, so a pool of an answer alone is never
  // written: the parser refuses a pool with no tokens. Nothing is written, and the field says nothing.
  assert.deepEqual(savePool(none, [{ path: none.outputPath, value: 500, pool: none.held }]), [], "a pool cannot be an answer's share alone");
  // Both fields of a pool written as one value go to the same place, and the budget set in the same
  // draft is kept beside the answer's share rather than the number the file had.
  assert.deepEqual(savePool(bare, [{ path: bare.tokensPath, value: 1000, pool: bare.held }, { path: bare.outputPath, value: 500, pool: bare.held }]),
    [{ path: ["models", "bare", "pool"], value: { tokens: 1000, output: 500 } }]);
  // The budget alone, on a pool written as one value, stays the one number the file takes.
  assert.deepEqual(savePool(bare, [{ path: bare.path, value: 1000, pool: bare.held }]), [{ path: ["models", "bare", "pool"], value: 1000 }]);
  // A pool the file wrote as a mapping stays a mapping, written where the number it changed is: the page
  // only writes keys it changed, so the other key and the comments on these lines survive.
  const map = poolPaths("m");
  assert.deepEqual(savePool(map, [{ path: map.tokensPath, value: 2000, pool: map.held }]), [{ path: ["models", "m", "pool", "tokens"], value: 2000 }]);
  assert.deepEqual(savePool(map, [{ path: map.tokensPath, value: null, pool: map.held }]), [{ path: ["models", "m", "pool"], delete: true }], "a pool with no budget cannot exist, so it goes whole");
  assert.deepEqual(savePool(map, [{ path: map.outputPath, value: 250, pool: map.held }]), [{ path: ["models", "m", "pool", "output"], value: 250 }]);
  assert.deepEqual(savePool(map, [{ path: map.outputPath, value: null, pool: map.held }]), [{ path: ["models", "m", "pool", "output"], delete: true }], "an answer's share cleared leaves the budget it sat in, and the block it is written in");
  // A mapping the file wrote with only a budget is still a mapping: a budget edit keeps its block.
  const tokensOnly = { ...poolPaths("tok"), held: { tokens: 1000 } };
  assert.deepEqual(savePool(tokensOnly, [{ path: tokensOnly.tokensPath, value: 5000, pool: tokensOnly.held }]), [{ path: ["models", "tok", "pool", "tokens"], value: 5000 }], "the shape follows the file, not the draft");
  // A net-zero edit writes nothing at all, whatever shape the pool has.
  assert.deepEqual(savePool(map, [{ path: map.outputPath, value: 100, pool: map.held }]), [], "a share set to what the file says is no edit");
  assert.deepEqual(savePool(tokensOnly, [{ path: tokensOnly.tokensPath, value: 1000, pool: tokensOnly.held }]), []);
  // An answer's share on a pool with no budget and none coming writes nothing: there is no pool to hold it.
  assert.deepEqual(savePool(poolPaths("x", "none"), [{ path: ["models", "x", "pool", "output"], value: 250, pool: undefined }]), []);
}

// --- clearing a pool, in every order the page can reach -------------------------------------------
{
  // The page's own route: a row hands setAt(path, null) and savePool's ops to the draft, and knobOps
  // turns the draft into what is written. `chain` follows that route for a list of field edits.
  const doc = { version: 3, models: { bare: { pool: 65536 }, fresh: { concurrency: 1 }, m: { pool: { tokens: 1000, output: 100 } }, tok: { pool: { tokens: 1000 } } } };
  // A row reads the draft for its numbers and the file for the shape its pool was written in, as the page does.
  const rowOf = (d: Doc, id: string): ModelRow => modelRows(d, id, doc)[0]!;
  // What the component's savePoolTo does to the draft: knobs.change is setAt, and a delete is written as null there.
  const step = (d: Doc, id: string, edits: PoolEdit[]): Doc =>
    savePool(rowOf(d, id), edits).reduce((out, op) => (op.delete === true ? setAt(out, op.path, null) : setAt(out, op.path, op.value)), d);
  // The budget field sends `r.tokensPath` itself, which is `pool` for a bare number and `pool.tokens` for a
  // mapping, so the helper uses that and not a path of its own making. The answer's field sends `pool.output`.
  const set = (d: Doc, id: string, field: "tokens" | "output", value: number | null): Doc => {
    const row = rowOf(d, id);
    const path: Path = field === "tokens" ? row.tokensPath : ["models", id, "pool", "output"];
    return step(d, id, [{ path, value, pool: row.poolValue }]);
  };

  // A bare pool cleared: the whole pool goes, written as a deletion so `dropCleared` keeps it.
  const clearedBare = set(doc, "bare", "tokens", null);
  assert.deepEqual(clearedBare.models, { ...doc.models, bare: { pool: null } }, "a cleared bare budget is written as null, never an empty object");
  assert.deepEqual(knobOps(doc, doc, clearedBare), [{ path: ["models", "bare", "pool"], delete: true }], "clearing a bare pool takes it out of the file");
  // And it is gone from the draft as a row reads it, so the answer's share is not offered under it.
  assert.equal(rowOf(clearedBare, "bare").pool, "none", "a pool taken out is no pool, not an empty mapping");
  assert.deepEqual(rowOf(clearedBare, "bare").outputPath === null ? [] : [rowOf(clearedBare, "bare").outputPath], [], "no answer's share is offered where there is no pool");

  // A bare pool cleared, then an answer's share set: nothing is written, because a pool of an answer
  // alone is a pool the parser refuses, and the budget it would sit in has been taken out.
  const bareThenOut = set(clearedBare, "bare", "output", 500);
  assert.deepEqual(knobOps(doc, doc, bareThenOut), [{ path: ["models", "bare", "pool"], delete: true }], "an answer's share set after the pool went writes nothing new");

  // A fresh model: budget set, cleared, then an answer's share. Each step is an edit on the last, which
  // is how a person types them, and no step may leave a pool with no budget in the draft.
  const fresh1 = set(doc, "fresh", "tokens", 2048);
  const fresh2 = set(fresh1, "fresh", "tokens", null);
  const fresh3 = set(fresh2, "fresh", "output", 500);
  assert.deepEqual(rowOf(fresh1, "fresh").pool, "number", "a budget set on no pool is the one number the file takes");
  assert.deepEqual(rowOf(fresh2, "fresh").pool, "none", "clearing it puts the pool back to none");
  assert.deepEqual(knobOps(doc, doc, fresh3), [], "a fresh pool set, cleared and given an answer's share writes nothing at all");

  // The last key in a block: an answer's share cleared on a pool the file wrote as a mapping stays a
  // mapping, so the share goes by its own path and the budget and its block are left alone.
  const lastKey = set(doc, "m", "output", null);
  assert.deepEqual(knobOps(doc, doc, lastKey), [{ path: ["models", "m", "pool", "output"], delete: true }]);
  assert.equal(rowOf(lastKey, "m").pool, "map", "the shape the file wrote is the shape the draft keeps");
  // Clearing that budget then takes the whole pool out.
  const both = set(lastKey, "m", "tokens", null);
  assert.deepEqual(knobOps(doc, doc, both), [{ path: ["models", "m", "pool"], delete: true }]);
  // A share cleared on a two-key mapping keeps the budget, and writes a delete at the share's own path.
  const twoKey = set(doc, "m", "output", null);
  // The page writes a deletion as the null `knobs.change` sets, and `knobOps` turns it back into a delete.
  assert.deepEqual((twoKey.models as Doc).m, { pool: { tokens: 1000, output: null } }, "the budget is still in the draft");
  assert.deepEqual(knobOps(doc, doc, twoKey), [{ path: ["models", "m", "pool", "output"], delete: true }], "only the share is written, so the tokens line and its comment are left as they are");
  // A budget edit on a tokens-only mapping writes that one number: the block the file wrote stays a block.
  const tokOnly = set(doc, "tok", "tokens", 5000);
  assert.deepEqual(knobOps(doc, doc, tokOnly), [{ path: ["models", "tok", "pool", "tokens"], value: 5000 }]);
  assert.equal(rowOf(tokOnly, "tok").pool, "map", "a flow form's block stays a block when its number is edited");
  // A net-zero edit writes nothing, however the pool is shaped: a share set to what the file says, and a
  // share set then cleared, both leave the file's value alone and so report no change at all.
  const netZeroShare = set(doc, "tok", "output", 50);
  const clearedAgain = set(netZeroShare, "tok", "output", null);
  // The draft holds the null `knobs.change` wrote for the deletion; `knobOps` drops it, so the page counts nothing.
  assert.deepEqual(knobOps(doc, doc, clearedAgain), [], "set then cleared is no edit, and the page counts none");
  assert.deepEqual(rowOf(clearedAgain, "tok").tokens, 1000, "the budget the file has is what the row reads");
  const sameBudget = set(doc, "tok", "tokens", 1000);
  assert.deepEqual(knobOps(doc, doc, sameBudget), [], "a budget set to the number the file has is no edit");
  assert.deepEqual(knobOps(doc, doc, set(doc, "m", "tokens", 1000)), [], "the same on a two-key mapping");
  // A bare pool in the file stays bare unless a share is set: bare to mapping and back to bare within one
  // draft shows the file's own shape again, so it writes nothing.
  const toMap = set(doc, "bare", "output", 500);
  assert.equal(rowOf(toMap, "bare").pool, "map", "a bare pool becomes a mapping once it has a share");
  const backToBare = set(toMap, "bare", "output", null);
  assert.deepEqual(knobOps(doc, doc, backToBare), [], "a bare pool given a share and cleared again is the file's own value");
  assert.equal(rowOf(backToBare, "bare").pool, "number", "and the draft is the bare number the file wrote");
  assert.deepEqual(knobOps(doc, doc, toMap), [{ path: ["models", "bare", "pool"], value: { tokens: 65536, output: 500 } }], "the one time a bare pool is written whole is when it gains a share");

  // A budget keeps its answer's share: clearing that share leaves the bare budget, and setting it again
  // puts the mapping back with the budget beside it. The row is read back off the draft between edits,
  // as the component reads it: what the draft holds then decides which shape the next write takes.
  assert.equal(rowOf(lastKey, "m").tokens, 1000);
  const shareBack = set(lastKey, "m", "output", 250);
  // The draft holds the mapping again. The page's own diff writes a bare number replaced by a mapping as
  // the leaf it has to set, because the two are not both objects: the budget the draft already holds
  // stays in the file, and the node accepts the pair — the real-node case below proves it.
  assert.deepEqual((shareBack.models as Doc).m, { pool: { tokens: 1000, output: 250 } });
  assert.deepEqual(knobOps(doc, doc, shareBack), [{ path: ["models", "m", "pool", "output"], value: 250 }]);

  // Every draft any of those orders reaches writes nothing when nothing more is edited, which a field
  // left alone must always be true of.
  for (const d of [doc, clearedBare, bareThenOut, fresh1, fresh2, fresh3, lastKey, both]) {
    for (const id of Object.keys(d.models as Doc)) {
      const saved = savePool(rowOf(d, id), []);
      assert.deepEqual(saved, [], `${id} alone writes nothing`);
    }
  }
}

// --- which models a filter hides, by id and not by reference -------------------------------------
{
  const draft = { models: { mine: { pool: 1000 }, spare: {}, other: {} } };
  // Two calls make two lists of rows, so the ids are what is compared: every model the filter keeps is
  // the same model, however the row object was made.
  assert.deepEqual(hiddenModels(modelRows(draft, ""), modelRows(draft, "")), [], "nothing is hidden by an empty filter");
  assert.deepEqual(hiddenModels(modelRows(draft, "mi"), modelRows(draft, "")), ["spare", "other"]);
  assert.deepEqual(hiddenModels(modelRows(draft, "zzz"), modelRows(draft, "")), ["mine", "spare", "other"]);
}

// --- a lane a menu must offer as itself, and one it must not invent -------------------------------
{
  // A key or lending that names no lane holds nothing: there is no lane to show as its own.
  assert.equal(strayLane(undefined, ["chat", "batch"]), null);
  assert.equal(strayLane(null, ["chat", "batch"]), null);
  assert.equal(strayLane("", ["chat", "batch"]), null);
  // A lane the draft no longer has is still what the file says, and must stay offered rather than be
  // silently replaced by the first lane in the menu.
  assert.equal(strayLane("gone", ["chat", "batch"]), "gone");
  assert.equal(strayLane("chat", ["chat", "batch"]), null);
}

// --- which of the parser's three lane defaults wait for a restart ---------------------------------
{
  const live = LANE_DEFAULT_WORDS.filter((d) => !d.restart).map((d) => d.key);
  const restart = LANE_DEFAULT_WORDS.filter((d) => d.restart).map((d) => d.key);
  assert.deepEqual(live, ["first", "peers"], "a request's lane and borrowed work's follow the file at once");
  assert.deepEqual(restart, ["routes"], "a route's lane is built at boot, so it waits for a restart");
  assert.deepEqual(LANE_DEFAULT_WORDS.map((d) => d.key), ["first", "peers", "routes"], "in the order the parser decides them");
  // What a default holds when the file writes none of its own is the node's own fallback, never a number
  // read back out of the file: a cleared default runs on `fields.ts`, and the page must say the same.
  const fromFields = (FIELDS.backendDefaults.concurrency as { def?: unknown }).def;
  assert.equal(typeof fromFields, "number", "fields.ts states the default as a number");
  // What emptying the default field runs is fields.ts's own default, and it does not follow the file:
  // a file that still sets 4 answers "the node runs 4" no more than one that has had it cleared.
  assert.equal(defaultJobs(), fromFields);
  // A page that passed the draft in and read the file back would answer 4 here; the call takes nothing
  // to answer from, so a file default cannot reach it.
  // The call takes nothing to answer from, so no file default can reach it: a signature that took the
  // draft would let it report the very number the field is about to take away.
  assert.equal(defaultJobs.length, 0, "what emptying the field runs is not read from the draft");
  // What a backend with no count of its own takes is the file's default, or the node's when the file writes none.
  assert.equal(backendRows({ backends: { b: {} } })[0]!.jobs, fromFields, "a backend of its own takes the node's default");
  assert.equal(backendRows({ backendDefaults: { concurrency: null }, backends: { b: {} } })[0]!.jobs, fromFields, "a cleared default is the node's again");
  assert.equal(backendRows({ backendDefaults: { concurrency: 4 }, backends: { b: {} } })[0]!.jobs, 4);
}

// --- a lane pin said well enough to tell it from the next one ------------------------------------
{
  const pins = pinsOf({
    backends: {
      b: { routes: [{ path: "/one", model: "m", lane: "chat" }, { path: "/two", model: "m", lane: "chat" }], hold: { lanes: ["chat", "chat"], idleMs: 5000 } },
      c: { routes: [{ path: "/one", model: "m", lane: "chat" }] },
    },
    models: { m: { lane: "chat" } },
    flows: { multi: { inputs: ["auto"], steps: [{ to: "m" }, { to: "m", lane: "chat" }, { to: "m", lane: "chat" }] },
             guard: { inputs: ["auto"], steps: [{ when: { lane: "chat", laneNot: ["batch"] }, to: "m" }] } },
    routers: { r: { flows: { multi: { inputs: ["auto"], steps: [{ to: "m", lane: "chat" }] } } } },
    apiKeys: [{ key: "k", label: "app", lane: "chat" }],
    lending: { lane: "chat" },
  });
  const words = (p: LanePin) => PIN_WORDS[p.kind](p.name, p);
  // No two pins are said the same, which is what a row is chosen by and a screen reader reads.
  const said = pins.map(words);
  assert.equal(new Set(said).size, said.length, `every pin is told apart: ${said.join(" | ")}`);
  // A flow's second and third step are not its first, and a router's flow of the same name is not the
  // file's own flow.
  const routes = pins.filter((p) => p.kind === "route");
  assert.deepEqual(routes.map(words), ["a route on backend b: /one", "a route on backend b: /two", "a route on backend c: /one"]);
  // A hold's list holds two lanes at different positions.
  assert.deepEqual(pins.filter((p) => p.kind === "hold").map(words), ["a hold on backend b, lane 1", "a hold on backend b, lane 2"]);
  // A step is numbered from one, and a router's step says which router it is in.
  assert.deepEqual(pins.filter((p) => p.kind === "rule").map(words), ["a rule step in flow multi, step 2", "a rule step in flow multi, step 3", "a rule step in router r, flow multi, step 1"]);
  // A condition that keeps a lane and one that keeps a lane out read differently.
  const whens = pins.filter((p) => p.kind === "when").map(words);
  assert.deepEqual(whens, ["a rule step in flow guard, step 1: lane is chat", "a rule step in flow guard, step 1: lane is not batch"]);
  // The row's key is its path, so two pins with the same words still make two rows.
  assert.equal(new Set(pins.map((p) => p.path.join("."))).size, pins.length);
}

// --- the sections' own edits, saved by a real node ----------------------------------------------
{
  // A file with one of each thing the four sections edit. Every write below goes through setAt and
  // knobOps exactly as a row's handler makes it, and the result is written into a temp file and
  // loaded by the node's own parser, because only that says whether the file the page would write loads.
  const base = {
    version: 3, name: "page-writes",
    backendDefaults: { concurrency: 2 },
    resources: { gpu0: { kind: "gpu" }, cpu0: { kind: "cpu", shared: true } },
    backends: {
      b: { url: "http://127.0.0.1:1", kind: "none", serves: ["mine", "fresh"], concurrency: 3, resources: ["gpu0"],
           activity: { path: "/status", running: "n" }, hold: { lanes: ["batch"], idleMs: 5000 }, routes: [{ path: "/speak", model: "mine", lane: "batch" }] },
      c: { url: "http://127.0.0.1:2", kind: "none", serves: ["spare"], resources: ["gpu0", "cpu0"] },
    },
    models: {
      mine: { backend: "b", lane: "chat", concurrency: 2, shareAfterMs: 3000, pool: { tokens: 144000, output: 8192 } },
      spare: { concurrency: 1, pool: 65536 },
      // No pool at all: the knot a new one is tied for.
      fresh: { concurrency: 1 },
    },
    flows: {
      f: { inputs: ["spare"], steps: [{ when: { lane: ["chat", "batch"] }, to: "mine" }, { to: "mine", lane: "chat" }] },
      rest: { inputs: ["*"], steps: [{ to: { asked: true } }] },
    },
    apiKeys: [{ key: "secret-one", label: "app", lane: "chat", limits: { maxConcurrent: 3 } }],
    lending: { lane: "chat", models: ["mine"] },
    scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 }, archive: { priority: 300 } } },
  };
  const dir = mkdtempSync(join(tmpdir(), "hearth-knobs-"));
  const path = join(dir, "hearth.yaml");
  writeFileSync(path, JSON.stringify(base), "utf8");
  const node = createNode(loadConfig(path), silentLogger);
  node.start();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  // The one key the file declares, as the bearer every read and write here presents.
  const head = { Authorization: "Bearer secret-one", "Content-Type": "application/json" };
  const ask = async (method: string, body?: unknown): Promise<{ status: number; reply: Record<string, any> }> => {
    const r = await fetch(`${url}/config`, { method, headers: head, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, reply: (await r.json()) as Record<string, any> };
  };
  const file = async (): Promise<Record<string, any>> => (await ask("GET")).reply;
  let hash = (await file()).hash as string;
  // Each save edits the draft exactly as a row's handler does, builds the ops the review would send,
  // and writes them with the file's own hash, so the node refuses anything its parser will not load.
  // `draftOf` is for a row whose handler does more than one `setAt`, such as a pool's.
  const save = async (label: string, edits: [Path, unknown][], expect: (doc: Record<string, any>) => void, draftOf?: (doc: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
    const before = await file();
    let drafted: Record<string, unknown> = draftOf === undefined ? (before.doc as Record<string, unknown>) : draftOf(before.doc as Record<string, unknown>);
    // Only the plain edits go on top; a row that builds its own draft has already made all of them.
    for (const [path, value] of draftOf === undefined ? edits : []) drafted = setAt(drafted, path, value);
    const ops = knobOps(before.doc as Record<string, unknown>, before.doc as Record<string, unknown>, drafted);
    const dry = await ask("PATCH", { baseHash: hash, ops, dryRun: true });
    assert.deepEqual([dry.status, dry.reply.error], [200, null], `${label}: the dry run accepts it`);
    const written = await ask("PATCH", { baseHash: hash, ops });
    assert.equal(written.status, 200, `${label}: the node writes it (${JSON.stringify(written.reply)})`);
    const after = await file();
    hash = after.hash;
    expect(after.doc as Record<string, any>);
  };

  // Backends: a count of its own, the default, a hold's idle time.
  await save("a backend's jobs at once", [[["backends", "b", "concurrency"], 5]], (d) => assert.equal(d.backends.b.concurrency, 5));
  await save("the default", [[["backendDefaults", "concurrency"], 4]], (d) => assert.equal(d.backendDefaults.concurrency, 4));
  await save("a hold's idle time", [[["backends", "b", "hold", "idleMs"], 9000]], (d) => assert.equal(d.backends.b.hold.idleMs, 9000));
  // A count cleared is a count the file no longer writes.
  await save("a cleared count", [[["backends", "b", "concurrency"], null]], (d) => assert.equal(d.backends.b.concurrency, undefined));

  // Models: the four numbers and the lane, and the lane cleared.
  await save("a model's numbers", [
    [["models", "mine", "concurrency"], 4],
    [["models", "mine", "shareAfterMs"], 1500],
    [["models", "mine", "pool", "tokens"], 65_536],
    [["models", "mine", "pool", "output"], null],
  ], (d) => assert.deepEqual([d.models.mine.concurrency, d.models.mine.shareAfterMs, d.models.mine.pool], [4, 1500, { tokens: 65_536 }], "a cleared answer's share is taken out of the file"));
  // A bare number is the whole pool, so it is edited as that number: writing the mapping over it would
  // need a budget the row does not have, and the parser refuses a pool of zero tokens.
  await save("a bare token budget", [[["models", "spare", "pool"], 32_768]], (d) => assert.equal(d.models.spare.pool, 32_768));
  const bareBudget = (await file()).doc.models.spare.pool as number;
  assert.equal(bareBudget, 32_768, "the bare pool is still the one number the save above left it as");
  // An answer's share on a pool written as a bare number: the row writes the whole pool, so the budget
  // the file had is kept beside it rather than replaced by a mapping of one number.
  // A row hands savePool's ops to the page's own `change`, which writes with setAt: a deletion is the
  // null `knobs.change` writes, and `knobOps` turns it back into a delete for the node.
  const poolEdit = (id: string, edits: (row: ModelRow) => PoolEdit[]): ((d: Record<string, unknown>) => Record<string, unknown>) => (d) => {
    let out: Record<string, unknown> = d;
    for (const op of savePool(modelRows(out, id)[0]!, edits(modelRows(out, id)[0]!))) {
      out = op.delete === true ? (setAt(out, op.path, null) as Record<string, unknown>) : (setAt(out, op.path, op.value) as Record<string, unknown>);
    }
    return out;
  };
  // The budget is whatever the file holds at this point in the run, which the row carries.
  await save("an answer's share on a bare pool", [], (d) => assert.deepEqual(d.models.spare.pool, { tokens: bareBudget, output: 4096 }),
    poolEdit("spare", (row) => [{ path: ["models", "spare", "pool", "output"], value: 4096, pool: row.poolValue }]));
  // The same for a model with no pool at all: an answer's share makes one, and the budget set beside it
  // in the same draft stays beside it.
  await save("an answer's share on a new pool", [], (d) => assert.deepEqual(d.models.fresh.pool, { tokens: 2048, output: 512 }),
    poolEdit("fresh", (row) => [
      { path: ["models", "fresh", "pool"], value: 2048, pool: row.poolValue },
      { path: ["models", "fresh", "pool", "output"], value: 512, pool: row.poolValue },
    ]));
  // A mapping whose answer's share is cleared keeps its budget and its block: only the share is written.
  await save("a share cleared from a budget", [], (d) => assert.deepEqual(d.models.mine.pool, { tokens: 65_536 }),
    poolEdit("mine", (row) => [{ path: ["models", "mine", "pool", "output"], value: null, pool: row.poolValue }]));
  // A mapping's budget cleared takes the whole pool out, which is the one shape the parser takes for it.
  await save("a mapping's budget cleared", [], (d) => assert.equal(d.models.mine.pool, undefined),
    poolEdit("mine", (row) => [{ path: ["models", "mine", "pool", "tokens"], value: null, pool: row.poolValue }]));
  // Clearing a bare pool takes the whole pool out, and the file is left with none rather than the 65536 it had.
  await save("a bare pool's budget cleared", [], (d) => assert.equal(d.models.spare.pool, undefined),
    poolEdit("spare", (row) => [{ path: ["models", "spare", "pool"], value: null, pool: row.poolValue }]));
  // An answer's share on a pool that is no longer there writes nothing, so no save of one alone is ever offered.
  await save("an answer's share where no pool is left", [], (d) => assert.equal(d.models.spare.pool, undefined),
    (doc) => poolEdit("spare", (row) => [{ path: ["models", "spare", "pool", "output"], value: 500, pool: row.poolValue }])(doc));
  // A fresh pool: a budget set, saved, cleared, and then given an answer's share. Each step is its own
  // save, as a person's keystrokes are, and every one of them is a file the parser takes. Where the budget
  // went, the share has no home, so the last step leaves the file without a pool rather than with one it refuses.
  // `fresh` holds a mapping by now, so a budget set on it keeps the share beside it; the sequence that
  // starts from nothing is the unit case above and the save below, which clears back to no pool first.
  await save("a budget set on a pool that has a share", [], (d) => assert.deepEqual(d.models.fresh.pool, { tokens: 2048, output: 512 }),
    poolEdit("fresh", (row) => [{ path: row.tokensPath, value: 2048, pool: row.poolValue }]));
  await save("…its budget cleared again", [], (d) => assert.equal(d.models.fresh.pool, undefined),
    poolEdit("fresh", (row) => [{ path: row.tokensPath, value: null, pool: row.poolValue }]));
  // The share has no budget to sit beside, so savePool writes nothing: the file keeps exactly what it had,
  // which is what asserting "no pool" alone could not tell from a write that silently did nothing.
  const beforeShare = (await file()).doc.models.fresh;
  await save("…and then given an answer's share", [], (d) => assert.deepEqual(d.models.fresh, beforeShare, "the file is untouched by a share with no budget to hold it"),
    poolEdit("fresh", (row) => [{ path: ["models", "fresh", "pool", "output"], value: 500, pool: row.poolValue }]));

  // Callers: a key's lane and jobs at once, lending's lane and jobs at once, a peer's jobs at once.
  await save("a key's lane and jobs", [[["apiKeys", 0, "lane"], "batch"], [["apiKeys", 0, "limits", "maxConcurrent"], 2]], (d) => {
    assert.deepEqual([d.apiKeys[0].lane, d.apiKeys[0].limits.maxConcurrent, d.apiKeys[0].label], ["batch", 2, "app"], "the rest of the key is kept");
  });
  await save("lending's lane and jobs", [[["lending", "lane"], "batch"], [["lending", "maxConcurrent"], 3]], (d) => assert.deepEqual([d.lending.lane, d.lending.maxConcurrent, d.lending.models], ["batch", 3, ["mine"]], "the rest of lending is kept"));

  // Lane pins: a model's lane, a key's lane, lending's, a route's, a hold's, a rule's and a condition's.
  await save("a model's lane", [[["models", "mine", "lane"], "archive"]], (d) => assert.equal(d.models.mine.lane, "archive"));
  await save("a model's lane cleared", [[["models", "mine", "lane"], null]], (d) => assert.equal(d.models.mine.lane, undefined));
  await save("a key's lane cleared", [[["apiKeys", 0, "lane"], null]], (d) => assert.equal(d.apiKeys[0].lane, undefined));
  await save("a route's lane", [[["backends", "b", "routes", 0, "lane"], "archive"]], (d) => assert.equal(d.backends.b.routes[0].lane, "archive"));
  await save("a hold's lane", [[["backends", "b", "hold", "lanes", 0], "chat"]], (d) => assert.deepEqual(d.backends.b.hold.lanes, ["chat"]));
  await save("a rule step's lane", [[["flows", "f", "steps", 1, "lane"], "batch"]], (d) => assert.equal(d.flows.f.steps[1].lane, "batch"));
  await save("a condition's lane", [[["flows", "f", "steps", 0, "when", "lane", 0], "archive"]], (d) => assert.deepEqual(d.flows.f.steps[0].when.lane, ["archive", "batch"]));
  // A condition that lists one lane is written as that lane, and the parser reads it back as a list of one.
  await save("a condition narrowed to one", [
    [["flows", "f", "steps", 0, "when", "lane", 1], "archive"],
    [["flows", "f", "steps", 0, "when", "lane", 0], null],
  ], (d) => assert.deepEqual(d.flows.f.steps[0].when.lane, ["archive"], "a list is kept as a list, minus the entry taken out"));
  // A default lane added at the end, as the Lanes section adds one, then pointed at from a model.
  await save("a lane added here", [[["scheduler", "lanes", "voice", "priority"], 400]], (d) => assert.deepEqual(d.scheduler.lanes.voice, { priority: 400 }));
  await save("a lane added now named", [[["models", "spare", "lane"], "voice"]], (d) => assert.equal(d.models.spare.lane, "voice"));

  await node.close();
}

// --- a pool edit leaves the lines it did not change, and their comments, as they were ---------------
{
  // The page only writes the keys it changed, so a share cleared on a block mapping must write the share
  // and not the block: a leaf op, checked here against a real node that keeps YAML comments.
  const yaml = `version: 3
name: writes
backends:
  b: {url: "http://127.0.0.1:1", kind: none, serves: [map, tok]}
models:
  map:
    pool:
      tokens: 1000 # the budget
      output: 100
  tok:
    pool: {tokens: 1000} # a note
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: secret-one, label: app}
`;
  const dir = mkdtempSync(join(tmpdir(), "hearth-shape-"));
  const path = join(dir, "hearth.yaml");
  writeFileSync(path, yaml, "utf8");
  const node = createNode(loadConfig(path), silentLogger);
  node.start();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const head = { Authorization: "Bearer secret-one", "Content-Type": "application/json" };
  const ask = async (method: string, body?: unknown): Promise<{ status: number; reply: Record<string, any> }> => {
    const r = await fetch(`${url}/config`, { method, headers: head, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, reply: (await r.json()) as Record<string, any> };
  };
  // Each edit is what the row's own `savePool` makes from the file's pool, sent the way the review sends it.
  const write = async (id: string, edit: (row: ModelRow) => PoolEdit[]): Promise<void> => {
    const before = await ask("GET");
    const row = modelRows(before.reply.doc, id)[0]!;
    const ops = savePool(row, edit(row));
    const dry = await ask("PATCH", { baseHash: before.reply.hash, ops, dryRun: true });
    assert.equal(dry.status, 200, `${id}: the dry run accepts ${JSON.stringify(ops)}`);
    const written = await ask("PATCH", { baseHash: before.reply.hash, ops });
    assert.equal(written.status, 200, `${id}: the node writes ${JSON.stringify(ops)}`);
  };

  // A share cleared on a two-key mapping: the budget's line and its comment stay.
  await write("map", (row) => [{ path: ["models", "map", "pool", "output"], value: null, pool: row.poolValue }]);
  let text = readFileSync(path, "utf8");
  assert.ok(text.includes("tokens: 1000 # the budget"), `the budget and its comment survive a share clear:\n${text}`);
  assert.ok(!text.includes("output: 100"), "the share itself is gone");
  // A budget edited on a flow-form mapping: the flow form and its comment stay.
  await write("tok", (row) => [{ path: row.tokensPath, value: 5000, pool: row.poolValue }]);
  text = readFileSync(path, "utf8");
  assert.ok(text.includes("pool: {tokens: 5000} # a note"), `a flow form and its comment survive a budget edit:\n${text}`);
  // A net-zero edit is written as nothing, so the file does not move at all.
  const settled = readFileSync(path, "utf8");
  const before = await ask("GET");
  const row = modelRows(before.reply.doc, "tok")[0]!;
  assert.deepEqual(savePool(row, [{ path: row.tokensPath, value: 5000, pool: row.poolValue }]), [], "the budget set to the number the file has writes nothing");
  assert.equal(readFileSync(path, "utf8"), settled, "and nothing is rewritten");
  await node.close();
}

console.log("knobs.test.ts ok");
