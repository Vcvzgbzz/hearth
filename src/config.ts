/** Config loading and validation: a typo fails at startup with an actionable line. Nothing leaves the machine unless configured to. */
import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { EMULATIONS, type Emulation } from "./emulate.js";
import { KINDS, type KindName } from "./kinds.js";
import { actionDecls, type Action } from "./actions.js";
import { FIELDS, nearest, SECTION_KEYS, type Scope } from "./fields.js";
import { v1Marker } from "./migrate.js";
import { known, NOTE_MAX, type ModelStats } from "./stats.js";

/** The shapes of flow a newly borrowed model can start as; see `routedFlow`. */
export type RoutePolicy = "local" | "peer" | "spillover" | "fastest";

/** Settings a model once routed by, each now a step of a flow. Refused, with the command that rewrites them. */
export const MOVED_TO_FLOWS = ["policy", "peers", "spilloverAt", "fallbackLocal", "whenHeld"] as const;

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

/** A machine on the local network that backends run on. It names where work goes; admission never reads it. */
export interface ServerDecl {
  host: string;
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
  /** The `servers` entry this backend runs on; null is the machine hearth is on. */
  server: string | null;
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
  /** The lanes kept waiting; a flow's `held` condition sends them somewhere else meanwhile. */
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

/**
 * What a flow step tests. Every condition present must hold. `warm`, `free` and `queuedUnder`
 * read the step's own target; the rest read the request and the node.
 */
export interface FlowWhen {
  images?: boolean;
  tools?: boolean;
  /** Estimated prompt plus reserved output, strictly over or under. */
  tokensOver?: number;
  tokensUnder?: number;
  /** The id the client asked for, when several enter one flow. */
  asked?: string[];
  /** An api key's label, or `local` for loopback without a key. */
  caller?: string[];
  lane?: string[];
  /** One of these ids has its hardware held against the request's lane; see HoldDecl. */
  held?: string[];
  /** None of these peers can take the request: down, not lending the id, or too small for it. */
  down?: string[];
  /**
   * `model` has had no work here for at least `ms`: nothing queued or running now, and nothing
   * finished more recently. A null `model` reads the step's own target.
   */
  idle?: { model: string | null; ms: number };
  warm?: boolean;
  free?: boolean;
  queuedUnder?: number;
  /**
   * Running it on the step's own target needs no swap: the model is loaded there, or nothing
   * else is loaded on its backend or on the exclusive hardware that backend uses.
   */
  ready?: boolean;
  /**
   * The variant the name was asked for with, after its last colon: `ImageGen:realism` is the
   * type `ImageGen` in its `realism` variant. A request with no variant matches none of these.
   */
  variant?: string[];
  /** The opposite of `asked`, `caller` and `lane`: none of these. */
  askedNot?: string[];
  callerNot?: string[];
  laneNot?: string[];
  /** The node's own clock is between these, `HH:MM` each; `from` later than `to` runs through midnight. */
  time?: { from: string; to: string };
}

/** Somewhere a request can run: here as `model`, or on `peer` as its id for `model` (null: the id asked for). */
export type FlowEnd = { model: string } | { peer: string; model: string | null };

/**
 * Where a step sends a request: to run, into another flow, to whichever of several would start
 * it soonest, nowhere, or here as the very id that was asked for.
 */
export type FlowTo = FlowEnd | { flow: string } | { fastest: FlowEnd[] } | { refuse: string } | { asked: true };

/** The input that stands for every name no other flow takes: the flow that has it decides what happens to those. */
export const ANY = "*";

/** One step of a flow: when its conditions hold and its target can take the request, the request goes there. */
export interface FlowStep {
  /** null always holds. */
  when: FlowWhen | null;
  to: FlowTo;
  /** The lane it queues in, over the target's own and the client's. */
  lane: string | null;
  /** Request fields stamped before the target model's own `params`. */
  params: Record<string, unknown> | null;
  /** Actions set off when this step decides, by their names under `actions:`. */
  do: string[];
  /** The most requests this step may have in flight at once; past it the step is passed over. */
  max?: number;
}

/**
 * `flows.<name>`: how requests for its `inputs` are routed. Steps are tried in order and the
 * first that holds wins; the last always can. Only what a client asked for enters a flow:
 * a step that names a model runs it as named.
 */
export interface Flow {
  inputs: string[];
  steps: FlowStep[];
  /** Switched off: requests for its inputs run as themselves. Another flow can still hand work to it. */
  off?: true;
  /** What it is for, in the operator's words. */
  note?: string;
  /**
   * The request paths this flow answers besides chat, each as a backend declares it under
   * `routes:`. A path with no name in it (`/generate`) is asked for by this flow's first input;
   * one with a `{model}` segment, or a model in its body, is asked for by the name it carries.
   */
  takes?: string[];
  /**
   * How long a conversation stays where this flow first sent it, in ms. A later turn of the same
   * conversation goes there again while it can take it, whatever the steps would say now.
   */
  sticky?: number;
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
  /** Other machines on the local network, by name. Empty when every backend is addressed by `url`. */
  servers: Record<string, ServerDecl>;
  /** The file this config was loaded from, or null when built in memory (which cannot be saved). */
  configPath: string | null;
  /**
   * A sidecar for runtime changes when the config file cannot be written (a read-only mount);
   * null otherwise. Under `ProtectSystem=strict` pair it with `StateDirectory=hearth`.
   */
  stateFile: string | null;
  /** Where the console's day of history and recent logs survive a restart; null keeps them in memory. */
  historyFile: string | null;
  /** How requests are routed, by flow name. Ids no flow takes as an input run where they are served. */
  flows: Record<string, Flow>;
  /** Rulebooks besides `flows`, by name. */
  routers: Record<string, Router>;
  /** Which rulebook a caller goes by: a router's name, or `default` for `flows`. `*` is everyone not named. */
  callers: Record<string, string>;
  /** Whether a chat answer carries `x-hearth-model`, the id it ran as. */
  modelHeader: boolean;
  /** `actions:`: what a flow step can set off beside routing, by name. */
  actions: Record<string, Action>;
  /** Where the console draws a topology node the operator has placed, by node id; the rest are laid out. */
  layout: Record<string, { x: number; y: number }>;
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

export function bad(path: string | null, text: string): ConfigError {
  return new ConfigError(path, path !== null && !text.startsWith(path) ? `${path} ${text}` : text);
}

/** Refuse a key this place does not take: a typo would otherwise load as the default, silently. */
export function only(rec: Record<string, unknown>, allowed: Scope | readonly string[], where: string): void {
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
export function resolveSecret(value: string, where: string): string {
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const got = process.env[name];
  if (!got) throw bad(where, `${where}: environment variable ${name} is not set`);
  return got;
}

export function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw bad(where, "must be a mapping");
  }
  return v as Record<string, unknown>;
}

export function str(v: unknown, where: string, fallback?: string): string {
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
/** `layout:`: a position per topology node id. Ids that no longer exist are kept and ignored. */
function layoutDecl(raw: unknown): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, v] of Object.entries(asRecord(raw ?? {}, "layout"))) {
    const at = asRecord(v, `layout.${id}`);
    only(at, ["x", "y"], `layout.${id}`);
    out[id] = { x: num(at.x, `layout.${id}.x`, 0), y: num(at.y, `layout.${id}.y`, 0) };
  }
  return out;
}

const WHEN_KEYS = ["images", "tools", "tokensOver", "tokensUnder", "variant", "asked", "askedNot", "caller", "callerNot", "lane", "laneNot", "time", "held", "down", "idle", "warm", "free", "queuedUnder", "ready"] as const;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A step's `to`: a bare id runs it here; a map says a peer, another flow, the fastest of several, or a refusal. */
function flowTo(raw: unknown, at: string): FlowTo {
  if (typeof raw === "string" && raw.trim() !== "") return { model: raw.trim() };
  const o = asRecord(raw, at);
  only(o, ["model", "peer", "flow", "fastest", "refuse", "asked"], at);
  const said = ["peer", "flow", "fastest", "refuse", "asked"].filter((k) => o[k] !== undefined);
  if (said.length > 1 || (said.length === 1 && said[0] !== "peer" && o.model !== undefined)) {
    throw bad(at, "must say one thing: a model, a peer, a flow, fastest, refuse or asked");
  }
  if (o.asked !== undefined) {
    if (o.asked !== true) throw bad(`${at}.asked`, "must be true: run it here as the id that was asked for");
    return { asked: true };
  }
  if (o.refuse !== undefined) return { refuse: str(o.refuse, `${at}.refuse`) };
  if (o.flow !== undefined) return { flow: str(o.flow, `${at}.flow`) };
  if (o.fastest !== undefined) {
    if (!Array.isArray(o.fastest) || o.fastest.length < 2) throw bad(`${at}.fastest`, "must list at least two places to choose between");
    return {
      fastest: o.fastest.map((e, i) => {
        const end = flowTo(e, `${at}.fastest[${i}]`);
        if ("flow" in end || "fastest" in end || "refuse" in end || "asked" in end) throw bad(`${at}.fastest[${i}]`, "must be a model or a peer");
        return end;
      }),
    };
  }
  if (o.peer !== undefined) return { peer: str(o.peer, `${at}.peer`), model: o.model === undefined ? null : str(o.model, `${at}.model`) };
  return { model: str(o.model, `${at}.model`) };
}

/** A flow as hearth.yaml writes it: the shortest form of each step, with nothing that is only a default. */
export function rawFlow(flow: Flow): Record<string, unknown> {
  const end = (e: FlowEnd): unknown => ("peer" in e ? (e.model === null ? { peer: e.peer } : { peer: e.peer, model: e.model }) : e.model);
  return {
    ...(flow.note !== undefined ? { note: flow.note } : {}),
    ...(flow.off ? { off: true } : {}),
    ...(flow.sticky !== undefined ? { sticky: flow.sticky } : {}),
    ...(flow.takes !== undefined ? { takes: [...flow.takes] } : {}),
    inputs: [...flow.inputs],
    steps: flow.steps.map((s) => ({
      ...(s.when !== null ? { when: s.when } : {}),
      to: "fastest" in s.to ? { fastest: s.to.fastest.map(end) } : "flow" in s.to || "refuse" in s.to || "asked" in s.to ? s.to : end(s.to),
      ...(s.max !== undefined ? { max: s.max } : {}),
      ...(s.lane !== null ? { lane: s.lane } : {}),
      ...(s.params !== null ? { params: s.params } : {}),
      ...(s.do.length > 0 ? { do: [...s.do] } : {}),
    })),
  };
}

/** The places a target can run a request: itself, or each of the several it chooses between. `asked` is the id in hand, for a target that runs "what was asked for". */
export function endsOf(to: FlowTo, asked?: string): FlowEnd[] {
  if ("fastest" in to) return to.fastest;
  if ("asked" in to) return asked === undefined ? [] : [{ model: asked }];
  return "flow" in to || "refuse" in to ? [] : [to];
}

/** Can this target be passed over when it cannot take the request? Only a peer can be down. */
const skippable = (to: FlowTo): boolean => "peer" in to || ("fastest" in to && to.fastest.every((e) => "peer" in e));

/** The name that stands for `flows:` where a caller is given a rulebook. */
export const DEFAULT_ROUTER = "default";

/**
 * `routers.<name>`: a rulebook used in place of `flows:` for the callers `callers:` gives it.
 * `strict` also switches off a backend route's own fallback for them, so a request runs where
 * its rule says or fails.
 */
export interface Router {
  strict: boolean;
  note?: string;
  flows: Record<string, Flow>;
}

/** `routers:`, each checked as `flows:` is. */
function routerDecls(raw: unknown, flows: (raw: unknown) => Record<string, Flow>): Record<string, Router> {
  const out: Record<string, Router> = {};
  for (const [name, v] of Object.entries(asRecord(raw ?? {}, "routers"))) {
    const at = `routers.${name}`;
    if (name === DEFAULT_ROUTER) throw bad(at, `is the name flows: goes by; give this router another`);
    const r = asRecord(v, at);
    only(r, ["strict", "note", "flows"], at);
    const own = flows(r.flows);
    if (!Object.values(own).some((f) => f.inputs.includes(ANY))) throw bad(`${at}.flows`, `needs a flow with inputs: ["${ANY}"], as flows: does, to say what happens to a name no other flow takes`);
    out[name] = { strict: bool(r.strict, `${at}.strict`, false), ...(typeof r.note === "string" && r.note ? { note: r.note } : {}), flows: own };
  }
  return out;
}

/** `callers:`: an api key's label, `local`, or `*` for everyone else, each to a router's name or `default`. */
function callerDecls(raw: unknown, routers: Record<string, Router>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [who, v] of Object.entries(asRecord(raw ?? {}, "callers"))) {
    if (typeof v !== "string" || (v !== DEFAULT_ROUTER && routers[v] === undefined)) throw bad(`callers.${who}`, `must be "${DEFAULT_ROUTER}" or a name under routers:`);
    out[who] = v;
  }
  return out;
}

/** Check a `flows:` section against a running config, as loading the file would. */
export function flowsFor(raw: unknown, cfg: HearthConfig, actions: Record<string, unknown> = cfg.actions): Record<string, Flow> {
  return flowDecls(raw, cfg.scheduler.lanes, cfg.peers, actions, cfg.backends.flatMap((b) => b.routes.map((r) => r.path)));
}

/**
 * A flow's `takes`: paths a backend declares. What arrives on one is not a chat request, so a step
 * cannot test what only chat has, nor send it to a peer, which is only ever sent chat.
 */
function takesOf(raw: unknown, at: string, steps: readonly FlowStep[], routed: readonly string[]): string[] {
  const paths = strList(typeof raw === "string" ? [raw] : raw, at);
  for (const p of paths) {
    if (!routed.includes(p)) throw bad(at, `names "${p}", which no backend declares under routes: (${routed.join(", ") || "none"})`);
  }
  steps.forEach((s, i) => {
    const chatOnly = (["images", "tools", "tokensOver", "tokensUnder"] as const).find((k) => s.when?.[k] !== undefined);
    if (chatOnly) throw bad(`${at.replace(/takes$/, `steps[${i}].when.${chatOnly}`)}`, "reads a chat request, and this flow takes paths that are not chat");
    if (endsOf(s.to).some((e) => "peer" in e)) throw bad(`${at.replace(/takes$/, `steps[${i}].to`)}`, "sends to a peer, and a peer is only ever sent chat: this flow takes paths that are not chat");
  });
  return paths;
}

/** `flows:`, checked whole: every name resolves, every flow ends in an answer, and none leads back to itself. */
function flowDecls(
  raw: unknown, lanes: Record<string, unknown>, peers: readonly PeerConfig[], actions: Record<string, unknown>, routed: readonly string[],
): Record<string, Flow> {
  const flows: Record<string, Flow> = {};
  const entry = new Map<string, string>();
  const inLanes = (l: string, where: string) => {
    if (!(l in lanes)) throw bad(where, `names lane "${l}", which is not in scheduler.lanes (${Object.keys(lanes).join(", ")})`);
  };
  for (const [name, v] of Object.entries(asRecord(raw ?? {}, "flows"))) {
    const at = `flows.${name}`;
    const decl = asRecord(v, at);
    only(decl, "flow", at);
    const inputs = strList(decl.inputs, `${at}.inputs`);
    for (const id of inputs) {
      const other = entry.get(id);
      if (other !== undefined) throw bad(`${at}.inputs`, `names "${id}", which already enters flows.${other}`);
      if (id === ANY && inputs.length > 1) throw bad(`${at}.inputs`, `lists "${ANY}" beside other names: the flow for every other name takes only "${ANY}"`);
      entry.set(id, name);
    }
    const rawSteps = decl.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw bad(`${at}.steps`, "must be a list of steps, the last one a bare `to:`");
    const steps = rawSteps.map((r, i): FlowStep => {
      const here = `${at}.steps[${i}]`;
      const step = asRecord(r, here);
      only(step, ["when", "to", "lane", "params", "do", "max"], here);
      if (step.to === undefined) throw bad(`${here}.to`, "is required");
      const to = flowTo(step.to, `${here}.to`);
      let when: FlowWhen | null = null;
      if (step.when !== undefined && step.when !== null) {
        const w = asRecord(step.when, `${here}.when`);
        only(w, WHEN_KEYS, `${here}.when`);
        when = {};
        for (const k of ["images", "tools", "warm", "free", "ready"] as const) if (w[k] !== undefined) when[k] = bool(w[k], `${here}.when.${k}`, false);
        for (const k of ["tokensOver", "tokensUnder", "queuedUnder"] as const) if (w[k] !== undefined) when[k] = count(w[k], `${here}.when.${k}`, 0, k === "tokensOver" ? 0 : 1);
        for (const k of ["variant", "asked", "askedNot", "caller", "callerNot", "lane", "laneNot", "held", "down"] as const) if (w[k] !== undefined) when[k] = strList(typeof w[k] === "string" ? [w[k]] : w[k], `${here}.when.${k}`);
        for (const l of [...(when.lane ?? []), ...(when.laneNot ?? [])]) inLanes(l, `${here}.when.lane`);
        for (const v of when.variant ?? []) if (v === "" || v.includes(":")) throw bad(`${here}.when.variant`, `names "${v}": a variant is a plain word, asked for as <name>:<variant>`);
        if (w.time !== undefined) {
          const time = asRecord(w.time, `${here}.when.time`);
          only(time, ["from", "to"], `${here}.when.time`);
          when.time = { from: str(time.from, `${here}.when.time.from`), to: str(time.to, `${here}.when.time.to`) };
          for (const k of ["from", "to"] as const) if (!CLOCK.test(when.time[k])) throw bad(`${here}.when.time.${k}`, "must be a time of day as HH:MM, like 22:00");
        }
        for (const p of when.down ?? []) if (!peers.some((x) => x.name === p)) throw bad(`${here}.when.down`, `names "${p}", which is not a peer you borrow from (one with a url)`);
        if (w.idle !== undefined) {
          const idle = asRecord(w.idle, `${here}.when.idle`);
          only(idle, ["model", "ms"], `${here}.when.idle`);
          when.idle = { model: idle.model === undefined ? null : str(idle.model, `${here}.when.idle.model`), ms: atLeast(idle.ms, `${here}.when.idle.ms`, 0, 0) };
          if (idle.ms === undefined) throw bad(`${here}.when.idle.ms`, "is required: how long it must have been idle, in ms");
        }
        const ownTarget = when.warm !== undefined || when.free !== undefined || when.queuedUnder !== undefined || when.ready !== undefined || when.idle?.model === null;
        if (ownTarget && !("model" in to)) {
          throw bad(`${here}.when`, "tests warm, free, queuedUnder, ready or idle, which read a model or a peer — this step goes somewhere else (give idle a model)");
        }
        if (Object.keys(when).length === 0) when = null;
      }
      const last = i === rawSteps.length - 1;
      const max = step.max === undefined ? undefined : count(step.max, `${here}.max`, 1);
      if (last && max !== undefined) throw bad(`${here}.max`, "cannot be set on the last step, which must always apply");
      if (last && (when !== null || skippable(to))) {
        throw bad(`${at}.steps`, "must end with a step that always applies: no `when`, and somewhere that can always answer (a model, a flow or refuse)");
      }
      if (!last && when === null && max === undefined && !skippable(to)) throw bad(here, "has no `when`, so the steps after it can never be reached");
      for (const end of "fastest" in to ? to.fastest : "peer" in to ? [to] : []) {
        if (!("peer" in end)) continue;
        const peer = peers.find((x) => x.name === end.peer);
        if (!peer) throw bad(`${here}.to`, `names peer "${end.peer}", which is not a peer you borrow from (one with a url)`);
        if (end.model === null && inputs.includes(ANY)) throw bad(`${here}.to`, `sends every other name to ${end.peer}: say which model with \`model:\`, since a peer maps ids one by one`);
        for (const id of end.model === null ? inputs : [end.model]) {
          if (peer.models[id] === undefined) throw bad(`${here}.to`, `sends "${id}" to ${end.peer}, which does not map it — add it to peers.${end.peer}.models`);
        }
      }
      const lane = str(step.lane, `${here}.lane`, "");
      if (lane !== "") inLanes(lane, `${here}.lane`);
      const doing = step.do === undefined ? [] : strList(typeof step.do === "string" ? [step.do] : step.do, `${here}.do`);
      for (const a of doing) if (!(a in actions)) throw bad(`${here}.do`, `names action "${a}", which is not under actions:`);
      return { when, to, lane: lane === "" ? null : lane, params: modelParams(step.params, name, `${here}.params`), do: doing, ...(max !== undefined ? { max } : {}) };
    });
    flows[name] = {
      inputs, steps,
      ...(bool(decl.off, `${at}.off`, false) ? { off: true as const } : {}),
      ...(str(decl.note, `${at}.note`, "") !== "" ? { note: str(decl.note, `${at}.note`) } : {}),
      ...(decl.sticky !== undefined ? { sticky: atLeast(decl.sticky, `${at}.sticky`, 0, 1000) } : {}),
      ...(decl.takes !== undefined ? { takes: takesOf(decl.takes, `${at}.takes`, steps, routed) } : {}),
    };
  }
  for (const [name, flow] of Object.entries(flows)) {
    flow.steps.forEach((step, i) => {
      if ("flow" in step.to && flows[step.to.flow] === undefined) {
        throw bad(`flows.${name}.steps[${i}].to`, `names flow "${step.to.flow}", which is not under flows:`);
      }
    });
    const walk = (at: string, seen: string[]): void => {
      for (const step of flows[at]!.steps) {
        if (!("flow" in step.to)) continue;
        if (step.to.flow === name) throw bad(`flows.${name}`, `leads back to itself: ${[...seen, at, name].join(" → ")}`);
        if (!seen.includes(step.to.flow)) walk(step.to.flow, [...seen, at]);
      }
    };
    walk(name, []);
  }
  return flows;
}

function modelParams(raw: unknown, id: string, where = `models.${id}.params`): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
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

/** A backend's address: its own `url`, else `http://<its server's host>:<port>`. */
function backendUrl(entry: Record<string, unknown>, at: string, host: string | null): string {
  if (entry.url !== undefined) {
    if (entry.port !== undefined) throw bad(`${at}.port`, "is set beside url — keep one: url already carries a port");
    return trimUrl(str(entry.url, `${at}.url`), `${at}.url`);
  }
  if (entry.port === undefined) throw bad(`${at}.url`, "is required, or set server and port");
  if (host === null) throw bad(`${at}.port`, "needs server: a port alone says nothing about which machine");
  const port = count(entry.port, `${at}.port`, 0, 1);
  // A bare IPv6 address takes brackets in a URL.
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
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

  const servers: Record<string, ServerDecl> = {};
  for (const [name, raw] of Object.entries(asRecord(root.servers ?? {}, "servers"))) {
    const at = `servers.${name}`;
    const entry = asRecord(raw, at);
    only(entry, "server", at);
    const host = str(entry.host, `${at}.host`).trim();
    if (host === "" || /[\s/]/.test(host)) {
      throw bad(`${at}.host`, `must be an IP or hostname with no scheme, port or path (got ${JSON.stringify(host)})`);
    }
    servers[name] = { host };
  }

  const backends: BackendConfig[] = [];
  if (root.backends === undefined) throw bad("backends", "is required: name at least one server for hearth to front");
  for (const [name, b] of Object.entries(asRecord(root.backends, "backends"))) {
    const at = `backends.${name}`;
    const entry = asRecord(b, at);
    only(entry, "backend", at);
    const server = str(entry.server ?? "", `${at}.server`) || null;
    if (server !== null && servers[server] === undefined) {
      throw bad(`${at}.server`, `names "${server}", which is not in servers`);
    }
    backends.push({
      name,
      url: backendUrl(entry, at, server === null ? null : servers[server]!.host),
      server,
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
  // One card is in one machine: backends taking turns for it from two would arbitrate nothing real.
  const cardOn = new Map<string, BackendConfig>();
  for (const b of backends) {
    for (const r of b.resources) {
      if (resourceDecls[r]?.shared) continue;
      const first = cardOn.get(r);
      if (first === undefined) cardOn.set(r, b);
      else if (first.server !== b.server) {
        const on = (x: BackendConfig) => (x.server === null ? "this machine" : `server "${x.server}"`);
        throw new ConfigError(
          "backends",
          `backends "${first.name}" (${on(first)}) and "${b.name}" (${on(b)}) both use ${r} — ` +
            `hardware on two machines needs two names`,
        );
      }
    }
  }
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

  const models: Record<string, ModelRoute> = {};
  const modelsRaw = root.models === undefined ? {} : asRecord(root.models, "models");
  const notes: Record<string, string> = {};
  for (const [id, v] of Object.entries(modelsRaw)) {
    const entry = asRecord(v, `models.${id}`);
    for (const k of MOVED_TO_FLOWS) {
      if (entry[k] !== undefined) throw bad(`models.${id}.${k}`, "is routing, which now lives under flows: — run `hearth migrate` to rewrite this file, with a backup");
    }
    only(entry, "model", `models.${id}`);
    if (entry.note !== undefined) {
      const note = str(entry.note, `models.${id}.note`).trim();
      if (note.length > NOTE_MAX) throw bad(`models.${id}.note`, `is ${note.length} characters -- keep it under ${NOTE_MAX}`);
      if (note !== "") notes[id] = note;
    }
    // A note alone describes a model; it is not a route.
    if (entry.note !== undefined && Object.keys(entry).length === 1) continue;
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
      concurrency: modelConcurrency(entry, id),
      params,
      lane: lane === "" ? null : lane,
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

  const actions = actionDecls(root.actions);
  // A removed key is refused, not ignored: ignoring it would close the page's port with no word why.
  const routers = routerDecls(root.routers, (raw) => flowDecls(raw, lanes, peers, actions, backends.flatMap((b) => b.routes.map((r) => r.path))));
  return {
    name: str(root.name, "name", "hearth"),
    // Set by loadConfig, which is the only caller that knows one.
    configPath: null,
    stateFile: str(root.stateFile, "stateFile", "") || null,
    historyFile: str(root.historyFile, "historyFile", "") || null,
    layout: layoutDecl(root.layout),
    modelHeader: bool(root.modelHeader, "modelHeader", true),
    flows: flowDecls(root.flows, lanes, peers, actions, backends.flatMap((b) => b.routes.map((r) => r.path))),
    routers,
    callers: callerDecls(root.callers, routers),
    actions,
    listen: mainListen,
    resources: resourceDecls,
    servers,
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
  // A file says what becomes of a name no flow takes, so that nothing is callable or refused by an oversight.
  if (!Object.values(cfg.flows).some((f) => f.inputs.includes(ANY))) {
    throw new ConfigError("flows", `flows: needs a flow with inputs: ["${ANY}"], which says what happens to a name no other flow takes — \`to: { asked: true }\` runs it as itself, \`to: { refuse: "..." }\` turns it away. \`hearth migrate\` adds one that runs them as themselves`);
  }
  cfg.configPath = path;
  return cfg;
}
