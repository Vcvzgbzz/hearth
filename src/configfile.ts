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
import { ConfigError, parseConfig, peersMapping, type HearthConfig, type ModelRoute, type RoutePolicy } from "./config.js";
import type { Logger } from "./log.js";

/** Keys the running node reads per call, so a new value takes effect on the next request. */
const LIVE_KEYS = [
  "models", "share", "notes", "apiKeys", "apiKeyLabels", "apiKeyModels", "peerTokens",
  "peerRateLimit", "peerLane", "peerMaxConcurrent", "maxBodyBytes", "peerFreshMs", "peerDownMs",
  "peerStaleMs", "peerFirstByteMs", "backendFirstByteMs", "backendIdleMs", "coldPenalty", "shutdownGraceMs",
  "operator",
] as const satisfies readonly (keyof HearthConfig)[];

/** Restart-only internal keys whose hearth.yaml name differs, for "restart to apply …". */
const YAML_NAME: Record<string, string> = { peerPollMs: "borrowing.pollMs" };

/** Live keys that stay frozen once applied, as the fixed config is. */
const FROZEN_LIVE = new Set<string>(["apiKeys", "apiKeyLabels", "apiKeyModels", "peerTokens", "operator"]);

export function deepFreeze(v: unknown): void {
  if (v === null || typeof v !== "object" || Object.isFrozen(v)) return;
  Object.freeze(v);
  for (const x of Object.values(v)) deepFreeze(x);
}

/** Keys that never count as a change to the node. */
const IGNORED = new Set<string>(["configPath", "stateFile"]);

const DEFAULT_ROUTE: ModelRoute = {
  backend: null, as: null, follow: false, policy: "local", peers: [], spilloverAt: 1, whenHeld: null,
  fallbackLocal: true, concurrency: null, params: null, lane: null, stats: null, emulate: null, pool: null,
};

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
 * A secret (an apiKeys entry, a peer token) never reaches a console — not in a form, not in the
 * YAML tab. Each one is read back as a stand-in; the stand-in then travels with an edit: left
 * standing, it is written back as the original, replaced, and the new value takes its place.
 */
const SECRET = "hearth-secret";

/** One stand-in per secret in the file, in file order; `env:NAME` entries are already out of the file. */
function secretTable(doc: unknown): Map<string, string> {
  const d = (doc ?? {}) as Record<string, unknown>;
  const table = new Map<string, string>();
  let n = 0;
  const grab = (v: unknown): void => {
    if (typeof v === "string" && v !== "" && !v.startsWith("env:")) table.set(`${SECRET}${++n}`, v);
  };
  // An apiKeys entry is a bare key or {key, label, models}; the secret sits in the same place either way.
  for (const e of (d.apiKeys ?? []) as unknown[]) {
    if (typeof e === "string") grab(e);
    else if (isObj(e)) grab(e.key);
  }
  if (isObj(d.peers)) for (const p of Object.values(d.peers)) if (isObj(p)) { grab(p.token); grab(p.accept); }
  // Only a hash, but one that can be attacked offline, and nothing on the page needs it.
  if (isObj(d.operator)) grab(d.operator.passHash);
  return table;
}

function maskSecrets(text: string, doc: unknown): { text: string; doc: unknown } {
  const table = secretTable(doc);
  if (table.size === 0) return { text, doc };
  const d = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  let n = 0;
  // Must skip exactly what secretTable skipped, or the stand-ins misalign.
  const swap = (v: unknown): unknown =>
    typeof v === "string" && v !== "" && !v.startsWith("env:") ? `${SECRET}${++n}` : v;
  const keys = d.apiKeys as unknown[] | undefined;
  if (Array.isArray(keys))
    for (let i = 0; i < keys.length; i++) {
      const e = keys[i];
      if (typeof e === "string") keys[i] = swap(e);
      else if (isObj(e)) e.key = swap(e.key);
    }
  if (isObj(d.peers)) {
    for (const p of Object.values(d.peers)) {
      if (!isObj(p)) continue;
      if (p.token !== undefined) p.token = swap(p.token);
      if (p.accept !== undefined) p.accept = swap(p.accept);
    }
  }
  if (isObj(d.operator)) d.operator.passHash = swap(d.operator.passHash);
  let masked = text;
  for (const [m, s] of table) masked = masked.split(s).join(m);
  return { text: masked, doc: d };
}

/** A file the console sent back: every stand-in it left standing comes home as the original. */
function unmaskSecrets(text: string, table: Map<string, string>): string {
  let out = text;
  for (const [m, s] of table) out = out.split(m).join(s);
  return out;
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

/** Map one of our ids to a peer's and route it there; a route naming its peers gains this one, never widens. */
export function link(cfg: HearthConfig, peer: string, mine: string, theirs: string, policy: RoutePolicy, fallbackLocal: boolean): void {
  const p = cfg.peers.find((x) => x.name === peer);
  if (!p) {
    throw new ConfigError(
      null,
      `"${peer}" is not a configured peer (${cfg.peers.map((x) => x.name).join(", ") || "none"})`,
    );
  }
  if (mine === "" || theirs === "") throw new ConfigError(null, "both model ids are required");
  const prev = cfg.models[mine];
  p.models[mine] = theirs;
  const peers = prev && prev.peers.length > 0 && !prev.peers.includes(peer) ? [...prev.peers, peer] : (prev?.peers ?? []);
  cfg.models[mine] = { ...DEFAULT_ROUTE, ...prev, policy, peers, fallbackLocal };
}

/** Remove a mapping, and retire any route nothing it names still maps; an emptied peer list is dead, not open. */
export function unlink(cfg: HearthConfig, peer: string, mine: string): void {
  const p = cfg.peers.find((x) => x.name === peer);
  if (!p) throw new ConfigError(null, `"${peer}" is not a configured peer`);
  delete p.models[mine];
  const route = cfg.models[mine];
  if (route && route.peers.includes(peer)) {
    const rest = route.peers.filter((n) => n !== peer);
    if (rest.length === 0) retireRoute(cfg, mine);
    else route.peers = rest;
  }
  pruneDeadRoutes(cfg);
}

/** Stop a route sending work away: delete it if it is only a policy, else demote it to local and keep its settings. */
function retireRoute(cfg: HearthConfig, id: string): void {
  const r = cfg.models[id];
  if (!r) return;
  const onlyAPolicy = r.backend === null && r.as === null && r.concurrency === null && r.spilloverAt === 1
    && r.params === null && r.lane === null && r.stats === null;
  if (onlyAPolicy) delete cfg.models[id];
  else cfg.models[id] = { ...r, policy: "local", peers: [] };
}

function pruneDeadRoutes(cfg: HearthConfig): void {
  for (const [id, route] of Object.entries(cfg.models)) {
    if (route.policy !== "local" && peersMapping(id, route.peers, cfg.peers).length === 0) retireRoute(cfg, id);
  }
}

export function setNote(cfg: HearthConfig, model: string, text: string | null): void {
  const notes = (cfg.notes ??= {});
  if (text === null || text.trim() === "") delete notes[model];
  else notes[model] = text.trim();
}

/** Lend or withhold one model; new ids append, existing order is kept. */
export function setShare(cfg: HearthConfig, model: string, on: boolean): void {
  if (on && !cfg.share.includes(model)) cfg.share = [...cfg.share, model];
  if (!on) cfg.share = cfg.share.filter((m) => m !== model);
}

/**
 * Write what changed between two parsed configs into the YAML document, touching only the share
 * list, peers' model maps, routes' policy/peers/fallbackLocal, and notes — the fields edits move.
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

  for (const id of new Set([...Object.keys(before.models), ...Object.keys(after.models)])) {
    const was = before.models[id];
    const now = after.models[id];
    if (!now) {
      // A retired route keeps its note: the note describes the model, not where it runs.
      if (was) for (const k of Object.keys(was)) if (k !== "note") doc.deleteIn(["models", id, k]);
      dropIfEmpty(id);
      continue;
    }
    if (was && was.policy === now.policy && was.fallbackLocal === now.fallbackLocal && same(was.peers, now.peers)) continue;
    doc.setIn(["models", id, "policy"], now.policy);
    if (now.peers.length) setList(["models", id, "peers"], now.peers);
    else doc.deleteIn(["models", id, "peers"]);
    // Only when not the default, so the file does not accumulate restatements.
    if (now.fallbackLocal) doc.deleteIn(["models", id, "fallbackLocal"]);
    else doc.setIn(["models", id, "fallbackLocal"], false);
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

  /** What a restart-only key compares as; for peers, everything but their model maps (those apply live). */
  private restartView(key: string, cfg: HearthConfig): unknown {
    if (key === "peers") return cfg.peers.map(({ models: _m, ...rest }) => rest);
    return (cfg as unknown as Record<string, unknown>)[key];
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
  patch(req: { baseHash?: string; ops?: ConfigOp[]; text?: string; dryRun?: boolean }): CommitResult {
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
    return this.commit(out, req.dryRun === true);
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
  private commit(text: string, dryRun: boolean): CommitResult {
    const next = this.parse(text, 422);
    const masked = this.masked(text);
    if (dryRun) return { hash: hashOf(text), text: masked, restartPending: this.restartPendingFor(next) };
    if (text !== this.lastText) {
      try {
        writeFileAtomic(this.path!, text);
      } catch (e) {
        throw new ConfigRefusal(500, `could not write ${this.path}: ${String(e)} — nothing changed`, null);
      }
      this.lastText = text;
      this.hash = hashOf(text);
      this.savedAt = new Date().toISOString();
      this.log.info("config.saved", { path: this.path, hash: this.hash });
    }
    this.apply(next);
    return { hash: this.hash, text: masked, restartPending: [...this.pending] };
  }

  /** The text a console sees back: the file's secrets out, stand-ins in. */
  private masked(text: string): string {
    let doc: unknown;
    try {
      doc = parseDocument(text).toJS();
    } catch {
      return text;
    }
    return isObj(doc) ? maskSecrets(text, doc).text : text;
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
    // Peer model maps apply in place on the objects the registry already holds; adding or changing a peer waits.
    for (const p of this.live.peers) {
      const n = next.peers.find((x) => x.name === p.name);
      if (n && JSON.stringify(n.models) !== JSON.stringify(p.models)) p.models = n.models;
    }
    this.pending = this.restartPendingFor(next);
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
      for (const [id, r] of Object.entries(saved.routes ?? {})) {
        if (r === null) delete d.models[id];
        else d.models[id] = { ...DEFAULT_ROUTE, ...d.models[id], ...r };
      }
      for (const [m, text] of Object.entries(saved.notes ?? {})) setNote(d, m, text);
      pruneDeadRoutes(d);
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
