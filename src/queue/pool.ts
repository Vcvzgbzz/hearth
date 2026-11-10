/**
 * The local backends and which one serves a model. Each is its own admission domain (queue,
 * concurrency, warm state), so an embedder never waits behind a GPU generation. Nothing
 * schedules across backends; shared hardware only makes one wait for another.
 */
import { backendAuth, type BackendConfig } from "../config/backends.js";
import type { HearthConfig } from "../config/config.js";
import type { Logger } from "../observe/log.js";
import { BackendState } from "./backend.js";
import { Hardware, RESIDENT_RESUME_MS } from "./hardware.js";
import { KeyTally } from "./keytally.js";
import { KINDS } from "./kinds.js";
import { ModelCatalog } from "./models.js";
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

/**
 * The backends and their queues, and what they can take. What a model is called and which backend serves
 * it is `models`; how backends that share hardware take turns on it is `hardware`.
 */
export class BackendPool {
  private readonly slots: BackendSlot[] = [];
  /** What each key is running here, across every backend. */
  readonly tally = new KeyTally();
  private kickQueued = false;
  private readonly byName = new Map<string, BackendSlot>();
  readonly models: ModelCatalog;
  readonly hardware: Hardware;

  constructor(
    private readonly cfg: HearthConfig,
    log: Logger,
    resumeAfterMs = RESIDENT_RESUME_MS,
  ) {
    this.models = new ModelCatalog(cfg, log, this.slots, this.byName);
    this.hardware = new Hardware(cfg, log, this.slots, resumeAfterMs);
    const { models, hardware } = this;
    // A key's waiter may be on another backend. One microtask, so a burst of endings looks once.
    this.tally.onEnded(() => {
      if (this.kickQueued) return;
      this.kickQueued = true;
      queueMicrotask(() => { this.kickQueued = false; this.kickAll(); });
    });
    for (const b of cfg.backends) {
      const state = new BackendState(b.url, b.kind, log, this.mineOn(b), backendAuth(b.format, b.key, b.headers));
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
          warm: (m) => state.isWarm(models.outboundId(m)),
          // Keyed by the id we advertise, which is what submit() puts on a job.
          // Undeclared is null, not the backend's number: the scheduler owns
          // that fallback, and answering it here would freeze the value.
          slots: (m) => models.slotsOf(m),
          pool: (m) => models.poolOf(m)?.tokens ?? null,
          // Inherited from the seat an alias fronts, like slots.
          shareAfter: (m) => this.cfg.models[m]?.shareAfterMs ?? this.cfg.models[models.outboundId(m)]?.shareAfterMs ?? 0,
          // Two ids that resolve to the same resident model ARE the same model
          // to a backend that batches; without this the scheduler sees a
          // foreign job and refuses to run them together.
          wire: (m) => models.outboundId(m),
          // Ollama serves a resident set side by side, so a model's ceiling counts its own jobs.
          coresident: KINDS[b.kind].coresident,
          onChange: () => { for (const cb of this.jobListeners) cb(); },
          // A resident never takes turns: its own requests neither wait for the card nor evict.
          resources: b.resident ? [] : hardware.arbitrated(b.resources),
          arbiter: hardware.arbiter,
          // Ask overlapping backends to unload before we load; weights stay resident after a run.
          evict: !b.resident && hardware.arbitrated(b.resources).length > 0 ? () => hardware.evictFor(b) : undefined,
          heldOff: (lane) => hardware.heldOff(b, lane),
          tally: this.tally,
        }),
      };
      this.slots.push(slot);
      this.byName.set(b.name, slot);
      models.addRoutes(slot);
    }
  }

  /**
   * What a backend sees of a URL it shares with another: its own `serves` if it declares them,
   * else everything except the ids a sibling declares. Undefined alone on its URL.
   */
  private mineOn(b: BackendConfig): ((id: string) => boolean) | undefined {
    const siblings = this.cfg.backends.filter((o) => o.name !== b.name && o.url === b.url);
    if (siblings.length === 0) return undefined;
    if (b.serves.length) {
      const own = new Set(b.serves);
      return (id) => own.has(id);
    }
    const theirs = new Set(siblings.flatMap((o) => o.serves));
    return (id) => !theirs.has(id);
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


















  /** Capacity for one model: that of the backend serving it. */
  capacityFor(model: string): ModelCapacity {
    const slot = this.models.for(model);
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
        : slot.state.isWarm(this.models.outboundId(model)),
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
    if (KINDS[slot.cfg.kind].coresident) return base;
    const raw = slot.state.resident();
    if (raw === null) return base;
    // Asked under the advertised id; aliases of one seat inherit the same ceiling.
    const c = slot.scheduler.capacityFor(this.models.advertised(raw));
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
    return { slots, free, running, offbox, queued, resident: this.models.loaded()[0] ?? null };
  }

  /** Give every backend's scheduler these lanes and order settings. Pair with `kickAll`. */
  retune(s: HearthConfig["scheduler"]): void {
    for (const slot of this.slots) slot.scheduler.retune({ lanes: s.lanes, agePerSecond: s.agePerSecond, warmBonus: s.warmBonus, maxPerLane: s.maxPerLane });
  }

  /** Look at every queue again: something outside them changed what may start. */
  kickAll(): void {
    for (const s of this.slots) s.scheduler.kick();
  }

  /** Every job in flight anywhere, tagged with the backend running it. */
  jobs(): (ReturnType<Scheduler["view"]>[number] & { backend: string })[] {
    return this.slots.flatMap((s) =>
      s.scheduler.view().map((j) => ({ ...j, backend: s.name })),
    );
  }

  start(): void {
    for (const s of this.slots) s.state.start();
    this.hardware.start();
  }

  private readonly jobListeners = new Set<() => void>();

  /** Called whenever any backend's job list changes: queued, started, finished, or moved in line. */
  onJobs(cb: () => void): () => void {
    this.jobListeners.add(cb);
    return () => this.jobListeners.delete(cb);
  }

  stop(): void {
    for (const s of this.slots) s.state.stop();
    this.hardware.stop();
  }
}
