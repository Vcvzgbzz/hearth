/**
 * What is picked out on the routing map. The map reports its selection into `many`; a selection asked for
 * from outside it (Escape, a paste) is a separate one-shot `toPick`, so a report never sets the map's selection.
 *
 *     npx tsx test/editstore.test.ts
 */
import assert from "node:assert/strict";

Object.assign(globalThis, { location: { hash: "" }, document: { hidden: false, addEventListener() {} }, addEventListener() {} });
// Imported by a name tsc does not follow: the tests are typechecked without the page's DOM types.
type Picked = { node: string; x: number; y: number };
type Edit = { many: Picked[]; toPick: Picked[] | null; draft: unknown };
const { copyMany, paste, pickOut, selectMany, useEdit } = (await import(`${"../src/console/"}editStore.js`)) as {
  copyMany(): boolean; paste(): void; pickOut(many: Picked[]): void; selectMany(many: Picked[]): void;
  useEdit: { getState(): Edit; setState(s: Partial<Edit>): void };
};

const at = (node: string) => ({ node, x: 0, y: 0 });
useEdit.setState({ draft: { flows: { a: { inputs: ["x"], steps: [{ to: "m" }] } } } });

// --- the map's own report is never handed back to it -------------------------------------------------
selectMany([at("flow:a")]);
assert.deepEqual(useEdit.getState().many, [at("flow:a")], "the report is what `many` says");
assert.equal(useEdit.getState().toPick, null, "and asks the map for nothing");

// --- Escape asks once, and says so in `many` straight away -------------------------------------------
pickOut([]);
assert.deepEqual(useEdit.getState().toPick, [], "Escape asks the map to pick out nothing");
assert.deepEqual(useEdit.getState().many, [], "and nothing is picked out meanwhile");
useEdit.setState({ toPick: null });

// --- a paste of several asks the map to pick out the copies ------------------------------------------
selectMany([at("flow:a")]);
assert.ok(copyMany());
paste();
const { many, toPick } = useEdit.getState();
assert.deepEqual(toPick?.map((p) => p.node), many.map((p) => p.node), "the copies are asked for");
assert.ok(many.length === 1 && many[0]!.node !== "flow:a", "and they are the copies, not the original");

console.log("editstore ok");
