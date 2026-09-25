/**
 * Runtime edits to a peer's model map and the route that sends work there; both halves move
 * together, since a mapping alone never routes. Edits mutate the live config (so they apply
 * at once) and persist only when saved, to the sidecar or the config file.
 */
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { parseDocument } from "yaml";

import { ConfigError, parseConfig, type HearthConfig, type ModelRoute, type RoutePolicy } from "./config.js";
import type { Logger } from "./log.js";
import { yamlScalar as y } from "./yamlq.js";

export interface MapChange {
  peer: string;
  /** my id */
  mine: string;
  /** their id, or null when the mapping was removed */
  theirs: string | null;
  was: string | null;
}

export interface RouteChange {
  model: string;
  policy: RoutePolicy | null;
  peers: string[];
  fallbackLocal: boolean;
  /** True when this route did not exist in the file at all. */
  added: boolean;
  removed: boolean;
}

export interface Changes {
  maps: MapChange[];
  routes: RouteChange[];
  /** A note set or cleared since the file was read; null is cleared. */
  notes: { model: string; text: string | null }[];
}

/** A route as it is stored. Only the fields the console can set — the rest
 *  (`backend`, `as`, `concurrency`) are properties of your backends, and a sidecar
 *  quietly restating them is how a config edit stops taking effect. */
export interface SavedRoute {
  policy: RoutePolicy;
  peers: string[];
  fallbackLocal: boolean;
}

/** The sidecar: deltas only (`null` removed, absent = config decides), so later config edits still apply. */
export interface SavedState {
  version: 1;
  savedAt: string;
  share: Record<string, boolean>;
  maps: Record<string, Record<string, string | null>>;
  routes: Record<string, SavedRoute | null>;
  notes?: Record<string, string | null>;
}

/** Read the sidecar, or null. A corrupt one is logged, not fatal: the config alone always runs. */
export function readState(path: string, log: Logger): SavedState | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as Partial<SavedState>;
    if (raw.version !== 1) throw new Error(`unknown version ${String(raw.version)}`);
    return {
      version: 1,
      savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
      share: raw.share ?? {},
      maps: raw.maps ?? {},
      routes: raw.routes ?? {},
      notes: raw.notes ?? {},
    };
  } catch (e) {
    log.warn("state.unreadable", {
      path,
      error: String(e),
      hint: "ignoring it and starting from the config; the next save will overwrite it",
    });
    return null;
  }
}

/** Write it atomically via a temp file, or delete it when the state is empty. */
export function writeState(path: string, state: SavedState): void {
  const empty =
    Object.keys(state.share).length === 0 &&
    Object.keys(state.maps).length === 0 &&
    Object.keys(state.routes).length === 0 &&
    Object.keys(state.notes ?? {}).length === 0;
  if (empty) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // Same staging discipline as the config write: flushed before the rename, so
  // the name never points at bytes that are not on disk yet.
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

const DEFAULT_ROUTE: ModelRoute = {
  backend: null,
  as: null,
  policy: "local",
  peers: [],
  spilloverAt: 1,
  fallbackLocal: true,
  concurrency: null,
  params: null,
  lane: null,
  stats: null,
  emulate: null,
  pool: null,
};

export class Overrides {
  /** What the file said, cloned before anything is allowed to touch it. */
  private readonly baseMaps: Map<string, Record<string, string>>;
  private readonly baseRoutes: Map<string, ModelRoute>;

  /** JSON of the last state written or restored, seeded empty, for the unsaved check. */
  private savedBlob: string;

  /** The config file's mtime when we last read it, to refuse a Save over someone's edit. */
  private configMtimeMs = 0;

  constructor(private readonly cfg: HearthConfig) {
    if (cfg.configPath) {
      try {
        this.configMtimeMs = statSync(cfg.configPath).mtimeMs;
      } catch {
        // Unreadable now means unwritable later, and saveConfig says so with a
        // better message than a number remembered from startup would.
      }
    }
    this.savedBlob = this.blob({ version: 1, savedAt: "", share: {}, maps: {}, routes: {} });
    this.baseMaps = new Map(cfg.peers.map((p) => [p.name, { ...p.models }]));
    this.baseRoutes = new Map(Object.entries(cfg.models).map(([id, r]) => [id, { ...r }]));
    this.baseNotes = { ...cfg.notes };
  }

  private baseNotes: Record<string, string>;

  /** Set or clear one model's note, live. Saved like everything else here. */
  setNote(model: string, text: string | null): void {
    const notes = (this.cfg.notes ??= {});
    if (text === null || text.trim() === "") delete notes[model];
    else notes[model] = text.trim();
  }

  /** Re-apply a saved state after the baseline is taken, so restored edits still show as differing. */
  restore(state: SavedState, log: Logger): void {
    for (const [name, entries] of Object.entries(state.maps)) {
      const p = this.cfg.peers.find((x) => x.name === name);
      if (!p) {
        // The peer was removed from the config since. Dropping its saved
        // mappings is the only coherent answer: the trust decision that made it
        // a peer has been withdrawn, and a sidecar must not put it back.
        log.warn("state.peer_gone", { peer: name, hint: "dropping its saved mappings" });
        continue;
      }
      for (const [mine, theirs] of Object.entries(entries)) {
        if (theirs === null) delete p.models[mine];
        else p.models[mine] = theirs;
      }
    }
    for (const [id, r] of Object.entries(state.routes)) {
      if (r === null) delete this.cfg.models[id];
      else this.cfg.models[id] = { ...DEFAULT_ROUTE, ...this.cfg.models[id], ...r };
    }
    for (const [model, text] of Object.entries(state.notes ?? {})) this.setNote(model, text);
    this.pruneDeadRoutes();
    this.markSaved(state);
  }

  /** Everything overridden right now, as stored. Share overrides come from Controls. */
  pending(share: Record<string, boolean>): SavedState {
    const c = this.changes();
    const maps: Record<string, Record<string, string | null>> = {};
    for (const m of c.maps) (maps[m.peer] ??= {})[m.mine] = m.theirs;
    const routes: Record<string, SavedRoute | null> = {};
    for (const r of c.routes) {
      routes[r.model] = r.removed
        ? null
        : { policy: r.policy!, peers: r.peers, fallbackLocal: r.fallbackLocal };
    }
    const notes = Object.fromEntries(c.notes.map((n) => [n.model, n.text]));
    return { version: 1, savedAt: new Date().toISOString(), share, maps, routes, notes };
  }

  /**
   * Write the runtime changes into the config file, editing the YAML document so comments and
   * styles survive. Refuses if the file changed since load, a peer would map nothing, the
   * result would not load, or the file is not writable.
   */
  saveConfig(share: readonly string[]): void {
    const path = this.cfg.configPath;
    if (!path) {
      throw new ConfigError("this node was not loaded from a config file, so there is nothing to write");
    }

    let text: string;
    let mtime: number;
    let mode: number;
    try {
      const st = statSync(path);
      mtime = st.mtimeMs;
      mode = st.mode;
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new ConfigError(`cannot read ${path}: ${String(e)}`);
    }
    // Catches an edit made elsewhere since we loaded, not a true race; this is not a lock.
    if (this.configMtimeMs !== 0 && mtime !== this.configMtimeMs) {
      throw new ConfigError(
        `${path} has changed on disk since hearth started — saving would overwrite that edit. ` +
          `Restart hearth to pick it up, or copy the config from the page and paste it yourself.`,
      );
    }

    const doc = parseDocument(text);
    const changes = this.changes();

    /** Replace a list, keeping its flow or block style. */
    const setList = (path: string[], value: string[]) => {
      const before = doc.getIn(path, true) as { flow?: boolean } | undefined;
      // createNode, so there is a node to carry `.flow`.
      const node = doc.createNode(value) as { flow?: boolean };
      if (before && typeof before.flow === "boolean") node.flow = before.flow;
      if (path.length === 1) doc.set(path[0]!, node);
      else doc.setIn(path, node);
    };

    if ([...share].sort().join(",") !== [...this.cfg.share].sort().join(",")) {
      // Keep the file's order for existing entries, then append new ones.
      setList(["share"], [
        ...this.cfg.share.filter((m) => share.includes(m)),
        ...[...share].filter((m) => !this.cfg.share.includes(m)).sort(),
      ]);
    }

    for (const m of changes.maps) {
      const peers = doc.get("peers") as { items?: unknown[] } | undefined;
      const i = this.cfg.peers.findIndex((p) => p.name === m.peer);
      // Refuse rather than skip: an anchored `peers:` would drop the edit and still report saved.
      if (i < 0 || !peers?.items?.[i]) {
        throw new ConfigError(
          `cannot find peer "${m.peer}" as a plain entry under peers: in ${path} — ` +
            `edit it by hand from the config the page offers`,
        );
      }
      if (m.theirs === null) doc.deleteIn(["peers", i, "models", m.mine]);
      else doc.setIn(["peers", i, "models", m.mine], m.theirs);
    }
    for (const r of changes.routes) {
      if (r.removed) {
        doc.deleteIn(["models", r.model]);
        continue;
      }
      doc.setIn(["models", r.model, "policy"], r.policy);
      if (r.peers.length) setList(["models", r.model, "peers"], r.peers);
      else doc.deleteIn(["models", r.model, "peers"]);
      // Only when it is not the default, so the file does not accumulate
      // restatements of behaviour it would have had anyway.
      if (r.fallbackLocal) doc.deleteIn(["models", r.model, "fallbackLocal"]);
      else doc.setIn(["models", r.model, "fallbackLocal"], false);
    }
    for (const n of changes.notes) {
      if (n.text === null) doc.deleteIn(["notes", n.model]);
      else doc.setIn(["notes", n.model], n.text);
    }
    if (changes.notes.length && Object.keys(this.cfg.notes ?? {}).length === 0) doc.delete("notes");

    // Match the file's own flow-collection spacing so untouched lines do not churn.
    const out = doc.toString({ flowCollectionPadding: /[[{] \S/.test(text) });
    // The last gate, and the one worth having: our edit has to produce a config
    // that actually loads. A file that parses as YAML and then fails validation
    // is a node that will not come back up, discovered at the next restart.
    try {
      parseConfig(doc.toJS() as unknown);
    } catch (e) {
      // Said as a failure to SAVE, because the underlying message is about a
      // config file the operator is not looking at and did not knowingly edit.
      throw new ConfigError(
        `these changes would produce a config that cannot be loaded, so nothing was written: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Temp file and rename where the directory is writable; in place where only the file is
    // (ReadWritePaths under ProtectSystem=strict).
    const tmp = `${path}.hearth-tmp`;
    let staged = false;
    try {
      // Keep the config's mode (it may hold secrets), and fsync before the rename.
      const fd = openSync(tmp, "w", mode & 0o7777);
      try {
        writeFileSync(fd, out);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      staged = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EROFS" && code !== "EACCES" && code !== "EPERM") throw e;
    }
    if (staged) {
      try {
        renameSync(tmp, path);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } else {
      writeFileSync(path, out);
    }
    this.configMtimeMs = statSync(path).mtimeMs;
  }

  /** After a successful write, take the file as the new baseline. */
  rebase(share: readonly string[]): void {
    this.cfg.share = [...share];
    this.baseMaps.clear();
    for (const p of this.cfg.peers) this.baseMaps.set(p.name, { ...p.models });
    this.baseRoutes.clear();
    for (const [id, r] of Object.entries(this.cfg.models)) this.baseRoutes.set(id, { ...r });
    this.baseNotes = { ...this.cfg.notes };
  }

  /** Is there anything the sidecar would not survive a restart with? */
  unsaved(share: Record<string, boolean>): boolean {
    return this.blob(this.pending(share)) !== this.savedBlob;
  }

  markSaved(state: SavedState): void {
    this.savedBlob = this.blob(state);
  }

  /** Stable JSON of a state: savedAt excluded, keys sorted. */
  private blob(state: SavedState): string {
    return JSON.stringify({ share: state.share, maps: state.maps, routes: state.routes, notes: state.notes ?? {} }, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort((a, b) => a[0].localeCompare(b[0])))
        : v,
    );
  }

  /** Map one of our ids to a peer's and route it there. The caller picks `policy` and `fallbackLocal`. */
  link(
    peer: string,
    mine: string,
    theirs: string,
    policy: RoutePolicy,
    fallbackLocal: boolean,
  ): void {
    const p = this.cfg.peers.find((x) => x.name === peer);
    if (!p) {
      throw new ConfigError(
        `"${peer}" is not a configured peer (${this.cfg.peers.map((x) => x.name).join(", ") || "none"}) — ` +
          `peers are added in the config file, only their model maps are editable here`,
      );
    }
    if (mine === "" || theirs === "") throw new ConfigError("both model ids are required");

    const prev = this.cfg.models[mine];

    p.models[mine] = theirs;

    // A route that names its peers gets this one added, never widened to everyone.
    const peers =
      prev && prev.peers.length > 0 && !prev.peers.includes(peer) ? [...prev.peers, peer] : (prev?.peers ?? []);

    this.cfg.models[mine] = { ...DEFAULT_ROUTE, ...prev, policy, peers, fallbackLocal };
  }

  /** Remove a mapping, and retire the route once nothing that it names still maps the model. */
  unlink(peer: string, mine: string): void {
    const p = this.cfg.peers.find((x) => x.name === peer);
    if (!p) throw new ConfigError(`"${peer}" is not a configured peer`);
    delete p.models[mine];

    // Narrow a named peer list; an emptied list is a dead route, not an open one.
    const route = this.cfg.models[mine];
    if (route && route.peers.includes(peer)) {
      const rest = route.peers.filter((n) => n !== peer);
      if (rest.length === 0) this.retireRoute(mine);
      else route.peers = rest;
    }
    this.pruneDeadRoutes();
  }

  /** Stop a route sending work away: delete it if it is only a policy, else demote it to local and keep its settings. */
  private retireRoute(id: string): void {
    const r = this.cfg.models[id];
    if (!r) return;
    const onlyAPolicy =
      r.backend === null && r.as === null && r.concurrency === null && r.spilloverAt === 1
      && r.params === null && r.lane === null && r.stats === null;
    if (onlyAPolicy) delete this.cfg.models[id];
    else this.cfg.models[id] = { ...r, policy: "local", peers: [] };
  }

  /** Retire every non-local route no eligible peer maps, after unlink and after restore. */
  private pruneDeadRoutes(): void {
    for (const [id, route] of Object.entries(this.cfg.models)) {
      if (route.policy === "local") continue;
      const named = route.peers.length > 0 ? route.peers : this.cfg.peers.map((p) => p.name);
      const able = named.some((n) => this.cfg.peers.find((p) => p.name === n)?.models[id] !== undefined);
      if (!able) this.retireRoute(id);
    }
  }

  /** Everything that differs from the file right now. */
  changes(): Changes {
    const maps: MapChange[] = [];
    for (const p of this.cfg.peers) {
      const base = this.baseMaps.get(p.name) ?? {};
      for (const [mine, theirs] of Object.entries(p.models)) {
        if (base[mine] !== theirs) maps.push({ peer: p.name, mine, theirs, was: base[mine] ?? null });
      }
      for (const [mine, theirs] of Object.entries(base)) {
        if (p.models[mine] === undefined) maps.push({ peer: p.name, mine, theirs: null, was: theirs });
      }
    }

    const routes: RouteChange[] = [];
    const ids = new Set([...Object.keys(this.cfg.models), ...this.baseRoutes.keys()]);
    for (const id of ids) {
      const now = this.cfg.models[id];
      const was = this.baseRoutes.get(id);
      if (!now && !was) continue;
      if (now && was && now.policy === was.policy && now.fallbackLocal === was.fallbackLocal &&
          now.peers.join(",") === was.peers.join(",")) continue;
      routes.push({
        model: id,
        policy: now?.policy ?? null,
        peers: now?.peers ?? [],
        fallbackLocal: now?.fallbackLocal ?? true,
        added: !was,
        removed: !now,
      });
    }
    const now = this.cfg.notes ?? {};
    const notes = [...new Set([...Object.keys(now), ...Object.keys(this.baseNotes)])]
      .filter((m) => now[m] !== this.baseNotes[m])
      .sort()
      .map((model) => ({ model, text: now[model] ?? null }));
    return {
      maps: maps.sort((a, b) => a.mine.localeCompare(b.mine)),
      routes: routes.sort((a, b) => a.model.localeCompare(b.model)),
      notes,
    };
  }

  dirty(): boolean {
    const c = this.changes();
    return c.maps.length > 0 || c.routes.length > 0 || c.notes.length > 0;
  }

  /** The pending changes as the config they should become, ready to paste. */
  yaml(share: readonly string[], configuredShare: readonly string[]): string {
    const out: string[] = [];
    const changes = this.changes();
    const shareChanged =
      [...share].sort().join(",") !== [...configuredShare].sort().join(",");

    if (shareChanged) {
      out.push("# top level — replaces your share: list");
      out.push(`share: [${[...share].sort().map(y).join(", ")}]`);
      out.push("");
    }

    const peersTouched = [...new Set(changes.maps.map((m) => m.peer))];
    for (const name of peersTouched) {
      const p = this.cfg.peers.find((x) => x.name === name);
      if (!p) continue;
      const entries = Object.entries(p.models).sort((a, b) => a[0].localeCompare(b[0]));
      out.push(`# in peers[name: ${name}] — replaces its models: block`);
      if (entries.length === 0) {
        // Nothing mapped is a legal state, not a broken one: the peer stays
        // configured and the page keeps listing everything they serve, so
        // borrowing again is a click rather than a config edit.
        out.push("    models: {}   # nothing borrowed from them at the moment");
      } else {
        out.push("    models:");
        for (const [mine, theirs] of entries) out.push(`      ${y(mine)}: ${y(theirs)}`);
      }
      out.push("");
    }

    const live = changes.routes.filter((r) => !r.removed);
    if (live.length > 0) {
      out.push("# top level, under models: — merges with what is already there");
      out.push("models:");
      for (const r of live) {
        out.push(`  ${y(r.model)}:`);
        out.push(`    policy: ${r.policy}`);
        if (r.peers.length) out.push(`    peers: [${r.peers.map(y).join(", ")}]`);
        if (!r.fallbackLocal) out.push("    fallbackLocal: false");
      }
      out.push("");
    }
    for (const r of changes.routes.filter((x) => x.removed)) {
      out.push(`# remove models.${r.model} — nothing maps it any more`);
    }
    if (changes.notes.length) {
      out.push("", "# top level, under notes: — merges with what is already there");
      out.push("notes:");
      for (const n of changes.notes) {
        out.push(n.text === null ? `  # remove ${y(n.model)}` : `  ${y(n.model)}: ${y(n.text)}`);
      }
    }

    return out.join("\n").trimEnd();
  }
}
