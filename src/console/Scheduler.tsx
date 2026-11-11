/**
 * The Scheduler page: every setting that changes which job runs next or how many run at once, over
 * one draft of hearth.yaml written through the same review as the Config page. The lanes are a board
 * of slots drawn from what the node runs now; a lane or a row opens in the inspector beside it, the
 * one place a value is typed; the jobs, models, callers, backends, pins and history are tabs under it.
 */
import { Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { Review, type File, type Plan } from "./config.js";
import { FIELDS, humanMs } from "../config/fields.js";
import { History } from "./pages.js";
import { BackendInspector, BackendsTab, CallerInspector, CallersTab, jobOrder, JobInspector, JobsTab, ModelInspector, ModelsTab, PinInspector, PinsTab, same, sectionFacts, type Pick, type Sel } from "./Sections.js";
import { boardOrder, boardSlots, changeWords, draftLanes, editedAt, knobOps, laneCeilings, laneNameError, lanePosition, laneRows, laneStatus, laneTags, laneTracks, lanesWithoutPriority, numberText, ORDER_KEYS, orderChip, PIN_WORDS, pinsOf, priorityGaps, removalBlock, reviewNotes, seeded, slotSummary, valueAt, waitingOn, type Doc, type LaneRow, type OrderKey, type Path, type SlotsOf, type Track } from "./knobs.js";
import { changeDraft, discardDraft, dirty, dropDraft, markUnread, takeFile, takeSaved, useSched } from "./schedStore.js";
import { request, toast, useLink, useStore } from "./store.js";
import type { LaneDefaults } from "../observe/uidata.js";
import { ago, Button, Card, cx, Empty, mono } from "./ui.js";

/** True once mounted: the file behind a draft is fetched in the browser, never while rendering for the server. */
const useMounted = (): boolean => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
};

/** Draws again every second, for a view that says how long a job has run or waited. */
export function useTick(): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

export const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

/* ------------------------------------------------------------------ knobs */

export type Knobs = {
  /** The file as it is on disk, and the draft seeded from it. */
  file: File;
  base: Doc;
  draft: Doc;
  change(path: Path, value: unknown): void;
  edited(path: Path): boolean;
  dirty: boolean;
  /** How many values differ from the file. */
  changes: number;
  review(): Promise<void>;
  discard(): void;
  plan: Plan | null;
  closePlan(): void;
  /** Why the last write or dry run was refused, or why the file could not be read, as the node said it. */
  err: string | null;
};

const KnobsCtx = createContext<Knobs | null>(null);
/** The page's draft; anything drawn under the page edits the one file. */
export const useKnobs = (): Knobs => useContext(KnobsCtx)!;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The file as the node serves it, with the draft it starts. The frame is read now, so a new frame alone reads nothing. */
async function readFile(): Promise<[File, Doc]> {
  const f = await request<File>("GET", "/config");
  return [f, seeded(f.doc ?? {}, useStore.getState().data!.scheduler)];
}

/**
 * The one draft of hearth.yaml the page edits, kept in `schedStore` so it outlives a walk to another
 * page. It starts from the file as the node would run it, so a file that writes no lanes shows none
 * as edited; nothing is written until it is reviewed, and a refused write says why and leaves the
 * draft alone. `err` is set when the draft could not be started: the file could not be read, and the
 * page says so instead of waiting on a draft that never comes.
 */
export function useKnobsPage(): { knobs: Knobs | null; err: string | null } {
  const mounted = useMounted();
  const hash = useStore((s) => s.data!.config.hash);
  const file = useSched((s) => s.file);
  const base = useSched((s) => s.base);
  const draft = useSched((s) => s.draft);
  const unread = useSched((s) => s.unread);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  // Bumped when a draft is dropped, so the page reads the file again.
  const [reads, setReads] = useState(0);

  useEffect(() => {
    if (!mounted) return;
    let live = true;
    void readFile().then(([f, start]) => {
      if (live) takeFile(f, start);
    }, (e: unknown) => { if (live) markUnread(message(e)); });
    return () => { live = false; };
  }, [mounted, reads]);

  // An edit made elsewhere moves the hash: follow it while there is nothing here to lose, and once
  // the edits are gone. A draft with edits stays on the file it was built on, so its write is refused.
  const edited = useSched(dirty);
  const fileHash = file?.hash;
  useEffect(() => {
    if (!mounted || fileHash === undefined || edited || hash === fileHash) return;
    void readFile().then(([f, start]) => takeFile(f, start), () => { /* the next hash says what became of it */ });
  }, [hash, fileHash, edited, mounted]);

  const why = err ?? unread;
  if (!file || base === null || draft === null) return { knobs: null, err: why };
  const ops = knobOps(file.doc ?? {}, base, draft);
  const clear = () => {
    discardDraft();
    setErr(null);
    // The file may have moved under the edits: the page follows it rather than the draft's old base.
    void readFile().then(([f, start]) => takeFile(f, start), (e: unknown) => setErr(message(e)));
  };
  return { err: why, knobs: {
    file, base, draft, err: why, plan,
    change: changeDraft,
    edited: (path) => editedAt(base, draft, path),
    dirty: ops.length > 0,
    changes: ops.length,
    discard: clear,
    closePlan: () => setPlan(null),
    review: async () => {
      if (ops.length === 0) return;
      try {
        const dry = await request<{ text: string; restartPending: string[]; defaults?: { before: LaneDefaults; after: LaneDefaults } }>(
          "PATCH", "/config", { baseHash: file.hash, ops, dryRun: true });
        setErr(null);
        setPlan({
          before: file.text, after: dry.text, restartPending: dry.restartPending,
          notes: reviewNotes(base, draft, dry.defaults), naming: true, verb: "apply",
          commit: async (name?: string) => {
            let out: { restartPending: string[] };
            try {
              out = await request<{ restartPending: string[] }>("PATCH", "/config", { baseHash: file.hash, ops, ...(name ? { name } : {}) });
            } catch (e) {
              setPlan(null);
              setErr(message(e));
              return;
            }
            toast("ok", out.restartPending.length ? `saved — restart to apply ${out.restartPending.join(", ")}` : "saved and applied");
            setPlan(null);
            setErr(null);
            // The saved file is the new start, and the draft is done with whatever it held.
            try {
              takeSaved(...(await readFile()));
            } catch (e) {
              dropDraft(`saved, but hearth.yaml could not be read back: ${message(e)}`);
              setReads((n) => n + 1);
            }
          },
        });
      } catch (e) {
        setErr(message(e));
      }
    },
  } };
}

/* ------------------------------------------------------------- the inspector's parts */

/**
 * A number field: a whole number or a decimal, an empty field what `none` says. `edited` marks a value
 * the draft holds and the file does not, with the accent border and tint every edited field wears.
 */
export function Num({ value, label, min, none, title, id, edited = false, onSave }: {
  value: number | null | undefined; label: string; min?: number; none: string; title?: string; id?: string; edited?: boolean; onSave: (n: number | null) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    setText(null);
    const clean = text.trim();
    if (clean === "") { if (value !== null && value !== undefined) onSave(null); return; }
    const n = Number(clean.replace(/[,_\s]/g, ""));
    if (!Number.isFinite(n) || (min !== undefined && n < min)) return toast("bad", `${label} must be a number${min !== undefined ? ` of ${min} or more` : ""}`);
    if (n !== value) onSave(n);
  };
  return (
    <input id={id} aria-label={label} title={title} inputMode="decimal" placeholder={none}
           value={text ?? (typeof value === "number" ? numberText(value) : "")}
           onChange={(e) => setText(e.target.value)} onBlur={commit}
           onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setText(null); }}
           className={cx("h-7 w-24 rounded-md border px-1.5 tabular placeholder:text-dim focus-visible:outline-2 focus-visible:outline-accent", mono,
             edited ? "border-accent bg-accent/10" : "border-line bg-bg")} />
  );
}

/** The inspector's heading and the one dim line under it. */
export function Inspect({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-w-0">
      <h2 className="truncate text-[14px] font-semibold">{title}</h2>
      {sub !== undefined && <div className="mt-0.5 text-dim">{sub}</div>}
      {children !== undefined && <div className="mt-2">{children}</div>}
    </div>
  );
}

export function Fields({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-line">{children}</div>;
}

/** One labelled value of the inspector. A field's longer explanation is its label's tooltip. */
export function Field({ label, id, title, note, children }: { label: string; id?: string; title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="py-1.5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        {id === undefined
          ? <span className="shrink-0 text-dim" title={title}>{label}</span>
          : <label htmlFor={id} className="shrink-0 text-dim" title={title}>{label}</label>}
        <div className="flex min-w-0 items-center justify-end gap-1.5">{children}</div>
      </div>
      {note}
    </div>
  );
}

/** A sub-heading inside the inspector. */
const SUB = "mb-1.5 mt-4 text-[11px] text-dim";

/* ------------------------------------------------------------------ the board */

const TONE = { warn: "text-warn", info: "text-info", dim: "text-dim" } as const;
const NO_BACKENDS: SlotsOf[] = [];

/** The lanes as the board draws them: the draft's, with what the node runs in each, and `warm` last. */
function useBoardRows(): LaneRow[] {
  const k = useContext(KnobsCtx);
  const view = useStore((s) => s.data!.scheduler);
  const jobs = useStore((s) => s.data!.q.jobs);
  // The draft decides which lanes are rows, so one just added is drawn before it is saved.
  // Without one, what the node runs is what there is.
  return boardOrder(draftLanes(laneRows(view, jobs), k?.draft ?? null));
}

/** The gap between two slots, in pixels: narrower the more slots a track has. */
const gapOf = (slots: number): number => (slots > 24 ? 1 : slots > 12 ? 2 : 3);

/** A ceiling's line over a track, with its number above it. A faint line is a draft's, not yet applied. */
function Ceiling({ at, slots, n, faint = false, dashed = false }: { at: number; slots: number; n: number; faint?: boolean; dashed?: boolean }) {
  const gap = gapOf(slots);
  // The line sits in the gap after the `at`th slot; a ceiling past the last slot sits at the track's end.
  const end = at >= slots;
  const left = end ? "calc(100% - 2px)" : `calc(${(at / slots) * 100}% + ${(at * gap) / slots - gap / 2 - 1}px)`;
  return (
    <span aria-hidden className={cx("absolute -bottom-1 -top-1 w-0.5 rounded-sm", dashed ? "border-l-2 border-dashed border-fg" : faint ? "bg-fg/35" : "bg-fg")} style={{ left }}>
      {/* At the track's end the number sits inside it, so nothing is cut off at the board's edge. */}
      <span className={cx("absolute -top-3.5 text-[10px] leading-none tabular", end ? "right-0" : "left-1/2 -translate-x-1/2", faint ? "text-dim/60" : "text-dim")}>{n}</span>
    </span>
  );
}

/** One backend's slots for one lane: what runs, the ceiling, and a chip for each job that waits. */
function TrackView({ t, ceiling, label }: { t: Track; ceiling: ReturnType<typeof laneCeilings>; label: string | null }) {
  const gap = gapOf(t.slots);
  const chips = t.waiting + t.held;
  const shown = Math.min(chips, 8);
  return (
    <span className="block min-w-0" style={{ flex: `${t.slots} 1 0` }}
          title={`${t.backend}: ${t.running} of ${t.slots} ${t.slots === 1 ? "slot" : "slots"} running in this lane${t.waiting ? `, ${t.waiting} waiting` : ""}${t.held ? `, ${t.held} held by a key` : ""}`}>
      <span className="relative block">
        <span className="grid h-[18px]" style={{ gridTemplateColumns: `repeat(${t.slots}, minmax(0, 1fr))`, gap }}>
          {Array.from({ length: t.slots }, (_, i) => (
            <span key={i} className={cx("rounded-[3px] transition-colors duration-300 ease-out motion-reduce:transition-none", i < t.running ? "bg-accent" : "bg-line")} />
          ))}
        </span>
        {ceiling.live !== null && <Ceiling at={ceiling.live} slots={t.slots} n={ceiling.live} dashed={ceiling.changed && ceiling.draft === null} />}
        {ceiling.changed && ceiling.draft !== null && <Ceiling at={ceiling.draft} slots={t.slots} n={ceiling.draft} faint />}
      </span>
      <span className="mt-1 flex h-2.5 items-center gap-[3px] overflow-hidden">
        {label !== null && <span className="mr-1 shrink-0 font-mono text-[10px] leading-none text-dim">{label}</span>}
        {Array.from({ length: shown }, (_, i) => (
          <span key={i} className={cx("h-2 w-3.5 shrink-0 rounded-[2px] border", i < Math.min(t.waiting, shown) ? "border-warn" : "border-dashed border-info")} />
        ))}
        {chips > shown && <span className="shrink-0 text-[10px] leading-none text-dim tabular">+{chips - shown}</span>}
      </span>
    </span>
  );
}

/** One lane: who sends work there, its slots on each backend it runs on, and what it is doing. */
function LaneButton({ row, tracks, scale, on, onPick }: { row: LaneRow; tracks: Track[]; scale: number; on: boolean; onPick: () => void }) {
  const k = useContext(KnobsCtx);
  const view = useStore((s) => s.data!.scheduler);
  const jobs = useStore((s) => s.data!.q.jobs);
  const ceiling = laneCeilings(row.name, view, k?.draft ?? null);
  const status = laneStatus(row.name, jobs, ceiling.live);
  const tags = laneTags(row.name, view.defaults, k === null ? [] : pinsOf(k.draft));
  const edited = k !== null && k.edited(["scheduler", "lanes", row.name]);
  const used = tracks.reduce((n, t) => n + t.slots, 0);
  const line = row.builtIn ? "built in · preloads" : [...tags.shown, ...(tags.more > 0 ? [`+${tags.more}`] : [])].join(" · ");
  const count = ceiling.live === null ? `${row.running} running` : `${row.running} running, ${ceiling.live} at once${tracks.length > 1 ? " on each backend" : ""}`;
  return (
    <button type="button" aria-pressed={on} onClick={onPick} aria-label={`${row.name}, priority ${numberText(row.priority)}: ${count}, ${status.text}`}
            className={cx("grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1.5 px-4 py-2.5 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent @xl:grid-cols-[150px_minmax(0,1fr)_170px]",
              on ? "bg-muted" : edited && "bg-accent/5", row.builtIn && "opacity-60")}>
      <span className="block min-w-0">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-semibold">{row.name}</span>
          <span className="shrink-0 rounded border border-line px-1 text-[11px] leading-4 text-dim tabular" title="priority: the lowest number goes first">{numberText(row.priority)}</span>
          {!row.inFile && <span className="shrink-0 rounded bg-warn/20 px-1 text-[10px] text-warn" title="a lane the file does not have: its jobs still run, sorted last">not in the file</span>}
        </span>
        <span className="block truncate text-[11px] text-dim" title={[...tags.defaults, ...tags.pins].join(", ") || undefined}>{line || " "}</span>
      </span>
      <span className="col-span-2 row-start-2 flex min-w-0 overflow-hidden pt-[18px] @xl:col-span-1 @xl:row-start-auto">
        {tracks.length === 0 && <span className="text-[11px] text-dim">no backend</span>}
        {tracks.map((t, i) => (
          <span key={t.backend} className={cx("flex min-w-0", i > 0 && "ml-2")} style={{ flex: `${t.slots} 1 0` }}>
            <TrackView t={t} ceiling={ceiling} label={tracks.length > 1 ? t.backend : null} />
          </span>
        ))}
        {used < scale && tracks.length > 0 && <span aria-hidden style={{ flex: `${scale - used} 1 0` }} />}
      </span>
      <span className="block min-w-0 max-w-44 text-right @xl:max-w-none">
        <span className="block whitespace-nowrap text-[15px] font-semibold leading-5 tabular">
          {/* A ceiling counts on each backend apart, so a lane on several says its number is each one's. */}
          {row.running}<span className="text-[12px] font-normal text-dim">{ceiling.live === null ? " running" : ` / ${ceiling.live}${tracks.length > 1 ? " each" : ""}`}</span>
        </span>
        <span className={cx("block truncate text-[11px]", TONE[status.tone])} title={status.title ?? undefined}>{status.text}</span>
      </span>
    </button>
  );
}

function Board({ sel, pick }: { sel: Sel | null; pick: Pick }) {
  const k = useContext(KnobsCtx);
  const jobs = useStore((s) => s.data!.q.jobs);
  const backends = useStore((s) => s.data!.net.nodes.find((n) => n.self)?.backends) ?? NO_BACKENDS;
  const rows = useBoardRows();
  const slots: SlotsOf[] = backends.map((b) => ({ name: b.name, slots: b.slots }));
  const tracks = rows.map((r) => laneTracks(r.name, jobs, slots));
  const scale = boardSlots(tracks);
  const swatch = "inline-block h-2 w-3 shrink-0 rounded-[2px]";
  return (
    <Card className="@container min-w-0 overflow-hidden">
      <div className="divide-y divide-line py-1" role="group" aria-label="lanes, top goes first">
        {rows.map((r, i) => (
          <LaneButton key={r.name} row={r} tracks={tracks[i]!} scale={scale} on={same(sel, "lane", r.name)} onPick={() => pick({ kind: "lane", id: r.name })} />
        ))}
      </div>
      {rows.length === 0 && <Empty>No lanes yet: every request runs in the first one written here.</Empty>}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-line px-4 py-2 text-[11px] text-dim">
        <span className="inline-flex items-center gap-1.5"><i aria-hidden className={cx(swatch, "bg-accent")} />running</span>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden className={cx(swatch, "border border-warn")} />waiting</span>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden className={cx(swatch, "border border-dashed border-info")} />held by its key</span>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2.5 w-0.5 rounded-sm bg-fg" />ceiling</span>
        <span className="ml-auto">{`${slotSummary(slots)} · top goes first`}</span>
        {k !== null && (
          <button type="button" aria-pressed={same(sel, "add", "")} onClick={() => pick({ kind: "add", id: "" })}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-line px-2 text-fg hover:bg-muted focus-visible:outline-2 focus-visible:outline-accent">
            <Plus size={11} />lane
          </button>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ inspectors */

const LANE_FIELDS = { priority: FIELDS.lane.priority!, concurrency: FIELDS.lane.concurrency!, maxWaitMs: FIELDS.lane.maxWaitMs! };

/** One lane: its numbers, who sends work there, its jobs, and whether it can be taken out. */
function LaneInspector({ name, pick }: { name: string; pick: Pick }) {
  const k = useContext(KnobsCtx);
  const view = useStore((s) => s.data!.scheduler);
  const jobs = useStore((s) => s.data!.q.jobs);
  const pending = useStore((s) => s.data!.config.restartPending);
  const rows = useBoardRows();
  useTick();
  const row = rows.find((r) => r.name === name);
  if (row === undefined) return <Inspect title={name} sub="Not a lane any more: taken out in the draft." />;
  // Only a lane the file has, that hearth does not own, can be edited: the rest are shown for what they are.
  const editable = k !== null && row.inFile && !row.builtIn;
  const path = (key: keyof typeof LANE_FIELDS): Path => ["scheduler", "lanes", name, key];
  const at = (key: keyof typeof LANE_FIELDS, fallback: number | undefined): unknown => (editable ? valueAt(k.draft, path(key)) : fallback);
  const priority = at("priority", row.priority);
  const ceiling = at("concurrency", row.ceiling);
  const maxWait = at("maxWaitMs", row.maxWaitMs);
  // The file refuses a lane with no priority, so the field and the save strip say so first.
  const cleared = editable && lanesWithoutPriority(k.draft).includes(name);
  const pins = k === null ? [] : pinsOf(k.draft).filter((p) => p.lane === name);
  const tags = laneTags(name, view.defaults, pins);
  const blocked = editable ? removalBlock(name, pinsOf(k.draft), view.defaults, jobs, pending) : null;
  const here = jobOrder(jobs.filter((j) => j.lane === name));
  const text = (v: unknown, unit?: (n: number) => string): ReactNode => (typeof v === "number" ? <span className="tabular">{unit ? unit(v) : numberText(v)}</span> : <span className="text-dim">—</span>);
  return (
    <Inspect title={name} sub={<>{lanePosition(name, rows)}{!row.inFile && " Not in the file: its jobs still run, sorted last."}</>}>
      <Fields>
        <Field label="Priority" id={editable ? "lane-priority" : undefined} title={LANE_FIELDS.priority.desc}
               note={cleared && <div className="text-right text-[11px] text-bad">a lane needs a priority</div>}>
          {editable
            // A lane the file never gave a priority runs at the setting's own default, which is what the field shows.
            ? <Num id="lane-priority" value={priority as number | null} label={`${name}: priority`} edited={k.edited(path("priority"))} title={LANE_FIELDS.priority.desc}
                   none={String("def" in LANE_FIELDS.priority ? LANE_FIELDS.priority.def : 0)} onSave={(n) => k.change(path("priority"), n)} />
            : text(priority)}
        </Field>
        <Field label="At once" id={editable ? "lane-concurrency" : undefined} title={`${LANE_FIELDS.concurrency.desc} Counted on each backend apart; empty is no ceiling.`}>
          {editable
            ? <Num id="lane-concurrency" value={ceiling as number | null | undefined} label={`${name}: jobs at once`} min={1} none="any" edited={k.edited(path("concurrency"))}
                   title={LANE_FIELDS.concurrency.desc} onSave={(n) => k.change(path("concurrency"), n)} />
            : text(ceiling)}
        </Field>
        <Field label="Max wait" id={editable ? "lane-wait" : undefined} title={`${LANE_FIELDS.maxWaitMs.desc} Empty is no limit.`}>
          {editable ? (
            <>
              <Num id="lane-wait" value={typeof maxWait === "number" ? maxWait : null} label={`${name}: max wait`} edited={k.edited(path("maxWaitMs"))}
                   min={"min" in LANE_FIELDS.maxWaitMs ? LANE_FIELDS.maxWaitMs.min : undefined} none="none" title={LANE_FIELDS.maxWaitMs.desc}
                   onSave={(n) => k.change(path("maxWaitMs"), n)} />
              <span className="w-9 whitespace-nowrap text-[11px] text-dim">{typeof maxWait === "number" ? humanMs(maxWait) : "ms"}</span>
            </>
          ) : text(maxWait, humanMs)}
        </Field>
      </Fields>

      <div className={SUB}>Sends work here</div>
      <div className="flex flex-wrap gap-1.5">
        {row.builtIn && <span className="rounded-md border border-line px-1.5 text-[11px]">hearth, to load a model ahead of a request</span>}
        {tags.defaults.map((d) => <span key={d} className="rounded-md border border-line px-1.5 text-[11px]">{d}</span>)}
        {pins.map((p) => (
          <button key={p.path.join(".")} type="button" onClick={() => pick({ kind: "pin", id: p.path.join(".") })}
                  className={cx("max-w-full truncate rounded-md border border-line px-1.5 text-[11px] hover:border-dim focus-visible:outline-2 focus-visible:outline-accent", mono)}>
            {PIN_WORDS[p.kind](p.name, p)}
          </button>
        ))}
        {!row.builtIn && tags.defaults.length === 0 && pins.length === 0 && <span className="text-[12px] text-dim">nothing in the file, only requests that name it</span>}
      </div>

      <div className={SUB}>Jobs</div>
      {here.length === 0 ? <div className="text-[12px] text-dim">none running or waiting</div> : (
        <div className="divide-y divide-line">
          {here.slice(0, 12).map((j) => {
            const why = waitingOn(j, jobs);
            const state = j.state === "running" ? `running ${ago(j.since)}${j.offbox ? ` on ${j.peer}` : ""}` : j.held === "key" ? "held by its key" : `#${j.position + 1} ${why ?? "queued"}`;
            return (
              <button key={j.id} type="button" onClick={() => pick({ kind: "job", id: j.id })} title={why ?? undefined}
                      className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)] gap-2 py-1 text-left text-[12px] hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-accent">
                <span className={cx("truncate", mono)}>{j.model}</span>
                <span className="truncate text-dim">{j.caller}</span>
                <span className={cx("truncate text-right tabular", j.state === "running" ? "text-fg" : j.held === "key" ? "text-info" : "text-warn")}>{state}</span>
              </button>
            );
          })}
          {here.length > 12 && <div className="py-1 text-[11px] text-dim">and {here.length - 12} more, in the Jobs tab</div>}
        </div>
      )}

      {editable && (
        // Why a lane cannot go is said in words: a disabled button's tooltip is not read on a keyboard.
        blocked !== null
          ? <div className="mt-4 text-[11px] leading-4 text-dim">{blocked}</div>
          : <div className="mt-4"><Button onClick={() => { k.change(["scheduler", "lanes", name], null); pick(null); }}><Trash2 size={13} />remove {name}</Button></div>
      )}
    </Inspect>
  );
}

/** What each order setting's field is called beside its number. */
const ORDER_LABEL: Record<OrderKey, string> = { agePerSecond: "per second waited", warmBonus: "bonus", maxPerLane: "jobs a lane may queue", maxPerCaller: "jobs per caller" };

/**
 * One order setting with its one-line meaning. The field shows the number the running node uses, not
 * the one `fields.ts` falls back to: a default there is a sentence ("0, or 2 with apiKeys") where the
 * node has already worked out the value.
 */
function OrderInspector({ id }: { id: OrderKey }) {
  const k = useContext(KnobsCtx);
  const current = useStore((s) => s.data!.scheduler.order[id]);
  const f = FIELDS.scheduler[id]!;
  const path: Path = ["scheduler", id];
  const title = id === "maxPerCaller"
    ? `${f.desc} It is counted in each lane on each backend. A key's own jobs at once waits instead: it holds those jobs and starts them when the limit frees a place.`
    : f.desc;
  return (
    <Inspect title={<span className={mono}>{id}</span>} sub={f.desc}>
      <Fields>
        <Field label={ORDER_LABEL[id]} id={k === null ? undefined : "order-value"} title={title}>
          {k === null ? <span className="tabular">{numberText(current)}</span> : (
            // A field holding a value says what emptying it runs; one that is empty says the same thing.
            <Num id="order-value" value={valueAt(k.draft, path) as number | null} label={id} min={"min" in f ? f.min : undefined} none={String(current)}
                 edited={k.edited(path)} title={`left empty, the node runs ${current}`} onSave={(n) => k.change(path, n)} />
          )}
        </Field>
      </Fields>
    </Inspect>
  );
}

/** The box that names a new lane. It goes last in the file, so the lane unlanded work runs in never moves. */
function AddInspector({ pick }: { pick: Pick }) {
  const k = useKnobs();
  const [name, setName] = useState("");
  const problem = laneNameError(name, k.draft);
  const add = () => {
    if (problem !== null || name.trim() === "") return;
    const clean = name.trim();
    k.change(["scheduler", "lanes", clean, "priority"], 0);
    pick({ kind: "lane", id: clean });
  };
  return (
    <Inspect title="New lane" sub="Added last in the file, at priority 0.">
      <Fields>
        <Field label="Name" id="new-lane" note={name !== "" && problem !== null && <div className="text-right text-[11px] text-bad">{problem}</div>}>
          <input id="new-lane" autoFocus aria-label="name for a new lane" placeholder="lane name" maxLength={40} value={name}
                 onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") pick(null); }}
                 className={cx("h-7 w-40 rounded-md border bg-bg px-2 focus-visible:outline-2 focus-visible:outline-accent", mono, problem !== null && name !== "" ? "border-bad" : "border-line")} />
        </Field>
      </Fields>
      <div className="mt-3 flex gap-2">
        <Button tone="primary" disabled={problem !== null} onClick={add}><Plus size={13} />add lane</Button>
        <Button onClick={() => pick(null)}>cancel</Button>
      </div>
    </Inspect>
  );
}

function InspectorFor({ sel, pick }: { sel: Sel | null; pick: Pick }) {
  const k = useContext(KnobsCtx);
  if (sel === null) return <div className="py-4 text-center text-dim">Pick a lane or a row to see it here.</div>;
  if (sel.kind === "lane") return <LaneInspector name={sel.id} pick={pick} />;
  if (sel.kind === "order") return <OrderInspector id={sel.id as OrderKey} />;
  if (sel.kind === "job") return <JobInspector id={sel.id} pick={pick} />;
  // Every other row is a value of the file, which there is none of to show without a draft.
  if (k === null) return <div className="py-4 text-center text-dim">Pick a lane or a row to see it here.</div>;
  if (sel.kind === "add") return <AddInspector pick={pick} />;
  if (sel.kind === "model") return <ModelInspector knobs={k} id={sel.id} />;
  if (sel.kind === "caller") return <CallerInspector knobs={k} id={sel.id} />;
  if (sel.kind === "backend") return <BackendInspector knobs={k} id={sel.id} />;
  return <PinInspector knobs={k} id={sel.id} />;
}

/* ------------------------------------------------------------------ the page */

/** The page's title, and the order settings as chips that open in the inspector. */
function TitleRow({ sel, pick }: { sel: Sel | null; pick: Pick }) {
  const k = useContext(KnobsCtx);
  const view = useStore((s) => s.data!.scheduler);
  const value = (key: OrderKey): number => (k === null ? view.order[key] : num(valueAt(k.draft, ["scheduler", key]), view.order[key]));
  // The order settings and the lanes are one draft, so the overtake sum follows a priority edited on a lane.
  const priorities = k === null ? laneRows(view, []).filter((r) => !r.builtIn).map((r) => r.priority) : priorityGaps(laneRows(view, []), k.draft);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 className="text-[16px] font-semibold">Scheduler</h1>
      <div role="group" aria-label="order settings" className="flex flex-wrap gap-1.5">
        {ORDER_KEYS.map((key) => {
          const chip = orderChip(key, value(key), priorities);
          const edited = k !== null && k.edited(["scheduler", key]);
          return (
            <button key={key} type="button" aria-pressed={same(sel, "order", key)} title={`${key}: ${FIELDS.scheduler[key]!.desc}`} onClick={() => pick({ kind: "order", id: key })}
                    className={cx("h-7 whitespace-nowrap rounded-md border px-2 text-[12px] hover:border-dim focus-visible:outline-2 focus-visible:outline-accent",
                      edited ? "border-accent bg-accent/10" : "border-line", same(sel, "order", key) && !edited && "bg-muted")}>
              {chip.lead}<b className="font-semibold tabular">{chip.value}</b>{chip.tail}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What is waiting to be written, with the review that writes it, held at the top of the page while it
 * scrolls. Why the last write was refused is said here too, so it is never out of view.
 */
function SaveStrip() {
  const k = useKnobs();
  const noNumber = lanesWithoutPriority(k.draft);
  const words = changeWords(k.base, knobOps(k.file.doc ?? {}, k.base, k.draft)).map((w) => ({ ...w, said: `${w.what} ${w.change}` }));
  const what = words.length === 0 ? "" : `${words.slice(0, 3).map((w) => w.said).join(" · ")}${words.length > 3 ? ` · ${words.length - 3} more` : ""} · ${words.some((w) => w.restart) ? "some wait for a restart" : "applies live"}`;
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-line bg-panel px-3 py-1.5 shadow-sm">
      {k.dirty
        ? <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-accent"><span className="size-1.5 rounded-full bg-accent" />{`${k.changes} ${k.changes === 1 ? "change" : "changes"}`}</span>
        : <span className="shrink-0 text-[12px] text-dim">No changes</span>}
      {k.err !== null
        ? <span role="alert" className="min-w-0 flex-1 text-[12px] text-bad">{k.err}</span>
        : noNumber.length > 0
          ? <span className="min-w-0 flex-1 text-[12px] text-bad">{noNumber.join(", ")} {noNumber.length === 1 ? "has" : "have"} no priority: give it a number first.</span>
          : <span className="min-w-0 flex-1 truncate text-[12px] text-dim" title={words.map((w) => w.said).join("\n") || undefined}>{what}</span>}
      <div className="ml-auto flex shrink-0 gap-2">
        <Button disabled={!k.dirty} onClick={k.discard}><RotateCcw size={13} />discard</Button>
        <Button tone="primary" disabled={!k.dirty || noNumber.length > 0} onClick={() => void k.review()}><Save size={13} />review &amp; apply</Button>
      </div>
    </div>
  );
}

type Tab = "jobs" | "models" | "callers" | "backends" | "pins" | "history";

/** The tables under the board, one tab at a time, each with its count and a mark while it holds an edit. */
function Tabs({ sel, pick }: { sel: Sel | null; pick: Pick }) {
  const k = useContext(KnobsCtx);
  const [tab, setTab] = useState<Tab>("jobs");
  const jobs = useStore((s) => s.data!.q.jobs.length);
  const calls = useStore((s) => s.data!.calls?.length ?? 0);
  const peers = useStore((s) => s.data!.scheduler.defaults.peers);
  const facts = k === null ? null : sectionFacts(k, peers);
  // Without a draft there is no file to show, so only what the node itself knows is a tab.
  const list: { id: Tab; label: string; count: number; edited: boolean }[] = [
    { id: "jobs", label: "Jobs", count: jobs, edited: false },
    ...(facts === null ? [] : [
      { id: "models" as const, label: "Models", ...facts.models },
      { id: "callers" as const, label: "Callers", ...facts.callers },
      { id: "backends" as const, label: "Backends", ...facts.backends },
      { id: "pins" as const, label: "Lane pins", ...facts.pins },
    ]),
    { id: "history", label: "History", count: calls, edited: false },
  ];
  const shown = list.some((t) => t.id === tab) ? tab : "jobs";
  return (
    <Card className="min-w-0 overflow-hidden">
      <div role="tablist" aria-label="scheduler tables" className="flex overflow-x-auto px-2 shadow-[inset_0_-1px_0_var(--border)]">
        {list.map((t) => (
          <button key={t.id} type="button" role="tab" id={`sched-tab-${t.id}`} aria-selected={shown === t.id} aria-controls="sched-panel" onClick={() => setTab(t.id)}
                  className={cx("flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                    shown === t.id ? "border-accent text-fg" : "border-transparent text-dim hover:text-fg")}>
            {t.label}<span className="text-[11px] text-dim tabular">{t.count}</span>
            {t.edited && <span className="size-1.5 rounded-full bg-accent" title="holds an unsaved change" />}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="sched-panel" aria-labelledby={`sched-tab-${shown}`}>
        {shown === "jobs" && <JobsTab sel={sel} pick={pick} />}
        {k !== null && shown === "models" && <ModelsTab knobs={k} sel={sel} pick={pick} />}
        {k !== null && shown === "callers" && <CallersTab knobs={k} sel={sel} pick={pick} />}
        {k !== null && shown === "backends" && <BackendsTab knobs={k} sel={sel} pick={pick} />}
        {k !== null && shown === "pins" && <PinsTab knobs={k} sel={sel} pick={pick} />}
        {shown === "history" && <History />}
      </div>
    </Card>
  );
}

/**
 * The page over one draft, or over the node's own frame while there is none: a file the reader has no
 * key for, or one that could not be read, still draws every lane and job, read-only, with why.
 */
function Page({ knobs, err }: { knobs: Knobs | null; err: string | null }) {
  const [sel, setSel] = useState<Sel | null>(null);
  // A lane or an order setting is linked as `<kind>:<name>`; the other picks are not kept in the address.
  useLink(sel && (sel.kind === "lane" || sel.kind === "order") ? [`${sel.kind}:${sel.id}`] : [], knobs !== null || err !== null, ([at = ""]) => {
    const [kind, ...rest] = at.split(":");
    const id = rest.join(":");
    const lane = useStore.getState().data!.scheduler.lanes.some((l) => l.name === id) || (knobs !== null && valueAt(knobs.draft, ["scheduler", "lanes", id]) !== undefined);
    if (kind === "lane" ? lane : kind === "order" && (ORDER_KEYS as readonly string[]).includes(id)) setSel({ kind: kind as "lane" | "order", id });
  });
  const insp = useRef<HTMLDivElement>(null);
  // Below the width where the inspector sits beside the board, a pick out of its sight brings it into view.
  useEffect(() => {
    const el = insp.current;
    if (sel === null || el === null || matchMedia("(min-width: 1280px)").matches) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.top > innerHeight - 120) el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [sel]);
  return (
    <KnobsCtx.Provider value={knobs}>
      <div className="flex flex-col gap-3 pb-2">
        <TitleRow sel={sel} pick={setSel} />
        {knobs !== null ? <SaveStrip /> : (
          <div className={cx("rounded-xl border px-4 py-2 text-[12px]", err === null ? "border-line text-dim" : "border-warn bg-warn/10 text-warn")}>
            {err ?? "reading hearth.yaml…"}
          </div>
        )}
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Board sel={sel} pick={setSel} />
          {/* Beside the board the inspector takes the board's height and scrolls, so a long one leaves no gap under the board. */}
          <div ref={insp} className="min-w-0 scroll-mt-28 xl:relative xl:min-h-[22rem] xl:self-stretch">
            <Card className="overflow-y-auto px-4 py-3.5 xl:absolute xl:inset-0">
              <InspectorFor key={sel === null ? "" : `${sel.kind}:${sel.id}`} sel={sel} pick={setSel} />
            </Card>
          </div>
        </div>
        <Tabs sel={sel} pick={setSel} />
      </div>
      {knobs?.plan && <Review plan={knobs.plan} onClose={knobs.closePlan} />}
    </KnobsCtx.Provider>
  );
}

export function Scheduler() {
  const { knobs, err } = useKnobsPage();
  const path = useStore((s) => s.data!.config.path);
  if (!path) return <Card className="p-6 text-dim">This node was not loaded from a config file, so there is no scheduler setting to edit here.</Card>;
  return <Page knobs={knobs} err={err} />;
}
