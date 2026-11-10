/**
 * The Scheduler page's tabs under the lane board: the jobs, every model, every caller, every backend
 * and every lane pin, each a plain table read first. A row opens in the inspector, the only place its
 * fields are edited, each through the knob it writes in the page's one draft of hearth.yaml.
 */
import { RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { FIELDS, humanMs } from "../config/fields.js";
import { backendRows, callerRows, defaultJobs, editedAt, editedIn, hiddenModels, LANE_DEFAULT_WORDS, laneCanClear, laneMenu, lanePinGroups, laneText, modelRows, pinLanes, pinRowsOf, savePool, strayLane, valueAt, waitingOn, type Caller, type LanePin, type ModelRow, type Path, type PoolMode } from "./knobs.js";
import { Field, Fields, Inspect, Num, useTick, type Knobs } from "./Scheduler.js";
import { go, useStore } from "./store.js";
import type { Job } from "../observe/uidata.js";
import { ago, Button, cx, Empty, mono, Pill } from "./ui.js";

/** What the inspector shows: a lane, an order setting, the new-lane box, or a row of one of the tabs. */
export type Sel = { kind: "lane" | "order" | "add" | "job" | "model" | "caller" | "backend" | "pin"; id: string };
export type Pick = (sel: Sel | null) => void;

/** True when `sel` is this one. */
export const same = (sel: Sel | null, kind: Sel["kind"], id: string): boolean => sel !== null && sel.kind === kind && sel.id === id;

/** A field's mark: the setting applies at the next restart, with the arrow that says so. */
function Restart() {
  return <Pill tone="warn"><RotateCw size={10} />restart</Pill>;
}

/** A lane menu: the draft's lanes, and none where the setting takes one, which is written as null. */
function LaneMenu({ id, label, value, lanes, canClear, edited, onChange }: {
  id?: string; label: string; value: string | null; lanes: string[]; canClear: boolean; edited: boolean; onChange: (lane: string | null) => void;
}) {
  // A lane the draft no longer has is still what the file says, so it is offered as itself rather than dropped.
  // A row whose value is not a lane at all (a key or lending that names none) has nothing to offer as one.
  const stray = strayLane(value, lanes);
  return (
    <select id={id} aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
            className={cx("h-7 max-w-44 rounded-md border bg-panel px-1.5 text-[12px] focus-visible:outline-2 focus-visible:outline-accent", mono,
              stray ? "border-warn" : edited ? "border-accent bg-accent/10" : "border-line")}>
      {stray !== null && <option value={stray}>{stray} (not a lane)</option>}
      {laneMenu(lanes, { canClear }).map((c) => <option key={c.value} value={c.value}>{c.text}</option>)}
    </select>
  );
}

/** A number and the unit a person reads it in, such as the idle time of a hold or a head start. */
function Line({ value, unit, ...num }: {
  id?: string; value: number | null; label: string; min?: number; none: string; title?: string; edited: boolean; unit: (n: number) => string; onSave: (n: number | null) => void;
}) {
  return (
    <>
      <Num value={value ?? undefined} {...num} />
      <span className="w-9 whitespace-nowrap text-[11px] text-dim">{value === null ? "ms" : unit(value)}</span>
    </>
  );
}

/** A tab's table: headings in the page's own case, and a scroll of its own on a narrow screen. */
function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="border-b border-line text-[11px] text-dim">
          <tr>{head.map((h) => <th key={h} className="whitespace-nowrap px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const TD = "whitespace-nowrap px-4 py-1.5";

/**
 * One row of a tab. Its first cell is the button a keyboard reaches; a click anywhere on the row opens
 * it in the inspector, and a row the draft has edited keeps the accent tint.
 */
function PickRow({ on, edited, name, onPick, children }: { on: boolean; edited: boolean; name: ReactNode; onPick: () => void; children: ReactNode }) {
  return (
    <tr onClick={onPick} className={cx("cursor-pointer border-b border-line/60 last:border-0 hover:bg-muted/60", on ? "bg-muted" : edited && "bg-accent/5")}>
      <td className={TD}>
        <button type="button" aria-pressed={on} className="rounded text-left focus-visible:outline-2 focus-visible:outline-accent">{name}</button>
      </td>
      {children}
    </tr>
  );
}

/** A value a row shows in place of one the file does not set. */
const unset = (text: string): ReactNode => <span className="text-dim">{text}</span>;

/* -------------------------------------------------------------------- jobs */

/** A job's state and, when it is waiting, its place in line. */
const stateOf = (j: Job): ReactNode => (j.state === "running" ? <Pill tone="accent" pulse>running</Pill> : <Pill tone="dim">#{j.position + 1} queued</Pill>);

/** Running first, then waiting, each oldest first. */
export const jobOrder = (jobs: Job[]): Job[] => [...jobs].sort((a, b) => (a.state === b.state ? a.since - b.since : a.state === "running" ? -1 : 1));

/** Where a job runs: a backend here, or the peer that took it. */
const whereOf = (j: Job): string => (j.offbox ? `${j.peer} (peer)` : j.backend ?? "—");

export function JobsTab({ sel, pick }: { sel: Sel | null; pick: Pick }) {
  const jobs = useStore((s) => s.data!.q.jobs);
  useTick();
  const rows = jobOrder(jobs);
  return (
    <>
      <Table head={["model", "state", "lane", "caller", "where", "waiting on", "time"]}>
        {rows.map((j) => {
          const why = waitingOn(j, jobs);
          return (
            <PickRow key={j.id} on={same(sel, "job", j.id)} edited={false} name={<span className={mono}>{j.model}</span>} onPick={() => pick({ kind: "job", id: j.id })}>
              <td className={TD}>{stateOf(j)}</td>
              <td className={TD}>{j.lane}</td>
              <td className={cx(TD, "text-dim")}>{j.caller}</td>
              <td className={cx(TD, "text-dim")}>{whereOf(j)}</td>
              <td className={cx(TD, why === null ? "text-dim" : "text-warn")}>{why ?? "—"}</td>
              <td className={cx(TD, "tabular text-dim")}>{ago(j.since)}</td>
            </PickRow>
          );
        })}
      </Table>
      {rows.length === 0 && <Empty>Nothing queued or running.</Empty>}
    </>
  );
}

export function JobInspector({ id, pick }: { id: string; pick: Pick }) {
  const jobs = useStore((s) => s.data!.q.jobs);
  useTick();
  const j = jobs.find((x) => x.id === id);
  if (j === undefined) return <Inspect title="Job" sub="Finished, or no longer in the queue." />;
  const why = waitingOn(j, jobs);
  return (
    <Inspect title={<span className={mono}>{j.model}</span>} sub={j.state === "running" ? `Running for ${ago(j.since)}.` : `Waiting for ${ago(j.since)}.`}>
      <Fields>
        <Field label="state">{stateOf(j)}</Field>
        <Field label="lane">
          <button type="button" onClick={() => pick({ kind: "lane", id: j.lane })} className="underline decoration-dotted hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">{j.lane}</button>
        </Field>
        <Field label="caller"><span className="truncate">{j.caller}</span></Field>
        <Field label="where"><span className="truncate">{whereOf(j)}</span></Field>
        {why !== null && <Field label="waiting on"><span className="text-right text-warn">{why}</span></Field>}
      </Fields>
    </Inspect>
  );
}

/* ------------------------------------------------------------------ models */

/** The pool as the file writes it, as words. */
function poolText(pool: PoolMode): string {
  if (pool === "map") return "a token budget, and a share of it for each answer";
  if (pool === "number") return "a token budget, written as the one number it is";
  return "no pool";
}

const modelPaths = (r: ModelRow): Path[] => [["models", r.id, "concurrency"], ["models", r.id, "lane"], r.sharePath, r.tokensPath, ...(r.outputPath === null ? [] : [r.outputPath])];

/** Every model in `models:`, each with the jobs it runs at once, its lane, the head start a turn gets, and its pool. */
export function ModelsTab({ knobs, sel, pick }: { knobs: Knobs; sel: Sel | null; pick: Pick }) {
  const [filter, setFilter] = useState("");
  // The rows read the draft; the shape a pool was written in is the file's.
  const all = modelRows(knobs.draft, "", knobs.file.doc ?? {});
  const rows = modelRows(knobs.draft, filter, knobs.file.doc ?? {});
  const changed = (r: ModelRow): boolean => editedIn(knobs.base, knobs.draft, modelPaths(r));
  // The two lists are made by separate calls, so what tells a shown model from a hidden one is its id.
  const hidden = hiddenModels(rows, all).filter((id) => changed(all.find((r) => r.id === id)!)).length;
  return (
    <>
      {all.length > 0 && (
        <div className="border-b border-line px-4 py-2">
          <input aria-label="filter models" placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)}
                 className={cx("h-7 w-44 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none", mono)} />
        </div>
      )}
      <Table head={["model", "lane", "jobs at once", "head start", "pool"]}>
        {rows.map((r) => (
          <PickRow key={r.id} on={same(sel, "model", r.id)} edited={changed(r)} name={<span className={mono}>{r.id}</span>} onPick={() => pick({ kind: "model", id: r.id })}>
            <td className={cx(TD, mono)}>{typeof r.laneValue === "string" ? r.laneValue : unset("—")}</td>
            <td className={cx(TD, "tabular")}>{r.jobs ?? unset("backend's")}</td>
            <td className={cx(TD, "tabular")}>{r.shareMs === null ? unset("—") : humanMs(r.shareMs)}</td>
            <td className={cx(TD, "tabular")} title={`This model's pool is ${poolText(r.pool)}.`}>
              {r.tokens === null ? unset("—") : `${r.tokens.toLocaleString("en-US")} tokens${r.output === null ? "" : ` · ${r.output.toLocaleString("en-US")} each answer`}`}
            </td>
          </PickRow>
        ))}
      </Table>
      {all.length === 0 && <Empty>This node declares no model, so there is no per-model setting to tune here.</Empty>}
      {all.length > 0 && rows.length === 0 && <Empty>No model has {filter.trim()} in its id.</Empty>}
      {hidden > 0 && <div className="border-t border-line px-4 py-2 text-[11px] text-warn">The filter hides a model whose setting is changed here.</div>}
    </>
  );
}

export function ModelInspector({ knobs, id }: { knobs: Knobs; id: string }) {
  const r = modelRows(knobs.draft, "", knobs.file.doc ?? {}).find((m) => m.id === id);
  if (r === undefined) return <Inspect title={<span className={mono}>{id}</span>} sub="Not in the draft." />;
  /** What one pool field sets, written as the parser takes a pool: `savePool` decides where. */
  const savePoolTo = (edits: Parameters<typeof savePool>[1]): void => {
    for (const op of savePool(r, edits)) knobs.change(op.path, op.delete === true ? null : op.value);
  };
  const concurrency: Path = ["models", id, "concurrency"];
  const lane: Path = ["models", id, "lane"];
  const laneValue = valueAt(knobs.draft, lane);
  return (
    <Inspect title={<span className={mono}>{id}</span>} sub="Each of these applies live.">
      <Fields>
        <Field label="jobs at once" id="model-jobs" title={FIELDS.model.concurrency!.desc}>
          <Num id="model-jobs" value={valueAt(knobs.draft, concurrency) as number | null} label={`${id}: jobs at once`} edited={knobs.edited(concurrency)}
               min={FIELDS.model.concurrency!.type === "number" ? FIELDS.model.concurrency!.min : undefined} none="backend's"
               title={FIELDS.model.concurrency!.desc} onSave={(n) => knobs.change(concurrency, n)} />
        </Field>
        <Field label="lane" id="model-lane" title="the lane this model's work queues in, which beats the key's and the request's">
          <LaneMenu id="model-lane" label={`${id}: lane`} value={typeof laneValue === "string" ? laneValue : null} edited={knobs.edited(lane)}
                    lanes={pinLanes(knobs.draft, "model")} canClear onChange={(l) => knobs.change(lane, l)} />
        </Field>
        <Field label="head start" id="model-share" title={FIELDS.model.shareAfterMs!.desc}>
          <Line id="model-share" value={r.shareMs} label={`${id}: head start`} min={0} none="none" unit={humanMs} edited={editedAt(knobs.base, knobs.draft, r.sharePath)}
                title={FIELDS.model.shareAfterMs!.desc} onSave={(n) => knobs.change(r.sharePath, n)} />
        </Field>
        {/* A pool written as one value has no mapping to write a number into, so both fields write the
            whole pool at `pool`, keeping the budget the file already has. */}
        <Field label="pool" id="model-pool" title={`${FIELDS.pool.tokens!.desc} This model's pool is ${poolText(r.pool)}.`}>
          <Num id="model-pool" value={r.tokens ?? undefined} label={`${id}: pool tokens`} min={1} none="no pool" edited={editedAt(knobs.base, knobs.draft, r.tokensPath)}
               title={`${FIELDS.pool.tokens!.desc} This model's pool is ${poolText(r.pool)}. Clearing it takes the whole pool out, an answer's share included.`}
               onSave={(n) => savePoolTo([{ path: r.tokensPath, value: n, pool: r.poolValue }])} />
          <span className="w-9 text-[11px] text-dim">tokens</span>
        </Field>
        {r.outputPath !== null && (
          <Field label="each answer" id="model-output" title={FIELDS.pool.output!.desc}>
            <Num id="model-output" value={r.output ?? undefined} label={`${id}: reserved for each answer`} min={1} none="none" edited={editedAt(knobs.base, knobs.draft, r.outputPath)}
                 title={`${FIELDS.pool.output!.desc} ${r.pool === "number" ? "Sets the budget beside it from the number the file has." : ""}`}
                 onSave={(n) => savePoolTo([{ path: r.outputPath!, value: n, pool: r.poolValue }])} />
            <span className="w-9 text-[11px] text-dim">tokens</span>
          </Field>
        )}
      </Fields>
    </Inspect>
  );
}

/* ----------------------------------------------------------------- callers */

const callerPaths = (c: Caller): Path[] => [c.lanePath, c.jobsPath].filter((p): p is Path => p !== null);
const callerId = (c: Caller): string => `${c.kind}:${c.name}`;

/**
 * The keys, the peers and the lending default, each with the lane its work queues in and the jobs at
 * once it may have. A key with no label is known only by its secret, so its row is read-only.
 */
export function CallersTab({ knobs, sel, pick }: { knobs: Knobs; sel: Sel | null; pick: Pick }) {
  // Where borrowed work goes when lending names no lane: the node works it out, so the frame says it.
  const peers = useStore((s) => s.data?.scheduler.defaults.peers ?? null);
  const rows = callerRows(knobs.draft, peers);
  return (
    <>
      <Table head={["caller", "lane", "jobs at once", "one model's own"]}>
        {rows.map(({ caller: c, laneText: lands }) => {
          const lane = c.lanePath === null ? lands : valueAt(knobs.draft, c.lanePath);
          const jobs = c.jobsPath === null ? null : valueAt(knobs.draft, c.jobsPath);
          return (
            <PickRow key={callerId(c)} on={same(sel, "caller", callerId(c))} edited={editedIn(knobs.base, knobs.draft, callerPaths(c))} onPick={() => pick({ kind: "caller", id: callerId(c) })}
                     name={<span><span className={mono}>{c.name}</span>
                       {c.kind === "lending" && <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-dim">every peer</span>}
                       {c.lanePath === null && c.kind === "key" && <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-dim">unlabelled</span>}
                     </span>}>
              <td className={TD}><span className={cx(mono, c.lanePath === null && "text-dim")}>{typeof lane === "string" ? lane : "—"}</span></td>
              <td className={cx(TD, "tabular")}>{typeof jobs === "number" ? jobs : unset(c.jobsPath === null ? "—" : "unset")}</td>
              <td className={cx(TD, "text-dim")}>{c.overrides === 0 ? "—" : `${c.overrides} model${c.overrides === 1 ? "" : "s"}`}</td>
            </PickRow>
          );
        })}
      </Table>
      {rows.length === 0 && <Empty>No caller is named in the file.</Empty>}
    </>
  );
}

export function CallerInspector({ knobs, id }: { knobs: Knobs; id: string }) {
  const peers = useStore((s) => s.data?.scheduler.defaults.peers ?? null);
  const row = callerRows(knobs.draft, peers).find((r) => callerId(r.caller) === id);
  if (row === undefined) return <Inspect title={id} sub="Not in the draft." />;
  const { caller: c, words, laneText: lands } = row;
  const sub = c.kind === "lending" ? "The borrowed work of every peer." : c.kind === "peer" ? "A peer's borrowed work lands in the lane lending names." : c.lanePath === null ? "Known only by its secret, so nothing of it is edited here." : undefined;
  return (
    <Inspect title={<span className={mono}>{c.name}</span>} sub={sub}>
      <Fields>
        <Field label={words.lane} id={c.lanePath === null ? undefined : "caller-lane"}>
          {c.lanePath === null ? <span className={cx(mono, "text-dim")}>{lands}</span> : (
            <LaneMenu id="caller-lane" label={`${c.name}: ${words.lane}`} value={valueAt(knobs.draft, c.lanePath) as string | null} edited={editedAt(knobs.base, knobs.draft, c.lanePath)}
                      lanes={pinLanes(knobs.draft, c.kind)} canClear onChange={(l) => knobs.change(c.lanePath!, l)} />
          )}
        </Field>
        <Field label={words.jobs} id={c.jobsPath === null ? undefined : "caller-jobs"}>
          {c.jobsPath === null ? unset("—") : (
            <Num id="caller-jobs" value={valueAt(knobs.draft, c.jobsPath) as number | null} label={`${c.name}: ${words.jobs}`} min={1} none="unset" edited={editedAt(knobs.base, knobs.draft, c.jobsPath)}
                 title={c.kind === "key"
                   ? "jobs it may run at once over every model, across all lanes and backends. Unset is no limit"
                   : "jobs it may have in flight here, across every model. Unset takes the lending terms"}
                 onSave={(n) => knobs.change(c.jobsPath!, n)} />
          )}
        </Field>
        <Field label="one model's own" title="a caller's own limit on one model is set beside that model, on Keys or Lending">
          {c.overrides === 0 ? unset("—") : (
            <button type="button" onClick={() => go(c.kind === "key" ? "keys" : "lending")} className="underline decoration-dotted hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
              {c.overrides} model{c.overrides === 1 ? "" : "s"}, on {c.kind === "key" ? "Keys" : "Lending"}
            </button>
          )}
        </Field>
      </Fields>
    </Inspect>
  );
}

/* ---------------------------------------------------------------- backends */

const DEFAULTS_PATH: Path = ["backendDefaults", "concurrency"];

/** Every backend, with the jobs at once it runs and the idle time of the lanes it holds. Both wait for a restart. */
export function BackendsTab({ knobs, sel, pick }: { knobs: Knobs; sel: Sel | null; pick: Pick }) {
  const rows = backendRows(knobs.draft);
  const current = defaultJobs();
  const written = valueAt(knobs.draft, DEFAULTS_PATH);
  return (
    <>
      <Table head={["backend", "jobs at once", "hold's idle time", "runs on"]}>
        {/* The file's default is a row of its own: a backend that sets no count takes it. */}
        <PickRow on={same(sel, "backend", "")} edited={knobs.edited(DEFAULTS_PATH)} name="every backend" onPick={() => pick({ kind: "backend", id: "" })}>
          <td className={cx(TD, "tabular")}>{typeof written === "number" ? written : unset(String(current))}</td>
          <td className={TD}>{unset("—")}</td>
          <td className={cx(TD, "text-[11px] text-dim")}>the default for every backend below</td>
        </PickRow>
        {rows.map((r) => (
          <PickRow key={r.name} on={same(sel, "backend", r.name)} edited={editedIn(knobs.base, knobs.draft, [r.jobsPath, ...(r.idlePath === null ? [] : [r.idlePath])])}
                   name={<span className={mono}>{r.name}</span>} onPick={() => pick({ kind: "backend", id: r.name })}>
            <td className={cx(TD, "tabular")}>{r.held ?? unset(String(r.jobs ?? current))}</td>
            <td className={cx(TD, "tabular")}>{r.idlePath === null ? unset("none") : r.idleMs === null ? unset("—") : humanMs(r.idleMs)}</td>
            <td className={cx(TD, mono, "text-dim")}>{r.resources.length === 0 ? "no hardware" : r.resources.join(", ")}{r.resident !== false && " · resident"}</td>
          </PickRow>
        ))}
      </Table>
      {rows.length === 0 && <Empty>This node fronts no backend.</Empty>}
    </>
  );
}

export function BackendInspector({ knobs, id }: { knobs: Knobs; id: string }) {
  const current = defaultJobs();
  if (id === "") {
    return (
      <Inspect title="every backend" sub="Every backend that sets no count of its own takes this one.">
        <Fields>
          <Field label="jobs at once" id="backend-jobs" title={FIELDS.backendDefaults.concurrency!.desc}>
            <Num id="backend-jobs" value={valueAt(knobs.draft, DEFAULTS_PATH) as number | null} label="jobs at once on a backend" edited={knobs.edited(DEFAULTS_PATH)}
                 min={FIELDS.backendDefaults.concurrency!.type === "number" ? FIELDS.backendDefaults.concurrency!.min : undefined}
                 none={String(current)} title={`${FIELDS.backendDefaults.concurrency!.desc} Left empty, the node runs ${current}.`}
                 onSave={(n) => knobs.change(DEFAULTS_PATH, n)} />
            <Restart />
          </Field>
        </Fields>
      </Inspect>
    );
  }
  const r = backendRows(knobs.draft).find((b) => b.name === id);
  if (r === undefined) return <Inspect title={<span className={mono}>{id}</span>} sub="Not in the draft." />;
  return (
    <Inspect title={<span className={mono}>{r.name}</span>}>
      <Fields>
        <Field label="jobs at once" id="backend-jobs" title={FIELDS.backend.concurrency!.desc}>
          <Num id="backend-jobs" value={r.held ?? undefined} label={`${r.name}: jobs at once`} edited={editedAt(knobs.base, knobs.draft, r.jobsPath)}
               min={FIELDS.backend.concurrency!.type === "number" ? FIELDS.backend.concurrency!.min : undefined}
               none={r.jobs === null ? String(current) : String(r.jobs)}
               title={`${FIELDS.backend.concurrency!.desc} Left empty, it takes ${r.jobs === null ? `the node's ${current}` : `the default, ${r.jobs}`}.`}
               onSave={(n) => knobs.change(r.jobsPath, n)} />
          <Restart />
        </Field>
        <Field label="hold's idle time" id={r.idlePath === null ? undefined : "backend-idle"}
               title="while this backend's app has work, the lanes it holds are kept off its hardware until it has been idle this long">
          {r.idlePath === null ? <span className="text-dim" title="nothing keeps a lane off this backend's hardware">none</span> : (
            <>
              <Line id="backend-idle" value={r.idleMs} label={`${r.name}: hold idle`} min={1} none="needed" unit={humanMs} edited={editedAt(knobs.base, knobs.draft, r.idlePath)}
                    title="while this backend's app has work, these lanes are kept off its hardware until it has been idle this long"
                    onSave={(n) => knobs.change(r.idlePath!, n)} />
              <Restart />
            </>
          )}
        </Field>
        <Field label="runs on" title="what a backend runs on decides what card means, and stays with the hardware on Config">
          <span className={cx(mono, "truncate text-dim")}>{r.resources.length === 0 ? "no hardware" : r.resources.join(", ")}{r.resident !== false && " · resident"}</span>
        </Field>
      </Fields>
      <div className="mt-3"><Button onClick={() => go("config")}>hardware and resident on Config</Button></div>
    </Inspect>
  );
}

/* --------------------------------------------------------------- lane pins */

/** One row of the pins tab: what it is, the lane it holds, the lanes its menu offers, and how a lane is written in its place. */
type PinRow = { key: string; path: Path; kind: LanePin["kind"]; what: string; restart: boolean; value: string; text: string; editable: boolean; canClear: boolean; lanes: string[]; write: (lane: string | null) => void };

/**
 * The rows of the pins tab, in the order the page lists their kinds. A path that ends on an index is
 * one entry of a list, and the menu moves that entry; any other path is the whole value, and the menu
 * moves it there. A row's key is its path, so two pins said alike are still two rows. A pin the draft
 * set to none keeps its row and its menu, so it can be given a lane again.
 */
function pinRows(knobs: Knobs): PinRow[] {
  const out: PinRow[] = [];
  for (const { pins, words } of lanePinGroups(pinRowsOf(knobs.draft, knobs.base))) {
    for (const p of pins) {
      const value = valueAt(knobs.draft, p.path);
      // A list of one is the lane itself, which the menu moves; a list of several is said in words.
      const named = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      const inList = typeof p.path[p.path.length - 1] === "number";
      const shown = laneText(named, inList ? undefined : "then acts");
      out.push({
        key: p.path.join("."), path: p.path, kind: p.kind, what: words.what(p.name, p), restart: p.restart,
        // Only a model's, a key's and lending's lane can be none; a hold's lane and a condition's never can.
        value: named.length === 1 ? named[0]! : "", text: shown.text, editable: named.length === 1 || (named.length === 0 && laneCanClear(p.kind)),
        canClear: laneCanClear(p.kind), lanes: pinLanes(knobs.draft, p.kind),
        write: (lane) => knobs.change(p.path, lane),
      });
    }
  }
  return out;
}

const applies = (restart: boolean): ReactNode => (restart ? <Restart /> : <Pill tone="accent">live</Pill>);
const DEFAULT_TITLE = "the parser works this lane out of the lanes the file has: move it by moving a lane, or setting lending's";

/**
 * Everything in the file that names a lane, and the three lanes the parser works out for the work
 * that names none. A route's and a hold's lane are built once at boot, so those rows wait for a
 * restart; the rest apply live.
 */
export function PinsTab({ knobs, sel, pick }: { knobs: Knobs; sel: Sel | null; pick: Pick }) {
  const rows = pinRows(knobs);
  const defaults = useStore((s) => s.data?.scheduler.defaults ?? null);
  return (
    <Table head={["what names a lane", "lane", "applies"]}>
      {LANE_DEFAULT_WORDS.map(({ key, what, restart }) => (
        <PickRow key={key} on={same(sel, "pin", `default:${key}`)} edited={false} onPick={() => pick({ kind: "pin", id: `default:${key}` })}
                 name={<span className="text-[12px]">{what}<span className={cx(mono, "ml-1.5 text-dim")}>default</span></span>}>
          <td className={cx(TD, mono)} title={DEFAULT_TITLE}>{defaults === null ? "—" : defaults[key]}</td>
          <td className={TD}>{applies(restart)}</td>
        </PickRow>
      ))}
      {rows.map((r) => (
        <PickRow key={r.key} on={same(sel, "pin", r.key)} edited={editedAt(knobs.base, knobs.draft, r.path)} onPick={() => pick({ kind: "pin", id: r.key })}
                 name={<span className="text-[12px]">{r.what}</span>}>
          <td className={cx(TD, mono, r.value === "" && "text-dim")}>{r.value === "" ? r.text : r.value}</td>
          <td className={TD}>{applies(r.restart)}</td>
        </PickRow>
      ))}
    </Table>
  );
}

export function PinInspector({ knobs, id }: { knobs: Knobs; id: string }) {
  const defaults = useStore((s) => s.data?.scheduler.defaults ?? null);
  const fixed = LANE_DEFAULT_WORDS.find((d) => `default:${d.key}` === id);
  if (fixed !== undefined) {
    return (
      <Inspect title="a lane default" sub={fixed.what}>
        <Fields>
          <Field label="lane" title={DEFAULT_TITLE}><span className={mono}>{defaults === null ? "—" : defaults[fixed.key]}</span></Field>
          <Field label="applies">{applies(fixed.restart)}</Field>
        </Fields>
      </Inspect>
    );
  }
  const r = pinRows(knobs).find((p) => p.key === id);
  if (r === undefined) return <Inspect title="a lane pin" sub="Not in the draft." />;
  return (
    <Inspect title={r.what} sub="A route's, a model's and a rule step's lane beats the key's, and the key's beats the request's.">
      <Fields>
        <Field label="lane" id={r.editable ? "pin-lane" : undefined}>
          {r.editable
            ? <LaneMenu id="pin-lane" label={r.what} value={r.value} lanes={r.lanes} canClear={r.canClear} edited={editedAt(knobs.base, knobs.draft, r.path)} onChange={r.write} />
            : <span className={cx(mono, "text-dim")}>{r.text}</span>}
        </Field>
        <Field label="applies">{applies(r.restart)}</Field>
      </Fields>
    </Inspect>
  );
}

/* -------------------------------------------------------------------- tabs */

/** Each editing tab's count, and whether the draft holds an edit of its, so a change is never out of sight. */
export function sectionFacts(knobs: Knobs, peers: string | null): Record<"models" | "callers" | "backends" | "pins", { count: number; edited: boolean }> {
  const models = modelRows(knobs.draft, "", knobs.file.doc ?? {});
  const callers = callerRows(knobs.draft, peers);
  const backends = backendRows(knobs.draft);
  // Every pin's path, one set to none included, so a menu that moved one marks the tab.
  const pins = pinRowsOf(knobs.draft, knobs.base);
  return {
    models: { count: models.length, edited: models.some((r) => editedIn(knobs.base, knobs.draft, modelPaths(r))) },
    callers: { count: callers.length, edited: callers.some((r) => editedIn(knobs.base, knobs.draft, callerPaths(r.caller))) },
    backends: { count: backends.length, edited: editedIn(knobs.base, knobs.draft, [DEFAULTS_PATH, ...backends.map((r) => r.jobsPath), ...backends.flatMap((r) => (r.idlePath === null ? [] : [r.idlePath]))]) },
    pins: { count: pins.length, edited: editedIn(knobs.base, knobs.draft, pins.map((p) => p.path)) },
  };
}
