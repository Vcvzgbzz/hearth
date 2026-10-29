/** The shape of `/ui/data`: the contract between the server's payload and the page. Only fields the page reads. */

/** A declared path on a backend that fronts something that is not OpenAI-shaped. */
export interface Route {
  path: string;
  model: string;
  lane: string;
  /** false means the path is forwarded but never queued — a progress endpoint. */
  queue: boolean;
  /** Where a request goes when this backend fails it before answering. */
  fallback?: { backend: string; model: string };
}

/** What a model can take. Absent means not asked yet, never "no limit". */
export interface ModelStats {
  context?: number;
  vision?: boolean;
  tools?: boolean;
  /** It reasons before it answers. */
  thinking?: boolean;
  /** Its template takes a `reasoning_effort` — a dial, apart from `thinking`. */
  effort?: boolean;
  quant?: string;
  /** The lender's own words on what the model is for. */
  note?: string;
  /** Where the record came from. "declared" is the operator's word about a
   *  model nothing has loaded yet, and the page must not draw it as measured. */
  from?: "declared" | "observed" | "both";
}

export interface Backend {
  name: string;
  url?: string;
  /** The declared machine it runs on; null or absent is the one hearth is on. */
  server?: string | null;
  kind?: string;
  /** A provider's server on the internet: it uses no hardware here. */
  cloud?: boolean;
  /** Why a provider's server could not be read, in a few words; absent when it could. */
  trouble?: string;
  loaded?: string[];
  /** Models being read off the disk right now; drawn only when the backend reports it. */
  loading?: string[];
  /**
   * Resident models with weights assigned off the card (e.g. experts on the CPU), which slows
   * every token. Says where they were assigned, not which medium serves them.
   */
  offload?: {
    model: string;
    /** Layers whose experts run on the CPU (`--n-cpu-moe`). */
    cpuLayers: number | null;
    /** Every layer of experts (`--cpu-moe`). */
    cpuExpertsAll: boolean;
    /** The whole model is on the CPU (`-ngl 0`) — not a split, just not a card model. */
    cpuOnly: boolean;
  }[];
  serves?: string[];
  /** How much longer it is passed over after failing three times in a row; absent when it is not. */
  restingMs?: number;
  /** Only llama-swap. An ollama backend keeps its set resident, so it cannot thrash. */
  evicts?: boolean;
  /** False when it cannot report warm state at all, which is not the same as cold. */
  knowsWarm?: boolean;
  /** False when nothing has come back in a minute; absent where hearth cannot tell. Not a health check. */
  answering?: boolean;
  slots?: number;
  free?: number;
  queued?: number;
  /** Hardware it consumes. Empty means it competes for nothing. */
  resources?: string[];
  /** Non-OpenAI endpoints it fronts. A route backend has these and no `serves`. */
  routes?: Route[];
  /** Requests proxied through us unqueued (e.g. image generation): they light an edge but hold no slot or card. */
  proxying?: { id: string; model: string | null }[];
  /**
   * A backend's own busy state from a declared `activity:` path. `ok: false` is unknown, never
   * idle; `running > 0` lights it amber without claiming the card.
   */
  activity?: { running: number; queued?: number; ok: boolean };
}

/** One piece of hardware. `holder` is who is running on it, not whose weights are resident. */
export interface Resource {
  name: string;
  /** Synthesised by the page: host memory holding some resident model's weights. */
  host?: { detail: string; cards: string[] };
  /** What to draw it as. Never reaches admission. */
  kind?: "gpu" | "cpu" | "other";
  /** Used by several backends at once and not arbitrated, so `holder` is always null. */
  shared?: boolean;
  holder: string | null;
  backends: string[];
}

/** One backend cleared off a card so another could use it. */
export interface Eviction {
  t: number;
  /** Who was unloaded. */
  backend: string;
  /** Who took the card. */
  for: string;
  resources: string[];
}

export interface Node {
  name: string;
  self?: boolean;
  up: boolean;
  /** Verified: what the peer is offering right now, in OUR ids. Empty when it is down. */
  serves?: string[];
  loaded?: string[];
  /** Our own intent, independent of reachability. Never merged into `serves`. */
  configured?: string[];
  /** Their ids we have not claimed. */
  unmapped?: string[];
  /** Per model, in OUR ids. Per node because two nodes can serve the same id
   *  with different windows, and a merged map would have to pick one. */
  stats?: Record<string, ModelStats>;
  /** our id -> theirs. Effective, so a runtime link shows up. */
  map?: Record<string, string>;
  free: number | null;
  slots: number | null;
  queued: number | null;
  sending?: number;
  lastError?: string | null;
  backends?: Backend[];
}

export interface Net {
  nodes: Node[];
  /** Declared hardware. Empty for a config that never mentioned any. */
  resources?: Resource[];
  /** Recent handoffs, oldest first. */
  evictions?: Eviction[];
  /** Everything reachable, ours and mapped peers' alike. */
  available: string[];
  /** Loaded somewhere reachable — a union across nodes. */
  readyNow: string[];
  /** Loaded on a backend that cannot report what it holds. */
  unknownWarm?: string[];
  /** False when no backend here evicts, which makes "thrash" the wrong word. */
  evicts?: boolean;
}

export interface Job {
  /** Unique per job and the only safe React key; model + caller + since can collide. */
  id: string;
  lane: string;
  model: string;
  caller: string;
  backend?: string;
  peer?: string;
  state: "running" | "queued";
  position: number;
  since: number;
  offbox?: boolean;
}

export interface Capacity {
  free: number;
  slots: number;
  queued: Record<string, number>;
  offbox?: number;
  /** The first model currently loaded, if any. */
  resident?: string | null;
}

export interface Sample {
  t: number;
  queued: number;
  residents?: string[];
  /** Models with a job running at the instant of the reading, as opposed to merely loaded. */
  active?: string[];
}

/** One request that ran on a local backend, recorded when it ended; catches calls shorter than a sample. */
export interface Call {
  /** When it finished. Start is `t - ms`. */
  t: number;
  model: string;
  backend: string;
  /** Run time, once it had a slot. */
  ms: number;
  /** Time spent queued before that. */
  waitedMs: number;
  ok: boolean;
}

/** hearth.yaml: where every edit lands, and what is waiting on a restart. */
export interface ConfigStatus {
  /** Null for a node built in code, whose edits live in memory only. */
  path: string | null;
  hash: string;
  savedAt: string | null;
  restartPending: string[];
  /** Why the file on disk does not load; the node keeps running the last good config. */
  error: string | null;
}

/** Where a request for one id may go, and whether it can fall back home if the peer cannot take it. */
/** One step of a flow, as the file or the node holds it: `to` is a bare id or a map naming a peer, a flow, `fastest` or `refuse`. */
export interface Step {
  when?: Record<string, unknown> | null;
  to?: unknown;
  lane?: string | null;
  params?: Record<string, unknown> | null;
  /** The actions it sets off when it decides, by name. */
  do?: string[];
}

/** A flow: the ids whose requests enter it, and the steps that decide where each goes. */
export interface Flow {
  inputs: string[];
  steps: Step[];
  /** Switched off: its names run as themselves. */
  off?: boolean;
  note?: string;
  /** How long a conversation stays where the flow first sent it, in ms. */
  sticky?: number;
  /** Request paths it answers besides chat. */
  takes?: string[];
}

export interface Routing {
  /** The backend this id resolves to, when it runs here. */
  backend?: string;
}

export interface Controls {
  lending: boolean;
  borrowing: boolean;
}

/** One model the canary asks, and what its last answer was worth. */
export interface CanaryModel {
  backend: string;
  health: "ok" | "degraded";
  /** Consecutive failed checks. */
  failures: number;
  /** When it was last asked; 0 before the first probe. */
  lastProbeAt: number;
  /** How long that probe took, in ms. What the check costs. */
  lastProbeMs: number;
  /** Why it is out, when it is. */
  reason: string | null;
  detail: string | null;
  /** A bounded sample of what it actually returned. */
  sample: string | null;
  /** When it went out of rotation. */
  since: number | null;
  /** A recovery drop has happened; the next request or probe reloads it. */
  reloadPending: boolean;
  /** Recovery drops attempted. */
  recoveryCount: number;
}

/**
 * The opt-in canary. Always present, so the page can say "off" rather than
 * drawing nothing — "not configured" and "configured and quiet" must not look
 * the same.
 */
export interface Canary {
  enabled: boolean;
  /** Degenerate output in real traffic counts as a failed check. */
  passive: boolean;
  /** The gentle recovery is armed. */
  recovery: boolean;
  models: Record<string, CanaryModel>;
}

/** Requests and tokens over some days. */
export interface Used { requests: number; failed: number; in: number; out: number; /** How much of `in` was read from a prompt cache. */ cached?: number; /** Dollars, at the prices the models carry now. */ cost?: number }

/** The limits one lent model is held to. */
export interface ModelLimits { tokensPerDay: number; maxConcurrent: number; rateLimit: number }

/** What one peer may take: the models it may run, and how much of each; `limits` is each model's own. */
export interface LendTerms extends ModelLimits { models: string[]; off?: boolean; limits?: Record<string, Partial<ModelLimits>> }

/** A model's limits as the peer lending it states them, with how much of today this node has used. */
export interface LentTerms extends ModelLimits { usedToday: number }

export type PluginStage = "request" | "routed" | "parallel" | "stream" | "response" | "log" | "error";
export type StageNumbers = { calls: number; errors: number; refused: number; flagged: number; skipped: number; p50: number; p95: number };

/** One plugin as /plugins reports it. */
export interface PluginView {
  name: string;
  trust: "code" | "http";
  state: "running" | "failed" | "off";
  error: string | null;
  /** What runs, by request kind: the plugin's own declaration narrowed by the config. */
  kinds: Partial<Record<string, PluginStage[]>>;
  declared: Partial<Record<string, PluginStage[]>>;
  /** Its model slots, each with the kind of model it takes. */
  needs: Record<string, { kind: string; optional?: boolean }>;
  /** The models wired into its slots on the plugin itself. */
  models: Record<string, string>;
  /** Runs on every line rather than where a step places it. */
  everyLine: boolean;
  use: string;
  /** The service's own API, answered at /plugins/<name>/; null when it has none. */
  serves: string | null;
  /** The plugin that answers when this one cannot, and the adapter between their APIs. */
  fallback?: { plugin: string; adapt: string | null } | null;
  served: { calls: number; errors: number };
  /** Requests served now, or within the last moment, by id: drawn as dots on the map. */
  live: string[];
  /** For a plugin that speaks MCP: whether its server answers, its name, and how many tools it has. */
  mcp: { transport: "http" | "stdio"; server: string | null; tools: number | null; error: string | null; checkedAt: number; /** Under /plugins/<name>. */ path: string } | null;
  /** The program a plugin that runs an MCP server starts, as its command line. */
  run: string | null;
  when: { asked?: string[]; askedNot?: string[]; caller?: string[]; callerNot?: string[]; lane?: string[]; target?: string[]; header?: Record<string, string[]> } | null;
  timeoutMs: number;
  onError: "skip" | "refuse";
  onFail: "refuse" | "flag";
  locked: boolean;
  required: boolean;
  reads: string[];
  paused: boolean;
  pausedUntil: number;
  failOpens: number;
  stages: Partial<Record<PluginStage, StageNumbers>>;
}

export interface PluginsView {
  plugins: PluginView[];
  /** Every placement on a line, as the running config has it. */
  placed: { plugin: string; router: string; flow: string; step: number; kind: string; models: Record<string, string> }[];
  /** Models that take something other than chat, by id. */
  modelKinds: Record<string, string>;
  /** The kinds and stages this build runs plugins for. */
  liveKinds: string[];
  liveStages: PluginStage[];
  /** What a plugin's fallback can name as `adapt`: an adapter between two APIs. */
  adapters?: { name: string; desc: string }[];
  /** Each router: the global plugins it turns off or gives settings of its own, and the callers that go by it. */
  routers: Record<string, { plugins: Record<string, "off" | "own">; /** For "own": the settings it changes, by name. */ changes: Record<string, string[]>; callers: string[] }>;
  /** Plugins in hearth.yaml that differ from the running ones, until a restart. */
  pending: { name: string; change: "added" | "changed" | "removed" }[];
}

export interface UiData {
  /** Which console the node serves now; the page reloads when it stops being the one it was loaded from. */
  build?: string;
  /** The operator logged in on this request, or null for loopback and key callers. */
  operator: string | null;
  /** How to authenticate a write here: "open" on a keyless node, else a key or a session. */
  control: "open" | "key";
  controls: Controls;
  /** What is going out right now. */
  share: string[];
  /** What hearth.yaml lends, whether or not lending is paused. */
  configuredShare: string[];
  /** What we could lend at all. */
  catalog: string[];
  config: ConfigStatus;
  net: Net;
  q: { jobs: Job[]; capacity: Capacity };
  hist: Sample[];
  /** Advertised id -> its `as`. X is a variant of P when aliases[X] === P and P is advertised. */
  aliases?: Record<string, string>;
  /** Advertised id -> how it routes. Absent for a node that declares no models. */
  routing?: Record<string, Routing>;
  /** Every local request that ended inside the samples' 10-minute window, oldest first. */
  calls?: Call[];
  /** Samples the server's ring holds, so the streamed page trims to the same window. */
  histKeep?: number;
  /** Every flow in force, by name. */
  flows?: Record<string, Flow>;
  /** How many times each step of each flow has decided since the flows last changed. */
  flowHits?: Record<string, number[]>;
  /** Every action by name: its kind, and for a draft what it says or calls. */
  actions?: Record<string, { kind: string; says?: string }>;
  /** Saved positions by topology node id. */
  layout?: Record<string, { x: number; y: number }>;
  /** The canary's verdict per model. Absent only on an older server's payload. */
  canary?: Canary;
  /** Every api key: its label (or hash where unlabeled), its model scope, and the last time it spoke here. */
  keys?: { label: string; id: string; models: string[] | null; lastSeen: number | null; today?: Used; month?: Used; rule?: { expires: number | null; requestsPerMinute: number; tokensPerDay: number; dollarsPerDay?: number } | null }[];
  /** Callers that are not keys (this machine with none, peers) and what they used. */
  others?: { caller: string; today: Used; month: Used }[];
  /** Each peer's lines in the ledger: tokens it ran here, tokens this node ran there, and why it is turned away now, if it is. */
  ledger?: { peer: string; lent: { today: Used; month: Used }; borrowed: { today: Used; month: Used }; closed?: string | null; terms?: LendTerms; /** Which of `terms` are its own, not the node's. */ own?: string[];
    /** Tokens it ran here today, by model. */ lentToday?: Record<string, number>;
    /** What this node borrows from it, by this node's id: their id, and their limits on it when they say. */ received?: Record<string, { theirs: string; terms?: LentTerms }> }[];
  /** The limits a peer is held to unless it has its own. */
  lendDefaults?: { tokensPerDay: number; maxConcurrent: number; rateLimit: number };
  /** A newer published hearth, or null. */
  update?: string | null;
  /** The requests this node made most recently, newest first; neither `backend` nor `peer` when it never ran. */
  recent?: { t: number; model: string; caller: string; backend?: string; peer?: string; ms: number; ok: boolean }[];
  /** Plugins, for the Plugins page and the Routing map. Absent on an older server's payload. */
  plugins?: PluginsView;
}
