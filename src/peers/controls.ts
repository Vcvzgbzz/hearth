/**
 * Runtime switches for lending and borrowing, separate because they fail at different times.
 * Operational, not config: a pause is not written to hearth.yaml, and a restart clears it.
 * Lending off reads as an empty share list; borrowing off leaves no peer candidates.
 */
export class Controls {
  private lending = true;
  private borrowing = true;

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
    return this.lending ? configured : [];
  }

  state(): { lending: boolean; borrowing: boolean } {
    return { lending: this.lending, borrowing: this.borrowing };
  }
}
