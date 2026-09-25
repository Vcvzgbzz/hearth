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

import { EMULATIONS, type Emulation } from "./emulate.js";
import { known, NOTE_MAX, type ModelStats } from "./stats.js";

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

/**
 * One request path on a backend that speaks something other than the OpenAI API.
 *
 * hearth's own routes queue because it knows their shape: a model id, a lane, a
 * caller. The catch-all passthrough deliberately does NOT queue, because
 * scheduling work you cannot identify is guesswork. That leaves out a whole
 * class of backend that is otherwise a perfect fit — request-scoped,
 * GPU-bound, one job at a time — purely because its URL is not `/v1/*`:
 * A1111's `/sdapi/v1/txt2img`, a whisper server's `/asr`, a TTS or rerank or
 * upscale sidecar, any homemade FastAPI in front of diffusers.
 *
 * Naming the path is what makes it identifiable, and that is all this is. The
 * body is still forwarded byte for byte and hearth never looks inside it.
 *
 * The case this is really for is one GPU with an LLM server and an image server
 * on it. Today nothing coordinates them: both load, both thrash the card. With
 * a path to queue on and a shared `resources` entry, they take turns.
 *
 * Limited to SYNCHRONOUS endpoints — ones that do the work and answer. A
 * submit-then-poll API (ComfyUI's `/prompt` -> `/history/{id}`) does not fit:
 * holding a slot across two unrelated requests leaks it the moment a client
 * stops polling. That wants its own mechanism, and this shape leaves room for
 * one rather than pretending to cover it.
 */
/**
 * What a named resource IS, declared once rather than inferred from use.
 *
 * `resources:` on a backend has always meant "hardware I use", and the arbiter
 * has always read that as "hardware I must not share". For a card that is the
 * same sentence. For a CPU it is not: six sidecars run on one CPU quite happily,
 * and serializing them would be wrong — worse than wrong, since a backend taking
 * a resource UNLOADS every other backend holding it, so declaring a shared CPU
 * under the old rules would have thrashed models that are meant to stay
 * resident.
 *
 * There was no way to say that, so the only safe move was to declare nothing —
 * which is why the console could not show what a sidecar runs on. Declaring the
 * resource fixes both: the operator says `resources: [cpu]`, which is true, and
 * says here that the CPU does not need serializing.
 *
 * `kind` is display only and never reaches admission. `shared` is the one that
 * changes behaviour, and it does so by keeping the resource away from the
 * arbiter entirely rather than by teaching the arbiter a second mode.
 */
export interface ResourceDecl {
  /** What to draw it as. Behaviour never reads this. */
  kind: "gpu" | "cpu" | "other";
  /**
   * True when several backends may use it at once.
   *
   * A shared resource is not arbitrated at all: it is filtered out before the
   * scheduler ever sees it, so `resources.ts` stays exactly what it says it is —
   * mutual exclusion — and knows nothing about sharing.
   */
  shared: boolean;
}

export interface RouteRule {
  /**
   * Exact pathname, query string ignored. `/sdapi/v1/txt2img`, `/generate`.
   *
   * May contain ONE `{model}` placeholder standing for a whole path segment —
   * `/upstream/{model}/generate` — for a backend that puts the model in the URL
   * rather than the body. See Pool.forPath for what stops that matching more
   * than the operator pictured.
   */
  path: string;
  /** Which lane it queues in, and so what it yields to. */
  lane: string;
  /** The id this work is reported under — status, logs, the page. */
  model: string;
  /**
   * false routes the path here but does not queue it.
   *
   * For the status endpoint every one of these backends has: A1111's
   * `/sdapi/v1/progress`, a job-list, a health probe. They are cheap, they are
   * not GPU work, and queueing them behind a render is worse than useless —
   * a progress bar that only updates once the thing it is measuring has
   * finished.
   */
  queue: boolean;
}

/**
 * `activity:` — where a backend reports its OWN busy state.
 *
 * For a backend hearth forwards to but does not schedule — a submit-then-poll
 * app like ComfyUI, whose `/prompt` answers in milliseconds while the render
 * runs for a minute. The forwarded mark is gone long before the GPU even spins
 * up (it tracks the HTTP request, which already returned), so the node draws
 * idle through the whole job. `routes:` cannot fix that: a route holds a slot
 * across the poll, and the moment a client stops polling the slot leaks.
 *
 * So instead the operator names a path the backend already serves and which
 * field on it carries the count. hearth reads only those and never learns the
 * app — the same bargain `routes:` strikes. `running` and the optional `queued`
 * may be a dotted field path; each is read as an array (its length) or a number
 * (itself), and anything else — missing, wrong type, an unreachable backend —
 * is "cannot tell", which the page draws as unknown and never as idle.
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
  /**
   * How long to wait for THIS backend to start answering, in ms. 0 waits
   * forever. Defaults to the node's `backendFirstByteMs`.
   *
   * Per backend because "how long before a first byte is plausible" is a fact
   * about what is behind the port, and a node-wide number cannot be right for
   * every one of them. A chat server answers in seconds; a sidecar that renders
   * a video before it replies with anything at all can legitimately take tens
   * of minutes, and a deadline sized for the first would kill the second's
   * honest work.
   *
   * It is still worth setting rather than disabling. The deadline is not there
   * to bound how long real work may take, it is there so that a backend which
   * has stopped answering ALTOGETHER eventually gives its slot — and its card —
   * back, instead of holding both until the process restarts.
   */
  firstByteMs: number | null;
  /**
   * Hardware this backend consumes, so backends sharing it take turns.
   *
   * A backend is its own admission domain, which is right up until two of them
   * are one piece of silicon — two llama-swap instances pinned to different
   * cards are independent, but a backend running a model spanning both cards is
   * not independent of either. The queues cannot see that on their own, so say
   * it:
   *
   *     backends:
   *       - name: swap
   *         resources: [gpu0]
   *       - name: swap-image
   *         resources: [gpu1]
   *       - name: deep          # spans the pair
   *         resources: [gpu0, gpu1]
   *
   * Backends whose sets overlap will not run at the same time; backends whose
   * sets are disjoint are unaffected, and neither is routing — a model still
   * resolves to exactly one backend by exactly the rules it did before.
   *
   * The names are yours and mean nothing outside this file. Empty, the default,
   * means competing for nothing, which is every config that predates this.
   */
  resources: string[];
  /**
   * Non-OpenAI paths this backend serves, and whether they are work.
   *
   * Empty for anything that speaks `/v1`, which is most backends and every
   * config that predates this.
   */
  routes: RouteRule[];
  /**
   * Where this backend reports its OWN busy state, for one hearth forwards to
   * but does not schedule. Null for every backend that speaks `/v1`, which is
   * most of them — see ActivityDecl.
   */
  activity: ActivityDecl | null;
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
   * Request fields stamped on every chat completion routed through this id,
   * AFTER the `as` rewrite and OVER whatever the client sent. The id is the
   * user's choice, so a client that also sends the field does not undo it.
   *
   * The other half of `as`: several advertised ids can front ONE resident
   * backend model and differ only in the defaults they carry
   * (`reasoning_effort: low` on one id, `none` on another) -- no second
   * process, so no seat swap on a one-GPU box. Local dispatch only: a peer
   * takes its id from its own map and applies its own config. null for every
   * model without it, which is nearly all of them.
   */
  params: Record<string, unknown> | null;
  /**
   * Which lane every request for this id queues in, OVER whatever the client
   * sent. null means the client's `lane` field (or the default) applies, as it
   * does for every model without it. The other half of `params`: an advertised
   * id can carry both the request defaults and the queue position the operator
   * wants for it, so a caller that only picks a model id cannot queue ahead of
   * work the operator ranked above it.
   */
  lane: string | null;
  /**
   * What this model can take, when nothing can be asked.
   *
   * Only for what cannot be learned: a cold model, or a backend that does not
   * speak /props. Whatever the running process reports beats this, field by
   * field. See declaredStats().
   */
  stats: ModelStats | null;
  /** Reshapes this id's backend answers into another server's format; see emulate.ts. */
  emulate: Emulation | null;
  /** Tokens the model's running requests share (vLLM's KV cache, llama.cpp `--kv-unified`); `output` caps each request's counted `max_tokens`, null counts it whole. */
  pool: { tokens: number; output: number | null } | null;
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
   * Counted against everything running on the backend, except on `kind: ollama`,
   * where it counts this model's own jobs.
   *
   * Written as `concurrency:`, matching the backend field it overrides. `batch:`
   * is the older name for the same thing, from when it could only raise.
   */
  concurrency: number | null;
}

export interface HearthConfig {
  /**
   * Declared hardware, by name.
   *
   * Optional and additive: a name a backend uses but nobody declares is an
   * exclusive `gpu`, which is what every config written before this meant and
   * what the arbiter has always done with it.
   */
  resources: Record<string, ResourceDecl>;
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
  /** Operator-chosen names for the keys above, index-aligned with `apiKeys`; an
   *  empty string means that key has no label. A labeled key is logged and shown
   *  as `key:<label>` instead of the sha256 prefix, so the console can say `dsh`
   *  rather than `key:ff2f1c4e`. A label is not a secret and never hashed. */
  apiKeyLabels: string[];
  /**
   * What each key may run, index-aligned with `apiKeys`. null is the full
   * local surface, which every key had before this existed. A list makes the
   * key a scoped one: `POST /v1/chat/completions` for exactly those ids and
   * `GET /v1/models` (filtered to them), and nothing else -- no passthrough,
   * no warm, no control, no queue. The ids must be routes in `models:`,
   * because what a scoped key may do is policy, and policy lives on routes.
   *
   * For the caller that holds only a model picker and runs on the softest
   * box you own. Its key leaking must cost you that one model, not the GPU.
   */
  apiKeyModels: (string[] | null)[];
  /** Tokens peers present to us, by peer name. Kept separate from apiKeys so
   *  peer traffic is attributable and can be capped on its own. */
  peerTokens: Record<string, string>;
  /** Models we'll serve to peers. Empty means none, since lending is opt-in. */
  share: string[];
  /** What each model is for, shown to peers beside it. */
  notes?: Record<string, string>;
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
   * How long to wait for a peer to start answering, in ms. 0 waits forever.
   *
   * A peer can accept a connection and then never answer, and you can't walk
   * over and look. With fallbackLocal on, this deadline is what turns that into
   * a retry at home instead of a hang. Set it above their worst honest cold
   * load or you'll bounce work home for nothing.
   */
  peerFirstByteMs: number;
  /**
   * The same deadline for a LOCAL backend, in ms. 0 waits forever.
   *
   * Longer than the peer's, because the trade is different rather than absent.
   * A local cold load is slow and it is your machine, so the deadline exists
   * only to catch the case where the backend is not going to answer at all: a
   * process wedged on a GPU fault, or a port that accepts and then drops. Those
   * do not fail the connection, so nothing else ever unblocks them.
   *
   * It matters more here than for a peer. A request to a peer holds no slot; a
   * request to a local backend holds one for as long as it runs, so a single
   * hung call takes the backend's whole queue with it — and if that backend
   * declared `resources`, the card stays held and every backend sharing it
   * stops too. The only recovery is a restart.
   *
   * A client hanging up releases the slot as well, but that is the client's
   * timeout doing the work, and one without a timeout of its own waits as long
   * as we do.
   */
  backendFirstByteMs: number;
  /**
   * How long a shutdown waits for requests already in flight, in ms. 0 kills
   * them immediately, which is what this did before it was a number.
   *
   * A restart is a deploy, and the work in flight at that moment is somebody's
   * chat turn or a render several GPU-minutes in. Destroying the socket loses
   * it with no error the caller can act on -- the response simply stops -- and
   * nothing retries it. Waiting costs the deploy a few seconds and the caller
   * nothing.
   *
   * Bounded, because the alternative is a stuck deploy: past this the remaining
   * connections are destroyed exactly as before. Keep the service manager's own
   * stop timeout above this (systemd's `TimeoutStopSec`, default 90s) or it
   * SIGKILLs mid-drain and the wait bought nothing.
   */
  shutdownGraceMs: number;
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
 * `models.<id>.params`: a flat object of chat-completion fields to stamp on the
 * body. The keys a request cannot function without are refused, because
 * stamping them is never what anyone meant: `model` is what `as` is for,
 * `messages` would replace the conversation, `stream` would change the response
 * shape under the client, and `lane` is hearth's own routing field, stripped
 * before forwarding. An empty object is the same as not saying it.
 */
/**
 * What the operator says a model can take, for the cases nothing can measure.
 *
 * Stats are normally LEARNED from the running process, which is authoritative
 * and needs no config at all. Two cases that cannot reach: a model that has
 * never been loaded (asking llama-swap for its props loads it, which is the
 * eviction and the 60-second load this check exists to avoid), and a backend
 * that is not OpenAI-shaped and can never answer at all. Both would otherwise
 * be unknown forever, and unknown refuses nothing — so the first oversized
 * request evicts somebody's resident model, waits out a cold load, and fails.
 *
 * Declaring is how you close that. It is a PREDICTION of how the process will
 * be launched, so the moment the real thing loads, its own answer wins.
 *
 * Loud on a bad value, unlike the same fields arriving from a peer, which are
 * quietly dropped. A peer is a stranger whose mistakes are not ours to fix; a
 * config is something the operator can correct, and a silently ignored `visio:
 * true` is the kind of typo that is discovered months later by its absence.
 */
function declaredStats(raw: unknown, id: string): ModelStats | null {
  if (raw === undefined || raw === null) return null;
  const where = `models.${id}.stats`;
  const rec = asRecord(raw, where);
  const out: ModelStats = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "context") {
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError(`${where}.context is "${String(v)}" -- expected a positive whole number of tokens`);
      }
      out.context = v;
    } else if (k === "vision" || k === "tools" || k === "thinking" || k === "effort") {
      if (typeof v !== "boolean") {
        throw new ConfigError(`${where}.${k} is "${String(v)}" -- expected true or false`);
      }
      out[k] = v;
    } else if (k === "quant") {
      out.quant = str(v, `${where}.quant`);
    } else {
      throw new ConfigError(
        `${where}.${k} is not a model stat -- expected context, vision, tools, thinking, effort or quant`,
      );
    }
  }
  return known(out) ? out : null;
}

function modelParams(raw: unknown, id: string): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  const where = `models.${id}.params`;
  const rec = asRecord(raw, where);
  for (const k of ["model", "messages", "stream", "lane"]) {
    if (k in rec) {
      throw new ConfigError(
        `${where}.${k} cannot be stamped -- ` +
          (k === "model" ? "use `as` to rename the model on the wire" : `${k} belongs to the request, not the route`),
      );
    }
  }
  return Object.keys(rec).length === 0 ? null : rec;
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

/**
 * `apiKeys:` entries, as a bare secret string or `{ key, label }`.
 *
 * The bare form is the entire history of this field and is untouched. The
 * object form only attaches an operator-chosen name, so the log and the console
 * can read `key:dsh` instead of `key:<hash>`. The label is not a secret — it is
 * the operator's own word for a caller — so, unlike the key, it is never taken
 * through `env:` and never hashed. It is also visible wherever caller ids are,
 * the off-loopback status port included, which is the reason it is opt-in per
 * key: name only the callers you are content to see named there.
 */
function apiKeyList(
  v: unknown, where: string, routeIds: Set<string>,
): { keys: string[]; labels: string[]; models: (string[] | null)[] } {
  if (v === undefined) return { keys: [], labels: [], models: [] };
  if (!Array.isArray(v)) throw new ConfigError(`${where} must be a list`);
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
      throw new ConfigError(
        `${at}.key repeats ${where}[${dupKey}] -- the first match wins, so this entry can never be the one that authenticates`,
      );
    }
    seenKey.set(key, keys.length);
    if (label !== "") {
      // Two keys under one name are one caller: the id is what maxPerCaller
      // counts against, so they would share a single budget (2 by default once
      // apiKeys is set) rather than getting one each. Silently merging two
      // callers is not something to discover from a queue that fills early.
      const dupLabel = seenLabel.get(label);
      if (dupLabel !== undefined) {
        throw new ConfigError(
          `${at}.label "${label}" is already used by ${where}[${dupLabel}] -- two keys under one name share one caller identity, and with it one maxPerCaller budget`,
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
    if (label === "") throw new ConfigError(`${at}.label must not be empty`);
    // A scope names routes, not backend ids: an unknown id is refused here
    // rather than found as a 403 on the client, and a scoped key can only ever
    // reach ids whose lane and params the operator wrote down.
    let scope: string[] | null = null;
    if (entry.models !== undefined) {
      scope = strList(entry.models, `${at}.models`);
      if (scope.length === 0) throw new ConfigError(`${at}.models must name at least one model`);
      for (const id of scope) {
        if (!routeIds.has(id)) {
          throw new ConfigError(`${at}.models names "${id}", which is not a route in models:`);
        }
      }
    }
    take(key, label, at, scope);
  });
  return { keys, labels, models };
}

/**
 * A path that can actually match a request: absolute, no query string. Shared
 * by `routes:` and `activity:` so the two rules cannot drift apart.
 */
function requirePath(path: string, at: string): void {
  // A path that does not start with "/" can never match a request — a typo that
  // would otherwise fail silently at 3am rather than at startup. Matching is on
  // pathname alone, so a query string in the config is a mistake as well.
  if (!path.startsWith("/")) {
    throw new ConfigError(`${at}.path must start with "/" (got ${path})`);
  }
  if (path.includes("?")) {
    throw new ConfigError(`${at}.path must not include a query string (got ${path})`);
  }
}

/**
 * `activity:` on a backend — see ActivityDecl. Absent or null for most.
 *
 * The path reuses the route-path rule; `running` is required because an
 * activity block with nothing to read is a no-op the operator will think is
 * working. `queued` is optional: some backends report one queue, some two.
 */
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

/**
 * `routes:` entries, as a bare path or an object.
 *
 * The bare form is the common case — one endpoint that does the work — and it
 * should not cost four lines of YAML to say so. `lane` and `model` are left
 * empty here and filled in once the lanes exist; see resolveRoutes.
 */
function routeList(v: unknown, where: string): RouteRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ConfigError(`${where} must be a list`);
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
      throw new ConfigError(`${at}.path may contain at most one {model} (got ${path})`);
    }
    if (holes === 1 && !path.split("/").includes("{model}")) {
      throw new ConfigError(
        `${at}.path must use {model} as a whole path segment, not part of one (got ${path})`,
      );
    }
    if (/\{(?!model\})[^}]*\}/.test(path)) {
      throw new ConfigError(`${at}.path: the only placeholder is {model} (got ${path})`);
    }
    if (holes === 1 && typeof entry.model === "string" && entry.model !== "") {
      throw new ConfigError(
        `${at} sets both {model} in the path and model: — the path supplies the id`,
      );
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

  /**
   * Declared hardware. Everything here is optional, including the block.
   *
   * Validated up front rather than on first use: a typo in `kind` that only
   * surfaces as the wrong icon weeks later is exactly the class of thing
   * --check exists to catch at deploy time.
   */
  const resourceDecls: Record<string, ResourceDecl> = {};
  if (root.resources !== undefined) {
    const rd = asRecord(root.resources, "resources");
    for (const [name, raw] of Object.entries(rd)) {
      const at = `resources.${name}`;
      const entry = asRecord(raw ?? {}, at);
      const kind = str(entry.kind, `${at}.kind`, "gpu");
      if (kind !== "gpu" && kind !== "cpu" && kind !== "other") {
        throw new ConfigError(
          `${at}.kind must be gpu, cpu or other (got ${JSON.stringify(kind)})`,
        );
      }
      resourceDecls[name] = { kind, shared: bool(entry.shared, `${at}.shared`, false) };
    }
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
        firstByteMs: entry.firstByteMs === undefined
          ? null
          : atLeast(entry.firstByteMs, `backends[${i}].firstByteMs`, 0),
        resources: strList(entry.resources, `backends[${i}].resources`),
        routes: routeList(entry.routes, `backends[${i}].routes`),
        activity: activityDecl(entry.activity, `backends[${i}].activity`),
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
      firstByteMs: backend.firstByteMs === undefined
        ? null
        : atLeast(backend.firstByteMs, "backend.firstByteMs", 0),
      resources: strList(backend.resources, "backend.resources"),
      routes: routeList(backend.routes, "backend.routes"),
      activity: activityDecl(backend.activity, "backend.activity"),
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

  // Routes are filled in HERE rather than where they are parsed, because their
  // defaults depend on the lanes, and the lanes are not known until now.
  //
  // The default lane is the lowest-priority one you configured — `batch` in the
  // stock config. A path worth naming is nearly always the heavy, uninteractive
  // half of the box (a render, a transcription, a batch of images), and the
  // thing it shares a GPU with is nearly always someone waiting on a chat
  // response. Yielding is the right default; say `lane:` when it isn't.
  const fallbackLane = Object.entries(lanes)
    .filter(([n]) => n !== WARM_LANE)
    .sort((a, b) => b[1].priority - a[1].priority)[0]![0];
  const claimedPaths = new Map<string, string>();
  for (const b of backends) {
    for (const r of b.routes) {
      if (r.lane === "") r.lane = fallbackLane;
      else if (!(r.lane in lanes)) {
        throw new ConfigError(
          `backends "${b.name}" route ${r.path} names lane "${r.lane}", which is not in scheduler.lanes`,
        );
      }
      // Named for the backend, since one backend's paths are one thing as far
      // as anything watching is concerned. Two paths on one backend reporting
      // the same id is correct: they are the same GPU doing the same job.
      //
      // A {model} route is the exception: its id comes from the request, so
      // defaulting it here would report every render under the backend's name.
      if (r.model === "" && !r.path.includes("{model}")) r.model = b.name;
      // A path resolves to exactly one backend, the same way a model id does.
      // Two backends claiming it is someone meaning two different things by one
      // URL, and picking either silently is worse than saying so.
      const owner = claimedPaths.get(r.path);
      if (owner) {
        throw new ConfigError(
          `backends "${owner}" and "${b.name}" both declare the route ${r.path} — ` +
            `one path cannot mean two backends`,
        );
      }
      claimedPaths.set(r.path, b.name);
    }
  }

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
    const params = modelParams(entry.params, id);
    const emulate = str(entry.emulate, `models.${id}.emulate`, "");
    if (emulate !== "" && !(EMULATIONS as readonly string[]).includes(emulate)) {
      throw new ConfigError(`models.${id}.emulate is "${emulate}"; known: ${EMULATIONS.join(", ")}`);
    }
    const lane = str(entry.lane, `models.${id}.lane`, "");
    if (lane !== "" && !(lane in lanes)) {
      throw new ConfigError(
        `models.${id}.lane is "${lane}", which is not in scheduler.lanes (${Object.keys(lanes).join(", ")})`,
      );
    }
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
      params,
      lane: lane === "" ? null : lane,
      stats: declaredStats(entry.stats, id),
      emulate: emulate === "" ? null : (emulate as Emulation),
      pool: modelPool(entry.pool, id),
    };
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
    share: strList(root.share, "share"),
    notes: (() => {
      const raw = root.notes === undefined ? {} : asRecord(root.notes, "notes");
      const out: Record<string, string> = {};
      for (const [id, v] of Object.entries(raw)) {
        const note = str(v, `notes.${id}`).trim();
        if (note.length > NOTE_MAX) {
          throw new ConfigError(`notes.${id} is ${note.length} characters -- keep it under ${NOTE_MAX}`);
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
    backendFirstByteMs: atLeast(root.backendFirstByteMs, "backendFirstByteMs", 900_000),
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
