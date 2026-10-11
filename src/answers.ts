/**
 * Answers kept for a while, for a model that says so: a request identical to one just answered
 * gets that answer back without running. Kept in memory, and gone with the process.
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

interface Kept {
  until: number;
  type: string;
  body: Buffer;
}

/** How many answers are kept at once, and the largest one worth keeping. */
// ponytail: one fixed budget for the node; per-model sizes if one model's answers crowd out another's.
export const KEEP_ANSWERS = 500;
export const KEEP_BYTES = 1_048_576;

export class Answers {
  private readonly kept = new Map<string, Kept>();

  constructor(private readonly now: () => number = Date.now) {}

  /** What names a request: the model it runs as and every field it was sent with. */
  key(model: string, payload: unknown): string {
    return createHash("sha256").update(model).update("\0").update(JSON.stringify(payload)).digest("hex");
  }

  get(key: string): { type: string; body: Buffer } | null {
    const hit = this.kept.get(key);
    if (!hit) return null;
    if (hit.until <= this.now()) {
      this.kept.delete(key);
      return null;
    }
    // Asked for again, it is the last to go.
    this.kept.delete(key);
    this.kept.set(key, hit);
    return hit;
  }

  /**
   * Watch what is written to `res` and keep it under `key` for `ms` once it has ended well: a 200,
   * small enough, and for a stream, one that reached its end. Never holds or alters a write.
   */
  keep(res: ServerResponse, key: string, ms: number): void {
    let chunks: Buffer[] | null = [];
    let size = 0;
    const take = (chunk: unknown): void => {
      if (chunks === null || chunk === undefined || chunk === null || typeof chunk === "function") return;
      const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk instanceof Uint8Array ? Buffer.from(chunk) : null;
      if (b === null) return;
      size += b.length;
      if (size > KEEP_BYTES) chunks = null;
      else chunks.push(b);
    };
    const { write, end } = res;
    res.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
      take(chunk);
      return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
    } as typeof res.write;
    res.end = function (this: ServerResponse, chunk?: unknown, ...rest: unknown[]) {
      take(chunk);
      return (end as (...a: unknown[]) => ServerResponse).call(this, chunk, ...rest);
    } as typeof res.end;
    res.once("finish", () => {
      if (chunks === null || res.statusCode !== 200) return;
      const body = Buffer.concat(chunks);
      const type = String(res.getHeader("content-type") ?? "application/json");
      // A stream cut short is half an answer; one that failed after its 200 carries the error as a frame.
      if (type.includes("text/event-stream") && (!body.includes("[DONE]") || body.includes('data: {"error"'))) return;
      this.kept.set(key, { until: this.now() + ms, type, body });
      while (this.kept.size > KEEP_ANSWERS) this.kept.delete(this.kept.keys().next().value!);
    });
  }
}
