// Stand-ins for everything the demo node fronts. None of them runs a model: each answers in the
// shape of the server it stands for, slowly enough that the queue and the console have something to show.
import { createServer } from "node:http";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const WORDS = "the queue keeps one model on the card while the next request waits its turn and nothing thrashes".split(" ");
const read = async (req) => { let b = ""; for await (const c of req) b += c; try { return b ? JSON.parse(b) : {}; } catch { return {}; } };
const json = (res, status, o) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
/** Roughly what a prompt weighs, so usage moves with what was sent. */
const sizeOf = (body) => Math.max(8, Math.round(JSON.stringify(body.messages ?? body.input ?? "").length / 4));

/** A chat completion, streamed a word at a time or whole. `perSec` is how fast this server talks. */
async function chat(res, body, perSec) {
  // The canary's question gets the answer it looks for, so the demo's models read as healthy.
  const probe = JSON.stringify(body.messages ?? "").includes("capital of France");
  const out = probe ? 1 : 12 + Math.floor(Math.random() * 48);
  const usage = { prompt_tokens: sizeOf(body), completion_tokens: out, total_tokens: sizeOf(body) + out };
  if (!body.stream) {
    await wait((out / perSec) * 1000);
    return json(res, 200, { id: "chatcmpl-demo", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: probe ? "Paris" : WORDS.slice(0, out).join(" ") }, finish_reason: "stop" }], usage });
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const ev = (o) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-demo", object: "chat.completion.chunk", model: body.model, ...o })}\n\n`);
  ev({ choices: [{ index: 0, delta: { role: "assistant" } }] });
  for (let i = 0; i < out && !res.destroyed; i++) { await wait(1000 / perSec); ev({ choices: [{ index: 0, delta: { content: `${WORDS[i % WORDS.length]} ` } }] }); }
  ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  if (body.stream_options?.include_usage) ev({ choices: [], usage });
  res.end("data: [DONE]\n\n");
}

/** A model swapper: one model on the card at a time, and asking for another loads it first. */
function swapper(port, models, { perSec = 40, loadMs = 2500, props = {} } = {}) {
  let loaded = models[0];
  let loading = null;
  const ensure = async (m) => {
    while (loading) await wait(100);
    if (loaded === m) return;
    loading = m; loaded = null;
    await wait(loadMs);
    loaded = m; loading = null;
  };
  createServer(async (req, res) => {
    const body = await read(req);
    const url = req.url ?? "";
    if (url === "/v1/models") return json(res, 200, { data: models.map((id) => ({ id })) });
    if (url === "/running") return json(res, 200, { running: [...(loaded ? [{ model: loaded, state: "ready" }] : []), ...(loading ? [{ model: loading, state: "starting" }] : [])] });
    if (url.startsWith("/api/models/unload")) { loaded = null; return json(res, 200, {}); }
    const up = /^\/upstream\/([^/]+)\/props$/.exec(url);
    if (up) return json(res, 200, { default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false }, chat_template_caps: { supports_tools: true }, ...(props[decodeURIComponent(up[1])] ?? {}) });
    if (url === "/v1/chat/completions" && models.includes(body.model)) { await ensure(body.model); return chat(res, body, perSec); }
    json(res, 404, { error: { message: "not found" } });
  }).listen(port, "127.0.0.1");
}

/** A server that keeps what it serves loaded: one process, one model, or several small ones side by side. */
function steady(port, models, { perSec = 60, ollama = false, context = 8192 } = {}) {
  createServer(async (req, res) => {
    const body = await read(req);
    const url = req.url ?? "";
    if (url === "/v1/models") return json(res, 200, { data: models.map((id) => ({ id, max_model_len: context })) });
    if (ollama && url === "/api/ps") return json(res, 200, { models: models.map((name) => ({ name, model: name })) });
    if (ollama && url === "/api/show") return json(res, 200, { model_info: { "general.context_length": context } });
    if (url === "/v1/embeddings") { await wait(60); return json(res, 200, { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: sizeOf(body), total_tokens: sizeOf(body) } }); }
    if (url === "/v1/chat/completions") return chat(res, body, perSec);
    json(res, 404, { error: { message: "not found" } });
  }).listen(port, "127.0.0.1");
}

/** An image app with a queue of its own, which it reports, and paths that are nothing like chat. */
function imageApp(port) {
  let running = 0;
  createServer(async (req, res) => {
    const url = req.url ?? "";
    await read(req);
    if (url === "/queue") return json(res, 200, { queue_running: running, queue_pending: 0 });
    if (url === "/sdapi/v1/progress") return json(res, 200, { progress: running ? 0.5 : 0 });
    if (url === "/sdapi/v1/txt2img") { running++; await wait(3500 + Math.random() * 2500); running--; return json(res, 200, { images: ["(an image)"] }); }
    json(res, 404, { error: "not found" });
  }).listen(port, "127.0.0.1");
}

/** A provider's API: nothing without its key. `anthropic` speaks Messages and reports its cache. */
function provider(port, key, models, { anthropic = false, perSec = 90 } = {}) {
  createServer(async (req, res) => {
    const body = await read(req);
    const given = anthropic ? req.headers["x-api-key"] : String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (given !== key) return json(res, 401, anthropic ? { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } : { error: { message: "invalid api key" } });
    if (req.url === "/v1/models") return json(res, 200, { data: models.map((id) => ({ id })) });
    if (!anthropic && req.url === "/v1/chat/completions") return chat(res, body, perSec);
    if (!anthropic || req.url !== "/v1/messages") return json(res, 404, { error: { message: "not found" } });
    const out = 12 + Math.floor(Math.random() * 48);
    const size = Math.max(8, Math.round(JSON.stringify(body.messages ?? "").length / 4));
    // A conversation's earlier turns were written to the cache by the turn before: most of the input is a read.
    const cached = (body.messages ?? []).length > 1 ? Math.round(size * 0.8) : 0;
    const usage = { input_tokens: size - cached, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: out };
    if (!body.stream) { await wait((out / perSec) * 1000); return json(res, 200, { id: "msg_demo", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: WORDS.slice(0, out).join(" ") }], usage }); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev("message_start", { message: { id: "msg_demo", usage: { ...usage, output_tokens: 1 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (let i = 0; i < out && !res.destroyed; i++) { await wait(1000 / perSec); ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: `${WORDS[i % WORDS.length]} ` } }); }
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: out } });
    ev("message_stop", {});
    res.end();
  }).listen(port, "127.0.0.1");
}

/** A webhook that takes whatever an action or the canary sends it. */
function hook(port) {
  createServer(async (req, res) => { await read(req); json(res, 200, { ok: true }); }).listen(port, "127.0.0.1");
}

// This node's own servers.
swapper(42001, ["big-model", "code-model", "vision-model"], { perSec: 35, props: { "vision-model": { modalities: { vision: true } }, "big-model": { default_generation_settings: { n_ctx: 131072 } } } });
steady(42002, ["small-model"], { perSec: 80, context: 16384 });
steady(42003, ["embed-small", "rerank-small"], { ollama: true });
imageApp(42004);
steady(42005, ["voice-model"], { perSec: 120 });
// Providers, and the hook the actions call.
provider(42010, "demo-key-a", ["hosted-large", "hosted-fast", "hosted-other"]);
provider(42011, "demo-key-b", ["messages-large", "messages-fast"], { anthropic: true });
hook(42020);
// What the friend's node fronts.
swapper(42030, ["their-big-model"], { perSec: 45, props: { "their-big-model": { default_generation_settings: { n_ctx: 262144 } } } });

console.log("demo backends are up on 127.0.0.1:42001-42030");
