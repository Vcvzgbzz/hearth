/**
 * The routing map's draft of hearth.yaml and what is selected on it. Drawing lines and the forms
 * change the draft; nothing is written until it goes through the same review as the Config page.
 */
import { create } from "zustand";

import type { Err, File, Plan } from "./config.js";
import { factsOf, nodeOf, obj, opsOf, placed, problems, put, rebase, refusal, removed, TEMPLATES, type Doc, type Facts, type Landing } from "./draft.js";
import { request, RequestError, toast, useStore } from "./store.js";

export type EditSel = { kind: "flow" | "action"; id: string } | null;
/** A request to try against the draft, and where it went. */
export type Trial = { model: string; images: boolean; tools: boolean; long: boolean; caller?: string; lane?: string; /** State to pretend, as `<what>:<model>` (idle, used, busy, warm or held) or `now:<HH:MM>`. */ pretend?: string[] };
export type Tried = { target: string; model: string; reason: string; backend?: string; peer?: string; path: { flow: string; step: number }[]; /** The actions it would set off. */ actions?: string[]; error?: string; /** Why the backend it reaches would turn this request down, when what is known says it would. */ unfit?: string };
/** A list of places to send a wire, open at a point on the page. `from` is the outlet it was dragged from. */
export type Picking = { x: number; y: number; from: { node: string; handle: string | null } | null } | null;
/** One choice in a menu; `head` is a label between groups, `on` marks the current one. */
export type Choice = { label: string; value?: string; hint?: string; head?: boolean; on?: boolean; off?: boolean; danger?: boolean; mono?: boolean };
/** A list of choices open at a point on the page. */
export type Choosing = { x: number; y: number; items: Choice[]; onPick: (value: string) => void; /** Always offer the filter, however short the list. */ search?: boolean } | null;

interface EditState {
  file: File | null;
  draft: Doc | null;
  sel: EditSel;
  err: Err | null;
  plan: Plan | null;
  trial: Trial | null;
  tried: Tried | null;
  picking: Picking;
  choosing: Choosing;
  /** Names typed onto the node that go nowhere yet: they exist in the file once they are wired. */
  pending: string[];
  /** The line under the pointer, by the start of its id, so it can be told from the ones it crosses. */
  hover: string | null;
  /** Drafts to go back to, oldest first. */
  past: Doc[];
  /** Why there is no draft to edit, once that is known; null while one is loaded or still loading. */
  unread: string | null;
  /** The dialog that names a new thing: `flows`, or `actions:<kind>`. */
  adding: string | null;
  /** A node to bring into view, or `*` for the whole map; a new object each time so asking twice works. */
  focus: { node: string } | null;
}

export const useEdit = create<EditState>(() => ({
  file: null, draft: null, sel: null, err: null, plan: null, trial: null, tried: null, picking: null, choosing: null, pending: [], hover: null, past: [], unread: null, adding: null, focus: null,
}));
const set = useEdit.setState;
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

// A draft outlives a reload: it is kept beside the file it was made on, and carried over if that file has moved since.
const KEPT = "hearth.draft";
const keep = (s: Pick<EditState, "file" | "draft">): void => {
  // With no file read there is nothing to compare a draft with: what was kept stays kept.
  if (!s.file) return;
  try {
    if (s.file?.doc && s.draft && dirty(s)) sessionStorage.setItem(KEPT, JSON.stringify({ base: s.file.doc, draft: s.draft }));
    else sessionStorage.removeItem(KEPT);
  } catch { /* storage is a convenience: without it a reload starts from the file */ }
};
// Every change to the draft is one step back for undo, and is kept across a reload.
let stepping = false;
useEdit.subscribe((s, prev) => {
  if (s.draft === prev.draft) return;
  keep(s);
  if (!stepping && prev.draft && s.draft && s.file === prev.file) set({ past: [...s.past.slice(-99), prev.draft] });
});

/**
 * Read hearth.yaml. A draft nobody has touched becomes the file; one with changes is carried
 * over to the file as it is now, unless both changed the same setting.
 */
export async function loadDraft(): Promise<void> {
  let file: File;
  try {
    file = await request<File>("GET", "/config");
  } catch (e) {
    // What is being edited stays as it is; with nothing loaded yet, the map is a picture to look at and says why.
    if (!useEdit.getState().draft) set({ unread: `hearth.yaml could not be read (${said(e)}), so the map cannot be edited yet.` });
    return;
  }
  if (!file.doc) { set({ file: null, draft: null, unread: "This node's hearth.yaml does not load as it stands: fix it on the Config page, then routing can be edited here." }); return; }
  const now = useEdit.getState();
  let mine: { base: Doc; draft: Doc } | null = now.file?.doc && now.draft && dirty(now) ? { base: now.file.doc, draft: now.draft } : null;
  if (!mine && !now.file) {
    try { mine = JSON.parse(sessionStorage.getItem(KEPT) ?? "null") as typeof mine; } catch { mine = null; }
  }
  stepping = true;
  set({ unread: null });
  if (!mine) set({ file, draft: file.doc, err: null, plan: null, past: [] });
  else {
    const moved = rebase(mine.base, mine.draft, file.doc);
    if ("doc" in moved) set({ file, draft: moved.doc, err: null, plan: null });
    // Changes kept from before a reload that no longer fit the file are let go, and said so: there is nothing on screen to keep editing.
    else if (!now.draft) {
      try { sessionStorage.removeItem(KEPT); } catch { /* nothing kept, then */ }
      set({ file, draft: file.doc, err: null, plan: null, past: [] });
      toast("bad", `Unsaved changes from before could not be carried over: ${moved.clash} has changed in the file since.`);
    }
    else set({ err: { message: `Someone else changed ${moved.clash} while you were editing it. Discard your changes to see theirs, or keep editing and save over it from the Config page.`, path: null } });
  }
  stepping = false;
}

export const dirty = (s: Pick<EditState, "file" | "draft">) => JSON.stringify(s.file?.doc ?? null) !== JSON.stringify(s.draft);
/** How many things the draft changes: a rule, a backend, the layout each count once however much of them moved. */
export const changed = (s: Pick<EditState, "file" | "draft">): number =>
  s.file?.doc && s.draft ? new Set(opsOf(s.file.doc, s.draft).map((op) => op.path.slice(0, 2).join("."))).size : 0;
export const revert = () => { set((s) => ({ draft: s.file?.doc ?? null, err: null, pending: [], trial: null, tried: null })); toast("ok", "changes discarded — undo brings them back"); };
export function undo(): void {
  const { past } = useEdit.getState();
  if (past.length === 0) return;
  stepping = true;
  set({ draft: past.at(-1)!, past: past.slice(0, -1), err: null });
  stepping = false;
}
export const editSelect = (sel: EditSel) => set({ sel });
export const pick = (picking: Picking) => set({ picking });
export const hover = (id: string | null) => { if (useEdit.getState().hover !== id) set({ hover: id }); };
/** Open a menu under whatever was clicked. */
export function choose(e: { currentTarget: Element }, items: Choice[], onPick: (value: string) => void): void {
  const r = e.currentTarget.getBoundingClientRect();
  set({ choosing: { x: r.left, y: r.bottom + 4, items, onPick } });
}
/** Open a menu at a point on the page: where the pointer was right-clicked, say. */
export const chooseAt = (x: number, y: number, items: Choice[], onPick: (value: string) => void, search = false) => set({ choosing: { x, y, items, onPick, search } });
export const closeMenu = () => set({ choosing: null });
export const setAdding = (adding: string | null) => set({ adding });
/** Bring a node into view. */
export const focusOn = (node: string) => set({ focus: { node } });

/** Start a rule from one of the common shapes, or ask for the name of a blank one. */
export function startRule(template: string): void {
  const t = TEMPLATES.find((x) => x.name === template);
  const { draft } = useEdit.getState();
  if (!t || !draft) { set({ adding: "flows" }); return; }
  // A name that is free: the rule opens straight away, to be pointed at the models it is for.
  let name = t.name;
  for (let n = 2; name in obj(draft.flows); n++) name = `${t.name}-${n}`;
  change((d) => put(d, "flows", name, { inputs: [], steps: t.steps }));
  set({ sel: { kind: "flow", id: name }, focus: { node: `flow:${name}` } });
}

/** Take a rule or an action out of the draft, saying what else that touched. */
export function remove(sel: NonNullable<EditSel>): void {
  change((d) => removed(d, sel.kind === "flow" ? "flows" : "actions", sel.id));
  if (useEdit.getState().sel?.id === sel.id) set({ sel: null });
  toast("ok", `${sel.id} deleted — undo brings it back`);
}
export const change = (fn: (d: Doc) => Doc) => set((s) => ({ draft: s.draft ? fn(s.draft) : s.draft, err: null }));

/** What is known right now about names and the places a line can go, or null before the node has reported. */
export function facts(): Facts | null {
  const { draft } = useEdit.getState();
  const data = useStore.getState().data;
  return draft && data ? factsOf(draft, data) : null;
}

/**
 * Draw a line from an outlet to somewhere. What the outlet is, and so what the line changes, is
 * its node kind's to say; a line that what is known says cannot work is refused here, in a sentence.
 */
export function wire(from: { node: string; handle: string | null }, to: Landing): void {
  const { draft } = useEdit.getState();
  const start = nodeOf(from.node);
  const out = draft && start.kind.outlet?.(draft, start.id, from.handle);
  if (!draft || !out) return;
  let next: Doc | null;
  if (to.kind === "action") {
    if (!out.also) { toast("bad", "An action runs from a line of a rule: put this through a rule first, then draw the line's dot to the action."); return; }
    next = out.also(to.action);
  } else {
    const known = facts();
    const no = known && refusal(out.when, to, known, out.paths);
    if (no) { toast("bad", no); return; }
    next = out.send(to);
  }
  if (next) set((s) => ({ draft: next, err: null, pending: s.pending.filter((p) => p !== out.name) }));
}

/** A line let go over a node: whatever that node is as somewhere to end one. */
export function connect(from: { node: string; handle: string | null }, node: string): void {
  const end = nodeOf(node);
  const to = end.kind.lands?.(end.id);
  if (to) wire(from, to);
}

/** A name clients will ask for that nothing serves: listed on the node until it is sent somewhere. */
export const addName = (id: string) => set((s) => (id && !s.pending.includes(id) ? { pending: [...s.pending, id] } : {}));

/** Keep a node where it was dragged to. */
export function place(id: string, at: { x: number; y: number }): void {
  set((s) => ({ draft: s.draft ? placed(s.draft, id, at) : s.draft }));
}

/** Ask the node where a request would go under the draft's flows, as it stands right now. */
export async function tryRequest(trial: Trial | null): Promise<void> {
  set({ trial });
  const { draft } = useEdit.getState();
  if (!trial || !draft) { set({ tried: null }); return; }
  try {
    const tried = await request<Tried>("POST", "/flows/try", {
      model: trial.model, images: trial.images, tools: trial.tools, tokens: trial.long ? 50_000 : 200, flows: draft.flows ?? {}, actions: draft.actions ?? {},
      ...(trial.caller ? { caller: trial.caller } : {}), ...(trial.lane ? { lane: trial.lane } : {}),
      pretend: {
        ...Object.fromEntries(["idle", "used", "busy", "warm", "held"].map((k) => [k, (trial.pretend ?? []).filter((p) => p.startsWith(`${k}:`)).map((p) => p.slice(k.length + 1))])),
        ...Object.fromEntries(["full", "unready"].map((k) => [k, (trial.pretend ?? []).filter((p) => p.startsWith(`${k}:`)).map((p) => p.slice(k.length + 1))])),
        ...((trial.pretend ?? []).some((p) => p.startsWith("now:")) ? { now: (trial.pretend ?? []).find((p) => p.startsWith("now:"))!.slice(4) } : {}),
      },
    });
    if (useEdit.getState().trial === trial) set({ tried });
  } catch (e) {
    if (useEdit.getState().trial === trial) set({ tried: { target: "error", model: trial.model, reason: "", path: [], error: said(e) } });
  }
}

/** Dry-run the draft, show the diff, and write only on confirm. */
export async function review(): Promise<void> {
  // The file may have moved since the draft was read: carry the draft over first, so the save is against what is there.
  await loadDraft();
  const { file, draft, err } = useEdit.getState();
  if (!file?.doc || !draft || err) return;
  const body = { baseHash: file.hash, ops: opsOf(file.doc, draft) };
  const fail = (e: unknown) => set({ plan: null, err: { message: said(e), path: e instanceof RequestError ? e.path : null } });
  try {
    const dry = await request<{ text: string; restartPending: string[] }>("PATCH", "/config", { ...body, dryRun: true });
    set({
      err: null,
      plan: {
        before: file.text, after: dry.text, restartPending: dry.restartPending, notes: problems(draft, facts() ?? undefined),
        commit: async () => {
          try {
            const out = await request<{ restartPending: string[] }>("PATCH", "/config", body);
            toast("ok", out.restartPending.length ? `saved — restart to apply ${out.restartPending.join(", ")}` : "saved and applied");
            stepping = true;
            // Saved: nothing is left to carry over a reload.
            try { sessionStorage.removeItem(KEPT); } catch { /* nothing kept, then */ }
            set({ file: null, draft: null, pending: [] });
            stepping = false;
            await loadDraft();
          } catch (e) {
            fail(e);
          }
        },
      },
    });
  } catch (e) {
    fail(e);
  }
}
