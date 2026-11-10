/** Config loading and validation: a typo fails at startup with an actionable line. Nothing leaves the machine unless configured to. */
import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { type Action, actionDecls } from "../routing/actions.js";
import { declaredStats, type Emulation, EMULATIONS, modelConcurrency, modelEfforts, modelParams, modelPool, modelPrice, type ModelRoute, NOTE_MAX } from "./models.js";
import { activityDecl, BACKEND_FORMATS, type BackendConfig, type BackendFormat, backendUrl, cacheTtl, holdDecl, layoutDecl, residentDecl, type ResourceDecl, routeList, type ServerDecl, warmSource } from "./backends.js";
import { type CanaryConfig, canaryDecl } from "./canary.js";
import { FIELDS, SECTION_KEYS } from "./fields.js";
import { KIND_SPECS } from "./kinds.js";
import { ANY, callerDecls, type Flow, flowDecls, MOVED_TO_FLOWS, type Router, routerDecls } from "./flows.js";
import { apiKeyList, type KeyRule, typeNames } from "./keys.js";
import { CONFIG_VERSION, v1Marker } from "./migrate.js";
import { lendTerms, type LendTerms, type ModelLimits, type PeerConfig } from "./peers.js";
import { type PluginDecl, pluginDecls, REQUEST_KINDS, type RequestKind } from "./plugins.js";
import { asRecord, atLeast, bad, bool, ConfigError, count, num, only, resolveSecret, str, strList, trimUrl } from "./read.js";

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
  /** Plugins by name, in the order they run within a stage. */
  plugins: Record<string, PluginDecl>;
  /** Whether a chat answer carries `x-hearth-model`, the id it ran as. */
  modelHeader: boolean;
  /** Ask the npm registry once a day whether a newer hearth is out, for the console to say so. */
  updateCheck: boolean;
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
  /** When each key stops working and how much it may use, index-aligned with `apiKeys`. */
  apiKeyRules: KeyRule[];
  /** Tokens peers present to us, by peer name (`peers.<name>.accept`). Kept separate from apiKeys so
   *  peer traffic is attributable and can be capped on its own. */
  peerTokens: Record<string, string>;
  /** The Tailscale stable node ID a peer's token is bound to (`peers.<name>.tailnet`), by peer name. */
  peerTailnet: Record<string, string>;
  /** tailscaled's local API socket, asked which machine a bound peer is calling from (`tailscaleSocket`). */
  tailscaleSocket: string;
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
  /** What kind of request each model takes, where `models.<id>.kind` says; unset is chat. A plugin's model slot takes only its kind. */
  modelKinds: Record<string, RequestKind>;
  /** Requests per hour one peer may send us (`lending.rateLimit`). */
  peerRateLimit: number;
  /** The lane borrowed work lands in, whatever the peer asks (`lending.lane`); defaults to the lowest-priority one. */
  peerLane: string;
  /** Jobs one peer may have queued or running at once (`lending.maxConcurrent`). */
  peerMaxConcurrent: number;
  /** Tokens one peer may run here in a UTC day (`lending.tokensPerDay`); 0 is no limit. */
  lendTokensPerDay: number;
  /** One peer's own terms (`peers.<name>.lend`), each laid over the `lending.*` setting it names. */
  peerTerms: Record<string, Partial<LendTerms>>;
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
  /** How long a backend is passed over, where a flow has another line that fits, after three failures in a row. 0 never passes one over. */
  backendRestMs: number;
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

/** The lane with the highest priority number, leaving out `warm`; the first declared wins a tie. */
export function lowestLane(lanes: Record<string, { priority: number }>): string {
  let best: string | null = null;
  let bestPriority = -Infinity;
  for (const [name, lane] of Object.entries(lanes)) {
    if (name === WARM_LANE) continue;
    if (lane.priority > bestPriority) {
      best = name;
      bestPriority = lane.priority;
    }
  }
  // A file may declare only `warm`, which is then the lane every request that names none lands in.
  return best ?? WARM_LANE;
}

/** Where a request that names no lane lands. */
export interface LaneDefaults {
  /** The first declared lane: what an empty flow step runs in. */
  first: string;
  /** `lending.lane`, else the lowest-priority lane. */
  peers: string;
  /** What a backend route that names no lane runs in: the lowest-priority lane. */
  routes: string;
}

/** Where a request that names no lane lands, read off a parsed config as a dry run would read it. */
export function laneDefaults(cfg: Pick<HearthConfig, "scheduler" | "peerLane">): LaneDefaults {
  return { first: Object.keys(cfg.scheduler.lanes)[0]!, peers: cfg.peerLane, routes: lowestLane(cfg.scheduler.lanes) };
}

export function parseConfig(raw: unknown): HearthConfig {
  const root = asRecord(raw, "config");
  if (root.version !== undefined) {
    const version = count(root.version, "version", CONFIG_VERSION, 1);
    if (version > CONFIG_VERSION) {
      throw bad("version", `is ${version}, a layout newer than this hearth reads (${CONFIG_VERSION}) — upgrade hearth, or restore the file an older one wrote`);
    }
    if (version < CONFIG_VERSION) throw bad("version", `is ${version}, an older layout — run \`hearth migrate\` to rewrite it; the original is kept beside it`);
  }
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
    const cloud = bool(entry.cloud, `${at}.cloud`, false);
    if (cloud) {
      if (str(entry.kind, `${at}.kind`, "none") !== "none") throw bad(`${at}.kind`, "must be none (or left out) on a cloud backend: its provider does not say what is loaded");
      if (strList(entry.resources, `${at}.resources`).length > 0) throw bad(`${at}.resources`, "names hardware, which a cloud backend does not use here");
      if (server !== null) throw bad(`${at}.server`, "is a machine on your network; a cloud backend takes a url");
      if (strList(entry.serves, `${at}.serves`).length === 0) throw bad(`${at}.serves`, "is required on a cloud backend: name the models to offer from it, as its provider names them or as `models.<id>.as` maps them");
    }
    const format = str(entry.format, `${at}.format`, "openai");
    if (!BACKEND_FORMATS.includes(format as BackendFormat)) throw bad(`${at}.format`, `is "${format}" — expected ${BACKEND_FORMATS.join(" or ")}`);
    backends.push({
      name,
      format: format as BackendFormat,
      promptCache: bool(entry.promptCache, `${at}.promptCache`, true),
      promptCacheTtl: cacheTtl(entry.promptCacheTtl, `${at}.promptCacheTtl`),
      key: entry.key === undefined ? null : resolveSecret(str(entry.key, `${at}.key`), `${at}.key`),
      headers: Object.fromEntries(Object.entries(asRecord(entry.headers ?? {}, `${at}.headers`))
        .map(([k, v]) => [k, resolveSecret(str(v, `${at}.headers.${k}`), `${at}.headers.${k}`)])),
      cloud,
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
    const k = KIND_SPECS[b.kind];
    if (b.resident || !k.knowsWarm || k.unloads) continue;
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
  const fallbackLane = lowestLane(lanes);
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
  const peerTerms: Record<string, Partial<LendTerms>> = {};
  const peerTailnet: Record<string, string> = {};
  for (const [name, p] of Object.entries(asRecord(root.peers ?? {}, "peers"))) {
    const at = `peers.${name}`;
    const entry = asRecord(p, at);
    only(entry, "peer", at);
    if (entry.accept !== undefined) peerTokens[name] = resolveSecret(str(entry.accept, `${at}.accept`), `${at}.accept`);
    // Empty is unset, as a freshly added setting is.
    const tailnet = str(entry.tailnet, `${at}.tailnet`, "").trim();
    if (tailnet !== "") {
      if (entry.accept === undefined) throw bad(`${at}.tailnet`, `binds the token ${name} presents to you, which needs its accept`);
      peerTailnet[name] = tailnet;
    }
    if (entry.lend !== undefined) {
      if (entry.accept === undefined) throw bad(`${at}.lend`, `is what ${name} may take from you, which needs its accept`);
      const lend = asRecord(entry.lend, `${at}.lend`);
      only(lend, "lend", `${at}.lend`);
      peerTerms[name] = lendTerms(lend, `${at}.lend`);
      if (lend.limits !== undefined) {
        const limits: Record<string, Partial<ModelLimits>> = {};
        for (const [model, l] of Object.entries(asRecord(lend.limits, `${at}.lend.limits`))) {
          const where = `${at}.lend.limits.${model}`;
          const rec = asRecord(l ?? {}, where);
          only(rec, "limit", where);
          limits[model] = lendTerms(rec, where);
        }
        if (Object.keys(limits).length > 0) peerTerms[name].limits = limits;
      }
      if (lend.off !== undefined) {
        if (typeof lend.off !== "boolean") throw bad(`${at}.lend.off`, "must be true or false");
        if (lend.off) peerTerms[name].off = true;
      }
    }
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
  const modelKinds: Record<string, RequestKind> = {};
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
    if (entry.kind !== undefined) {
      const kind = str(entry.kind, `models.${id}.kind`);
      if (!(REQUEST_KINDS as readonly string[]).includes(kind)) throw bad(`models.${id}.kind`, `is not a request kind (${REQUEST_KINDS.join(", ")})`);
      if (kind !== "chat") modelKinds[id] = kind as RequestKind;
    }
    // A note and a kind describe a model; alone they are not a route.
    if (Object.keys(entry).length > 0 && Object.keys(entry).every((k) => k === "note" || k === "kind")) continue;
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
      price: modelPrice(entry.price, id),
    };
    if (entry.shareAfterMs !== undefined) {
      models[id].shareAfterMs = count(entry.shareAfterMs, `models.${id}.shareAfterMs`, 0, 0);
    }
    if (entry.cacheMs !== undefined) {
      models[id].cacheMs = count(entry.cacheMs, `models.${id}.cacheMs`, 0, 0);
    }
    if (entry.videoTokens !== undefined) {
      models[id].videoTokens = count(entry.videoTokens, `models.${id}.videoTokens`, 1);
    }
    const efforts = modelEfforts(entry.efforts, id);
    if (efforts !== null) models[id].efforts = efforts;
  }

  // A provider answers for its own models, and every probe of one would be billed.
  const canary = canaryDecl(root.canary, backends);
  for (const name of Object.keys(canary?.backends ?? {})) {
    if (backends.find((b) => b.name === name)?.cloud) throw bad(`canary.backends.${name}`, "is a cloud backend: the canary does not probe a provider's models");
  }
  for (const id of Object.keys(canary?.models ?? {})) {
    const on = backends.find((b) => b.name === models[id]?.backend) ?? backends.find((b) => b.serves.includes(id));
    if (on?.cloud) throw bad(`canary.models.${id}`, `runs on the cloud backend "${on.name}": the canary does not probe a provider's models`);
  }

  // A provider's model is not ours to lend: a peer's requests would be paid for with this node's key.
  const lent = strList(lending.models, "lending.models");
  for (const [at, ids] of [["lending.models", lent], ...Object.entries(peerTerms).map(([name, t]) => [`peers.${name}.lend.models`, t.models ?? []])] as [string, readonly string[]][]) {
    for (const id of ids) {
      const on = backends.find((b) => b.name === models[id]?.backend) ?? backends.find((b) => b.serves.includes(id));
      if (on?.cloud) throw bad(at, `names "${id}", which runs on the cloud backend "${on.name}": lending it would spend that provider's key on a peer's requests`);
    }
  }

  const { keys: apiKeys, labels: apiKeyLabels, models: apiKeyModels, rules: apiKeyRules } =
    apiKeyList(root.apiKeys, "apiKeys", new Set([...Object.keys(models), ...typeNames(root)]), Object.keys(lanes).filter((l) => l !== WARM_LANE));

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
  const plugins = pluginDecls(root.plugins);
  const routers = routerDecls(root.routers, (raw) => flowDecls(raw, lanes, peers, actions, backends.flatMap((b) => b.routes.map((r) => r.path)), plugins), plugins);
  return {
    name: str(root.name, "name", "hearth"),
    // Set by loadConfig, which is the only caller that knows one.
    configPath: null,
    stateFile: str(root.stateFile, "stateFile", "") || null,
    historyFile: str(root.historyFile, "historyFile", "") || null,
    layout: layoutDecl(root.layout),
    modelHeader: bool(root.modelHeader, "modelHeader", true),
    updateCheck: bool(root.updateCheck, "updateCheck", true),
    flows: flowDecls(root.flows, lanes, peers, actions, backends.flatMap((b) => b.routes.map((r) => r.path)), plugins),
    routers,
    callers: callerDecls(root.callers, routers),
    plugins,
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
    apiKeyRules,
    peerTokens,
    peerTailnet,
    tailscaleSocket: str(root.tailscaleSocket, "tailscaleSocket", "") || "/var/run/tailscale/tailscaled.sock",
    operator,
    share: lent,
    notes,
    modelKinds,
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
      return lowestLane(lanes);
    })(),
    peerMaxConcurrent: count(lending.maxConcurrent, "lending.maxConcurrent", 2, 1),
    lendTokensPerDay: count(lending.tokensPerDay, "lending.tokensPerDay", 0, 0),
    peerTerms,
    maxBodyBytes: count(root.maxBodyBytes, "maxBodyBytes", 32 * 1024 * 1024, 1024),
    peers,
    models,
    canary,
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
    backendRestMs: atLeast(defaults.restMs, "backendDefaults.restMs", 30_000),
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
