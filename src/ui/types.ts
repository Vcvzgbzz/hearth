/** The shape of `/ui/data`: the contract between the server's payload and the page. Only fields the page reads. */

/** A declared path on a backend that fronts something that is not OpenAI-shaped. */
export interface Route {
  path: string;
  model: string;
  lane: string;
  /** false means the path is forwarded but never queued — a progress endpoint. */
  queue: boolean;
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
  kind?: string;
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

export interface Overrides {
  dirty: boolean;
  changes: { maps: unknown[]; routes: unknown[]; notes?: unknown[] };
  canSave: boolean;
  savesTo: "config" | "state" | null;
  savePath: string | null;
  /** Distinct from `dirty`: "will not survive a restart", not "not in the file". */
  unsaved: boolean;
  yaml: string;
}

/** Where a request for one id may go, and whether it can fall back home if the peer cannot take it. */
export interface Routing {
  policy: "local" | "peer" | "spillover" | "fastest";
  /** Who may serve it, in preference order. Empty means anyone that maps it. */
  peers: string[];
  /** Fall back to the local backend when no peer can take it. */
  fallbackLocal: boolean;
  /** `spillover` only: go remote once this many jobs are queued here. */
  spilloverAt: number;
}

export interface Controls {
  lending: boolean;
  borrowing: boolean;
  /** Per-model lending overrides. Absent key means "whatever the file says". */
  models?: Record<string, boolean>;
}

export interface UiData {
  /** Whether the write routes exist on the socket that served this page. */
  canWarm: boolean;
  /** How to authenticate a write here, decided per socket rather than guessed. */
  control: "open" | "key" | "off";
  controls: Controls;
  /** What is going out right now. */
  share: string[];
  /** What the file says. */
  configuredShare: string[];
  /** What we could lend at all. */
  catalog: string[];
  overrides: Overrides;
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
}
