/**
 * Plugins: code or services that read or change requests at stages hearth controls (docs/plugins.md).
 * A plugin is called only for the request kinds and stages both it and its config declare, every call
 * is bounded by its timeout, and a plugin that cannot answer follows its own `onError`, so a broken
 * plugin costs at most its own requests, never the node.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_ROUTER, PLUGIN_STAGES, REQUEST_KINDS, type Flow, type HearthConfig, type PluginDecl, type PluginStage, type PluginWhen, type RequestKind, type StepPlugin } from "./config.js";
import type { Logger } from "./log.js";

/** The stages this build calls. The others may be declared, and are never called yet. */
export const LIVE_STAGES: ReadonlySet<PluginStage> = new Set(["request", "routed", "log", "error"]);
/** The kinds whose requests run plugins in this build. Every other request runs none. */
export const LIVE_KINDS: ReadonlySet<RequestKind> = new Set(["chat"]);

/** What a plugin says it handles, by kind; hearth holds it to this on every request. */
export type Declared = Partial<Record<RequestKind, PluginStage[]>>;

/** The models a plugin needs, as named slots, each taking one kind of model. */
export type Needs = Record<string, { kind: RequestKind; optional?: boolean }>;

/** Where a plugin was placed: a step of a flow, in a router's rules or the default ones. */
export interface Line { router: string; flow: string; step: number }

/** A request as a hook sees it. `model`, `target` and `peer` exist once routing has decided. */
export interface HookRequest {
  id: string;
  kind: RequestKind;
  asked: string;
  model?: string;
  target?: "local" | "peer";
  peer?: string | null;
  /** The backend here that will run it; null when a peer will. */
  backend?: string | null;
  /** It leaves this machine: for a peer, or a backend that is a cloud provider. */
  leaves?: boolean;
  caller: string;
  router: string;
  lane: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The model wired into each of this plugin's slots for this request; an empty optional slot is null. */
  models?: Record<string, string | null>;
  /** The line this plugin was placed on; null for a plugin that runs on every line. */
  line?: Line | null;
}

/** A finished request, for `log` and `error`. */
export interface HookExchange extends HookRequest {
  status: number;
  error: string | null;
  /** The assistant's text, when the reply could be read. */
  reply: string | null;
  ms: number;
}

/** What a `request` or `routed` hook may return. */
export interface Decision {
  body?: Record<string, unknown>;
  headers?: Record<string, string | null>;
  lane?: string;
  stayLocal?: true;
  refuse?: { status?: number; message: string };
  flag?: string;
}

/** What a code plugin's `setup` returns: one function per stage it hooks. */
export interface Hooks {
  request?: (r: HookRequest) => Promise<Decision | void> | Decision | void;
  routed?: (r: HookRequest) => Promise<Decision | void> | Decision | void;
  log?: (x: HookExchange) => Promise<void> | void;
  error?: (x: HookExchange) => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

/** What `setup` is given. */
export interface PluginContext {
  name: string;
  config: Record<string, unknown>;
  log: Logger;
  /** Calls back into this node as internal traffic: no plugin runs on them. */
  internal: { url: string; token: string };
}

/** A code plugin's default export. */
export interface PluginModule {
  name?: string;
  apiVersion: 1;
  kinds: Declared;
  needs?: Needs;
  setup: (ctx: PluginContext) => Promise<Hooks> | Hooks;
}

/** A plugin said no, or could not answer and refuses on error. */
export class PluginRefusal extends Error {
  constructor(readonly plugin: string, readonly status: number, message: string) {
    super(message);
  }
}

interface Stat { calls: number; errors: number; refused: number; flagged: number; skipped: number; ms: number[] }

export interface PluginStatus {
  name: string;
  trust: "code" | "http";
  state: "running" | "failed" | "off";
  error: string | null;
  kinds: Declared;
  /** What the plugin itself declares, before the config narrows it. */
  declared: Declared;
  /** The model slots it declares. */
  needs: Needs;
  /** The models wired into its slots on the plugin itself. */
  models: Record<string, string>;
  /** Runs on every line; otherwise only where a step places it. */
  everyLine: boolean;
  /** Where it comes from: a URL shows only its origin and path. */
  use: string;
  when: PluginWhen | null;
  timeoutMs: number;
  onError: PluginDecl["onError"];
  onFail: PluginDecl["onFail"];
  locked: boolean;
  required: boolean;
  reads: PluginDecl["reads"];
  /** Paused from the console until unpaused or restarted. */
  paused: boolean;
  pausedUntil: number;
  failOpens: number;
  stages: Partial<Record<PluginStage, { calls: number; errors: number; refused: number; flagged: number; skipped: number; p50: number; p95: number }>>;
}

const BREAK_AFTER = 5;
const BREAK_MS = 30_000;
const OBSERVE_MS = 10_000;

/** Within a declaration: what the config's `kinds` narrows the plugin's own to. Never wider. */
export function effectiveKinds(declared: Declared, narrowed: Declared | null): Declared {
  if (narrowed === null) return declared;
  const out: Declared = {};
  for (const k of REQUEST_KINDS) {
    const mine = declared[k];
    const theirs = narrowed[k];
    if (!mine || !theirs) continue;
    const both = theirs.filter((s) => mine.includes(s));
    if (both.length) out[k] = both;
  }
  return out;
}

/** Config naming a kind or stage the plugin does not declare, said the way an operator can fix it. */
export function widened(name: string, declared: Declared, narrowed: Declared | null): string | null {
  for (const [k, stages] of Object.entries(narrowed ?? {})) {
    const mine = declared[k as RequestKind];
    if (!mine) return `${name} handles ${Object.keys(declared).join(", ") || "nothing"}; ${k} is not one of its kinds`;
    const extra = (stages ?? []).filter((s) => !mine.includes(s));
    if (extra.length) return `${name} does not hook ${extra.join(", ")} for ${k}`;
  }
  return null;
}

export function validDeclared(v: unknown): Declared | null {
  if (typeof v !== "object" || v === null) return null;
  const out: Declared = {};
  for (const [k, stages] of Object.entries(v)) {
    if (!(REQUEST_KINDS as readonly string[]).includes(k) || !Array.isArray(stages)) return null;
    if (stages.some((s) => !(PLUGIN_STAGES as readonly string[]).includes(s))) return null;
    out[k as RequestKind] = stages as PluginStage[];
  }
  return out;
}

/** A manifest's `needs`: slot name to the kind of model it takes. Absent is none; null when it is not that shape. */
export function validNeeds(v: unknown): Needs | null {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: Needs = {};
  for (const [slot, n] of Object.entries(v as Record<string, unknown>)) {
    const need = n as { kind?: unknown; optional?: unknown } | null;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(slot) || typeof need !== "object" || need === null) return null;
    if (!(REQUEST_KINDS as readonly string[]).includes(need.kind as string)) return null;
    out[slot] = { kind: need.kind as RequestKind, ...(need.optional === true ? { optional: true } : {}) };
  }
  return out;
}

/** Whether `when` holds for a request. Unset parts hold. */
export function matches(when: PluginWhen | null, r: HookRequest): boolean {
  if (!when) return true;
  const any = (list: string[] | undefined, v: string | undefined) => list === undefined || (v !== undefined && list.includes(v));
  const none = (list: string[] | undefined, v: string | undefined) => list === undefined || v === undefined || !list.includes(v);
  if (!any(when.asked, r.asked) || !none(when.askedNot, r.asked)) return false;
  if (!any(when.caller, r.caller) || !none(when.callerNot, r.caller)) return false;
  if (!any(when.lane, r.lane)) return false;
  // Before routing there is no target yet, so a target condition waits for `routed`.
  if (when.target && (r.target === undefined || !when.target.includes(r.target))) return false;
  for (const [h, values] of Object.entries(when.header ?? {})) {
    const v = r.headers[h];
    if (v === undefined || (values.length > 0 && !values.includes(v))) return false;
  }
  return true;
}

/** The assistant's text in a relayed chat answer: a JSON completion, or a stream of `data:` lines. */
export function replyText(raw: string): string | null {
  const t = raw.trimStart();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as { choices?: { message?: { content?: unknown } }[] };
      const c = j.choices?.[0]?.message?.content;
      return typeof c === "string" ? c : null;
    } catch {
      return null;
    }
  }
  let out = "";
  let any = false;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    try {
      const c = (JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
      if (typeof c === "string") { out += c; any = true; }
    } catch {
      // A line split across chunks or a comment: the text before it still stands.
    }
  }
  return any ? out : null;
}

/** Why a service could not be reached, said the way an operator can act on it. */
function unreachable(base: string, e: unknown): string {
  if (e instanceof Error && e.name === "TimeoutError") return `${base}/manifest gave no answer in 5 s`;
  const code = (e as { cause?: { code?: string } }).cause?.code;
  const why: Record<string, string> = { ECONNREFUSED: "nothing is listening there", ENOTFOUND: "that host name does not resolve", EHOSTUNREACH: "that host cannot be reached", ECONNRESET: "the connection was reset" };
  return `could not reach ${base}: ${(code && why[code]) ?? (code ? code : e instanceof Error ? e.message : String(e))}`;
}

/** A plugin's source as the console shows it: a URL loses any credentials and query. */
function shownUse(use: string): string {
  if (!/^https?:/.test(use)) return use;
  try {
    const u = new URL(use);
    return u.origin + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return "(a URL)";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, no) => { timer = setTimeout(() => no(new Error(`${what} gave no answer in ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

interface Loaded {
  name: string;
  decl: PluginDecl;
  declared: Declared;
  needs: Needs;
  kinds: Declared;
  hooks: Hooks;
  state: PluginStatus["state"];
  error: string | null;
  fails: number;
  pausedUntil: number;
  failOpens: number;
  paused: boolean;
  stats: Partial<Record<PluginStage, Stat>>;
}

/** One plugin as it applies to one request: its hooks, the settings its router gives it, its models and its line. */
export interface Active { name: string; config: Record<string, unknown>; models: Record<string, string | null>; line: Line | null }

/** What kind of request a flow's lines carry: chat, or what its routes are, which hearth does not know yet. */
export const lineKind = (flow: Flow): RequestKind => (flow.takes !== undefined ? "other" : "chat");

/** Every placement in the config: each step of each flow, in the default rules and every router's. */
export function placements(cfg: HearthConfig): { line: Line; kind: RequestKind; plugin: StepPlugin }[] {
  const out: { line: Line; kind: RequestKind; plugin: StepPlugin }[] = [];
  const walk = (router: string, flows: Record<string, Flow>) => {
    for (const [flow, f] of Object.entries(flows)) {
      f.steps.forEach((st, step) => { for (const plugin of st.plugins ?? []) out.push({ line: { router, flow, step }, kind: lineKind(f), plugin }); });
    }
  };
  walk(DEFAULT_ROUTER, cfg.flows);
  for (const [name, r] of Object.entries(cfg.routers)) if (name !== DEFAULT_ROUTER) walk(name, r.flows);
  return out;
}

export class Plugins {
  private loaded: Loaded[] = [];
  private tokens = new Map<string, string>();

  constructor(private cfg: HearthConfig, private log: Logger, private opts: { off: boolean; selfUrl: () => string }) {}

  /** Loads every plugin. One that fails is turned off and logged, unless it is `required`. */
  async start(): Promise<void> {
    for (const [name, decl] of Object.entries(this.cfg.plugins)) {
      const l: Loaded = { name, decl, declared: {}, needs: {}, kinds: {}, hooks: {}, state: "off", error: null, fails: 0, pausedUntil: 0, failOpens: 0, paused: false, stats: {} };
      this.loaded.push(l);
      if (this.opts.off) continue;
      try {
        const token = randomBytes(24).toString("base64url");
        this.tokens.set(token, name);
        const internal = { url: this.opts.selfUrl(), token };
        const { declared, needs, hooks } = decl.trust === "code" ? await this.loadCode(name, decl, internal) : await this.loadService(name, decl, internal);
        const wider = widened(name, declared, decl.kinds);
        if (wider) throw new Error(wider);
        l.declared = declared;
        l.needs = needs;
        l.kinds = effectiveKinds(declared, decl.kinds);
        const misplaced = this.misplaced(name, l.kinds, needs);
        if (misplaced) throw new Error(misplaced);
        l.hooks = hooks;
        l.state = "running";
        const idle = Object.keys(l.kinds).filter((k) => !LIVE_KINDS.has(k as RequestKind));
        this.log.info("plugin.started", { plugin: name, trust: decl.trust, kinds: l.kinds, ...(idle.length ? { notYetRun: idle } : {}) });
        if (!decl.everyLine && !placements(this.cfg).some((x) => x.plugin.name === name)) {
          this.log.warn("plugin.on_no_line", { plugin: name, hint: "it runs nowhere: place it on a flow step, or set everyLine: true to run it on every request" });
        }
      } catch (e) {
        l.state = "failed";
        l.error = e instanceof Error ? e.message : String(e);
        this.log.error("plugin.failed_to_start", { plugin: name, error: l.error });
        if (decl.required) throw new Error(`plugin ${name} is required and did not start: ${l.error}`);
      }
    }
  }

  async stop(): Promise<void> {
    for (const l of this.loaded) await Promise.resolve(l.hooks.stop?.()).catch(() => {});
  }

  /** The plugin a bearer token belongs to: such a call is internal and no plugin runs on it. */
  internalCaller(token: string): string | null {
    const name = token ? this.tokens.get(token) : undefined;
    return name ?? null;
  }

  /** Why this plugin's placements or wired models do not fit it, said the way an operator can fix it; null when they do. */
  private misplaced(name: string, kinds: Declared, needs: Needs): string | null {
    const decl = this.cfg.plugins[name]!;
    for (const x of placements(this.cfg).filter((p) => p.plugin.name === name)) {
      if (!kinds[x.kind]) return `${name} is placed on ${x.line.flow} line ${x.line.step + 1}, which carries ${x.kind} requests; it handles ${Object.keys(kinds).join(", ") || "nothing"}`;
    }
    const wired = [decl.models, ...placements(this.cfg).filter((p) => p.plugin.name === name).map((p) => p.plugin.models)];
    for (const models of wired) {
      for (const [slot, id] of Object.entries(models)) {
        const need = needs[slot];
        if (!need) return `${name} has no model slot "${slot}" (it has ${Object.keys(needs).join(", ") || "none"})`;
        const is = this.cfg.modelKinds[id] ?? "chat";
        if (is !== need.kind) return `${name}'s ${slot} slot takes ${need.kind} models; ${id} is a ${is} model (set models.${id}.kind if that is wrong)`;
      }
    }
    return null;
  }

  private running(l: Loaded, kind: RequestKind): boolean {
    return l.state === "running" && !l.paused && l.kinds[kind] !== undefined;
  }

  /** The models a plugin uses on a line: the line's wiring over its own. null when a slot it needs is empty there. */
  private slots(l: Loaded, onLine: Record<string, string>): Record<string, string | null> | null {
    const wired = { ...l.decl.models, ...onLine };
    const out: Record<string, string | null> = {};
    for (const [slot, need] of Object.entries(l.needs)) {
      const id = wired[slot];
      if (id === undefined && !need.optional) return null;
      out[slot] = id ?? null;
    }
    return out;
  }

  /** The plugins that run on every line for a request of this kind from this router, in config order. */
  forRequest(kind: RequestKind, router: string | null): Active[] {
    if (!LIVE_KINDS.has(kind)) return [];
    const own = router === null ? {} : this.cfg.routers[router]?.plugins ?? {};
    return this.loaded
      .filter((l) => l.decl.everyLine && this.running(l, kind) && own[l.name] !== "off")
      .flatMap((l) => {
        const o = own[l.name];
        const models = this.slots(l, {});
        return models ? [{ name: l.name, config: typeof o === "object" ? o.config : l.decl.config, models, line: null }] : [];
      });
  }

  /** The plugins a step places, for a request of this kind, in the step's order; one with an empty slot there is left out. */
  forLine(kind: RequestKind, placed: readonly StepPlugin[], line: Line): Active[] {
    if (!LIVE_KINDS.has(kind)) return [];
    const own = this.cfg.routers[line.router]?.plugins ?? {};
    return placed.flatMap((x) => {
      const l = this.loaded.find((y) => y.name === x.name);
      if (!l || !this.running(l, kind)) return [];
      const models = this.slots(l, x.models);
      if (!models) return [];
      const o = own[l.name];
      return [{ name: l.name, config: typeof o === "object" ? o.config : l.decl.config, models, line }];
    });
  }

  /** Whether any plugin could run on a request at all, so the request carries what a line's plugins will need. */
  any(): boolean {
    return this.loaded.some((l) => l.state === "running");
  }

  /** Pauses or resumes a running plugin until the next restart. A locked plugin is never paused. */
  pause(name: string, paused: boolean): string | null {
    const l = this.loaded.find((x) => x.name === name);
    if (!l) return `no plugin named ${name}`;
    if (l.state !== "running") return `${name} is not running`;
    if (paused && l.decl.locked) return `${name} is locked: it runs on every request it handles`;
    if (l.paused !== paused) this.log.info(paused ? "plugin.paused_by_operator" : "plugin.resumed", { plugin: name });
    l.paused = paused;
    return null;
  }

  private get(name: string): Loaded {
    return this.loaded.find((l) => l.name === name)!;
  }

  private stat(l: Loaded, stage: PluginStage): Stat {
    return (l.stats[stage] ??= { calls: 0, errors: 0, refused: 0, flagged: 0, skipped: 0, ms: [] });
  }

  /**
   * Runs one blocking stage over the active plugins, in order, each seeing the previous one's changes.
   * Returns the request as changed and whether any plugin asked to keep it local. A refusal throws.
   */
  async run(stage: "request" | "routed", active: Active[], req: HookRequest): Promise<{ req: HookRequest; stayLocal: boolean; ran: string[] }> {
    let cur = req;
    let stayLocal = false;
    const ran: string[] = [];
    for (const a of active) {
      const l = this.get(a.name);
      // On a line, a plugin's one turn before the model is its `routed` hook, or its `request` hook if that is all it has.
      const hook = stage === "routed" && a.line !== null && !l.kinds[cur.kind]?.includes("routed") ? "request" : stage;
      const fn = l.hooks[hook];
      if (!fn || !l.kinds[cur.kind]?.includes(hook)) continue;
      const st = this.stat(l, stage);
      if (!matches(l.decl.when, cur)) { st.skipped++; continue; }
      ran.push(l.name);
      st.calls++;
      const t0 = Date.now();
      let d: Decision | void;
      try {
        if (Date.now() < l.pausedUntil) throw new Error("paused after repeated failures");
        d = await withTimeout(Promise.resolve(fn({ ...structuredClone(cur), models: a.models, line: a.line })), l.decl.timeoutMs, `plugin ${l.name}`);
        l.fails = 0;
      } catch (e) {
        st.errors++;
        const msg = e instanceof Error ? e.message : String(e);
        if (++l.fails >= BREAK_AFTER && Date.now() >= l.pausedUntil) {
          l.pausedUntil = Date.now() + BREAK_MS;
          this.log.warn("plugin.paused", { plugin: l.name, forMs: BREAK_MS });
        }
        if (l.decl.onError === "refuse") throw new PluginRefusal(l.name, 503, `plugin ${l.name} could not check this request: ${msg}`);
        l.failOpens++;
        this.log.warn("plugin.failed_open", { plugin: l.name, stage, id: cur.id, error: msg });
        continue;
      } finally {
        st.ms.push(Date.now() - t0);
        if (st.ms.length > 200) st.ms.shift();
      }
      if (!d) continue;
      if (d.refuse) {
        if (l.decl.onFail === "refuse") {
          st.refused++;
          throw new PluginRefusal(l.name, d.refuse.status && d.refuse.status >= 400 && d.refuse.status < 600 ? d.refuse.status : 400, d.refuse.message);
        }
        st.flagged++;
        this.log.warn("plugin.flagged", { plugin: l.name, id: cur.id, reason: d.refuse.message });
      }
      if (d.flag) { st.flagged++; this.log.warn("plugin.flagged", { plugin: l.name, id: cur.id, reason: d.flag }); }
      if (d.stayLocal) stayLocal = true;
      cur = this.apply(l.name, cur, d);
    }
    return { req: cur, stayLocal, ran };
  }

  /** A decision's changes, checked: a body must stay a chat request, and no hook touches authorization. */
  private apply(name: string, r: HookRequest, d: Decision): HookRequest {
    let next = r;
    if (d.body !== undefined) {
      const b = d.body as { messages?: unknown };
      if (typeof d.body !== "object" || d.body === null || !Array.isArray(b.messages)) {
        throw new PluginRefusal(name, 500, `plugin ${name} returned a body that is not a chat request`);
      }
      if (Buffer.byteLength(JSON.stringify(d.body)) > this.cfg.maxBodyBytes) {
        throw new PluginRefusal(name, 413, `plugin ${name} made the request larger than maxBodyBytes`);
      }
      next = { ...next, body: d.body };
    }
    if (d.headers) {
      const h = { ...next.headers };
      for (const [k, v] of Object.entries(d.headers)) {
        const key = k.toLowerCase();
        if (key === "authorization" || key === "cookie") continue;
        if (v === null) delete h[key];
        else h[key] = String(v);
      }
      next = { ...next, headers: h };
    }
    if (d.lane !== undefined && d.lane in this.cfg.scheduler.lanes) next = { ...next, lane: d.lane };
    return next;
  }

  /** Runs `log` or `error` in the background, in the reverse of config order. Never throws. */
  observe(stage: "log" | "error", active: Active[], x: HookExchange): void {
    for (const a of [...active].reverse()) {
      const l = this.get(a.name);
      const fn = l.hooks[stage];
      if (!fn || !l.kinds[x.kind]?.includes(stage) || !matches(l.decl.when, x)) continue;
      const st = this.stat(l, stage);
      st.calls++;
      const t0 = Date.now();
      void withTimeout(Promise.resolve(fn({ ...structuredClone(x), models: a.models, line: a.line })), OBSERVE_MS, `plugin ${l.name}`)
        .catch((e) => {
          st.errors++;
          this.log.warn("plugin.observe_failed", { plugin: l.name, stage, error: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => {
          st.ms.push(Date.now() - t0);
          if (st.ms.length > 200) st.ms.shift();
        });
    }
  }

  /** Whether any running plugin may read a reply, so one is worth keeping before the line is known. */
  anyWantsReply(): boolean {
    return this.loaded.some((l) => l.state === "running" && (l.hooks.log !== undefined || l.hooks.error !== undefined) && (l.decl.trust === "code" || l.decl.reads.includes("reply")));
  }

  /** Whether any active plugin wants the reply, so it is worth keeping a copy of the answer. */
  wantsReply(active: Active[]): boolean {
    return active.some((a) => {
      const l = this.get(a.name);
      return (l.hooks.log !== undefined || l.hooks.error !== undefined) && (l.decl.trust === "code" || l.decl.reads.includes("reply"));
    });
  }

  status(): PluginStatus[] {
    const pct = (ms: number[], q: number) => {
      if (!ms.length) return 0;
      const s = [...ms].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
    };
    return this.loaded.map((l) => ({
      name: l.name, trust: l.decl.trust, state: l.state, error: l.error, kinds: l.kinds, declared: l.declared, needs: l.needs, models: l.decl.models, everyLine: l.decl.everyLine, use: shownUse(l.decl.use),
      when: l.decl.when, timeoutMs: l.decl.timeoutMs, onError: l.decl.onError, onFail: l.decl.onFail, locked: l.decl.locked,
      required: l.decl.required, reads: l.decl.reads, paused: l.paused, pausedUntil: l.pausedUntil, failOpens: l.failOpens,
      stages: Object.fromEntries(Object.entries(l.stats).map(([stage, st]) => [stage, {
        calls: st.calls, errors: st.errors, refused: st.refused, flagged: st.flagged, skipped: st.skipped, p50: pct(st.ms, 0.5), p95: pct(st.ms, 0.95),
      }])),
    }));
  }

  private async loadCode(name: string, decl: PluginDecl, internal: PluginContext["internal"]): Promise<{ declared: Declared; needs: Needs; hooks: Hooks }> {
    let url: string;
    if (decl.use.startsWith("file:")) {
      const rel = decl.use.slice(5);
      const base = this.cfg.configPath ? dirname(this.cfg.configPath) : process.cwd();
      const path = isAbsolute(rel) ? rel : resolvePath(base, rel);
      if (decl.integrity !== null) {
        const got = "sha256-" + createHash("sha256").update(readFileSync(path)).digest("hex");
        if (got !== decl.integrity) throw new Error(`${path} is not the file its integrity names (it hashes to ${got})`);
      }
      url = pathToFileURL(path).href;
    } else {
      // npm:<package>@<version>: installed beside hearth by the operator, and held to that exact version.
      const spec = decl.use.slice(4);
      const at = spec.lastIndexOf("@");
      const pkg = spec.slice(0, at), want = spec.slice(at + 1);
      const req = createRequire(this.cfg.configPath ?? resolvePath(process.cwd(), "hearth.yaml"));
      const manifest = req.resolve(`${pkg}/package.json`);
      const have = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
      if (have !== want) throw new Error(`${pkg} is installed at ${have ?? "no version"}, and the config pins ${want}`);
      url = pathToFileURL(req.resolve(pkg)).href;
    }
    const mod = (await import(url)) as { default?: PluginModule };
    const m = mod.default;
    if (!m || m.apiVersion !== 1 || typeof m.setup !== "function") throw new Error("its default export is not a plugin (definePlugin with apiVersion 1)");
    const declared = validDeclared(m.kinds);
    if (!declared) throw new Error("it declares kinds hearth does not know");
    const needs = validNeeds(m.needs);
    if (!needs) throw new Error("its needs name a kind of model hearth does not know");
    const hooks = await withTimeout(Promise.resolve(m.setup({ name, config: decl.config, log: this.log, internal })), 10_000, `plugin ${name} setup`);
    return { declared, needs, hooks };
  }

  /** What a service says it handles, read the way startup reads it; for the console, before it is added. */
  static async manifest(url: string, key: string | null): Promise<{ kinds: Declared; needs: Needs }> {
    const base = url.replace(/\/$/, "");
    const res = await fetch(`${base}/manifest`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5_000) }).catch((e: unknown) => {
      throw new Error(unreachable(base, e));
    });
    if (!res.ok) throw new Error(`${base}/manifest answered ${res.status}${res.status === 401 || res.status === 403 ? ": it wants a key" : ""}`);
    const m = (await res.json().catch(() => null)) as { apiVersion?: unknown; kinds?: unknown; needs?: unknown } | null;
    if (m?.apiVersion !== 1) throw new Error(`${base}/manifest is not a hearth plugin manifest (apiVersion 1)`);
    const declared = validDeclared(m.kinds);
    if (!declared) throw new Error(`${base}/manifest declares kinds or stages hearth does not know`);
    const needs = validNeeds(m.needs);
    if (!needs) throw new Error(`${base}/manifest needs a kind of model hearth does not know`);
    return { kinds: declared, needs };
  }

  private async loadService(_name: string, decl: PluginDecl, internal: PluginContext["internal"]): Promise<{ declared: Declared; needs: Needs; hooks: Hooks }> {
    const base = decl.use.replace(/\/$/, "");
    const auth: Record<string, string> = decl.key ? { authorization: `Bearer ${decl.key}` } : {};
    const { kinds: declared, needs } = await Plugins.manifest(base, decl.key);
    const post = async (hook: PluginStage, payload: Record<string, unknown>, ms: number): Promise<unknown> => {
      const r = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ apiVersion: 1, hook, ...payload, internal }),
        signal: AbortSignal.timeout(ms),
      });
      if (!r.ok) throw new Error(`answered ${r.status}`);
      return r.json().catch(() => ({}));
    };
    // Only what the plugin reads leaves the node.
    const shown = (r: HookRequest | HookExchange): Record<string, unknown> => {
      const { body, headers, ...rest } = r as HookExchange;
      const out: Record<string, unknown> = { ...rest };
      if (decl.reads.includes("messages")) out.body = body;
      if (decl.reads.includes("headers")) out.headers = headers;
      if (!decl.reads.includes("reply")) delete out.reply;
      return out;
    };
    const decide = (hook: "request" | "routed") => async (r: HookRequest): Promise<Decision | void> => {
      const out = (await post(hook, { kind: r.kind, dryRun: false, request: shown(r) }, decl.timeoutMs)) as { decision?: Decision };
      return out.decision;
    };
    const observe = (hook: "log" | "error") => async (x: HookExchange): Promise<void> => {
      await post(hook, { kind: x.kind, exchange: shown(x) }, OBSERVE_MS);
    };
    const hooks: Hooks = {};
    const all = new Set(Object.values(declared).flat());
    if (all.has("request")) hooks.request = decide("request");
    if (all.has("routed")) hooks.routed = decide("routed");
    if (all.has("log")) hooks.log = observe("log");
    if (all.has("error")) hooks.error = observe("error");
    return { declared, needs, hooks };
  }
}
