/**
 * Catching the `!!!!` on its way past, not on the next tick.
 *
 * A probe every 30s means the first garbage answer a client gets is always at
 * least one probe interval old, and under a broken seat every real request is
 * garbage anyway — so the traffic itself is the best evidence there is. This
 * watches the bytes as they are relayed and never holds them: the proxy writes
 * each chunk on immediately, and the watcher keeps only a bounded tail.
 *
 * The bar for calling real traffic degenerate is higher than the bar for a
 * canary answer, because a false positive here refuses a working seat: a
 * character or a token repeated 32 and 8 times respectively, or an answer whose
 * whole alphabet is two characters. A markdown rule of twenty dashes is not
 * degeneration, and ordinary prose never is.
 *
 *   npx tsx test/canary-stream.test.ts
 */
import assert from "node:assert/strict";

import { DegenerateScan, StreamWatch } from "../src/observe/canary.js";

/** One SSE frame, exactly as an OpenAI server writes it. */
const delta = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;

const reasoning = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`;

// --- 200 of one character, streamed -----------------------------------------
// 200 `!` arrive as ten deltas of twenty. The first delta already carries a run
// past the threshold, so the flag lands mid-stream rather than at the end.
{
  const w = new StreamWatch("text/event-stream");
  for (let i = 0; i < 10; i++) w.feed(delta("!".repeat(20)));
  const v = w.verdict();
  assert.ok(v, "200 identical characters through SSE must be flagged");
  assert.equal(v.reason, "degenerate");
  assert.equal(v.failure, true);
  assert.ok(v.sample.startsWith("!"), `the sample is the bad output, got ${JSON.stringify(v.sample)}`);
}

// --- ordinary answers are never flagged ------------------------------------
{
  const w = new StreamWatch("text/event-stream");
  for (const piece of ["Paris", " is the", " capital", " of France", ".", "\n"]) {
    w.feed(delta(piece));
  }
  assert.equal(w.verdict(), null);
}

// --- a frame split across chunks -------------------------------------------
// TCP does not respect JSON. A frame arriving seven bytes at a time must be
// reassembled, not dropped.
{
  const w = new StreamWatch("text/event-stream");
  const frame = delta("!".repeat(200));
  for (let i = 0; i < frame.length; i += 7) w.feed(frame.slice(i, i + 7));
  assert.ok(w.verdict(), "a frame split mid-line must still be read");
}

// --- a multi-byte character split across chunks -----------------------------
// The run detector must not be fooled by a mangled UTF-8 character, nor crash
// on one. Paris is spelled with an accent and a CJK word, either side of it.
{
  const w = new StreamWatch("text/event-stream");
  const frame = Buffer.from(delta("capitale de la France : Paris 首都"), "utf8");
  for (let i = 0; i < frame.length; i += 1) w.feed(frame.subarray(i, i + 1));
  assert.equal(w.verdict(), null, "a byte-at-a-time split of valid text is not degeneration");
}

// --- the reasoning channel is watched too ----------------------------------
// A client that renders the reasoning trace is being fed junk just as surely.
{
  const w = new StreamWatch("text/event-stream");
  w.feed(reasoning("!".repeat(200)));
  assert.ok(w.verdict(), "a degenerate reasoning channel must be flagged");
}

// --- one token repeated with spaces ---------------------------------------
// No character run at all: the run is of the TOKEN. This is the case a naive
// "same character repeated" check misses.
{
  const w = new StreamWatch("text/event-stream");
  for (let i = 0; i < 40; i++) w.feed(delta("! "));
  assert.ok(w.verdict(), "one token repeated must be flagged");
}

// --- a non-streamed body ----------------------------------------------------
// The same request with `stream: false` arrives as one JSON document, and the
// document only exists once the model has finished. So the proxy judges it at
// the end — `finish()` — rather than pretending there was something to watch
// on the way. The content is a run of 200 identical characters either way.
{
  const w = new StreamWatch("application/json");
  w.feed(JSON.stringify({
    choices: [{ message: { content: "!".repeat(200) }, finish_reason: "length" }],
  }));
  assert.ok(w.finish(), "a non-streamed 200-! body must be caught when it completes");
}

// --- and a non-streamed good body ------------------------------------------
{
  const w = new StreamWatch("application/json");
  w.feed(JSON.stringify({
    choices: [{ message: { content: "Paris is the capital of France." }, finish_reason: "stop" }],
  }));
  assert.equal(w.finish(), null);
}

// --- a markdown rule is not degeneration -----------------------------------
// Twenty dashes between two paragraphs is ordinary output. The threshold is
// what keeps this feature from refusing a healthy seat.
{
  const w = new StreamWatch("text/event-stream");
  for (let i = 0; i < 2; i++) w.feed(delta("----------"));
  assert.equal(w.verdict(), null, "a short rule of dashes is not degeneration");
}

// --- the trailer is not content --------------------------------------------
// `[DONE]` is the end of the stream, not something the model said.
{
  const w = new StreamWatch("text/event-stream");
  w.feed(`data: ${JSON.stringify({ choices: [{ message: { content: "Paris" }, finish_reason: "stop" }] })}\n\n`);
  w.feed("data: [DONE]\n\n");
  assert.equal(w.verdict(), null);
}

// --- nothing is buffered ----------------------------------------------------
// A megabyte and a half of ordinary prose: never flagged, and the watcher holds
// a bounded tail rather than the stream. A watcher that accumulated the answer
// would make every long generation cost memory in the proxy.
{
  const w = new StreamWatch("text/event-stream");
  const para = "The quick brown fox jumps over the lazy dog, and then it does it again. ";
  for (let i = 0; i < 20_000; i++) w.feed(delta(para));
  assert.equal(w.verdict(), null, "ordinary prose must never be flagged");
  assert.ok(w.retained() < 4096, `the watcher must not buffer the stream; retained ${w.retained()} characters`);
}

// --- the scan reports, it does not decide ----------------------------------
// Feeding it directly is how the proxy uses it; the tuning is per call site.
{
  const chars = new DegenerateScan();
  assert.equal(chars.feed("Paris"), false, "a good answer does not trip it");
  assert.equal(chars.verdict(), null);

  const repeat = new DegenerateScan();
  assert.equal(repeat.feed("!"), false, "one character is not a run");
  assert.equal(repeat.feed("!".repeat(40)), true, "forty is a run");
  assert.ok(repeat.verdict());
}

console.log("canary-stream.test.ts ok");
