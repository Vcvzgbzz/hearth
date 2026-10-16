/**
 * The `/v1/messages` door: a Messages API request is rewritten as a chat completion, served like
 * any other, and its answer rewritten back on the way out, so a Messages client can use whatever
 * this node routes to. `src/anthropic.ts` is the other direction, for a backend that speaks it.
 */
import type { ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";

import { args } from "./anthropic.js";
import { MAX_HELD_CHARS } from "./upstream.js";

type Doc = Record<string, unknown>;
const isObj = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A block's or a whole content's text. */
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : list(content).map((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");

/** An image block as a chat completion image part. */
function imagePart(b: Doc): Doc | null {
  const s = isObj(b.source) ? b.source : null;
  if (s?.type === "base64" && typeof s.data === "string") return { type: "image_url", image_url: { url: `data:${String(s.media_type ?? "image/png")};base64,${s.data}` } };
  if (s?.type === "url" && typeof s.url === "string") return { type: "image_url", image_url: { url: s.url } };
  return null;
}

/** A Messages request as a chat completion request. Thinking blocks and cache marks have no equivalent and are dropped. */
export function chatOf(body: Doc): Doc {
  const messages: Doc[] = [];
  const system = textOf(body.system);
  if (system !== "") messages.push({ role: "system", content: system });
  for (const m of list(body.messages)) {
    if (!isObj(m)) continue;
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : list(m.content).filter(isObj);
    if (m.role === "assistant") {
      const text = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
      const calls = content.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id ?? ""), type: "function", function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: "assistant", content: text, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    // Results answer the assistant turn just before, which chat completions wants them right behind.
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      const said = textOf(b.content);
      messages.push({ role: "tool", tool_call_id: String(b.tool_use_id ?? ""), content: b.is_error === true ? `error: ${said}` : said });
    }
    const parts = content.flatMap((b): Doc[] => {
      if (b.type === "text" && typeof b.text === "string") return [{ type: "text", text: b.text }];
      const image = b.type === "image" ? imagePart(b) : null;
      return image ? [image] : [];
    });
    if (parts.length > 0) messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("") : parts });
  }
  const tools = list(body.tools).filter(isObj).filter((t) => typeof t.name === "string" && t.input_schema !== undefined)
    .map((t) => ({ type: "function", function: { name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), parameters: t.input_schema } }));
  const choice = isObj(body.tool_choice) ? body.tool_choice : null;
  const toolChoice = choice?.type === "any" ? "required" : choice?.type === "none" ? "none"
    : choice?.type === "tool" ? { type: "function", function: { name: String(choice.name ?? "") } } : choice ? "auto" : undefined;
  const stop = list(body.stop_sequences).filter((s) => typeof s === "string");
  return {
    model: body.model,
    messages,
    ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(typeof body.top_k === "number" ? { top_k: body.top_k } : {}),
    ...(stop.length > 0 ? { stop } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(choice?.disable_parallel_tool_use === true ? { parallel_tool_calls: false } : {}),
    // Usage is what a Messages stream reports at its end, so it is always asked for.
    ...(body.stream === true ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

const STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use" };

/** A chat completion's usage as Messages usage: cached input is reported apart from the rest. */
function usageOf(u: unknown): Doc {
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const doc = isObj(u) ? u : {};
  const cached = n(isObj(doc.prompt_tokens_details) ? doc.prompt_tokens_details.cached_tokens : 0);
  return { input_tokens: Math.max(0, n(doc.prompt_tokens) - cached), output_tokens: n(doc.completion_tokens), cache_read_input_tokens: cached };
}

const msgId = (id: unknown): string => `msg_${String(id ?? "").replace(/^chatcmpl-/, "") || Date.now().toString(36)}`;

/** A chat completion answer as a Messages answer. */
export function messageOf(answer: Doc, model: string): Doc {
  const choice = isObj(list(answer.choices)[0]) ? (list(answer.choices)[0] as Doc) : {};
  const m = isObj(choice.message) ? choice.message : {};
  const thought = typeof m.reasoning_content === "string" ? m.reasoning_content : typeof m.reasoning === "string" ? m.reasoning : "";
  const content: Doc[] = [
    ...(thought !== "" ? [{ type: "thinking", thinking: thought, signature: "" }] : []),
    ...(typeof m.content === "string" && m.content !== "" ? [{ type: "text", text: m.content }] : []),
    ...list(m.tool_calls).filter(isObj).map((c) => {
      const fn = isObj(c.function) ? c.function : {};
      return { type: "tool_use", id: String(c.id ?? ""), name: String(fn.name ?? ""), input: args(fn.arguments) };
    }),
  ];
  return {
    id: msgId(answer.id), type: "message", role: "assistant", model, content,
    stop_reason: STOP[String(choice.finish_reason)] ?? "end_turn", stop_sequence: null,
    usage: usageOf(answer.usage),
  };
}

/** The Messages error type a status reads as. */
function errorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 503 || status === 529) return "overloaded_error";
  return "api_error";
}

/** A chat completion error body, or any text, as a Messages error. */
export function errorOf(status: number, raw: string): Doc {
  let message = raw.slice(0, 500);
  try {
    const e = (JSON.parse(raw) as Doc).error;
    if (isObj(e) && typeof e.message === "string") message = e.message;
    else if (typeof e === "string") message = e;
  } catch {
    // Not JSON: said as it came.
  }
  return { type: "error", error: { type: errorType(status), message } };
}

const event = (type: string, data: Doc): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** A chat completion stream read chunk by chunk, each answered with the Messages events it amounts to. */
export class MessagesStream {
  private started = false;
  /** The open content block: its index, and what it holds. */
  private open: { index: number; kind: "thinking" | "text" | "tool"; call?: number } | null = null;
  private next = 0;
  private stop = "end_turn";
  private usage: Doc = { input_tokens: 0, output_tokens: 0 };
  private ended = false;

  constructor(private readonly model: string) {}

  private start(id: unknown): string {
    if (this.started) return "";
    this.started = true;
    return event("message_start", { message: { id: msgId(id), type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }

  private close(): string {
    if (this.open === null) return "";
    const out = event("content_block_stop", { index: this.open.index });
    this.open = null;
    return out;
  }

  /** The block for this kind of delta, opened if it is not the one already open. */
  private block(kind: "thinking" | "text" | "tool", first: Doc, call?: number): string {
    if (this.open?.kind === kind && this.open.call === call) return "";
    const out = this.close();
    this.open = { index: this.next++, kind, ...(call !== undefined ? { call } : {}) };
    return out + event("content_block_start", { index: this.open.index, content_block: first });
  }

  /** One chunk, parsed. */
  chunk(c: Doc): string {
    if (isObj(c.error)) return this.fail(Number(c.error.code ?? 502), String(c.error.message ?? "the backend reported an error"));
    let out = this.start(c.id);
    if (c.usage !== undefined && c.usage !== null) this.usage = usageOf(c.usage);
    for (const ch of list(c.choices).filter(isObj)) {
      const d = isObj(ch.delta) ? ch.delta : {};
      const thought = typeof d.reasoning_content === "string" ? d.reasoning_content : typeof d.reasoning === "string" ? d.reasoning : "";
      if (thought !== "") {
        out += this.block("thinking", { type: "thinking", thinking: "", signature: "" });
        out += event("content_block_delta", { index: this.open!.index, delta: { type: "thinking_delta", thinking: thought } });
      }
      if (typeof d.content === "string" && d.content !== "") {
        out += this.block("text", { type: "text", text: "" });
        out += event("content_block_delta", { index: this.open!.index, delta: { type: "text_delta", text: d.content } });
      }
      for (const t of list(d.tool_calls).filter(isObj)) {
        const fn = isObj(t.function) ? t.function : {};
        const call = typeof t.index === "number" ? t.index : 0;
        out += this.block("tool", { type: "tool_use", id: String(t.id ?? ""), name: String(fn.name ?? ""), input: {} }, call);
        if (typeof fn.arguments === "string" && fn.arguments !== "") {
          out += event("content_block_delta", { index: this.open!.index, delta: { type: "input_json_delta", partial_json: fn.arguments } });
        }
      }
      if (typeof ch.finish_reason === "string") this.stop = STOP[ch.finish_reason] ?? "end_turn";
    }
    return out;
  }

  /** The events that end the message; nothing once it has ended. */
  end(): string {
    if (this.ended) return "";
    this.ended = true;
    return this.start("") + this.close()
      + event("message_delta", { delta: { stop_reason: this.stop, stop_sequence: null }, usage: this.usage })
      + event("message_stop", {});
  }

  /** A failure after the stream has begun, as the error event that ends it. */
  fail(status: number, message: string): string {
    if (this.ended) return "";
    this.ended = true;
    return event("error", { error: { type: errorType(status), message: message.slice(0, 500) } });
  }
}

/**
 * Where the chat path writes its answer for a Messages caller. It reads like the response the chat
 * path expects, and what it is given goes on to `res` rewritten: a stream as it arrives, a JSON
 * answer or an error once it is whole.
 */
export class MessagesResponse extends Writable {
  statusCode = 200;
  headersSent = false;
  private readonly headers = new Map<string, string | number | readonly string[]>();
  private readonly decoder = new StringDecoder("utf8");
  private stream: MessagesStream | null = null;
  private held = "";
  /** The id the caller asked for, which every answer names. */
  model = "";

  constructor(private readonly res: ServerResponse) {
    super();
    // A caller who hangs up is a close the chat path must hear, to stop the work.
    res.on("close", () => { if (!this.writableEnded) this.destroy(); });
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  getHeader(name: string): string | number | readonly string[] | undefined { return this.headers.get(name.toLowerCase()); }
  hasHeader(name: string): boolean { return this.headers.has(name.toLowerCase()); }
  removeHeader(name: string): void { this.headers.delete(name.toLowerCase()); }

  writeHead(status: number, more?: Record<string, string | number | readonly string[] | undefined>): this {
    this.statusCode = status;
    for (const [k, v] of Object.entries(more ?? {})) if (v !== undefined) this.setHeader(k, v);
    this.headersSent = true;
    if (status < 400 && String(this.getHeader("content-type") ?? "").includes("text/event-stream")) {
      this.stream = new MessagesStream(this.model);
      this.res.writeHead(200, { ...this.passed(), "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    }
    return this;
  }

  /** What our own headers say that a Messages caller can use too; never a length, which the rewrite changes. */
  private passed(): Record<string, string | number | readonly string[]> {
    return Object.fromEntries([...this.headers].filter(([k]) => k.startsWith("x-") || k === "retry-after" || k === "connection"));
  }

  override _write(chunk: Buffer | string, _enc: BufferEncoding, done: (e?: Error | null) => void): void {
    if (!this.headersSent) this.writeHead(this.statusCode);
    this.held += this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    if (this.stream === null) return done();
    let out = "";
    for (let end = /\r?\n\r?\n/.exec(this.held); end; end = /\r?\n\r?\n/.exec(this.held)) {
      const data = this.held.slice(0, end.index).split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      this.held = this.held.slice(end.index + end[0].length);
      if (data === "") continue;
      if (data === "[DONE]") { out += this.stream.end(); continue; }
      try {
        out += this.stream.chunk(JSON.parse(data) as Doc);
      } catch {
        // A chunk that is not JSON says nothing a caller could use.
      }
    }
    if (this.held.length > MAX_HELD_CHARS) this.held = "";
    if (out === "" || this.res.write(out)) done();
    else this.res.once("drain", () => done());
  }

  override _final(done: (e?: Error | null) => void): void {
    if (!this.headersSent) this.writeHead(this.statusCode);
    const rest = this.held + this.decoder.end();
    if (this.stream !== null) {
      this.res.end(this.stream.end());
      return done();
    }
    let body: Doc;
    let status = this.statusCode;
    if (status >= 400) body = errorOf(status, rest);
    else {
      try {
        body = messageOf(JSON.parse(rest) as Doc, this.model);
      } catch {
        status = 502;
        body = errorOf(status, "the backend's answer could not be read");
      }
    }
    const text = JSON.stringify(body);
    this.res.writeHead(status, { ...this.passed(), "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) }).end(text);
    done();
  }
}
