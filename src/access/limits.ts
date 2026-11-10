/**
 * The limits a caller is held to before its work is queued: what this node lends each peer, a
 * key's scope, requests a minute, tokens and dollars a day, and how many jobs a caller may hold.
 * Every refusal is a `Refusal` thrown with its status; the scheduler then decides when work starts.
 */
import { admitModel, callerCap } from "./admit.js";
import { Refusal } from "../errors.js";
import type { Callers } from "./callers.js";
import type { HearthConfig } from "../config/config.js";
import { ANY } from "../config/flows.js";
import { peersMapping } from "../config/peers.js";
import type { Controls } from "../peers/controls.js";
import type { KeyLimit } from "../queue/keytally.js";
import { closedWhy, limitsFor, spentWhy, termsFor } from "../peers/lending.js";
import type { BackendPool } from "../queue/pool.js";
import { entryOf } from "../routing/route.js";
import type { Usage } from "../observe/usage.js";
import type { Spent } from "../observe/views.js";
import { SlidingWindow } from "./window.js";
import type { Worlds } from "../routing/world.js";

/** Requests a peer may make of the control plane in an hour, apart from its inference budget so polling never starves real work. */
const CONTROL_LIMIT_PER_HOUR = 2_000;

/** Who is asking: a peer, or a local caller with the models its key may run (null for any). */
export interface Asker { peer: string | null; caller: string; models: string[] | null }

export class Limits {
  private readonly peerHour = new SlidingWindow(3_600_000);
  private readonly controlHour = new SlidingWindow(3_600_000);
  /** When each limited key, and each key on each model, last asked, for requests-a-minute. */
  private readonly keyMinute = new SlidingWindow(60_000);

  constructor(
    private readonly cfg: HearthConfig,
    private readonly pool: BackendPool,
    private readonly controls: Controls,
    private readonly usage: Usage,
    private readonly callers: Callers,
    private readonly worlds: Worlds,
  ) {}

  /** Why `peer` is turned away from everything right now, or null. */
  closedTo(peer: string): string | null {
    return closedWhy(termsFor(this.cfg, peer));
  }

  /** Why `peer` is turned away from one model right now under that model's limits, or null. */
  spentOn(peer: string, model: string): string | null {
    return spentWhy(model, limitsFor(termsFor(this.cfg, peer), model), this.usage.byModel(`peer:${peer}`, 1)[model]);
  }

  /**
   * What we lend right now, to one peer or (unnamed) by the node's own list: nothing while lending
   * is paused, nothing to a peer lent nothing, and no model whose day it has used. Every share gate reads this.
   */
  shared(peer?: string): readonly string[] {
    if (peer === undefined) return this.controls.share(this.cfg.share);
    if (this.closedTo(peer) !== null) return [];
    return this.controls.share(termsFor(this.cfg, peer).models).filter((m) => this.spentOn(peer, m) === null);
  }

  /** Is this a name some flow takes, here or in a router's rulebook? */
  isType(name: string): boolean {
    return [this.cfg.flows, ...Object.values(this.cfg.routers).map((r) => r.flows)]
      .some((flows) => Object.values(flows).some((f) => f.inputs.includes(name)));
  }

  /** Null when something here or on a mapped peer serves this id, else what is served instead. */
  unknownHere(m: string): string | null {
    return this.pool.models.certainlyUnknown(m) && peersMapping(m, [], this.cfg.peers).length === 0
      ? this.pool.models.catalog().join(", ") || "nothing"
      : null;
  }

  /**
   * The gates every model request passes before it is queued; throws the Refusal. With `flowed`, a
   * name nothing serves that a flow takes, the flow for every other name included, is left to that
   * flow to answer; true then, and the caller's limits are for the caller to check once it runs.
   */
  admit(c: Asker, model: string, flowed = false): boolean {
    const { cfg } = this;
    let deferred = false;
    // Said in its own words: a peer told only "does not share" cannot tell a spent day from a model it was never lent.
    const lent = c.peer !== null && this.controls.lendingOn && !termsFor(cfg, c.peer).off;
    const why = lent && this.controls.share(termsFor(cfg, c.peer!).models).includes(model) ? this.spentOn(c.peer!, model) : null;
    if (why !== null) throw new Refusal(429, `${cfg.name} is not lending you ${model} right now: ${why}`, "rate_limit_error");
    const refused = admitModel({ model, peer: c.peer, scope: c.models }, {
      name: cfg.name,
      shared: () => (c.peer !== null ? this.shared(c.peer) : this.shared()),
      type: (n) => this.isType(n),
      // A peer may map an id nothing here serves.
      unknown: (m) => {
        const flows = this.worlds.rulesFor(c.caller).flows;
        const instead = this.unknownHere(m);
        deferred = instead !== null && flowed && (entryOf(flows, m) ?? entryOf(flows, ANY)) !== undefined;
        return deferred ? null : instead;
      },
    });
    if (refused) throw refused;
    if (deferred) return true;
    // Counted only once the model is known to be lent, so a refused ask spends none of a model's hour.
    if (c.peer !== null && !this.peerHour.take(JSON.stringify([c.peer, model]), limitsFor(termsFor(cfg, c.peer), model).rateLimit)) {
      throw new Refusal(429, `rate capped for ${model}`, "rate_limit_error");
    }
    this.withinLimits(c.caller);
    return false;
  }

  /** A peer's call to the control plane (/peer/*): false once it is over its hourly budget. */
  controlAllowed(peer: string): boolean {
    return this.controlHour.take(peer, CONTROL_LIMIT_PER_HOUR);
  }

  /**
   * What a caller used over some days, with what it cost. ponytail: priced at what each model
   * costs now, not on the day; keep dollars in the ledger if prices change often enough to matter.
   */
  spent(caller: string, days: number): Spent {
    let cost = 0;
    for (const [model, row] of Object.entries(this.usage.byModel(caller, days))) {
      const p = this.cfg.models[model]?.price;
      const cached = Math.min(row.cached ?? 0, row.in);
      if (p) cost += ((row.in - cached) * p.in + cached * (p.cached ?? p.in) + row.out * p.out) / 1_000_000;
    }
    return { ...this.usage.total(caller, days), cost };
  }

  /** What holds a key's job to its jobs at once, read each time so a change reaches jobs already waiting. */
  keyLimitOf(caller: string, model: string): { keyLimit?: () => KeyLimit } {
    if (!caller.startsWith("key:")) return {};
    return { keyLimit: () => { const r = this.callers.ruleOf(caller); return { total: r?.maxConcurrent ?? 0, model: r?.models[model]?.maxConcurrent ?? 0 }; } };
  }

  /** The node's cap on a local caller, unless its key says how many it may run: that limit waits where the cap refuses. */
  capOf(caller: string, model: string): number | undefined {
    const r = this.callers.ruleOf(caller);
    return r !== null && (r.maxConcurrent > 0 || r.models[model]?.maxConcurrent !== undefined) ? undefined : callerCap(null, this.cfg);
  }

  /**
   * Jobs one caller may hold per lane. A peer's limit is one total over every model, since the
   * hardware is shared; a model's own limit caps that model as well.
   */
  capFor(peer: string | null, model: string): { maxPerCaller?: number; maxPerModel?: number } {
    const t = peer !== null ? termsFor(this.cfg, peer) : null;
    const cap = callerCap(peer, { scheduler: this.cfg.scheduler, peerMaxConcurrent: t !== null ? t.maxConcurrent : this.cfg.peerMaxConcurrent });
    const own = t?.limits?.[model]?.maxConcurrent;
    return { maxPerCaller: cap, ...(own !== undefined ? { maxPerModel: own } : {}) };
  }

  /** Hold a key to its limits: so many requests a minute, so many tokens a UTC day. Counts the request it lets through. */
  withinLimits(caller: string): void {
    const rule = this.callers.ruleOf(caller);
    if (!rule) return;
    if (rule.tokensPerDay > 0) {
      const used = this.usage.total(caller, 1);
      if (used.in + used.out >= rule.tokensPerDay) throw new Refusal(429, `this key has used its ${rule.tokensPerDay} tokens for today (UTC)`, "rate_limit_error");
    }
    if (rule.dollarsPerDay > 0 && this.spent(caller, 1).cost >= rule.dollarsPerDay) throw new Refusal(429, `this key has spent its $${rule.dollarsPerDay} for today (UTC)`, "rate_limit_error");
    if (rule.requestsPerMinute > 0 && !this.keyMinute.take(caller, rule.requestsPerMinute)) {
      throw new Refusal(429, `this key is limited to ${rule.requestsPerMinute} requests a minute`, "rate_limit_error");
    }
  }

  /** Hold a key to one model's own limits, once it is known which model runs. A routed path counts requests, not tokens. */
  withinModelLimits(caller: string, model: string, tokens = true): void {
    const rule = this.callers.ruleOf(caller)?.models[model];
    if (!rule) return;
    if (tokens && (rule.tokensPerDay ?? 0) > 0) {
      const used = this.usage.byModel(caller, 1)[model];
      if ((used?.in ?? 0) + (used?.out ?? 0) >= rule.tokensPerDay!) throw new Refusal(429, `this key has used its ${rule.tokensPerDay} tokens of ${model} for today (UTC)`, "rate_limit_error");
    }
    if ((rule.requestsPerMinute ?? 0) > 0 && !this.keyMinute.take(`${caller}\0${model}`, rule.requestsPerMinute!)) {
      throw new Refusal(429, `this key is limited to ${rule.requestsPerMinute} requests a minute of ${model}`, "rate_limit_error");
    }
  }

  /** Drop rate-limit entries with nothing left in their window. */
  prune(): void {
    this.peerHour.prune();
    this.controlHour.prune();
    this.keyMinute.prune();
  }
}
