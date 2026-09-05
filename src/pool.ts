/**
 * The local backends, and which one serves a given model.
 *
 * One node can front several local providers: a swapping chat model on the GPU,
 * an always-resident embedder on another port, a CPU-only classifier on a
 * third. Each is its own admission domain — its own queue, its own concurrency,
 * its own warm state — and a model resolves to exactly one of them.
 *
 * There is deliberately no scheduling ACROSS backends. That is the line between
 * this and the multi-GPU scheduler the README disclaims: nothing here decides
 * that a job would be better off somewhere else, it only works out where the
 * job belongs and then queues it there. The hard part (one GPU, one resident
 * model, warm bonus) stays exactly as simple as it was, N times over.
 *
 * The reason it has to work this way rather than sharing one queue: the whole
 * point of a second backend is usually something small and latency-sensitive.
 * Put it behind the GPU's queue and a 20ms embedding waits on a 40s generation,
 * which is the opposite of why it exists.
 */
import type { BackendConfig, HearthConfig, RouteRule } from "./config.js";
import { BackendState } from "./backend.js";
import type { Logger } from "./log.js";
import { ResourceArbiter } from "./resources.js";
import { Scheduler } from "./scheduler.js";

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
  /**
   * Hardware shared between backends, so the ones that overlap take turns.
   *
   * Still not scheduling across backends: routing is untouched and nothing here
   * moves a job somewhere it did not belong. What this adds is that a backend
   * can be made to WAIT for another — which is the one thing the "each is its
   * own admission domain" model gets wrong when two of those domains are one
   * GPU.
   *
   * Inert unless a backend declares `resources`.
   */
  private readonly arbiter = new ResourceArbiter();
  /** Declared non-OpenAI paths -> who serves them. See BackendConfig.routes. */
  private readonly byPath = new Map<string, { slot: BackendSlot; rule: RouteRule }>();

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
          // A predicate, not one name: ollama holds several models resident at
          // once, and only the first would ever collect the bonus otherwise.
          //
          // Asked in the BACKEND's vocabulary. Jobs carry the advertised id and
          // isWarm() compares against the ids the backend reports, so an `as`
          // route read as permanently cold and never collected the bonus —
          // harmless while `as` was a rare rename, load-bearing now that
          // `params` makes several aliased ids the normal way to front a seat.
          warm: (m) => state.isWarm(this.outboundId(m)),
          // Keyed by the id we advertise, which is what submit() puts on a job.
          // Undeclared is null, not the backend's number: the scheduler owns
          // that fallback, and answering it here would freeze the value.
          slots: (m) => this.slotsOf(m),
          // Two ids that resolve to the same resident model ARE the same model
          // to a backend that batches; without this the scheduler sees a
          // foreign job and refuses to run them together.
          wire: (m) => this.outboundId(m),
          resources: b.resources,
          arbiter: this.arbiter,
          // Winning the arbitration only means nobody else is RUNNING on this
          // hardware. Anything that ran recently still has weights resident on
          // it, which on a card sized for one model is the same as it being
          // occupied — so ask the overlapping backends to let go before we
          // load.
          evict: b.resources.length > 0 ? () => this.evictFor(b) : undefined,
        }),
      };
      this.slots.push(slot);
      this.byName.set(b.name, slot);
      for (const r of b.routes) this.byPath.set(r.path, { slot, rule: r });
    }
  }

  /**
   * The backend that declared this request path, if any.
   *
   * Exact match on the pathname, query string already stripped by the caller.
   * No prefixes and no wildcards: these are a handful of named endpoints, and a
   * pattern that matches more than the operator pictured would silently pull
   * unrelated traffic into a queue.
   */
  forPath(pathname: string): { slot: BackendSlot; rule: RouteRule } | undefined {
    return this.byPath.get(pathname);
  }

  /**
   * Clear every other backend off the hardware `b` just took.
   *
   * Sequential and awaited: these are unload calls to servers that may be
   * loading, and the point is to be sure the card is free before we put
   * something on it. In practice it is one or two calls that are usually
   * no-ops.
   */
  private async evictFor(b: BackendConfig): Promise<void> {
    const overlap = this.slots.filter(
      (s) => s.name !== b.name && s.cfg.resources.some((r) => b.resources.includes(r)),
    );
    for (const s of overlap) {
      if (!s.state.resident()) continue;
      this.log.info("pool.evict", { backend: s.name, for: b.name, resources: b.resources });
      await s.state.unload();
    }
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
   * Which backend serves this model.
   *
   * Precedence, and the order matters:
   *
   *   1. pinned in config      the operator said so, so stop asking
   *   2. the catalogs          exactly one backend lists it
   *   3. the first backend     nobody claims it, so send it where a
   *                            single-backend node would have sent it
   *
   * Step 3 is what keeps an unknown id behaving as it always did. A backend can
   * serve models it does not list (llama-swap will happily load an id that is
   * in its config but absent from a stale catalog), so refusing here would
   * break working setups to satisfy a lookup table.
   */
  for(model: string): BackendSlot {
    const pinned = this.cfg.models[model]?.backend;
    if (pinned) {
      const slot = this.byName.get(pinned);
      // Config validation already proved the name exists; this is belt and braces.
      if (slot) return slot;
    }

    // Past the pin, every comparison is against the BACKEND's vocabulary. An
    // aliased id does not appear in any catalog under the name we advertise, so
    // matching on the advertised one would fall through to "first backend" and
    // silently send `nomic-embed` to whichever backend happens to be first.
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

  /** Everything any backend could serve, deduped. A backend that declared its
   *  models contributes those and not whatever it happens to report, which is
   *  the point: the declaration exists because the report is unusable. */
  /**
   * The id to put on the wire for an advertised id. Identity for everything
   * without `as`, which is nearly everything.
   *
   * THE one place the rewrite lives. Both dispatch paths and every catalog
   * comparison go through it, because an alias that applies on one path and not
   * another is worse than no alias: the model appears to work until you use the
   * other endpoint.
   */
  outboundId(model: string): string {
    return this.cfg.models[model]?.as ?? model;
  }

  /**
   * A model's own slot ceiling, INHERITED from the seat it fronts when it does
   * not declare one.
   *
   * Several ids on one resident model share that model's slots — they are one
   * queue's worth, not one each. Read per advertised id, `concurrency: 8` on
   * the seat left every `-low`/`-off` id on the backend's flat number, so the
   * arrangement `params` exists for silently gave up batching unless the
   * operator restated the ceiling on every id.
   */
  private slotsOf(model: string): number | null {
    const r = this.cfg.models[model];
    if (!r) return null;
    if (r.as === null) return r.concurrency;
    return r.concurrency ?? this.cfg.models[r.as]?.concurrency ?? null;
  }

  /**
   * The BODY to put on the wire for a chat completion: the advertised id
   * swapped for the backend's (`as`), and the route's `params` laid over what
   * the client sent. The same object back, untouched, for a model with
   * neither -- which is nearly all of them, so the common case allocates
   * nothing. `params` win over the client's own values on purpose: the id is
   * the user's choice, and a client that always sends `reasoning_effort:
   * high` must not be able to undo the `-low` id it just picked.
   *
   * `wire` overrides the id for the one caller that does not want ours: a job
   * going to a peer is addressed by THEIR id. The params still go, because the
   * id the user picked meant the same thing whichever box answers it — a `-low`
   * request that spilled over must not come back at full effort. A peer that is
   * another hearth applies its own route on top, which is the same rule one
   * level out: the nearest config to the backend wins.
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

  /** The advertised id for something a backend called `raw`, if we alias it.
   *  Backends speak their own vocabulary; this is the way back to ours. */
  /**
   * Every advertised id for something a backend called `raw`: each alias that
   * points at it, plus `raw` itself when it is ALSO a first-class id (a route
   * of its own, or no alias at all). Several aliases on one raw id is the
   * `params` arrangement -- one resident model, several ids -- and a catalog
   * that showed only the first of them would hide the very ids the operator
   * added. The raw id stays hidden only when it exists purely to be renamed.
   */
  private advertisedIds(raw: string): string[] {
    const ids: string[] = [];
    for (const [id, route] of Object.entries(this.cfg.models)) {
      if (route.as === raw) ids.push(id);
    }
    if (ids.length === 0 || this.cfg.models[raw] !== undefined) ids.push(raw);
    return ids;
  }

  private advertisedId(raw: string): string {
    // Built per call rather than cached: `models` is small, and a cache here
    // would need invalidating on any future config reload.
    for (const [id, route] of Object.entries(this.cfg.models)) {
      if (route.as === raw) return id;
    }
    return raw;
  }

  catalog(): string[] {
    const out = new Set<string>();
    for (const s of this.slots) {
      for (const m of s.cfg.serves.length ? s.cfg.serves : s.state.catalog()) {
        // Advertise OUR name, not the backend's. This is the visible half of
        // the feature: /v1/models and the UI show `nomic-embed`, and the raw
        // `nomic-embed-text-v2-moe:latest` never leaks to a client that cannot
        // use it anyway.
        for (const id of this.advertisedIds(m)) out.add(id);
      }
    }
    return [...out];
  }

  /** Everything warm anywhere. Several at once is normal now: one backend per
   *  model means several models can be resident simultaneously. */
  loaded(): string[] {
    const out = new Set<string>();
    for (const s of this.slots) {
      // A backend that declares `serves` MAY report unusable ids — a bare
      // llama-server names the gguf path it was launched with, under every key,
      // warm state included — so its declared names are all we can say is warm.
      //
      // But `serves` is not itself evidence of that: a llama-swap backend can
      // declare what it serves and still report real ids. Believe those, or one
      // loaded model marks every id on the backend warm, and the warm bonus
      // fires for models that would in fact cost a full load.
      if (s.cfg.serves.length) {
        // Two rules, and they compose rather than compete.
        //
        // Believe an id the backend actually named: a llama-swap that declares
        // `serves` can still say exactly which one is resident, and marking all
        // of them warm would fire the warm bonus for models that in fact cost a
        // full load — the swap the bonus exists to avoid. Only when the
        // reported id is unusable (a bare llama-server naming a gguf path) does
        // the declared list become the best answer available.
        //
        // Then expand each through advertisedIds, because one resident model
        // can be advertised under several ids once `params` gives them
        // different defaults. They are the same weights on the same seat, so
        // they are all warm together.
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

  /**
   * Capacity for one model, which is the capacity of the backend that serves
   * it. This is what a peer actually wants to know, and what node-level numbers
   * could only approximate once a node has more than one queue.
   */
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

  /**
   * The node-level view, for the legacy half of the peer protocol and for any
   * status surface that wants one number.
   *
   * Summing free slots across backends is a simplification, and an honest one
   * only because nothing schedules across backends: it answers "is anything
   * free here", not "will my job start". A protocol-2 peer asks per model and
   * gets the real answer.
   */
  aggregate(): NodeCapacity {
    return this.sum((s) => s.scheduler.capacity());
  }

  /**
   * What ONE backend can take right now, given what is loaded on it.
   *
   * A backend's `concurrency` is the number for a seat whose models all agree.
   * Where they do not — llama.cpp entries started with different `--parallel` —
   * the loaded model's own ceiling is the one that binds, and the backend's
   * larger number is a promise nothing can keep: dispatching into it puts the
   * extra jobs in llama.cpp's internal queue, where the scheduler counts them
   * as running.
   *
   * Narrowing ONLY. A loaded model that batches reports its raise through
   * capacityFor(), where a peer scoring that model asks for it; letting the
   * raise through here would swing the node's headline number between 1 and 32
   * on every swap, describing the seat by whichever model happens to be in it.
   */
  loadedCapacity(slot: BackendSlot): ReturnType<Scheduler["capacity"]> {
    const base = slot.scheduler.capacity();
    const raw = slot.state.resident();
    if (raw === null) return base;
    // Advertised, because that is the vocabulary the scheduler's slot counts
    // are keyed by. resident() answers in the backend's own ids.
    //
    // Whichever alias advertisedId() picks is fine even with several fronting
    // one seat: slotsOf() has them all inherit the seat's ceiling, so they all
    // answer the same number.
    const c = slot.scheduler.capacityFor(this.advertisedId(raw));
    return c.free < base.free || c.slots < base.slots ? c : base;
  }

  /**
   * aggregate(), narrowed the same way, for status surfaces.
   *
   * Deliberately NOT what /peer/state sends. The aggregate a protocol-1
   * borrower scores us by is frozen, and this number answers a different
   * question anyway — "can the seat take more of what it is already doing",
   * which is what a person watching the page is asking.
   */
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
