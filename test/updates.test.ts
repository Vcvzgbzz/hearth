/**
 * The update check. The failures worth catching:
 *
 *   - an older, equal or pre-release version offered as an update
 *   - asking while `updateCheck` is off, or a notice left standing once it is switched off
 *   - a registry that is down clearing a notice, or failing anything else
 *   - the console never hearing about it
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { newer, watchUpdates } from "../src/updates.js";
import { parseV1 } from "./v1.js";

assert.equal(newer("3.1.0", "3.0.9"), true);
assert.equal(newer("3.0.10", "3.0.9"), true, "numbers, not strings");
assert.equal(newer("3.0.9", "3.0.9"), false);
assert.equal(newer("2.9.0", "3.0.0"), false);
assert.equal(newer("4.0.0-beta.1", "3.0.0"), false, "a pre-release is not offered");
assert.equal(newer("3.0.0", "3.0.0-rc.1"), false, "a pre-release build is compared by its release");
assert.equal(newer("not a version", "3.0.0"), false);

// Against a registry this test runs.
let latest: string | null = "99.0.0";
const asked: string[] = [];
const registry = createServer((req, res) => {
  asked.push(req.url ?? "");
  if (latest === null) return void res.writeHead(503).end();
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: "@scope/pkg", version: latest }));
});
await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
const at = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
const until = async (ok: () => boolean) => { for (let i = 0; !ok() && i < 200; i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(ok(), "timed out waiting"); };

{
  let on = true;
  const seen: (string | null)[] = [];
  const lines: string[] = [];
  const log = { ...silentLogger, info: (msg: string) => { lines.push(msg); } };
  const stop = watchUpdates({ name: "@scope/pkg", current: "3.0.0", enabled: () => on, found: (v) => seen.push(v), log, registry: at, everyMs: 30 });
  await until(() => seen.length >= 2);
  assert.equal(asked[0], "/@scope%2fpkg/latest", "a scoped name is asked for as the registry spells it");
  assert.deepEqual(seen.slice(0, 2), ["99.0.0", "99.0.0"]);
  assert.equal(lines.filter((l) => l === "update.available").length, 1, "said once, not every check");

  latest = null;
  const before = seen.length;
  await until(() => asked.length >= before + 2);
  assert.equal(seen.at(-1), "99.0.0", "a registry that does not answer leaves the notice as it was");

  on = false;
  const count = asked.length;
  await until(() => seen.at(-1) === null);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(asked.length <= count + 1, "switched off, it stops asking");
  stop();
}

// The setting, and the console's data.
{
  assert.equal(parseV1({ backend: { url: "http://127.0.0.1:1" } }).updateCheck, true, "on unless switched off");
  assert.equal(parseV1({ backend: { url: "http://127.0.0.1:1" }, updateCheck: false }).updateCheck, false);

  const node = createNode(parseV1({ backend: { url: "http://127.0.0.1:1" } }), silentLogger);
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const data = async () => ((await (await fetch(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}/ui/data`)).json()) as { update?: string | null }).update;
  assert.equal(await data(), null);
  node.update = "99.0.0";
  assert.equal(await data(), "99.0.0");
  await node.close();
}

registry.close();
console.log("updates.test.ts ok");
