/**
 * The Scheduler page as it draws: what `knobs.ts` works out has to reach the board, a table or the
 * inspector. Each block renders the real page, tab or inspector to HTML over a small file and reads
 * the part it is about, so a value the logic works out that nothing shows fails here.
 *
 *     npx tsx test/schedpage.test.ts
 */
import assert from "node:assert/strict";
import * as React from "react";
import { renderToString } from "react-dom/server";

import { editedAt, setAt, type Doc, type Path } from "../src/console/knobs.js";
import type { SchedulerView } from "../src/observe/uidata.js";

// The page's JSX compiles to `React.createElement` here, and its store reads the address and the document as it loads.
Object.assign(globalThis, { React, location: { hash: "" }, document: { hidden: false, addEventListener() {} }, addEventListener() {} });
// Imported by a name tsc does not follow: the tests are typechecked without JSX, and these modules are .tsx.
const console_ = "../src/console/";
type Part = React.FunctionComponent<{ knobs: unknown; id?: string; sel?: unknown; pick?: unknown }>;
const { useStore } = (await import(`${console_}store.js`)) as { useStore: { getInitialState(): Record<string, unknown> } };
const { useSched } = (await import(`${console_}schedStore.js`)) as { useSched: { getInitialState(): Record<string, unknown> } };
const sections = (await import(`${console_}Sections.js`)) as Record<string, Part> & { sectionFacts(knobs: unknown, peers: string | null): Record<string, { count: number; edited: boolean }> };
const { Scheduler } = (await import(`${console_}Scheduler.js`)) as { Scheduler: React.FunctionComponent };

const view: SchedulerView = {
  lanes: [
    { name: "chat", priority: 0 }, { name: "memory", priority: 50, ceiling: 1 }, { name: "spare", priority: 60 },
    { name: "batch", priority: 100 }, { name: "warm", priority: 200, builtIn: true },
  ],
  order: { agePerSecond: 1, warmBonus: 40, maxPerLane: 100, maxPerCaller: 0 },
  defaults: { first: "chat", peers: "batch", routes: "batch" },
};
const job = (id: string, lane: string, state: string, extra: Record<string, unknown> = {}) => ({ id, lane, state, model: "m", caller: "app", position: 0, since: 0, backend: "b", ...extra });
// A render on the server reads a store's first state, so the frame goes there.
Object.assign(useStore.getInitialState(), {
  data: {
    scheduler: view,
    q: { jobs: [job("1", "chat", "running"), job("2", "memory", "running"), job("3", "memory", "queued", { why: "lane" })] },
    net: { nodes: [{ name: "n", self: true, up: true, free: 2, slots: 4, queued: 1, backends: [{ name: "b", slots: 4 }] }] },
    config: { path: "hearth.yaml", hash: "h", restartPending: [] },
  },
});

const lanes = { chat: { priority: 0 }, memory: { priority: 50 }, batch: { priority: 100 } };
const knobsOf = (base: Doc, draft: Doc) => ({
  file: { text: "", hash: "h", doc: base }, base, draft, change() {}, edited: (p: Path) => editedAt(base, draft, p),
  dirty: true, changes: 1, async review() {}, discard() {}, plan: null, closePlan() {}, err: null,
});
const render = (part: string, base: Doc, draft: Doc, id?: string): string =>
  renderToString(React.createElement(sections[part]!, { knobs: knobsOf(base, draft), id, sel: null, pick() {} }));
/** The options of the menu with this label. */
const menu = (html: string, label: string): string[] => {
  const body = new RegExp(`<select[^>]*aria-label="${label}"[^>]*>(.*?)</select>`).exec(html)?.[1];
  assert.notEqual(body, undefined, `a menu labelled ${label}`);
  return [...(body ?? "").matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1]!);
};
/** How many slots of the board are drawn running. */
const running = (html: string): number => html.match(/rounded-\[3px\][^"]*bg-accent/g)?.length ?? 0;

// --- no draft: the board is the node's, whole, and read-only ---------------------------------------
{
  const html = renderToString(React.createElement(Scheduler));
  for (const name of ["chat", "memory", "spare", "batch", "warm"]) assert.match(html, new RegExp(`>${name}<`), `${name} has a row with no draft`);
  assert.doesNotMatch(html, /not in the file/, "and no lane the node runs is said to be missing from the file");
  assert.doesNotMatch(html, /aria-label="remove /, "nothing is offered that the draft would have to do");
  assert.doesNotMatch(html, /<input/, "and there is no field to type in");
  assert.equal(running(html), 2, "each running job fills a slot");
  assert.match(html, /1 wait: the lane is at its ceiling/, "a lane says why its jobs wait, in the jobs table's words");
  assert.match(html, /b 4 slots · top goes first/, "the legend counts the backend's slots from the frame");
  // Only what the node itself knows is a tab: the file's tables need the file.
  assert.deepEqual([...html.matchAll(/role="tab"[^>]*>([A-Za-z ]+)</g)].map((m) => m[1]), ["Jobs", "History"]);
}

// --- with a draft: the strip says what changed, and an unapplied ceiling is drawn faintly -----------
{
  const base: Doc = { version: 3, scheduler: { lanes: { ...lanes, memory: { priority: 50, concurrency: 1 } } } };
  const draft = setAt(base, ["scheduler", "lanes", "memory", "concurrency"], 2);
  Object.assign(useSched.getInitialState(), { file: { text: "", hash: "h", doc: base }, base, draft, unread: null });
  const html = renderToString(React.createElement(Scheduler));
  assert.match(html, /1 change/, "the strip counts the change");
  assert.match(html, /memory at once 1 → 2 · applies live/, "and says what it is");
  assert.match(html, /review &amp; apply/);
  assert.match(html, /bg-fg\/35/, "the draft's ceiling is a faint second line until it is applied");
  assert.match(html, /aria-label="memory, priority 50: 1 running, 1 at once,/, "the count is against the ceiling the node runs");
  Object.assign(useSched.getInitialState(), { file: null, base: null, draft: null, unread: null });
}

// --- a pin set to none keeps its row, its menu and its tab's mark -----------------------------------
{
  const base: Doc = { version: 3, scheduler: { lanes }, models: { m: { lane: "chat" } } };
  const draft = setAt(base, ["models", "m", "lane"], null);
  assert.match(render("PinsTab", base, draft), />model m</, "the row stays");
  assert.equal(sections.sectionFacts(knobsOf(base, draft), "batch").pins!.edited, true, "the tab is marked while it holds the edit");
  assert.deepEqual(menu(render("PinInspector", base, draft, "models.m.lane"), "model m"), ["chat", "memory", "batch", "warm", "none"], "and the pin can be given a lane again");
}

// --- a cell with no menu says the lane the work lands in -------------------------------------------
{
  const base: Doc = { version: 3, scheduler: { lanes }, apiKeys: [{ key: "one", lane: "memory" }], peers: { p: { accept: "t" } }, lending: {} };
  const html = render("CallersTab", base, setAt(base, ["lending", "maxConcurrent"], 3));
  const cell = (name: string): string => new RegExp(`${name}.*?</td><td[^>]*><span[^>]*>(.*?)</span>`).exec(html)?.[1] ?? "";
  assert.equal(cell("unlabelled key 1"), "memory", "an unlabelled key shows its own lane");
  assert.equal(cell(">p<"), "batch", "a peer shows the lane the node sends borrowed work to");
}

// --- warm is a lane on the menus of what may hold it, written or not, and never on a key's --------
{
  const base: Doc = { version: 3, scheduler: { lanes }, models: { pinned: { lane: "warm" }, plain: { lane: "chat" } }, apiKeys: [{ key: "one", label: "app", lane: "chat" }], lending: { lane: "warm" } };
  const moved = setAt(base, ["models", "plain", "lane"], "batch");
  assert.deepEqual(menu(render("ModelInspector", base, moved, "pinned"), "pinned: lane"), ["chat", "memory", "batch", "warm", "none"], "a model on warm reads it as a lane");
  assert.deepEqual(menu(render("PinInspector", base, moved, "models.pinned.lane"), "model pinned"), ["chat", "memory", "batch", "warm", "none"]);
  assert.deepEqual(menu(render("PinInspector", base, moved, "lending.lane"), "lending"), ["chat", "memory", "batch", "warm", "none"], "lending may hold it too");
  assert.deepEqual(menu(render("PinInspector", base, moved, "apiKeys.0.lane"), "key app"), ["chat", "memory", "batch", "none"], "a key never may");
  assert.deepEqual(menu(render("CallerInspector", base, setAt(base, ["apiKeys", 0, "lane"], "batch"), "key:app"), "app: lane"), ["chat", "memory", "batch", "none"]);
  // The parser refuses a key on warm whether or not the file writes that lane, so a file that does changes nothing.
  const written: Doc = { ...base, scheduler: { lanes: { ...lanes, warm: { priority: 200 } } } };
  assert.deepEqual(menu(render("PinInspector", written, setAt(written, ["models", "plain", "lane"], "batch"), "apiKeys.0.lane"), "key app"), ["chat", "memory", "batch", "none"]);
}

console.log("schedpage.test.ts ok");
