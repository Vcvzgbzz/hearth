/**
 * A backend that speaks Anthropic's Messages API: a chat completion is rewritten on its way out
 * and the answer on its way back, so a caller sees the same shapes as from any other backend.
 */
import type { ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";

import type { CacheTtl } from "./config.js";
import { streamErrorFrame } from "./emulate.js";
import { MAX_HELD_CHARS, type UpstreamResponse } from "./upstream.js";
import type { Meter } from "./usage.js";

type Doc = Record<string, unknown>;
const isObj = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The API version every call names. */
export const ANTHROPIC_VERSION = "2023-06-01";
/** What an answer may run to when the request does not say; the Messages API will not choose. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * `reasoning_effort` as the Messages API's `output_config.effort`. Its lowest level stands in for
 * none and minimal: several models refuse any way of switching thinking off.
 */
const EFFORT: Record<string, string> = { none: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** A message's text, whether it was sent as a string or as parts. */
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : list(content).map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("");

/** A message's content as Messages blocks. Empty text is left out: the API refuses it. */
function blocks(content: unknown): Doc[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return list(content).flatMap((p): Doc[] => {
    if (!isObj(p)) return [];
    if (p.type === "text" && typeof p.text === "string") return p.text === "" ? [] : [{ type: "text", text: p.text }];
    if (p.type !== "image_url") return [];
    const url = isObj(p.image_url) ? p.image_url.url : p.image_url;
    if (typeof url !== "string") return [];
    const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    return [{ type: "image", source: data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url } }];
  });
}

/** A tool call's arguments as the object they spell; text that is not JSON is kept under `_raw`. */
export function args(text: unknown): Doc {
  try {
    const v: unknown = JSON.parse(typeof text === "string" && text !== "" ? text : "{}");
    return isObj(v) ? v : { _raw: v };
  } catch {
    return { _raw: text };
  }
}

/** The last of these, marked as where a cached prefix ends. */
function marked<T extends Doc>(items: T[], ttl: CacheTtl): T[] {
  return items.length === 0 ? items : [...items.slice(0, -1), { ...items.at(-1)!, cache_control: { type: "ephemeral", ...(ttl === "5m" ? {} : { ttl }) } }];
}

/**
 * A chat completion request as a Messages request. With `cache`, the tools, the system prompt and
 * the conversation so far are each marked as a cached prefix, so the next turn of the same
 * conversation is billed for them as a read.
 */
export function toAnthropic(body: Doc, cache: boolean, ttl: CacheTtl = "5m"): Doc {
  let system: Doc[] = [];
  const messages: { role: string; content: Doc[] }[] = [];
  // The API takes turns that alternate; neighbours of one role are one turn.
  const add = (role: string, content: Doc[]): void => {
    if (content.length === 0) return;
    const last = messages.at(-1);
    if (last?.role !== role) messages.push({ role, content });
    // Results answer the turn before, and the API wants them ahead of anything else said in theirs.
    else if (content[0]!.type === "tool_result") last.content.splice(last.content.findLastIndex((b) => b.type === "tool_result") + 1, 0, ...content);
    else last.content.push(...content);
  };
  for (const m of list(body.messages)) {
    if (!isObj(m)) continue;
    // Only what opens the conversation is the system prompt. A system message said later stays where it
    // stands: moved up, it would change the start of a prefix the provider has cached, and all of it is paid for again.
    if (m.role === "system" || m.role === "developer") {
      if (messages.length === 0) system.push(...blocks(m.content));
      else add("user", blocks(m.content));
    } else if (m.role === "tool") add("user", [{ type: "tool_result", tool_use_id: String(m.tool_call_id ?? ""), content: textOf(m.content) }]);
    else if (m.role === "assistant") {
      const calls = list(m.tool_calls).flatMap((c): Doc[] =>
        isObj(c) && isObj(c.function) ? [{ type: "tool_use", id: String(c.id ?? ""), name: String(c.function.name ?? ""), input: args(c.function.arguments) }] : []);
      add("assistant", [...blocks(m.content), ...calls]);
    } else add("user", blocks(m.content));
  }
  let tools = list(body.tools).flatMap((t): Doc[] =>
    isObj(t) && isObj(t.function) ? [{ name: String(t.function.name ?? ""), ...(typeof t.function.description === "string" ? { description: t.function.description } : {}), input_schema: isObj(t.function.parameters) ? t.function.parameters : { type: "object", properties: {} } }] : []);
  if (cache) {
    system = marked(system, ttl);
    tools = marked(tools, ttl);
    // The turn before the last is marked too: a caller that rewrites its newest message between
    // requests leaves nothing at the last mark to read, and the conversation up to it still is.
    for (const turn of messages.slice(-2)) turn.content = marked(turn.content, ttl);
  }
  const choice = body.tool_choice;
  const stop = typeof body.stop === "string" ? [body.stop] : list(body.stop).filter((s) => typeof s === "string");
  const limit = [body.max_tokens, body.max_completion_tokens].find((n) => typeof n === "number" && n > 0);
  const effort = typeof body.reasoning_effort === "string" ? EFFORT[body.reasoning_effort] : undefined;
  // A caller that asks for an effort is asked for the thinking too: the API returns it empty unless summarized.
  const thinks = effort !== undefined && body.reasoning_effort !== "none" && body.reasoning_effort !== "minimal";
  return {
    model: body.model,
    max_tokens: limit ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && choice !== undefined
      ? { tool_choice: choice === "required" ? { type: "any" } : choice === "none" ? { type: "none" } : isObj(choice) && isObj(choice.function) ? { type: "tool", name: choice.function.name } : { type: "auto" } }
      : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(stop.length > 0 ? { stop_sequences: stop } : {}),
    ...(effort !== undefined ? { output_config: { effort } } : {}),
    ...(thinks ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
    ...(body.stream === true ? { stream: true } : {}),
  };
}

const FINISH: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls" };

/** What a Messages answer cost, as a chat completion's `usage`: input counts what was read from and written to the cache too. */
function usageOf(u: Doc): Doc {
  const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const read = n("cache_read_input_tokens");
  const input = n("input_tokens") + read + n("cache_creation_input_tokens");
  return { prompt_tokens: input, completion_tokens: n("output_tokens"), total_tokens: input + n("output_tokens"), prompt_tokens_details: { cached_tokens: read } };
}

/** A Messages answer as a chat completion. */
export function fromAnthropic(msg: Doc, model: string): Doc {
  const parts = list(msg.content).filter(isObj);
  const text = parts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join("");
  const thought = parts.filter((p) => p.type === "thinking").map((p) => String(p.thinking ?? "")).join("");
  const calls = parts.filter((p) => p.type === "tool_use").map((p) => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } }));
  return {
    id: `chatcmpl-${String(msg.id ?? "")}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text === "" && calls.length > 0 ? null : text, ...(thought ? { reasoning_content: thought } : {}), ...(calls.length > 0 ? { tool_calls: calls } : {}) },
      finish_reason: FINISH[String(msg.stop_reason)] ?? "stop",
    }],
    usage: usageOf(isObj(msg.usage) ? msg.usage : {}),
  };
}

/** A Messages stream read event by event, each answered with the chat completion chunks it amounts to. */
export class AnthropicStream {
  private id = "";
  private readonly created = Math.floor(Date.now() / 1000);
  private usage: Doc = {};
  private finish = "stop";
  /** Which tool call each content block is, by the block's index. */
  private readonly calls = new Map<number, number>();
  /** The usage event, once the answer has ended: sent on only to a caller who asked for it. */
  report: string | null = null;

  constructor(private readonly model: string) {}

  private chunk(delta: Doc, finish: string | null = null): string {
    return `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  }

  /** One event's `data`, parsed. */
  event(e: Doc): string {
    if (e.type === "message_start" && isObj(e.message)) {
      this.id = `chatcmpl-${String(e.message.id ?? "")}`;
      if (isObj(e.message.usage)) this.usage = { ...e.message.usage };
      return this.chunk({ role: "assistant", content: "" });
    }
    if (e.type === "content_block_start" && isObj(e.content_block) && e.content_block.type === "tool_use") {
      const at = this.calls.size;
      this.calls.set(Number(e.index), at);
      return this.chunk({ tool_calls: [{ index: at, id: e.content_block.id, type: "function", function: { name: e.content_block.name, arguments: "" } }] });
    }
    if (e.type === "content_block_delta" && isObj(e.delta)) {
      if (e.delta.type === "text_delta") return this.chunk({ content: e.delta.text });
      if (e.delta.type === "thinking_delta") return this.chunk({ reasoning_content: e.delta.thinking });
      if (e.delta.type === "input_json_delta") return this.chunk({ tool_calls: [{ index: this.calls.get(Number(e.index)) ?? 0, function: { arguments: e.delta.partial_json } }] });
      return "";
    }
    if (e.type === "message_delta") {
      if (isObj(e.delta) && typeof e.delta.stop_reason === "string") this.finish = FINISH[e.delta.stop_reason] ?? "stop";
      if (isObj(e.usage)) this.usage = { ...this.usage, ...e.usage };
      return "";
    }
    if (e.type === "message_stop") {
      this.report = `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: usageOf(this.usage) })}\n\n`;
      return this.chunk({}, this.finish);
    }
    if (e.type === "error" && isObj(e.error)) return streamErrorFrame(502, String(e.error.message ?? "the backend reported an error"));
    return "";
  }
}

/** What a failed Messages call said, as a chat completion error body. */
function errorBody(raw: string): Doc {
  try {
    const e = (JSON.parse(raw) as Doc).error;
    if (isObj(e)) return { error: { message: String(e.message ?? raw).slice(0, 500), type: String(e.type ?? "server_error") } };
  } catch {
    // Not JSON: said as it came.
  }
  return { error: { message: raw.slice(0, 500), type: "server_error" } };
}

/**
 * Relays a Messages answer as a chat completion's; returns the status. `usage` is whether the caller
 * asked for a stream's usage event; `meter` is given it either way.
 */
export async function relayAnthropic(up: UpstreamResponse, res: ServerResponse, o: { model: string; usage: boolean; meter?: Meter }): Promise<number> {
  // A stream opened early to report queue position already has its headers; failures then go in-band.
  const early = res.headersSent;
  const type = String(up.headers["content-type"] ?? "");
  if (up.status >= 400 || !type.includes("text/event-stream")) {
    const raw = await up.text();
    if (up.status >= 400) {
      if (early) res.end(streamErrorFrame(up.status, String((errorBody(raw).error as Doc).message)));
      else res.writeHead(up.status, { "Content-Type": "application/json" }).end(JSON.stringify(errorBody(raw)));
      return up.status;
    }
    let out: Doc;
    try {
      out = fromAnthropic(JSON.parse(raw) as Doc, o.model);
    } catch {
      out = { error: { message: "the backend's answer could not be read", type: "server_error" } };
    }
    res.writeHead("error" in out ? 502 : 200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
    return "error" in out ? 502 : 200;
  }
  if (!early) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  const stream = new AnthropicStream(o.model);
  const decoder = new StringDecoder("utf8");
  let held = "";
  const take = (): void => {
    for (let end = /\r?\n\r?\n/.exec(held); end; end = /\r?\n\r?\n/.exec(held)) {
      const data = held.slice(0, end.index).split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      held = held.slice(end.index + end[0].length);
      if (data === "") continue;
      try {
        const out = stream.event(JSON.parse(data) as Doc);
        if (out) res.write(out);
      } catch {
        // An event that is not JSON says nothing a caller could use.
      }
    }
  };
  for await (const c of up.body) {
    held += decoder.write(c as Buffer);
    take();
    // Not an event stream at all: nothing in it will ever be an event.
    if (held.length > MAX_HELD_CHARS) held = "";
  }
  held += `${decoder.end()}\n\n`;
  take();
  if (stream.report) {
    if (o.usage) res.write(stream.report);
    else o.meter?.feed(stream.report);
  }
  res.end("data: [DONE]\n\n");
  return 200;
}
