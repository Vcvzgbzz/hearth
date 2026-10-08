/**
 * The operator login against a live node, reached the way the operator reaches it:
 * from off loopback. The node listens on the machine's own non-loopback address, so
 * every request here is what the Mac is to the box.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";

import { parseConfig } from "../src/config.js";
import { hashPassword } from "../src/login.js";
import { createNode } from "../src/server.js";
import { silentLogger } from "../src/log.js";

const iface = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal);
if (!iface) {
  console.log("server-login.test.ts skipped — no non-loopback IPv4 on this host");
  process.exit(0);
}

const cfg = parseConfig({
  backend: { url: "http://127.0.0.1:9292" },
  listen: { host: iface.address },
  // A key is set, as it is on the real box: loopback then needs one too, which is the
  // shape a login has to beat — the session must count as a full local identity.
  apiKeys: ["test-key"],
  operator: { user: "jadeyn", passHash: await hashPassword("right-horse") },
});

const node = createNode(cfg, silentLogger);
await new Promise<void>((r) => node.server.listen(0, iface.address, r));
const url = `http://${iface.address}:${(node.server.address() as AddressInfo).port}`;

const j = (r: Response): Promise<Record<string, unknown>> => r.json() as Promise<Record<string, unknown>>;

// --- refused before there is a session ---------------------------------------
{
  const r = await fetch(`${url}/ui/data`);
  assert.equal(r.status, 403, "off loopback, no key and no session is nobody");
  await r.text();

  const c = await fetch(`${url}/config`);
  assert.equal(c.ok, false, "/config wants a credential it does not have yet");
  await c.text();

  // The page itself is static and may be read; the gate is on the data stream.
  const p = await fetch(`${url}/ui`);
  assert.equal(p.status, 200, "the shell loads anywhere — with no data under it");
  assert.match(await p.text(), /<div id="root">/, "and it is the console's shell");
}

// --- a wrong login is refused, and says nothing about which part was wrong ---
{
  const wrong = await fetch(`${url}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "jadeyn", pass: "wrong-horse" }),
  });
  assert.equal(wrong.status, 401);
  assert.equal((await j(wrong)).error, "bad username or password");

  const ghost = await fetch(`${url}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "mallory", pass: "wrong-horse" }),
  });
  assert.equal(ghost.status, 401, "an unknown user gets the same answer");
  assert.equal((await j(ghost)).error, "bad username or password");
}

// --- a right login mints a cookie, and the cookie is the door ----------------
let cookie = "";
{
  const r = await fetch(`${url}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "jadeyn", pass: "right-horse" }),
  });
  assert.equal(r.status, 200, "the right password is in");
  const set = r.headers.get("Set-Cookie") ?? "";
  assert.match(set, /hearth_op=[0-9a-f]{64}/, "a 32-byte token in the cookie");
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Max-Age=/);
  cookie = set.split(";")[0]!;
}

{
  // The data stream opens, and the payload says who this browser is.
  const d = await fetch(`${url}/ui/data`, { headers: { Cookie: cookie } });
  assert.equal(d.status, 200, "the session carries the page's data");
  const payload = (await d.json()) as { operator: string | null };
  assert.equal(payload.operator, "jadeyn", "the page can show the sign-in and offer a sign-out");

  // /config with the cookie and no key: the session is a full local identity.
  const c = await fetch(`${url}/config`, { headers: { Cookie: cookie } });
  assert.equal(c.status, 200, "the config editor opens for a logged-in operator");
  await c.text();

  // /control too; an unknown action is a 400 from the handler, not a refusal at the gate.
  const ctl = await fetch(`${url}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ nonsense: true }),
  });
  assert.notEqual(ctl.status, 401, "the gate let the session through");
  assert.notEqual(ctl.status, 403, "and so did the loopback-only parts of it");
  await ctl.text();

  // A session and a key are both fine; the key is simply ignored by the gate.
  const both = await fetch(`${url}/config`, { headers: { Cookie: cookie, Authorization: "Bearer test-key" } });
  assert.equal(both.status, 200);
  await both.text();
}

// --- logout kills exactly that session ---------------------------------------
{
  const out = await fetch(`${url}/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("Set-Cookie") ?? "", /Max-Age=0/, "the cookie is cleared in the browser");
  await out.text();

  const r = await fetch(`${url}/ui/data`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 403, "a dropped session is dead at once");
  await r.text();

  // Logging out without a session is a no-op, not an error.
  const anon = await fetch(`${url}/logout`, { method: "POST" });
  assert.equal(anon.status, 200);
  await anon.text();
}

// --- the throttle: ten wrong tries per name, then a pause ---------------------
// The earlier success cleared this name's count, so the cap is a clean ten from here.
{
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${url}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "jadeyn", pass: `nope-${i}` }),
    });
    assert.equal(r.status, 401, `attempt ${i + 1} is still a straight refusal`);
    await r.text();
  }
  const blocked = await fetch(`${url}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "jadeyn", pass: "right-horse" }),
  });
  assert.equal(blocked.status, 429, "the eleventh attempt waits out the window — even with the right password");
  await blocked.text();
}

await node.close();

// --- loopback is unchanged, and a node with no operator has no login ---------
{
  const plain = createNode(parseConfig({ backend: { url: "http://127.0.0.1:9292" } }), silentLogger);
  await new Promise<void>((r) => plain.server.listen(0, "127.0.0.1", r));
  const purl = `http://127.0.0.1:${(plain.server.address() as AddressInfo).port}`;
  const d = await fetch(`${purl}/ui/data`);
  assert.equal(d.status, 200, "loopback stays open without any credential");
  const payload = (await d.json()) as { operator: string | null };
  assert.equal(payload.operator, null, "loopback is nobody in particular");

  const r = await fetch(`${purl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "x", pass: "y" }),
  });
  assert.equal(r.status, 404, "nothing is configured, so there is nothing to sign in to");
  await r.text();
  await plain.close();
}

console.log("server-login.test.ts ok");
