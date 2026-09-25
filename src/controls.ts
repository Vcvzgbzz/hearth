/**
 * Runtime switches for lending and borrowing, separate because they fail at different times.
 * Not persisted: the config stays the source of truth, and a restart restores it.
 * Lending off reads as an empty share list; borrowing off leaves no peer candidates.
 */
export class Controls {
  private lending = true;
  private borrowing = true;
  /** Per-model share overrides: false withholds, true lends, absent defers to the config. */
  private readonly models = new Map<string, boolean>();

  /** May peers use our models right now? */
  get lendingOn(): boolean {
    return this.lending;
  }

  /** May our work be sent to peers right now? */
  get borrowingOn(): boolean {
    return this.borrowing;
  }

  /** Apply a change; undefined fields are left alone. Returns only what changed. */
  set(next: { lending?: boolean; borrowing?: boolean }): { lending?: boolean; borrowing?: boolean } {
    const changed: { lending?: boolean; borrowing?: boolean } = {};
    if (next.lending !== undefined && next.lending !== this.lending) {
      this.lending = next.lending;
      changed.lending = next.lending;
    }
    if (next.borrowing !== undefined && next.borrowing !== this.borrowing) {
      this.borrowing = next.borrowing;
      changed.borrowing = next.borrowing;
    }
    return changed;
  }

  /** The share list right now. Every share gate reads through this, not `cfg.share`. */
  share(configured: readonly string[]): readonly string[] {
    if (!this.lending) return [];
    const out = configured.filter((m) => this.models.get(m) !== false);
    for (const [m, on] of this.models) if (on && !out.includes(m)) out.push(m);
    return out;
  }

  /** Lend or withhold one model, or `null` to defer to the config. The caller validates the id. */
  setShare(model: string, on: boolean | null): void {
    if (on === null) this.models.delete(model);
    else this.models.set(model, on);
  }

  /** Forget every per-model override, once they have been written into `share:`. */
  clearShareOverrides(): void {
    this.models.clear();
  }

  /** The overrides in force, so the status page can mark which rows are saying
   *  something the YAML does not. */
  shareOverrides(): Record<string, boolean> {
    return Object.fromEntries(this.models);
  }

  state(): { lending: boolean; borrowing: boolean; models: Record<string, boolean> } {
    return { lending: this.lending, borrowing: this.borrowing, models: this.shareOverrides() };
  }
}
