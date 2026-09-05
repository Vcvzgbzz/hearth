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

export interface Backend {
  name: string;
  loaded?: string[];
  serves?: string[];
  /** Only llama-swap. An ollama backend keeps its set resident, so it cannot thrash. */
  evicts?: boolean;
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
