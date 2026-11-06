/**
 * hearth.yaml as the only config state. Every edit is written into the file (comments and
 * styles kept), validated by parseConfig, then applied to the running node: live where the
 * code reads it per call, otherwise listed as waiting for a restart. Hand edits are picked
 * up by a watcher the same way. There is no second layer to fall out of sync with the file.
 */
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, watch,
  writeFileSync, type FSWatcher,
} from "node:fs";
import { basename, dirname } from "node:path";

import { isMap, isScalar, parseDocument, type Document } from "yaml";

import { Refusal } from "./admit.js";
import { ConfigError, endsOf, parseConfig, peersMapping, rawFlow, type Flow, type FlowEnd, type HearthConfig, type RoutePolicy } from "./config.js";
import { routedFlow } from "./route.js";
import type { Logger } from "./log.js";

/** Keys the running node reads per call, so a new value takes effect on the next request. */
const LIVE_KEYS = [
  "models", "share", "notes", "apiKeys", "apiKeyLabels", "apiKeyModels", "apiKeyRules", "peerTokens", "peerTailnet",
  "peerRateLimit", "peerLane", "peerMaxConcurrent", "lendTokensPerDay", "peerTerms", "maxBodyBytes", "peerFreshMs", "peerDownMs",
  "peerStaleMs", "peerFirstByteMs", "backendFirstByteMs", "backendIdleMs", "backendRestMs", "coldPenalty", "shutdownGraceMs",
  "operator", "layout", "flows", "routers", "callers", "actions", "modelHeader", "updateCheck", "peers", "modelKinds",
] as const satisfies readonly (keyof HearthConfig)[];

/** Restart-only internal keys whose hearth.yaml name differs, for "restart to apply …". */
const YAML_NAME: Record<string, string> = { peerPollMs: "borrowing.pollMs" };

/** Live keys that stay frozen once applied, as the fixed config is. */
const FROZEN_LIVE = new Set<string>(["apiKeys", "apiKeyLabels", "apiKeyModels", "apiKeyRules", "peerTokens", "peerTailnet", "operator"]);

export function deepFreeze(v: unknown): void {
  if (v === null || typeof v !== "object" || Object.isFrozen(v)) return;
  Object.freeze(v);
  for (const x of Object.values(v)) deepFreeze(x);
}

/** Keys that never count as a change to the node. */
const IGNORED = new Set<string>(["configPath", "stateFile"]);


/** One edit to the YAML document: set `value` at `path`, or delete it. */
export interface ConfigOp {
  path: (string | number)[];
  value?: unknown;
  delete?: true;
  /** Rename the map key at `path`, keeping its value, comments and layout. */
  rename?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A secret (an apiKeys entry, a peer token, a backend's key) never reaches a console — not in a form, not in the
 * YAML tab. Each one is read back as a stand-in; the stand-in then travels with an edit: left
 * standing, it is written back as the original, replaced, and the new value takes its place.
 */
const SECRET = "hearth-secret";

const HAS_STANDIN = /hearth-secret\d+/;
const IS_STANDIN = /^hearth-secret\d+$/;
type Path = (string | number)[];

/** Every place a secret sits in the file, in one order: the table, the masking and the way home all walk this. */
function secretPaths(d: Record<string, unknown>): Path[] {
  const out: Path[] = [];
  const each = (v: unknown, f: (name: string, o: Record<string, unknown>) => void): void => {
    if (isObj(v)) for (const [name, o] of Object.entries(v)) if (isObj(o)) f(name, o);
  };
  const headers = (h: unknown, at: Path): void => {
    if (isObj(h)) for (const name of Object.keys(h)) out.push([...at, name]);
  };
  // An apiKeys entry is a bare key or {key, label, models}.
  if (Array.isArray(d.apiKeys)) d.apiKeys.forEach((e, i) => out.push(isObj(e) ? ["apiKeys", i, "key"] : ["apiKeys", i]));
  each(d.peers, (name) => out.push(["peers", name, "token"], ["peers", name, "accept"]));
  // Only a hash, but one that can be attacked offline, and nothing on the page needs it.
  out.push(["operator", "passHash"]);
  each(d.backends, (name, b) => { out.push(["backends", name, "key"]); headers(b.headers, ["backends", name, "headers"]); });
  // What a webhook is sent to prove who is calling.
  each(d.actions, (name, a) => headers(a.headers, ["actions", name, "headers"]));
  if (isObj(d.canary) && isObj(d.canary.notify)) headers(d.canary.notify.headers, ["canary", "notify", "headers"]);
  return out;
}

const valueAt = (d: unknown, path: Path): unknown =>
  path.reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? (v as Record<string | number, unknown>)[k] : undefined), d);
/** A secret that is in the file; `env:NAME` entries are already out of it. */
const held = (v: unknown): v is string => typeof v === "string" && v !== "" && !v.startsWith("env:");

/** One stand-in per secret in the file, in the order of `secretPaths`. */
function secretTable(doc: unknown): Map<string, string> {
  const table = new Map<string, string>();
  if (!isObj(doc)) return table;
  let n = 0;
  for (const path of secretPaths(doc)) {
    const v = valueAt(doc, path);
    if (held(v)) table.set(`${SECRET}${++n}`, v);
  }
  return table;
}

/** Each `[from, to, text]` written over the source, last first so earlier offsets hold. */
function splice(text: string, cuts: [number, number, string][]): string {
  let out = text;
  for (const [from, to, put] of cuts.sort((x, y) => y[0] - x[0])) out = out.slice(0, from) + put + out.slice(to);
  return out;
}

function maskSecrets(text: string, doc: Record<string, unknown>): { text: string; doc: unknown } {
  const d = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  const src = parseDocument(text);
  const cuts: [number, number, string][] = [];
  const loose: [string, string][] = [];
  let n = 0;
  for (const path of secretPaths(d)) {
    const v = valueAt(d, path);
    if (!held(v)) continue;
    const standIn = `${SECRET}${++n}`;
    (valueAt(d, path.slice(0, -1)) as Record<string | number, unknown>)[path[path.length - 1]!] = standIn;
    const node = src.getIn(path, true);
    if (isScalar(node) && node.range) cuts.push([node.range[0], node.range[1], standIn]);
    else loose.push([v, standIn]);
  }
  if (n === 0) return { text, doc };
  let masked = splice(text, cuts);
  // A secret with no scalar of its own in the text (an alias) is taken out wherever it is written.
  for (const [secret, standIn] of loose) masked = masked.split(secret).join(standIn);
  return { text: masked, doc: d };
}

/** A config file's text with every secret in it replaced by a stand-in; text that is not YAML comes back as it is. */
export function maskedText(text: string): string {
  let doc: unknown;
  try {
    doc = parseDocument(text).toJS();
  } catch {
    return text;
  }
  return isObj(doc) ? maskSecrets(text, doc).text : text;
}

/** A string as a YAML scalar that reads back as that string wherever it is put. */
const scalarOf = (s: string): string =>
  /^[\w./+=:@-]+$/.test(s) && !s.endsWith(":") && parseDocument(s).toJS() === s ? s : JSON.stringify(s);

/** The first value or key outside a secret's place that carries a stand-in, as a dotted path. */
function strayStandIn(v: unknown, path: Path, own: Set<string>): string | null {
  if (typeof v === "string") return HAS_STANDIN.test(v) && !own.has(JSON.stringify(path)) ? path.join(".") : null;
  if (typeof v !== "object" || v === null) return null;
  for (const [k, x] of Array.isArray(v) ? v.entries() : Object.entries(v)) {
    if (typeof k === "string" && HAS_STANDIN.test(k)) return [...path, k].join(".");
    const found = strayStandIn(x, [...path, k], own);
    if (found !== null) return found;
  }
  return null;
}

/**
 * A file the console sent back: every stand-in left standing where a secret goes comes home as
 * the original. Anywhere else it is refused, or a stand-in typed into a field the page shows
 * would read the secret out.
 */
function unmaskSecrets(text: string, table: Map<string, string>): string {
  let d: unknown;
  const src = parseDocument(text);
  try {
    d = src.toJS();
  } catch {
    return text;
  }
  // A file that does not parse is refused whole by the commit; nothing of it is written.
  if (src.errors.length > 0 || !isObj(d)) return text;
  const paths = secretPaths(d);
  const stray = strayStandIn(d, [], new Set(paths.map((p) => JSON.stringify(p))));
  if (stray !== null) throw new ConfigRefusal(422, `${stray} carries the stand-in for a secret, which only goes back where a secret is kept`, stray);
  const cuts: [number, number, string][] = [];
  for (const path of paths) {
    const v = valueAt(d, path);
    if (typeof v !== "string" || !IS_STANDIN.test(v)) continue;
    const at = path.join(".");
    const secret = table.get(v);
    const node = src.getIn(path, true);
    if (secret === undefined || !isScalar(node) || !node.range) throw new ConfigRefusal(422, `${at} is a stand-in this node did not hand out for this file; enter the value itself`, at);
    cuts.push([node.range[0], node.range[1], scalarOf(secret)]);
  }
  return splice(text, cuts);
}

export interface ConfigStatus {
  /** The file every edit lands in, or null for a node built in code (edits are then in memory only). */
  path: string | null;
  /** Hash of the file as last read or written; send it back as `baseHash`. */
  hash: string;
  savedAt: string | null;
  /** Top-level keys that differ from what is running and only apply on restart. */
  restartPending: string[];
  /** Why the file on disk does not load, while the node keeps running the last good one. */
  error: string | null;
}

export interface CommitResult {
  hash: string;
  text: string;
  restartPending: string[];
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** A refusal that carries the field it is about, straight from the ConfigError it came from. */
export class ConfigRefusal extends Refusal {
  constructor(status: number, message: string, readonly path: string | null = null) {
    super(status, message);
  }
}

/** A version of the file that was written through the node: when, the name it was given (may be empty), and its hash. */
export interface Version { at: string; name: string; hash: string }
/** How many versions are kept; older ones go. */
const KEEP_VERSIONS = 50;

/** Write via temp file, fsync and rename, keeping the file's mode; in place where only the file is writable. */
export function writeFileAtomic(path: string, text: string): void {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    // A new file gets owner-only, since a config may hold secrets.
  }
  const tmp = `${path}.hearth-tmp`;
  let staged = false;
  try {
    const fd = openSync(tmp, "w", mode);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    staged = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EROFS" && code !== "EACCES" && code !== "EPERM") throw e;
  }
  if (!staged) {
    writeFileSync(path, text);
    return;
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/* ------------------------------------------------- edits on a parsed draft */

/**
 * Map one of our ids to a peer's and send its requests there. An id no flow takes yet gets one in
 * the shape `policy` names; one that is already routed keeps its flow, which gains this peer.
 */
export function link(cfg: HearthConfig, peer: string, mine: string, theirs: string, policy: RoutePolicy, fallbackLocal: boolean): void {
  const p = cfg.peers.find((x) => x.name === peer);
  if (!p) {
    throw new ConfigError(
      null,
      `"${peer}" is not a configured peer (${cfg.peers.map((x) => x.name).join(", ") || "none"})`,
    );
  }
  if (mine === "" || theirs === "") throw new ConfigError(null, "both model ids are required");
  p.models[mine] = theirs;
  const taken = Object.values(cfg.flows).find((f) => f.inputs.includes(mine));
  if (!taken) {
    const flow = routedFlow(mine, { policy, peers: [peer], fallbackLocal });
    // A name already used by a flow that takes other ids gets one beside it.
    let name = mine;
    for (let n = 2; name in cfg.flows; n++) name = `${mine}-${n}`;
    if (flow) cfg.flows[name] = flow;
    return;
  }
  const sends = (e: FlowEnd) => "peer" in e && e.peer === peer && (e.model ?? mine) === mine;
  if (taken.steps.some((s) => endsOf(s.to).some(sends))) return;
  // Beside the peers it already tries: in the choice of the fastest when there is one, else as a step ahead of the last.
  const choice = taken.steps.find((s) => "fastest" in s.to);
  if (choice && "fastest" in choice.to) choice.to.fastest.push({ peer, model: mine });
  else taken.steps.splice(-1, 0, { when: null, to: { peer, model: mine }, lane: null, params: null, do: [] });
}

/** Remove a mapping, and with it every step that sent the id to that peer. */
export function unlink(cfg: HearthConfig, peer: string, mine: string): void {
  const p = cfg.peers.find((x) => x.name === peer);
  if (!p) throw new ConfigError(null, `"${peer}" is not a configured peer`);
  delete p.models[mine];
  pruneUnmapped(cfg);
}

/**
 * Take out of every flow what a peer can no longer be sent: a step or a candidate for an id that
 * peer does not map. A flow left doing nothing but running its own id here, or refusing it, goes.
 */
function pruneUnmapped(cfg: HearthConfig): void {
  const maps = (peer: string, id: string) => cfg.peers.find((x) => x.name === peer)?.models[id] !== undefined;
  for (const [name, flow] of Object.entries(cfg.flows)) {
    const before = JSON.stringify(flow);
    // An id this flow takes that a peer step can no longer be sent as goes back to running as itself.
    const open = flow.steps.flatMap((s) => endsOf(s.to)).filter((e): e is Extract<FlowEnd, { peer: string }> => "peer" in e && e.model === null);
    if (flow.inputs.length > 1) flow.inputs = flow.inputs.filter((id) => open.every((e) => maps(e.peer, id)));
    const dead = (e: FlowEnd) => "peer" in e && (e.model === null ? flow.inputs.some((id) => !maps(e.peer, id)) : !maps(e.peer, e.model));
    flow.steps = flow.steps.flatMap((s): Flow["steps"] => {
      if ("flow" in s.to || "refuse" in s.to || "asked" in s.to || "plugin" in s.to) return [s];
      if (!("fastest" in s.to)) return dead(s.to) ? [] : [s];
      const left = s.to.fastest.filter((e) => !dead(e));
      return left.length === 0 ? [] : [{ ...s, to: left.length === 1 ? left[0]! : { fastest: left } }];
    });
    if (JSON.stringify(flow) === before) continue;
    const idle = flow.steps.every((s) => "refuse" in s.to || (!("flow" in s.to) && !("plugin" in s.to) && !("fastest" in s.to) && !("peer" in s.to) && ("asked" in s.to || flow.inputs.includes(s.to.model)) && s.do.length === 0 && s.params === null && s.lane === null));
    if (flow.steps.length === 0 || flow.inputs.length === 0 || idle) { delete cfg.flows[name]; continue; }
    // What is left still has to end in a step that always applies.
    const last = flow.steps.at(-1)!;
    flow.steps[flow.steps.length - 1] = { ...last, when: null };
    delete flow.steps[flow.steps.length - 1]!.max;
  }
}

export function setNote(cfg: HearthConfig, model: string, text: string | null): void {
  const notes = (cfg.notes ??= {});
  if (text === null || text.trim() === "") delete notes[model];
  else notes[model] = text.trim();
}

/**
 * Lend or withhold one model; new ids append, existing order is kept. Withheld, it leaves each
 * peer's own list too: that list stands in for the node's, and would go on lending it.
 */
export function setShare(cfg: HearthConfig, model: string, on: boolean): void {
  if (on && !cfg.share.includes(model)) cfg.share = [...cfg.share, model];
  if (on) return;
  cfg.share = cfg.share.filter((m) => m !== model);
  for (const terms of Object.values(cfg.peerTerms)) if (terms.models) terms.models = terms.models.filter((m) => m !== model);
}

/**
 * Write what changed between two parsed configs into the YAML document, touching only the share
 * list, peers' own lists and model maps, flows, and notes — the fields edits move.
 */
function writeDiff(doc: Document, before: HearthConfig, after: HearthConfig, where: string): void {
  /** Replace a list, keeping its flow or block style. */
  const setList = (path: string[], value: string[]) => {
    const old = doc.getIn(path, true) as { flow?: boolean } | undefined;
    const node = doc.createNode(value) as { flow?: boolean };
    if (old && typeof old.flow === "boolean") node.flow = old.flow;
    doc.setIn(path, node);
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  if (!same(before.share, after.share)) setList(["lending", "models"], after.share);
  for (const [name, terms] of Object.entries(after.peerTerms)) {
    if (terms.models && !same(before.peerTerms[name]?.models, terms.models)) setList(["peers", name, "lend", "models"], [...terms.models]);
  }

  for (const p of after.peers) {
    const was = before.peers.find((x) => x.name === p.name)?.models ?? {};
    if (same(was, p.models)) continue;
    // Refuse rather than skip: an anchored `peers:` would drop the edit and still report saved.
    if (!(doc.getIn(["peers", p.name], true))) {
      throw new ConfigError(`peers.${p.name}.models`, `cannot find peer "${p.name}" as a plain entry under peers: in ${where}`);
    }
    for (const mine of Object.keys(was)) if (!(mine in p.models)) doc.deleteIn(["peers", p.name, "models", mine]);
    for (const [mine, theirs] of Object.entries(p.models)) {
      if (was[mine] !== theirs) doc.setIn(["peers", p.name, "models", mine], theirs);
    }
  }

  for (const name of new Set([...Object.keys(before.flows), ...Object.keys(after.flows)])) {
    const now = after.flows[name];
    if (same(before.flows[name], now)) continue;
    if (now) doc.setIn(["flows", name], doc.createNode(rawFlow(now)));
    else {
      doc.deleteIn(["flows", name]);
      const left = doc.getIn(["flows"], true) as { items?: unknown[] } | undefined;
      if (left && Array.isArray(left.items) && left.items.length === 0) doc.delete("flows");
    }
  }

  const wasNotes = before.notes ?? {};
  const nowNotes = after.notes ?? {};
  for (const m of new Set([...Object.keys(wasNotes), ...Object.keys(nowNotes)])) {
    if (wasNotes[m] === nowNotes[m]) continue;
    if (nowNotes[m] === undefined) { doc.deleteIn(["models", m, "note"]); dropIfEmpty(m); }
    else doc.setIn(["models", m, "note"], nowNotes[m]);
  }

  /** A model entry left with nothing in it goes, rather than staying as `id: {}`. */
  function dropIfEmpty(id: string): void {
    const node = doc.getIn(["models", id], true) as { items?: unknown[] } | undefined;
    if (node && Array.isArray(node.items) && node.items.length === 0) doc.deleteIn(["models", id]);
  }
}

/* --------------------------------------------------------------- the file */

export class ConfigFile {
  /** What is running for keys that only apply at restart, as JSON, captured at boot. */
  private readonly running: Record<string, string>;
  private lastText = "";
  private hash = "";
  private savedAt: string | null = null;
  private error: string | null = null;
  private pending: string[] = [];
  /** The plugins the file names, once it has been read since startup; null until then. */
  private onDisk: HearthConfig["plugins"] | null = null;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly live: HearthConfig,
    private readonly log: Logger,
    /** Called after anything applied, so status surfaces push the new state. */
    private readonly onChange: () => void = () => {},
  ) {
    this.running = Object.fromEntries(
      Object.keys(live).filter((k) => !(LIVE_KEYS as readonly string[]).includes(k) && !IGNORED.has(k))
        .map((k) => [k, JSON.stringify(this.restartView(k, live))]),
    );
    if (live.configPath) {
      try {
        this.lastText = readFileSync(live.configPath, "utf8");
        this.hash = hashOf(this.lastText);
      } catch (e) {
        this.error = `cannot read ${live.configPath}: ${String(e)}`;
      }
    }
  }

  private get path(): string | null {
    return this.live.configPath;
  }

  /** What a restart-only key compares as. */
  private restartView(key: string, cfg: HearthConfig): unknown {
    return (cfg as unknown as Record<string, unknown>)[key];
  }

  /** The console's draft, kept beside the file so it outlasts a browser; null when there is none. */
  draft(): unknown {
    if (!this.path) return null;
    try {
      return JSON.parse(readFileSync(`${this.path}.draft.json`, "utf8"));
    } catch {
      return null;
    }
  }

  /** Keep a draft, or with null let go of the one kept. It is the console's to read: nothing here applies it. */
  keepDraft(draft: unknown): void {
    if (!this.path) throw new ConfigRefusal(409, "this node was not loaded from a config file, so there is nowhere to keep a draft", null);
    if (draft === null) rmSync(`${this.path}.draft.json`, { force: true });
    else writeFileAtomic(`${this.path}.draft.json`, JSON.stringify(draft));
  }

  /** The list as kept: a bare list, or `{v: 1, versions}`. Null for a file a later hearth wrote, which is left as it is. */
  private kept(): (Version & { text: string })[] | null {
    try {
      const all = JSON.parse(readFileSync(`${this.path}.versions.json`, "utf8")) as unknown;
      if (Array.isArray(all)) return all as (Version & { text: string })[];
      if (!isObj(all)) return [];
      if (all.v !== 1) return null;
      return Array.isArray(all.versions) ? all.versions as (Version & { text: string })[] : [];
    } catch {
      return [];
    }
  }

  /** What has been written through here, oldest first: when, and the name it was given. */
  versions(): Version[] {
    return this.path ? (this.kept() ?? []).map(({ text: _, ...v }) => v) : [];
  }

  /** Remember what was just written. A save never fails for want of its place in the list. */
  private remember(was: string, text: string, name: string): void {
    try {
      const all = this.kept();
      if (all === null) {
        this.log.warn("config.version_not_kept", { error: "the list of versions was written by a later hearth" });
        return;
      }
      // The file as it stood before the first change made here is somewhere to go back to as well.
      if (all.length === 0 && was) all.push({ at: new Date().toISOString(), name: "before the first change made here", hash: hashOf(was), text: was });
      all.push({ at: new Date().toISOString(), name, hash: hashOf(text), text });
      writeFileAtomic(`${this.path}.versions.json`, JSON.stringify(all.slice(-KEEP_VERSIONS)));
    } catch (e) {
      this.log.warn("config.version_not_kept", { error: String(e) });
    }
  }

  /** Write an earlier version back as the file, through the same checks as any other save. */
  restore(hash: string, dryRun: boolean): CommitResult {
    if (!this.path) throw new ConfigRefusal(409, "this node was not loaded from a config file, so there is no file to edit", null);
    const v = (this.kept() ?? []).findLast((x) => x.hash === hash);
    if (!v) throw new ConfigRefusal(404, "no version by that hash is kept", null);
    this.syncFromDisk();
    return this.commit(v.text, dryRun, `back to ${v.name || v.at}`);
  }

  /** The plugins in the file, where they differ from the running ones: what a restart would add, change or remove. */
  pluginChanges(): { name: string; change: "added" | "changed" | "removed" }[] {
    const disk = this.onDisk;
    const running = this.live.plugins;
    if (!disk) return [];
    type Change = { name: string; change: "added" | "changed" | "removed" };
    return [...new Set([...Object.keys(disk), ...Object.keys(running)])].flatMap((name): Change[] =>
      !(name in running) ? [{ name, change: "added" }]
      : !(name in disk) ? [{ name, change: "removed" }]
      : JSON.stringify(disk[name]) !== JSON.stringify(running[name]) ? [{ name, change: "changed" }] : []);
  }

  status(): ConfigStatus {
    return { path: this.path, hash: this.hash, savedAt: this.savedAt, restartPending: [...this.pending], error: this.error };
  }

  /**
   * The file's text, hash and parsed document, for editors; a file that does not load is returned
   * too, to be fixed. `env:` references are left unresolved, and secrets are stand-ins.
   */
  text(): { text: string; hash: string; doc: unknown } {
    try {
      this.syncFromDisk();
    } catch (e) {
      if (this.error === null) throw e;
    }
    let doc: unknown = null;
    try {
      doc = parseDocument(this.lastText).toJS();
    } catch {
      // Not YAML at all: the raw text is still there to fix.
    }
    const masked = isObj(doc) ? maskSecrets(this.lastText, doc) : { text: this.lastText, doc };
    return { text: masked.text, hash: this.hash, doc: masked.doc };
  }

  /**
   * Edit through the parsed config: `mutate` changes a copy of what is running, and what moved is
   * written into the file. For the console's verbs (share, link, notes), which think in routes.
   */
  update(mutate: (draft: HearthConfig) => void): CommitResult {
    this.syncFromDisk();
    const draft = structuredClone(this.live) as HearthConfig;
    try {
      mutate(draft);
    } catch (e) {
      throw e instanceof ConfigError ? new ConfigRefusal(400, e.message, e.path) : e;
    }
    if (!this.path) return this.applyInMemory(draft);
    const doc = parseDocument(this.lastText);
    try {
      writeDiff(doc, this.live, draft, this.path);
    } catch (e) {
      throw e instanceof ConfigError ? new ConfigRefusal(409, e.message, e.path) : e;
    }
    return this.commit(this.render(doc), false);
  }

  /**
   * Edit the YAML itself: path ops, or the whole text. `baseHash` is the file the caller last saw;
   * if it moved since, ops still apply when the paths they touch did not change, and text never does.
   */
  patch(req: { baseHash?: string; ops?: ConfigOp[]; text?: string; dryRun?: boolean; /** What to call this version in the list of them. */ name?: string }): CommitResult {
    if (!this.path) throw new ConfigRefusal(409, "this node was not loaded from a config file, so there is no file to edit", null);
    const base = this.lastText;
    const baseHash = this.hash;
    this.syncFromDisk();
    const moved = req.baseHash !== undefined && req.baseHash !== this.hash;
    // The stand-ins the caller's file was showing; what it sends back with them still standing is
    // the originals, and the console never writes one of its own into the file.
    const table = this.tableOf(base);

    let out: string;
    if (req.text !== undefined) {
      if (moved) throw this.conflict();
      out = unmaskSecrets(req.text, table);
    } else {
      const ops = req.ops ?? [];
      if (moved) {
        // Merge onto the fresh file only when we hold the caller's base and none of its paths moved.
        if (req.baseHash !== baseHash) throw this.conflict();
        const was = parseDocument(base);
        const now = parseDocument(this.lastText);
        for (const op of ops) {
          if (JSON.stringify(was.getIn(op.path)) !== JSON.stringify(now.getIn(op.path))) throw this.conflict();
        }
      }
      const doc = parseDocument(this.lastText);
      for (const op of ops) {
        if (!Array.isArray(op.path) || op.path.length === 0) throw new ConfigRefusal(400, "each op needs a non-empty path", null);
        if (op.delete) {
          doc.deleteIn(op.path);
          continue;
        }
        if (op.rename !== undefined) {
          const parent = doc.getIn(op.path.slice(0, -1), true);
          const key = op.path[op.path.length - 1];
          const pair = isMap(parent) ? parent.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key) : undefined;
          if (!pair || !isScalar(pair.key)) throw new ConfigRefusal(409, `nothing at ${op.path.join(".")} to rename`, null);
          if (typeof op.rename !== "string" || op.rename === "") throw new ConfigRefusal(400, "rename needs a non-empty name", null);
          if (isMap(parent) && parent.has(op.rename)) throw new ConfigRefusal(400, `${op.rename} already exists`, null);
          pair.key.value = op.rename;
          continue;
        }
        // A list or map written inline stays inline when replaced.
        const old = doc.getIn(op.path, true) as { flow?: boolean } | undefined;
        const node = doc.createNode(op.value) as { flow?: boolean };
        if (old && typeof old.flow === "boolean" && node && typeof node === "object") node.flow = old.flow;
        doc.setIn(op.path, node);
      }
      out = unmaskSecrets(this.render(doc), table);
    }
    return this.commit(out, req.dryRun === true, req.name);
  }

  /** What the file the caller last held was masking, so its stand-ins come home on the way in. */
  private tableOf(text: string): Map<string, string> {
    try {
      const doc = parseDocument(text).toJS();
      return isObj(doc) ? secretTable(doc) : new Map();
    } catch {
      return new Map();
    }
  }

  /** Validate, write, apply. Nothing is written unless the result loads, and nothing applies unless it was written. */
  private commit(text: string, dryRun: boolean, name = ""): CommitResult {
    const next = this.parse(text, 422);
    const masked = this.masked(text);
    if (dryRun) return { hash: hashOf(text), text: masked, restartPending: this.restartPendingFor(next) };
    if (text !== this.lastText) {
      try {
        writeFileAtomic(this.path!, text);
      } catch (e) {
        throw new ConfigRefusal(500, `could not write ${this.path}: ${String(e)} — nothing changed`, null);
      }
      this.remember(this.lastText, text, name);
      this.lastText = text;
      this.hash = hashOf(text);
      this.savedAt = new Date().toISOString();
      this.log.info("config.saved", { path: this.path, hash: this.hash, ...(name ? { name } : {}) });
    }
    this.apply(next);
    return { hash: this.hash, text: masked, restartPending: [...this.pending] };
  }

  /** The text a console sees back: the file's secrets out, stand-ins in. */
  private masked(text: string): string {
    return maskedText(text);
  }

  private applyInMemory(draft: HearthConfig): CommitResult {
    this.apply(draft);
    return { hash: this.hash, text: "", restartPending: [...this.pending] };
  }

  private parse(text: string, status: number): HearthConfig {
    let raw: unknown;
    try {
      const doc = parseDocument(text);
      if (doc.errors.length > 0) throw new ConfigError(null, `not valid YAML: ${doc.errors[0]!.message}`);
      raw = doc.toJS();
    } catch (e) {
      throw new ConfigRefusal(status, e instanceof Error ? e.message : String(e), null);
    }
    try {
      const cfg = parseConfig(raw);
      cfg.configPath = this.path;
      return cfg;
    } catch (e) {
      if (e instanceof ConfigError) throw new ConfigRefusal(status, e.message, e.path);
      throw new ConfigRefusal(status, e instanceof Error ? e.message : String(e), null);
    }
  }

  private render(doc: Document): string {
    // Untouched lines must not churn: the file's own flow spacing, and no folding of long lines.
    return doc.toString({ flowCollectionPadding: /[[{] \S/.test(this.lastText), lineWidth: 0 });
  }

  private conflict(): ConfigRefusal {
    return new ConfigRefusal(409, `${this.path} changed since you loaded it — reload to see the edit, then make yours again`, null);
  }

  /** Put a parsed config into the running node: live keys now, the rest into restartPending. */
  private apply(next: HearthConfig): void {
    const live = this.live as unknown as Record<string, unknown>;
    const fresh = next as unknown as Record<string, unknown>;
    for (const k of LIVE_KEYS) {
      if (JSON.stringify(live[k]) === JSON.stringify(fresh[k])) continue;
      // Credentials stay frozen like the rest of the fixed config; the rest are edited in place by nothing.
      if (FROZEN_LIVE.has(k)) deepFreeze(fresh[k]);
      live[k] = fresh[k];
    }
    this.pending = this.restartPendingFor(next);
    this.onDisk = next.plugins;
    this.error = null;
    this.onChange();
  }

  private restartPendingFor(next: HearthConfig): string[] {
    return Object.keys(this.running).filter((k) => JSON.stringify(this.restartView(k, next)) !== this.running[k])
      .map((k) => YAML_NAME[k] ?? k).sort();
  }

  /** Re-read the file; if someone else changed it, load that first so an edit builds on it. */
  private syncFromDisk(): void {
    if (!this.path) return;
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      throw new ConfigRefusal(500, `cannot read ${this.path}: ${String(e)}`, null);
    }
    if (text === this.lastText && this.error === null) return;
    if (text === this.lastText) throw new ConfigRefusal(409, `${this.path} does not load: ${this.error} — fix it first`, null);
    let next: HearthConfig;
    try {
      next = this.parse(text, 409);
    } catch (e) {
      this.lastText = text;
      this.hash = hashOf(text);
      this.error = e instanceof Error ? e.message : String(e);
      this.log.warn("config.invalid", { path: this.path, error: this.error, hint: "still running the last config that loaded" });
      this.onChange();
      throw new ConfigRefusal(409, `${this.path} does not load: ${this.error} — fix it first`, null);
    }
    this.lastText = text;
    this.hash = hashOf(text);
    this.apply(next);
    // A hand edit has no reply to carry restartPending, so the journal must say what is still waiting.
    if (this.pending.length) this.log.warn("config.reloaded", { path: this.path, hash: this.hash, restartPending: this.pending, hint: "restart hearth to apply these" });
    else this.log.info("config.reloaded", { path: this.path, hash: this.hash });
  }

  /** Pick up hand edits: watch the directory (editors replace files), debounced, ignoring our own writes. */
  watch(): void {
    if (!this.path || this.watcher) return;
    const name = basename(this.path);
    try {
      this.watcher = watch(dirname(this.path), (_event, file) => {
        if (file !== null && file !== name) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = null;
          try {
            this.syncFromDisk();
          } catch {
            // Logged and surfaced as status.error; the node keeps the last good config.
          }
        }, 300);
        this.debounce.unref?.();
      });
      this.watcher.unref?.();
    } catch (e) {
      this.log.warn("config.watch_failed", { path: this.path, error: String(e), hint: "hand edits load on the next console edit" });
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounce) clearTimeout(this.debounce);
  }

  /**
   * Fold a pre-2.0 sidecar (`stateFile`) into the file once, then retire it. Its deltas go through
   * the same edit path as the console's; unknown peers are dropped, as they always were.
   */
  migrateSidecar(stateFile: string): void {
    if (!existsSync(stateFile)) return;
    let saved: { share?: Record<string, boolean>; maps?: Record<string, Record<string, string | null>>; routes?: Record<string, { policy: RoutePolicy; peers: string[]; fallbackLocal: boolean } | null>; notes?: Record<string, string | null> };
    try {
      saved = JSON.parse(readFileSync(stateFile, "utf8")) as typeof saved;
    } catch (e) {
      this.log.warn("state.unreadable", { path: stateFile, error: String(e), hint: "left in place; nothing folded in" });
      return;
    }
    const fold = (d: HearthConfig) => {
      for (const [m, on] of Object.entries(saved.share ?? {})) setShare(d, m, on);
      for (const [name, entries] of Object.entries(saved.maps ?? {})) {
        const p = d.peers.find((x) => x.name === name);
        if (!p) continue;
        for (const [mine, theirs] of Object.entries(entries)) {
          if (theirs === null) delete p.models[mine];
          else p.models[mine] = theirs;
        }
      }
      // A route the sidecar held becomes the flow it described, for an id nothing routes yet.
      for (const [id, r] of Object.entries(saved.routes ?? {})) {
        if (r === null || Object.values(d.flows).some((f) => f.inputs.includes(id)) || id in d.flows) continue;
        const flow = routedFlow(id, { policy: r.policy, peers: peersMapping(id, r.peers, d.peers), fallbackLocal: r.fallbackLocal });
        if (flow) d.flows[id] = flow;
      }
      for (const [m, text] of Object.entries(saved.notes ?? {})) setNote(d, m, text);
      pruneUnmapped(d);
    };
    try {
      this.update(fold);
    } catch (e) {
      // Still honoured for this run, so a read-only file loses nothing it had before.
      this.log.warn("state.migrate_failed", { from: stateFile, error: String(e), hint: "applied in memory; make the config writable to fold it in" });
      const draft = structuredClone(this.live) as HearthConfig;
      fold(draft);
      this.applyInMemory(draft);
      return;
    }
    if (this.path) renameSync(stateFile, `${stateFile}.migrated`);
    this.log.info("state.migrated", { from: stateFile, into: this.path ?? "memory" });
  }
}
