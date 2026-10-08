/** Config loading and validation: a typo fails at startup with an actionable line. Nothing leaves the machine unless configured to. */
import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { EMULATIONS, type Emulation } from "./emulate.js";
import { KINDS, type KindName } from "./kinds.js";
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
 * Whether the standalone status listener also serves the write routes: "off" (page only), or
 * "key", behind the same apiKey gate as the main listener. The socket alone never grants authority.
 */
export type UiControl = "off" | "key";

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
  /** Where warm state comes from. `llamaSwapExtras: true/false` is the old
   *  spelling of `llama-swap`/`none` and still works. */
  kind: WarmSource;
  /**
   * The model ids this backend serves, instead of discovering them from /v1/models. Also an
   * allowlist; declare them for a server that reports a file path as its id.
   */
  serves: string[];
  /** Jobs allowed on this backend at once; defaults to scheduler.concurrency. */
  concurrency: number;
  /**
   * How long to wait for this backend's first byte, in ms; 0 waits forever. Defaults to
   * `backendFirstByteMs`. Size it for the slowest honest reply behind this port.
   */
  firstByteMs: number | null;
  /** How long this backend may go silent mid-answer, in ms; 0 waits forever. Defaults to `backendIdleMs`. */
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
}

/**
 * A small always-loaded service that shares a card rather than taking turns on it: its own
 * requests never wait for the card or evict anyone, and before any other backend's turn on
 * that card hearth POSTs `yield` (`{"seconds": n}`), then `resume` once the card is free again.
 */
export interface ResidentDecl {
  yield: string;
  resume: string;
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
  /** What this model can take when nothing can be asked; observed values win field by field. */
  stats: ModelStats | null;
  /** Reshapes this id's backend answers into another server's format; see emulate.ts. */
  emulate: Emulation | null;
  /** Tokens the model's running requests share (vLLM's KV cache, llama.cpp `--kv-unified`); `output` caps each request's counted `max_tokens`, null counts it whole. */
  pool: { tokens: number; output: number | null } | null;
  /**
   * Jobs this model may run at once locally, overriding the backend's `concurrency` either way:
   * vLLM's --max-num-seqs above it, llama.cpp's --parallel below it. A raise applies only while
   * this model is the only one running. `batch:` is the older name.
   */
  concurrency: number | null;
  /** Tokens one video costs this model when sizing a request; unset uses the flat default. */
  videoTokens?: number;
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
    lanes: Record<string, { priority: number; concurrency?: number }>;
    /** How long one lane's queue may get before we start refusing. Someone told
     *  "full" can retry. Someone queued behind 400 jobs just waits. */
    maxPerLane: number;
    /** Cap per caller per lane; 0 turns it off. Defaults to 0 without apiKeys, where every caller is one. */
    maxPerCaller: number;
  };
  /**
   * A second listener serving only `/ui` and `/ui/data`, or null. Whoever reaches it can read
   * the queue and callers, so bind it to a tailnet address with an ACL, not a LAN.
   */
  uiListen: { host: string; port: number; control: UiControl } | null;
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
  /** Tokens peers present to us, by peer name. Kept separate from apiKeys so
   *  peer traffic is attributable and can be capped on its own. */
  peerTokens: Record<string, string>;
  /**
   * The operator login: a username and the scrypt hash of its password, as printed by
   * `hearth set-operator`. Null means the console has no login form and no session can
   * exist — the address and the keys are the only doors in.
   */
  operator: { user: string; passHash: string } | null;
  /** Models we'll serve to peers. Empty means none, since lending is opt-in. */
  share: string[];
  /** What each model is for, shown to peers beside it. */
  notes?: Record<string, string>;
  /** Requests per hour one peer may send us. */
  peerRateLimit: number;
  /** The lane borrowed work lands in, whatever the peer asks; defaults to the lowest-priority one. */
  peerLane: string;
  /** Jobs one peer may have queued or running at once, whether or not apiKeys are set. */
  peerMaxConcurrent: number;
  /** Biggest request body we'll take. Multi-image vision payloads get close to
   *  the old hardcoded 32MB, so it's a knob now instead of a constant. */
  maxBodyBytes: number;
  peers: PeerConfig[];
  models: Record<string, ModelRoute>;
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
 * A validation finding. `path` is the field it is about (e.g. `backends[0].kind`),
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

/** A model's own slot count from `concurrency` or the older `batch`; both at once must agree. */
function modelConcurrency(entry: Record<string, unknown>, id: string): number | null {
  const has = (k: string) => entry[k] !== undefined && entry[k] !== null;
  if (has("concurrency") && has("batch") && entry.concurrency !== entry.batch) {
    throw bad(
      `models.${id}`, `sets both concurrency and batch, which are the same setting ` +
        `(${String(entry.concurrency)} vs ${String(entry.batch)}) — keep concurrency`,
    );
  }
  const key = has("concurrency") ? "concurrency" : "batch";
  if (!has(key)) return null;
  return count(entry[key], `models.${id}.${key}`, 1, 1);
}

/** `pool: 144000`, or `pool: { tokens: 144000, output: 8192 }`. */
function modelPool(v: unknown, id: string): ModelRoute["pool"] {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return { tokens: count(v, `models.${id}.pool`, 1, 1), output: null };
  const p = asRecord(v, `models.${id}.pool`);
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

/** `kind`, or the `llamaSwapExtras` boolean it replaced; not both. */
function warmSource(entry: Record<string, unknown>, where: string): WarmSource {
  const kind = str(entry.kind, `${where}.kind`, "");
  const legacy = entry.llamaSwapExtras;
  if (kind !== "" && legacy !== undefined) {
    throw bad(
      where, `set kind or llamaSwapExtras, not both — ` +
        `llamaSwapExtras: ${String(legacy)} is the old spelling of kind: ${legacy === false ? "none" : "llama-swap"}`,
    );
  }
  if (kind !== "") {
    if (!WARM_SOURCES.includes(kind as WarmSource)) {
      throw bad(`${where}.kind`, `is "${kind}" — expected ${WARM_SOURCES.join(", ")}`);
    }
    return kind as WarmSource;
  }
  return bool(legacy, `${where}.llamaSwapExtras`, true) ? "llama-swap" : "none";
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
  const out = { yield: str(o.yield, `${where}.yield`, "/yield"), resume: str(o.resume, `${where}.resume`, "/resume") };
  requirePath(out.yield, `${where}.yield`);
  requirePath(out.resume, `${where}.resume`);
  return out;
}

/** `routes:` entries, as a bare path or an object; lane and model are filled in once lanes exist. */
function routeList(v: unknown, where: string): RouteRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(where, "must be a list");
  return v.map((raw, i) => {
    const at = `${where}[${i}]`;
    const entry = typeof raw === "string" ? { path: raw } : asRecord(raw, at);
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
    };
  });
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

export function parseConfig(raw: unknown): HearthConfig {
  const root = asRecord(raw, "config");

  const listen = asRecord(root.listen ?? {}, "listen");
  const sched = asRecord(root.scheduler ?? {}, "scheduler");
  const defaultConcurrency = count(sched.concurrency, "scheduler.concurrency", 1, 1);

  // `backend:` (one) and `backends:` (many). Both is a mistake worth naming,
  // since silently preferring one of them is how you end up fronting a server
  // you thought you had replaced.
  if (root.backend !== undefined && root.backends !== undefined) {
    throw new ConfigError(
      null,
      "set either backend: (one) or backends: (a list), not both — " +
        "`backend` is just shorthand for a list of one",
    );
  }

  /** Declared hardware, validated up front so --check catches a typo. */
  const resourceDecls: Record<string, ResourceDecl> = {};
  if (root.resources !== undefined) {
    const rd = asRecord(root.resources, "resources");
    for (const [name, raw] of Object.entries(rd)) {
      const at = `resources.${name}`;
      const entry = asRecord(raw ?? {}, at);
      const kind = str(entry.kind, `${at}.kind`, "gpu");
      if (kind !== "gpu" && kind !== "cpu" && kind !== "other") {
        throw bad(`${at}.kind`, `must be gpu, cpu or other (got ${JSON.stringify(kind)})`);
      }
      resourceDecls[name] = { kind, shared: bool(entry.shared, `${at}.shared`, false) };
    }
  }

  const backends: BackendConfig[] = [];
  if (root.backends !== undefined) {
    if (!Array.isArray(root.backends)) throw bad("backends", "must be a list");
    if (root.backends.length === 0) throw bad("backends", "must not be empty");
    for (const [i, b] of root.backends.entries()) {
      const entry = asRecord(b, `backends[${i}]`);
      backends.push({
        name: str(entry.name, `backends[${i}].name`),
        url: trimUrl(str(entry.url, `backends[${i}].url`), `backends[${i}].url`),
        kind: warmSource(entry, `backends[${i}]`),
        serves: strList(entry.serves, `backends[${i}].serves`),
        concurrency: count(entry.concurrency, `backends[${i}].concurrency`, defaultConcurrency, 1),
        firstByteMs: entry.firstByteMs === undefined
          ? null
          : atLeast(entry.firstByteMs, `backends[${i}].firstByteMs`, 0),
        idleMs: entry.idleMs === undefined
          ? null
          : atLeast(entry.idleMs, `backends[${i}].idleMs`, 0),
        resources: strList(entry.resources, `backends[${i}].resources`),
        routes: routeList(entry.routes, `backends[${i}].routes`),
        activity: activityDecl(entry.activity, `backends[${i}].activity`),
        resident: residentDecl(entry.resident, `backends[${i}].resident`),
      });
    }
    const seen = new Set<string>();
    for (const b of backends) {
      if (seen.has(b.name)) throw new ConfigError("backends", `two backends are both named "${b.name}"`);
      seen.add(b.name);
    }
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
  } else {
    const backend = asRecord(root.backend ?? {}, "backend");
    backends.push({
      // Named so status output and error messages have something to say, and so
      // a config that later grows a second backend does not have to rename the
      // first one.
      name: str(backend.name, "backend.name", "default"),
      url: trimUrl(str(backend.url, "backend.url"), "backend.url"),
      kind: warmSource(backend, "backend"),
      serves: strList(backend.serves, "backend.serves"),
      concurrency: count(backend.concurrency, "backend.concurrency", defaultConcurrency, 1),
      firstByteMs: backend.firstByteMs === undefined
        ? null
        : atLeast(backend.firstByteMs, "backend.firstByteMs", 0),
      idleMs: backend.idleMs === undefined
        ? null
        : atLeast(backend.idleMs, "backend.idleMs", 0),
      resources: strList(backend.resources, "backend.resources"),
      routes: routeList(backend.routes, "backend.routes"),
      activity: activityDecl(backend.activity, "backend.activity"),
      resident: residentDecl(backend.resident, "backend.resident"),
    });
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
  const lanes: Record<string, { priority: number; concurrency?: number }> = {};
  for (const [lane, v] of Object.entries(lanesRaw)) {
    const entry = asRecord(v, `scheduler.lanes.${lane}`);
    lanes[lane] = { priority: num(entry.priority, `scheduler.lanes.${lane}.priority`, 0) };
    // Left off when unset rather than defaulted: no number here means the lane has no ceiling of its own.
    if (entry.concurrency !== undefined) {
      lanes[lane].concurrency = count(entry.concurrency, `scheduler.lanes.${lane}.concurrency`, 1);
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

  // Route defaults need the lanes: the lowest-priority lane, since a named path is usually the heavy work.
  const fallbackLane = Object.entries(lanes)
    .filter(([n]) => n !== WARM_LANE)
    .sort((a, b) => b[1].priority - a[1].priority)[0]![0];
  const claimedPaths = new Map<string, string>();
  for (const [bi, b] of backends.entries()) {
    for (const [ri, r] of b.routes.entries()) {
      if (r.lane === "") r.lane = fallbackLane;
      else if (!(r.lane in lanes)) {
        throw bad(`backends[${bi}].routes[${ri}].lane`, `names lane "${r.lane}", which is not in scheduler.lanes`);
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
    }
  }

  const peers: PeerConfig[] = [];
  const peersRaw = root.peers === undefined ? [] : root.peers;
  if (!Array.isArray(peersRaw)) throw bad("peers", "must be a list");
  for (const [i, p] of peersRaw.entries()) {
    const entry = asRecord(p, `peers[${i}]`);
    const name = str(entry.name, `peers[${i}].name`);
    const models = asRecord(entry.models ?? {}, `peers[${i}].models`);
    const map: Record<string, string> = {};
    for (const [mine, theirs] of Object.entries(models)) {
      map[mine] = str(theirs, `peers[${i}].models.${mine}`);
      if (map[mine] === "") throw bad(`peers[${i}].models.${mine}`, "is empty: name the peer's id for it");
    }
    // A peer mapping nothing is valid: the state between trusting someone and borrowing from them.
    peers.push({
      name,
      url: trimUrl(str(entry.url, `peers[${i}].url`), `peers[${i}].url`),
      token: resolveSecret(str(entry.token, `peers[${i}].token`), `peers[${i}].token`),
      models: map,
    });
  }

  const names = new Set<string>();
  for (const p of peers) {
    if (names.has(p.name)) throw new ConfigError("peers", `two peers are both named "${p.name}"`);
    names.add(p.name);
  }

  const models: Record<string, ModelRoute> = {};
  const modelsRaw = root.models === undefined ? {} : asRecord(root.models, "models");
  for (const [id, v] of Object.entries(modelsRaw)) {
    const entry = asRecord(v, `models.${id}`);
    const policy = str(entry.policy, `models.${id}.policy`, "local") as RoutePolicy;
    if (!["local", "peer", "spillover", "fastest"].includes(policy)) {
      throw bad(`models.${id}.policy`, `is "${policy}" — expected local, peer, spillover or fastest`);
    }
    const named = strList(entry.peers, `models.${id}.peers`);
    for (const n of named) {
      if (!names.has(n)) {
        throw bad(`models.${id}.peers`, `names "${n}", which is not a configured peer`);
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
      stats: declaredStats(entry.stats, id),
      emulate: emulate === "" ? null : (emulate as Emulation),
      pool: modelPool(entry.pool, id),
    };
    if (entry.videoTokens !== undefined) {
      models[id].videoTokens = count(entry.videoTokens, `models.${id}.videoTokens`, 1);
    }
  }

  const { keys: apiKeys, labels: apiKeyLabels, models: apiKeyModels } =
    apiKeyList(root.apiKeys, "apiKeys", new Set(Object.keys(models)));

  const peerTokensRaw = asRecord(root.peerTokens ?? {}, "peerTokens");
  const peerTokens: Record<string, string> = {};
  for (const [name, v] of Object.entries(peerTokensRaw)) {
    peerTokens[name] = resolveSecret(str(v, `peerTokens.${name}`), `peerTokens.${name}`);
  }

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
    const user = str(e.user, "operator.user").trim();
    if (user === "") throw bad("operator.user", "must not be empty");
    const passHash = str(e.passHash, "operator.passHash");
    // 16-byte salt and 64-byte scrypt, both hex: the shape `set-operator` prints.
    if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(passHash))
      throw bad("operator.passHash", "must be the salt:hash printed by `hearth set-operator`");
    operator = { user, passHash };
  }

  let uiListen: { host: string; port: number; control: UiControl } | null = null;
  if (root.uiListen !== undefined && root.uiListen !== null) {
    const u = asRecord(root.uiListen, "uiListen");
    // `false` (default) serves the page only; `key` adds the write routes behind the apiKey gate.
    const rawControl = u.control ?? false;
    if (rawControl !== false && rawControl !== "key") {
      throw bad("uiListen.control", `must be false or "key" (got ${JSON.stringify(rawControl)})`);
    }
    const control: UiControl = rawControl === "key" ? "key" : "off";
    uiListen = {
      host: str(u.host, "uiListen.host", "127.0.0.1"),
      port: count(u.port, "uiListen.port", 4142, 1),
      control,
    };
    // Clickable controls with no apiKeys could only ever 401 off-loopback, so refuse at --check.
    if (control === "key" && apiKeys.length === 0) {
      throw bad(
        "uiListen.control", `key requires apiKeys — without one, writes on the status ` +
          `port fall back to loopback-only and every click from the LAN would be refused`,
      );
    }
    // Same socket twice is a listen() failure at startup with a errno nobody
    // reads. Say it here instead.
    if (uiListen.port === mainListen.port && uiListen.host === mainListen.host) {
      throw new ConfigError(
        "uiListen",
        `uiListen is the same address as listen (${uiListen.host}:${uiListen.port}) — ` +
          `give the status page its own port, or drop uiListen and reach it on the main one`,
      );
    }
  }

  return {
    name: str(root.name, "name", "hearth"),
    // Set by loadConfig, which is the only caller that knows one.
    configPath: null,
    stateFile: str(root.stateFile, "stateFile", "") || null,
    listen: mainListen,
    uiListen,
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
    share: strList(root.share, "share"),
    notes: (() => {
      const raw = root.notes === undefined ? {} : asRecord(root.notes, "notes");
      const out: Record<string, string> = {};
      for (const [id, v] of Object.entries(raw)) {
        const note = str(v, `notes.${id}`).trim();
        if (note.length > NOTE_MAX) {
          throw bad(`notes.${id}`, `is ${note.length} characters -- keep it under ${NOTE_MAX}`);
        }
        if (note !== "") out[id] = note;
      }
      return out;
    })(),
    peerRateLimit: count(root.peerRateLimit, "peerRateLimit", 600, 1),
    peerLane: (() => {
      const named = str(root.peerLane, "peerLane", "");
      if (named !== "") {
        if (!(named in lanes)) {
          throw bad(
            "peerLane", `is "${named}", which is not one of your lanes (${Object.keys(lanes).join(", ")})`,
          );
        }
        return named;
      }
      // The lowest-priority lane, excluding warm, which is reserved for speculative preloading.
      const eligible = Object.entries(lanes).filter(([n]) => n !== WARM_LANE);
      const pick = eligible.length > 0 ? eligible : Object.entries(lanes);
      return pick.sort((a, b) => b[1].priority - a[1].priority)[0]![0];
    })(),
    peerMaxConcurrent: count(root.peerMaxConcurrent, "peerMaxConcurrent", 2, 1),
    maxBodyBytes: count(root.maxBodyBytes, "maxBodyBytes", 32 * 1024 * 1024, 1024),
    peers,
    models,
    peerFreshMs: count(root.peerFreshMs, "peerFreshMs", 4_000, 100),
    peerDownMs: count(root.peerDownMs, "peerDownMs", 30_000, 1000),
    // Slower than it used to be, since on-demand probing does the real work.
    peerPollMs: count(root.peerPollMs, "peerPollMs", 60_000, 1000),
    peerStaleMs: count(root.peerStaleMs, "peerStaleMs", 60_000, 1000),
    // Same family. A negative here quietly disabled the deadline, which looks
    // like working peer failover right up until a peer hangs.
    peerFirstByteMs: atLeast(root.peerFirstByteMs, "peerFirstByteMs", 180_000),
    backendFirstByteMs: atLeast(root.backendFirstByteMs, "backendFirstByteMs", 900_000),
    backendIdleMs: atLeast(root.backendIdleMs, "backendIdleMs", 600_000),
    coldPenalty: atLeast(root.coldPenalty, "coldPenalty", 2),
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
