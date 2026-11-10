/**
 * Backends: where each one is, what it speaks, what it serves, and the paths it queues.
 */
import { KIND_SPECS, type KindName } from "./kinds.js";
import { asRecord, atLeast, bad, bool, ConfigError, count, num, only, str, strList, trimUrl } from "./read.js";

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
  /** Sent to this backend as `Authorization: Bearer` on every call, in place of anything the client sent. null sends none. */
  key: string | null;
  /** Sent to this backend on every call beside its key, for an API that asks for more than one. */
  headers: Record<string, string>;
  /**
   * Someone else's server, reached over the internet: it has no hardware here and no warm state,
   * and serves only what `serves` names. A request sent to it leaves this machine and this network.
   */
  cloud: boolean;
  /** The API it speaks: OpenAI's chat completions, or Anthropic's Messages, which requests and answers are rewritten for. */
  format: BackendFormat;
  /** With `format: anthropic`: mark each request's system prompt, tools and conversation so far for the provider's prompt cache. */
  promptCache: boolean;
  /** With `promptCache`: how long the provider keeps a prefix after its last use. */
  promptCacheTtl: CacheTtl;
}

export const BACKEND_FORMATS = ["openai", "anthropic"] as const;

export type BackendFormat = (typeof BACKEND_FORMATS)[number];

/** How long a provider keeps a cached prefix after its last use. The longer one costs more to write. */
export const CACHE_TTLS = ["5m", "1h"] as const;

export type CacheTtl = (typeof CACHE_TTLS)[number];

/**
 * What a backend is sent to say who is calling: its key in the header its API reads, for Messages
 * the version, and its own `headers`, none of which stands in for the key's.
 */
export function backendAuth(format: BackendFormat, key: string | null, headers: Record<string, string> = {}): Record<string, string> {
  const more = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  if (format === "anthropic") return { ...more, "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) };
  return { ...more, ...(key ? { authorization: `Bearer ${key}` } : {}) };
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
 * `models.<id>.params`: flat request fields to stamp. `model`, `messages`, `stream` and `lane`
 * are refused, since stamping them breaks the request.
 */
/** `layout:`: a position per topology node id. Ids that no longer exist are kept and ignored. */
export function layoutDecl(raw: unknown): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, v] of Object.entries(asRecord(raw ?? {}, "layout"))) {
    const at = asRecord(v, `layout.${id}`);
    only(at, ["x", "y"], `layout.${id}`);
    out[id] = { x: num(at.x, `layout.${id}.x`, 0), y: num(at.y, `layout.${id}.y`, 0) };
  }
  return out;
}

const WARM_SOURCES = Object.keys(KIND_SPECS) as WarmSource[];

/** A backend's `kind`, defaulting to llama-swap. */
export function warmSource(entry: Record<string, unknown>, where: string): WarmSource {
  // A provider's servers are not ours to ask what is loaded.
  const kind = str(entry.kind, `${where}.kind`, entry.cloud === true ? "none" : "llama-swap");
  if (!WARM_SOURCES.includes(kind as WarmSource)) {
    throw bad(`${where}.kind`, `is "${kind}" — expected ${WARM_SOURCES.join(", ")}`);
  }
  return kind as WarmSource;
}

/** `promptCacheTtl: 1h`. */
export function cacheTtl(v: unknown, where: string): CacheTtl {
  const ttl = str(v, where, "5m");
  if (!CACHE_TTLS.includes(ttl as CacheTtl)) throw bad(where, `is "${ttl}" — expected ${CACHE_TTLS.join(" or ")}`);
  return ttl as CacheTtl;
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
export function activityDecl(v: unknown, where: string): ActivityDecl | null {
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
export function residentDecl(v: unknown, where: string): ResidentDecl | null {
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
export function holdDecl(v: unknown, where: string): HoldDecl | null {
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
export function routeList(v: unknown, where: string): RouteRule[] {
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

/** A backend's base url as given, without the `/v1` every call adds: a provider's is usually copied with it. */
export const backendBase = (url: string, where: string): string => trimUrl(url, where).replace(/\/v1$/, "");

/** A backend's address: its own `url`, else `http://<its server's host>:<port>`. */
export function backendUrl(entry: Record<string, unknown>, at: string, host: string | null): string {
  if (entry.url !== undefined) {
    if (entry.port !== undefined) throw bad(`${at}.port`, "is set beside url — keep one: url already carries a port");
    return backendBase(str(entry.url, `${at}.url`), `${at}.url`);
  }
  if (entry.port === undefined) throw bad(`${at}.url`, "is required, or set server and port");
  if (host === null) throw bad(`${at}.port`, "needs server: a port alone says nothing about which machine");
  const port = count(entry.port, `${at}.port`, 0, 1);
  // A bare IPv6 address takes brackets in a URL.
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}
