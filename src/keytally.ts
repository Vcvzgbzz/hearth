/**
 * How many jobs each key is running across every backend. Each backend has its own scheduler,
 * and a key's limit is one number over all of them, so the count lives here and they share it.
 */

/** Jobs a key may run at once: over all models, and of this model. 0 is no limit. */
export interface KeyLimit {
  total: number;
  model: number;
}

export class KeyTally {
  private readonly totals = new Map<string, number>();
  private readonly perModel = new Map<string, number>();
  private readonly listeners: (() => void)[] = [];

  private static at(caller: string, model: string): string {
    return `${caller}\0${model}`;
  }

  private static bump(counts: Map<string, number>, key: string, by: number): void {
    const n = (counts.get(key) ?? 0) + by;
    if (n > 0) counts.set(key, n);
    else counts.delete(key);
  }

  started(caller: string, model: string): void {
    KeyTally.bump(this.totals, caller, 1);
    KeyTally.bump(this.perModel, KeyTally.at(caller, model), 1);
  }

  ended(caller: string, model: string): void {
    KeyTally.bump(this.totals, caller, -1);
    KeyTally.bump(this.perModel, KeyTally.at(caller, model), -1);
    for (const fn of this.listeners) fn();
  }

  /** Is this caller at its limit for this model? */
  full(caller: string, model: string, limit: KeyLimit): boolean {
    if (limit.total > 0 && (this.totals.get(caller) ?? 0) >= limit.total) return true;
    return limit.model > 0 && (this.perModel.get(KeyTally.at(caller, model)) ?? 0) >= limit.model;
  }

  /** Runs after any job ends, so a waiter on another backend is looked at. */
  onEnded(fn: () => void): void {
    this.listeners.push(fn);
  }
}
