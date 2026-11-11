/** The Playground's stream parser, its code-fence split, and the facts line under an answer, and the names offered. */
import assert from "node:assert/strict";

import { chatNames, factsLine, segments, StreamParser } from "../src/console/chat.js";

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: Record<string, string>) => ev({ choices: [{ delta: d }] });

// Chunks split mid-line, comments, keep-alives and CRLF are all read as one stream.
{
  const whole = `: hearth-queue {"position":1}\n\n` + delta({ content: "Hel" }) + "\r\n" + delta({ reasoning_content: "think" }) + delta({ content: "lo" })
    + ev({ choices: [], usage: { completion_tokens: 2 }, model: "m" }) + "data: [DONE]\n\n";
  for (const size of [1, 3, 7, whole.length]) {
    const p = new StreamParser();
    for (let i = 0; i < whole.length; i += size) p.push(whole.slice(i, i + size));
    const r = p.end();
    assert.equal(r.text, "Hello", `split every ${size}`);
    assert.equal(r.reasoning, "think");
    assert.equal(r.tokens, 2);
    assert.equal(r.model, "m");
    assert.equal(r.done, true);
    assert.equal(r.error, undefined);
  }
}

// An error mid-stream keeps what came before it and says what went wrong.
{
  const p = new StreamParser();
  p.push(delta({ content: "partial" }) + ev({ error: { message: "backend went away" } }));
  const r = p.end();
  assert.equal(r.text, "partial");
  assert.equal(r.error, "backend went away");
  assert.equal(r.done, false, "no [DONE] was seen");
}

// The last line without a trailing newline is still read.
{
  const p = new StreamParser();
  p.push(delta({ content: "a" }).trimEnd());
  assert.equal(p.end().text, "a");
}

// A backend that ignored `stream` answers one JSON body.
{
  const p = new StreamParser();
  const body = JSON.stringify({ model: "m", choices: [{ message: { content: "whole", reasoning_content: "r" } }], usage: { completion_tokens: 5 } });
  p.push(body.slice(0, 10));
  p.push(body.slice(10));
  const r = p.end();
  assert.deepEqual([r.text, r.reasoning, r.tokens, r.done], ["whole", "r", 5, true]);
  const e = new StreamParser();
  e.push(JSON.stringify({ error: { message: "no such model" } }));
  assert.equal(e.end().error, "no such model");
}

// Fences become code blocks; one still open while streaming runs to the end.
assert.deepEqual(segments("hi\n```ts\nconst a = 1;\n```\nbye"), [{ code: false, text: "hi" }, { code: true, text: "const a = 1;" }, { code: false, text: "bye" }]);
assert.deepEqual(segments("see\n```\nopen"), [{ code: false, text: "see" }, { code: true, text: "open" }]);
assert.deepEqual(segments("  two\n\n  lines  "), [{ code: false, text: "  two\n\n  lines  " }], "whitespace is kept");

// The facts line.
assert.equal(
  factsLine({ model: "my-model", target: "local", backend: "gpu0", waitedMs: 200, firstByteMs: 400, runMs: 2900, tokensOut: 170 }),
  "ran as my-model on gpu0 · waited 0.2 s · first token 0.4 s · 3.1 s · 170 tokens · 68 tok/s",
);
assert.equal(factsLine({ model: "my-model", target: "peer", backend: "gpu0", peer: "friend", waitedMs: 0, runMs: 1000 }), "ran as my-model on friend · waited 0.0 s · 1.0 s");
assert.equal(factsLine({ runMs: 1500 }), "1.5 s", "only what is known is said");
// Names: types first, a rule with `takes` is not chat, a model is listed once.
assert.deepEqual(chatNames([{ inputs: ["chat", "*"] }, { inputs: ["voice"], takes: ["/v1/audio/speech"] }], ["my-model", "chat", "voice"]), { types: ["chat"], models: ["my-model"] });
console.log("chat-stream.test.ts ok");
