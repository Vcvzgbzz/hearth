/**
 * Self-check for the runtime lend/borrow switches.
 *
 * The failure that matters is a PARTIAL pause: one gate still lending after the
 * switch went off. There are four share gates (peer chat, peer warm,
 * /peer/state's advertisement, the peer view of /v1/models) and they were
 * separate reads of cfg.share, so "it works" has to mean all of them, not the
 * one that was easiest to test.
 *
 * The other is authority. /control is the only route here that CHANGES
 * anything, so a peer being able to reach it would let someone else switch off
 * our lending — or switch it back on after we paused it.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { Controls } from "../src/controls.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

/* ---------------------------------------------- the object, in isolation */

{
  const c = new Controls();
  assert.equal(c.lendingOn, true, "lending defaults ON — the config decides, not this");
  assert.equal(c.borrowingOn, true, "so does borrowing");
  assert.deepEqual(c.share(["a", "b"]), ["a", "b"], "share passes through while lending");

  c.set({ lending: false });
  assert.deepEqual(c.share(["a", "b"]), [], "and reads empty once paused");
  assert.equal(c.borrowingOn, true, "pausing one direction must not touch the other");

  // The race this prevents: two callers each PUT a full state built from a
  // stale read, and the second silently reverts the first.
  const changed = c.set({ borrowing: false });
  assert.deepEqual(changed, { borrowing: false }, "only the transition is reported");
  assert.deepEqual(c.set({ borrowing: false }), {}, "a no-op change reports nothing");
  assert.equal(c.lendingOn, false, "and the earlier pause survived the second call");
}

/* ------------------------------------------------------------ a live node */

/** Minimal peer that is always up and always answers. */
function stubPeer(model: string) {
  let served = 0;
  const s = createServer((req, res) => {
    if (req.url === "/peer/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        slots: 4, free: 4, running: 0, offbox: 0,
        queued: { chat: 0 }, resident: model, loaded: [model], serves: [model],
      }));
      return;
    }
    if (req.url === "/peer/hello") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "friend", capabilities: [] }));
      return;
    }
    served++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from-peer" } }] }));
  });
  return {
    server: s,
    served: () => served,
    listen: () => new Promise<void>((r) => s.listen(0, "127.0.0.1", r)),
    url: () => `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
  };
}

/** Minimal local backend. */
function stubBackend(label: string) {
  const s = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mine" }, { id: "secret" }] }));
      return;
    }
    if (req.url === "/running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: [{ model: "mine", state: "ready" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: label } }] }));
  });
  return {
    server: s,
    listen: () => new Promise<void>((r) => s.listen(0, "127.0.0.1", r)),
    url: () => `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
  };
}

const peer = stubPeer("theirs");
const be = stubBackend("from-local");
await peer.listen();
await be.listen();

const cfg = parseConfig({
  name: "node-under-test",
  backend: { url: be.url(), llamaSwapExtras: false },
  share: ["mine"],
  peerTokens: { friend: "their-token" },
  peers: [{ name: "friend", url: peer.url(), token: "t", models: { borrowed: "theirs" } }],
  // fallbackLocal ON, so pausing borrowing should route home rather than fail.
  models: { borrowed: { policy: "peer", peers: ["friend"], fallbackLocal: true } },
});
const node = createNode(cfg, silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
await node.peers.pollAll();

const asPeer = { Authorization: "Bearer their-token", "Content-Type": "application/json" };
const chat = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  fetch(`${url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
const control = (body?: unknown) =>
  body === undefined
    ? fetch(`${url}/control`)
    : fetch(`${url}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

/* --------------------------------------------------- lending, on then off */

{
  const before = await chat({ model: "mine", messages: [] }, asPeer);
  assert.equal(before.status, 200, "a peer may borrow a shared model while lending is on");

  const state = (await (await control()).json()) as { lending: boolean; share: string[] };
  assert.equal(state.lending, true);
  assert.deepEqual(state.share, ["mine"]);

  const off = await control({ lending: false });
  assert.equal(off.status, 200);

  // GATE 1: the peer chat path.
  const after = await chat({ model: "mine", messages: [] }, asPeer);
  assert.equal(after.status, 403, "the same borrow is refused once lending is paused");

  // GATE 2: what we advertise. A peer must see a healthy node offering nothing,
  // not an error — their router then stops choosing us on its own.
  const st = await fetch(`${url}/peer/state`, { headers: { Authorization: "Bearer their-token" } });
  assert.equal(st.status, 200, "the control plane stays UP — we are not pretending to be down");
  const adv = (await st.json()) as { serves: string[]; loaded: string[]; resident: string | null };
  assert.deepEqual(adv.serves, [], "and advertises nothing");
  assert.deepEqual(adv.loaded, [], "including nothing warm");
  assert.equal(adv.resident, null, "and does not leak which model is resident");

  // GATE 3: the peer view of the model list.
  const models = await fetch(`${url}/v1/models`, { headers: { Authorization: "Bearer their-token" } });
  const mlist = (await models.json()) as { data: { id: string }[] };
  assert.deepEqual(mlist.data, [], "a peer sees an empty catalogue while paused");

  // GATE 4: warm.
  const warm = await fetch(`${url}/v1/warm`, {
    method: "POST", headers: asPeer, body: JSON.stringify({ model: "mine" }),
  });
  assert.equal(warm.status, 403, "a peer cannot warm what we are not lending");

  // Our OWN use of our own model is untouched — this pauses lending, not the node.
  const mine = await chat({ model: "mine", messages: [] });
  assert.equal(mine.status, 200, "local callers are unaffected by a lending pause");

  assert.equal((await control({ lending: true })).status, 200);
  assert.equal(
    (await chat({ model: "mine", messages: [] }, asPeer)).status,
    200,
    "and lending resumes when switched back on",
  );
}

/* ------------------------------------------------- borrowing, on then off */

{
  const served = peer.served();
  const out = await chat({ model: "borrowed", messages: [] });
  assert.equal(out.status, 200);
  assert.match(await out.text(), /from-peer/, "borrowing works while it is on");
  assert.equal(peer.served(), served + 1, "and the peer really served it");

  assert.equal((await control({ borrowing: false })).status, 200);

  const held = peer.served();
  const home = await chat({ model: "borrowed", messages: [] });
  assert.equal(home.status, 200, "with fallbackLocal on, a paused borrow routes home");
  assert.match(await home.text(), /from-local/, "and it is genuinely served locally");
  assert.equal(peer.served(), held, "the peer was not contacted at all");

  // Lending is still on — the two directions are independent.
  assert.equal(
    (await chat({ model: "mine", messages: [] }, asPeer)).status,
    200,
    "pausing OUR borrowing must not stop THEIR borrowing",
  );

  assert.equal((await control({ borrowing: true })).status, 200);
  const back = await chat({ model: "borrowed", messages: [] });
  assert.match(await back.text(), /from-peer/, "borrowing resumes when switched back on");
}

/* ------------------------------------------------------ authority + input */

{
  // A peer must not be able to change our settings. Presenting a valid PEER
  // token is not local authority.
  const byPeer = await fetch(`${url}/control`, {
    method: "POST",
    headers: asPeer,
    body: JSON.stringify({ lending: false }),
  });
  assert.equal(byPeer.status, 401, "a peer token does not grant control");
  const still = (await (await control()).json()) as { lending: boolean };
  assert.equal(still.lending, true, "and nothing changed");

  // `{"lending":"false"}` must not read as truthy and turn lending ON.
  const bad = await control({ lending: "false" });
  assert.equal(bad.status, 400, "a non-boolean is refused rather than coerced");

  assert.equal((await control({})).status, 200, "an empty change is legal and a no-op");
  const put = await fetch(`${url}/control`, { method: "PUT" });
  assert.equal(put.status, 405, "only GET and POST");
}

await node.close();
peer.server.close();
be.server.close();
console.log("control.test.ts ok");
