/**
 * Self-check for peer health.
 *
 * Two properties matter more than the rest, and both are here because getting
 * them wrong has a cost: a peer must not be declared down over one blip, and a
 * peer must not stay "up" on the strength of an old reading. Everything else is
 * bookkeeping.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { PeerRegistry } from "../src/peers.js";

/** A peer whose health and auth we can steer from the test. */
let answering = true;
let sawToken = "";
/** /peer/state requests received, i.e. probe cost. Deliberately not counting
 *  /peer/hello, which fires once when a peer transitions up and is not part of
 *  the per-decision cost being measured. */
let hits = 0;

const peer = createServer((req, res) => {
  if (req.url === "/peer/state") hits++;
  sawToken = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!answering) {
    // Not a refusal: a wedged box that accepts the connection and never
    // answers. The failure mode a connect-check would call healthy.
    return;
  }
  if (req.url === "/peer/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        slots: 1,
        free: 1,
        running: 0,
        offbox: 0,
        queued: { chat: 0 },
        resident: "their-big",
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise<void>((ready) => peer.listen(0, "127.0.0.1", ready));
const peerUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;

function build(staleMs = 60_000) {
  const cfg = parseConfig({
    backend: { url: "http://127.0.0.1:9292" },
    peerStaleMs: staleMs,
    peers: [{ name: "friend", url: peerUrl, token: "shared-token", models: { big: "their-big" } }],
  });
  return { cfg, reg: new PeerRegistry(cfg, silentLogger) };
}

// --- unknown until proven otherwise ----------------------------------------
{
  const { reg } = build();
  assert.equal(reg.isUp("friend"), false, "a peer is down until a poll succeeds");
  assert.deepEqual(reg.candidates("big", []), [], "and is not a routing candidate");
}

// --- a successful poll brings it up ----------------------------------------
{
  answering = true;
  const { reg } = build();
  await reg.pollAll();
  assert.equal(reg.isUp("friend"), true);
  assert.equal(sawToken, "shared-token", "the peer's token must be presented");
  assert.equal(reg.get("friend")?.capacity?.resident, "their-big");
  assert.deepEqual(reg.candidates("big", []), ["friend"]);
  // Only mapped models make it a candidate.
  assert.deepEqual(reg.candidates("something-else", []), []);
}

// --- one failure is not enough to fail over --------------------------------
// A restart on their side should not bounce every job home and back.
{
  answering = true;
  const { reg } = build();
  await reg.pollAll();
  assert.equal(reg.isUp("friend"), true);

  answering = false;
  await reg.pollAll();
  assert.equal(reg.isUp("friend"), true, "one strike must not take a peer down");

  await reg.pollAll();
  assert.equal(reg.isUp("friend"), false, "two consecutive failures must");
}

// --- recovery takes one success --------------------------------------------
{
  answering = true;
  const { reg } = build();
  await reg.pollAll();
  answering = false;
  await reg.pollAll();
  await reg.pollAll();
  assert.equal(reg.isUp("friend"), false);

  answering = true;
  await reg.pollAll();
  assert.equal(reg.isUp("friend"), true, "coming back should be immediate");
}

// --- a stale reading is not a health check ---------------------------------
// The poller could wedge. If it does, an old "up" must expire on its own rather
// than leaving the peer looking healthy forever.
//
// The clock is moved rather than the config: validation now refuses a
// sub-second peerStaleMs, because `60` where `60000` was meant is a plausible
// typo that would leave every peer permanently stale.
{
  answering = true;
  const { reg } = build(60_000);
  await reg.pollAll();
  assert.equal(reg.isUp("friend"), true);

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    assert.equal(reg.isUp("friend"), false, "a reading older than peerStaleMs must not count");
    assert.deepEqual(reg.candidates("big", []), []);
  } finally {
    Date.now = realNow;
  }
  assert.equal(reg.isUp("friend"), true, "healthy again once the clock is sane");
}

// --- on-demand freshness: ask when asked, not on a timer -------------------
{
  answering = true;
  const { reg } = build();
  const before = hits;

  // Cold: the first caller must actually go and look.
  await reg.ensureFresh();
  assert.equal(hits, before + 1, "a cold reading is fetched");
  assert.equal(reg.isUp("friend"), true);

  // Inside peerFreshMs: reused, no traffic at all.
  await reg.ensureFresh();
  await reg.ensureFresh();
  assert.equal(hits, before + 1, "a fresh reading is reused");

  // Concurrent callers coalesce onto one probe. Without this, cost scales with
  // traffic and an agent loop rate-limits itself out of its own peer.
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000; // past peerFreshMs
  try {
    await Promise.all([reg.ensureFresh(), reg.ensureFresh(), reg.ensureFresh()]);
    assert.equal(hits, before + 2, "three concurrent callers make one request");
  } finally {
    Date.now = realNow;
  }
}

// --- a down peer is remembered, so it cannot tax every local request -------
{
  answering = false;
  const { reg } = build();
  const before = hits;

  await reg.ensureFresh();          // one failed probe
  await reg.ensureFresh();          // ...and no more
  await reg.ensureFresh();
  assert.equal(hits, before + 1, "a failed probe is not retried on every request");
  assert.equal(reg.isUp("friend"), false, "and it stays unavailable, which routes local");
  answering = true;
}

peer.closeAllConnections();
peer.close();
console.log("peers.test.ts ok");
