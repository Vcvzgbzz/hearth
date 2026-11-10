/**
 * The page, pushed instead of polled.
 *
 * `/ui/data` is 95KB and the page asked for all of it every 3 seconds. 93% of
 * that is `hist` — 120 samples, of which the client already had 119. So this
 * sends one snapshot and then only what changed, with new samples appended
 * singly.
 *
 * What is pinned here is the part that could rot silently: that a patch really
 * is a patch (not a whole payload wearing a different event name), that an
 * idle node sends NOTHING rather than a frame saying nothing, and that an open
 * stream cannot hold a shutdown — a page left open in a tab is exactly the
 * connection that would sit out the whole drain.
 *
 *     npx tsx test/uistream.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

interface Frame { event: string; data: Record<string, unknown> }

/** Minimal SSE reader: enough to assert on frames, and no more. */
const listen = async (url: string) => {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const frames: Frame[] = [];
  let pings = 0;
  void (async () => {
    let buf = "";
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const raw of parts) {
          if (raw.startsWith(":")) { pings++; continue; }
          const event = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
          const data = /^data: (.*)$/m.exec(raw)?.[1] ?? "{}";
          frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
        }
      }
    } catch { /* aborted */ }
  })();
  const next = async (n = frames.length + 1, ms = 4_000) => {
    const t0 = Date.now();
    while (frames.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
    return frames[n - 1];
  };
  return { frames, next, pings: () => pings, stop: () => ctrl.abort() };
};

const backend = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m" }] }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const node = createNode(
  parseV1({ name: "sse", backends: [{ name: "b", url: backendUrl, serves: ["m"] }] }),
  silentLogger,
);
node.start();
const base = await new Promise<string>((ready) =>
  node.server.listen(0, "127.0.0.1", () =>
    ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
);

// --- the snapshot is the whole page ----------------------------------------
const s = await listen(`${base}/ui/events`);
{
  const first = await s.next(1);
  assert.equal(first!.event, "snapshot", "a stream opens with everything, so the page can draw at once");
  for (const k of ["net", "q", "hist", "catalog", "config", "controls", "histKeep"]) {
    assert.ok(k in first!.data, `snapshot carries ${k}`);
  }
  assert.equal(first!.data.control, "open", "and how a write authenticates here");
  assert.equal(first!.data.histKeep, 120, "plus the ring size, so the page trims as we do");
}

// --- a change arrives as a patch, not a payload ----------------------------
{
  await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
  }).then((r) => r.json());

  const f = await s.next(2);
  assert.equal(f!.event, "patch");
  const set = f!.data.set as Record<string, unknown>;
  assert.ok(set, "a patch says what changed");
  assert.equal((set.calls as unknown[]).length, 1, "the call that just finished");
  assert.ok(!("hist" in set), "and does not resend history for a call");
  assert.ok(!("operator" in set), "the signed-in operator is per connection and never repeats");
}

// --- a new sample is appended, not resent ----------------------------------
// This is the whole point: 87KB of the 95KB payload was history the client
// already had.
{
  const before = s.frames.length;
  node.history.sample();
  const f = await s.next(before + 1);
  assert.equal(f!.event, "patch");
  const add = f!.data.add as { hist: unknown[] } | undefined;
  assert.ok(add, "history arrives as an append");
  assert.equal(add.hist.length, 1, "one new sample, not a hundred and twenty");
  assert.ok(!(f!.data.set as Record<string, unknown> | undefined)?.hist,
    "and never as a whole array while it can be expressed as a tail");
}

// --- a quiet node says nothing ---------------------------------------------
// A tick that sends "nothing changed" is a poll with extra steps.
{
  const before = s.frames.length;
  await new Promise((r) => setTimeout(r, 2_500));
  assert.equal(s.frames.length, before, "no frames while nothing is happening");
}

// --- an open page does not hold a shutdown ---------------------------------
// The drain waits for requests in flight. A stream is open for as long as
// somebody has a tab open, so counting it would make every restart sit out the
// full grace period waiting for a page that never finishes.
{
  const t0 = Date.now();
  await node.close(10_000);
  const ms = Date.now() - t0;
  assert.ok(ms < 1_000, `close was not held open by the stream (took ${ms}ms)`);
}

s.stop();
backend.closeAllConnections();
backend.close();

// --- the page ships both transports ----------------------------------------
// A SMOKE CHECK, not a behaviour test: nothing here renders the bundle, so
// this proves the code went out, not that it works in a browser. The fallback
// is what it really guards — deleting the poll would be an easy tidy-up, and
// it is the only thing standing between a broken EventSource and a blank page.
{
  const bundle = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../dist/console.js", import.meta.url), "utf8"));
  for (const needle of ["/ui/events", "EventSource", "/ui/data"]) {
    assert.ok(bundle.includes(needle), `the built page references ${needle}`);
  }
}

console.log("uistream.test.ts ok");
