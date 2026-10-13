/**
 * Older hearth.yaml layouts rewritten as the current one, on the YAML document so comments travel
 * with the values they sit on. Two steps, each a no-op on a file that is already past it:
 * v1 → v2 groups what v1 spread over the top level (lending:, borrowing:, backendDefaults:, one
 * entry per peer, maps keyed by name), and a model's own routing settings become a flow.
 */
import { Document, isMap, isScalar, isSeq, YAMLMap, type Node } from "yaml";

import { ANY, CONFIG_VERSION, MOVED_TO_FLOWS, rawFlow, type Flow } from "./config.js";
import { routedFlow } from "./route.js";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Top-level keys that only v1 has, and where each one lives now. */
const MOVED: Record<string, string[]> = {
  share: ["lending", "models"],
  peerLane: ["lending", "lane"],
  peerMaxConcurrent: ["lending", "maxConcurrent"],
  peerRateLimit: ["lending", "rateLimit"],
  peerFirstByteMs: ["borrowing", "firstByteMs"],
  peerFreshMs: ["borrowing", "freshMs"],
  peerDownMs: ["borrowing", "downMs"],
  peerPollMs: ["borrowing", "pollMs"],
  peerStaleMs: ["borrowing", "staleMs"],
  coldPenalty: ["borrowing", "coldPenalty"],
  backendFirstByteMs: ["backendDefaults", "firstByteMs"],
  backendIdleMs: ["backendDefaults", "idleMs"],
  backendRestMs: ["backendDefaults", "restMs"],
};

/** The first v1-only thing in a parsed config, named for the error, or null for a v2 file. */
export function v1Marker(raw: Record<string, unknown>): string | null {
  for (const k of [...Object.keys(MOVED), "backend", "peerTokens", "notes"]) if (k in raw) return k;
  if (Array.isArray(raw.backends)) return "backends as a list";
  if (Array.isArray(raw.peers)) return "peers as a list";
  if (isObj(raw.scheduler) && "concurrency" in raw.scheduler) return "scheduler.concurrency";
  return null;
}

/** Does the file leave unsaid what happens to a name no flow takes? */
export function unguarded(raw: Record<string, unknown>): boolean {
  return !Object.values(isObj(raw.flows) ? raw.flows : {}).some((f) => isObj(f) && Array.isArray(f.inputs) && f.inputs.includes(ANY));
}

/** The first model that still routes by its own settings, named for the error, or null. */
export function routedMarker(raw: Record<string, unknown>): string | null {
  for (const [id, m] of Object.entries(isObj(raw.models) ? raw.models : {})) {
    const key = isObj(m) ? MOVED_TO_FLOWS.find((k) => k in m) : undefined;
    if (key) return `models.${id}.${key}`;
  }
  return null;
}

/**
 * Each model's `policy`, `peers`, `spilloverAt`, `fallbackLocal` and `whenHeld` as the flow they
 * described, under `flows:` by the model's id. The model keeps everything else it sets.
 */
function routesToFlows(doc: Document, done: string[]): void {
  const raw = doc.toJS() as Record<string, unknown> | null;
  const models = isObj(raw?.models) ? raw.models : {};
  const peers = isObj(raw?.peers) ? raw.peers : {};
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
  // The peers an id can be sent to: the ones the model names, else every peer, that are borrowed from and map it.
  const mapping = (id: string, named: string[]) => (named.length ? named : Object.keys(peers))
    .filter((n) => isObj(peers[n]) && peers[n].url !== undefined && isObj(peers[n].models) && peers[n].models[id] !== undefined);
  const routed = (id: string): Flow | null => {
    const m = isObj(models[id]) ? models[id] : {};
    const policy = (typeof m.policy === "string" ? m.policy : "local") as "local" | "peer" | "spillover" | "fastest";
    return routedFlow(id, {
      policy, peers: mapping(id, list(m.peers)), fallbackLocal: m.fallbackLocal !== false,
      ...(typeof m.spilloverAt === "number" ? { spilloverAt: m.spilloverAt } : {}),
    });
  };
  for (const [id, m] of Object.entries(models)) {
    if (!isObj(m) || !MOVED_TO_FLOWS.some((k) => k in m)) continue;
    let flow = routed(id);
    if (typeof m.whenHeld === "string" && m.whenHeld !== "") {
      // The stand-in keeps its own routing, as a request for it would.
      const to = routed(m.whenHeld) ? { flow: m.whenHeld } : { model: m.whenHeld };
      const held = { when: { held: [id] }, to, lane: null, params: null, do: [] };
      flow = { inputs: [id], steps: [held, ...(flow?.steps ?? [{ when: null, to: { model: id }, lane: null, params: null, do: [] }])] };
    }
    if (flow) {
      if (doc.hasIn(["flows", id])) throw new Error(`models.${id} routes by its own settings and flows.${id} already exists — fold one into the other, then migrate`);
      doc.setIn(["flows", id], doc.createNode(rawFlow(flow)));
    }
    for (const k of MOVED_TO_FLOWS) doc.deleteIn(["models", id, k]);
    const left = doc.getIn(["models", id], true);
    if (isMap(left) && left.items.length === 0) doc.deleteIn(["models", id]);
    done.push(flow ? `models.${id} routing → flows.${id}` : `models.${id}: routing that sent nothing anywhere, removed`);
  }
}

/** Rewrite an older document in place; returns one line per change, for the CLI to print. */
export function migrateDoc(doc: Document): string[] {
  const done: string[] = [];
  const v1 = v1Marker((doc.toJS() ?? {}) as Record<string, unknown>) !== null;
  const move = (from: (string | number)[], to: (string | number)[]) => {
    const node = doc.getIn(from, true);
    if (node === undefined) return;
    doc.deleteIn(from);
    doc.setIn(to, node);
    done.push(`${from.join(".")} → ${to.join(".")}`);
  };

  for (const [k, to] of Object.entries(MOVED)) move([k], to);
  move(["scheduler", "concurrency"], ["backendDefaults", "concurrency"]);

  // `backend:` (one) and `backends:` (a list) both become a map keyed by name.
  // With both, which one was meant is the operator's call: `backend:` stays and the parser says so.
  const single = doc.get("backend", true);
  if (isMap(single) && !doc.has("backends")) {
    const name = String(single.get("name") ?? "default");
    single.delete("name");
    doc.delete("backend");
    doc.setIn(["backends", name], single);
    done.push(`backend → backends.${name}`);
  }
  listToMap(doc, "backends", done);
  const backends = doc.get("backends", true);
  if (isMap(backends)) {
    for (const pair of backends.items) {
      const b = pair.value;
      if (!isMap(b) || !b.has("llamaSwapExtras")) continue;
      const on = b.get("llamaSwapExtras") !== false;
      if (b.has("kind")) throw new Error("a backend sets kind and llamaSwapExtras, not both — keep kind, then migrate");
      b.delete("llamaSwapExtras");
      b.set("kind", on ? "llama-swap" : "none");
      done.push(`backends.${String(isScalar(pair.key) ? pair.key.value : pair.key)}.llamaSwapExtras → kind`);
    }
  }

  // One entry per peer: the token it presents to us joins the entry we borrow through.
  listToMap(doc, "peers", done);
  const tokens = doc.get("peerTokens", true);
  if (isMap(tokens)) {
    for (const pair of tokens.items) {
      const name = String(isScalar(pair.key) ? pair.key.value : pair.key);
      doc.setIn(["peers", name, "accept"], pair.value);
    }
    doc.delete("peerTokens");
    done.push("peerTokens.<name> → peers.<name>.accept");
  }

  // A note belongs to its model.
  const notes = doc.get("notes", true);
  if (isMap(notes)) {
    for (const pair of notes.items) {
      const id = String(isScalar(pair.key) ? pair.key.value : pair.key);
      doc.setIn(["models", id, "note"], pair.value);
    }
    doc.delete("notes");
    done.push("notes.<model> → models.<model>.note");
  }

  // `batch` was the older name for a model's concurrency.
  const models = doc.get("models", true);
  if (isMap(models)) {
    for (const pair of models.items) {
      const m = pair.value;
      if (!isMap(m) || !m.has("batch")) continue;
      if (!m.has("concurrency")) m.set("concurrency", m.get("batch", true));
      m.delete("batch");
      done.push(`models.${String(isScalar(pair.key) ? pair.key.value : pair.key)}.batch → concurrency`);
    }
  }
  const sched = doc.get("scheduler", true);
  if (isMap(sched) && sched.items.length === 0) doc.delete("scheduler");

  routesToFlows(doc, done);
  // A file from before names had to be offered keeps every one of them callable, as it was.
  if (unguarded((doc.toJS() ?? {}) as Record<string, unknown>)) {
    let name = "anything-else";
    for (let n = 2; doc.hasIn(["flows", name]); n++) name = `anything-else-${n}`;
    doc.setIn(["flows", name], doc.createNode({ note: "every name no other flow takes runs as itself", inputs: [ANY], steps: [{ to: { asked: true } }] }));
    done.push(`flows.${name}: names no other flow takes run as themselves, as before`);
  }

  // Moved keys land at the end; put a v1 file back in reading order. Comments ride on their pairs.
  const top = doc.contents;
  if (v1 && isMap(top)) {
    const rank = (k: unknown) => {
      const i = ORDER.indexOf(String(isScalar(k) ? k.value : k));
      return i === -1 ? ORDER.length : i;
    };
    top.items.sort((a, b) => rank(a.key) - rank(b.key));
  }
  // The file says which layout it is now in, first, so the next rewrite does not have to work it out.
  if (done.length > 0 && isMap(top)) {
    top.delete("version");
    const stamp = doc.createPair("version", CONFIG_VERSION);
    // What the file opens with stays what it opens with.
    const first = top.items[0]?.key;
    if (isScalar(first) && isScalar(stamp.key)) {
      stamp.key.commentBefore = first.commentBefore;
      first.commentBefore = undefined;
    }
    top.items.unshift(stamp);
  }
  return done;
}

/** v2's top level in the order a reader wants it: who this is, what it runs, how it shares. */
const ORDER = [
  "name", "listen", "resources", "backends", "backendDefaults", "models", "flows", "actions", "scheduler",
  "peers", "lending", "borrowing", "apiKeys", "operator", "maxBodyBytes", "shutdownGraceMs", "stateFile",
];

/** `[{name: a, ...}]` → `{a: {...}}`, keeping each entry's node and its comments. */
function listToMap(doc: Document, key: string, done: string[]): void {
  const seq = doc.get(key, true);
  if (!isSeq(seq)) return;
  // Made by the document, so it carries the schema later setIn calls need to add entries.
  const map = doc.createNode({}) as YAMLMap<unknown, Node>;
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const name = String(item.get("name") ?? "");
    // A map cannot hold the same name twice, so the second would silently replace the first.
    if (map.has(name)) throw new Error(`two ${key} are both named "${name}" — rename one, then migrate`);
    item.delete("name");
    map.set(name, item as Node);
  }
  map.commentBefore = seq.commentBefore;
  doc.set(key, map);
  done.push(`${key}: a list → a map keyed by name`);
}

/** The same rewrite on a plain object: test fixtures and anything else holding v1 as data. */
export function migrate(raw: unknown): unknown {
  if (!isObj(raw) || (v1Marker(raw) === null && routedMarker(raw) === null && !unguarded(raw))) return raw;
  const doc = new Document(raw);
  migrateDoc(doc);
  return doc.toJS();
}
