/**
 * A sliding-window rate limit per key: at most `limit` events in any `windowMs`. Each key keeps
 * its timestamps oldest first; a check drops the expired ones from the front, so every timestamp
 * is added once and removed once and a check is amortized O(1). A refused event is not counted.
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number) {}

  /** Count one event for `key` and return true, or return false when `key` is at `limit`. */
  take(key: string, limit: number, now = Date.now()): boolean {
    const times = this.hits.get(key) ?? [];
    const cutoff = now - this.windowMs;
    while (times.length > 0 && times[0]! <= cutoff) times.shift();
    if (times.length >= limit) return false;
    times.push(now);
    this.hits.set(key, times);
    return true;
  }

  /** Forget keys with nothing left in the window, so one-off callers do not accumulate. */
  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) if (times.length === 0 || times[times.length - 1]! <= cutoff) this.hits.delete(key);
  }
}
