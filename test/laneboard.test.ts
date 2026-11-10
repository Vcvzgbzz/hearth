/**
 * The Scheduler page's lane board: the tracks each lane draws, where its ceiling sits, what its row
 * says, the order settings' chips, and the save strip's words. Pure functions over the frame and the
 * draft, so this runs without a browser.
 *
 *     npx tsx test/laneboard.test.ts
 */
import assert from "node:assert/strict";

import { boardOrder, boardSlots, changeWords, knobOps, laneCeilings, lanePosition, laneStatus, laneTags, laneTracks, orderChip, pinsOf, seeded, setAt, slotSummary, type Doc } from "../src/console/knobs.js";
import type { Job, SchedulerView } from "../src/observe/uidata.js";

const job = (id: string, lane: string, state: Job["state"], extra: Partial<Job> = {}): Job =>
  ({ id, lane, model: "m", caller: "app", state, position: 0, since: 0, backend: "gpu0", ...extra });
const backends = [{ name: "gpu0", slots: 4 }, { name: "gpu1", slots: 2 }];
const view: SchedulerView = {
  lanes: [{ name: "chat", priority: 0 }, { name: "batch", priority: 100, ceiling: 2 }, { name: "warm", priority: 50, builtIn: true }],
  order: { agePerSecond: 1, warmBonus: 40, maxPerLane: 100, maxPerCaller: 0 },
  defaults: { first: "chat", peers: "batch", routes: "batch" },
};

// --- one track per backend the lane has jobs on, each as wide as that backend ---------------------
{
  const jobs = [
    job("1", "batch", "running"), job("2", "batch", "running"), job("3", "batch", "queued", { why: "lane", position: 0 }),
    job("4", "batch", "running", { backend: "gpu1" }), job("5", "batch", "queued", { backend: "gpu1", held: "key" }),
    job("6", "chat", "running"), job("7", "batch", "running", { offbox: true, peer: "p", backend: undefined }),
  ];
  assert.deepEqual(laneTracks("batch", jobs, backends), [
    { backend: "gpu0", slots: 4, running: 2, waiting: 1, held: 0 },
    { backend: "gpu1", slots: 2, running: 1, waiting: 0, held: 1 },
  ], "a track per backend, in the frame's order, and off-box work on none of them");
  assert.deepEqual(laneTracks("chat", jobs, backends), [{ backend: "gpu0", slots: 4, running: 1, waiting: 0, held: 0 }], "a lane on one backend has one track");
  // An idle lane is one empty track on the widest backend, so its ceiling still has somewhere to sit.
  assert.deepEqual(laneTracks("spare", jobs, [{ name: "small", slots: 1 }, { name: "big", slots: 8 }]), [{ backend: "big", slots: 8, running: 0, waiting: 0, held: 0 }]);
  assert.deepEqual(laneTracks("spare", [], []), [], "a node with no backend draws no track");
  // A node may run past its count; the track grows with it rather than drawing a job nowhere.
  assert.equal(laneTracks("chat", [job("a", "chat", "running"), job("b", "chat", "running")], [{ name: "gpu0", slots: 1 }])[0]!.slots, 2);
  // The board's scale is its widest row, two tracks side by side counting together.
  assert.equal(boardSlots([laneTracks("batch", jobs, backends), laneTracks("chat", jobs, backends)]), 6);
  assert.equal(boardSlots([]), 1, "an empty board still has a unit to draw by");
}

// --- the board's order: lowest number first, and hearth's own lane last -----------------------------
{
  const rows = boardOrder([{ name: "batch", priority: 100 }, { name: "warm", priority: 50, builtIn: true as const }, { name: "chat", priority: 0 }]);
  assert.deepEqual(rows.map((r) => r.name), ["chat", "batch", "warm"]);
}

// --- a ceiling as the node runs it, and a draft's that has not been applied ---------------------------
{
  const doc: Doc = { scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100, concurrency: 2 } } } };
  assert.deepEqual(laneCeilings("batch", view, doc), { live: 2, draft: 2, changed: false });
  assert.deepEqual(laneCeilings("batch", view, setAt(doc, ["scheduler", "lanes", "batch", "concurrency"], 3)), { live: 2, draft: 3, changed: true });
  assert.deepEqual(laneCeilings("batch", view, setAt(doc, ["scheduler", "lanes", "batch", "concurrency"], null)), { live: 2, draft: null, changed: true }, "a cleared ceiling is a change too");
  assert.deepEqual(laneCeilings("chat", view, setAt(doc, ["scheduler", "lanes", "chat", "concurrency"], 1)), { live: null, draft: 1, changed: true }, "a ceiling a lane did not have");
  assert.deepEqual(laneCeilings("batch", view, null), { live: 2, draft: null, changed: false }, "with no draft there is only the node's");
  assert.deepEqual(laneCeilings("gone", view, setAt(doc, ["scheduler", "lanes", "batch"], null)), { live: null, draft: null, changed: false });
}

// --- what a row says under its count -----------------------------------------------------------------
{
  const full = [job("1", "batch", "running"), job("2", "batch", "queued", { why: "lane", position: 0 }), job("3", "batch", "queued", { why: "lane", position: 1 }), job("4", "batch", "queued", { why: "model", position: 2 })];
  const s = laneStatus("batch", full, 2);
  assert.equal(s.tone, "warn");
  assert.equal(s.text, "3 wait: the lane is at its ceiling", "the most common reason, in the words the jobs table uses");
  assert.match(s.title ?? "", /1 wait: the model is at its own ceiling/, "and every other reason in its title");
  assert.deepEqual(laneStatus("batch", [job("1", "batch", "queued", { held: "key" })], 2), { tone: "info", text: "1 held by its key", title: null });
  assert.equal(laneStatus("batch", [job("1", "batch", "queued", { held: "key" }), job("2", "batch", "queued", { held: "key" })], 2).text, "2 held by their keys");
  assert.equal(laneStatus("chat", [job("1", "chat", "running")], null).text, "no ceiling");
  assert.equal(laneStatus("batch", [job("1", "batch", "running")], 2).text, "nothing waiting");
  assert.equal(laneStatus("batch", [job("1", "batch", "running", { offbox: true })], 2).text, "idle", "work a peer runs is not this node's");
}

// --- who sends work into a lane, as a row and as the inspector say it ---------------------------------
{
  const doc: Doc = { models: { a: { lane: "batch" }, b: { lane: "batch" }, c: { lane: "batch" } }, apiKeys: [{ key: "k", label: "app", lane: "batch" }] };
  const tags = laneTags("batch", view.defaults, pinsOf(doc));
  assert.deepEqual(tags.defaults, ["peers", "unnamed routes"], "one word per default");
  assert.deepEqual(tags.shown, ["peers", "unnamed routes", "a", "b"], "and up to two pins by name");
  assert.equal(tags.more, 2, "with the rest counted");
  assert.deepEqual(tags.pins, ["model a", "model b", "model c", "key app"]);
  assert.deepEqual(laneTags("chat", view.defaults, []), { defaults: ["requests default"], pins: [], shown: ["requests default"], more: 0 });
}

// --- where a lane stands in line -----------------------------------------------------------------------
{
  const rows = [{ name: "chat", priority: 0 }, { name: "memory", priority: 50 }, { name: "spare", priority: 50 }, { name: "batch", priority: 100 }, { name: "warm", priority: 200, builtIn: true as const }];
  assert.equal(lanePosition("chat", rows), "Goes first. Ahead of memory, spare.", "every lane at the nearest number");
  assert.equal(lanePosition("memory", rows), "Waits behind chat. Level with spare, oldest first. Ahead of batch.");
  assert.equal(lanePosition("batch", rows), "Waits behind memory, spare. Last in line.", "hearth's own lane is not in the line");
  assert.match(lanePosition("warm", rows), /Hearth's own lane/);
  assert.equal(lanePosition("chat", [{ name: "chat", priority: 0 }]), "The only lane.");
}

// --- the order settings' chips ---------------------------------------------------------------------------
{
  assert.deepEqual(orderChip("agePerSecond", 1, [0, 10, 100]), { lead: "ages ", value: "1", tail: "/s · 10 apart overtakes in 10 s" });
  assert.equal(orderChip("agePerSecond", 0.5, [0, 100]).tail, "/s · 100 apart overtakes in 200 s");
  assert.equal(orderChip("agePerSecond", 1, [0, 120]).tail, "/s · 120 apart overtakes in 2 min");
  assert.equal(orderChip("agePerSecond", 0, [0, 100]).tail, "/s · nothing overtakes");
  assert.equal(orderChip("agePerSecond", 1, [0, 0]).tail, "/s · lanes level");
  assert.equal(orderChip("maxPerCaller", 0, []).value, "off");
  assert.equal(orderChip("maxPerCaller", 2, []).value, "2");
  assert.deepEqual(orderChip("maxPerLane", 100, []), { lead: "queue cap ", value: "100", tail: " per lane" });
  assert.equal(slotSummary(backends), "gpu0 4 · gpu1 2 slots");
  assert.equal(slotSummary([{ name: "gpu0", slots: 1 }]), "gpu0 1 slot");
  assert.equal(slotSummary([]), "no backend");
}

// --- what the save strip says changed ------------------------------------------------------------------
{
  const file: Doc = {
    version: 3, scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100, concurrency: 4 } } },
    backends: { gpu0: { url: "http://127.0.0.1:1" } }, models: { m: { lane: "chat" } }, apiKeys: [{ key: "k", label: "app" }],
  };
  let draft = setAt(file, ["scheduler", "lanes", "batch", "concurrency"], 6);
  draft = setAt(draft, ["backends", "gpu0", "concurrency"], 2);
  draft = setAt(draft, ["models", "m", "lane"], "batch");
  draft = setAt(draft, ["apiKeys", 0, "lane"], "chat");
  draft = setAt(draft, ["scheduler", "lanes", "spare"], { priority: 60 });
  const words = changeWords(file, knobOps(file, file, draft));
  const said = Object.fromEntries(words.map((w) => [w.what, w]));
  assert.equal(said["batch at once"]?.change, "4 → 6");
  assert.equal(said["gpu0 jobs at once"]?.change, "unset → 2");
  assert.equal(said["gpu0 jobs at once"]?.restart, true, "a backend's own setting waits for a restart");
  assert.equal(said["batch at once"]?.restart, false);
  assert.equal(said["m lane"]?.change, "chat → batch");
  assert.equal(said["app lane"]?.change, "unset → chat", "a key is said by its label");
  assert.equal(said["lane spare"]?.change, "added");
  const gone = changeWords(file, knobOps(file, file, setAt(file, ["scheduler", "lanes", "batch"], null)));
  assert.deepEqual(gone.map((w) => [w.what, w.change]), [["lane batch", "removed"]]);
  // A file that writes no lanes has them all written in by the first lane edit, and the strip says so.
  const bare: Doc = { version: 3 };
  const base = seeded(bare, view);
  const first = changeWords(base, knobOps(bare, base, setAt(base, ["scheduler", "lanes", "chat", "priority"], 5)));
  assert.deepEqual(first.map((w) => [w.what, w.change]), [["every lane", "written into the file"], ["chat priority", "0 → 5"]]);
}

console.log("laneboard.test.ts ok");
