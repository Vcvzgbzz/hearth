/**
 * First run: a node with no operator lets the first visitor off loopback create one, signs
 * them in, writes it to the file, and then closes the door. A bare address redirects to /ui.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { hashPassword } from "../src/login.js";
import { createNode } from "../src/server.js";

const iface = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal);
if (!iface) {
  console.log("server-setup.test.ts skipped — no non-loopback IPv4 on this host");
  process.exit(0);
}

const path = join(mkdtempSync(join(tmpdir(), "hearth-setup-")), "hearth.yaml");
writeFileSync(path, `backends:\n  main:\n    url: http://127.0.0.1:9292\n`);
const node = createNode(loadConfig(path), silentLogger);
await new Promise<void>((r) => node.server.listen(0, iface.address, r));
const url = `http://${iface.address}:${(node.server.address() as AddressInfo).port}`;
const post = (route: string, body: unknown, cookie = "") => fetch(`${url}${route}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});

{
  const r = await fetch(`${url}/`, { redirect: "manual" });
  assert.equal(r.status, 302, "a bare address is not a 401");
  assert.equal(r.headers.get("Location"), "/ui");
}

assert.deepEqual(await (await fetch(`${url}/setup`)).json(), { needed: true });
assert.equal((await post("/setup", { user: "admin", pass: "short" })).status, 400, "a password under 8 is refused");

const ok = await post("/setup", { user: "admin", pass: "right-horse" });
assert.equal(ok.status, 200);
const cookie = (ok.headers.get("Set-Cookie") ?? "").split(";")[0]!;
assert.match(cookie, /^hearth_op=/, "setup signs the new operator in");
assert.equal((await fetch(`${url}/ui/data`, { headers: { Cookie: cookie } })).status, 200, "and the session opens the data");
assert.match(readFileSync(path, "utf8"), /operator:[\s\S]*passHash: [0-9a-f]{32}:[0-9a-f]{128}/, "only a hash reaches the file");

assert.deepEqual(await (await fetch(`${url}/setup`)).json(), { needed: false });
assert.equal((await post("/setup", { user: "mallory", pass: "long-enough" })).status, 409, "the door closes after the first");
assert.equal((await post("/login", { user: "admin", pass: "right-horse" })).status, 200, "the login is live, no restart");

// A new password in the file signs every old session out, as a restart would.
writeFileSync(path, readFileSync(path, "utf8").replace(/passHash: \S+/, `passHash: ${await hashPassword("new-horse")}`));
assert.equal((await fetch(`${url}/config`, { headers: { Cookie: cookie } })).status, 200, "a read syncs the edit");
assert.equal((await fetch(`${url}/ui/data`, { headers: { Cookie: cookie } })).status, 403, "the old session is gone");

await node.close();
console.log("server-setup.test.ts ok");
