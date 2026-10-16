/**
 * The `/v1/messages` door. The failures worth catching:
 *
 *   - a Messages request the backend cannot read: system prompt, tool calls and their results
 *     out of order, images, tool choice
 *   - an answer a Messages client cannot read: content blocks, stop reason, usage
 *   - a stream whose events are out of order, lose a delta, or never end
 *   - an error answered in the chat completion envelope, which a Messages client does not parse
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/log.js";
import { chatOf, messageOf } from "../src/messages.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

type Doc = Record<string, unknown>;

// The request, on its own.
{
  const chat = chatOf({
    model: "chat", max_tokens: 100, system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
    stop_sequences: ["END"], tool_choice: { type: "any" },
    tools: [{ name: "look", description: "looks", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "find it" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }, { type: "tool_use", id: "tu_1", name: "look", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "found" }] }, { type: "text", text: "and?" }] },
    ],
  }) as { messages: Doc[]; tools: Doc[]; tool_choice: unknown; stop: string[]; max_tokens: number };
  assert.deepEqual(chat.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "find it" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    { role: "assistant", content: "", tool_calls: [{ id: "tu_1", type: "function", function: { name: "look", arguments: "{\"q\":\"x\"}" } }] },
    { role: "tool", tool_call_id: "tu_1", content: "found" },
    { role: "user", content: "and?" },
  ], "a tool's result follows the call it answers, and comes before what the user says next");
  assert.deepEqual(chat.tools, [{ type: "function", function: { name: "look", description: "looks", parameters: { type: "object", properties: { q: { type: "string" } } } } }]);
  assert.equal(chat.tool_choice, "required");
  assert.deepEqual(chat.stop, ["END"]);
  assert.equal(chat.max_tokens, 100);
  assert.deepEqual((chatOf({ model: "m", stream: true, messages: [] }) as Doc).stream_options, { include_usage: true }, "a stream asks for the usage its last event reports");
}

// The answer, on its own.
{
  const msg = messageOf({
    id: "chatcmpl-abc",
    choices: [{ message: { role: "assistant", content: "here", reasoning_content: "thinking", tool_calls: [{ id: "call_1", type: "function", function: { name: "look", arguments: "{\"q\":\"y\"}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
  }, "chat");
  assert.deepEqual(msg, {
    id: "msg_abc", type: "message", role: "assistant", model: "chat",
    content: [{ type: "thinking", thinking: "thinking", signature: "" }, { type: "text", text: "here" }, { type: "tool_use", id: "call_1", name: "look", input: { q: "y" } }],
    stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
  });
}

// Through a node.
const asked: Doc[] = [];
const backend: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += String(c); });
  req.on("end", () => {
    if (req.method !== "POST") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "the-weights" }] }));
    const body = JSON.parse(raw) as Doc;
    asked.push(body);
    if (body.stream !== true) {
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 },
      }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
    send({ id: "chatcmpl-2", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
    send({ id: "chatcmpl-2", choices: [{ index: 0, delta: { content: "Hel" } }] });
    send({ id: "chatcmpl-2", choices: [{ index: 0, delta: { content: "lo" } }] });
    send({ id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "look", arguments: "{\"q\":" } }] } }] });
    send({ id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"z\"}" } }] } }] });
    send({ id: "chatcmpl-2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    send({ id: "chatcmpl-2", choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const node = createNode(parseV1({ backend: { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, serves: ["chat"] } }), silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const post = (body: unknown) => fetch(`${url}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

{
  const r = await post({ model: "chat", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    id: "msg_1", type: "message", role: "assistant", model: "chat", content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0 },
  });
  assert.deepEqual(asked.at(-1)!.messages, [{ role: "user", content: "hi" }], "the backend is asked in chat completion shapes");
}

{
  const r = await post({ model: "chat", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = (await r.text()).trim().split("\n\n").map((e) => {
    const [name, data] = e.split("\n");
    const parsed = JSON.parse(data!.slice("data: ".length)) as Doc;
    assert.equal(name, `event: ${String(parsed.type)}`, "each event is named as its data says");
    return parsed;
  });
  assert.deepEqual(events.map((e) => e.type), [
    "message_start",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]);
  assert.deepEqual(events[1], { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  assert.deepEqual(events.slice(2, 4).map((e) => (e.delta as Doc).text), ["Hel", "lo"]);
  assert.deepEqual(events[5], { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_9", name: "look", input: {} } });
  assert.equal(events.slice(6, 8).map((e) => (e.delta as Doc).partial_json).join(""), "{\"q\":\"z\"}");
  assert.deepEqual(events[9], { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 0 } });
}

{
  const r = await post({ model: "nothing-here", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 404);
  const body = (await r.json()) as { type: string; error: { type: string; message: string } };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "not_found_error", "a refusal comes in the Messages error shape");
  assert.match(body.error.message, /nothing-here/);
}

{
  const r = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: { type: string } }).error.type, "invalid_request_error");
}

await node.close();
backend.close();
console.log("messages.test.ts ok");
