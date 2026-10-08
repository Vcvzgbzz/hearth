/**
 * The operator login in isolation: the hash round-trip, the decoy, the cookie, and the
 * in-memory session and throttle bookkeeping — before any of it meets a socket.
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import {
  COOKIE,
  LoginThrottle,
  OperatorSessions,
  cookieToken,
  hashPassword,
  verifyDecoy,
  verifyPassword,
} from "../src/login.js";

// --- the hash: a salt:hex pair that verifies and reveals nothing -------------
{
  const h1 = await hashPassword("s3cret");
  const h2 = await hashPassword("s3cret");
  assert.match(h1, /^[0-9a-f]{32}:[0-9a-f]{128}$/, "16-byte salt and 64-byte scrypt, both hex");
  assert.notEqual(h1, h2, "the salt is random per password, so identical passwords differ");
  assert.equal(await verifyPassword("s3cret", h1), true, "the right password verifies");
  assert.equal(await verifyPassword("S3cret", h1), false, "and so does not another");
  assert.equal(await verifyPassword("s3cret", "junk"), false, "a malformed stored value is false, not a throw");
  assert.equal(await verifyPassword("s3cret", "abc"), false, "and a short one");
  assert.equal(await verifyDecoy("s3cret"), false, "the decoy verifies nothing");
}

// --- the cookie: the token travels as hearth_op, and only hearth_op -----------
{
  assert.equal(cookieToken("hearth_op=abc123"), "abc123");
  assert.equal(cookieToken("other=1; hearth_op=abc123; other2=2"), "abc123", "it picks its own cookie out of the line");
  assert.equal(cookieToken("hearth_opp=abc"), null, "a different name is not it — split on the first `=`");
  assert.equal(cookieToken("hearth_op="), null, "an empty token is none");
  assert.equal(cookieToken(undefined), null);
  assert.equal(cookieToken("no-equals; also=1"), null);
  assert.equal(COOKIE, "hearth_op");
}

// --- sessions: mint, check, slide, drop, expire -------------------------------
{
  const s = new OperatorSessions(1000);
  const t = s.mint("jadeyn", 0);
  assert.equal(s.size, 1);
  assert.equal(s.check(t, 500), "jadeyn");
  // The check at 950 slides the expiry to 1950, so 1500 is still in.
  assert.equal(s.check(t, 950), "jadeyn", "a use slides the session forward");
  assert.equal(s.check(t, 1500), "jadeyn");
  assert.equal(s.check(t, 3000), null, "past the slid expiry it is gone");
  assert.equal(s.size, 0, "and the store holds no ghosts");

  const t2 = s.mint("other", 10_000);
  s.drop(t2);
  assert.equal(s.check(t2, 10_500), null, "a dropped session is dead at once");
}

// --- the throttle: ten per name, sixty per address, a win clears the name -----
{
  const th = new LoginThrottle(3, 1000, 5, 1000);
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) th.note("jadeyn", "10.0.0.9", t0 + i);
  assert.equal(th.blocked("jadeyn", "10.0.0.9", t0 + 10), true, "the per-name count trips first");
  assert.equal(th.blocked("someone-else", "10.0.0.9", t0 + 10), false, "a fresh name is not blocked");
  th.clear("jadeyn");
  assert.equal(th.blocked("jadeyn", "10.0.0.9", t0 + 10), false, "a success clears the name");

  // The per-address cap trips with a fresh name every time: spray from one machine.
  for (let i = 0; i < 5; i++) th.note(`spray-${i}`, "10.0.0.9", t0 + 100 + i);
  assert.equal(th.blocked("spray-new", "10.0.0.9", t0 + 200), true, "the per-address count trips on its own");
  assert.equal(th.blocked("spray-new", "10.0.0.10", t0 + 200), false, "and only that address");

  // The window is rolling: failures fifteen hundred ago are outside a one-second window.
  const old = new LoginThrottle(1, 1000, 100, 1000);
  old.note("late", "1.2.3.4", 0);
  assert.equal(old.blocked("late", "1.2.3.4", 500), true);
  assert.equal(old.blocked("late", "1.2.3.4", 2000), false, "an old failure does not block a new attempt");
}

// The production defaults are the same classes with real clocks and real windows.
{
  const s = new OperatorSessions();
  const t = s.mint("now");
  assert.equal(s.check(t), "now");
  assert.equal(s.prune(), 0, "nothing has expired this second");
  await sleep(10);
  assert.equal(s.check(t), "now");
}

console.log("login.test.ts ok");
