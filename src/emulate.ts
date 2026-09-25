/**
 * `emulate: llama-server`: reshapes an OpenAI-style backend's answers (vLLM) into llama-server's.
 * Renames `reasoning` to `reasoning_content` and rebuilds `timings` from `usage` and our own clock.
 */
import type { ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";

import type { UpstreamResponse } from "./upstream.js";

export type Emulation = "llama-server";

export const EMULATIONS: readonly Emulation[] = ["llama-server"];

/** Asks for the usage chunk a streamed answer needs for timings. */
export function emulatedRequest(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.stream !== true) return payload;
  const opts = (payload.stream_options ?? {}) as Record<string, unknown>;
  return { ...payload, stream_options: { ...opts, include_usage: true } };
}

interface Clock {
  sentAt: number;
  firstAt: number;
  lastAt: number;
}

function renameReasoning(obj: Record<string, unknown> | undefined): boolean {
  if (!obj || typeof obj.reasoning !== "string") return false;
  if (obj.reasoning_content === undefined) obj.reasoning_content = obj.reasoning;
  delete obj.reasoning;
  return true;
}

function timings(usage: Record<string, unknown>, clock: Clock): Record<string, number> {
  const prompt = Number(usage.prompt_tokens ?? 0);
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cached = Math.min(prompt, Number(details.cached_tokens ?? 0));
  const predicted = Number(usage.completion_tokens ?? 0);
  const promptMs = clock.firstAt > 0 ? clock.firstAt - clock.sentAt : 0;
  const predictedMs = clock.firstAt > 0 ? Math.max(0, clock.lastAt - clock.firstAt) : Date.now() - clock.sentAt;
  // The first token lands at firstAt, so the rate counts the ones after it.
  const rateTokens = clock.firstAt > 0 ? predicted - 1 : predicted;
  return {
    prompt_n: prompt - cached,
    cache_n: cached,
    prompt_ms: promptMs,
    prompt_per_second: promptMs > 0 ? ((prompt - cached) * 1000) / promptMs : 0,
    predicted_n: predicted,
    predicted_ms: predictedMs,
    predicted_per_second: predictedMs > 0 && rateTokens > 0 ? (rateTokens * 1000) / predictedMs : 0,
  };
}

/** Rewrites one parsed chunk or body in place; true if it carried output. */
function adapt(obj: Record<string, unknown>): boolean {
  let produced = false;
  for (const c of (obj.choices ?? []) as Record<string, unknown>[]) {
    const part = (c.delta ?? c.message) as Record<string, unknown> | undefined;
    if (!part) continue;
    const reasoned = renameReasoning(part);
    if (reasoned || part.content || part.tool_calls) produced = true;
  }
  return produced;
}

function stamp(obj: Record<string, unknown>, clock: Clock): void {
  if (obj.usage && typeof obj.usage === "object") {
    obj.timings = timings(obj.usage as Record<string, unknown>, clock);
  }
}

/** Relays an upstream answer reshaped as llama-server's; returns the status. */
export async function relayEmulated(
  up: UpstreamResponse,
  res: ServerResponse,
  headers: Record<string, string | string[]>,
  sentAt: number,
): Promise<number> {
  const clock: Clock = { sentAt, firstAt: 0, lastAt: 0 };
  const type = String(up.headers["content-type"] ?? "application/json");
  res.writeHead(up.status, { ...headers, "Content-Type": type, "X-Accel-Buffering": "no" });

  if (up.status >= 400 || !type.includes("text/event-stream")) {
    const chunks: Buffer[] = [];
    for await (const c of up.body) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    if (up.status >= 400) {
      res.end(raw);
      return up.status;
    }
    try {
      const body = JSON.parse(raw) as Record<string, unknown>;
      adapt(body);
      stamp(body, clock);
      res.end(JSON.stringify(body));
    } catch {
      res.end(raw);
    }
    return up.status;
  }

  const decoder = new StringDecoder("utf8");
  let pending = "";
  const line = (text: string): string => {
    if (!text.startsWith("data:")) return text;
    const data = text.slice(5).trim();
    if (data === "" || data === "[DONE]") return text;
    try {
      const obj = JSON.parse(data) as Record<string, unknown>;
      if (adapt(obj)) {
        const now = Date.now();
        if (clock.firstAt === 0) clock.firstAt = now;
        clock.lastAt = now;
      }
      stamp(obj, clock);
      return `data: ${JSON.stringify(obj)}`;
    } catch {
      return text;
    }
  };
  for await (const c of up.body) {
    pending += decoder.write(c as Buffer);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (lines.length) res.write(lines.map(line).join("\n") + "\n");
  }
  pending += decoder.end();
  res.end(pending ? line(pending) : undefined);
  return up.status;
}
