/**
 * The node keeps one routing draft for every browser. A tab with no changes of its own must never
 * have the node let go of it: another device's draft would be lost when this tab merely reloads the file.
 *
 *     npx tsx test/draftkeep.test.ts
 */
import assert from "node:assert/strict";

Object.assign(globalThis, { location: { hash: "" }, document: { hidden: false, addEventListener() {} }, addEventListener() {} });

const file = { doc: { flows: { a: { inputs: ["x"], steps: [{ to: "m" }] } } }, hash: "h1" };
const calls: string[] = [];
globalThis.fetch = (async (path: string, init?: { method?: string }) => {
  const method = init?.method ?? "GET";
  calls.push(`${method} ${path}`);
  const body = path === "/config" ? file : path === "/config/draft" && method === "GET" ? { draft: null } : {};
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

type Doc = Record<string, unknown>;
const { loadDraft, useEdit } = (await import(`${"../src/console/"}editStore.js`)) as {
  loadDraft(): Promise<void>; useEdit: { getState(): { draft: Doc | null }; setState(s: Partial<{ draft: Doc }>): void };
};
const settle = () => new Promise((r) => setTimeout(r, 700));
const sent = (method: string) => calls.filter((c) => c === `${method} /config/draft`).length;

// An untouched tab reading the file, and reading it again as it moves between pages.
await loadDraft();
await loadDraft();
await settle();
assert.equal(sent("DELETE"), 0, "an untouched tab never has the node drop the draft");

// A change of its own is kept; taking it back lets the node drop what this tab kept.
useEdit.setState({ draft: { ...useEdit.getState().draft!, note: "mine" } });
await settle();
assert.equal(sent("PUT"), 1, "a change is handed to the node");
useEdit.setState({ draft: structuredClone(file.doc) });
await settle();
assert.equal(sent("DELETE"), 1, "and undoing it has the node drop the draft this tab kept");

// Having let go, this tab is untouched again.
await loadDraft();
await settle();
assert.equal(sent("DELETE"), 1, "and does not send it again");

console.log("draftkeep ok");
