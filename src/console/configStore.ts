/**
 * The Config page's draft of hearth.yaml, kept outside the page so it outlives a walk to another page
 * and back, and so the header can count it. `file` is the file the drafts were built on, and a write
 * sends its hash, so a file that moved under unsaved edits is refused rather than overwritten.
 * `drafts` holds each edited section whole, `renames` the renames made in each, and `text` the
 * hearth.yaml tab. Nothing here writes: the review does.
 */
import { create } from "zustand";

import type { Op } from "./diff.js";
import type { File } from "../observe/uidata.js";

export interface ConfigDraft {
  /** The file the drafts were built on, or null before it is read. */
  file: File | null;
  drafts: Record<string, unknown>;
  renames: Record<string, Op[]>;
  text: string;
}

export const useConfig = create<ConfigDraft>(() => ({ file: null, drafts: {}, renames: {}, text: "" }));

/** How many things are unsaved: each section with a draft, and the yaml text if it differs from the file. */
export function changes(s: ConfigDraft): number {
  return Object.keys(s.drafts).length + (s.file !== null && s.text !== s.file.text ? 1 : 0);
}

export function dirty(s: ConfigDraft): boolean {
  return changes(s) > 0;
}

/** The file the page reads on arriving, and the one it follows when the hash moves. Edits keep the file they were built on. */
export function takeFile(file: File): void {
  useConfig.setState((s) => (dirty(s) ? s : { file, drafts: {}, renames: {}, text: file.text }));
}

/** The file read back after a save: it is what the node now runs, so every draft goes. */
export function takeSaved(file: File): void {
  useConfig.setState({ file, drafts: {}, renames: {}, text: file.text });
}

export function setDraft(key: string, v: unknown): void {
  useConfig.setState((s) => ({ drafts: { ...s.drafts, [key]: v } }));
}

export function addRename(key: string, op: Op): void {
  useConfig.setState((s) => ({ renames: { ...s.renames, [key]: [...(s.renames[key] ?? []), op] } }));
}

/** One section back to the file: its draft and its renames go, nothing else does. */
export function revertSection(key: string): void {
  useConfig.setState((s) => {
    const { [key]: _d, ...drafts } = s.drafts;
    const { [key]: _r, ...renames } = s.renames;
    return { drafts, renames };
  });
}

export function setText(text: string): void {
  useConfig.setState({ text });
}
