/**
 * Config loading and validation.
 *
 * For most people this file is the product. They'll read it once, copy it, and
 * never open the source. So it validates loudly and early: a typo in a peer's
 * model map should fail at startup with a line you can act on, not at 2am as a
 * 404 from a machine you don't own.
 *
 * Everything stays local unless you say otherwise. Nothing leaves your machine
 * because a default allowed it.
 */
import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

export type RoutePolicy = "local" | "peer" | "spillover" | "fastest";

export interface PeerConfig {
  name: string;
  /** Base url of the peer's hearth, not its backend. */
  url: string;
  /** Bearer token this peer expects. `env:NAME` pulls it from the environment so
   *  it stays out of the config file you commit. */
  token: string;
  /**
   * my model id -> their model id.
   *
   * Doubles as the allowlist. A model that isn't in this map can't be routed to
   * this peer no matter what the policy says. Local-only variants (a thinking
   * level with its own backend entry, say) stay home by simply not appearing.
   */
  models: Record<string, string>;
}

/**
 * How a backend can be asked what it has loaded.
 *
 *   llama-swap  /api/events over SSE, falling back to /running
 *   ollama      poll /api/ps; several models can be resident at once
 *   single      one always-resident model, so whatever it lists is warm
 *   none        it cannot tell us, and we must not pretend otherwise
 *
 * The distinction that matters is `none` versus the rest: an empty warm set is
 * not the same claim as "nothing is warm". Reporting a cold-load tax that may
 * not exist makes the status page lie, so `none` is carried through as unknown
 * rather than flattened into cold.
 */
export type WarmSource = "llama-swap" | "ollama" | "single" | "none";

/**
 * Whether the standalone status listener may serve the WRITE routes.
 *
 * "off"  — the default and today's behaviour: that socket answers the page and
 *          404s everything else, so the only thing a LAN can do there is look.
 * "key"  — it also serves POST /control and POST /v1/warm, behind the SAME
 *          localCaller gate the main listener uses. That gate already accepts a
 *          valid apiKey from any address, so this grants no authority that the
 *          main listener does not already grant — it moves a credential-gated
 *          route onto a second socket. An unauthenticated caller there still
 *          gets exactly the page, which is the property worth preserving.
 *
 * There is deliberately NO "trusted" mode treating the socket itself as
 * authority. That would be a second trust model beside the credential, and its
 * failure — a bind wider than the operator believed — is silent and remote.
 */
export type UiControl = "off" | "key";

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
   * The model ids this backend serves, if you'd rather say than have it asked.
   *
   * Empty means discover them from /v1/models, which is right for llama-swap
   * and anything else that names its models usefully. Declare them when the
   * backend does not: a bare llama-server reports the gguf path it was started
   * with, so discovery would put "/root/models/Llama-Guard-3-1B-Q8_0.gguf" in
   * your catalogue and hand your filesystem layout to anyone who reads it.
   *
   * Declaring is also an allowlist, the same way a peer's model map is: nothing
   * else resolves here. Most such servers ignore the model field in the request
   * and serve whatever they loaded, so the name is yours to choose.
   */
  serves: string[];
  /**
   * Jobs allowed to hold THIS backend at once.
   *
   * Per backend, not per node, and that is the whole point of the list. A GPU
   * that fits one model wants 1; a small always-resident CPU model alongside it
   * can take several at once and must not be stuck behind the GPU's queue.
   * Defaults to scheduler.concurrency so a single-backend config is unchanged.
   */
  concurrency: number;
}

export interface ModelRoute {
  /** Which backend serves it. null means "work it out from the catalogs".
   *  Naming one is how you break a tie when two backends offer the same id. */
  backend: string | null;
  /**
   * The id to send to the BACKEND, when it differs from the id we advertise.
   *
   * The same rewrite `peers[].models` already does (my-id -> their-id), applied
   * to a local backend. `nomic-embed` here, `nomic-embed-text-v2-moe:latest` on
   * the wire. null means "they are the same", which is every model without it.
   *
   * This exists so a backend's naming does not leak into the API. The
   * alternative in the field was `ollama cp` to duplicate the tag under a
   * nicer name, which leaves both names in the backend's catalog and only
   * works for Ollama.
   */
  as: string | null;
  policy: RoutePolicy;
  /** Who may serve it, in preference order. Empty means anyone that maps it. */
  peers: string[];
  /** `spillover` only: go remote once this many jobs are queued here. */
  spilloverAt: number;
  /** Fall back to the local backend if no peer can take it. */
  fallbackLocal: boolean;
  /**
   * How many jobs for THIS model may run at once locally, or null to use the
   * backend's own `concurrency`.
   *
   * Per model rather than per backend because one llama-swap fronts entries
   * that disagree: the ceiling is a property of what is loaded, not of the port
   * it answers on. So this number wins over the backend's in BOTH directions.
   *
   * Higher, for something that batches: a vLLM entry answers 32 requests in
   * about the time it takes to answer one, and queuing them one behind the
   * other throws away the only reason to run it. Set it to --max-num-seqs, or
   * lower if you would rather cap the latency each request sees. A raise
   * applies only while this model is the only one running, so a swap is still
   * serialized exactly as before.
   *
   * Lower, for a llama.cpp entry started with fewer slots than its neighbours:
   * `--parallel 2` on the 8B and `--parallel 4` on the 3B is one seat with two
   * real ceilings, and the backend's single number is wrong for one of them.
   * Dispatching 4 to a server with 2 slots does not make it serve 4 — the extra
   * two queue inside llama.cpp where this scheduler cannot see them, and it
   * goes on counting them as running.
   *
   * Written as `concurrency:`, matching the backend field it overrides. `batch:`
   * is the older name for the same thing, from when it could only raise.
   */
  concurrency: number | null;
}

export interface HearthConfig {
  /**
   * The file this config was loaded from, or null when it was built in memory.
   *
   * Set by loadConfig and by nothing else. Saving a runtime change writes back
   * into this file, so a config that never came from disk simply cannot be
   * saved to one — which is the right answer for a test or an embedded use, and
   * says so rather than inventing a path.
   */
  configPath: string | null;
  /**
   * Where runtime changes are kept when the CONFIG cannot be written, or null.
   *
   * Save writes your config file, which is where a saved change belongs: one
   * record of what this node does, in the file you already keep in a repo. This
   * is the fallback for when that is impossible — a read-only bind mount in a
   * container, most often — and it holds the same changes as a set of deltas
   * applied over the config at startup.
   *
   * Leave it null unless you have that problem. Two files describing one node
   * is a cost, and it is only worth paying when the alternative is not being
   * able to save at all. Under `ProtectSystem=strict` nothing outside
   * WorkingDirectory is writable, so pair it with `StateDirectory=hearth`.
   */
  stateFile: string | null;
  /** What this node calls itself when talking to peers. */
  name: string;
  listen: { host: string; port: number };
  /**
   * The local backends this node fronts, in declaration order. Always at least
   * one; `backend:` in YAML is sugar for a list of one.
   *
   * Each is its own admission domain: its own queue, its own concurrency, its
   * own warm state. There is no scheduling across them, deliberately — a model
   * resolves to exactly one backend and queues only there. That keeps the hard
   * part (one GPU, one resident model) exactly as simple as it was, and stops a
   * cheap always-on model waiting behind a chat generation.
   *
   * Order matters for two things: an unknown model goes to the first backend,
   * and a model offered by several resolves to the first unless pinned.
   */
  backends: BackendConfig[];
  scheduler: {
    /** Default concurrency for backends that don't set their own. */
    concurrency: number;
    agePerSecond: number;
    warmBonus: number;
    lanes: Record<string, { priority: number }>;
    /** How long one lane's queue may get before we start refusing. Someone told
     *  "full" can retry. Someone queued behind 400 jobs just waits. */
    maxPerLane: number;
    /**
     * Cap per caller per lane. 0 turns it off.
     *
     * "Per caller" only means anything when callers are distinguishable. Without
     * apiKeys every local request is the same identity, so this stops being
     * fairness and becomes a global concurrency limit. Hence the default of 0
     * there: a default of 2 would 429 the second concurrent request from your
     * own app, straight out of the box.
     */
    maxPerCaller: number;
  };
  /**
   * Where the status page is ALSO served, if anywhere.
   *
   * null means nowhere else: the page stays on the main port, loopback-only,
   * which is the default and the safe answer. Set this and you get a second
   * listener that serves `/ui` and `/ui/data` and nothing else — no `/v1`, no
   * passthrough, no peer protocol — so widening it cannot widen anything but
   * the page.
   *
   * The point is headless boxes and containers, where there is no browser on
   * loopback to use. Binding it somewhere reachable is a deliberate widening:
   * a browser cannot present a bearer token, so whoever can reach this socket
   * can read your queue, your callers and your model inventory. Put it on a
   * tailnet address with an ACL, not on a LAN.
   */
  uiListen: { host: string; port: number; control: UiControl } | null;
  /** Keys allowed on the OpenAI surface. Empty means no auth, which only makes
   *  sense on loopback. Setting it also means loopback needs a key. */
  apiKeys: string[];
  /** Tokens peers present to us, by peer name. Kept separate from apiKeys so
   *  peer traffic is attributable and can be capped on its own. */
  peerTokens: Record<string, string>;
  /** Models we'll serve to peers. Empty means none, since lending is opt-in. */
  share: string[];
  /** Requests per hour one peer may send us. */
  peerRateLimit: number;
  /**
   * Which lane borrowed work lands in. Defaults to your lowest-priority one.
   *
   * Peers used to pick this themselves by putting a lane in the request body,
   * which meant a borrower could file their work into your highest-priority
   * lane, ahead of yours. Their choice is ignored now. Lanes say what matters to
   * the operator, and a guest doesn't get a vote in that.
   */
  peerLane: string;
  /**
   * Jobs one peer may have queued-or-running at once. Unlike maxPerCaller this
   * doesn't care whether apiKeys are set, because a peer is always a caller we
   * can tell apart.
   *
   * peerRateLimit won't do this job. Hundreds of requests an hour is far more
   * than a serialized GPU can retire, so without a concurrency cap a borrower's
   * retry loop parks itself in front of your own work indefinitely.
   */
  peerMaxConcurrent: number;
  /** Biggest request body we'll take. Multi-image vision payloads get close to
   *  the old hardcoded 32MB, so it's a knob now instead of a constant. */
  maxBodyBytes: number;
  peers: PeerConfig[];
  models: Record<string, ModelRoute>;
  /**
   * How long a good reading gets reused before routing goes and asks again.
   * This is the freshness knob that matters, because peer state is fetched on
   * demand when a request needs it, not on a timer.
   *
   * Concurrent requests coalesce onto one probe, so this bounds cost too: one
   * control-plane call per peer per window however much traffic there is, and
   * none at all when nobody's asking.
   */
  peerFreshMs: number;
  /**
   * How long we remember a failed probe. Longer than peerFreshMs on purpose.
   *
   * Probing a dead peer costs the full timeout, so without this every request
   * during an outage pays it, and their box being broken makes your local
   * requests slower. Backwards.
   */
  peerDownMs: number;
  /** Background poll, and only a floor these days: warms the cache before the
   *  first request and re-checks peers nobody's asking about. 0 turns it off. */
  peerPollMs: number;
  peerStaleMs: number;
  /**
   * How long to wait for a peer to start answering, in ms. 0 waits forever,
   * which is the right call for a local backend: a cold load is slow, but it's
   * your machine and it will finish.
   *
   * Peers are different. One can accept a connection and then never answer, and
   * you can't walk over and look. With fallbackLocal on, this deadline is what
   * turns that into a retry at home instead of a hang. Set it above their worst
   * honest cold load or you'll bounce work home for nothing.
   */
  peerFirstByteMs: number;
  /**
   * What a cold model is worth to `fastest`, in queued-jobs-equivalent. 0 means
   * ignore warmth and compare queue depth alone.
   *
   * Loading something large off disk is tens of seconds; a queued job is however
   * long one turn takes. 2 says starting cold is about as bad as being two turns
   * back in the queue, which is roughly right for a 27B and roughly wrong for a
   * 3B. Tune it against your own load times.
   */
  coldPenalty: number;
}

const DEFAULT_LANES = { chat: { priority: 0 }, batch: { priority: 100 } };

/**
 * The lane /v1/warm uses, and the highest number here on purpose: a warm is
 * speculative work done on a hunch, so it must yield to every real request,
 * including a batch render.
 *
 * Ensured even when the operator declares `lanes` explicitly — declaring lanes
 * REPLACES the defaults, and without this a warm would land on the unknown-lane
 * fallback of 1000. That fallback exists to make a typo sort to the back where
 * you notice it, so leaning on it would make a deliberate lane indistinguishable
 * from a mistake. Declare `warm` yourself to override the priority.
 */
const WARM_LANE = "warm";
const WARM_LANE_PRIORITY = 200;

export { WARM_LANE };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** `env:NAME` indirection, so tokens live in the environment and the config
 *  stays committable. A missing variable is fatal, because starting up with an
 *  empty token means every peer call 401s and nothing says why. */
function resolveSecret(value: string, where: string): string {
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const got = process.env[name];
  if (!got) {
    throw new ConfigError(`${where}: environment variable ${name} is not set`);
  }
  return got;
}

function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError(`${where} must be a mapping`);
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string, fallback?: string): string {
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${where} is required`);
  }
  if (typeof v !== "string") throw new ConfigError(`${where} must be a string`);
  return v;
}

function num(v: unknown, where: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${where} must be a number`);
  }
  return v;
}

/**
 * Whole number, at least `min`.
 *
 * These are counts and milliseconds and the likely typos aren't harmless.
 * `concurrency: 0` used to validate fine and then made pump()'s loop condition
 * never fire, so every request queued forever with no error, no timeout, and
 * nothing in the log.
 */
function count(v: unknown, where: string, fallback: number, min = 1): number {
  const n = num(v, where, fallback);
  if (!Number.isInteger(n) || n < min) {
    throw new ConfigError(`${where} must be a whole number >= ${min} (got ${n})`);
  }
  return n;
}

/**
 * A model's own slot count: `concurrency`, or the older `batch` spelling, or
 * null for "whatever the backend says".
 *
 * Both names are accepted and mean the same field. Saying both is refused
 * rather than silently resolved, because the two numbers disagreeing is a
 * config that reads as one ceiling and enforces the other.
 */
function modelConcurrency(entry: Record<string, unknown>, id: string): number | null {
  const has = (k: string) => entry[k] !== undefined && entry[k] !== null;
  if (has("concurrency") && has("batch") && entry.concurrency !== entry.batch) {
    throw new ConfigError(
      `models.${id} sets both concurrency and batch, which are the same setting ` +
        `(${String(entry.concurrency)} vs ${String(entry.batch)}) — keep concurrency`,
    );
  }
  const key = has("concurrency") ? "concurrency" : "batch";
  if (!has(key)) return null;
  return count(entry[key], `models.${id}.${key}`, 1, 1);
}

/**
 * Number, at least `min`, fractions fine.
 *
 * `count` is too strict for the tuning weights, since half a point of aging per
 * second is a reasonable thing to ask for. But plain `num` was too loose. A
 * negative agePerSecond inverts aging into guaranteed starvation, a negative
 * warmBonus makes the scheduler prefer to thrash, and a negative coldPenalty
 * sends `fastest` looking for whichever node has to load the model. All three
 * validated fine and then misbehaved quietly.
 */
function atLeast(v: unknown, where: string, fallback: number, min = 0): number {
  const n = num(v, where, fallback);
  if (n < min) throw new ConfigError(`${where} must be >= ${min} (got ${n})`);
  return n;
}

const WARM_SOURCES: WarmSource[] = ["llama-swap", "ollama", "single", "none"];

/**
 * `kind`, or the boolean it replaced.
 *
 * `llamaSwapExtras` said one thing badly: true meant "ask llama-swap", false
 * meant "do not ask". Both spellings are accepted, but not at once — silently
 * preferring one is how someone ends up wondering why their ollama backend
 * still reports cold.
 */
function warmSource(entry: Record<string, unknown>, where: string): WarmSource {
  const kind = str(entry.kind, `${where}.kind`, "");
  const legacy = entry.llamaSwapExtras;
  if (kind !== "" && legacy !== undefined) {
    throw new ConfigError(
      `${where}: set kind or llamaSwapExtras, not both — ` +
        `llamaSwapExtras: ${String(legacy)} is the old spelling of kind: ${legacy === false ? "none" : "llama-swap"}`,
    );
  }
  if (kind !== "") {
    if (!WARM_SOURCES.includes(kind as WarmSource)) {
      throw new ConfigError(
        `${where}.kind is "${kind}" — expected ${WARM_SOURCES.join(", ")}`,
      );
    }
    return kind as WarmSource;
  }
  return bool(legacy, `${where}.llamaSwapExtras`, true) ? "llama-swap" : "none";
}

function bool(v: unknown, where: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new ConfigError(`${where} must be true or false`);
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ConfigError(`${where} must be a list of strings`);
  }
  return v as string[];
}

function trimUrl(u: string, where: string): string {
  if (!/^https?:\/\//.test(u)) {
    throw new ConfigError(`${where} must start with http:// or https:// (got ${u})`);
  }
  return u.replace(/\/+$/, "");
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
      "set either backend: (one) or backends: (a list), not both — " +
        "`backend` is just shorthand for a list of one",
    );
  }

  const backends: BackendConfig[] = [];
  if (root.backends !== undefined) {
    if (!Array.isArray(root.backends)) throw new ConfigError("backends must be a list");
    if (root.backends.length === 0) throw new ConfigError("backends must not be empty");
    for (const [i, b] of root.backends.entries()) {
      const entry = asRecord(b, `backends[${i}]`);
      backends.push({
        name: str(entry.name, `backends[${i}].name`),
        url: trimUrl(str(entry.url, `backends[${i}].url`), `backends[${i}].url`),
        kind: warmSource(entry, `backends[${i}]`),
        serves: strList(entry.serves, `backends[${i}].serves`),
        concurrency: count(entry.concurrency, `backends[${i}].concurrency`, defaultConcurrency, 1),
      });
    }
    const seen = new Set<string>();
    for (const b of backends) {
      if (seen.has(b.name)) throw new ConfigError(`two backends are both named "${b.name}"`);
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
    });
  }
  const backendNames = new Set(backends.map((b) => b.name));

  const lanesRaw = sched.lanes === undefined ? DEFAULT_LANES : asRecord(sched.lanes, "scheduler.lanes");
  const lanes: Record<string, { priority: number }> = {};
  for (const [lane, v] of Object.entries(lanesRaw)) {
    const entry = asRecord(v, `scheduler.lanes.${lane}`);
    lanes[lane] = { priority: num(entry.priority, `scheduler.lanes.${lane}.priority`, 0) };
  }
  // BEFORE the warm lane is added, or `lanes: {}` would quietly become a valid
  // config with one lane nobody asked for. An empty lanes block is a mistake and
  // has to keep failing as one.
  if (Object.keys(lanes).length === 0) {
    throw new ConfigError("scheduler.lanes must define at least one lane");
  }
  // See WARM_LANE_PRIORITY. Added rather than defaulted, so it survives an
  // explicit `lanes:` block that would otherwise replace it.
  if (lanes[WARM_LANE] === undefined) lanes[WARM_LANE] = { priority: WARM_LANE_PRIORITY };

  const peers: PeerConfig[] = [];
  const peersRaw = root.peers === undefined ? [] : root.peers;
  if (!Array.isArray(peersRaw)) throw new ConfigError("peers must be a list");
  for (const [i, p] of peersRaw.entries()) {
    const entry = asRecord(p, `peers[${i}]`);
    const name = str(entry.name, `peers[${i}].name`);
    const models = asRecord(entry.models ?? {}, `peers[${i}].models`);
    const map: Record<string, string> = {};
    for (const [mine, theirs] of Object.entries(models)) {
      map[mine] = str(theirs, `peers[${i}].models.${mine}`);
    }
    // A peer that maps nothing used to be refused here, on the grounds that
    // nothing could ever route to it. That was a lint for a file somebody typed
    // by hand, and it stopped making sense when the console could edit these:
    // unlinking a peer's last model is one click, and it left you in a state
    // the config could not express and the page could not save.
    //
    // It is also not the mistake it looks like. An empty map is the state
    // between deciding to trust someone and deciding what to borrow from them —
    // their url, their token and your notes are all still here. Nothing routes
    // there because candidates() needs a mapping, and the page lists everything
    // they serve so you can put one back.
    peers.push({
      name,
      url: trimUrl(str(entry.url, `peers[${i}].url`), `peers[${i}].url`),
      token: resolveSecret(str(entry.token, `peers[${i}].token`), `peers[${i}].token`),
      models: map,
    });
  }

  const names = new Set<string>();
  for (const p of peers) {
    if (names.has(p.name)) throw new ConfigError(`two peers are both named "${p.name}"`);
    names.add(p.name);
  }

  const models: Record<string, ModelRoute> = {};
  const modelsRaw = root.models === undefined ? {} : asRecord(root.models, "models");
  for (const [id, v] of Object.entries(modelsRaw)) {
    const entry = asRecord(v, `models.${id}`);
    const policy = str(entry.policy, `models.${id}.policy`, "local") as RoutePolicy;
    if (!["local", "peer", "spillover", "fastest"].includes(policy)) {
      throw new ConfigError(
        `models.${id}.policy is "${policy}" — expected local, peer, spillover or fastest`,
      );
    }
    const named = strList(entry.peers, `models.${id}.peers`);
    for (const n of named) {
      if (!names.has(n)) {
        throw new ConfigError(`models.${id}.peers names "${n}", which is not a configured peer`);
      }
    }
    // Catching it here instead of at request time is the reason this validation
    // exists at all. A policy that can never fire is a typo.
    if (policy !== "local") {
      const candidates = named.length > 0 ? named : peers.map((p) => p.name);
      const able = candidates.filter((n) => peers.find((p) => p.name === n)?.models[id]);
      if (able.length === 0) {
        throw new ConfigError(
          `models.${id}.policy is "${policy}" but no peer maps "${id}" — ` +
            `add it to a peer's models mapping, or set policy: local`,
        );
      }
    }
    const pinned = str(entry.backend, `models.${id}.backend`, "");
    if (pinned !== "" && !backendNames.has(pinned)) {
      throw new ConfigError(
        `models.${id}.backend is "${pinned}", which is not a configured backend ` +
          `(${[...backendNames].join(", ")})`,
      );
    }
    const alias = str(entry.as, `models.${id}.as`, "");
    // `as` and a peer policy used to be refused together, on the grounds that
    // two rewrites of one id is ambiguous. They are not ambiguous, they are the
    // two destinations: `as` is applied by pool.outboundId() and ONLY on the
    // way to a local backend, while a peer dispatch takes its id from that
    // peer's own map. No request can be subject to both.
    //
    // And forbidding it broke the case that wants it. `policy: fastest` on a
    // model you serve locally under one name and borrow under another is
    // exactly the arrangement worth having, and from the console you reached it
    // by typing the obvious local id — then got told to remove the alias, which
    // would have broken the local backend instead.
    models[id] = {
      backend: pinned === "" ? null : pinned,
      as: alias === "" ? null : alias,
      policy,
      peers: named,
      spilloverAt: count(entry.spilloverAt, `models.${id}.spilloverAt`, 1, 1),
      fallbackLocal: bool(entry.fallbackLocal, `models.${id}.fallbackLocal`, true),
      concurrency: modelConcurrency(entry, id),
    };
  }

  const apiKeys = strList(root.apiKeys, "apiKeys").map((k, i) =>
    resolveSecret(k, `apiKeys[${i}]`),
  );

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

  let uiListen: { host: string; port: number; control: UiControl } | null = null;
  if (root.uiListen !== undefined && root.uiListen !== null) {
    const u = asRecord(root.uiListen, "uiListen");
    // `false` is the default and the safe one: the status listener serves the
    // page and nothing that writes. `key` additionally serves the write routes
    // there behind the SAME apiKey gate the main listener uses — no new
    // authority, just a second socket for a credential that already works.
    const rawControl = u.control ?? false;
    if (rawControl !== false && rawControl !== "key") {
      throw new ConfigError(
        `uiListen.control must be false or "key" (got ${JSON.stringify(rawControl)})`,
      );
    }
    const control: UiControl = rawControl === "key" ? "key" : "off";
    uiListen = {
      host: str(u.host, "uiListen.host", "127.0.0.1"),
      port: count(u.port, "uiListen.port", 4142, 1),
      control,
    };
    // Refuse the combination that looks enabled and cannot work.
    //
    // With no apiKeys, localCaller falls back to loopback-only — so a keyed
    // write from the LAN is rejected no matter what the page sends. The
    // operator would enable clickable controls, be prompted for a key, and
    // watch every write 401 with nothing explaining why. Fail at --check
    // instead, where there is a person reading the message.
    if (control === "key" && apiKeys.length === 0) {
      throw new ConfigError(
        `uiListen.control: key requires apiKeys — without one, writes on the status ` +
          `port fall back to loopback-only and every click from the LAN would be refused`,
      );
    }
    // Same socket twice is a listen() failure at startup with a errno nobody
    // reads. Say it here instead.
    if (uiListen.port === mainListen.port && uiListen.host === mainListen.host) {
      throw new ConfigError(
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
    peerTokens,
    share: strList(root.share, "share"),
    peerRateLimit: count(root.peerRateLimit, "peerRateLimit", 600, 1),
    peerLane: (() => {
      const named = str(root.peerLane, "peerLane", "");
      if (named !== "") {
        if (!(named in lanes)) {
          throw new ConfigError(
            `peerLane is "${named}", which is not one of your lanes (${Object.keys(lanes).join(", ")})`,
          );
        }
        return named;
      }
      // Lowest priority means the largest number. Guests wait behind the house.
      //
      // EXCLUDING the warm lane. It is the lowest-priority lane by construction,
      // so once it existed this default silently moved every peer's inference
      // into the lane reserved for speculative preloading — real work filed
      // behind a hunch. A peer can still be put there explicitly with
      // `peerLane: warm`, which at least says so out loud.
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
    coldPenalty: atLeast(root.coldPenalty, "coldPenalty", 2),
  };
}

export function loadConfig(path: string): HearthConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`cannot read config at ${path}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`${path} is not valid YAML: ${String(e)}`);
  }
  const cfg = parseConfig(raw);
  cfg.configPath = path;
  return cfg;
}
