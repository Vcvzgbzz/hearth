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
import type { BackendConfig, HearthConfig, ModelRoute, RouteRule } from "./config.js";
import { BackendState } from "./backend.js";
import type { Logger } from "./log.js";
import { mergeStats, type ModelStats, type Need } from "./stats.js";
import { ResourceArbiter } from "./resources.js";
import { Scheduler } from "./scheduler.js";

/**
 * How long the whole clear-the-card sequence may take.
 *
 * One unload caps its own wait at 30s, so a card with several neighbours could
 * otherwise be held for a multiple of that while everything queued for it
 * waits. Generous against a healthy unload, which is a fraction of a second.
 */
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
  /** Routes carrying a {model} segment, in declaration order. */
  private readonly patterns: { slot: BackendSlot; rule: RouteRule; re: RegExp }[] = [];
  /**
   * The last few handoffs, so a card changing hands is visible and not merely
   * logged.
   *
   * An eviction is the expensive event on this node — 20-60s of reload the next
   * request pays for — and it is the one thing the status page could not see at
   * all: the resident model simply changed between two polls, with nothing
   * saying why or what it cost. A ring of twenty, same as everything else here,
   * dies with the process.
   */
  /**
   * The subset of a backend's resources that are actually arbitrated.
   *
   * Shared hardware is filtered out HERE, before the scheduler or the arbiter
   * ever see it, rather than by teaching them a second mode. `resources.ts` is
   * mutual exclusion and stays that way; a shared resource is simply not a thing
   * it is asked about.
   *
   * Display is the one place that must NOT use this: the console draws what a
   * backend runs on, which includes the hardware nobody is fighting over.
   */
  private arbitrated(names: readonly string[]): string[] {
    return names.filter((n) => !this.cfg.resources[n]?.shared);
  }

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
          pool: (m) => this.poolOf(m)?.tokens ?? null,
          // Two ids that resolve to the same resident model ARE the same model
          // to a backend that batches; without this the scheduler sees a
          // foreign job and refuses to run them together.
          wire: (m) => this.outboundId(m),
          // Ollama serves a resident set side by side, so a model's ceiling counts its own jobs.
          coresident: b.kind === "ollama",
          resources: this.arbitrated(b.resources),
          arbiter: this.arbiter,
          // Winning the arbitration only means nobody else is RUNNING on this
          // hardware. Anything that ran recently still has weights resident on
          // it, which on a card sized for one model is the same as it being
          // occupied — so ask the overlapping backends to let go before we
          // load.
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
   * The backend that declared this request path, if any.
   *
   * Exact match on the pathname, query string already stripped by the caller.
   * No prefixes and no open wildcards: these are a handful of named endpoints,
   * and a pattern that matches more than the operator pictured would silently
   * pull unrelated traffic into a queue.
   *
   * `{model}` is the one exception, and it is narrow enough to keep that
   * promise. It matches a single segment, and ONLY when the backend actually
   * serves the model that segment names — so `/upstream/{model}/generate` on the
   * image backend cannot swallow `/upstream/coder/generate`, which falls through
   * to the unqueued passthrough exactly as it did before. The captured segment
   * IS the id the work queues under, so a pattern cannot pull in traffic without
   * also naming a model this backend admits.
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
      // Match in the BACKEND's vocabulary and report in ours. The captured
      // segment is whatever the caller typed, and for an aliased model that is
      // the only id we advertise -- `image-hq` when the backend serves `image`
      // and the raw id is hidden precisely because it exists to be renamed. So
      // asking against the raw segment meant the route never fired for the one
      // name a client could legitimately use: the request fell through to the
      // unqueued passthrough, and the operator's `routes:` entry silently did
      // nothing on the model it was written for.
      if (!this.declaredBy(p.slot, this.outboundId(model))) continue;
      return { slot: p.slot, rule: { ...p.rule, model } };
    }
    return undefined;
  }

  /**
   * Does this backend actually serve this id?
   *
   * `for()` deliberately falls back to the first backend for an id nobody
   * claims, which is right for dispatch and wrong here: it would make every
   * pattern match everything. So this asks the narrower question directly —
   * what the backend DECLARED, or failing that what it reported it can serve.
   */
  private declaredBy(slot: BackendSlot, model: string): boolean {
    if (slot.cfg.serves.length) return slot.cfg.serves.includes(model);
    return slot.state.catalog().includes(model);
  }

  /**
   * Clear every other backend off the hardware `b` just took.
   *
   * Sequential and awaited: these are unload calls to servers that may be
   * loading, and the point is to be sure the card is free before we put
   * something on it. In practice it is one or two calls that are usually
   * no-ops.
   *
   * `unload()` throws only when a backend answers and REFUSES — then the job
   * fails rather than load onto weights still on the card. A backend that is
   * down is a no-op, and each call caps its own wait — but the sequence CAN be
   * slow, and everything queued for this card is waiting behind it. The
   * whole sequence is therefore bounded as well as each call in it: past the
   * deadline we stop asking and let the job proceed, because a neighbour that
   * will not answer an unload is not going to start answering, and holding the
   * card hostage to it helps nobody.
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

  /**
   * Every declared piece of hardware, who is on it, and who competes for it.
   *
   * The list is empty for a config that declares no `resources`, which is most
   * of them — and the page then draws nothing rather than an empty box.
   *
   * `holder` is the backend currently RUNNING on the resource, not the one
   * whose weights are resident: the arbiter is released the moment a backend's
   * last job finishes, so a card with nothing running is genuinely free even
   * though the model that just ran is still sitting in its memory.
   */
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
        // Owner identity is the Scheduler instance, which is what acquire() was
        // handed. Mapping it back to a name here keeps that private to the pool.
        // A shared resource is never acquired, so this is always null for one —
        // correctly: nobody is holding it, several things are using it.
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
      // Config validation already proved the name exists, and nothing removes a
      // backend afterwards — `backends` is fixed for the life of the process,
      // and the runtime edits in overrides.ts only ever touch `models`. So this
      // cannot fire today. It is kept because the alternative to belt and
      // braces here is a silent misroute, and warned-about is better than
      // that whatever future makes it reachable.
      if (slot) return slot;
      // Namespaced: `warned` is shared with the by-model warning below, and a
      // backend and a model may perfectly well have the same name (a `guard`
      // backend serving a `guard` model is the normal shape) — unprefixed, one
      // would silence the other.
      if (!this.warned.has(`pin:${pinned}`)) {
        this.warned.add(`pin:${pinned}`);
        this.log.warn("backend.pinned_missing", {
          model,
          pinned,
          available: this.slots.map((s) => s.name),
          // Deliberately does not promise where it went. The pin is ignored and
          // the normal resolution runs: `serves`, then the catalogues, and only
          // then the first backend. A pin naming a typo on a model its backend
          // declares still lands in the right place, and telling the operator
          // it fell through to the first backend would send them chasing a
          // misroute that never happened.
          hint: `ignoring the pin and resolving ${model} by catalogue — set models.${model}.backend to a real name`,
        });
      }
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

  /**
   * The model a routed request is queued as. The route's model is the default;
   * the caller's id wins only when it is this backend's own (pinned in `models:`,
   * in `serves`, or in its catalogue), so an arbitrary string never mints a queue entry.
   */
  routedModel(slot: BackendSlot, rule: RouteRule, asked: string | undefined): string {
    if (asked === undefined || asked === rule.model) return rule.model;
    if (this.cfg.models[asked]?.backend === slot.name) return asked;
    const wire = this.outboundId(asked);
    if (slot.cfg.serves.includes(wire) || slot.state.catalog().includes(wire)) return asked;
    return rule.model;
  }

  /**
   * Is it CERTAIN that no backend here can serve this id?
   *
   * `for()` sends an unrecognised id to the first backend, which is the right
   * fallback for resolution — a backend that cannot enumerate its models may
   * well serve it. It is the wrong thing to queue: a typo then waits its turn,
   * can evict a resident model on the way in, and 404s from the backend having
   * cost a slot on the GPU.
   *
   * So this answers the narrower question, and only says yes when it cannot be
   * wrong: every backend has DECLARED what it serves, so the catalogue is a
   * fact from the config rather than a discovery, and none of them names this
   * id. A backend that discovers its models is unknowable while it is down, and
   * refusing on its behalf would turn a restart into "no such model".
   */
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

  /** The id we advertise for something a backend calls `raw`. The way back
   *  from a backend's vocabulary into ours, for anything read off the wire. */
  advertised(raw: string): string {
    return this.advertisedId(raw);
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

  /**
   * The context window for an advertised model id, or null if unknown.
   *
   * Known means the model has been loaded at least once, so we could ask the
   * backend for its window. We never probe a cold model: llama-swap's /props
   * endpoint loads it to answer, which would swap the GPU. Unknown is a
   * distinct and honest state — the id is real, its window just hasn't been
   * learned yet.
   */
  contextLength(model: string): number | null {
    return this.statsFor(model)?.context ?? null;
  }

  /**
   * Everything known about an advertised model id, declared under observed.
   *
   * The declaration is what makes a COLD model checkable at all: the backend
   * cannot be asked about one without loading it, so without a declared window
   * the first oversized request evicts whatever is resident, waits out the
   * load, and only then fails. Once the model does load, its own answer wins
   * field by field — see mergeStats.
   *
   * A variant falls back to its parent's declaration, the same way concurrency
   * does: `coder-low` and `coder` are one set of weights in one process, so the
   * window cannot differ between them, and restating it per variant is a
   * restatement that can drift.
   */
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
    // Ollama serves a set side by side, so one member's ceiling is not the backend's.
    if (slot.cfg.kind === "ollama") return base;
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
