/**
 * The console at /ui: one self-contained response behind the page's own gate,
 * with its stylesheet and bundle inlined and nothing that renders raw HTML.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

const node = createNode(parseV1({
  name: "n", apiKeys: ["secret-key"], backend: { url: "http://127.0.0.1:1", kind: "none", serves: ["m"] },
}), silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const r = await fetch(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}/ui`);
const html = await r.text();
assert.equal(r.status, 200);
assert.match(r.headers.get("content-type") ?? "", /text\/html/);
for (const words of ["goes by router", "queues in lane", "what it reaches"]) assert.ok(html.includes(words), `the keys page says ${words}`);
// The Scheduler page is served with its own words, and the nav offers no Queue page.
for (const words of ["review & apply", "waiting on", "top goes first"]) assert.ok(html.includes(words), `the scheduler page says ${words}`);
// Every knob the scheduler has is on that page, and one that waits for a restart says so.
for (const words of ["jobs at once", "head start", "Lane pins", "restart"]) assert.ok(html.includes(words), `the scheduler page says ${words}`);
// The Config page's scheduler section sends the reader there instead of offering a second form for it.
assert.ok(html.includes("Lanes, order and limits now live on the Scheduler page"), "the config page points at the Scheduler page");
assert.ok(!html.includes('label:"Queue"'), "the nav has no Queue page");
assert.match(html, /<div id="root"><\/div>/);
assert.match(html, /<style>[^]*--accent[^]*<\/style>/, "the stylesheet is inlined, so nothing loads from elsewhere");
assert.ok(!/<script src=|<link [^>]*href="(?!data:)/.test(html), "no external assets: an icon is a data: URI");
assert.ok(!html.includes("secret-key"), "no credential may appear in the page");
await node.close();

for (const f of readdirSync(new URL("../src/console/", import.meta.url))) {
  const src = readFileSync(new URL(`../src/console/${f}`, import.meta.url), "utf8");
  assert.ok(!src.includes("dangerouslySetInnerHTML"), `${f} must not render raw HTML`);
}

console.log("console.test.ts ok");
