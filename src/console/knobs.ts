/**
 * The Scheduler page's logic, kept apart from its view: the lanes a file has and what names each
 * one, what the live queue is doing in them, when a lane cannot be removed, what a change will do,
 * and the rows of the backends, models, callers and lane pins. Pure, and reading `hearth.yaml` as
 * the page holds it rather than the parsed config, because every row needs the exact path in the
 * file that it writes.
 */
import { FIELDS, humanMs } from "../config/fields.js";
import { opsBetween, type Op } from "./diff.js";
import type { Job, LaneDefaults, SchedulerView, WaitReason } from "../observe/uidata.js";

export type Doc = Record<string, unknown>;
export type Path = (string | number)[];

/** The kinds of thing that send work into a lane, in the order the page lists them. `restart` marks a backend's own, built once at boot. */
const PIN_KINDS: { kind: LanePin["kind"]; restart: boolean }[] = [
  { kind: "model", restart: false }, { kind: "route", restart: true }, { kind: "rule", restart: false }, { kind: "when", restart: false },
  { kind: "hold", restart: true }, { kind: "key", restart: false }, { kind: "lending", restart: false },
];

/**
 * How a pin row names the thing that holds the lane. A model, a key and lending are named once; a
 * backend's routes, a flow's steps and a hold's lanes repeat, so each carries the path that tells it
 * from the next: the route's path, the step's number, the entry's position, and the router a rule is
 * in. Every word is unique, because a row is picked by its words and a screen reader reads them.
 */
export const PIN_WORDS: Record<LanePin["kind"], (name: string, pin: LanePin) => string> = {
  model: (n) => `model ${n}`,
  route: (n, p) => `a route on backend ${n}: ${routePathOf(p)}`,
  rule: (n, p) => ruleWords(n, p),
  when: (n, p) => `${ruleWords(n, p)}: ${whenWords(p)}`,
  hold: (n, p) => `a hold on backend ${n}, lane ${indexOf(p) ?? 0}`,
  key: (n) => `key ${n}`,
  lending: () => "lending",
};

/** Something in the file that sends work into a lane. `restart` marks a backend's, built once at boot. */
export type LanePin = { kind: "model" | "route" | "rule" | "when" | "hold" | "key" | "lending"; name: string; lane: string; path: Path; restart: boolean; facts: PinFacts };
/**
 * What a pin row is said by, read off the file at its path. A route is its path, a rule step is
 * numbered from one, and a condition is the list entry it is: `lane` keeps a lane, `laneNot` keeps it out.
 */
export type PinFacts = { route?: string; step?: number; router?: string; when?: "lane" | "laneNot"; index?: number };

/** Someone whose jobs a lane holds: a key, a peer, or borrowed work in general. A path is null where there is nothing safe to write. */
export type Caller = { kind: "key" | "peer" | "lending"; name: string; lane: string | null; lanePath: Path | null; jobs: number | null; jobsPath: Path | null; overrides: number };

export type LaneRow = SchedulerView["lanes"][number] & { running: number; queued: number; heldByKey: number; inFile: boolean };

/** How a caller row words the lane it sends work to, and the jobs at once it may run. */
export type CallerWords = { lane: string; jobs: string };
const CALLER_WORDS: Record<Caller["kind"], CallerWords> = {
  key: { lane: "lane", jobs: "jobs at once" },
  peer: { lane: "borrowed work's lane", jobs: "what it may run here" },
  lending: { lane: "borrowed work's lane", jobs: "what every peer may run here" },
};

/** One caller of the three, with the words its kind of row goes by and the lane its cell shows. */
export type CallerRow = { caller: Caller; words: CallerWords; laneText: string };

/** One backend: the jobs at once it runs on, the idle time of the lanes it holds, and what it runs on, which stays in Config. */
export type BackendRow = {
  name: string;
  /** The file's default, or the node's when the file writes none: what a count of its own is left empty for. */
  jobs: number | null;
  /** Its own count, or null to take `jobs`. */
  held: number | null;
  jobsPath: Path;
  defaultsPath: Path;
  /** Where a hold's idle time is, or null for a backend whose draft holds no lanes. */
  holdPath: Path | null;
  idleMs: number | null;
  idlePath: Path | null;
  resources: string[];
  resident: unknown;
};

/**
 * How a model's pool is written. A bare number is its token budget alone, which the parser reads as a
 * pool with nothing reserved for an answer; a mapping is both numbers; absent is no pool at all.
 */
export type PoolMode = "number" | "map" | "none";

/** One model's numbers, each read where the file keeps it. */
export type ModelRow = {
  id: string;
  jobs: number | null;
  laneValue: unknown;
  shareMs: number | null;
  sharePath: Path;
  pool: PoolMode;
  /** The shape the file wrote at `models.<id>.pool`. An edit keeps it, so a mapping is never turned into a number. */
  filePool: PoolMode;
  /** What the draft holds at `models.<id>.pool`, which a save of a pool written as one value has to spell out again. */
  poolValue: unknown;
  tokens: number | null;
  output: number | null;
  tokensPath: Path;
  /** Where an answer's share is, or null for a model with no pool: one is made from the budget beside it. */
  outputPath: Path | null;
};

/** What one pin row says the thing is, and whether its lane waits for a restart. */
export type LanePinGroup = { kind: LanePin["kind"]; restart: boolean; pins: LanePin[]; words: { what: (name: string, pin: LanePin) => string } };

/** A choice in a lane menu. `lane` is null for none, which is written as null. */
export type LaneChoice = { lane: string | null; text: string; value: string };

/** The kinds of thing whose lane may be none at all: a model, a key and lending's default. */
export const CLEARABLE: LanePin["kind"][] = ["model", "key", "lending"];

/** Whether a lane menu for a thing of this kind offers none. A hold's lane and a condition's never can. */
export function laneCanClear(kind: LanePin["kind"]): boolean {
  return CLEARABLE.includes(kind);
}

const WARM = "warm";
/** Where the parser puts `warm` when the file does not write it (`config.ts`, `WARM_LANE_PRIORITY`). */
const WARM_PRIORITY = 200;
/** The lane borrowed work lands in, which is the name its row goes by among the callers. */
const LENDING = "lending";
/** The lanes a file that declares none of its own runs on. */
const BUILT_IN_LANES = ["chat", "batch"];
/** What the scheduler sorts a lane it does not know at (`scheduler.ts`, `lanePriority`). */
const UNKNOWN_PRIORITY = 1000;

const isObj = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Doc => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const number = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** What the file holds at `path`. */
function at(doc: Doc, path: Path): unknown {
  let here: unknown = doc;
  for (const step of path) here = typeof step === "number" ? arr(here)[step] : obj(here)[step];
  return here;
}

/** The page an address names. `#queue` is another name for the Scheduler page. */
export function pageFor(hash: string): string {
  return hash === "queue" ? "scheduler" : hash;
}

/** Everything in the file that names a lane, each with the path that writes it. */
export function pinsOf(doc: Doc): LanePin[] {
  const pins: LanePin[] = [];
  const pin = (kind: LanePin["kind"], name: string, path: Path, restart: boolean, facts: PinFacts = {}): void => {
    const lane = str(at(doc, path));
    // A route, step or key that names no lane leaves the choice to its target or the request, so there is nothing to write.
    if (lane !== "") pins.push({ kind, name, lane, path, restart, facts });
  };
  // A step's lane and the lanes its condition tests, each entry of a condition being what the parser checks.
  const rules = (flows: unknown, under: Path, router: string | null): void => {
    for (const [f, flow] of Object.entries(obj(flows))) {
      arr(obj(flow).steps).forEach((step, i) => {
        pin("rule", f, [...under, f, "steps", i, "lane"], false, { step: i + 1, ...(router === null ? {} : { router }) });
        for (const k of ["lane", "laneNot"] as const) {
          // A condition may write its one lane as a bare string, which the file then holds as a list of one.
          const named = obj(obj(step).when)[k];
          const entries: unknown[] = typeof named === "string" ? [named] : arr(named);
          const path: Path = [...under, f, "steps", i, "when", k];
          const bare = entries.length === 1 && typeof named === "string";
          entries.forEach((_, j) => pin("when", f, bare ? path : [...path, j], false,
            { step: i + 1, when: k, ...(bare ? {} : { index: j + 1 }), ...(router === null ? {} : { router }) }));
        }
      });
    }
  };

  for (const id of Object.keys(obj(doc.models))) pin("model", id, ["models", id, "lane"], false);
  for (const [b, backend] of Object.entries(obj(doc.backends))) {
    arr(obj(backend).routes).forEach((route, i) => pin("route", b, ["backends", b, "routes", i, "lane"], true, { route: str(obj(route).path) }));
    arr(obj(obj(backend).hold).lanes).forEach((_, i) => pin("hold", b, ["backends", b, "hold", "lanes", i], true, { index: i + 1 }));
  }
  rules(doc.flows, ["flows"], null);
  for (const [r, router] of Object.entries(obj(doc.routers))) rules(obj(router).flows, ["routers", r, "flows"], r);
  // A key's name is its label, and a key without one has no name to be shown or edited by.
  arr(doc.apiKeys).forEach((entry, i) => {
    const label = str(obj(entry).label);
    if (label !== "") pin("key", label, ["apiKeys", i, "lane"], false);
  });
  pin("lending", LENDING, ["lending", "lane"], false);
  return pins;
}

/** Every labelled key, every peer and the lending default, with where its lane and its jobs at once can be written. */
export function callersOf(doc: Doc): Caller[] {
  const out: Caller[] = [];
  arr(doc.apiKeys).forEach((entry, i) => {
    const limits = obj(obj(entry).limits);
    // A key with no label is known only by its secret, so it has no name to show and nothing safe to change.
    const label = str(obj(entry).label);
    const known = label !== "";
    out.push({
      kind: "key", name: known ? label : `unlabelled key ${i + 1}`,
      // The lane a key is in is read for every key; only a labelled one has a path to write it.
      lane: str(obj(entry).lane) || null, lanePath: known ? ["apiKeys", i, "lane"] : null,
      jobs: known ? number(limits.maxConcurrent) : null, jobsPath: known ? ["apiKeys", i, "limits", "maxConcurrent"] : null,
      overrides: Object.keys(obj(limits.models)).length,
    });
  });
  for (const [name, peer] of Object.entries(obj(doc.peers))) {
    // Every peer's borrowed work lands in one lane, `lending.lane`, so a peer names none of its own.
    const lend = obj(obj(peer).lend);
    out.push({
      kind: "peer", name, lane: null, lanePath: null,
      jobs: number(lend.maxConcurrent), jobsPath: obj(peer).accept === undefined ? null : ["peers", name, "lend", "maxConcurrent"],
      overrides: Object.keys(obj(lend.limits)).length,
    });
  }
  const lending = obj(doc.lending);
  out.push({
    kind: "lending", name: LENDING,
    lane: str(lending.lane) || null, lanePath: ["lending", "lane"],
    jobs: number(lending.maxConcurrent), jobsPath: ["lending", "maxConcurrent"], overrides: 0,
  });
  return out;
}

/** The draft the page starts from: a file that writes no lanes of its own is given the ones the node runs on, whole. */
export function seeded(doc: Doc, view: SchedulerView): Doc {
  const scheduler = obj(doc.scheduler);
  if (isObj(scheduler.lanes)) return doc;
  // Written out rather than left to the defaults, so editing one lane in the draft keeps the rest.
  const lanes: Doc = {};
  for (const l of view.lanes) {
    if (l.builtIn) continue;
    lanes[l.name] = {
      priority: l.priority,
      ...(l.ceiling === undefined ? {} : { concurrency: l.ceiling }),
      ...(l.maxWaitMs === undefined ? {} : { maxWaitMs: l.maxWaitMs }),
    };
  }
  return { ...doc, scheduler: { ...scheduler, lanes } };
}

/** Each lane with what the queue is doing in it, and a row for a lane a job is in that the file does not have. */
export function laneRows(view: SchedulerView, jobs: Job[]): LaneRow[] {
  const rows: LaneRow[] = view.lanes.map((l) => ({ ...l, running: 0, queued: 0, heldByKey: 0, inFile: true }));
  const rowOf = new Map(rows.map((r) => [r.name, r]));
  for (const j of jobs) {
    let row = rowOf.get(j.lane);
    if (row === undefined) {
      // A removed lane's jobs still run, sorted at the priority every unknown lane gets.
      row = { name: j.lane, priority: UNKNOWN_PRIORITY, running: 0, queued: 0, heldByKey: 0, inFile: false };
      rowOf.set(j.lane, row);
      rows.push(row);
    }
    // Off-box work holds a slot on a peer, not here: not this lane's turns, and not in its line.
    if (j.offbox) continue;
    if (j.state === "running") row.running++;
    else if (j.held === "key") row.heldByKey++;
    else row.queued++;
  }
  return rows.sort((a, b) => a.priority - b.priority);
}

/**
 * `rows` as the draft will leave them: a lane added but not saved gets a row, a lane taken out loses
 * one, and the file's own priority decides the order. A row a job is in stays whatever the draft
 * says, because the node is running that lane now. With no draft the rows are the node's, as they are.
 */
export function draftLanes(rows: LaneRow[], doc: Doc | null): LaneRow[] {
  if (doc === null) return rows;
  const written = obj(obj(doc.scheduler).lanes);
  // A lane the page takes out is written as null until the ops turn it into a deletion, so it is gone.
  const has = new Set(Object.keys(written).filter((name) => name !== WARM && written[name] !== null));
  const out: LaneRow[] = [];
  for (const row of rows) {
    if (row.builtIn) { out.push(row); continue; }
    if (!has.has(row.name) && row.running + row.queued + row.heldByKey === 0) continue;
    const lane = obj(written[row.name]);
    out.push({ ...row, ...laneOf(lane, row.priority), inFile: has.has(row.name) });
  }
  const known = new Set(rows.map((r) => r.name));
  for (const name of has) {
    if (known.has(name)) continue;
    out.push({ name, ...laneOf(obj(written[name]), 0), running: 0, queued: 0, heldByKey: 0, inFile: true });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/** What a lane entry in the file sets, as a row holds it: a key it does not write is left off. */
function laneOf(lane: Doc, fallback: number): Pick<LaneRow, "priority"> & Partial<Pick<LaneRow, "ceiling" | "maxWaitMs">> {
  return {
    priority: number(lane.priority) ?? fallback,
    ...(number(lane.concurrency) === null ? {} : { ceiling: number(lane.concurrency)! }),
    ...(number(lane.maxWaitMs) === null ? {} : { maxWaitMs: number(lane.maxWaitMs)! }),
  };
}

/** Why a lane cannot be added under this name, or null when it can. */
export function laneNameError(name: string, doc: Doc): string | null {
  const clean = name.trim();
  if (clean === "") return "give the lane a name";
  if (clean === WARM) return "warm is hearth's own lane, for loading models ahead of a request";
  // A file that writes no lanes runs on the built-in ones, which are as taken as any it declares.
  const written = obj(doc.scheduler).lanes;
  // A lane the page took out is written as null: it is gone, so its name is free again.
  const declared: string[] = isObj(written) ? Object.keys(written).filter((k) => written[k] !== null) : BUILT_IN_LANES;
  return [...declared, WARM].includes(clean) ? `${clean} is already a lane` : null;
}

/**
 * Why the page will not remove a lane, or null when nothing holds it. `pending` is what the node says
 * waits on a restart: a lane change already saved but not applied leaves running routes on the lane
 * they were built with, so no lane can be removed until that restart happens.
 */
export function removalBlock(lane: string, pins: LanePin[], defaults: LaneDefaults, jobs: Job[], pending: string[] = []): string | null {
  // Jobs come first: they are here now, whatever the file says.
  const here = jobs.filter((j) => j.lane === lane);
  if (here.length > 0) {
    const running = here.filter((j) => j.state === "running").length;
    const waiting = here.length - running;
    const what = [running > 0 && `${running} running`, waiting > 0 && `${waiting} waiting`].filter(Boolean).join(" and ");
    return `${what} in ${lane}: let the lane drain first.`;
  }
  // A saved lane change the node has not restarted into: which lane the rule picks says nothing about
  // the one running routes still hold, and a request that enters a removed lane cannot fail.
  if (pending.includes("backends")) return `A backend setting was saved and waits on a restart, so routes still run the lanes they were built with: restart before removing ${lane}.`;
  // Then each of the three defaults, named for the work it sends or would move.
  if (lane === defaults.first) return `${lane} is the first lane, so every request that names no lane runs in it.`;
  if (lane === defaults.peers) return `Borrowed peer work lands in ${lane}, so removing it would move that work at once.`;
  if (lane === defaults.routes) return `Routes that name no lane land in ${lane}, and would keep using it until a restart.`;
  // Then everything in the file that points work at it, each by the kind of thing it is.
  const named = pinNames(lane, pins);
  return named.length === 0 ? null : `${lane} is named by ${named.join(", ")}. Point each of them at another lane first.`;
}

/** A pin said in a few words, by the kind of thing it is and its name. */
const PIN_SHORT: Record<LanePin["kind"], (name: string) => string> = {
  model: (n) => `model ${n}`, route: (n) => `a route on backend ${n}`, rule: (n) => `rule ${n}`,
  hold: (n) => `a hold on backend ${n}`, key: (n) => `key ${n}`, lending: () => "lending", when: (n) => `a condition in rule ${n}`,
};

/** Everything in the file that sends work into `lane`, each said once in a few words. */
function pinNames(lane: string, pins: LanePin[]): string[] {
  return [...new Set(pins.filter((p) => p.lane === lane).map((p) => PIN_SHORT[p.kind](p.name)))];
}

/** What a person should know about the change from `base` to `draft`, in the order the page shows it. */
export function reviewNotes(base: Doc, draft: Doc, moved?: { before: LaneDefaults; after: LaneDefaults }): string[] {
  const notes: string[] = [];
  const lanesOf = (d: Doc): Doc => obj(obj(d.scheduler).lanes);
  const before = lanesOf(base);
  const after = lanesOf(draft);
  // A removed lane is written as null, so it takes out its key rather than leaving one behind.
  const gone = (name: string): boolean => after[name] === null || after[name] === undefined;

  for (const name of Object.keys(before)) {
    if (before[name] === null || !gone(name)) continue;
    notes.push(`${name} is gone, so a client or plugin that asks for it in a request no longer reaches a lane of that name.`);
  }
  // What a lane's place in the list moves, as the parser worked it out: the rule for a default lives there and nowhere else.
  if (moved !== undefined) {
    if (moved.before.peers !== moved.after.peers) notes.push(`Borrowed peer work moves from ${moved.before.peers} to ${moved.after.peers}.`);
    if (moved.before.routes !== moved.after.routes) notes.push(`Any route that names no lane moves from ${moved.before.routes} to ${moved.after.routes} after a restart.`);
  }
  // A max wait is read when a job is queued, so a change to one reaches the next jobs only.
  for (const [name, lane] of Object.entries(after)) {
    if (gone(name) || number(obj(before[name]).maxWaitMs) === number(obj(lane).maxWaitMs)) continue;
    notes.push(`${name}'s max wait applies to new jobs only: a job already waiting keeps the timer it was queued with.`);
  }
  return notes;
}

/** Seconds until a lane `gap` behind earns its way past, or null when nothing ages. */
export function overtakeSeconds(gap: number, agePerSecond: number): number | null {
  if (agePerSecond <= 0) return null;
  return Math.max(0, gap) / agePerSecond;
}

/**
 * What the Order section says about the lanes' own gaps at a weight of `agePerSecond`: the closest
 * pair of lanes that are not level, and the seconds at which the lower one earns its way past the
 * higher. A pair at one priority never overtakes anything, so it is no gap to quote, and `gap` is
 * null when no two lanes are apart at all. `seconds` is null when nothing ages, so a weight of zero
 * reads as its own fact rather than as the lanes being level.
 */
export function overtakeText(priorities: number[], agePerSecond: number): { gap: { before: number; after: number } | null; seconds: number | null } {
  const sorted = [...priorities].sort((a, b) => a - b);
  let gap: { before: number; after: number } | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const apart = sorted[i]! - sorted[i - 1]!;
    if (apart <= 0) continue;
    if (gap === null || apart < gap.after - gap.before) gap = { before: sorted[i - 1]!, after: sorted[i]! };
  }
  return { gap, seconds: gap === null ? null : overtakeSeconds(gap.after - gap.before, agePerSecond) };
}

/**
 * The lanes' priorities in the order the draft puts them. A built-in lane is left out: `warm` is
 * hearth's own preload lane and queues nothing a person sends, so a gap to it would be an accident
 * of where the node happens to run it.
 */
export function priorityGaps(rows: LaneRow[], doc: Doc): number[] {
  return draftLanes(rows, doc)
    .filter((r) => !r.builtIn)
    .map((r) => r.priority);
}

/** The value at a path of a doc the page holds, the way a row reads it back out. */
export function valueAt(doc: Doc, path: Path): unknown {
  return at(doc, path);
}

/**
 * True when `path` of the two docs holds different values. A key the file leaves out and one the
 * draft clears to null are the same thing at any depth, because the page clears a field by writing
 * null over it and the ops write no null: a row is marked only where there is something to save.
 */
export function editedAt(base: Doc, draft: Doc, path: Path): boolean {
  return JSON.stringify(withoutNulls(at(base, path))) !== JSON.stringify(withoutNulls(at(draft, path)));
}

/** A number as shown in a field: a plain decimal, never in a grouping the field would then read back differently. */
export function numberText(n: number): string {
  return String(n);
}

/**
 * The lanes of a draft that have no priority, which the file refuses: each named so its row can say so.
 * A lane the file never gave one runs at the parser's default of 0, so only a cleared priority counts.
 * `warm` is out: the page does not edit that lane, so it cannot hold a save back.
 */
export function lanesWithoutPriority(doc: Doc): string[] {
  return Object.entries(obj(obj(doc.scheduler).lanes))
    // A lane cleared to null is being taken out, not waiting for its number.
    .filter(([name, lane]) => name !== WARM && lane !== null && obj(lane).priority === null)
    .map(([name]) => name);
}

/**
 * The ops that turn `doc` into `draft`, with `base` the seed of `doc`. A file that writes no lanes has
 * them seeded, so an edit that reaches any lane writes them all: one op taken out on its own would
 * remove the lanes it did not name. Every other edit is written where it is.
 */
export function knobOps(doc: Doc, base: Doc, draft: Doc): Op[] {
  const ops = dropCleared(opsBetween(base, draft));
  const lanes = obj(doc.scheduler).lanes;
  if (isObj(lanes) || !ops.some((op) => op.path[0] === "scheduler" && op.path[1] === "lanes")) return ops;
  // The seeded lanes go in whole, first, so the file has them before any lane the draft adds beside
  // them. A lane the draft adds is an op of its own, and a lane it takes back is no op at all: an
  // entry for either here would be the same lane twice, and a taken-back lane's null is a key the
  // parser refuses, so that lane could never be added again.
  const block: Doc = {};
  for (const [name, lane] of Object.entries(obj(base.scheduler).lanes as Doc)) if (lane !== null) block[name] = lane;
  const written = ops.filter((op) => !(op.path.length === 2 && op.path[0] === "scheduler" && op.path[1] === "lanes"));
  return Object.keys(block).length === 0 ? written : [{ path: ["scheduler", "lanes"], value: block }, ...written];
}

/**
 * `ops` without the ones that write a value nothing can hold. The page clears a field by setting it
 * to null, and `opsBetween` emits that null for a key the base never had; the node refuses the key
 * without a value, and refuses a null there too. A lane the draft adds is written whole, so its
 * cleared fields are nulls inside that value: they come out of it, all the way down. Deleting is not
 * touched: that is what a cleared key the base does have is written as.
 */
function dropCleared(ops: Op[]): Op[] {
  const kept: Op[] = [];
  for (const op of ops) {
    if (op.delete === true) { kept.push(op); continue; }
    if (op.value === null || op.value === undefined) continue;
    const value = withoutNulls(op.value);
    // A value that was nothing but cleared fields has nothing left to write.
    if (value !== undefined) kept.push(value === op.value ? op : { ...op, value });
  }
  return kept;
}

/** `value` with every null out of it, at any depth; undefined when that leaves nothing to write. */
function withoutNulls(value: unknown): unknown {
  // A cleared field is written as null, which is the one value that never goes into the file.
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(withoutNulls).filter((v) => v !== undefined);
  if (!isObj(value)) return value;
  const out: Doc = {};
  for (const [k, v] of Object.entries(value)) {
    const clean = withoutNulls(v);
    if (clean !== undefined) out[k] = clean;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** `doc` with `value` at `path`, making what the path needs on the way; the doc it is given is never changed. */
export function setAt(doc: Doc, path: Path, value: unknown): Doc {
  const [head, ...rest] = path as [string | number, ...Path];
  if (rest.length === 0) return { ...doc, [head]: value };
  const here = obj(doc);
  // A list stays a list and keeps every entry but the one the path reaches, which `listAt` replaces whole.
  if (typeof rest[0] === "number") return { ...here, [head]: listAt(arr(here[head]), rest as [number, ...Path], value) };
  return { ...here, [head]: setAt(obj(here[head]), rest, value) };
}

/** `list` with `value` at `path`, whose first step is an index into it, and every other entry kept. */
function listAt(list: unknown[], path: [number, ...Path], value: unknown): unknown[] {
  const [i, ...rest] = path;
  // Grown to the index, so every entry before it is a value the file can be written with.
  const next: unknown[] = Array.from({ length: Math.max(list.length, i + 1) }, (_, k) => list[k]);
  const below = (entry: unknown): unknown => (typeof rest[0] === "number" ? listAt(arr(entry), rest as [number, ...Path], value) : setAt(obj(entry), rest, value));
  next[i] = rest.length === 0 ? value : below(list[i]);
  return next;
}

/** The words the page puts on each reason, in the order the scheduler checks them. */
const REASON: Record<WaitReason, string> = {
  key: "the job's key is at its limit",
  card: "another backend has the card, or this one is handing it over",
  hold: "a neighbour's app has this lane kept off the card",
  lane: "the lane is at its ceiling",
  model: "the model is at its own ceiling",
  pool: "the model's shared context pool is full",
  share: "waiting out a running turn's head start",
  slots: "every slot on the backend is taken",
};

/** What the page says about one reason a job waits. */
export function reasonText(reason: WaitReason): string {
  return REASON[reason];
}

/**
 * Why a queued job waits, or null for one that is running. A job its own blockers leave alone is
 * next in line, or behind a better-placed job that cannot start yet: the scheduler starts it by the
 * same pass that clears the one ahead. A job's place in line is counted per backend and skips the
 * jobs their keys hold, so the job ahead of it is the one on its own backend with a lower position.
 */
export function waitingOn(job: Job, all: Job[]): string | null {
  if (job.state !== "queued") return null;
  if (job.held === "key") return REASON.key;
  if (job.why !== undefined) return REASON[job.why] ?? null;
  const ahead = all.some((j) => j !== job && j.state === "queued" && j.held !== "key" && j.backend === job.backend && j.position < job.position);
  return ahead ? "behind a better-placed job that cannot start yet" : "next in line";
}

/** The backend of a file that sets nothing of its own: one server the node fronts, unless the file has its own. */
const BUILT_IN_BACKEND = "local";

/**
 * Whether a backend's `hold` in `doc` is a hold at all: a draft that holds nothing writes null over it,
 * and nothing else in the draft is a hold.
 */
function holdsLanes(v: unknown): boolean {
  return v !== null && v !== undefined;
}

/** Every named lane of a doc, lowest priority first, each with the priority the menu sorts it by. */
function orderedLanes(doc: Doc, { warm = false }: { warm?: boolean } = {}): { name: string; priority: number }[] {
  const written = doc.scheduler !== undefined && doc.scheduler !== null ? obj(doc.scheduler).lanes : undefined;
  // A file that writes no lanes runs on the built-in ones, which are what it has to offer.
  const entries: [string, Doc][] = isObj(written)
    ? Object.entries(written).filter(([, lane]) => lane !== null).map(([name, lane]) => [name, obj(lane)])
    : BUILT_IN_LANES.map((name) => [name, { priority: 0 }]);
  const lanes = entries
    .filter(([name]) => warm || name !== WARM)
    .map(([name, lane]) => ({ name, priority: number(lane.priority) ?? UNKNOWN_PRIORITY }));
  // The parser adds `warm` to every file that does not write it, so it is a lane either way.
  if (warm && !lanes.some((l) => l.name === WARM)) lanes.push({ name: WARM, priority: WARM_PRIORITY });
  return lanes.sort((a, b) => a.priority - b.priority);
}

/**
 * The lanes a lane menu offers: every lane the draft has, lowest priority first. `warm` is hearth's
 * own preload lane, left out unless `warm: true` asks for it, as `pinLanes` does for what may hold it.
 */
export function knobLanes(doc: Doc, { warm = false }: { warm?: boolean } = {}): string[] {
  return orderedLanes(doc, { warm }).map((l) => l.name);
}

/**
 * The lanes the menu of a thing of this kind offers. The parser lets a model, a route, a rule step,
 * a condition, a hold and lending name `warm`, so their menus have it; it refuses a key on it.
 */
export function pinLanes(doc: Doc, kind: LanePin["kind"] | Caller["kind"]): string[] {
  return knobLanes(doc, { warm: kind !== "key" });
}

/**
 * A lane menu: the draft's lanes, and "none" as null where the setting takes one. A hold's list entry
 * and a condition's entry always hold a lane, so their menus have no none.
 */
export function laneMenu(lanes: string[], { canClear = false }: { canClear?: boolean } = {}): LaneChoice[] {
  const out: LaneChoice[] = lanes.map((lane) => ({ lane, text: lane, value: lane }));
  return canClear ? [...out, { lane: null, text: "none", value: "" }] : out;
}

/**
 * What a row says about a lane it holds. A condition may name one lane as a bare string, which the
 * file then holds as a list of one, so both read as the lane they name; a list of several is every
 * lane in it, as words. `act` says what the list does, for a row that is one entry of it.
 */
export function laneText(
  value: unknown,
  act?: string,
  offered?: string[],
): { lane: string | null; text: string; value: string } {
  // An empty name is no lane named, which is what a row whose value the draft does not have shows.
  const named = (typeof value === "string" ? [value] : arr(value).filter((v): v is string => typeof v === "string")).filter((l) => l !== "");
  const text = named.length === 0 ? "—" : named.join(", ");
  // The menu writes a lane equal to the whole value, and the value's own list entry writes itself.
  const chosen = named.length === 1 ? named[0]! : offered !== undefined && text === offered.join(", ") ? text : "";
  return {
    lane: named.length === 1 ? named[0]! : null,
    text: named.length === 0 ? "—" : act === undefined ? text : `${act} on ${text}`,
    value: chosen,
  };
}

/**
 * The backends the draft has, each with the count it runs on now and where that count is written. A
 * backend with no count of its own takes the file's default, which is what `jobs` is when `held` is
 * null, so a cleared field shows the number a save would leave it running on.
 */
export function backendRows(doc: Doc): BackendRow[] {
  const written = isObj(doc.backends) ? Object.keys(doc.backends) : [BUILT_IN_BACKEND];
  const fallback = number(obj(doc.backendDefaults).concurrency);
  return written.map((name) => {
    const backend = obj(obj(doc.backends)[name]);
    const hold = backend.hold;
    return {
      name,
      jobs: fallback ?? fieldDefaultJobs(),
      held: number(backend.concurrency),
      jobsPath: ["backends", name, "concurrency"],
      defaultsPath: ["backendDefaults", "concurrency"],
      // A hold is idleMs and lanes together, so a backend the draft holds nothing on has no idle time to edit.
      holdPath: holdsLanes(hold) ? ["backends", name, "hold"] : null,
      idleMs: holdsLanes(hold) ? number(obj(hold).idleMs) : null,
      idlePath: holdsLanes(hold) ? ["backends", name, "hold", "idleMs"] : null,
      // What it runs on decides what `card` means; it is read here and edited on the Config page.
      resources: arr(backend.resources).filter((r): r is string => typeof r === "string"),
      resident: backend.resident ?? false,
    };
  });
}

/** What a model may have running at once as a number, where the file writes one. */
const jobsOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/**
 * Every model in `models:`, in the order the file writes them, keeping the ids `filter` finds. The
 * filter is any part of an id in either case, and nothing to type is every model.
 */
export function modelRows(doc: Doc, filter: string, file: Doc = doc): ModelRow[] {
  const wanted = filter.trim().toLowerCase();
  return Object.entries(obj(doc.models))
    .filter(([id]) => wanted === "" || id.toLowerCase().includes(wanted))
    .map(([id, entry]) => {
      const model = obj(entry);
      const pool = model.pool;
      // The shape the file itself wrote, which the draft may have moved away from mid-edit.
      const written = obj(obj(file.models)[id]).pool;
      const fileMode: PoolMode = typeof written === "number" ? "number" : written === undefined || written === null ? "none" : "map";
      // A pool written as a bare number is its token budget, with nothing reserved for an answer, which
      // makes its one number the whole pool: writing the mapping over it would need the budget beside it.
      const mode: PoolMode = typeof pool === "number" ? "number" : typeof pool === "object" && pool !== null ? "map" : "none";
      return {
        id,
        jobs: jobsOf(model.concurrency),
        laneValue: model.lane,
        shareMs: number(model.shareAfterMs),
        sharePath: ["models", id, "shareAfterMs"],
        pool: mode,
        filePool: fileMode,
        poolValue: pool,
        tokens: mode === "number" ? (pool as number) : number(obj(pool).tokens),
        output: mode === "map" ? number(obj(pool).output) : null,
        // A budget is edited where the file keeps it, and made a mapping when it has none.
        tokensPath: (mode === "map" ? ["models", id, "pool", "tokens"] : ["models", id, "pool"]) as Path,
        outputPath: mode === "none" ? null : ["models", id, "pool", "output"],
      };
    });
}

/**
 * The keys, then the peers, then the lending default that covers every peer, each with the words its
 * kind of row goes by. A caller who cannot pick a lane here still says which one its work lands in:
 * a key its own lane, and a peer the lane lending sends borrowed work to. `fallback` is the lane the
 * node gives work that names none, which is where lending's own work goes when it names no lane.
 */
export function callerRows(doc: Doc, fallback: string | null = null): CallerRow[] {
  const rank: Record<Caller["kind"], number> = { key: 0, peer: 1, lending: 2 };
  const lendingLane = str(obj(doc.lending).lane) || fallback;
  return callersOf(doc)
    .sort((a, b) => rank[a.kind] - rank[b.kind])
    .map((caller) => {
      // A key's own lane; a peer's and lending's are the one lane borrowed work lands in.
      const lane = caller.kind === "key" ? caller.lane : lendingLane;
      return { caller, words: CALLER_WORDS[caller.kind], laneText: lane ?? "—" };
    });
}

/**
 * The badges a lane row carries, one per default it is: the first lane takes every request that
 * names none, lending's lane takes borrowed work, and a third lane takes routes that name none.
 * Where two of those are one lane the row says so in one badge, and a lane no rule picks has none.
 */
export function laneBadges(lane: string, defaults: LaneDefaults): string[] {
  const first = lane === defaults.first;
  const peers = lane === defaults.peers;
  const routes = lane === defaults.routes;
  const out: string[] = [];
  if (first) out.push("requests default");
  // A lane that takes both is one badge: two would read as two different defaults it does not have.
  if (peers && routes) out.push("peers and unnamed routes");
  else if (peers) out.push("borrowed peer work");
  else if (routes) out.push("unnamed routes");
  return out;
}

/** Everything that names a lane, grouped by kind in the order the section lists it, each group saying the kind once. */
export function lanePinGroups(pins: LanePin[]): LanePinGroup[] {
  return PIN_KINDS
    .map(({ kind, restart }) => ({ kind, restart, pins: pins.filter((p) => p.kind === kind), words: { what: (name: string, pin: LanePin) => PIN_WORDS[kind](name, pin) } }))
    .filter((g) => g.pins.length > 0);
}

/** The route a pin is, as the file writes it; a route that names none reads as its position. */
function routePathOf(p: LanePin): string {
  return p.facts?.route || `route ${(indexOf(p) ?? 0) + 1}`;
}

/** The number a pin's step sits at, from one, which is how a file's steps are counted. */
function ruleWords(name: string, p: LanePin): string {
  const inRouter = p.facts?.router === undefined ? `flow ${name}` : `router ${p.facts.router}, flow ${name}`;
  return `a rule step in ${inRouter}${p.facts?.step === undefined ? "" : `, step ${p.facts.step}`}`;
}

/** What a condition does with the lane: keeps it, or keeps it out. */
function whenWords(p: LanePin): string {
  return `lane ${p.facts?.when === "laneNot" ? "is not" : "is"} ${p.lane}`;
}

/** The position a path names in a list, or null for a path that names no list entry. */
function indexOf(p: LanePin): number | null {
  const last = p.path[p.path.length - 1];
  return typeof last === "number" ? last + 1 : null;
}

/**
 * What a pin's path holds in the draft. A row the draft does not have is nothing, which a menu writes
 * as its empty choice, so a hold the draft took out leaves nothing behind.
 */
export function pinValueAt(doc: Doc, path: Path): unknown {
  return at(doc, path);
}

/** True when any of `paths` holds a different value in the two docs, as `editedAt` reads one. */
export function editedIn(base: Doc, draft: Doc, paths: Path[]): boolean {
  return paths.some((path) => editedAt(base, draft, path));
}

/** One row of the pins section: what it is, the lane it holds, and the path that writes the lane. */
export type PinRow = { kind: LanePin["kind"]; name: string; lane: string; path: Path; restart: boolean; facts: PinFacts };

/**
 * Every pin to show a row for: the draft's own, then any the draft has cleared to none but the file
 * still has. A cleared pin keeps its row, so it can be pointed at a lane again rather than vanishing,
 * and it reads the lane `base` holds. A pin both have is one row, taken from the draft.
 */
export function pinRowsOf(draft: Doc, base: Doc): PinRow[] {
  const rows: PinRow[] = pinsOf(draft);
  const seen = new Set(rows.map((p) => p.path.join(".")));
  for (const pin of pinsOf(base)) {
    const key = pin.path.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(pin);
  }
  return rows;
}

/* ------------------------------------------------------------ pools, defaults */

/**
 * One edit a pool's fields make. `pool` is what the draft holds at `models.<id>.pool`, which a pool
 * written as one value has to keep beside the number the edit sets.
 */
export type PoolEdit = { path: Path; value: unknown; pool: unknown };

/**
 * What a model's pool becomes under `edits`, as ops that agree with the parser. A pool written as a
 * bare number has no mapping to write into, so setting its budget writes that number and setting an
 * answer's share writes the whole `{ tokens, output }`, keeping the budget the file had. Clearing a
 * mapping's budget takes the whole pool out: the parser refuses a pool with no tokens.
 */
export function savePool(row: { id: string; filePool: PoolMode }, edits: PoolEdit[]): Op[] {
  // A field left alone writes nothing: an op here would rewrite the pool the file already has.
  if (edits.length === 0) return [];
  // The pool as the draft holds it, which a row has to spell out again: the budget and share the file
  // already has, then every number the edits set over it. A pool written as one number is its budget,
  // and a budget edit names `tokens` wherever the file keeps that number.
  const current = edits[0]!.pool;
  const held = typeof current === "number" ? current : isObj(current) ? { ...current } : {};
  const next: Doc = { ...(typeof held === "number" ? { tokens: held } : held) };
  // A cleared pool is the whole thing, whatever path the field names: the parser takes no pool without a
  // budget, so any clear is read as "take the pool out" rather than as one number going missing.
  for (const e of edits) {
    if (e.path[e.path.length - 1] === "pool") {
      if (e.value === null) return [{ path: ["models", row.id, "pool"], delete: true }];
      // A number at `pool` is the budget itself; anything else is a whole pool written out.
      if (typeof e.value === "number") { next.tokens = e.value; continue; }
      if (isObj(e.value)) Object.assign(next, e.value);
      continue;
    }
    const key = poolFieldOf(e.path);
    if (key === null) continue;
    if (e.value === null) delete next[key];
    else next[key] = e.value;
  }
  // A budget is the pool's reason to exist, and the parser refuses one without: a cleared budget takes the
  // whole pool out, written as a deletion the draft keeps as a null the page turns into one. An answer's
  // share with no budget anywhere is the same pool, so it writes nothing at all.
  const budget = typeof next.tokens === "number" && next.tokens > 0 ? next.tokens : null;
  if (budget === null) {
    const cleared = edits.some((e) => e.path.length > 3 && e.path[e.path.length - 1] === "tokens" && e.value === null);
    return cleared ? [{ path: ["models", row.id, "pool"], delete: true }] : [];
  }
  // The shape follows the file, not the draft: a mapping the file wrote stays a mapping, so each number is
  // written where it sits and the block, its other key and their comments are left as they are. A bare
  // number the file wrote stays a number until a share gives it a reason to be a mapping.
  const poolPath: Path = ["models", row.id, "pool"];
  const share = number(next.output);
  if (share === null) {
    // With no share left, a pool is the one number the file takes: a mapping the file wrote keeps its block
    // below, and anything else is written as that number. Set to the number the file holds is no edit at all.
    if (row.filePool !== "map") return current === budget ? [] : [{ path: poolPath, value: budget }];
  }
  // A number becoming a mapping is the one edit written whole: the parser has no leaf for it.
  if (row.filePool !== "map") return [{ path: poolPath, value: { tokens: budget, output: share } }];
  // A mapping is written one number at a time, and a number that already says what the file says writes nothing.
  const written = (key: "tokens" | "output", value: number | null): Op[] => {
    const was = number(obj(held)[key]);
    if (value === was) return [];
    return value === null ? [{ path: [...poolPath, key], delete: true }] : [{ path: [...poolPath, key], value }];
  };
  return [...written("tokens", budget), ...written("output", share)];
}

/**
 * Which number of a pool an edit names: `tokens` for the budget, which a pool written as one number keeps
 * at `pool` itself, and `output` for a share.
 */
function poolFieldOf(path: Path): "tokens" | "output" | null {
  const key = path[path.length - 1];
  if (key === "output") return "output";
  return key === "tokens" || key === "pool" ? "tokens" : null;
}

/** The lanes the parser works out for the work that names none, each said for the work it takes. A route's lane is built at boot, so it alone waits. */
export const LANE_DEFAULT_WORDS: { key: keyof LaneDefaults; what: string; restart: boolean }[] = [
  { key: "first", what: "a request that names no lane, and a step that sets none", restart: false },
  { key: "peers", what: "borrowed peer work, where lending names no lane", restart: false },
  { key: "routes", what: "a backend route that names no lane", restart: true },
];

/**
 * What the node runs a backend at when nothing above it is set: the setting's own `def` in `fields.ts`,
 * which is the table the parser and the config editor read for it. A cleared default does not fall back
 * to a number this page keeps, so the two cannot drift.
 */
const fieldDefaultJobs = (): number => {
  // A number setting states its default as a number; anything else here is a table this page misread.
  const f = FIELDS.backendDefaults.concurrency;
  const def = f !== undefined && "def" in f ? f.def : undefined;
  return typeof def === "number" ? def : 1;
};

/**
 * The jobs at once the node runs on when nothing a backend says applies: the setting's own default,
 * whatever the file writes. It answers "what does emptying this field run", so it never reports the
 * default the file happens to hold now.
 */
export function defaultJobs(): number {
  return fieldDefaultJobs();
}

/** The ids the filter hides: every model `all` holds that `shown` does not, compared by id because the two lists are made apart. */
export function hiddenModels(shown: ModelRow[], all: ModelRow[]): string[] {
  const kept = new Set(shown.map((r) => r.id));
  return all.filter((r) => !kept.has(r.id)).map((r) => r.id);
}

/**
 * A lane a menu must offer as itself though the draft no longer has it: the value only counts when it
 * is a non-empty string. A key or lending that names no lane holds nothing to show.
 */
export function strayLane(value: unknown, lanes: string[]): string | null {
  return typeof value === "string" && value !== "" && !lanes.includes(value) ? value : null;
}

/* ------------------------------------------------------------- the lane board */

/** One backend's slots as a lane's row draws them: what runs there in the lane, waits there, and waits on its key. */
export type Track = { backend: string; slots: number; running: number; waiting: number; held: number };

/** A backend as the frame reports it: its name and the slots it runs. */
export type SlotsOf = { name: string; slots?: number };

/**
 * The tracks a lane's row draws. A lane's ceiling counts on each backend apart, so there is one track
 * per backend that has this lane's jobs, as many slots wide as that backend runs; an idle lane draws
 * one empty track for the widest backend. Slots and jobs are the frame's, so the board draws what the
 * node runs. Off-box work holds a slot on a peer, so it is on no track here.
 */
export function laneTracks(lane: string, jobs: Job[], backends: SlotsOf[]): Track[] {
  const by = new Map<string, Track>();
  for (const j of jobs) {
    if (j.lane !== lane || j.offbox) continue;
    const name = j.backend ?? "";
    let t = by.get(name);
    if (t === undefined) {
      t = { backend: name, slots: backends.find((b) => b.name === name)?.slots ?? 0, running: 0, waiting: 0, held: 0 };
      by.set(name, t);
    }
    if (j.state === "running") t.running++;
    else if (j.held === "key") t.held++;
    else t.waiting++;
  }
  const place = (name: string): number => {
    const i = backends.findIndex((b) => b.name === name);
    return i < 0 ? backends.length : i;
  };
  // A track is never narrower than what runs on it: a node may run past its count, and its slots say so.
  const tracks = [...by.values()].map((t) => ({ ...t, slots: Math.max(t.slots, t.running, 1) })).sort((a, b) => place(a.backend) - place(b.backend));
  if (tracks.length > 0) return tracks;
  let widest: SlotsOf | null = null;
  for (const b of backends) if (widest === null || (b.slots ?? 0) > (widest.slots ?? 0)) widest = b;
  return widest === null ? [] : [{ backend: widest.name, slots: Math.max(1, widest.slots ?? 0), running: 0, waiting: 0, held: 0 }];
}

/** The slots the widest row spans, so one slot is as wide on every row of the board. */
export function boardSlots(rows: Track[][]): number {
  return Math.max(1, ...rows.map((tracks) => tracks.reduce((n, t) => n + t.slots, 0)));
}

/** The board's rows: lowest priority number first, with hearth's own lane last whatever its number. */
export function boardOrder<T extends { priority: number; builtIn?: true }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.builtIn === b.builtIn ? a.priority - b.priority : a.builtIn ? 1 : -1));
}

/**
 * A lane's ceiling as the node runs it, and the draft's where that differs. `changed` with a null
 * `draft` is a ceiling the draft clears. A lane the draft does not write has nothing to compare.
 */
export function laneCeilings(lane: string, view: SchedulerView, draft: Doc | null): { live: number | null; draft: number | null; changed: boolean } {
  const live = view.lanes.find((l) => l.name === lane)?.ceiling ?? null;
  if (draft === null) return { live, draft: null, changed: false };
  const written = obj(obj(draft.scheduler).lanes)[lane];
  if (!isObj(written)) return { live, draft: null, changed: false };
  const next = number(written.concurrency);
  return { live, draft: next, changed: next !== live };
}

/**
 * What a lane's row says under its count: why its jobs wait, in the words the jobs table uses, the
 * most common reason first; else the jobs their keys hold; else whether anything runs. `title` holds
 * every reason, for a row that waits on more than one.
 */
export function laneStatus(lane: string, jobs: Job[], ceiling: number | null): { tone: "warn" | "info" | "dim"; text: string; title: string | null } {
  const here = jobs.filter((j) => j.lane === lane && !j.offbox);
  const waiting = here.filter((j) => j.state === "queued" && j.held !== "key");
  const held = here.filter((j) => j.state === "queued" && j.held === "key").length;
  const heldText = `${held} held by ${held === 1 ? "its key" : "their keys"}`;
  if (waiting.length > 0) {
    const counts = new Map<string, number>();
    for (const j of waiting) {
      const why = waitingOn(j, jobs) ?? "waiting";
      counts.set(why, (counts.get(why) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const title = [...ranked.map(([why, n]) => `${n} wait: ${why}`), ...(held > 0 ? [heldText] : [])].join("\n");
    return { tone: "warn", text: `${waiting.length} wait: ${ranked[0]![0]}`, title };
  }
  if (held > 0) return { tone: "info", text: heldText, title: null };
  if (here.some((j) => j.state === "running")) return { tone: "dim", text: ceiling === null ? "no ceiling" : "nothing waiting", title: null };
  return { tone: "dim", text: "idle", title: null };
}

/**
 * Who sends work into a lane: one word per default the parser makes it, and each pin in the file.
 * `shown` is what a board row has room for, the defaults and up to two pins by name, with `more`
 * counting the pins left off; `pins` says every pin by its kind, for the inspector.
 */
export function laneTags(lane: string, defaults: LaneDefaults, pins: LanePin[]): { defaults: string[]; pins: string[]; shown: string[]; more: number } {
  const own: string[] = [];
  if (lane === defaults.first) own.push("requests default");
  if (lane === defaults.peers) own.push("peers");
  if (lane === defaults.routes) own.push("unnamed routes");
  const names = [...new Set(pins.filter((p) => p.lane === lane).map((p) => p.name))];
  return { defaults: own, pins: pinNames(lane, pins), shown: [...own, ...names.slice(0, 2)], more: Math.max(0, names.length - 2) };
}

/**
 * Where a lane stands in line, in one sentence: the lane it waits behind, any it is level with, and
 * the lane it is ahead of. Hearth's own lane is left out of the line, because it queues nothing a
 * person sends.
 */
export function lanePosition(name: string, rows: { name: string; priority: number; builtIn?: true }[]): string {
  const me = rows.find((r) => r.name === name);
  if (me === undefined) return "";
  if (me.builtIn) return "Hearth's own lane, for loading models ahead of a request.";
  const others = rows.filter((r) => r.name !== name && !r.builtIn);
  if (others.length === 0) return "The only lane.";
  // The nearest lanes either side, every one of them where several share a number.
  const nearest = (side: typeof others): string[] => {
    const at = side.length === 0 ? null : side.reduce((p, r) => (Math.abs(r.priority - me.priority) < Math.abs(p - me.priority) ? r.priority : p), side[0]!.priority);
    return side.filter((r) => r.priority === at).map((r) => r.name);
  };
  const before = nearest(others.filter((r) => r.priority < me.priority));
  const level = others.filter((r) => r.priority === me.priority).map((r) => r.name);
  const after = nearest(others.filter((r) => r.priority > me.priority));
  const parts = [before.length === 0 ? "Goes first." : `Waits behind ${before.join(", ")}.`];
  if (level.length > 0) parts.push(`Level with ${level.join(", ")}, oldest first.`);
  parts.push(after.length === 0 ? "Last in line." : `Ahead of ${after.join(", ")}.`);
  return parts.join(" ");
}

/** The order settings, in the order the title row shows them. */
export const ORDER_KEYS = ["agePerSecond", "warmBonus", "maxPerLane", "maxPerCaller"] as const;
export type OrderKey = (typeof ORDER_KEYS)[number];

/**
 * One order setting as its chip says it: the words before its number, the number, and the words
 * after. Earned priority carries what the lanes' closest gap means at that weight.
 */
export function orderChip(key: OrderKey, value: number, priorities: number[]): { lead: string; value: string; tail: string } {
  if (key === "agePerSecond") {
    const { gap, seconds } = overtakeText(priorities, value);
    if (value <= 0) return { lead: "ages ", value: numberText(value), tail: "/s · nothing overtakes" };
    if (gap === null || seconds === null) return { lead: "ages ", value: numberText(value), tail: "/s · lanes level" };
    const s = Math.round(seconds);
    return { lead: "ages ", value: numberText(value), tail: `/s · ${gap.after - gap.before} apart overtakes in ${s < 1 ? "under 1 s" : humanMs(s * 1000)}` };
  }
  if (key === "warmBonus") return { lead: "warm bonus ", value: numberText(value), tail: "" };
  if (key === "maxPerLane") return { lead: "queue cap ", value: numberText(value), tail: " per lane" };
  return { lead: "per caller ", value: value === 0 ? "off" : numberText(value), tail: "" };
}

/** The slots each backend runs, said in one line for the board's legend. */
export function slotSummary(backends: SlotsOf[]): string {
  if (backends.length === 0) return "no backend";
  const one = (b: SlotsOf): string => `${b.name} ${b.slots ?? 0}`;
  return `${backends.map(one).join(" · ")} ${backends.length === 1 && backends[0]!.slots === 1 ? "slot" : "slots"}`;
}

/** The words a lane's own field goes by. */
const LANE_FIELD_WORDS: Record<string, string> = { priority: "priority", concurrency: "at once", maxWaitMs: "max wait" };

/** A value as the save strip says it; one the file does not set is "unset". */
function said(v: unknown): string {
  if (v === undefined || v === null) return "unset";
  if (typeof v === "number") return numberText(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(said).join(", ");
  if (isObj(v)) return Object.entries(v).map(([k, x]) => `${k} ${said(x)}`).join(", ");
  return String(v);
}

/** What the thing at `path` is called on the page. */
function pathWords(path: Path, base: Doc): string {
  const [head, a, b, c, d] = path;
  if (head === "scheduler" && a === "lanes") {
    if (b === undefined) return "every lane";
    if (c === undefined) return `lane ${String(b)}`;
    return `${String(b)} ${LANE_FIELD_WORDS[String(c)] ?? String(c)}`;
  }
  if (head === "scheduler" && typeof a === "string") return a;
  if (head === "backendDefaults") return "every backend jobs at once";
  if (head === "backends" && b === "concurrency") return `${String(a)} jobs at once`;
  if (head === "backends" && b === "hold" && c === "idleMs") return `${String(a)} hold idle`;
  if (head === "models" && typeof a === "string") {
    if (b === "concurrency") return `${a} jobs at once`;
    if (b === "lane") return `${a} lane`;
    if (b === "shareAfterMs") return `${a} head start`;
    if (b === "pool") return `${a} pool${c === "output" ? " each answer" : ""}`;
  }
  if (head === "apiKeys" && typeof a === "number") {
    const label = str(obj(arr(base.apiKeys)[a]).label) || `key ${a + 1}`;
    if (b === "lane") return `${label} lane`;
    if (b === "limits" && c === "maxConcurrent") return `${label} jobs at once`;
  }
  if (head === "peers" && typeof a === "string" && d === undefined && c === "maxConcurrent") return `${a} jobs at once`;
  if (head === "lending" && a === "lane") return "lending lane";
  if (head === "lending" && a === "maxConcurrent") return "lending jobs at once";
  const pin = pinsOf(base).find((p) => p.path.join(".") === path.join("."));
  return pin === undefined ? path.join(".") : PIN_WORDS[pin.kind](pin.name, pin);
}

/**
 * What each op of a draft changes, in the page's words: what it is, and its value before and after.
 * `restart` marks a backend's own setting, which waits for a restart; the rest apply live.
 */
export function changeWords(base: Doc, ops: Op[]): { what: string; change: string; restart: boolean }[] {
  return ops.map((op) => {
    const before = at(base, op.path);
    const whole = op.path[0] === "scheduler" && op.path[1] === "lanes" && op.path.length <= 3;
    // A file that writes no lanes is given every lane the node runs on, as `knobOps` says.
    const change = op.path.length === 2 && whole ? "written into the file"
      : op.delete === true ? (whole ? "removed" : `${said(before)} → unset`)
      : whole && (before === undefined || before === null) ? "added"
        : `${said(before)} → ${said(op.value)}`;
    return { what: pathWords(op.path, base), change, restart: op.path[0] === "backends" || op.path[0] === "backendDefaults" };
  });
}
