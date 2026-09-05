/**
 * Mutual exclusion between backends that share physical hardware.
 *
 * A backend is an admission domain, but it is not always an independent one.
 * Two llama-swap instances pinned to the same GPU are two backends and one
 * piece of silicon; a model large enough to span every card is one backend that
 * consumes all of them. Nothing in the per-backend queues can see that, so both
 * dispatch happily and the card is over-committed — which on some drivers is
 * not a slow request but a wedged GPU.
 *
 * So a backend may declare what it consumes, and this serializes the ones that
 * overlap:
 *
 *     backends:
 *       - name: swap          # one card
 *         resources: [gpu0]
 *       - name: swap-image    # the other
 *         resources: [gpu1]
 *       - name: deep          # a model that needs both
 *         resources: [gpu0, gpu1]
 *
 * THIS IS NOT SCHEDULING ACROSS BACKENDS. Routing is untouched: a model still
 * resolves to exactly one backend by the same rules it always did, and nothing
 * here ever decides a job would be better off somewhere else. What changes is
 * admission — a backend waits for hardware another backend is using. Placement
 * and exclusion are different questions, and only the first one was ever
 * disclaimed.
 *
 * A backend holds its resources for as long as it has ANY job running, not per
 * job: its concurrency already says how much work it may run at once, and a
 * second job on the same backend must not have to re-acquire what the first one
 * is already holding.
 *
 * Declaring nothing means competing for nothing, which is every existing config.
 */

/** Anything with identity; in practice the owning Scheduler. */
export type ResourceOwner = object;

export class ResourceArbiter {
  /** resource name -> current owner. Absent means free. */
  private readonly holders = new Map<string, ResourceOwner>();
  private readonly listeners = new Set<() => void>();

  /**
   * Could `owner` take all of these right now?
   *
   * Resources it already holds do not block it — re-entrance is the normal case
   * for a backend admitting a second job while its first is still running.
   */
  available(resources: readonly string[], owner?: ResourceOwner): boolean {
    for (const r of resources) {
      const held = this.holders.get(r);
      if (held !== undefined && held !== owner) return false;
    }
    return true;
  }

  /**
   * Take all of them, or none.
   *
   * All-or-nothing matters: a partial take is how two backends each holding
   * half of what they need wait on each other forever. Acquiring in sorted
   * order on top of that means two callers wanting overlapping sets always
   * contend on the same first resource, so one of them loses the whole set
   * rather than both stalling holding part of it.
   */
  acquire(resources: readonly string[], owner: ResourceOwner): boolean {
    if (!this.available(resources, owner)) return false;
    for (const r of [...resources].sort()) this.holders.set(r, owner);
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
    if (freed) for (const cb of [...this.listeners]) cb();
  }

  /** Called whenever anything is released, so waiting schedulers re-pump. */
  onRelease(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
