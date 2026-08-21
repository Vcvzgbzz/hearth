/**
 * Runtime on/off switches for the two directions federation runs in.
 *
 * Federation is two independent relationships and they fail at different times:
 * you may want to stop SENDING work to a friend who is rebuilding his box,
 * without also closing your door to him — or take your own GPU back for an hour
 * without giving up the ability to borrow. One switch covering both would force
 * a choice nobody wants to make.
 *
 * NOT PERSISTED, deliberately. The config file stays the single source of truth
 * for what this node intends to do, and these are a temporary override on top
 * of it. A pause that silently survived a reboot would be the worst kind of
 * stale state: months later, `share:` lists three models, the status page says
 * lending is off, and nothing in the repo explains why. Restart and you are
 * back to whatever the config says — which is discoverable, greppable, and in
 * version control. If a pause should outlive a restart, it belongs in the YAML.
 *
 * Sharing is finer-grained than lending: `lending` is the master switch, and
 * `setShare` overrides one model at a time on top of it. Both live here for the
 * same reason — the config says what this node intends to lend, and these are a
 * temporary answer to "not right now" or "go on then, take it".
 *
 * Both directions degrade GRACEFULLY rather than by erroring:
 *   - lending off  -> the share list reads empty. Peers see a healthy node
 *                     offering nothing, so their router simply stops choosing
 *                     us. Refusing with 403s instead would look like a broken
 *                     node or a revoked token, and someone would go debugging
 *                     their credentials.
 *   - borrowing off -> peers stop being routing candidates. Every policy path
 *                     in decide() already handles "no candidates" (including
 *                     honouring fallbackLocal), so this needs no new branch and
 *                     inherits behaviour that is already tested.
 */
export class Controls {
  private lending = true;
  private borrowing = true;
  /**
   * Per-model answers that beat the config list, either way.
   *
   * A Map with three states rather than two sets: false withholds something
   * `share:` offers, true lends something it does not, and ABSENT means "the
   * config decides". That third state is the one worth having — without it,
   * un-pausing a model would have to guess whether to put it back on the list,
   * and a model dropped from `share:` in the YAML would stay lent by a stale
   * override nobody remembers setting.
   */
  private readonly models = new Map<string, boolean>();

  /** May peers use our models right now? */
  get lendingOn(): boolean {
    return this.lending;
  }

  /** May our work be sent to peers right now? */
  get borrowingOn(): boolean {
    return this.borrowing;
  }

  /**
   * Apply a change. Undefined fields are left alone, so a caller can flip one
   * direction without having to know or restate the other — otherwise two
   * operators (or the status page and a curl) race and each clobbers the other's
   * setting with a stale copy.
   *
   * Returns what changed, so the caller can log the transitions and only the
   * transitions.
   */
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

  /**
   * The share list as it stands right now.
   *
   * Every share gate reads through this rather than `cfg.share` directly, which
   * is what makes one flag cover all of them — the peer chat gate, the warm
   * gate, /peer/state's advertisement and the peer view of /v1/models. A gate
   * that kept reading cfg.share would keep lending after the switch was off,
   * and it would be the least-tested gate that did it.
   */
  share(configured: readonly string[]): readonly string[] {
    if (!this.lending) return [];
    const out = configured.filter((m) => this.models.get(m) !== false);
    for (const [m, on] of this.models) if (on && !out.includes(m)) out.push(m);
    return out;
  }

  /**
   * Lend or withhold one model, or `null` to hand the decision back to the
   * config.
   *
   * Nothing is validated here on purpose. Whether a model exists is a question
   * about the backends, and this class deliberately knows nothing about them —
   * the caller holds the catalog and refuses there, where the error message can
   * list what you could have meant.
   */
  setShare(model: string, on: boolean | null): void {
    if (on === null) this.models.delete(model);
    else this.models.set(model, on);
  }

  /**
   * Forget every per-model override.
   *
   * For after the config file has been written with these values folded into
   * `share:`. Keeping them would be harmless but wrong in the way that matters:
   * the page marks an override as differing from the file, and it no longer
   * does.
   */
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
