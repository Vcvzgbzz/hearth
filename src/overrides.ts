/**
 * Runtime edits to who serves what: a peer's model map, and the route that
 * decides whether a request actually goes there.
 *
 * Those two are one feature and it took a while to admit it. `peers[].models`
 * is only an allowlist — adding an entry there says a request MAY leave the
 * machine, never that it will. Without a matching `models.<id>` route the
 * policy stays local and the mapping does nothing at all, which is exactly the
 * shape of bug where someone maps a friend's new model, watches every request
 * run at home, and concludes federation is broken. So both halves move together
 * or neither does.
 *
 * PERSISTED ONLY ON REQUEST, and only when `stateFile` is configured. An edit
 * is live immediately and gone on restart unless somebody presses Save, which
 * is the split that matters: a link tried on a hunch should not outlive the
 * hunch. `yaml()` is still here and still the better destination — a change you
 * want to keep for good belongs in the file that is in version control, not in
 * a sidecar that quietly diverges from it. The sidecar is for the ones you want
 * to survive a reboot before you have decided that.
 *
 * IT MUTATES THE LIVE CONFIG, and that is load-bearing. PeerRegistry keeps
 * references to the very PeerConfig objects in `cfg.peers`, and route decisions
 * read `cfg.models` on every request, so writing through the config is what
 * makes an edit take effect immediately with no cache to invalidate and no
 * second read path to keep in step. The price is that `cfg` no longer tells you
 * what the file said, which is why the baseline below is cloned first.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
}

/** A route as it is stored. Only the fields the console can set — the rest
 *  (`backend`, `as`, `concurrency`) are properties of your backends, and a sidecar
 *  quietly restating them is how a config edit stops taking effect. */
export interface SavedRoute {
  policy: RoutePolicy;
  peers: string[];
  fallbackLocal: boolean;
}

/**
 * The sidecar, as it is written.
 *
 * Deltas rather than effective state, throughout: `null` means removed, and a
 * key that is absent means the config decides. Storing the full picture would
 * mean an edit to `hearth.yaml` silently doing nothing, because a file written
 * weeks ago would keep overriding it — the exact failure that makes people
 * distrust a second source of truth.
 */
export interface SavedState {
  version: 1;
  savedAt: string;
  share: Record<string, boolean>;
  maps: Record<string, Record<string, string | null>>;
  routes: Record<string, SavedRoute | null>;
}

/**
 * Read the sidecar, or null for anything that isn't a usable one.
 *
 * A missing file is the normal first run. A CORRUPT one is louder but still not
 * fatal, deliberately: refusing to start because a convenience file got
 * truncated in a power cut would turn a lost preference into an outage, and the
 * config alone is always a valid way to run. It says so in the log rather than
 * pretending the file was empty.
 */
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

/**
 * Write it, or delete it when there is nothing left to say.
 *
 * Via a temp file and a rename, so a crash mid-write leaves the previous state
 * rather than half of this one — the file is read exactly once, at startup, and
 * that is the worst possible moment to find it truncated.
 *
 * An EMPTY state removes the file instead of writing `{}`. Reverting everything
 * and pressing Save should leave no trace: an empty sidecar sitting next to the
 * config is a thing someone finds later and has to reason about.
 */
export function writeState(path: string, state: SavedState): void {
  const empty =
    Object.keys(state.share).length === 0 &&
    Object.keys(state.maps).length === 0 &&
    Object.keys(state.routes).length === 0;
  if (empty) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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
};

export class Overrides {
  /** What the file said, cloned before anything is allowed to touch it. */
  private readonly baseMaps: Map<string, Record<string, string>>;
  private readonly baseRoutes: Map<string, ModelRoute>;

  /**
   * JSON of the last state written or restored, for the unsaved check. A blob
   * rather than a structure because the only question asked of it is "same?".
   *
   * Seeded with the EMPTY state rather than "", or a node with nothing
   * overridden at all reports unsaved work — there is no sidecar and nothing to
   * put in one, and offering to save that is offering to save nothing.
   */
  private savedBlob: string;

  /**
   * The config file's mtime as we last saw it, for the clobber check.
   *
   * The one failure a config writer has that a sidecar does not: you are ssh'd
   * into the box editing the file while somebody presses Save in a browser, and
   * one of you silently loses. Comparing this before writing turns that into a
   * refusal with an explanation.
   */
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
  }

  /**
   * Put a saved state back, after the baseline above has been taken.
   *
   * Order is the whole trick. The constructor snapshots what the FILE said, and
   * this runs afterwards, so restored edits still read as differing from the
   * config — the page keeps offering the YAML for them, and "saved" never
   * quietly becomes "in the config".
   *
   * Applied directly rather than through link(), which merges and defaults. A
   * restore has to reproduce what was saved, not re-derive it from rules that
   * may have changed since.
   */
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
    this.pruneDeadRoutes();
    this.markSaved(state);
  }

  /**
   * Everything overridden right now, in the shape it is stored.
   *
   * Share lives in Controls rather than here, so it is passed in — this class
   * owns the config and knows nothing about lending, and wiring it to Controls
   * to save one argument would give two objects a reason to know about each
   * other for no gain.
   */
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
    return { version: 1, savedAt: new Date().toISOString(), share, maps, routes };
  }

  /**
   * Write the runtime changes into the config file itself.
   *
   * This is where a saved change belongs, and the reason is the same one that
   * made a sidecar look reasonable and then wrong: there should be ONE record
   * of what this node does. A second file holding half the answer means the
   * page has to keep explaining the difference, which it did, in the form of a
   * block that never stopped asking to be dealt with.
   *
   * Edited as a Document rather than re-serialised from the parsed config,
   * which is the whole reason this is safe to do at all: the comments are the
   * valuable part of a config someone maintains by hand, and round-tripping
   * through parseConfig would return a file with every one of them gone.
   *
   * Four ways it refuses rather than writes, in order of how likely they are:
   * somebody edited the file since we started, a peer would be left mapping
   * nothing, the result would not load, or the file is not writable.
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
    // Not a lock, and it does not pretend to be. It catches the case that
    // actually happens — an edit made hours ago in another window — rather than
    // a genuine race, which would need the file locked for as long as somebody
    // has an editor open.
    if (this.configMtimeMs !== 0 && mtime !== this.configMtimeMs) {
      throw new ConfigError(
        `${path} has changed on disk since hearth started — saving would overwrite that edit. ` +
          `Restart hearth to pick it up, or copy the config from the page and paste it yourself.`,
      );
    }

    const doc = parseDocument(text);
    const changes = this.changes();

    /**
     * Replace a list, keeping whether it was written inline or as a block.
     *
     * doc.set() with a plain array builds a fresh node, and a fresh node has no
     * opinion about style, so yaml renders it as a block. `share: [a, b]` came
     * back as three lines — a diff on a line we did edit, but rewritten into a
     * shape the author had deliberately not used.
     */
    const setList = (path: string[], value: string[]) => {
      const before = doc.getIn(path, true) as { flow?: boolean } | undefined;
      // createNode, not the plain array: assigning an array stores the array
      // itself, so there is no node to carry the style and yaml falls back to a
      // block. Reading it back gives you the Array, and setting .flow on that
      // does exactly nothing — which is how the first attempt at this passed
      // review and failed the test.
      const node = doc.createNode(value) as { flow?: boolean };
      if (before && typeof before.flow === "boolean") node.flow = before.flow;
      if (path.length === 1) doc.set(path[0]!, node);
      else doc.setIn(path, node);
    };

    if ([...share].sort().join(",") !== [...this.cfg.share].sort().join(",")) {
      // The file's own order for everything still shared, then whatever is new.
      // Sorting was deterministic and also reordered a list somebody had
      // grouped on purpose — one more line changed by a save that did not mean
      // to change it.
      setList(["share"], [
        ...this.cfg.share.filter((m) => share.includes(m)),
        ...[...share].filter((m) => !this.cfg.share.includes(m)).sort(),
      ]);
    }

    for (const m of changes.maps) {
      const peers = doc.get("peers") as { items?: unknown[] } | undefined;
      const i = this.cfg.peers.findIndex((p) => p.name === m.peer);
      // Not skipped quietly. A `peers:` written as an anchor or an alias rather
      // than a literal sequence would drop every mapping edit here, and rebase()
      // would then mark it all saved — the page reporting success over a file
      // that never changed, which is the worst outcome this code has.
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

    // Match the file's own flow spacing rather than impose a house style. This
    // is rendered whole, so whichever setting is wrong for the file rewrites
    // every line using the other one — `[a, b]` becoming `[ a, b ]`, or the
    // reverse — and those are lines nobody edited, in a config that is probably
    // in a repo. Both directions have now happened to the same file.
    //
    // A file mixing the two still churns the minority style once and is then
    // consistent, which is the best a whole-document render can do without
    // diffing its own output.
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

    // Temp file and rename where the DIRECTORY allows it, because a crash
    // half way through writing a config is a node that will not start.
    //
    // It often does not allow it. `ReadWritePaths=/etc/hearth.yaml` under
    // ProtectSystem=strict makes exactly that file writable and leaves /etc
    // read-only, so creating a sibling fails with EROFS while the file itself
    // is perfectly writable — which is the normal case on a hardened unit, not
    // an edge one. Falling back to writing in place gives up atomicity for a
    // window measured in microseconds on a file of a few KB, and the
    // alternative is refusing to save at all on the configuration the README
    // recommends.
    const tmp = `${path}.hearth-tmp`;
    let staged = false;
    try {
      // The tmp file's mode becomes the config's mode after the rename, and
      // writeFileSync defaults to 0666 minus the umask — so a config kept at
      // 0600 came out world-readable, silently, the first time anyone pressed
      // Save. This file holds peer tokens and api keys whenever they are
      // written literally rather than as `env:` references.
      writeFileSync(tmp, out, { mode: mode & 0o7777 });
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

  /**
   * Forget the difference, because the file now says it.
   *
   * Called only after a successful write. Without it the page would keep
   * reporting everything as a runtime change against a baseline taken before
   * the change was written — the exact nagging this replaced.
   */
  rebase(share: readonly string[]): void {
    this.cfg.share = [...share];
    this.baseMaps.clear();
    for (const p of this.cfg.peers) this.baseMaps.set(p.name, { ...p.models });
    this.baseRoutes.clear();
    for (const [id, r] of Object.entries(this.cfg.models)) this.baseRoutes.set(id, { ...r });
  }

  /** Is there anything the sidecar would not survive a restart with? */
  unsaved(share: Record<string, boolean>): boolean {
    return this.blob(this.pending(share)) !== this.savedBlob;
  }

  markSaved(state: SavedState): void {
    this.savedBlob = this.blob(state);
  }

  /**
   * savedAt is excluded: it changes on every call and would make every state
   * look unsaved a millisecond after it was written. Keys are sorted because
   * JSON.stringify follows insertion order, and "unsaved" must not depend on
   * the order somebody happened to click things in.
   */
  private blob(state: SavedState): string {
    return JSON.stringify({ share: state.share, maps: state.maps, routes: state.routes }, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort((a, b) => a[0].localeCompare(b[0])))
        : v,
    );
  }

  /**
   * Point one of our model ids at a peer's, and route it there.
   *
   * `policy` and `fallbackLocal` are required rather than defaulted, because
   * the right default depends on whether we serve the model ourselves — and
   * that is a question about the backends, which this class does not know. The
   * caller has the catalog and picks; see the /control route.
   */
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

    // An empty `peers` list means "anyone who maps it", which is what a fresh
    // route should say. But a route that NAMES its peers is an operator being
    // specific, and silently widening it to everyone would route work to boxes
    // they deliberately left out — so extend the list instead of clearing it.
    const peers =
      prev && prev.peers.length > 0 && !prev.peers.includes(peer) ? [...prev.peers, peer] : (prev?.peers ?? []);

    this.cfg.models[mine] = { ...DEFAULT_ROUTE, ...prev, policy, peers, fallbackLocal };
  }

  /**
   * Take a mapping back, and the route with it once nothing maps the model.
   *
   * The route used to survive if it had come from the config file, on the
   * reasoning that quietly rewriting the operator's stated intent was worse
   * than leaving a route that no longer fires. That was wrong twice over.
   *
   * It is not a rewrite. Unlinking the last peer for a model IS the operator
   * saying to stop sending it away, and leaving `policy: peer` behind with
   * nothing mapped is not a preserved intention, it is a route that resolves to
   * "no peer available" on every request forever.
   *
   * And it produced a state that could not be saved. parseConfig refuses a
   * non-local policy that no peer maps — correctly, it can never fire — so the
   * old behaviour let you reach a perfectly ordinary place in the UI from which
   * writing the config was impossible, with an error about a line you never
   * touched. Found by pressing Save on a real box.
   */
  unlink(peer: string, mine: string): void {
    const p = this.cfg.peers.find((x) => x.name === peer);
    if (!p) throw new ConfigError(`"${peer}" is not a configured peer`);
    delete p.models[mine];

    // Narrowed rather than left alone, because a route that NAMES its peers is
    // still pointing at one we just unmapped. An emptied list is not an open
    // one: `peers: []` means "anyone who maps it", which is WIDER than the list
    // we started from, so emptying it would quietly let a different peer serve
    // work the operator had pinned to this one. An emptied list is a dead route.
    const route = this.cfg.models[mine];
    if (route && route.peers.includes(peer)) {
      const rest = route.peers.filter((n) => n !== peer);
      if (rest.length === 0) this.retireRoute(mine);
      else route.peers = rest;
    }
    this.pruneDeadRoutes();
  }

  /**
   * Stop a route sending work away, keeping anything local about it.
   *
   * The difference matters more than it looks. A route is not only a policy: it
   * can carry `backend`, `as` and `concurrency`, which are facts about YOUR machine
   * and have nothing to do with the peer you just unlinked. Deleting the whole
   * entry — which is what this used to do — silently threw away a vLLM batch
   * size or a backend pin, and then the config writer deleted the key from the
   * file along with whatever comments were on it. Irreversible, on an action
   * that said nothing about any of it.
   *
   * So a route that is only a policy is deleted, and one carrying local
   * settings is demoted to `local` and keeps them.
   */
  private retireRoute(id: string): void {
    const r = this.cfg.models[id];
    if (!r) return;
    const onlyAPolicy =
      r.backend === null && r.as === null && r.concurrency === null && r.spilloverAt === 1 && r.params === null;
    if (onlyAPolicy) delete this.cfg.models[id];
    else this.cfg.models[id] = { ...r, policy: "local", peers: [] };
  }

  /**
   * Retire every non-local route that nothing can serve.
   *
   * The invariant parseConfig enforces at load, kept here at runtime, and it
   * has to run on BOTH paths that can break it. Unlink is the obvious one. The
   * other is restoring a sidecar, which applies saved deltas directly — so a
   * file written before unlink learned this rule puts the dangling route
   * straight back, and the node lands in a state it cannot save its way out of.
   *
   * Eligibility is read the way decide() reads it: a named `peers` list is the
   * candidates, and only an empty one means everybody. Testing "does ANY peer
   * map this" instead was wrong in the case with two peers — unlink a model
   * from the one the route names, and the route survived because the OTHER peer
   * happened to map it, then failed to save with an error about a line nobody
   * had touched.
   */
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
    return { maps: maps.sort((a, b) => a.mine.localeCompare(b.mine)), routes: routes.sort((a, b) => a.model.localeCompare(b.model)) };
  }

  dirty(): boolean {
    const c = this.changes();
    return c.maps.length > 0 || c.routes.length > 0;
  }

  /**
   * The pending changes as config, ready to paste.
   *
   * Effective state rather than a patch: what `share:`, this peer's `models:`
   * and these routes should read once you are done. A diff would be shorter and
   * far easier to apply wrongly — YAML has no merge syntax, so a patch is only
   * ever a set of instructions a person has to carry out by hand.
   */
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

    return out.join("\n").trimEnd();
  }
}
