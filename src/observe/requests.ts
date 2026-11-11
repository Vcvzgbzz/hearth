/**
 * The most recent finished requests, one record each, for the console to draw as a trace: where
 * routing sent each, how long it waited and ran, and what it cost. Never a body, prompt, reply or
 * credential.
 */
import type { RequestTrace } from "./uidata.js";

// ponytail: a fixed in-memory cap; keep them in an indexed file if a day of requests is wanted.
export const REQUESTS_KEPT = 2_000;

export class RequestStore {
  /** Oldest first. */
  private kept: RequestTrace[] = [];

  constructor(private readonly keep: number = REQUESTS_KEPT) {}

  add(r: RequestTrace): void {
    this.kept.push(r);
    if (this.kept.length > this.keep) this.kept.splice(0, this.kept.length - this.keep);
  }

  /** The last record with this id: a request that fell back from a failed attempt has one per attempt. */
  get(id: string): RequestTrace | undefined {
    if (id === "") return undefined;
    return this.kept.findLast((r) => r.id === id);
  }

  /** Newest first, those that finished after `after` and match every filter given, at most `limit`. */
  list(q: { after?: number; limit?: number; model?: string; caller?: string; ok?: boolean } = {}): { requests: RequestTrace[]; oldest: number | null } {
    const limit = Math.min(Math.max(1, q.limit ?? 200), 1000);
    const out: RequestTrace[] = [];
    for (let i = this.kept.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.kept[i]!;
      if (q.after !== undefined && r.t <= q.after) break;
      if (q.model !== undefined && r.model !== q.model && r.asked !== q.model) continue;
      if (q.caller !== undefined && r.caller !== q.caller) continue;
      if (q.ok !== undefined && r.ok !== q.ok) continue;
      out.push(r);
    }
    return { requests: out, oldest: this.kept[0]?.t ?? null };
  }

  all(): RequestTrace[] {
    return [...this.kept];
  }

  /** Records saved by `all()`; anything that is not one, or a file without them, is passed over. */
  restore(saved: unknown): void {
    if (!Array.isArray(saved)) return;
    const ok = saved.filter((r): r is RequestTrace => typeof r === "object" && r !== null
      && typeof (r as RequestTrace).id === "string" && typeof (r as RequestTrace).t === "number" && typeof (r as RequestTrace).model === "string"
      && Array.isArray((r as RequestTrace).path));
    this.kept = [...ok, ...this.kept].slice(-this.keep);
  }
}
