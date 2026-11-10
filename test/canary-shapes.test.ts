/**
 * Every response shape a degenerate answer can arrive in.
 *
 * Passive detection watches what hearth relays, and "the model is emitting
 * `!!!!`" does not look the same in each shape. The first version read chat
 * deltas only, which left three real holes:
 *
 *   - the legacy completions shape (`choices[].text`) — a whole endpoint
 *     (`/v1/completions`) whose junk was never looked at;
 *   - a NON-STREAMED body, which carries the answer inside JSON rather than as
 *     deltas, so nothing was extracted from it and only a crude raw-byte run
 *     check applied — `! ! ! !` spaced out slipped straight through;
 *   - the reasoning spellings a reasoning model actually uses
 *     (`reasoning_content`, `reasoning`), which are the channels a reasoning model fills.
 *
 * One case per shape, and a good answer in each shape that must not be flagged.
 *
 *   npx tsx test/canary-shapes.test.ts
 */
import assert from "node:assert/strict";

import { StreamWatch } from "../src/observe/canary.js";

/** A degenerate answer that has NO long run of one character: 120 `!` spaced out. */
const SPACED = "! ".repeat(60);
/** One character, repeated past every threshold. */
const SOLID = "!".repeat(200);

const frame = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;

/** A whole (non-streamed) response body, as one chunk. */
const body = (json: unknown): string => JSON.stringify(json);

/** Feed a body and finish it, the way the proxy does after the pipeline settles. */
const whole = (w: StreamWatch, text: string) => {
  w.feed(text);
  return w.finish() ?? w.verdict();
};

// ===========================================================================
// Streamed (SSE) shapes
// ===========================================================================

// --- chat deltas, the shape the first version covered -----------------------
{
  const w = new StreamWatch("text/event-stream");
  for (let i = 0; i < 10; i++) w.feed(frame({ choices: [{ delta: { content: "!".repeat(20) } }] }));
  assert.ok(w.verdict(), "chat deltas are the original case and must keep working");
}

// --- the legacy completions stream shape: choices[].text -------------------
// `/v1/completions` streams `text`, not `delta.content`. Reading only the chat
// shape means a whole endpoint's junk is invisible.
{
  const w = new StreamWatch("text/event-stream");
  for (let i = 0; i < 10; i++) w.feed(frame({ choices: [{ text: "!".repeat(20) }] }));
  assert.ok(w.verdict(), "a streamed legacy completion must be judged");
}

// --- and the same shape, degraded the subtle way ---------------------------
{
  const w = new StreamWatch("text/event-stream");
  for (let i = 0; i < 4; i++) w.feed(frame({ choices: [{ text: "! ".repeat(15) }] }));
  assert.ok(w.verdict(), "spaced repetition in a streamed completion must be caught too");
}

// --- reasoning, both spellings --------------------------------------------
// vLLM spells it `reasoning_content`; the other common spelling is `reasoning`.
// A reasoning model's junk arrives here before it ever reaches `content`.
{
  const a = new StreamWatch("text/event-stream");
  a.feed(frame({ choices: [{ delta: { reasoning_content: "!".repeat(200) } }] }));
  assert.ok(a.verdict(), "reasoning_content must be read");

  const b = new StreamWatch("text/event-stream");
  b.feed(frame({ choices: [{ delta: { reasoning: "!".repeat(200) } }] }));
  assert.ok(b.verdict(), "reasoning must be read");
}

// --- harmony / Responses-API deltas ---------------------------------------
// The Responses API streams named events whose payload is `{type, delta}`,
// with no `choices` at all. Nothing about the answer is in the chat shape.
{
  const w = new StreamWatch("text/event-stream");
  w.feed(frame({ type: "response.output_text.delta", delta: SPACED }));
  assert.ok(w.verdict(), "a Responses-style output delta must be judged");

  const r = new StreamWatch("text/event-stream");
  r.feed(frame({ type: "response.reasoning_text.delta", delta: SPACED }));
  assert.ok(r.verdict(), "a Responses-style reasoning delta must be judged too");
}

// --- a good answer in each streamed shape is never flagged -----------------
{
  const cases: unknown[] = [
    { choices: [{ delta: { content: "Paris is the capital of France." } }] },
    { choices: [{ text: "Paris is the capital of France." }] },
    { choices: [{ delta: { reasoning_content: "The capital of France is Paris." } }] },
    { type: "response.output_text.delta", delta: "Paris is the capital of France." },
  ];
  for (const c of cases) {
    const w = new StreamWatch("text/event-stream");
    w.feed(frame(c));
    w.feed("data: [DONE]\n\n");
    assert.equal(w.finish() ?? w.verdict(), null, `good text must not be flagged: ${JSON.stringify(c)}`);
  }
}

// ===========================================================================
// Non-streamed shapes
// ===========================================================================
//
// Here the answer is inside the JSON body, which arrives in one piece when the
// model has finished. There are no deltas to judge, so the body is read at the
// end — `finish()` — and judged with the same content rules.

// --- chat, non-streamed ----------------------------------------------------
{
  const w = new StreamWatch("application/json");
  assert.equal(whole(w, body({ choices: [{ message: { content: SOLID }, finish_reason: "length" }] }))?.reason,
    "degenerate", "a non-streamed chat body with a solid run must be flagged");
}

// --- chat, non-streamed, with no long character run ------------------------
// This is the one the raw-byte check cannot see: nothing in the bytes repeats
// 64 times in a row, but the answer is still one token over and over.
{
  const w = new StreamWatch("application/json");
  const v = whole(w, body({ choices: [{ message: { content: SPACED }, finish_reason: "stop" }] }));
  assert.ok(v, "a spaced-out repetitive answer must be judged by content, not by raw bytes");
  assert.equal(v.reason, "degenerate");
}

// --- legacy completions, non-streamed -------------------------------------
{
  const w = new StreamWatch("application/json");
  const v = whole(w, body({ choices: [{ text: SPACED, finish_reason: "stop" }] }));
  assert.ok(v, "a non-streamed legacy completion must be judged");
  assert.equal(v.reason, "degenerate");
}

// --- a reasoning trace in a non-streamed body -----------------------------
{
  const w = new StreamWatch("application/json");
  const v = whole(w, body({
    choices: [{ message: { content: "", reasoning_content: SPACED }, finish_reason: "length" }],
  }));
  assert.ok(v, "a degenerate reasoning trace in a non-streamed body must be judged");
}

// --- good answers, non-streamed, in every shape ---------------------------
{
  const cases: unknown[] = [
    { choices: [{ message: { content: "Paris is the capital of France." }, finish_reason: "stop" }] },
    { choices: [{ text: "Paris is the capital of France.", finish_reason: "stop" }] },
    { output: [{ content: [{ type: "output_text", text: "Paris is the capital of France." }] }] },
  ];
  for (const c of cases) {
    const w = new StreamWatch("application/json");
    assert.equal(whole(w, body(c)), null, `good text must not be flagged: ${JSON.stringify(c)}`);
  }
}

// --- llama.cpp's own /completion shape --------------------------------------
// A bare top-level `content`, no choices at all. `/completion` is one of the
// paths the passthrough watches, so its answer has to be readable here.
{
  const w = new StreamWatch("application/json");
  const v = whole(w, body({ content: SPACED, stop: true }));
  assert.ok(v, "a llama.cpp /completion body must be judged");
  assert.equal(v.reason, "degenerate");

  const good = new StreamWatch("application/json");
  assert.equal(whole(good, body({ content: "Paris is the capital of France.", stop: true })), null);
}

// --- a body that is not a completion at all -------------------------------
// The passthrough relays things that are not chat: a base64 image, a rerank
// score list. None of it may be called degenerate, and none of it may crash
// the watcher.
{
  const w = new StreamWatch("application/json");
  assert.equal(whole(w, "not json at all, just a long line of text"), null);
  const b64 = new StreamWatch("application/json");
  assert.equal(whole(b64, body({ data: [{ b64_json: "A".repeat(5000) }] })), null,
    "a long run inside a field hearth does not read is not an answer");
}

// --- nothing is buffered without a bound ----------------------------------
// The non-streamed path has to hold the body to read it, so the bound is the
// guarantee: a huge response must not grow the proxy's memory with it.
{
  const w = new StreamWatch("application/json");
  const huge = body({ choices: [{ message: { content: "Paris. ".repeat(200_000) } }] });
  w.feed(huge);
  assert.ok(w.retained() < 600_000, `the watcher must hold a bounded body, held ${w.retained()}`);
  assert.equal(w.finish(), null, "and a good answer is still good at that size");
}

console.log("canary-shapes.test.ts ok");
