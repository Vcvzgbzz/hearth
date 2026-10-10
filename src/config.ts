/** Config loading and validation: a typo fails at startup with an actionable line. Nothing leaves the machine unless configured to. */
import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { EMULATIONS, type Emulation } from "./emulate.js";
import { KINDS, type KindName } from "./kinds.js";
import { FIELDS, nearest, SECTION_KEYS, type Scope } from "./fields.js";
import { v1Marker } from "./migrate.js";
import { known, NOTE_MAX, type ModelStats } from "./stats.js";

export type RoutePolicy = "local" | "peer" | "spillover" | "fastest";

export interface PeerConfig {
  name: string;
  /** Base url of the peer's hearth, not its backend. */
  url: string;
  /** Bearer token this peer expects. `env:NAME` pulls it from the environment so
   *  it stays out of the config file you commit. */
  token: string;
  /** my model id -> their model id. Also the allowlist: an unmapped model never goes to this peer. */
  models: Record<string, string>;
}

/** A backend's `kind`, one of the entries in kinds.ts. */
export type WarmSource = KindName;

/**
 * What a named resource is. `kind` is display only; `shared` resources (a CPU running several
 * sidecars) are never arbitrated, so declaring one serializes and evicts nothing.
 */
export interface ResourceDecl {
  /** What to draw it as. Behaviour never reads this. */
  kind: "gpu" | "cpu" | "other";
  /** Several backends may use it at once; filtered out before the scheduler sees it. */
  shared: boolean;
}

/**
 * A request path on a backend that is not OpenAI-shaped (A1111, whisper, a TTS sidecar), named so
 * it can queue. The body is forwarded untouched. Synchronous endpoints only: submit-then-poll leaks a slot.
 */
export interface RouteRule {
  /** Exact pathname, query ignored. May hold one `{model}` placeholder for a whole segment. */
  path: string;
  /** Which lane it queues in, and so what it yields to. */
  lane: string;
  /** The id this work is reported under — status, logs, the page. */
  model: string;
  /** false routes the path here without queueing it: progress and status endpoints. */
  queue: boolean;
  /**
   * Where the same request goes when this backend cannot answer it (unreachable, or a 5xx
   * before any byte): another backend, under the id it serves there. null refuses, as before.
   */
  fallback: RouteFallback | null;
}

export interface RouteFallback {
  backend: string;
  model: string;
}

/**
 * `activity:`: a path where a backend reports its own busy state, for work hearth forwards but
 * does not schedule (e.g. ComfyUI). `running` and optional `queued` name dotted fields read as an
 * array length or number; anything else is "cannot tell", never idle.
 */
export interface ActivityDecl {
  path: string;
  /** Field holding what is running now. */
  running: string;
  /** Field holding what is queued, if the backend distinguishes the two. */
  queued: string | null;
}

export interface BackendConfig {
  /** How this backend is named in `models.<id>.backend` and in status output.
   *  A single-backend config gets "default" without having to say so. */
  name: string;
  /** The OpenAI-compatible server this backend fronts. */
  url: string;
  /** Where warm state comes from. */
  kind: WarmSource;
  /**
   * The model ids this backend serves, instead of discovering them from /v1/models. Also an
   * allowlist; declare them for a server that reports a file path as its id.
   */
  serves: string[];
  /** Jobs allowed on this backend at once; defaults to backendDefaults.concurrency. */
  concurrency: number;
  /**
   * How long to wait for this backend's first byte, in ms; 0 waits forever. Defaults to
   * `backendDefaults.firstByteMs`. Size it for the slowest honest reply behind this port.
   */
  firstByteMs: number | null;
  /** How long this backend may go silent mid-answer, in ms; 0 waits forever. Defaults to `backendDefaults.idleMs`. */
  idleMs: number | null;
  /**
   * Hardware this backend consumes (names are yours), so backends whose sets overlap take
   * turns. Routing is unaffected; empty competes for nothing.
   */
  resources: string[];
  /** Non-OpenAI paths this backend serves, and whether they queue. Empty for `/v1` backends. */
  routes: RouteRule[];
  /** Where this backend reports its own busy state; see ActivityDecl. */
  activity: ActivityDecl | null;
  /** Lives on its `resources` without taking turns for them; see ResidentDecl. null for a normal backend. */
  resident: ResidentDecl | null;
  /** Keeps named lanes off its `resources` while its app is in use; see HoldDecl. null holds nothing. */
  hold: HoldDecl | null;
}

/**
 * `hold:` on a backend with an `activity:` path: work hearth does not schedule (an image app
 * driven from its own page) keeps the listed lanes of every backend sharing its hardware from
 * starting, from the moment the app answers until it has reported nothing running or queued
 * for `idleMs`. Other lanes take the card as before.
 */
export interface HoldDecl {
  /** The lanes kept waiting, or sent to `models.<id>.whenHeld`. */
  lanes: string[];
  /** How long the app must stay idle before the lanes may start again. */
  idleMs: number;
  /**
   * The id the app loads under when it is a seat in a model swapper: one a backend declares in
   * `serves`, this one included. The hold then starts when that seat starts loading, not a load
   * later when the app first answers, and ends when the swapper drops it. null for an app that
   * is simply up or down.
   */
  seat: string | null;
}

/**
 * A small always-loaded service that shares a card rather than taking turns on it: its own
 * requests never wait for the card or evict anyone, and before any other backend's turn on
 * that card hearth POSTs `yield` (`{"seconds": n}`), then `resume` once the card is free again.
 */
export interface ResidentDecl {
  /** null for a resident with nothing to ask: it shares the card and is never told to move. */
  yield: string | null;
  resume: string | null;
}

export interface ModelRoute {
  /** Which backend serves it. null means "work it out from the catalogs".
   *  Naming one is how you break a tie when two backends offer the same id. */
  backend: string | null;
  /** The id sent to the backend when it differs from the advertised one; null when they match. */
  as: string | null;
  /**
   * Go out as whatever `backend` has resident right now, and as `as` only when
   * nothing is loaded there. For clients pinned to one id on a card whose seat
   * gets swapped by hand: a fixed id would swap the card back on every request.
   */
  follow: boolean;
  policy: RoutePolicy;
  /** Who may serve it, in preference order. Empty means anyone that maps it. */
  peers: string[];
  /** `spillover` only: go remote once this many jobs are queued here. */
  spilloverAt: number;
  /** Fall back to the local backend if no peer can take it. */
  fallbackLocal: boolean;
  /**
   * Request fields stamped on every chat completion for this id, after `as` and over the
   * client's own, so several ids can front one resident model with different defaults.
   * Local dispatch only.
   */
  params: Record<string, unknown> | null;
  /** The lane every request for this id queues in, over the client's; null lets the client choose. */
  lane: string | null;
  /**
   * The id a request for this one runs as while a neighbour's `hold` keeps its lane off this
   * model's hardware; null leaves it queued until the hold ends.
   */
  whenHeld: string | null;
  /** What this model can take when nothing can be asked; observed values win field by field. */
  stats: ModelStats | null;
  /** Reshapes this id's backend answers into another server's format; see emulate.ts. */
  emulate: Emulation | null;
  /** Tokens the model's running requests share (vLLM's KV cache, llama.cpp `--kv-unified`); `output` caps each request's counted `max_tokens`, null counts it whole. */
  pool: { tokens: number; output: number | null } | null;
  /** A turn shares the backend with this model's running turns only once each has run this long; unset never waits. */
  shareAfterMs?: number;
  /**
   * Jobs this model may run at once locally, overriding the backend's `concurrency` either way:
   * vLLM's --max-num-seqs above it, llama.cpp's --parallel below it. A raise applies only while
   * this model is the only one running. `batch:` is the older name.
   */
  concurrency: number | null;
  /** Tokens one video costs this model when sizing a request; unset uses the flat default. */
  videoTokens?: number;
}

/**
 * How a canary asks its question and what counts as an answer. Small and
 * specific on purpose: a question with one right answer, in a handful of
 * tokens, judged by a pattern.
 */
export interface CanaryProbe {
  /** Sent as the only user message. */
  prompt: string;
  /** Compiled and matched against the answer; a bad pattern fails at --check. */
  expect: string;
  /** Room for the answer. A reasoning model needs more, since its trace shares this budget. */
  maxTokens: number;
  /** Deadline for the whole probe, in ms. */
  timeoutMs: number;
  /** How long between probes of one model, in ms. */
  intervalMs: number;
  /** This many consecutive failures puts the model in `degraded`. */
  failureThreshold: number;
  /** This many consecutive clean probes brings it back. */
  recoverAfter: number;
}

/** Where a state change is announced, and with what. */
export interface CanaryNotify {
  /** POSTed a JSON body describing the change. */
  url: string;
  /** Sent as-is; values may be `env:NAME` so a key stays out of the config file. */
  headers: Record<string, string>;
  /** A hook that hangs must not hang the canary. */
  timeoutMs: number;
}

/**
 * The gentlest nudge for a degraded seat: for a swapping backend, drop just that
 * model so the next request has to load it again. Present only where declared,
 * and `unload: false` keeps it to notification only.
 */
export interface CanaryRecovery {
  /** Ask the backend to unload this one model. */
  unload: boolean;
  /** Never attempt it twice for one model inside this window, in ms. */
  cooldownMs: number;
}

/**
 * The opt-in canary: which models are asked, how, and what happens when one
 * stops answering. Absent means no probes at all, and no traffic inspection.
 */
export interface CanaryConfig {
  /** Every probe inherits these; a model or backend entry overrides field by field. */
  defaults: CanaryProbe;
  /** Model ids asked directly, with overrides. Presence is the opt-in. */
  models: Record<string, Partial<CanaryProbe>>;
  /** Backends whose whole served set is asked, with overrides. */
  backends: Record<string, Partial<CanaryProbe>>;
  /** Also watch relayed completions; a degenerate one brings the next probe forward. */
  passive: boolean;
  notify: CanaryNotify | null;
  recovery: CanaryRecovery | null;
}

export interface HearthConfig {
  /** Declared hardware by name; an undeclared name is an exclusive `gpu`. */
  resources: Record<string, ResourceDecl>;
  /** The file this config was loaded from, or null when built in memory (which cannot be saved). */
  configPath: string | null;
  /**
   * A sidecar for runtime changes when the config file cannot be written (a read-only mount);
   * null otherwise. Under `ProtectSystem=strict` pair it with `StateDirectory=hearth`.
   */
  stateFile: string | null;
  /** Where the console's day of history and recent logs survive a restart; null keeps them in memory. */
  historyFile: string | null;
  /** What this node calls itself when talking to peers. */
  name: string;
  listen: { host: string; port: number };
  /**
   * The local backends, in order: each its own admission domain. An unknown model goes to the
   * first, and a model several offer resolves to the first unless pinned.
   */
  backends: BackendConfig[];
  scheduler: {
    /** Default concurrency for backends that don't set their own. */
    concurrency: number;
    agePerSecond: number;
    warmBonus: number;
    /** `concurrency` is the most of a backend's slots the lane may hold at once; unset is no ceiling. */
    lanes: Record<string, { priority: number; concurrency?: number; maxWaitMs?: number }>;
    /** How long one lane's queue may get before we start refusing. Someone told
     *  "full" can retry. Someone queued behind 400 jobs just waits. */
    maxPerLane: number;
    /** Cap per caller per lane; 0 turns it off. Defaults to 0 without apiKeys, where every caller is one. */
    maxPerCaller: number;
  };
  /** Keys allowed on the OpenAI surface. Empty means no auth, which only makes
   *  sense on loopback. Setting it also means loopback needs a key. */
  apiKeys: string[];
  /** Names for the keys, index-aligned with `apiKeys` ("" for none), shown as `key:<label>`. Not secret. */
  apiKeyLabels: string[];
  /**
   * What each key may run, index-aligned with `apiKeys`; null is everything. A list scopes the
   * key to chat and `/v1/models` for exactly those routed ids.
   */
  apiKeyModels: (string[] | null)[];
  /** Tokens peers present to us, by peer name (`peers.<name>.accept`). Kept separate from apiKeys so
   *  peer traffic is attributable and can be capped on its own. */
  peerTokens: Record<string, string>;
  /**
   * The operator login: a username and the scrypt hash of its password, as printed by
   * `hearth set-operator`. Null means the console has no login form and no session can
   * exist — the address and the keys are the only doors in.
   */
  operator: { user: string; passHash: string } | null;
  /** Models we'll serve to peers (`lending.models`). Empty means none, since lending is opt-in. */
  share: string[];
  /** What each model is for, shown to peers beside it (`models.<id>.note`). */
  notes?: Record<string, string>;
  /** Requests per hour one peer may send us (`lending.rateLimit`). */
  peerRateLimit: number;
  /** The lane borrowed work lands in, whatever the peer asks (`lending.lane`); defaults to the lowest-priority one. */
  peerLane: string;
  /** Jobs one peer may have queued or running at once (`lending.maxConcurrent`). */
  peerMaxConcurrent: number;
  /** Biggest request body we'll take. Multi-image vision payloads get close to
   *  the old hardcoded 32MB, so it's a knob now instead of a constant. */
  maxBodyBytes: number;
  peers: PeerConfig[];
  models: Record<string, ModelRoute>;
  /**
   * Ask named models a question with one right answer, on a schedule, so a seat that answers
   * 200 with nothing worth reading is taken out of rotation instead of being called healthy.
   * Off — null — unless `canary:` is configured. See canary.ts.
   */
  canary: CanaryConfig | null;
  // The peer timings below are `borrowing.*` in hearth.yaml, and the backend ones `backendDefaults.*`.
  /** How long a good peer reading is reused before routing asks again; concurrent requests share one probe. */
  peerFreshMs: number;
  /** How long a failed probe is remembered, so an outage does not slow every local request. */
  peerDownMs: number;
  /** Background poll, and only a floor these days: warms the cache before the
   *  first request and re-checks peers nobody's asking about. 0 turns it off. */
  peerPollMs: number;
  peerStaleMs: number;
  /** How long to wait for a peer's first byte, in ms; 0 waits forever. Above their worst honest cold load. */
  peerFirstByteMs: number;
  /**
   * How long to wait for a local backend's first byte, in ms; 0 waits forever. Catches a wedged
   * backend, which would otherwise hold its slot (and any shared card) until restart.
   */
  backendFirstByteMs: number;
  /**
   * How long a local backend may go silent once its answer has started, in ms; 0 waits forever.
   * Catches a generation that hangs mid-stream, which would otherwise hold its slot and card.
   */
  backendIdleMs: number;
  /**
   * How long shutdown waits for in-flight requests, in ms; 0 kills them at once. Keep the
   * service manager's stop timeout above it.
   */
  shutdownGraceMs: number;
  /** A cold model's cost to `fastest`, in queued-job units; 0 ignores warmth. Tune to your load times. */
  coldPenalty: number;
}

const DEFAULT_LANES = { chat: { priority: 0 }, batch: { priority: 100 } };

/** The lane /v1/warm uses, lowest priority so a warm yields to every real request; always ensured. */
const WARM_LANE = "warm";
const WARM_LANE_PRIORITY = 200;

export { WARM_LANE };

/**
 * A validation finding. `path` is the field it is about (e.g. `backends.card.kind`),
 * or null for a whole-config one; the sentence keeps the field too, because a
 * journal line has nothing else to say where it came from.
 */
export class ConfigError extends Error {
  constructor(
    readonly path: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function bad(path: string | null, text: string): ConfigError {
  return new ConfigError(path, path !== null && !text.startsWith(path) ? `${path} ${text}` : text);
}

/** Refuse a key this place does not take: a typo would otherwise load as the default, silently. */
function only(rec: Record<string, unknown>, allowed: Scope | readonly string[], where: string): void {
  const keys = typeof allowed === "string" ? Object.keys(FIELDS[allowed]) : allowed;
  for (const k of Object.keys(rec)) {
    if (keys.includes(k)) continue;
    const near = nearest(k, keys);
    throw bad(where ? `${where}.${k}` : k, `is not a setting${where ? ` of ${where}` : ""}${near ? ` — did you mean ${near}?` : ""}`);
  }
}

/** `env:NAME` indirection, so tokens live in the environment and the config
 *  stays committable. A missing variable is fatal, because starting up with an
 *  empty token means every peer call 401s and nothing says why. */
function resolveSecret(value: string, where: string): string {
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const got = process.env[name];
  if (!got) throw bad(where, `${where}: environment variable ${name} is not set`);
  return got;
}

function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw bad(where, "must be a mapping");
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string, fallback?: string): string {
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw bad(where, "is required");
  }
  if (typeof v !== "string") throw bad(where, "must be a string");
  return v;
}

function num(v: unknown, where: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw bad(where, "must be a number");
  }
  return v;
}

/** Whole number, at least `min` (`concurrency: 0` would queue forever). */
function count(v: unknown, where: string, fallback: number, min = 1): number {
  const n = num(v, where, fallback);
  if (!Number.isInteger(n) || n < min) {
    throw bad(where, `must be a whole number >= ${min} (got ${n})`);
  }
  return n;
}

/**
 * Declared stats, for a model that has never loaded or a backend that cannot report them.
 * A prediction: the running process wins once it loads. Bad values are errors, unlike a peer's.
 */
function declaredStats(raw: unknown, id: string): ModelStats | null {
  if (raw === undefined || raw === null) return null;
  const where = `models.${id}.stats`;
  const rec = asRecord(raw, where);
  const out: ModelStats = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "context") {
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw bad(`${where}.context`, `is "${String(v)}" -- expected a positive whole number of tokens`);
      }
      out.context = v;
    } else if (k === "vision" || k === "tools" || k === "thinking" || k === "effort") {
      if (typeof v !== "boolean") {
        throw bad(`${where}.${k}`, `is "${String(v)}" -- expected true or false`);
      }
      out[k] = v;
    } else if (k === "quant") {
      out.quant = str(v, `${where}.quant`);
    } else {
      throw bad(`${where}.${k}`, "is not a model stat -- expected context, vision, tools, thinking, effort or quant");
    }
  }
  return known(out) ? out : null;
}

/**
 * `models.<id>.params`: flat request fields to stamp. `model`, `messages`, `stream` and `lane`
 * are refused, since stamping them breaks the request.
 */
function modelParams(raw: unknown, id: string): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  const where = `models.${id}.params`;
  const rec = asRecord(raw, where);
  for (const k of ["model", "messages", "stream", "lane"]) {
    if (k in rec) {
      throw bad(
        `${where}.${k}`, "cannot be stamped -- " +
          (k === "model" ? "use `as` to rename the model on the wire" : `${k} belongs to the request, not the route`),
      );
    }
  }
  return Object.keys(rec).length === 0 ? null : rec;
}

/** A model's own slot count, or null to take its backend's. */
function modelConcurrency(entry: Record<string, unknown>, id: string): number | null {
  if (entry.concurrency === undefined || entry.concurrency === null) return null;
  return count(entry.concurrency, `models.${id}.concurrency`, 1, 1);
}

/** `pool: 144000`, or `pool: { tokens: 144000, output: 8192 }`. */
function modelPool(v: unknown, id: string): ModelRoute["pool"] {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return { tokens: count(v, `models.${id}.pool`, 1, 1), output: null };
  const p = asRecord(v, `models.${id}.pool`);
  only(p, "pool", `models.${id}.pool`);
  return {
    tokens: count(p.tokens, `models.${id}.pool.tokens`, 0, 1),
    output: p.output === undefined || p.output === null ? null : count(p.output, `models.${id}.pool.output`, 1, 1),
  };
}

/** Number, at least `min`, fractions fine; for tuning weights where a negative inverts the meaning. */
function atLeast(v: unknown, where: string, fallback: number, min = 0): number {
  const n = num(v, where, fallback);
  if (n < min) throw bad(where, `must be >= ${min} (got ${n})`);
  return n;
}

const WARM_SOURCES = Object.keys(KINDS) as WarmSource[];

/** A backend's `kind`, defaulting to llama-swap. */
function warmSource(entry: Record<string, unknown>, where: string): WarmSource {
  const kind = str(entry.kind, `${where}.kind`, "llama-swap");
  if (!WARM_SOURCES.includes(kind as WarmSource)) {
    throw bad(`${where}.kind`, `is "${kind}" — expected ${WARM_SOURCES.join(", ")}`);
  }
  return kind as WarmSource;
}

function bool(v: unknown, where: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw bad(where, "must be true or false");
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw bad(where, "must be a list of strings");
  }
  return v as string[];
}

/** `apiKeys:` entries: a bare secret, or `{ key, label }`. Labels are shown wherever caller ids are. */
function apiKeyList(
  v: unknown, where: string, routeIds: Set<string>,
): { keys: string[]; labels: string[]; models: (string[] | null)[] } {
  if (v === undefined) return { keys: [], labels: [], models: [] };
  if (!Array.isArray(v)) throw bad(where, "must be a list");
  const keys: string[] = [];
  const labels: string[] = [];
  const models: (string[] | null)[] = [];
  // Both refuse a duplicate, and neither message ever names the secret.
  const seenKey = new Map<string, number>();
  const seenLabel = new Map<string, number>();
  const take = (key: string, label: string, at: string, scope: string[] | null = null): void => {
    // The first match wins in localCaller, so a repeated secret makes every
    // later entry unreachable — including its label, which would then be a name
    // the operator sees in the config and never in a log.
    const dupKey = seenKey.get(key);
    if (dupKey !== undefined) {
      throw bad(
        `${at}.key`, `repeats ${where}[${dupKey}] -- the first match wins, so this entry can never be the one that authenticates`,
      );
    }
    seenKey.set(key, keys.length);
    if (label !== "") {
      // Two keys under one label would be one caller sharing one budget, so refuse it.
      const dupLabel = seenLabel.get(label);
      if (dupLabel !== undefined) {
        throw bad(
          `${at}.label`, `"${label}" is already used by ${where}[${dupLabel}] -- two keys under one name share one caller identity, and with it one maxPerCaller budget`,
        );
      }
      seenLabel.set(label, keys.length);
    }
    keys.push(key);
    labels.push(label);
    models.push(scope);
  };
  v.forEach((raw, i) => {
    const at = `${where}[${i}]`;
    if (typeof raw === "string") {
      take(resolveSecret(raw, at), "", at);
      return;
    }
    const entry = asRecord(raw, at);
    only(entry, ["key", "label", "models"], at);
    const key = resolveSecret(str(entry.key, `${at}.key`), `${at}.key`);
    // A blank label is a typo, not "no label" — the string form is how you say
    // no label — so it is refused rather than silently falling back to the hash.
    const label = str(entry.label, `${at}.label`).trim();
    if (label === "") throw bad(`${at}.label`, "must not be empty");
    // A scope names routes, not backend ids: an unknown id is refused here
    // rather than found as a 403 on the client, and a scoped key can only ever
    // reach ids whose lane and params the operator wrote down.
    let scope: string[] | null = null;
    if (entry.models !== undefined) {
      scope = strList(entry.models, `${at}.models`);
      if (scope.length === 0) throw bad(`${at}.models`, "must name at least one model");
      for (const id of scope) {
        if (!routeIds.has(id)) {
          throw bad(`${at}.models`, `names "${id}", which is not a route in models:`);
        }
      }
    }
    take(key, label, at, scope);
  });
  return { keys, labels, models };
}

/** A path that can match a request: absolute, no query string. Shared by `routes:` and `activity:`. */
function requirePath(path: string, at: string): void {
  // A path that does not start with "/" can never match a request — a typo that
  // would otherwise fail silently at 3am rather than at startup. Matching is on
  // pathname alone, so a query string in the config is a mistake as well.
  if (!path.startsWith("/")) {
    throw bad(`${at}.path`, `must start with "/" (got ${path})`);
  }
  if (path.includes("?")) {
    throw bad(`${at}.path`, `must not include a query string (got ${path})`);
  }
}

/** `activity:` on a backend; `running` is required, `queued` optional. */
function activityDecl(v: unknown, where: string): ActivityDecl | null {
  if (v === undefined || v === null) return null;
  const o = asRecord(v, where);
  only(o, "activity", where);
  const path = str(o.path, `${where}.path`);
  requirePath(path, where);
  return {
    path,
    running: str(o.running, `${where}.running`),
    queued: o.queued === undefined ? null : str(o.queued, `${where}.queued`),
  };
}

/** `resident: true` for the default paths, or `{yield, resume}` to name them. */
function residentDecl(v: unknown, where: string): ResidentDecl | null {
  if (v === undefined || v === null || v === false) return null;
  if (v === true) return { yield: "/yield", resume: "/resume" };
  const o = asRecord(v, where);
  only(o, ["yield", "resume"], where);
  // `yield: false` is a resident that cannot give memory back (a model inside someone else's llama-swap).
  if (o.yield === false) return { yield: null, resume: null };
  const out = { yield: str(o.yield, `${where}.yield`, "/yield"), resume: str(o.resume, `${where}.resume`, "/resume") };
  requirePath(out.yield, `${where}.yield`);
  requirePath(out.resume, `${where}.resume`);
  return out;
}

/** `hold:` on a backend; lane names are checked once the lanes exist. */
function holdDecl(v: unknown, where: string): HoldDecl | null {
  if (v === undefined || v === null) return null;
  const o = asRecord(v, where);
  only(o, ["lanes", "idleMs", "seat"], where);
  const lanes = strList(o.lanes, `${where}.lanes`);
  if (lanes.length === 0) throw bad(`${where}.lanes`, "must name at least one lane to hold");
  if (o.idleMs === undefined) throw bad(`${where}.idleMs`, "is required: how long the app must stay idle before the lanes start again");
  const seat = str(o.seat, `${where}.seat`, "");
  return { lanes, idleMs: atLeast(o.idleMs, `${where}.idleMs`, 0), seat: seat === "" ? null : seat };
}

/** `routes:` entries, as a bare path or an object; lane and model are filled in once lanes exist. */
function routeList(v: unknown, where: string): RouteRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(where, "must be a list");
  return v.map((raw, i) => {
    const at = `${where}[${i}]`;
    const entry = typeof raw === "string" ? { path: raw } : asRecord(raw, at);
    only(entry, ["path", "lane", "model", "queue", "fallback"], at);
    const path = str(entry.path, `${at}.path`);
    requirePath(path, at);
    // One placeholder, standing for one whole segment. More than one, or one
    // glued to other characters, is a pattern nobody can predict the reach of —
    // which is the objection that kept wildcards out of here in the first place.
    const holes = path.split("{model}").length - 1;
    if (holes > 1) {
      throw bad(`${at}.path`, `may contain at most one {model} (got ${path})`);
    }
    if (holes === 1 && !path.split("/").includes("{model}")) {
      throw bad(
        `${at}.path`, `must use {model} as a whole path segment, not part of one (got ${path})`,
      );
    }
    if (/\{(?!model\})[^}]*\}/.test(path)) {
      throw bad(`${at}.path`, `${at}.path: the only placeholder is {model} (got ${path})`);
    }
    if (holes === 1 && typeof entry.model === "string" && entry.model !== "") {
      throw bad(`${at}`, `sets both {model} in the path and model: — the path supplies the id`);
    }
    return {
      path,
      lane: str(entry.lane, `${at}.lane`, ""),
      model: str(entry.model, `${at}.model`, ""),
      queue: bool(entry.queue, `${at}.queue`, true),
      fallback: routeFallback(entry.fallback, `${at}.fallback`),
    };
  });
}

/** `fallback: {backend, model}`; that the backend exists is checked once all of them are known. */
function routeFallback(v: unknown, where: string): RouteFallback | null {
  if (v === undefined || v === null) return null;
  const o = asRecord(v, where);
  const out = { backend: str(o.backend, `${where}.backend`), model: str(o.model, `${where}.model`) };
  if (out.backend === "" || out.model === "") {
    throw new ConfigError(where, `${where} needs both backend: and model: — the backend to try, and the id it serves`);
  }
  return out;
}

function trimUrl(u: string, where: string): string {
  if (!/^https?:\/\//.test(u)) {
    throw bad(where, `must start with http:// or https:// (got ${u})`);
  }
  return u.replace(/\/+$/, "");
}

/** Peers a route may use that map `id`, in preference order; an empty `named` means every peer. */
export function peersMapping(id: string, named: readonly string[], peers: readonly PeerConfig[]): string[] {
  const order = named.length > 0 ? named : peers.map((p) => p.name);
  return order.filter((n) => peers.find((p) => p.name === n)?.models[id] !== undefined);
}

/** The question the canary asks when the operator does not write one. One right answer, one line. */
export const DEFAULT_CANARY_PROMPT = "What is the capital of France? Reply with the city name only.";

/** A pattern that will be compiled later; refuse it now, where `--check` can still report it. */
function pattern(text: string, where: string): string {
  try {
    new RegExp(text);
  } catch (e) {
    throw bad(where, `is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }
  return text;
}

/** Only the probe fields actually written down, so a neighbour's override is not inherited. */
function probeOverrides(raw: unknown, where: string): Partial<CanaryProbe> {
  const o = asRecord(raw ?? {}, where);
  const out: Partial<CanaryProbe> = {};
  if (o.prompt !== undefined) {
    const prompt = str(o.prompt, `${where}.prompt`).trim();
    if (prompt === "") throw bad(`${where}.prompt`, "must not be empty");
    out.prompt = prompt;
  }
  if (o.expect !== undefined) {
    out.expect = pattern(str(o.expect, `${where}.expect`), `${where}.expect`);
  }
  if (o.maxTokens !== undefined) out.maxTokens = count(o.maxTokens, `${where}.maxTokens`, 1, 1);
  if (o.timeoutMs !== undefined) out.timeoutMs = count(o.timeoutMs, `${where}.timeoutMs`, 1, 1);
  if (o.intervalMs !== undefined) out.intervalMs = count(o.intervalMs, `${where}.intervalMs`, 1, 1);
  if (o.failureThreshold !== undefined) {
    out.failureThreshold = count(o.failureThreshold, `${where}.failureThreshold`, 1, 1);
  }
  if (o.recoverAfter !== undefined) out.recoverAfter = count(o.recoverAfter, `${where}.recoverAfter`, 1, 1);
  return out;
}

/**
 * The `canary:` block. Off unless present, and it must name something to ask:
 * a canary that probes nothing looks configured and protects nothing.
 */
function canaryDecl(v: unknown, backends: readonly BackendConfig[]): CanaryConfig | null {
  if (v === undefined || v === null || v === false) return null;
  const c = asRecord(v, "canary");

  const prompt = str(c.prompt, "canary.prompt", DEFAULT_CANARY_PROMPT).trim();
  if (prompt === "") throw bad("canary.prompt", "must not be empty");
  const defaults: CanaryProbe = {
    prompt,
    expect: pattern(str(c.expect, "canary.expect", "Paris"), "canary.expect"),
    maxTokens: count(c.maxTokens, "canary.maxTokens", 512, 1),
    timeoutMs: count(c.timeoutMs, "canary.timeoutMs", 30_000, 1),
    intervalMs: count(c.intervalMs, "canary.intervalMs", 30_000, 1),
    failureThreshold: count(c.failureThreshold, "canary.failureThreshold", 2, 1),
    recoverAfter: count(c.recoverAfter, "canary.recoverAfter", 1, 1),
  };

  const models: Record<string, Partial<CanaryProbe>> = {};
  if (c.models !== undefined) {
    for (const [id, raw] of Object.entries(asRecord(c.models, "canary.models"))) {
      if (id.trim() === "") throw bad("canary.models", "a model id must not be empty");
      models[id] = probeOverrides(raw, `canary.models.${id}`);
    }
  }

  const scoped: Record<string, Partial<CanaryProbe>> = {};
  if (c.backends !== undefined) {
    const declared = backends.map((b) => b.name);
    for (const [name, raw] of Object.entries(asRecord(c.backends, "canary.backends"))) {
      if (!declared.includes(name)) {
        throw bad(
          `canary.backends.${name}`,
          `names a backend that is not declared (${declared.join(", ") || "none"})`,
        );
      }
      scoped[name] = probeOverrides(raw, `canary.backends.${name}`);
    }
  }

  if (Object.keys(models).length === 0 && Object.keys(scoped).length === 0) {
    throw bad(
      "canary",
      "names no models — add `models:` with at least one id, or `backends:` naming one " +
        "whose whole served set you want asked",
    );
  }

  let notify: CanaryNotify | null = null;
  if (c.notify !== undefined && c.notify !== null && c.notify !== false) {
    const n = asRecord(c.notify, "canary.notify");
    const url = str(n.url, "canary.notify.url").trim();
    if (url === "") throw bad("canary.notify.url", "must not be empty");
    const headers: Record<string, string> = {};
    if (n.headers !== undefined) {
      for (const [k, raw] of Object.entries(asRecord(n.headers, "canary.notify.headers"))) {
        headers[k] = resolveSecret(str(raw, `canary.notify.headers.${k}`), `canary.notify.headers.${k}`);
      }
    }
    notify = { url, headers, timeoutMs: count(n.timeoutMs, "canary.notify.timeoutMs", 5_000, 1) };
  }

  let recovery: CanaryRecovery | null = null;
  if (c.recovery !== undefined && c.recovery !== null && c.recovery !== false) {
    const r = asRecord(c.recovery, "canary.recovery");
    recovery = {
      // Declaring the block IS the flag; `unload: false` is how you keep it to a notification.
      unload: bool(r.unload, "canary.recovery.unload", true),
      cooldownMs: count(r.cooldownMs, "canary.recovery.cooldownMs", 600_000, 1),
    };
  }

  return {
    defaults,
    models,
    backends: scoped,
    passive: bool(c.passive, "canary.passive", false),
    notify,
    recovery,
  };
}

export function parseConfig(raw: unknown): HearthConfig {
  const root = asRecord(raw, "config");
  const v1 = v1Marker(root);
  if (v1 !== null) {
    throw new ConfigError(null, `this hearth.yaml is in the v1 layout (it has ${v1}) — run \`hearth migrate\` to rewrite it; the original is kept beside it`);
  }
  if (root.uiListen !== undefined) {
    throw bad("uiListen", "was removed: the console is on the main port now, open off-loopback " +
      "to a signed-in operator. Delete uiListen, and run `hearth set-operator` if you have not");
  }
  only(root, [...Object.keys(FIELDS.node), ...SECTION_KEYS], "");

  const listen = asRecord(root.listen ?? {}, "listen");
  only(listen, "listen", "listen");
  const sched = asRecord(root.scheduler ?? {}, "scheduler");
  only(sched, "scheduler", "scheduler");
  const defaults = asRecord(root.backendDefaults ?? {}, "backendDefaults");
  only(defaults, "backendDefaults", "backendDefaults");
  const lending = asRecord(root.lending ?? {}, "lending");
  only(lending, "lending", "lending");
  const borrowing = asRecord(root.borrowing ?? {}, "borrowing");
  only(borrowing, "borrowing", "borrowing");
  const defaultConcurrency = count(defaults.concurrency, "backendDefaults.concurrency", 1, 1);

  /** Declared hardware, validated up front so --check catches a typo. */
  const resourceDecls: Record<string, ResourceDecl> = {};
  if (root.resources !== undefined) {
    const rd = asRecord(root.resources, "resources");
    for (const [name, raw] of Object.entries(rd)) {
      const at = `resources.${name}`;
      const entry = asRecord(raw ?? {}, at);
      only(entry, "resource", at);
      const kind = str(entry.kind, `${at}.kind`, "gpu");
      if (kind !== "gpu" && kind !== "cpu" && kind !== "other") {
        throw bad(`${at}.kind`, `must be gpu, cpu or other (got ${JSON.stringify(kind)})`);
      }
      resourceDecls[name] = { kind, shared: bool(entry.shared, `${at}.shared`, false) };
    }
  }

  const backends: BackendConfig[] = [];
  if (root.backends === undefined) throw bad("backends", "is required: name at least one server for hearth to front");
  for (const [name, b] of Object.entries(asRecord(root.backends, "backends"))) {
    const at = `backends.${name}`;
    const entry = asRecord(b, at);
    only(entry, "backend", at);
    backends.push({
      name,
      url: trimUrl(str(entry.url, `${at}.url`), `${at}.url`),
      kind: warmSource(entry, at),
      serves: strList(entry.serves, `${at}.serves`),
      concurrency: count(entry.concurrency, `${at}.concurrency`, defaultConcurrency, 1),
      firstByteMs: entry.firstByteMs === undefined ? null : atLeast(entry.firstByteMs, `${at}.firstByteMs`, 0),
      idleMs: entry.idleMs === undefined ? null : atLeast(entry.idleMs, `${at}.idleMs`, 0),
      resources: strList(entry.resources, `${at}.resources`),
      routes: routeList(entry.routes, `${at}.routes`),
      activity: activityDecl(entry.activity, `${at}.activity`),
      resident: residentDecl(entry.resident, `${at}.resident`),
      hold: holdDecl(entry.hold, `${at}.hold`),
    });
  }
  if (backends.length === 0) throw bad("backends", "must not be empty");
  // Two backends claiming the same id outright is a typo. Discovery can
  // collide at runtime and picks the first with a warning, but a declared
  // clash is someone meaning two different things by one name.
  const claimed = new Map<string, string>();
  for (const b of backends) {
    for (const m of b.serves) {
      const owner = claimed.get(m);
      if (owner) {
        throw new ConfigError(
          "backends",
          `backends "${owner}" and "${b.name}" both declare they serve "${m}" — ` +
            `one id cannot mean two backends`,
        );
      }
      claimed.set(m, b.name);
    }
  }
  const backendNames = new Set(backends.map((b) => b.name));
  // A resident on shared hardware (or none) would never be asked to yield, which is its only job.
  for (const b of backends) {
    if (b.resident && !b.resources.some((r) => !resourceDecls[r]?.shared)) {
      throw new ConfigError("backends", `backends "${b.name}" is resident but declares no exclusive resource to yield`);
    }
  }
  // A kind that reports a resident model but cannot unload it would fail every neighbour's turn.
  for (const b of backends) {
    const k = KINDS[b.kind];
    if (b.resident || !k.knowsWarm || k.unload) continue;
    const mine = b.resources.filter((r) => !resourceDecls[r]?.shared);
    const rival = backends.find((o) => o !== b && !o.resident && o.resources.some((r) => mine.includes(r)));
    if (rival) {
      const card = rival.resources.find((r) => mine.includes(r));
      throw new ConfigError(
        "backends",
        `backends "${b.name}" (kind: ${b.kind}) cannot unload, so "${rival.name}" could never take ${card} from it — ` +
          `declare "${b.name}" resident, or mark ${card} shared`,
      );
    }
  }

  const lanesRaw = sched.lanes === undefined ? DEFAULT_LANES : asRecord(sched.lanes, "scheduler.lanes");
  const lanes: Record<string, { priority: number; concurrency?: number; maxWaitMs?: number }> = {};
  for (const [lane, v] of Object.entries(lanesRaw)) {
    const entry = asRecord(v, `scheduler.lanes.${lane}`);
    only(entry, "lane", `scheduler.lanes.${lane}`);
    lanes[lane] = { priority: num(entry.priority, `scheduler.lanes.${lane}.priority`, 0) };
    // Left off when unset rather than defaulted: no number here means the lane has no ceiling of its own.
    if (entry.concurrency !== undefined) {
      lanes[lane].concurrency = count(entry.concurrency, `scheduler.lanes.${lane}.concurrency`, 1);
    }
    if (entry.maxWaitMs !== undefined) {
      lanes[lane].maxWaitMs = count(entry.maxWaitMs, `scheduler.lanes.${lane}.maxWaitMs`, 0, 1000);
    }
  }
  // BEFORE the warm lane is added, or `lanes: {}` would quietly become a valid
  // config with one lane nobody asked for. An empty lanes block is a mistake and
  // has to keep failing as one.
  if (Object.keys(lanes).length === 0) {
    throw new ConfigError("scheduler.lanes", "must define at least one lane");
  }
  // See WARM_LANE_PRIORITY. Added rather than defaulted, so it survives an
  // explicit `lanes:` block that would otherwise replace it.
  if (lanes[WARM_LANE] === undefined) lanes[WARM_LANE] = { priority: WARM_LANE_PRIORITY };

  // A hold is read off the backend's own busy signal and only means something on hardware others wait for.
  for (const b of backends) {
    if (b.hold === null) continue;
    const at = `backends.${b.name}.hold`;
    if (b.activity === null) throw bad(at, `needs backends.${b.name}.activity: the path that says whether the app is in use`);
    if (!b.resources.some((r) => !resourceDecls[r]?.shared)) {
      throw bad(at, `needs an exclusive resource on backends.${b.name}.resources: there is nothing to hold`);
    }
    for (const l of b.hold.lanes) {
      if (!(l in lanes)) throw bad(`${at}.lanes`, `names "${l}", which is not in scheduler.lanes (${Object.keys(lanes).join(", ")})`);
    }
    // Only a declared id says which backend loads the seat; a discovered one could be anybody's.
    if (b.hold.seat !== null && !backends.some((o) => o.serves.includes(b.hold!.seat!))) {
      throw bad(`${at}.seat`, `is "${b.hold.seat}", which no backend declares in serves: name the swapper's id for this app`);
    }
  }

  // Route defaults need the lanes: the lowest-priority lane, since a named path is usually the heavy work.
  const fallbackLane = Object.entries(lanes)
    .filter(([n]) => n !== WARM_LANE)
    .sort((a, b) => b[1].priority - a[1].priority)[0]![0];
  const claimedPaths = new Map<string, string>();
  for (const b of backends) {
    for (const [ri, r] of b.routes.entries()) {
      if (r.lane === "") r.lane = fallbackLane;
      else if (!(r.lane in lanes)) {
        throw bad(`backends.${b.name}.routes[${ri}].lane`, `names lane "${r.lane}", which is not in scheduler.lanes`);
      }
      // Reported under the backend's name, except {model} routes, which take the id from the request.
      if (r.model === "" && !r.path.includes("{model}")) r.model = b.name;
      // A path resolves to exactly one backend, the same way a model id does.
      // Two backends claiming it is someone meaning two different things by one
      // URL, and picking either silently is worse than saying so.
      const owner = claimedPaths.get(r.path);
      if (owner) {
        throw new ConfigError(
          "backends",
          `backends "${owner}" and "${b.name}" both declare the route ${r.path} — ` +
            `one path cannot mean two backends`,
        );
      }
      claimedPaths.set(r.path, b.name);
      if (r.fallback) {
        if (!r.queue) {
          throw new ConfigError("backends", `backends "${b.name}" route ${r.path} has a fallback but queue: false — only queued work falls back`);
        }
        if (r.fallback.backend === b.name || !backendNames.has(r.fallback.backend)) {
          throw new ConfigError(
            "backends",
            `backends "${b.name}" route ${r.path} falls back to "${r.fallback.backend}", which is not another backend`,
          );
        }
      }
    }
  }

  // One entry per friend: url and token to borrow from it, accept to lend to it, either or both.
  const peers: PeerConfig[] = [];
  const peerTokens: Record<string, string> = {};
  for (const [name, p] of Object.entries(asRecord(root.peers ?? {}, "peers"))) {
    const at = `peers.${name}`;
    const entry = asRecord(p, at);
    only(entry, "peer", at);
    if (entry.accept !== undefined) peerTokens[name] = resolveSecret(str(entry.accept, `${at}.accept`), `${at}.accept`);
    if (entry.url === undefined) {
      if (entry.accept === undefined) throw bad(at, "needs url (to borrow from it) or accept (to lend to it)");
      for (const k of ["token", "models"]) {
        if (entry[k] !== undefined) throw bad(`${at}.${k}`, `is only used to borrow from ${name}, which needs its url`);
      }
      continue;
    }
    const map: Record<string, string> = {};
    for (const [mine, theirs] of Object.entries(asRecord(entry.models ?? {}, `${at}.models`))) {
      map[mine] = str(theirs, `${at}.models.${mine}`);
      if (map[mine] === "") throw bad(`${at}.models.${mine}`, "is empty: name the peer's id for it");
    }
    peers.push({
      name,
      url: trimUrl(str(entry.url, `${at}.url`), `${at}.url`),
      token: resolveSecret(str(entry.token, `${at}.token`), `${at}.token`),
      models: map,
    });
  }
  const names = new Set(peers.map((p) => p.name));

  const models: Record<string, ModelRoute> = {};
  const modelsRaw = root.models === undefined ? {} : asRecord(root.models, "models");
  const notes: Record<string, string> = {};
  for (const [id, v] of Object.entries(modelsRaw)) {
    const entry = asRecord(v, `models.${id}`);
    only(entry, "model", `models.${id}`);
    if (entry.note !== undefined) {
      const note = str(entry.note, `models.${id}.note`).trim();
      if (note.length > NOTE_MAX) throw bad(`models.${id}.note`, `is ${note.length} characters -- keep it under ${NOTE_MAX}`);
      if (note !== "") notes[id] = note;
    }
    // A note alone describes a model; it is not a route.
    if (entry.note !== undefined && Object.keys(entry).length === 1) continue;
    const policy = str(entry.policy, `models.${id}.policy`, "local") as RoutePolicy;
    if (!["local", "peer", "spillover", "fastest"].includes(policy)) {
      throw bad(`models.${id}.policy`, `is "${policy}" — expected local, peer, spillover or fastest`);
    }
    const named = strList(entry.peers, `models.${id}.peers`);
    for (const n of named) {
      if (!names.has(n)) {
        throw bad(`models.${id}.peers`, `names "${n}", which is not a peer you borrow from (one with a url)`);
      }
    }
    // Catching it here instead of at request time is the reason this validation
    // exists at all. A policy that can never fire is a typo.
    if (policy !== "local") {
      if (peersMapping(id, named, peers).length === 0) {
        throw bad(
          `models.${id}.policy`, `is "${policy}" but no peer maps "${id}" — ` +
            `add it to a peer's models mapping, or set policy: local`,
        );
      }
    }
    const pinned = str(entry.backend, `models.${id}.backend`, "");
    if (pinned !== "" && !backendNames.has(pinned)) {
      throw bad(
        `models.${id}.backend`, `is "${pinned}", which is not a configured backend ` +
          `(${[...backendNames].join(", ")})`,
      );
    }
    const alias = str(entry.as, `models.${id}.as`, "");
    const follow = bool(entry.follow, `models.${id}.follow`, false);
    if (follow && pinned === "") {
      throw bad(`models.${id}.follow`, `needs models.${id}.backend: the backend whose resident model it follows`);
    }
    if (follow && alias === "") {
      throw bad(`models.${id}.follow`, `needs models.${id}.as: the model to load when nothing is resident`);
    }
    const params = modelParams(entry.params, id);
    const emulate = str(entry.emulate, `models.${id}.emulate`, "");
    if (emulate !== "" && !(EMULATIONS as readonly string[]).includes(emulate)) {
      throw bad(`models.${id}.emulate`, `is "${emulate}"; known: ${EMULATIONS.join(", ")}`);
    }
    const whenHeld = str(entry.whenHeld, `models.${id}.whenHeld`, "");
    const lane = str(entry.lane, `models.${id}.lane`, "");
    if (lane !== "" && !(lane in lanes)) {
      throw bad(
        `models.${id}.lane`, `is "${lane}", which is not in scheduler.lanes (${Object.keys(lanes).join(", ")})`,
      );
    }
    // `as` applies only on the way to a local backend and a peer dispatch uses the peer's map, so both may be set.
    models[id] = {
      backend: pinned === "" ? null : pinned,
      as: alias === "" ? null : alias,
      follow,
      policy,
      peers: named,
      spilloverAt: count(entry.spilloverAt, `models.${id}.spilloverAt`, 1, 1),
      fallbackLocal: bool(entry.fallbackLocal, `models.${id}.fallbackLocal`, true),
      concurrency: modelConcurrency(entry, id),
      params,
      lane: lane === "" ? null : lane,
      whenHeld: whenHeld === "" ? null : whenHeld,
      stats: declaredStats(entry.stats, id),
      emulate: emulate === "" ? null : (emulate as Emulation),
      pool: modelPool(entry.pool, id),
    };
    if (entry.shareAfterMs !== undefined) {
      models[id].shareAfterMs = count(entry.shareAfterMs, `models.${id}.shareAfterMs`, 0, 0);
    }
    if (entry.videoTokens !== undefined) {
      models[id].videoTokens = count(entry.videoTokens, `models.${id}.videoTokens`, 1);
    }
  }

  // Checked once every model is known: a target that is itself redirected would make the answer depend on order.
  for (const [id, route] of Object.entries(models)) {
    if (route.whenHeld === null) continue;
    const to = models[route.whenHeld];
    if (route.whenHeld === id || to === undefined) {
      throw bad(`models.${id}.whenHeld`, `is "${route.whenHeld}", which is not another id under models:`);
    }
    if (to.whenHeld !== null) {
      throw bad(`models.${id}.whenHeld`, `names "${route.whenHeld}", which has a whenHeld of its own -- name the id the request should end up on`);
    }
  }

  const { keys: apiKeys, labels: apiKeyLabels, models: apiKeyModels } =
    apiKeyList(root.apiKeys, "apiKeys", new Set(Object.keys(models)));

  const mainListen = {
    // Loopback by default. Anyone who wants it on the network says so, and
    // knows they said it.
    host: str(listen.host, "listen.host", "127.0.0.1"),
    port: count(listen.port, "listen.port", 4141, 1),
  };

  // The password is a hash, never a secret in the file: `set-operator` computes it and
  // the file holds only the salt:hash pair, which verifies and reveals nothing.
  let operator: { user: string; passHash: string } | null = null;
  if (root.operator !== undefined && root.operator !== null) {
    const e = asRecord(root.operator, "operator");
    only(e, "operator", "operator");
    const user = str(e.user, "operator.user").trim();
    if (user === "") throw bad("operator.user", "must not be empty");
    const passHash = str(e.passHash, "operator.passHash");
    // 16-byte salt and 64-byte scrypt, both hex: the shape `set-operator` prints.
    if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(passHash))
      throw bad("operator.passHash", "must be the salt:hash printed by `hearth set-operator`");
    operator = { user, passHash };
  }

  // A removed key is refused, not ignored: ignoring it would close the page's port with no word why.
  return {
    name: str(root.name, "name", "hearth"),
    // Set by loadConfig, which is the only caller that knows one.
    configPath: null,
    stateFile: str(root.stateFile, "stateFile", "") || null,
    historyFile: str(root.historyFile, "historyFile", "") || null,
    listen: mainListen,
    resources: resourceDecls,
    backends,
    scheduler: {
      concurrency: defaultConcurrency,
      agePerSecond: atLeast(sched.agePerSecond, "scheduler.agePerSecond", 1),
      warmBonus: atLeast(sched.warmBonus, "scheduler.warmBonus", 40),
      lanes,
      maxPerLane: count(sched.maxPerLane, "scheduler.maxPerLane", 100, 1),
      // Off when callers are indistinguishable. See the field docs.
      maxPerCaller: num(sched.maxPerCaller, "scheduler.maxPerCaller", apiKeys.length > 0 ? 2 : 0),
    },
    apiKeys,
    apiKeyLabels,
    apiKeyModels,
    peerTokens,
    operator,
    share: strList(lending.models, "lending.models"),
    notes,
    peerRateLimit: count(lending.rateLimit, "lending.rateLimit", 600, 1),
    peerLane: (() => {
      const named = str(lending.lane, "lending.lane", "");
      if (named !== "") {
        if (!(named in lanes)) {
          throw bad(
            "lending.lane", `is "${named}", which is not one of your lanes (${Object.keys(lanes).join(", ")})`,
          );
        }
        return named;
      }
      // The lowest-priority lane, excluding warm, which is reserved for speculative preloading.
      const eligible = Object.entries(lanes).filter(([n]) => n !== WARM_LANE);
      const pick = eligible.length > 0 ? eligible : Object.entries(lanes);
      return pick.sort((a, b) => b[1].priority - a[1].priority)[0]![0];
    })(),
    peerMaxConcurrent: count(lending.maxConcurrent, "lending.maxConcurrent", 2, 1),
    maxBodyBytes: count(root.maxBodyBytes, "maxBodyBytes", 32 * 1024 * 1024, 1024),
    peers,
    models,
    canary: canaryDecl(root.canary, backends),
    peerFreshMs: count(borrowing.freshMs, "borrowing.freshMs", 4_000, 100),
    peerDownMs: count(borrowing.downMs, "borrowing.downMs", 30_000, 1000),
    // Slower than it used to be, since on-demand probing does the real work.
    peerPollMs: count(borrowing.pollMs, "borrowing.pollMs", 60_000, 1000),
    peerStaleMs: count(borrowing.staleMs, "borrowing.staleMs", 60_000, 1000),
    // Same family. A negative here quietly disabled the deadline, which looks
    // like working peer failover right up until a peer hangs.
    peerFirstByteMs: atLeast(borrowing.firstByteMs, "borrowing.firstByteMs", 180_000),
    backendFirstByteMs: atLeast(defaults.firstByteMs, "backendDefaults.firstByteMs", 900_000),
    backendIdleMs: atLeast(defaults.idleMs, "backendDefaults.idleMs", 600_000),
    coldPenalty: atLeast(borrowing.coldPenalty, "borrowing.coldPenalty", 2),
    // 30s covers a sidecar call, an embedding and most chat turns. A box whose
    // routes are minutes-long renders wants more, and its TimeoutStopSec too.
    shutdownGraceMs: atLeast(root.shutdownGraceMs, "shutdownGraceMs", 30_000),
  };
}

export function loadConfig(path: string): HearthConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(null, `cannot read config at ${path}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(null, `${path} is not valid YAML: ${String(e)}`);
  }
  const cfg = parseConfig(raw);
  cfg.configPath = path;
  return cfg;
}
