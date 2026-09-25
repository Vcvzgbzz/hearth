/**
 * Hands shared hardware between backends that declare it (`resources: [gpu0]`). Admission
 * only: routing is untouched, a backend just waits for hardware another one holds.
 *
 * A holder keeps the card while it has work and yields after `MAX_HOLD_MS` once someone
 * waits, so neither the busiest backend starves the rest nor every job pays a cold load.
 * A claim is the enqueue time of a backend's oldest job it cannot start.
 */

/** Anything with identity; in practice the owning Scheduler. */
export type ResourceOwner = object;

/**
 * How long a holder may keep hardware once a neighbour waits; above a typical cold load.
 * ponytail: one value per node; make it per-resource if seats load at very different speeds.
 */
export const MAX_HOLD_MS = 30_000;

export interface ArbiterOptions {
  maxHoldMs?: number;
  /** Injected so a test can move time without waiting for it. */
  now?: () => number;
}

export class ResourceArbiter {
  /** resource name -> current owner. Absent means free. */
  private readonly holders = new Map<string, ResourceOwner>();
  /** owner -> what it is blocked on, and since when. Absent means not waiting. */
  private readonly claims = new Map<ResourceOwner, { resources: readonly string[]; since: number }>();
  /** owner -> when its current turn began. Absent means it holds nothing. */
  private readonly heldSince = new Map<ResourceOwner, number>();
  private readonly listeners = new Set<() => void>();
  private readonly maxHoldMs: number;
  private readonly now: () => number;

  constructor(opts: ArbiterOptions = {}) {
    this.maxHoldMs = opts.maxHoldMs ?? MAX_HOLD_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Is this hardware free for `owner`? What it already holds never blocks it. Ignores turn order. */
  available(resources: readonly string[], owner?: ResourceOwner): boolean {
    for (const r of resources) {
      const held = this.holders.get(r);
      if (held !== undefined && held !== owner) return false;
    }
    return true;
  }

  /** Record that `owner` has work waiting since `since` (oldest job's enqueue time), or clear with null. */
  claim(owner: ResourceOwner, resources: readonly string[], since: number | null): void {
    if (since === null) this.claims.delete(owner);
    else this.claims.set(owner, { resources, since });
  }

  /** The longest-waiting claimant that overlaps `resources`, excluding `owner`. */
  private waiter(
    resources: readonly string[],
    owner: ResourceOwner,
  ): { owner: ResourceOwner; since: number } | null {
    let best: { owner: ResourceOwner; since: number } | null = null;
    for (const [other, c] of this.claims) {
      if (other === owner) continue;
      if (!c.resources.some((r) => resources.includes(r))) continue;
      if (best === null || c.since < best.since) best = { owner: other, since: c.since };
    }
    return best;
  }

  /** Free, and nobody holds an older claim on any of it. */
  mayTake(resources: readonly string[], owner: ResourceOwner): boolean {
    if (!this.available(resources, owner)) return false;
    const ahead = this.waiter(resources, owner);
    if (ahead === null) return true;
    const mine = this.claims.get(owner);
    // No claim of our own means we have only just arrived, so anybody already
    // waiting was here first.
    return mine !== undefined && mine.since <= ahead.since;
  }

  /** Has `owner` had its turn while someone else waits? False when nothing is contended. */
  owed(resources: readonly string[], owner: ResourceOwner): boolean {
    const since = this.heldSince.get(owner);
    if (since === undefined) return false;
    if (this.now() - since < this.maxHoldMs) return false;
    return this.waiter(resources, owner) !== null;
  }

  /**
   * Take all of them or none, in sorted order so overlapping sets cannot deadlock. Starts the
   * turn and drops the claim.
   */
  acquire(resources: readonly string[], owner: ResourceOwner): boolean {
    if (!this.available(resources, owner)) return false;
    for (const r of [...resources].sort()) this.holders.set(r, owner);
    if (!this.heldSince.has(owner)) this.heldSince.set(owner, this.now());
    this.claims.delete(owner);
    return true;
  }

  /** Everything `owner` holds, released, then wake anyone waiting. */
  release(owner: ResourceOwner): void {
    let freed = false;
    for (const [r, held] of [...this.holders]) {
      if (held === owner) {
        this.holders.delete(r);
        freed = true;
      }
    }
    // The turn ends with the hold, so the next one starts a fresh quantum
    // rather than inheriting an expired one.
    this.heldSince.delete(owner);
    if (freed) for (const cb of [...this.listeners]) cb();
  }

  /** Who holds what, as a copy for status surfaces; nothing schedules off it. */
  snapshot(): [string, ResourceOwner][] {
    return [...this.holders];
  }

  /** Called whenever anything is released, so waiting schedulers re-pump. */
  onRelease(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
