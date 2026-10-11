/**
 * Every hearth.yaml setting: its type, default and one line on what it does. parseConfig accepts
 * exactly these keys in each scope, and the console's config editor draws its form from them, so
 * a setting cannot exist in one and not the other.
 */

/** Where a setting's choices come from, read off the config being edited. */
export type Ref = "models" | "lanes" | "resources" | "backends" | "peers" | "servers" | "actions";

export type Field =
  | { type: "text" | "secret"; desc: string; def?: string }
  | { type: "number" | "ms"; desc: string; def?: number | string; min?: number }
  | { type: "bool"; desc: string; def?: boolean }
  | { type: "enum"; desc: string; def?: string; options: string[] }
  | { type: "ref"; desc: string; def?: string; ref: Ref }
  | { type: "refs"; desc: string; ref: Ref }
  | { type: "list"; desc: string }
  /** Nested settings with a scope of their own, or a free `name: value` map. */
  | { type: "object"; desc: string; scope?: Scope; seed: Record<string, unknown> }
  /** Accepted by the parser, edited in the hearth.yaml tab: shapes a form would only get in the way of. */
  | { type: "raw"; desc: string };

export type Scope =
  | "node" | "listen" | "backendDefaults" | "backend" | "activity" | "resource" | "server" | "flow" | "action" | "scheduler" | "lane"
  | "model" | "stats" | "pool" | "peer" | "lending" | "borrowing" | "operator";

const ms = (desc: string, def?: number | string, min?: number): Field =>
  ({ type: "ms", desc, ...(def !== undefined ? { def } : {}), ...(min !== undefined ? { min } : {}) });

/** The top-level keys that are sections of their own rather than node settings. */
export const SECTION_KEYS = ["backends", "resources", "servers", "models", "flows", "actions", "scheduler", "peers"] as const;

export const FIELDS: Record<Scope, Record<string, Field>> = {
  node: {
    name: { type: "text", desc: "How this node identifies itself to peers.", def: "hostname" },
    listen: { type: "object", scope: "listen", desc: "Address and port hearth serves on.", seed: { host: "127.0.0.1", port: 4141 } },
    lending: { type: "object", scope: "lending", desc: "What peers may run here, and how much of it.", seed: { models: [] } },
    borrowing: { type: "object", scope: "borrowing", desc: "How this node reads and waits on its peers.", seed: {} },
    backendDefaults: { type: "object", scope: "backendDefaults", desc: "Defaults every backend takes unless it sets its own.", seed: {} },
    apiKeys: { type: "list", desc: "Keys allowed on /v1/*. Empty means loopback only; setting it means loopback needs a key too." },
    maxBodyBytes: { type: "number", min: 1024, desc: "Largest accepted request body, in bytes.", def: 33554432 },
    modelHeader: { type: "bool", desc: "Send `x-hearth-model` on every chat answer: the id the request ran as. Turn off where callers should not see what is behind a name.", def: true },
    shutdownGraceMs: ms("How long a shutdown waits for requests in flight. 0 drops them.", 30000),
    operator: { type: "raw", desc: "The console login. Written by `hearth set-operator`." },
    historyFile: { type: "text", desc: "A file that keeps the console's day of history, recent logs and the month of usage per caller across restarts. Unset keeps them in memory." },
    routers: { type: "raw", desc: "Rulebooks besides `flows:`: `routers.<name>` has `flows` in the same shape, and `strict` so a request runs on the model its line names or fails: no next line after a failure, no route fallback. `callers:` says who goes by one." },
    callers: { type: "raw", desc: "Which rulebook a caller goes by: an api key's label, `local`, or `*` for everyone else, each to a name under `routers:` or `default` for `flows:`. Unset, everyone goes by `flows:`." },
    layout: { type: "raw", desc: "Where the console's topology draws the nodes you have placed. Written by its editor." },
    stateFile: { type: "raw", desc: "A pre-2.0 console sidecar, folded into this file once at startup." },
    canary: { type: "raw", desc: "Ask named models a question with one right answer, on a schedule; a seat that answers 200 with nothing is taken out of rotation. Off unless set; restart-only." },
  },
  listen: {
    host: { type: "text", desc: "Widening the host is deliberate: see Security in the README.", def: "127.0.0.1" },
    port: { type: "number", min: 1, desc: "Port for the API, peers and the console.", def: 4141 },
  },
  backendDefaults: {
    concurrency: { type: "number", min: 1, desc: "Jobs at once on a backend.", def: 1 },
    firstByteMs: ms("How long a backend may take to start answering. 0 waits forever.", 900000),
    idleMs: ms("How long a backend may go silent mid-answer. 0 waits forever.", 600000),
  },
  backend: {
    url: { type: "text", desc: "The OpenAI-compatible server hearth fronts. Or set server and port." },
    server: { type: "ref", ref: "servers", desc: "The machine this backend runs on. Unset is this one." },
    port: { type: "number", min: 1, desc: "With server and no url: the backend is http://<server host>:<port>." },
    kind: { type: "enum", options: ["llama-swap", "ollama", "single", "none"], desc: "Where warm state comes from.", def: "llama-swap" },
    resources: { type: "refs", ref: "resources", desc: "Hardware this backend uses. Backends on one exclusive card take turns." },
    serves: { type: "list", desc: "Model ids this backend serves. Declaring replaces discovery and acts as an allowlist." },
    concurrency: { type: "number", min: 1, desc: "Jobs at once on this backend.", def: "backendDefaults" },
    firstByteMs: ms("How long this backend may take to start answering: a sidecar that works before answering needs longer.", "backendDefaults"),
    idleMs: ms("How long this backend may go silent mid-answer.", "backendDefaults"),
    activity: { type: "object", scope: "activity", desc: "Where this backend reports its own busy state.", seed: { path: "/", running: "" } },
    resident: { type: "bool", desc: "Stays loaded beside the card's swapping model and is asked to yield when it needs the memory.", def: false },
    hold: { type: "raw", desc: "`{ lanes, idleMs, seat? }`: while this backend's app has work (read off `activity`), keep these lanes off its hardware until it has been idle this long. `seat` is the id a model swapper loads the app under, so the hold starts as the seat loads." },
    routes: { type: "raw", desc: "Paths this backend answers besides chat, each with its lane and model." },
  },
  activity: {
    path: { type: "text", desc: "The backend path to read." },
    running: { type: "text", desc: "Field holding how many jobs are running." },
    queued: { type: "text", desc: "Field holding how many are queued." },
  },
  resource: {
    kind: { type: "enum", options: ["gpu", "cpu", "other"], desc: "Picks the icon; gpu and other are exclusive unless shared.", def: "gpu" },
    shared: { type: "bool", desc: "Many backends at once, never arbitrated: CPUs, mostly.", def: false },
  },
  server: {
    host: { type: "text", desc: "The machine's address on your network: an IP or a hostname, no scheme or port." },
  },
  flow: {
    note: { type: "text", desc: "What this flow is for." },
    off: { type: "bool", desc: "Switched off: requests for its inputs run as themselves.", def: false },
    takes: { type: "list", desc: "Request paths this flow answers besides chat, each as a backend declares it under routes: (image generation and the like). Unset is chat." },
    sticky: { type: "ms", min: 1000, desc: "How long a conversation stays where this flow first sent it, so later turns keep the same model. Unset decides every turn afresh." },
    inputs: { type: "refs", ref: "models", desc: "The ids whose requests enter this flow. An id enters at most one." },
    steps: { type: "raw", desc: "Tried in order, first match wins: `when: {…}`, `to:` a model, `{ peer }`, `{ flow }`, `{ fastest: […] }` or `{ refuse }`, with optional `lane`, `params`, `max` (requests in flight at once) and `do:` (actions to set off). The last has no `when`." },
  },
  action: {
    on: { type: "enum", options: ["decided", "finished", "failed"], desc: "When it runs: as the step decides, once the request has finished (either way), or only when it failed.", def: "decided" },
    slowerThan: { type: "ms", min: 1000, desc: "Only for a request that took longer than this. It then runs once the request has finished, unless `on` says failed." },
    every: { type: "ms", min: 1000, desc: "Run at most once in this long, however many requests name it. Unset runs every time." },
    log: { type: "text", desc: "Write this line to the log. `{asked}`, `{model}`, `{caller}` and the other request facts are filled in." },
    call: { type: "text", desc: "Send a request to this URL, without waiting on it. env:NAME keeps it out of the file." },
    method: { type: "enum", options: ["POST", "PUT", "GET"], desc: "call only: how the URL is called.", def: "POST" },
    headers: { type: "object", desc: "call only: headers to send. A value may be env:NAME.", seed: {} },
    body: { type: "raw", desc: "call only: the JSON to send, with `{asked}` and the like filled in. Unset sends every request fact." },
  },
  scheduler: {
    lanes: { type: "object", desc: "Named lanes and their base priority. Lower goes first.", seed: { chat: { priority: 0 } } },
    agePerSecond: { type: "number", min: 0, desc: "Priority earned per second waited, which is also the starvation bound.", def: 1 },
    warmBonus: { type: "number", min: 0, desc: "Priority discount for a model already loaded.", def: 40 },
    maxPerLane: { type: "number", min: 1, desc: "How long one lane's queue may get before new work is refused.", def: 100 },
    maxPerCaller: { type: "number", min: 0, desc: "Queued-or-running jobs per caller per lane. 0 is off.", def: "0, or 2 with apiKeys" },
  },
  lane: {
    priority: { type: "number", desc: "Base priority. Lower goes first.", def: 0 },
    concurrency: { type: "number", min: 1, desc: "Most slots of one backend this lane may hold. Unset is no ceiling." },
    maxWaitMs: ms("Fail a queued job once nothing on its backend has started for this long. A guard against a wedged backend.", undefined, 1000),
  },
  model: {
    note: { type: "text", desc: "What the model is for, shown to borrowers and as description on /v1/models." },
    as: { type: "ref", ref: "models", desc: "The id this one goes out as: an alias for another model." },
    backend: { type: "ref", ref: "backends", desc: "Pin to a backend instead of resolving it from the catalogs." },
    follow: { type: "bool", desc: "Go out as whatever the pinned backend has loaded, else as `as`. Needs backend and as.", def: false },
    lane: { type: "ref", ref: "lanes", desc: "Lane this model's requests queue in, over the client's." },
    concurrency: { type: "number", min: 1, desc: "Jobs this model may run at once, above or below its backend's.", def: "backend's" },
    shareAfterMs: ms("A turn joins running turns only once each has run this long. Matters above concurrency 1.", undefined, 0),
    videoTokens: { type: "number", min: 1, desc: "What one video costs when checking a request fits the context window.", def: 49152 },
    params: { type: "object", desc: "Request fields stamped on every call: temperature, top_p and the like.", seed: {} },
    stats: { type: "object", scope: "stats", desc: "What the model takes, for one that hasn't loaded or a backend that can't say.", seed: {} },
    pool: { type: "object", scope: "pool", desc: "Token budget shared by this model's running turns.", seed: { tokens: 131072 } },
    emulate: { type: "enum", options: ["llama-server"], desc: "Reshape this backend's answers into another server's format." },
  },
  stats: {
    context: { type: "number", min: 1, desc: "Context window, in tokens." },
    vision: { type: "bool", desc: "Takes images." },
    tools: { type: "bool", desc: "Takes tool calls." },
    thinking: { type: "bool", desc: "Reasons before answering." },
    effort: { type: "bool", desc: "Takes a reasoning-effort setting." },
    quant: { type: "text", desc: "Quantization, shown to borrowers." },
  },
  pool: {
    tokens: { type: "number", min: 1, desc: "Tokens shared by this model's running turns." },
    output: { type: "number", min: 1, desc: "Tokens reserved for each turn's answer." },
  },
  peer: {
    url: { type: "text", desc: "The peer's hearth, main port. Needed to borrow from it." },
    token: { type: "secret", desc: "What you present when borrowing from it. env:NAME keeps it out of the file." },
    accept: { type: "secret", desc: "What it presents when borrowing from you. Without one it cannot borrow." },
    models: { type: "object", desc: "your id: their id, for each model you borrow.", seed: {} },
  },
  lending: {
    models: { type: "refs", ref: "models", desc: "Models peers may run here. Empty lends nothing." },
    lane: { type: "ref", ref: "lanes", desc: "Which lane borrowed work enters.", def: "lowest-priority lane" },
    maxConcurrent: { type: "number", min: 1, desc: "Jobs one peer may have in flight.", def: 2 },
    rateLimit: { type: "number", min: 1, desc: "Peer inference requests per hour. Capacity polling has its own budget.", def: 600 },
  },
  borrowing: {
    firstByteMs: ms("How long to wait for a peer to start answering before falling back. 0 waits forever.", 180000),
    freshMs: ms("How long a good peer reading is reused before a routing decision asks again.", 4000, 100),
    downMs: ms("How long a failed probe is remembered, so an outage doesn't make every request pay the timeout.", 30000, 1000),
    pollMs: ms("Background floor that warms the peer cache.", 60000, 1000),
    staleMs: ms("When a background peer reading counts as stale.", 60000, 1000),
    coldPenalty: { type: "number", min: 0, desc: "What a model load is worth to `fastest`, in queued jobs.", def: 2 },
  },
  operator: {
    user: { type: "text", desc: "The console login's username." },
    passHash: { type: "raw", desc: "salt:hash from `hearth set-operator`." },
  },
};

/** The scope a path in the config points at, or null for a free `name: value` map. */
export function scopeOf(path: (string | number)[]): Scope | null {
  const [a, b, c, d] = path;
  const n = path.length;
  if (n === 0) return "node";
  if (n === 1 && (a === "listen" || a === "backendDefaults" || a === "scheduler" || a === "lending" || a === "borrowing" || a === "operator")) return a;
  if (a === "backends" && n === 2) return "backend";
  if (a === "backends" && c === "activity" && n === 3) return "activity";
  if (a === "resources" && n === 2) return "resource";
  if (a === "servers" && n === 2) return "server";
  if (a === "flows" && n === 2) return "flow";
  if (a === "actions" && n === 2) return "action";
  if (a === "scheduler" && b === "lanes" && n === 3) return "lane";
  if (a === "models" && n === 2) return "model";
  if (a === "models" && c === "stats" && d === undefined) return "stats";
  if (a === "models" && c === "pool" && d === undefined) return "pool";
  if (a === "peers" && n === 2) return "peer";
  return null;
}

/** The setting at a path, if the table knows it. */
export function fieldAt(path: (string | number)[]): Field | null {
  const key = path[path.length - 1];
  if (typeof key !== "string") return null;
  const scope = scopeOf(path.slice(0, -1));
  return scope ? FIELDS[scope][key] ?? null : null;
}

/** What a newly added setting starts as: something the parser accepts, so a save never fails on type alone. */
export function seedOf(f: Field): unknown {
  switch (f.type) {
    case "bool": return f.def ?? false;
    case "number": case "ms": return typeof f.def === "number" ? f.def : (f.min ?? 1);
    case "enum": return f.def ?? f.options[0];
    case "refs": case "list": return [];
    case "object": return structuredClone(f.seed);
    default: return "";
  }
}

/** 900000 → "15 min": the unit a person thinks in, beside the one the file takes. */
export function humanMs(n: number): string {
  if (n === 0) return "forever";
  if (n % 3_600_000 === 0) return `${n / 3_600_000} h`;
  if (n % 60_000 === 0) return `${n / 60_000} min`;
  if (n % 1000 === 0) return `${n / 1000} s`;
  return `${n} ms`;
}

/** The allowed key closest to a typo, for "did you mean": a case slip or at most two edits away. */
export function nearest(key: string, allowed: readonly string[]): string | null {
  const lower = key.toLowerCase();
  let best: string | null = null;
  let bestD = 3;
  for (const a of allowed) {
    if (a.toLowerCase() === lower) return a;
    const d = distance(lower, a.toLowerCase());
    if (d < bestD) { best = a; bestD = d; }
  }
  return best;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}
