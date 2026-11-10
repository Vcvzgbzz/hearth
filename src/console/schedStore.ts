/**
 * The Scheduler page's draft of hearth.yaml, kept outside the page so it outlives a walk to another
 * page and back, and so the header can count it. `file` is the file the draft was built on, and a
 * write sends its hash, so a file that moved under unsaved edits is refused rather than overwritten.
 * `base` is that file as the node would run it and `draft` is what is being edited; the count is what
 * `knobOps` says the difference is. Nothing here writes: the review does.
 */
import { create } from "zustand";

import { knobOps, setAt, type Doc, type Path } from "./knobs.js";
import type { File } from "../observe/uidata.js";

export interface SchedDraft {
  /** The file the draft was built on, or null before it is read. */
  file: File | null;
  /** The file the draft starts from, seeded the way the page reads it. */
  base: Doc | null;
  draft: Doc | null;
  /** Why the file could not be read, once that is known. A refusal from a write is the page's own. */
  unread: string | null;
}

export const useSched = create<SchedDraft>(() => ({ file: null, base: null, draft: null, unread: null }));

/**
 * The file the page reads on arriving, and the one it follows when the hash moves. A draft with
 * edits keeps the file it was built on, and its base, whatever arrives.
 */
export function takeFile(file: File, start: Doc): void {
  useSched.setState((s) => (dirty(s) ? s : { file, base: start, draft: start, unread: null }));
}

/** The file read back after a save: it is what the node now runs, so it replaces all three. */
export function takeSaved(file: File, start: Doc): void {
  useSched.setState({ file, base: start, draft: start, unread: null });
}

/** The file could not be read back after a save: the page starts over from nothing, and says why. */
export function dropDraft(why: string): void {
  useSched.setState({ file: null, base: null, draft: null, unread: why });
}

/** Nobody could read the file: the page says so rather than waiting on a draft that never comes. */
export function markUnread(why: string): void {
  // A draft already being edited stays: a refused write leaves it exactly as it was.
  useSched.setState((s) => (s.draft === null ? { unread: why } : s));
}

/** Read the draft back to what the file would run: every edit goes, and nothing else does. */
export function discardDraft(): void {
  useSched.setState((s) => (s.base === null ? s : { draft: s.base }));
}

/** True when the draft holds a value the file does not: the same walk the review would send. */
export function dirty(s: Pick<SchedDraft, "file" | "base" | "draft">): boolean {
  return changes(s) > 0;
}

/** How many values the draft changes: what the header's pill counts and the save bar says. */
export function changes(s: Pick<SchedDraft, "file" | "base" | "draft">): number {
  if (s.file === null || s.base === null || s.draft === null) return 0;
  return knobOps(s.file.doc ?? {}, s.base, s.draft).length;
}

/** One value in the draft, made on the way down like `setAt` does. */
export function changeDraft(path: Path, value: unknown): void {
  useSched.setState((s) => (s.draft === null ? s : { draft: setAt(s.draft, path, value) }));
}
