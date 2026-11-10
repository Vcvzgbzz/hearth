/**
 * The Config page's drafts and the file they were built on. They live outside the page, so leaving
 * it keeps them; a write sends the file's hash, so a file that moved under edits is refused.
 *
 *     npx tsx test/configstore.test.ts
 */
import assert from "node:assert/strict";

import { addRename, changes, dirty, revertSection, setDraft, setText, takeFile, takeSaved, useConfig } from "../src/console/configStore.js";

const file = (hash: string, text: string) => ({ text, hash, doc: { version: 3 } });
const start = (hash: string, text = "version: 3\n") => {
  useConfig.setState(useConfig.getInitialState(), true);
  takeFile(file(hash, text));
};

// --- drafts outlive the page: a remount reads the file again and the edits stay -------------------
{
  start("one");
  setDraft("backends", { gpu0: {} });
  addRename("backends", { path: ["backends", "a"], rename: "b" });
  setText("version: 3\n# edited\n");
  takeFile(file("one", "version: 3\n"));
  const s = useConfig.getState();
  assert.deepEqual(s.drafts, { backends: { gpu0: {} } }, "the section draft is kept");
  assert.equal(s.renames.backends?.length, 1, "and its renames");
  assert.equal(s.text, "version: 3\n# edited\n", "and the yaml text");
  assert.equal(changes(s), 2, "one section plus the text");
}

// --- the count: one per drafted section, one for the text ------------------------------------------
{
  start("one");
  assert.equal(changes(useConfig.getState()), 0);
  setDraft("backends", {});
  setDraft("models", {});
  setDraft("models", { m: {} });
  assert.equal(changes(useConfig.getState()), 2, "a section edited twice counts once");
  setText("x");
  assert.equal(changes(useConfig.getState()), 3);
  setText("version: 3\n");
  assert.equal(changes(useConfig.getState()), 2, "text put back is no change");
}

// --- a moved hash keeps a dirty draft on the file it was built on ---------------------------------
{
  start("one");
  setDraft("backends", { gpu0: {} });
  const before = useConfig.getState().file;
  takeFile(file("two", "version: 3\n# other\n"));
  const s = useConfig.getState();
  assert.equal(s.file, before, "the write still sends the old hash");
  assert.equal(s.file?.hash, "one");
  assert.deepEqual(s.drafts, { backends: { gpu0: {} } });
}

// --- with no edits a moved file is followed --------------------------------------------------------
{
  start("one");
  takeFile(file("two", "b\n"));
  assert.equal(useConfig.getState().file?.hash, "two");
  assert.equal(useConfig.getState().text, "b\n");
}

// --- revert clears that section's draft and renames only; then the file is followed ----------------
{
  start("one");
  setDraft("backends", {});
  addRename("backends", { path: ["backends", "a"], rename: "b" });
  setDraft("models", {});
  revertSection("backends");
  let s = useConfig.getState();
  assert.equal("backends" in s.drafts, false);
  assert.equal("backends" in s.renames, false);
  assert.equal("models" in s.drafts, true, "another section's draft stays");
  revertSection("models");
  s = useConfig.getState();
  assert.equal(dirty(s), false);
  takeFile(file("two", "b\n"));
  assert.equal(useConfig.getState().file?.hash, "two", "a reverted page follows the file again");
}

// --- a save clears every draft and lands on the saved file -----------------------------------------
{
  start("one");
  setDraft("backends", {});
  setText("x");
  takeSaved(file("two", "saved\n"));
  const s = useConfig.getState();
  assert.equal(dirty(s), false);
  assert.equal(s.file?.hash, "two");
  assert.equal(s.text, "saved\n");
}

console.log("configstore.test.ts ok");
