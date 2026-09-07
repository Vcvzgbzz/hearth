/**
 * The shape of `/ui/data`, written down.
 *
 * The old page was a string and nothing type-checked what it consumed, so a
 * renamed field on the server surfaced as a blank panel rather than a failure.
 * That is the whole reason these live here: `serveUi` builds the payload from
 * `networkView()`, `pool.jobs()` and `overrideView()`, and this file is the
 * contract between them and the page. Fields the server sends but nothing on
 * the page reads are deliberately omitted rather than typed as `unknown` —
 * adding one here should mean somebody is about to draw it.
 */

/** A declared path on a backend that fronts something that is not OpenAI-shaped. */
export interface Route {
  path: string;
  model: string;
  lane: string;
  /** false means the path is forwarded but never queued — a progress endpoint. */
  queue: boolean;
}

/**
 * What a model can take, learned from the backend running it.
 *
 * Every field optional and absent-when-unknown, which the page must render as
 * "not asked yet" rather than "no limit" — a model that has never been loaded
 * reports nothing at all, and drawing that as unlimited is the one wrong answer.
 */
export interface ModelStats {
  context?: number;
  vision?: boolean;
  tools?: boolean;
  thinking?: boolean;
  quant?: string;
}

export interface Backend {
  name: string;
  url?: string;
  kind?: string;
  loaded?: string[];
  serves?: string[];
  /** Only llama-swap. An ollama backend keeps its set resident, so it cannot thrash. */
  evicts?: boolean;
  /** False when it cannot report warm state at all, which is not the same as cold. */
  knowsWarm?: boolean;
  /** False when nothing has come back from it in a minute. Not a health check,
   *  and only meaningful where `knowsWarm` is true. */
  answering?: boolean;
  slots?: number;
  free?: number;
  queued?: number;
  /** Hardware it consumes. Empty means it competes for nothing. */
  resources?: string[];
  /** Non-OpenAI endpoints it fronts. A route backend has these and no `serves`. */
  routes?: Route[];
  /**
   * Requests being proxied through us right now WITHOUT being queued.
   *
   * Image generation arrives on `/upstream/<model>/generate`, which hearth
   * forwards verbatim and deliberately does not schedule. That is a decision
   * about admission, and it used to be an accidental decision about visibility
   * too: the backend drew idle and its card drew free while the GPU was flat
   * out. These are real in-flight requests with no job behind them, so they
   * light an edge but never claim a slot, a queue position or a card.
   */
  proxying?: { id: string; model: string | null }[];
}

/**
 * One piece of hardware, and the backends that take turns on it.
 *
 * `holder` is who is RUNNING on it, not whose weights are resident: the arbiter
 * frees a card the moment the last job on it finishes, so free-and-still-loaded
 * is the normal resting state and the page must not draw it as busy.
 */
export interface Resource {
  name: string;
  /** What to draw it as. Never reaches admission. */
  kind?: "gpu" | "cpu" | "other";
  /**
   * Several backends may use it at once, so it is not arbitrated at all.
   *
   * `holder` is therefore always null for one of these — correctly: nobody is
   * holding it, several things are using it. Drawing that as "free" would be
   * the same lie the console used to tell about forwarded work.
   */
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
  /**
   * Unique per job, and the only safe key for one.
   *
   * The obvious composite — model + caller + since — is NOT unique: two
   * concurrent requests for the same model from the same caller, submitted in
   * the same millisecond, collide. React then renders ONE of them and silently
   * drops the rest, so the graph drew a single particle for a pair of jobs and
   * the queue table was short a row, while the count beside them (taken from
   * the array, not the rendered list) correctly said two.
   */
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
  /**
   * Models with a job RUNNING on a local backend at the instant of the reading.
   * Residency says what is loaded; this says what is being used. A model can
   * sit warm for an hour and never appear here.
   */
  active?: string[];
}

/**
 * One request that ran on a local backend, recorded when it ENDED.
 *
 * The samples above cannot see a call that starts and finishes between two
 * readings, and cannot place a boundary more finely than 5s. This can: it is
 * the same record llama-swap's activity page keeps, made here so it exists for
 * every backend kind and for exactly the traffic that went through the queue.
 */
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
  changes: { maps: unknown[]; routes: unknown[] };
  canSave: boolean;
  savesTo: "config" | "state" | null;
  savePath: string | null;
  /** Distinct from `dirty`: "will not survive a restart", not "not in the file". */
  unsaved: boolean;
  yaml: string;
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
  /**
   * Advertised id -> the `as` it is sent to the backend under.
   *
   * Used to detect variants: if aliases[X] === P and P is itself in
   * net.available, then X is a variant of P (same weights, different advertised
   * name). An `as` naming something not in net.available is a rename, not a
   * variant — those rows stand alone.
   */
  aliases?: Record<string, string>;
  /**
   * Every request that ran on a local backend and ended inside the same
   * 10-minute window as the samples, oldest first.
   */
  calls?: Call[];
}
