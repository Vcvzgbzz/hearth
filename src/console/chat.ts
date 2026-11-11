/**
 * The Playground's pure parts: reading a chat completion as it streams in, splitting a reply into
 * text and fenced code, and the one line of facts said under an answer.
 */
import type { RequestTrace } from "../observe/uidata.js";

/** What has arrived of one reply so far. */
export interface Reply {
  text: string;
  reasoning: string;
  error?: string;
  model?: string;
  tokens?: number;
  /** `[DONE]` was seen, or a whole body was read. */
  done: boolean;
}

type Chunk = {
  model?: string;
  error?: { message?: string } | string;
  usage?: { completion_tokens?: number };
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown }; message?: { content?: unknown; reasoning_content?: unknown } }[];
};

/**
 * Reads `/v1/chat/completions` as it arrives: SSE `data:` lines in chunks split anywhere, comment and
 * blank lines skipped, or, when the backend ignored `stream`, one JSON body read at the end.
 */
export class StreamParser {
  readonly reply: Reply = { text: "", reasoning: "", done: false };
  private buf = "";
  private body: boolean | null = null;

  push(chunk: string): void {
    this.buf += chunk;
    if (this.body === null && this.buf.trim() !== "") this.body = this.buf.trimStart().startsWith("{");
    if (this.body !== false) return;
    const lines = this.buf.split("\n");
    this.buf = lines.pop()!;
    for (const l of lines) this.line(l);
  }

  /** The stream closed: what is left in the buffer is the last line, or the whole body. */
  end(): Reply {
    if (this.body) {
      try { this.apply(JSON.parse(this.buf) as Chunk, "message"); } catch { this.reply.error ??= "the answer was not JSON"; }
      this.reply.done = true;
    } else this.line(this.buf);
    this.buf = "";
    return this.reply;
  }

  private line(raw: string): void {
    const l = raw.replace(/\r$/, "");
    if (!l.startsWith("data:")) return;
    const data = l.slice(5).trim();
    if (data === "[DONE]") { this.reply.done = true; return; }
    try { this.apply(JSON.parse(data) as Chunk, "delta"); } catch { /* a line that is not JSON says nothing */ }
  }

  private apply(c: Chunk, part: "delta" | "message"): void {
    if (c.error) this.reply.error = typeof c.error === "string" ? c.error : c.error.message ?? "the backend failed";
    if (c.model) this.reply.model = c.model;
    if (typeof c.usage?.completion_tokens === "number") this.reply.tokens = c.usage.completion_tokens;
    const d = c.choices?.[0]?.[part];
    if (typeof d?.content === "string") this.reply.text += d.content;
    if (typeof d?.reasoning_content === "string") this.reply.reasoning += d.reasoning_content;
  }
}

/** A reply as plain text and fenced code blocks; a fence still open while streaming runs to the end. */
export function segments(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let code = false;
  let cur: string[] = [];
  const flush = () => { if (cur.length || code) out.push({ code, text: cur.join("\n") }); cur = []; };
  for (const l of text.split("\n")) {
    if (l.trimStart().startsWith("```")) { flush(); code = !code; } else cur.push(l);
  }
  if (cur.length) out.push({ code, text: cur.join("\n") });
  return out.filter((s) => s.code || s.text.trim() !== "");
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** What a finished request took, start to end, as the facts line says it. */
export const totalMs = (t: Pick<RequestTrace, "runMs"> & Partial<Pick<RequestTrace, "waitedMs">>) => (t.waitedMs ?? 0) + t.runMs;

/** One line under an answer: where it ran and how fast. Parts the record does not hold are left out. */
export function factsLine(t: Pick<RequestTrace, "runMs"> & Partial<Pick<RequestTrace, "model" | "target" | "backend" | "peer" | "waitedMs" | "firstByteMs" | "tokensOut">>): string {
  const where = t.peer ? ` on ${t.peer}` : t.target === "cache" ? " from the cache" : t.backend ? ` on ${t.backend}` : "";
  const parts = [t.model ? `ran as ${t.model}${where}` : where.trim()];
  if (t.waitedMs !== undefined) parts.push(`waited ${sec(t.waitedMs)}`);
  if (t.firstByteMs !== undefined) parts.push(`first token ${sec(t.firstByteMs)}`);
  parts.push(sec(totalMs(t)));
  if (t.tokensOut !== undefined) {
    parts.push(`${t.tokensOut} tokens`);
    const gen = t.runMs - (t.firstByteMs ?? 0);
    if (gen > 0 && t.tokensOut > 0) parts.push(`${Math.round(t.tokensOut / (gen / 1000))} tok/s`);
  }
  return parts.filter(Boolean).join(" · ");
}

/** The names the Playground offers, types first then models; a type whose rule takes other paths is not chat and is left out, as is a model only it answers to. */
export function chatNames(flows: { inputs: string[]; takes?: string[] }[], catalog: string[]): { types: string[]; models: string[] } {
  const ruleOf = (n: string) => flows.find((f) => f.inputs.includes(n));
  const chat = (n: string) => (ruleOf(n)?.takes ?? []).length === 0;
  const types = [...new Set(flows.flatMap((f) => f.inputs))].filter((n) => n !== "*" && chat(n));
  return { types, models: catalog.filter((m) => !types.includes(m) && chat(m)) };
}
