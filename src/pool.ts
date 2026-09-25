/**
 * The local backends and which one serves a model. Each is its own admission domain (queue,
 * concurrency, warm state), so an embedder never waits behind a GPU generation. Nothing
 * schedules across backends; shared hardware only makes one wait for another.
 */
import type { BackendConfig, HearthConfig, ModelRoute, RouteRule } from "./config.js";
import { BackendState } from "./backend.js";
import type { Logger } from "./log.js";
import { mergeStats, type ModelStats, type Need } from "./stats.js";
import { ResourceArbiter } from "./resources.js";
import { Scheduler } from "./scheduler.js";

/** The budget for a whole clear-the-card sequence, which may unload several neighbours. */
const EVICT_BUDGET_MS = 45_000;

/** One backend, with the queue that fronts it. */
export interface BackendSlot {
  name: string;
  cfg: BackendConfig;
  state: BackendState;
  scheduler: Scheduler;
}

/** One node's numbers, summed across its backends. */
export interface NodeCapacity {
  slots: number;
  free: number;
  running: number;
  offbox: number;
  queued: Record<string, number>;
  resident: string | null;
}

/** What a peer needs to know to score one model against its own copy. */
export interface ModelCapacity {
  slots: number;
  free: number;
  queued: number;
  warm: boolean;
}

export class BackendPool {
  private readonly slots: BackendSlot[] = [];
  private readonly byName = new Map<string, BackendSlot>();
  /** Complained-about ambiguous ids, so a duplicate warns once and not per request. */
  private readonly warned = new Set<string>();
  /** Hardware shared between backends, so overlapping ones take turns; inert without `resources`. */
  private readonly arbiter = new ResourceArbiter();
  /** Declared non-OpenAI paths -> who serves them. See BackendConfig.routes. */
  private readonly byPath = new Map<string, { slot: BackendSlot; rule: RouteRule }>();
  /** Routes carrying a {model} segment, in declaration order. */
  private readonly patterns: { slot: BackendSlot; rule: RouteRule; re: RegExp }[] = [];
  /** A backend's arbitrated resources: shared ones are filtered out here, but still drawn. */
  private arbitrated(names: readonly string[]): string[] {
    return names.filter((n) => !this.cfg.resources[n]?.shared);
  }

  /** The last twenty handoffs, so a card changing hands shows on the status page. */
  private readonly evicted: { t: number; backend: string; for: string; resources: string[] }[] = [];

  constructor(
    private readonly cfg: HearthConfig,
    private readonly log: Logger,
  ) {
    for (const b of cfg.backends) {
      const state = new BackendState(b.url, b.kind, log);
      const slot: BackendSlot = {
        name: b.name,
        cfg: b,
        state,
        scheduler: new Scheduler({
          lanes: cfg.scheduler.lanes,
          concurrency: b.concurrency,
          agePerSecond: cfg.scheduler.agePerSecond,
          warmBonus: cfg.scheduler.warmBonus,
          maxPerLane: cfg.scheduler.maxPerLane,
          resident: () => state.resident(),
          // A predicate in the backend's vocabulary, so aliased ids of a resident model are warm too.
          warm: (m) => state.isWarm(this.outboundId(m)),
          // Keyed by the id we advertise, which is what submit() puts on a job.
          // Undeclared is null, not the backend's number: the scheduler owns
          // that fallback, and answering it here would freeze the value.
          slots: (m) => this.slotsOf(m),
          pool: (m) => this.poolOf(m)?.tokens ?? null,
          // Two ids that resolve to the same resident model ARE the same model
          // to a backend that batches; without this the scheduler sees a
          // foreign job and refuses to run them together.
          wire: (m) => this.outboundId(m),
          // Ollama serves a resident set side by side, so a model's ceiling counts its own jobs.
          coresident: b.kind === "ollama",
          resources: this.arbitrated(b.resources),
          arbiter: this.arbiter,
          // Ask overlapping backends to unload before we load; weights stay resident after a run.
          evict: this.arbitrated(b.resources).length > 0 ? () => this.evictFor(b) : undefined,
        }),
      };
      this.slots.push(slot);
      this.byName.set(b.name, slot);
      for (const r of b.routes) {
        if (r.path.includes("{model}")) {
          const re = new RegExp(
            "^" + r.path.split("{model}")
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join("([^/]+)") + "$",
          );
          this.patterns.push({ slot, rule: r, re });
        } else {
          this.byPath.set(r.path, { slot, rule: r });
        }
      }
    }
  }

  /**
   * The backend that declared this request path, by exact match. `{model}` matches one segment,
   * and only a model this backend serves, so a pattern cannot pull in unrelated traffic.
   */
  forPath(pathname: string): { slot: BackendSlot; rule: RouteRule } | undefined {
    const exact = this.byPath.get(pathname);
    if (exact) return exact;
    for (const p of this.patterns) {
      const m = p.re.exec(pathname);
      if (!m) continue;
      let model: string;
      try {
        model = decodeURIComponent(m[1]!);
      } catch {
        continue; // a malformed escape is not a model id
      }
      // Match the captured segment in the backend's vocabulary, so an aliased id still routes.
      if (!this.declaredBy(p.slot, this.outboundId(model))) continue;
      return { slot: p.slot, rule: { ...p.rule, model } };
    }
    return undefined;
  }

  /** Does this backend serve this id: declared in `serves`, else reported by it? */
  private declaredBy(slot: BackendSlot, model: string): boolean {
    if (slot.cfg.serves.length) return slot.cfg.serves.includes(model);
    return slot.state.catalog().includes(model);
  }

  /**
   * Clear every other backend off the hardware `b` just took, one at a time and within
   * EVICT_BUDGET_MS. A refusal fails the job; a neighbour that never answers is given up on.
   */
  private async evictFor(b: BackendConfig): Promise<void> {
    // Shared hardware never causes an eviction: that is the whole hazard this
    // exists to remove. Six sidecars on one CPU must not unload each other.
    const mine = this.arbitrated(b.resources);
    const overlap = this.slots.filter(
      (s) => s.name !== b.name && this.arbitrated(s.cfg.resources).some((r) => mine.includes(r)),
    );
    const deadline = Date.now() + EVICT_BUDGET_MS;
    for (const s of overlap) {
      if (!s.state.resident()) continue;
      if (Date.now() >= deadline) {
        this.log.warn("pool.evict_budget", {
          for: b.name, resources: mine, skipped: s.name, budgetMs: EVICT_BUDGET_MS,
        });
        break;
      }
      this.log.info("pool.evict", { backend: s.name, for: b.name, resources: mine });
      this.evicted.push({ t: Date.now(), backend: s.name, for: b.name, resources: [...mine] });
      while (this.evicted.length > 20) this.evicted.shift();
      await s.state.unload();
    }
  }

  /** Recent handoffs, oldest first. See `evicted`. */
  evictions(): readonly { t: number; backend: string; for: string; resources: string[] }[] {
    return [...this.evicted];
  }

  /** Declared hardware, who is running on it, and who competes for it. `holder` is running, not resident. */
  resources(): { name: string; kind: "gpu" | "cpu" | "other"; shared: boolean; holder: string | null; backends: string[] }[] {
    const held = new Map(this.arbiter.snapshot());
    const names = [...new Set(this.slots.flatMap((s) => s.cfg.resources))].sort();
    return names.map((name) => {
      // An undeclared name is an exclusive gpu: that is what every config
      // written before declarations existed meant by it, and what the arbiter
      // has always done with it.
      const decl = this.cfg.resources[name] ?? { kind: "gpu" as const, shared: false };
      return {
        name,
        kind: decl.kind,
        shared: decl.shared,
        // Map the holder back to a backend name; a shared resource never has one.
        holder: decl.shared
          ? null
          : this.slots.find((s) => held.get(name) === s.scheduler)?.name ?? null,
        backends: this.slots.filter((s) => s.cfg.resources.includes(name)).map((s) => s.name),
      };
    });
  }

  all(): BackendSlot[] {
    return [...this.slots];
  }

  get(name: string): BackendSlot | undefined {
    return this.byName.get(name);
  }

  /** The one every unknown model falls back to. */
  first(): BackendSlot {
    return this.slots[0]!;
  }

  get single(): boolean {
    return this.slots.length === 1;
  }

  /**
   * Which backend serves this model: a config pin, else the one catalogue listing it, else
   * the first backend (an unlisted id may still load there).
   */
  for(model: string): BackendSlot {
    const pinned = this.cfg.models[model]?.backend;
    if (pinned) {
      const slot = this.byName.get(pinned);
      // Unreachable while backends are fixed at startup; warned rather than silently misrouted.
      if (slot) return slot;
      // Namespaced, since a backend and a model may share a name.
      if (!this.warned.has(`pin:${pinned}`)) {
        this.warned.add(`pin:${pinned}`);
        this.log.warn("backend.pinned_missing", {
          model,
          pinned,
          available: this.slots.map((s) => s.name),
          // The pin is ignored and normal resolution runs.
          hint: `ignoring the pin and resolving ${model} by catalogue — set models.${model}.backend to a real name`,
        });
      }
    }

    // Past the pin, compare in the backend's vocabulary, so an aliased id is found.
    const wire = this.outboundId(model);

    // A backend that declares what it serves is believed, and nothing else
    // resolves to it. Discovery only speaks for backends that stayed quiet.
    const declared = this.slots.find((s) => s.cfg.serves.includes(wire));
    if (declared) return declared;

    const claiming = this.slots.filter(
      (s) => s.cfg.serves.length === 0 && s.state.catalog().includes(wire),
    );
    if (claiming.length === 1) return claiming[0]!;
    if (claiming.length > 1) {
      if (!this.warned.has(model)) {
        this.warned.add(model);
        this.log.warn("backend.ambiguous_model", {
          model,
          backends: claiming.map((s) => s.name),
          chose: claiming[0]!.name,
          hint: `set models.${model}.backend to pick one and silence this`,
        });
      }
      return claiming[0]!;
    }
    return this.first();
  }

  /**
   * The model a routed request is queued as: the route's model, unless the caller's id is this
   * backend's own, so an arbitrary string never mints a queue entry.
   */
  routedModel(slot: BackendSlot, rule: RouteRule, asked: string | undefined): string {
    if (asked === undefined || asked === rule.model) return rule.model;
    if (this.cfg.models[asked]?.backend === slot.name) return asked;
    const wire = this.outboundId(asked);
    if (slot.cfg.serves.includes(wire) || slot.state.catalog().includes(wire)) return asked;
    return rule.model;
  }

  /** True only when every backend declares what it serves and none names this id, so a typo can be refused. */
  certainlyUnknown(model: string): boolean {
    // Named in `models:` — the operator said this id means something, and
    // `backend`/`as` may point it somewhere this check cannot see.
    if (this.cfg.models[model]) return false;
    const wire = this.outboundId(model);
    for (const s of this.slots) {
      if (s.cfg.serves.length === 0) return false;
      if (s.cfg.serves.includes(wire) || s.cfg.serves.includes(model)) return false;
      for (const r of s.cfg.routes) if (r.model === wire || r.model === model) return false;
    }
    return true;
  }

  /** The id to put on the wire for an advertised id (`as`), used by every dispatch path and catalogue comparison. */
  outboundId(model: string): string {
    return this.cfg.models[model]?.as ?? model;
  }

  /** A model's shared-context pool, inherited from the seat it fronts like its slots. */
  private poolOf(model: string): ModelRoute["pool"] {
    const r = this.cfg.models[model];
    if (!r) return null;
    return r.pool ?? (r.as === null ? null : this.cfg.models[r.as]?.pool ?? null);
  }

  /** What a request holds of its model's pool while it runs, or undefined without one. */
  poolTokens(model: string, need: Need): number | undefined {
    const p = this.poolOf(model);
    if (!p) return undefined;
    const output = need.output ?? 0;
    return need.tokens - output + Math.min(output, p.output ?? output);
  }

  /** A model's slot ceiling, inherited from the seat it fronts when it declares none. */
  private slotsOf(model: string): number | null {
    const r = this.cfg.models[model];
    if (!r) return null;
    if (r.as === null) return r.concurrency;
    return r.concurrency ?? this.cfg.models[r.as]?.concurrency ?? null;
  }

  /**
   * The chat body for the backend: `as` for the id and the route's `params` over the client's.
   * `wire` overrides the id for a peer, and params still apply. Untouched when neither is set.
   */
  outboundBody(
    model: string,
    payload: Record<string, unknown>,
    wire: string = this.outboundId(model),
  ): Record<string, unknown> {
    const params = this.cfg.models[model]?.params ?? null;
    if (wire === model && params === null) return payload;
    return { ...payload, ...(params ?? {}), model: wire };
  }

  /** Every advertised id for a backend's `raw` id: its aliases, plus `raw` when it is a first-class id. */
  private advertisedIds(raw: string): string[] {
    const ids: string[] = [];
    for (const [id, route] of Object.entries(this.cfg.models)) {
      if (route.as === raw) ids.push(id);
    }
    if (ids.length === 0 || this.cfg.models[raw] !== undefined) ids.push(raw);
    return ids;
  }

  /** The id we advertise for something a backend calls `raw`. The way back
   *  from a backend's vocabulary into ours, for anything read off the wire. */
  advertised(raw: string): string {
    return this.advertisedId(raw);
  }

  /** The advertised id for a backend's `raw` id, if we alias it. */
  private advertisedId(raw: string): string {
    // Built per call rather than cached: `models` is small, and a cache here
    // would need invalidating on any future config reload.
    for (const [id, route] of Object.entries(this.cfg.models)) {
      if (route.as === raw) return id;
    }
    return raw;
  }

  /** Everything any backend could serve, deduped; a backend's declared `serves` replaces what it reports. */
  catalog(): string[] {
    const out = new Set<string>();
    for (const s of this.slots) {
      for (const m of s.cfg.serves.length ? s.cfg.serves : s.state.catalog()) {
        // Advertise our names, never the backend's raw id behind an alias.
        for (const id of this.advertisedIds(m)) out.add(id);
      }
    }
    return [...out];
  }

  /** The learned context window for an advertised id, or null until it has loaded once. */
  contextLength(model: string): number | null {
    return this.statsFor(model)?.context ?? null;
  }

  /** Declared stats under observed ones for an advertised id; a variant falls back to its parent's declaration. */
  statsFor(model: string): ModelStats | null {
    const route = this.cfg.models[model];
    const declared = route?.stats ?? (route?.as ? this.cfg.models[route.as]?.stats : null) ?? null;
    const merged = mergeStats(declared, this.for(model).state.statsFor(this.outboundId(model)));
    const note = this.cfg.notes?.[model] ?? (route?.as ? this.cfg.notes?.[route.as] : undefined);
    return note ? { ...merged, note } : merged;
  }

  /** Everything warm anywhere. Several at once is normal now: one backend per
   *  model means several models can be resident simultaneously. */
  loaded(): string[] {
    const out = new Set<string>();
    for (const s of this.slots) {
      // With `serves` declared, trust ids the backend reports when usable; otherwise the declared names.
      if (s.cfg.serves.length) {
        // Expand each warm id through advertisedIds: aliases of one resident model are warm together.
        const raw = s.state.loaded();
        const recognised = raw.filter((m) => s.cfg.serves.includes(m));
        if (recognised.length) {
          for (const m of recognised) for (const id of this.advertisedIds(m)) out.add(id);
        } else if (raw.length) {
          for (const m of s.cfg.serves) for (const id of this.advertisedIds(m)) out.add(id);
        }
        continue;
      }
      // Translated too, and this one is NOT cosmetic: warm state feeds the
      // scheduler's warm bonus and the "ready now" set. Left raw, an aliased
      // model would read as permanently cold and quietly lose its priority.
      for (const m of s.state.loaded()) for (const id of this.advertisedIds(m)) out.add(id);
    }
    return [...out];
  }

  /** Capacity for one model: that of the backend serving it. */
  capacityFor(model: string): ModelCapacity {
    const slot = this.for(model);
    // Per model, not the backend's flat number: a batching model can take work
    // the backend as a whole looks too busy for, and a peer deciding where to
    // send a job is exactly who needs to know that.
    const cap = slot.scheduler.capacityFor(model);
    return {
      slots: cap.slots,
      free: cap.free,
      queued: Object.values(cap.queued).reduce((a, b) => a + b, 0),
      // isWarm compares against the backend's own loaded ids, so it has to be
      // asked in the backend's vocabulary.
      warm: slot.cfg.serves.length
        ? slot.state.loaded().length > 0
        : slot.state.isWarm(this.outboundId(model)),
    };
  }

  /** The node-level view (summed free slots), for protocol-1 peers and one-number surfaces. */
  aggregate(): NodeCapacity {
    return this.sum((s) => s.scheduler.capacity());
  }

  /** What one backend can take given what is loaded; narrows to the loaded model's lower ceiling, never raises. */
  loadedCapacity(slot: BackendSlot): ReturnType<Scheduler["capacity"]> {
    const base = slot.scheduler.capacity();
    // Ollama serves a set side by side, so one member's ceiling is not the backend's.
    if (slot.cfg.kind === "ollama") return base;
    const raw = slot.state.resident();
    if (raw === null) return base;
    // Asked under the advertised id; aliases of one seat inherit the same ceiling.
    const c = slot.scheduler.capacityFor(this.advertisedId(raw));
    return c.free < base.free || c.slots < base.slots ? c : base;
  }

  /** aggregate(), narrowed the same way, for status surfaces; not what /peer/state sends. */
  loadedAggregate(): NodeCapacity {
    return this.sum((s) => this.loadedCapacity(s));
  }

  private sum(per: (s: BackendSlot) => ReturnType<Scheduler["capacity"]>): NodeCapacity {
    const queued: Record<string, number> = {};
    for (const lane of Object.keys(this.cfg.scheduler.lanes)) queued[lane] = 0;
    let slots = 0, free = 0, running = 0, offbox = 0;
    for (const s of this.slots) {
      const c = per(s);
      slots += c.slots;
      free += c.free;
      running += c.running;
      offbox += c.offbox;
      for (const [lane, n] of Object.entries(c.queued)) queued[lane] = (queued[lane] ?? 0) + n;
    }
    return { slots, free, running, offbox, queued, resident: this.loaded()[0] ?? null };
  }

  /** Every job in flight anywhere, tagged with the backend running it. */
  jobs(): (ReturnType<Scheduler["view"]>[number] & { backend: string })[] {
    return this.slots.flatMap((s) =>
      s.scheduler.view().map((j) => ({ ...j, backend: s.name })),
    );
  }

  start(): void {
    for (const s of this.slots) s.state.start();
  }

  stop(): void {
    for (const s of this.slots) s.state.stop();
  }
}
