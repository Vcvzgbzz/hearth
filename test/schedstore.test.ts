/**
 * The Scheduler page's draft and the file it was built on. A write sends that file's hash, so a
 * file that moved under unsaved edits is refused only while nothing swaps it out from under them.
 * Each block drives the store the way the page does: what arrives, what is edited, what comes back.
 *
 *     npx tsx test/schedstore.test.ts
 */
import assert from "node:assert/strict";

import { changeDraft, changes, dirty, discardDraft, dropDraft, markUnread, takeFile, takeSaved, useSched } from "../src/console/schedStore.js";

const SPARE = ["scheduler", "lanes", "spare", "priority"];
const doc = (spare: number) => ({ version: 3, scheduler: { lanes: { chat: { priority: 0 }, spare: { priority: spare } } } });
const file = (hash: string, spare: number) => ({ text: `spare: ${spare}\n`, hash, doc: doc(spare) });
const read = (f: ReturnType<typeof file>) => takeFile(f, f.doc);
const fileHash = () => useSched.getState().file?.hash;
const spareOf = (held: "base" | "draft") => (useSched.getState()[held] as ReturnType<typeof doc>).scheduler.lanes.spare.priority;
const start = (hash: string, spare: number) => {
  useSched.setState(useSched.getInitialState(), true);
  read(file(hash, spare));
};

// --- a save leaves the page clean, on what the file now holds ----------------------------------
{
  start("one", 60);
  changeDraft(SPARE, 61);
  assert.equal(dirty(useSched.getState()), true);
  const saved = file("two", 61);
  takeSaved(saved, saved.doc);
  assert.equal(dirty(useSched.getState()), false, "nothing is left to save");
  assert.equal(changes(useSched.getState()), 0, "so the header counts nothing");
  assert.equal(fileHash(), "two", "and the next write is built on the saved file");
  assert.equal(spareOf("draft"), 61);
  discardDraft();
  assert.equal(spareOf("draft"), 61, "discard after a save shows the saved value");
}

// --- a save takes what the file holds, even where the draft said something else -----------------
{
  start("one", 60);
  changeDraft(SPARE, 61);
  const merged = file("two", 62);
  takeSaved(merged, merged.doc);
  assert.equal(spareOf("draft"), 62, "the file read back is the truth");
  assert.equal(spareOf("base"), 62);
}

// --- a file that cannot be read back after a save starts the page over ---------------------------
{
  start("one", 60);
  changeDraft(SPARE, 61);
  dropDraft("the file could not be read back");
  const s = useSched.getState();
  assert.deepEqual([s.file, s.base, s.draft], [null, null, null], "no draft is left against a stale file");
  assert.equal(dirty(s), false);
  assert.equal(s.unread, "the file could not be read back", "and the page says so");
  read(file("two", 61));
  assert.equal(useSched.getState().unread, null, "until the page has loaded again");
  assert.equal(spareOf("draft"), 61);
}

// --- a file that moves under edits leaves all three where they are -------------------------------
{
  start("one", 60);
  changeDraft(SPARE, 70);
  const before = useSched.getState();
  read(file("two", 99));
  const s = useSched.getState();
  assert.equal(s.file?.hash, "one", "the write still sends the hash the draft was built on");
  assert.equal(s.file, before.file);
  assert.equal(s.base, before.base);
  assert.equal(s.draft, before.draft);
  assert.equal(changes(s), 1);
}

// --- a walk away and back reads the file again, and leaves the edits alone -----------------------
{
  start("one", 60);
  changeDraft(SPARE, 70);
  read(file("one", 60));
  assert.equal(spareOf("draft"), 70, "the draft is kept");
  assert.equal(dirty(useSched.getState()), true, "and it is still unsaved");
}

// --- discard, then the reload, shows what the file holds now --------------------------------------
{
  start("one", 60);
  changeDraft(SPARE, 70);
  read(file("two", 99));
  discardDraft();
  assert.equal(spareOf("draft"), 60, "the edits go first");
  assert.equal(dirty(useSched.getState()), false);
  read(file("two", 99));
  assert.equal(fileHash(), "two", "the reload then follows the file");
  assert.equal(spareOf("draft"), 99);
  assert.equal(spareOf("base"), 99);
}

// --- with no edits a moved file is simply followed ------------------------------------------------
{
  start("one", 60);
  read(file("two", 99));
  assert.equal(fileHash(), "two");
  assert.equal(spareOf("draft"), 99);
}

// --- an edit put back by hand is no edit, so the file can be followed again -----------------------
{
  start("one", 60);
  changeDraft(SPARE, 70);
  changeDraft(SPARE, 60);
  read(file("two", 99));
  assert.equal(spareOf("draft"), 99);
}

// --- a file that cannot be read says so, and a draft already held stays ---------------------------
{
  useSched.setState(useSched.getInitialState(), true);
  markUnread("a key is needed");
  assert.equal(useSched.getState().unread, "a key is needed");
  start("one", 60);
  changeDraft(SPARE, 70);
  markUnread("a key is needed");
  assert.equal(spareOf("draft"), 70);
  assert.equal(useSched.getState().unread, null, "the page has a draft to show");
}

console.log("schedstore.test.ts ok");
