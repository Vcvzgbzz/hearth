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
}

export interface Sample {
  t: number;
  queued: number;
  residents?: string[];
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
}
