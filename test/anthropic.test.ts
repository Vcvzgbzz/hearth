/**
 * A backend with `format: anthropic`. The failures worth catching:
 *
 *   - a request the Messages API would refuse: no max_tokens, a system turn among the messages,
 *     two user turns in a row, a tool result or a tool call in the wrong shape
 *   - cache marks missing, or present when switched off
 *   - an answer a chat-completions client cannot read: text, tool calls, finish reason, usage
 *   - a stream that loses a delta, never ends, or reports usage to a caller who did not ask
 *   - the key sent as a bearer token, which this API does not read
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fromAnthropic, toAnthropic } from "../src/anthropic.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

type Doc = Record<string, unknown>;

// The request, on its own.
const tool = { type: "function", function: { name: "look", description: "looks", parameters: { type: "object", properties: { q: { type: "string" } } } } };
const asked = {
  model: "their-model", stream: true, temperature: 0.2, stop: "END", tool_choice: "required", tools: [tool],
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "one" },
    { role: "user", content: [{ type: "text", text: "two" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "look", arguments: "{\"q\":\"x\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "found" },
  ],
};
const out = toAnthropic(asked, true) as { max_tokens: number; system: Doc[]; messages: { role: string; content: Doc[] }[]; tools: Doc[]; tool_choice: Doc; stop_sequences: string[]; stream: boolean };
assert.equal(out.max_tokens, 4096, "the API will not choose a limit, so one is always sent");
assert.deepEqual(out.system, [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }]);
assert.deepEqual(out.messages.map((m) => m.role), ["user", "assistant", "user"], "turns alternate: two user messages are one turn");
assert.deepEqual(out.messages[0]!.content, [{ type: "text", text: "one" }, { type: "text", text: "two" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]);
assert.deepEqual(out.messages[1]!.content, [{ type: "tool_use", id: "call_1", name: "look", input: { q: "x" } }], "an empty reply beside a tool call sends no empty text");
assert.deepEqual(out.messages[2]!.content, [{ type: "tool_result", tool_use_id: "call_1", content: "found", cache_control: { type: "ephemeral" } }], "the conversation so far ends the cached prefix");
assert.deepEqual(out.tools, [{ name: "look", description: "looks", input_schema: tool.function.parameters, cache_control: { type: "ephemeral" } }]);
assert.deepEqual([out.tool_choice, out.stop_sequences, out.stream], [{ type: "any" }, ["END"], true]);
assert.ok(!JSON.stringify(toAnthropic(asked, false)).includes("cache_control"), "switched off, nothing is marked");
assert.equal((toAnthropic({ ...asked, max_completion_tokens: 50 }, true) as Doc).max_tokens, 50);

// The answer, on its own.
const answer = fromAnthropic({
  id: "msg_1", stop_reason: "tool_use",
  content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "looking" }, { type: "tool_use", id: "tu_1", name: "look", input: { q: "y" } }],
  usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 },
}, "big") as { choices: { message: Doc; finish_reason: string }[]; usage: Doc };
assert.deepEqual(answer.choices[0]!.message, { role: "assistant", content: "looking", reasoning_content: "hm", tool_calls: [{ id: "tu_1", type: "function", function: { name: "look", arguments: "{\"q\":\"y\"}" } }] });
assert.equal(answer.choices[0]!.finish_reason, "tool_calls");
assert.deepEqual(answer.usage, { prompt_tokens: 105, completion_tokens: 7, total_tokens: 112, prompt_tokens_details: { cached_tokens: 90 } }, "input counts the cached part too, and says how much of it was read");

// Through a node, against a server that speaks Messages and nothing else.
const got: { path: string; key: unknown; bearer: unknown; version: unknown; body: Doc }[] = [];
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = (raw ? JSON.parse(raw) : {}) as Doc;
  got.push({ path: req.url ?? "", key: req.headers["x-api-key"], bearer: req.headers.authorization, version: req.headers["anthropic-version"], body });
  const say = (status: number, o: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.headers["x-api-key"] !== "provider-secret") return say(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
  if (req.url === "/v1/models") return say(200, { data: [{ id: "their-model" }] });
  if (req.url !== "/v1/messages") return say(404, { type: "error", error: { type: "not_found_error", message: "no" } });
  if (body.max_tokens === 1) return say(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too small" } });
  const usage = { input_tokens: 3, cache_read_input_tokens: 40, output_tokens: 6 };
  if (!body.stream) return say(200, { id: "msg_2", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "from afar" }], usage });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const ev = (type: string, data: Doc) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id: "msg_3", usage: { input_tokens: 3, cache_read_input_tokens: 40, output_tokens: 1 } } });
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  ev("ping", {});
  for (const text of ["from ", "afar é✓"]) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  ev("content_block_stop", { index: 0 });
  ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "tu_9", name: "look", input: {} } });
  for (const partial_json of ["{\"q\":", "\"z\"}"]) ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json } });
  ev("content_block_stop", { index: 1 });
  ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } });
  ev("message_stop", {});
  res.end();
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));

const cfgPath = join(mkdtempSync(join(tmpdir(), "hearth-anthropic-")), "hearth.yaml");
writeFileSync(cfgPath, `name: node-under-test
backends:
  away:
    url: http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1
    cloud: true
    format: anthropic
    key: provider-secret
    serves: [their-model]
models:
  big: {backend: away, as: their-model, price: {in: 1000000, out: 0, cached: 100000}}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: ours-secret, label: app}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const ours = { Authorization: "Bearer ours-secret", "Content-Type": "application/json" };
const chat = (more: Doc = {}) => fetch(`${url}/v1/chat/completions`, { method: "POST", headers: ours, body: JSON.stringify({ model: "big", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], ...more }) });

try {
  const plain = await chat();
  assert.equal(plain.status, 200, await plain.clone().text());
  const said = (await plain.json()) as { object: string; choices: { message: Doc; finish_reason: string }[]; usage: Doc };
  assert.deepEqual([said.object, said.choices[0]!.message.content, said.choices[0]!.finish_reason, said.usage.prompt_tokens, said.usage.completion_tokens], ["chat.completion", "from afar", "stop", 43, 6]);
  const sent = got.find((g) => g.path === "/v1/messages")!;
  assert.deepEqual([sent.key, sent.bearer, sent.version], ["provider-secret", undefined, "2023-06-01"], "its key goes in the header this API reads, and ours does not go at all");
  assert.equal(sent.body.model, "their-model");
  assert.deepEqual(sent.body.system, [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }]);
  assert.ok(got.some((g) => g.path === "/v1/models" && g.key === "provider-secret"), "the model list is read with the same key");

  const streamed = await (await chat({ stream: true })).text();
  const events = streamed.trim().split("\n\n").map((e) => e.slice(6));
  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e) as { choices: { delta: Doc; finish_reason: string | null }[]; usage?: Doc });
  assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? "").join(""), "from afar é✓");
  const calls = chunks.flatMap((c) => (c.choices[0]?.delta.tool_calls ?? []) as { index: number; id?: string; function: { name?: string; arguments: string } }[]);
  assert.deepEqual([calls[0]!.id, calls[0]!.function.name, calls.map((c) => c.function.arguments).join(""), new Set(calls.map((c) => c.index)).size], ["tu_9", "look", "{\"q\":\"z\"}", 1]);
  assert.equal(chunks.at(-1)!.choices[0]!.finish_reason, "tool_calls");
  assert.ok(chunks.every((c) => c.choices.length === 1), "a caller who did not ask gets no usage event");

  const withUsage = await (await chat({ stream: true, stream_options: { include_usage: true } })).text();
  assert.match(withUsage, /"choices":\[\],"usage":\{"prompt_tokens":43,"completion_tokens":6/);

  await new Promise((r) => setTimeout(r, 50));
  const used = ((await (await fetch(`${url}/usage?days=1`, { headers: ours })).json()) as { usage: Record<string, Record<string, Record<string, { requests: number; in: number; out: number }>>> }).usage;
  assert.deepEqual(Object.values(used)[0]!["key:app"]!["big"], { requests: 3, failed: 0, in: 129, out: 18, cached: 120 }, "all three counted from what the provider said, the stream nobody asked usage of included, and how much was a cache read");

  // Priced at a dollar a token in and a tenth of that for a cache read: 9 fresh and 120 read.
  const page = (await (await fetch(`${url}/ui/data`, { headers: ours })).json()) as { keys: { label: string; today: { cost: number } }[] };
  assert.equal(page.keys.find((k) => k.label === "app")!.today.cost, 21, "input read from the cache is priced as such");

  const small = await chat({ max_tokens: 1 });
  assert.equal(small.status, 400);
  assert.deepEqual(await small.json(), { error: { message: "max_tokens: too small", type: "invalid_request_error" } }, "its refusal reaches the caller in the shape a chat client reads");
  console.log("anthropic.test.ts ok");
} finally {
  await node.close();
  provider.close();
}
