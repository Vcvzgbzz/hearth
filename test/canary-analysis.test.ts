/**
 * What a bad answer looks like, in one pure function.
 *
 * A backend can answer HTTP 200 with 200 `!` characters, and nothing upstream
 * calls that a failure when every layer only asks "did bytes arrive".
 * A canary has to say what a GOOD answer is and then judge against that, so
 * this is the judgement, separated from the HTTP that fetched it.
 *
 * The cases that matter are the ones a naive check gets wrong: a reasoning
 * model that spent its whole budget thinking (not a broken seat, a probe that
 * asked for too little), a one-word answer that is simply wrong (a missing
 * answer, not a degenerate one), and a run of one character or one token
 * repeated to the cap.
 *
 *   npx tsx test/canary-analysis.test.ts
 */
import assert from "node:assert/strict";

import { analyseAnswer, isFailure, readCompletion } from "../src/observe/canary.js";

const PARIS = /paris/i;

// --- 200 of one character -------------------------------------------------
// 200 `!`, finish_reason `length`, HTTP 200. This is the answer that must be
// called what it is before any threshold is consulted.
{
  const bang = "!".repeat(200);
  const reading = readCompletion({
    choices: [{ message: { content: bang }, finish_reason: "length" }],
  });
  assert.ok(reading, "a normal chat completion must parse");
  const v = analyseAnswer(reading, PARIS);
  assert.equal(v.reason, "degenerate", "200 identical characters is degenerate");
  assert.equal(v.failure, true, "and it must count against the seat");
  assert.equal(v.ok, false);
  assert.ok(v.sample.startsWith("!!!!"), `the sample must be the bad output, got ${JSON.stringify(v.sample)}`);
  assert.ok(v.sample.length <= 80, "the sample is bounded, since it goes in an error body");
}

// --- a good answer ----------------------------------------------------------
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: "Paris is the capital of France." }, finish_reason: "stop" }],
  })!, PARIS);
  assert.equal(v.reason, "ok");
  assert.equal(v.ok, true);
  assert.equal(v.failure, false);
  assert.equal(isFailure(v), false);
}

// --- an empty answer --------------------------------------------------------
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: "" }, finish_reason: "stop" }],
  })!, PARIS);
  assert.equal(v.reason, "empty");
  assert.equal(v.failure, true, "no answer at all is a failure");
  assert.equal(v.ok, false);
}

// --- present but wrong ------------------------------------------------------
// Content arrived, it is not repetitive, and it does not answer the question.
// That is a different fault from garbage, and the reason has to say so.
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: "The capital of Germany is Berlin." }, finish_reason: "stop" }],
  })!, PARIS);
  assert.equal(v.reason, "missing");
  assert.equal(v.failure, true, "an answer that never answers is a failure");
  assert.equal(v.ok, false);
}

// --- a reasoning model that ran out of room --------------------------------
// A reasoning model thinks before it answers. With max_tokens small enough, the whole
// budget goes to the reasoning channel and `content` is empty with
// finish_reason `length`. That is a mis-sized probe, NOT a broken seat: calling
// it a failure would degrade a perfectly healthy reasoning model on the first
// tick, which is the exact false positive this feature must not produce.
{
  const v = analyseAnswer(readCompletion({
    choices: [{
      message: { content: "", reasoning_content: "The user asks for the capital of France. Let me recall..." },
      finish_reason: "length",
    }],
  })!, PARIS);
  assert.equal(v.reason, "thinking");
  assert.equal(v.ok, false, "it did not answer");
  assert.equal(v.failure, false, "but the seat is not at fault; the probe was too small");
  assert.equal(isFailure(v), false);
}

// --- the same reasoning channel, having actually finished -------------------
// Reasoning present, content empty, and it STOPPED: it thought and then said
// nothing. That is a real failure, and it must not be excused by the rule above.
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: "", reasoning_content: "France... Paris." }, finish_reason: "stop" }],
  })!, PARIS);
  assert.equal(v.reason, "empty");
  assert.equal(v.failure, true, "finished thinking and produced no answer is a failure");
}

// --- the answer is only in the reasoning channel ---------------------------
// A model that puts the answer in its reasoning and leaves content empty must
// not be credited with answering: clients read `content`.
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: "", reasoning_content: "Paris" }, finish_reason: "stop" }],
  })!, PARIS);
  assert.equal(v.reason, "empty", "the reasoning channel is not the answer");
}

// --- one token repeated -----------------------------------------------------
// Distinct-character ratio does not catch this: the alphabet is large enough.
// The repeated-token check is what does.
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: "the the the the the the the the" }, finish_reason: "stop" }],
  })!, PARIS);
  assert.equal(v.reason, "degenerate", "one token repeated is degenerate");
  assert.equal(v.failure, true);
}

// --- two characters alternating ---------------------------------------------
// Caught by the distinct-character ratio: 2 distinct over 20 characters.
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: "abababababababababab" }, finish_reason: "stop" }],
  })!, PARIS);
  assert.equal(v.reason, "degenerate");
}

// --- a long run of one character inside otherwise fine text -----------------
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: `Paris${"-".repeat(40)}` }, finish_reason: "stop" }],
  })!, /paris[\s\S]*/i);
  assert.equal(v.reason, "degenerate", "a long run of one character is degenerate even when the answer is present");
}

// --- hit the cap without answering -----------------------------------------
// The question asks for one city. Answering it cannot need a second screenful.
// `length` with no expected text is the signature this whole feature was built
// around, and it must not be filed as merely "missing".
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: "The capital of France is" }, finish_reason: "length" }],
  })!, PARIS);
  assert.equal(v.reason, "degenerate", "stopping at the cap without answering is degenerate");
  assert.equal(v.failure, true);
}

// --- short, correct, unusual ------------------------------------------------
// A one-word answer must not be judged by its length or its alphabet.
{
  const v = analyseAnswer(readCompletion({
    choices: [{ message: { content: "Paris" }, finish_reason: "stop" }],
  })!, PARIS);
  assert.equal(v.reason, "ok");
}

// --- content as an array of parts -------------------------------------------
// OpenAI's newer shape puts content in parts. Reading `.content` and finding an
// array must not turn a good answer into "empty".
{
  const reading = readCompletion({
    choices: [{
      message: { content: [{ type: "text", text: "Paris" }] },
      finish_reason: "stop",
    }],
  });
  assert.ok(reading);
  assert.equal(reading.content, "Paris", "text parts must be joined, not dropped");
  assert.equal(analyseAnswer(reading, PARIS).reason, "ok");
}

// --- a legacy completions shape ---------------------------------------------
{
  const reading = readCompletion({ choices: [{ text: "Paris", finish_reason: "stop" }] });
  assert.ok(reading);
  assert.equal(reading.content, "Paris");
  assert.equal(analyseAnswer(reading, PARIS).reason, "ok");
}

// --- nothing to read --------------------------------------------------------
// No choices at all is not an answer, and must not throw where a verdict is due.
{
  assert.equal(readCompletion({}), null);
  assert.equal(readCompletion({ choices: [] }), null);
  assert.equal(readCompletion(null), null);
  assert.equal(readCompletion("not json"), null);
  assert.equal(readCompletion({ choices: [{ message: {} }] })?.content, "");
}

console.log("canary-analysis.test.ts ok");
