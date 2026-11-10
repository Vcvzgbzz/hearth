/**
 * Which backend serves a model, and what the model is called on each side: the id a client asks for,
 * the id a backend knows it by (`as`, `follow`), the paths a backend declares, and what the node
 * advertises. Reads the backends; never queues, loads or evicts anything.
 */
import type { RouteRule } from "../config/backends.js";
import type { HearthConfig } from "../config/config.js";
import { ANY } from "../config/flows.js";
import type { ModelRoute, ModelStats } from "../config/models.js";
import type { Logger } from "../observe/log.js";
import { mergeStats, type Need } from "../routing/stats.js";
import type { BackendSlot } from "./pool.js";

export class ModelCatalog {
  /** Complained-about ambiguous ids, so a duplicate warns once and not per request. */
  private readonly warned = new Set<string>();
  /** Declared non-OpenAI paths -> who serves them. See BackendConfig.routes. */
  private readonly byPath = new Map<string, { slot: BackendSlot; rule: RouteRule }>();
  /** Routes carrying a {model} segment, in declaration order. */
  private readonly patterns: { slot: BackendSlot; rule: RouteRule; re: RegExp }[] = [];

  constructor(
    private readonly cfg: HearthConfig,
    private readonly log: Logger,
    /** The pool's backends, in order; the pool adds to it as it builds them. */
    private readonly slots: readonly BackendSlot[],
    private readonly byName: ReadonlyMap<string, BackendSlot>,
  ) {}

  /** Take note of the paths a backend declares. */
  addRoutes(slot: BackendSlot): void {
    for (const r of slot.cfg.routes) {
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

  /**
   * A path some backend declares with a `{model}` segment, as the name standing in that segment
   * and the same path for another name. The name need not be a model anything serves: it may be
   * one a flow takes, to be turned into a model before the path is matched to a backend.
   */
  named(pathname: string): { path: string; name: string; as: (model: string) => string } | undefined {
    for (const p of this.patterns) {
      const m = p.re.exec(pathname);
      if (!m) continue;
      try {
        return { path: p.rule.path, name: decodeURIComponent(m[1]!), as: (model) => p.rule.path.replace("{model}", encodeURIComponent(model)) };
      } catch {
        continue; // a malformed escape is not a name
      }
    }
    return undefined;
  }

  /** Does this backend serve this id: declared in `serves`, else reported by it? */
  private declaredBy(slot: BackendSlot, model: string): boolean {
    if (slot.cfg.serves.length) return slot.cfg.serves.includes(model);
    return slot.state.catalog().includes(model);
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

    // A path with no name in it is answered by the model its route names, which is that backend's to run.
    const routed = this.slots.find((s) => s.cfg.routes.some((r) => r.model === wire));
    if (routed) return routed;

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
    return this.slots[0]!;
  }

  /**
   * The model a routed request is queued as: the route's model, unless the caller's id is this
   * backend's own, so an arbitrary string never mints a queue entry.
   */
  routedModel(slot: BackendSlot, rule: RouteRule, asked: string | undefined): string {
    if (asked === undefined || asked === rule.model) return rule.model;
    return this.owns(slot, asked) ? asked : rule.model;
  }

  /** Is this id this backend's own: pinned to it, declared by it, or in its catalogue? */
  owns(slot: BackendSlot, model: string): boolean {
    // A pin decides it: two backends may run the same id, and a name pinned to one is not the other's.
    const pinned = this.cfg.models[model]?.backend;
    if (pinned && this.byName.has(pinned)) return pinned === slot.name;
    const wire = this.outboundId(model);
    return slot.cfg.serves.includes(wire) || slot.state.catalog().includes(wire);
  }

  /** True only when every backend declares what it serves and none names this id, so a typo can be refused. */
  certainlyUnknown(model: string): boolean {
    // Named in `models:` — the operator said this id means something, and
    // `backend`/`as` may point it somewhere this check cannot see.
    if (this.cfg.models[model]) return false;
    // A name a flow takes, with or without a variant after it, is that flow's to answer.
    const cut = model.lastIndexOf(":");
    if (Object.values(this.cfg.flows).some((flow) => flow.inputs.includes(model) || (cut > 0 && flow.inputs.includes(model.slice(0, cut))))) return false;
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
    const r = this.cfg.models[model];
    if (r?.follow && r.backend !== null) {
      // `as` when it is among what is loaded, so several resident models never make this arbitrary.
      const loaded = this.byName.get(r.backend)?.state.loaded() ?? [];
      if (loaded.length > 0 && !loaded.includes(r.as!)) return loaded[0]!;
    }
    return r?.as ?? model;
  }

  /** The ids configured with `follow`. */
  private followIds(): string[] {
    return Object.entries(this.cfg.models).filter(([, r]) => r.follow).map(([id]) => id);
  }

  /** A model's shared-context pool, inherited from the seat it fronts like its slots. */
  poolOf(model: string): ModelRoute["pool"] {
    const r = this.cfg.models[model];
    if (!r) return null;
    return r.pool ?? (r.as === null ? null : this.cfg.models[this.outboundId(model)]?.pool ?? null);
  }

  /** What a request holds of its model's pool while it runs, or undefined without one. */
  poolTokens(model: string, need: Need): number | undefined {
    const p = this.poolOf(model);
    if (!p) return undefined;
    const output = need.output ?? 0;
    return need.tokens - output + Math.min(output, p.output ?? output);
  }

  /** A model's slot ceiling, inherited from the seat it fronts when it declares none. */
  slotsOf(model: string): number | null {
    const r = this.cfg.models[model];
    if (!r) return null;
    if (r.as === null) return r.concurrency;
    return r.concurrency ?? this.cfg.models[this.outboundId(model)]?.concurrency ?? null;
  }

  /**
   * The chat body for the backend: `as` for the id and the route's `params` over the client's.
   * `wire` overrides the id for a peer, and params still apply. Untouched when neither is set.
   * The `efforts` fields for the effort asked (after params) go under params: the seat's only when
   * it runs here, a template switch being the seat's own, then the id's, which travel like params.
   */
  outboundBody(
    model: string,
    payload: Record<string, unknown>,
    wire: string = this.outboundId(model),
  ): Record<string, unknown> {
    const params = this.cfg.models[model]?.params ?? null;
    const asked = params?.reasoning_effort ?? payload.reasoning_effort;
    const level = typeof asked === "string" ? asked : "";
    const seat = wire === this.outboundId(model) && wire !== model ? this.cfg.models[wire]?.efforts?.[level] : undefined;
    const own = this.cfg.models[model]?.efforts?.[level];
    if (wire === model && params === null && seat === undefined && own === undefined) return payload;
    return { ...payload, ...(seat ?? {}), ...(own ?? {}), ...(params ?? {}), model: wire };
  }

  /** Every advertised id for a backend's `raw` id: its aliases, plus `raw` when it is a first-class id. */
  private advertisedIds(raw: string): string[] {
    const ids: string[] = [];
    for (const [id, route] of Object.entries(this.cfg.models)) {
      if (route.as === raw && !route.follow) ids.push(id);
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
      if (route.as === raw && !route.follow) return id;
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
    for (const id of this.followIds()) {
      if (out.has(this.cfg.models[id]!.as!)) out.add(id);
    }
    // An id a flow takes is advertised whether or not a backend serves it: where it lands is decided per request.
    for (const flow of Object.values(this.cfg.flows)) for (const id of flow.inputs) if (id !== ANY) out.add(id);
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
    // A follow id goes out as whatever is resident, so it costs no load while
    // anything is.
    for (const id of this.followIds()) {
      if (this.byName.get(this.cfg.models[id]!.backend!)?.state.resident()) out.add(id);
    }
    return [...out];
  }
}
