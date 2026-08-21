/**
 * Self-check for the HTTP client.
 *
 * The bug this file exists to prevent cannot be asserted directly: undici's 300s
 * headers cap needs 300 seconds to fire, and the fix is the *absence* of a
 * timer. So the tests pin everything else a hand-rolled node:http client can get
 * wrong — incremental delivery, delayed headers, error bodies, aborts — plus the
 * one deadline that is deliberately opt-in.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { getJson, send } from "../src/upstream.js";

/** How many chunks /drip had emitted when the client vanished. -1 = never. */
let dripAbortedAfter = -1;

const server = createServer((req, res) => {
  const path = req.url ?? "/";

  if (path === "/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => res.write("data: two\n\n"), 60);
    setTimeout(() => {
      res.write("data: three\n\n");
      res.end();
    }, 120);
    return;
  }

  if (path === "/drip") {
    // Headers immediately, then a chunk every 80ms, and record whether the
    // client's disconnect actually got here.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let n = 0;
    const timer = setInterval(() => {
      n++;
      if (!res.write(`data: ${n}\n\n`) || n > 60) {
        clearInterval(timer);
        res.end();
      }
    }, 80);
    req.on("close", () => {
      clearInterval(timer);
      dripAbortedAfter = n;
    });
    return;
  }

  if (path === "/slow-headers") {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"late":true}');
    }, 250);
    return;
  }

  if (path === "/boom") {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("model is not loaded");
    return;
  }

  if (path === "/echo") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(Buffer.concat(chunks).toString() || "{}");
    });
    return;
  }

  if (path === "/notjson") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("<html>nope</html>");
    return;
  }

  // /hang: headers never sent.
});

await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// --- delivery is incremental ----------------------------------------------
// A client that buffered the whole body would still pass a content check, so
// assert on timing: the first frame must land before the last is written.
{
  const up = await send(`${base}/stream`);
  assert.equal(up.ok, true);
  assert.equal(up.status, 200);

  const seen: { text: string; at: number }[] = [];
  const t0 = Date.now();
  for await (const chunk of up.body) seen.push({ text: String(chunk), at: Date.now() - t0 });

  assert.equal(seen.map((s) => s.text).join(""), "data: one\n\ndata: two\n\ndata: three\n\n");
  const first = seen[0];
  assert.ok(first, "no chunks at all");
  assert.ok(first.at < 60, `first chunk at ${first.at}ms, expected < 60`);
  assert.ok(seen.length > 1, "body arrived as one lump, not a stream");
}

// --- no deadline of our own on headers -------------------------------------
// 250ms stands in for a cold model load. Proves the client imposes nothing
// between request and first byte unless asked.
{
  const t0 = Date.now();
  const up = await send(`${base}/slow-headers`);
  assert.equal(up.ok, true);
  assert.ok(Date.now() - t0 >= 240, "resolved before the server sent headers");
  assert.equal(await up.text(), '{"late":true}');
}

// --- ...but a caller may opt into one --------------------------------------
// Peer polling wants this. Generation never does.
{
  await assert.rejects(
    send(`${base}/slow-headers`, { headersTimeoutMs: 50 }),
    /no response headers in 50ms/,
  );
}

// --- non-2xx keeps its body ------------------------------------------------
{
  const up = await send(`${base}/boom`);
  assert.equal(up.ok, false);
  assert.equal(up.status, 503);
  assert.equal(await up.text(), "model is not loaded");
}

// --- the request body round-trips ------------------------------------------
{
  const out = await getJson<{ hello: string }>(`${base}/echo`, { json: { hello: "world" } });
  assert.equal(out.hello, "world");
}

// --- getJson reports what it got -------------------------------------------
{
  await assert.rejects(getJson(`${base}/notjson`), /did not return JSON/);
  await assert.rejects(getJson(`${base}/boom`), /returned 503/);
}

// --- the caller's signal is the only deadline ------------------------------
// If this times out instead of rejecting, the abort wiring is broken and a
// disconnected client leaks a request forever.
{
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const t0 = Date.now();
  await assert.rejects(send(`${base}/hang`, { signal: ctrl.signal }), /aborted/);
  assert.ok(Date.now() - t0 >= 90, "rejected before the signal fired");
}

// --- aborting MID-STREAM stops the upstream ---------------------------------
// The half that was missing. `fail()` only fires before headers arrive, so an
// abort after streaming began used to do nothing at all. The upstream generated
// to completion into a socket nobody was reading, and the caller's job never
// settled. On a real backend that is a minute of GPU per cancelled request.
{
  const ctrl = new AbortController();
  const up = await send(`${base}/drip`, { signal: ctrl.signal });
  assert.equal(up.ok, true);

  let seen = 0;
  await assert.rejects(
    (async () => {
      for await (const _ of up.body) {
        seen++;
        // Hang up once we are genuinely mid-stream.
        if (seen === 3) ctrl.abort();
      }
    })(),
    /aborted/,
    "iterating the body should throw once the request is destroyed",
  );

  // Give the server a tick to notice the socket went away.
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(dripAbortedAfter > 0, "the server never saw the disconnect");
  assert.ok(
    dripAbortedAfter < 60,
    `upstream ran to completion anyway (stopped at chunk ${dripAbortedAfter})`,
  );
}

// --- an already-aborted signal never opens a connection --------------------
{
  await assert.rejects(send(`${base}/stream`, { signal: AbortSignal.abort() }), /aborted/);
}

// --- unsupported schemes are refused, not silently downgraded --------------
{
  await assert.rejects(send("ftp://example.invalid/x"), /unsupported url/);
}

// closeAllConnections, not just close: /hang left a socket open on purpose and
// close() alone waits for it forever.
server.closeAllConnections();
server.close();
console.log("upstream.test.ts ok");
