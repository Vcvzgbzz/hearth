/**
 * hearth.yaml is the only config state. Every edit lands in the file the moment it is made, the
 * running node follows the file, and nothing is ever "pending" except what needs a restart.
 *
 * The failures worth catching are all "it worked and ruined something":
 *
 *   - comments or styles stripped from a file a person maintains by hand
 *   - an edit made in another window overwritten, or ignored by the running node
 *   - a file written that parses as YAML and then fails to LOAD
 *   - a live-looking change that actually needs a restart, or the reverse
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

const dir = mkdtempSync(join(tmpdir(), "hearth-cfg-"));
const cfgPath = join(dir, "hearth.yaml");

const backend = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(req.url === "/v1/models"
    ? JSON.stringify({ data: [{ id: "mine" }, { id: "spare" }] })
    : JSON.stringify({ choices: [{ message: { role: "assistant", content: "local" } }] }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const beUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

// Comments in every position: above a key, beside a value, inside a nested mapping.
const ORIGINAL = `# hearth on the test box.
#
# Two peers, one of which is a friend.
name: node-under-test

backends:
  main:
    url: ${beUrl}          # the local llama-swap
    kind: none
    serves: [mine, spare]

# Empty by default, since lending is opt-in per model.
lending:
  models: [mine]

peers:
  friend:
    url: http://127.0.0.1:1
    token: t
    accept: shhh
    models:
      # my id: their id. Also the allowlist.
      borrowed: theirs

models:
  borrowed:
    policy: peer
    fallbackLocal: true
  # Past 80 columns on purpose: the writer's default would fold it across lines.
  long-one: {concurrency: 4, params: {thinking_token_budget: 2048}, pool: {tokens: 144000, output: 8192}, stats: {context: 131072}}
`;

const comments = (t: string) => t.split("\n").filter((l) => l.includes("#")).map((l) => l.slice(l.indexOf("#"))).join("\n");

type Status = { path: string | null; hash: string; restartPending: string[]; error: string | null };

async function boot(path = cfgPath) {
  const node = createNode(loadConfig(path), silentLogger);
  node.start();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const send = (route: string, method: string, body: unknown) =>
    fetch(`${url}${route}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    node,
    url,
    control: (body: unknown) => send("/control", "POST", body),
    patch: (body: unknown) => send("/config", "PATCH", body),
    file: async () => (await (await fetch(`${url}/config`)).json()) as Status & { text: string },
    note: async (model: string) => {
      const m = (await (await fetch(`${url}/v1/models`)).json()) as { data: { id: string; description?: string }[] };
      return m.data.find((x) => x.id === model)?.description;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 700));

/* ------------------------------------------ every console edit lands in the file */

{
  writeFileSync(cfgPath, ORIGINAL);
  const a = await boot();
  assert.equal((await a.control({ share: { mine: false, spare: true } })).status, 200);
  assert.equal((await a.control({ link: { peer: "friend", mine: "extra", theirs: "their-extra" } })).status, 200);
  assert.equal((await a.control({ notes: { mine: "use for: \"quoted\" things" } })).status, 200);

  const written = readFileSync(cfgPath, "utf8");
  assert.equal(comments(written), comments(ORIGINAL), "every comment survives, in order");
  assert.match(written, /serves: \[mine, spare\]/, "untouched flow lists keep their spacing");
  assert.match(written, /^lending:\n  models: \[spare\]/m, "an inline list stays inline after being rewritten");
  assert.match(written, /^  mine:\n    note: 'use for: "quoted" things'/m, "a note is written onto its model");
  assert.ok(written.includes("  long-one: {concurrency: 4, params: {thinking_token_budget: 2048}, pool: {tokens: 144000, output: 8192}, stats: {context: 131072}}\n"),
    "a long line nobody edited stays one line");

  const back = loadConfig(cfgPath);
  assert.deepEqual(back.share, ["spare"], "no save step: the file already says it");
  assert.equal(back.peers[0]!.models.extra, "their-extra");
  assert.equal(back.models.extra!.policy, "peer", "a link writes its route, not just the mapping");
  assert.equal(back.peers[0]!.models.borrowed, "theirs", "untouched entries stay untouched");
  assert.deepEqual(back.notes, { mine: "use for: \"quoted\" things" });
  assert.equal(await a.note("mine"), "use for: \"quoted\" things", "and the running node has it too");

  const st = await a.file();
  assert.deepEqual(st.restartPending, [], "all of that applies live");
  assert.equal(st.path, cfgPath);

  // The last mapping going leaves the peer configured, borrowing nothing.
  assert.equal((await a.control({ unlink: { peer: "friend", mine: "borrowed" } })).status, 200);
  assert.equal((await a.control({ unlink: { peer: "friend", mine: "extra" } })).status, 200);
  const empty = loadConfig(cfgPath);
  assert.deepEqual(empty.peers[0]!.models, {}, "the peer is still there");
  assert.equal(empty.peers[0]!.token, "t", "with its token");
  assert.equal(empty.models.borrowed, undefined, "and the dead route is retired in the file");
  await a.node.close();
}

/* ------------------------------------------------- hand edits, two ways in */

{
  writeFileSync(cfgPath, ORIGINAL);
  const a = await boot();

  // An edit made elsewhere is loaded before ours, so ours builds on it instead of overwriting it.
  writeFileSync(cfgPath, ORIGINAL.replace("# Empty by default", "# somebody was in here\n# Empty by default"));
  assert.equal((await a.control({ share: { spare: true } })).status, 200);
  const both = readFileSync(cfgPath, "utf8");
  assert.match(both, /somebody was in here/, "their edit survives");
  assert.match(both, /^lending:\n  models: \[mine, spare\]/m, "and ours is on top of it");

  // With no request at all, the watcher picks a hand edit up and the node runs it.
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace("models:\n  borrowed:", "models:\n  mine:\n    note: typed in vim\n  borrowed:"));
  await settle();
  assert.equal(await a.note("mine"), "typed in vim", "a hand edit applies without a restart or a click");

  // A broken hand edit leaves the node on the last good config and says why.
  const good = readFileSync(cfgPath, "utf8");
  writeFileSync(cfgPath, good.replace("kind: none", "kind: banana"));
  await settle();
  const st = await a.file();
  assert.match(st.error ?? "", /kind/, "the status names what is wrong");
  assert.equal(await a.note("mine"), "typed in vim", "and the node keeps serving the last good config");
  const refused = await a.control({ share: { spare: false } });
  assert.equal(refused.status, 409, "an edit on top of a file that does not load is refused");
  assert.match(readFileSync(cfgPath, "utf8"), /banana/, "and the file is left for its author to fix");

  writeFileSync(cfgPath, good);
  await settle();
  assert.equal((await a.file()).error, null, "fixing it clears the error");
  await a.node.close();
}

{
  // A hand edit to a restart-only key loads, and the journal says it is waiting on a restart.
  writeFileSync(cfgPath, ORIGINAL);
  const warned: Record<string, unknown>[] = [];
  const node = createNode(loadConfig(cfgPath), { ...silentLogger, warn: (msg, f) => { if (msg === "config.reloaded") warned.push(f ?? {}); } });
  node.start();
  writeFileSync(cfgPath, ORIGINAL.replace("serves: [mine, spare]", "serves: [mine]"));
  await settle();
  assert.deepEqual(warned.at(-1)?.restartPending, ["backends"], "a serves edit is logged as waiting on a restart");
  await node.close();
}

/* ------------------------------------------------------------ PATCH /config */

{
  writeFileSync(cfgPath, ORIGINAL);
  const a = await boot();
  const { hash } = await a.file();

  // A live key applies at once; a key read only at startup is saved and listed.
  let r = await a.patch({ baseHash: hash, ops: [{ path: ["backendDefaults", "idleMs"], value: 1234 }] });
  assert.equal(r.status, 200);
  let out = (await r.json()) as Status;
  assert.deepEqual(out.restartPending, [], "an idle deadline is read per request");
  r = await a.patch({ baseHash: out.hash, ops: [{ path: ["scheduler", "maxPerLane"], value: 7 }] });
  out = (await r.json()) as Status;
  assert.deepEqual(out.restartPending, ["scheduler"], "lanes and queues are built once, so they wait");
  assert.equal(loadConfig(cfgPath).scheduler.maxPerLane, 7, "but the file has it now");
  r = await a.patch({ baseHash: out.hash, ops: [{ path: ["scheduler", "maxPerLane"], delete: true }] });
  out = (await r.json()) as Status;
  assert.deepEqual(out.restartPending, [], "putting it back clears the restart");

  // Invalid: 422 with the field, and nothing written.
  const before = readFileSync(cfgPath, "utf8");
  r = await a.patch({ baseHash: out.hash, ops: [{ path: ["backends", "main", "url"], value: "nope" }] });
  assert.equal(r.status, 422);
  const err = (await r.json()) as { error: { message: string; path: string | null } };
  assert.equal(err.error.path, "backends.main.url", "the error carries the field it is about");
  assert.equal(readFileSync(cfgPath, "utf8"), before, "and the file is untouched");

  // A dry run shows the result without writing it.
  r = await a.patch({ baseHash: out.hash, ops: [{ path: ["scheduler", "maxPerLane"], value: 9 }], dryRun: true });
  assert.deepEqual(((await r.json()) as Status).restartPending, ["scheduler"], "a dry run says what its change would need");
  r = await a.patch({ baseHash: out.hash, ops: [{ path: ["lending", "models"], value: [] }], dryRun: true });
  assert.match(((await r.json()) as { text: string }).text, /lending:\n  models: \[\]/);
  assert.equal(readFileSync(cfgPath, "utf8"), before, "a dry run writes nothing");

  // Someone edits a different key: ops on untouched paths merge onto their file.
  writeFileSync(cfgPath, before.replace("name: node-under-test", "name: renamed"));
  r = await a.patch({ baseHash: out.hash, ops: [{ path: ["borrowing", "coldPenalty"], value: 3 }] });
  assert.equal(r.status, 200, "an unrelated edit elsewhere is not a conflict");
  const merged = readFileSync(cfgPath, "utf8");
  assert.match(merged, /name: renamed/);
  assert.match(merged, /coldPenalty: 3/);

  // ...but the same path, or the whole text, from a stale base is.
  const stale = out.hash;
  writeFileSync(cfgPath, merged.replace("coldPenalty: 3", "coldPenalty: 4"));
  r = await a.patch({ baseHash: stale, ops: [{ path: ["borrowing", "coldPenalty"], value: 5 }] });
  assert.equal(r.status, 409, "a path someone else changed is theirs until you reload");
  r = await a.patch({ baseHash: stale, text: ORIGINAL });
  assert.equal(r.status, 409, "replacing the whole file needs the current hash");
  assert.match(readFileSync(cfgPath, "utf8"), /coldPenalty: 4/, "and their value stands");
  await a.node.close();
}

/* ------------------------------- a writable file in a read-only directory */

{
  // ReadWritePaths=/etc/hearth.yaml leaves /etc read-only, so the temp-file rename fails; write in place.
  const locked = mkdtempSync(join(tmpdir(), "hearth-ro-"));
  const roCfg = join(locked, "hearth.yaml");
  writeFileSync(roCfg, ORIGINAL);
  chmodSync(locked, 0o500);
  try {
    const a = await boot(roCfg);
    assert.equal((await a.control({ share: { mine: false } })).status, 200);
    assert.deepEqual(loadConfig(roCfg).share, [], "a writable file is enough, directory or not");
    await a.node.close();
  } finally {
    chmodSync(locked, 0o700);
  }
}

/* --------------------------------------------- a pre-2.0 sidecar folds in once */

{
  const statePath = join(dir, "overrides.json");
  writeFileSync(cfgPath, `stateFile: ${statePath}\n` + ORIGINAL);
  writeFileSync(statePath, JSON.stringify({
    version: 1, savedAt: "", share: { spare: true },
    maps: { friend: { extra: "their-extra" }, gone: { x: "y" } },
    routes: { extra: { policy: "peer", peers: [], fallbackLocal: false } },
    notes: { mine: "from the sidecar" },
  }));
  const a = await boot();
  const after = loadConfig(cfgPath);
  assert.deepEqual(after.share, ["mine", "spare"], "its share deltas are in the file");
  assert.equal(after.peers[0]!.models.extra, "their-extra");
  assert.equal(after.models.extra!.fallbackLocal, false);
  assert.equal(after.notes?.mine, "from the sidecar");
  assert.ok(!existsSync(statePath) && existsSync(`${statePath}.migrated`), "and the sidecar is retired");
  assert.match(readFileSync(cfgPath, "utf8"), /# my id: their id\. Also the allowlist\./, "comments intact");
  await a.node.close();
}

/* --------------------------------------------- secrets never reach the console */

{
  process.env.HEARTH_TEST_SECRET = "env-resolved-value";
  const secretPath = join(dir, "secret-hearth.yaml");
  const SECRETED = `name: node-under-test
backends:
  main:
    url: ${beUrl}
    kind: none
    serves: [mine]
apiKeys:
  - plain-key-value
  - {key: plain-map-key, label: ops}
  - env:HEARTH_TEST_SECRET
peers:
  friend:
    url: http://127.0.0.1:1
    token: plain-peer-token
    accept: plain-token-value
    models: {}
operator:
  user: op
  passHash: a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1:b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2
`;
  writeFileSync(secretPath, SECRETED);
  const a = await boot(secretPath);
  const auth = { Authorization: "Bearer plain-key-value", "Content-Type": "application/json" };
  type SecretDoc = { apiKeys: (string | { key: string; label: string })[]; peers: Record<string, { token: string; accept: string }> };
  const get = async () => (await (await fetch(`${a.url}/config`, { headers: auth })).json()) as { text: string; hash: string; doc: SecretDoc };
  const patch = (body: unknown) => fetch(`${a.url}/config`, { method: "PATCH", headers: auth, body: JSON.stringify(body) });

  const f = await get();
  for (const s of ["plain-key-value", "plain-map-key", "plain-token-value", "plain-peer-token", "env-resolved-value", "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"]) {
    assert.ok(!f.text.includes(s), `no secret in the file's own tab (${s})`);
    assert.ok(!JSON.stringify(f.doc).includes(s), `no secret in the parsed doc`);
  }
  assert.match(f.text, /hearth-secret\d+/, "the stand-in is where the secret was");
  assert.match(f.doc.apiKeys[0]! as string, /^hearth-secret\d+$/);
  const mapEntry = f.doc.apiKeys[1]! as { key: string; label: string };
  assert.match(mapEntry.key, /^hearth-secret\d+$/, "a {key, label} entry masks the key, keeps the label");
  assert.equal(mapEntry.label, "ops");
  assert.equal(f.doc.apiKeys[2], "env:HEARTH_TEST_SECRET", "an env: reference is not a secret in the file");
  assert.match(f.doc.peers.friend!.accept, /^hearth-secret\d+$/);
  assert.match(f.doc.peers.friend!.token, /^hearth-secret\d+$/);
  assert.ok(readFileSync(secretPath, "utf8").includes("plain-key-value"), "the file itself still holds the real key");

  // A whole-text save sends the stand-ins back; the originals come home.
  const edited = f.text + "# touched from the console\n";
  let r = await patch({ baseHash: f.hash, text: edited });
  assert.equal(r.status, 200);
  const file = readFileSync(secretPath, "utf8");
  assert.match(file, /# touched from the console/);
  for (const s of ["plain-key-value", "plain-map-key", "plain-token-value", "plain-peer-token"]) assert.ok(file.includes(s), `the stand-in came home as ${s}`);

  // An op that replaces a secret installs the new value; the answer masks it again.
  const f2 = await get();
  r = await patch({ baseHash: f2.hash, ops: [{ path: ["apiKeys", 0], value: "rotated-key" }] });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { text: string };
  assert.ok(!body.text.includes("rotated-key"), "a new secret is masked in the answer too");
  assert.match(readFileSync(secretPath, "utf8"), /^  - rotated-key$/m, "and the file has the new one");

  // A dry run leaks nothing and writes nothing. (The key just rotated, so does the auth.)
  const auth2 = { Authorization: "Bearer rotated-key", "Content-Type": "application/json" };
  const get2 = async () => (await (await fetch(`${a.url}/config`, { headers: auth2 })).json()) as { text: string; hash: string; doc: SecretDoc };
  const f3 = await get2();
  r = await fetch(`${a.url}/config`, { method: "PATCH", headers: auth2, body: JSON.stringify({ baseHash: f3.hash, ops: [{ path: ["peers", "friend", "accept"], value: "another" }], dryRun: true }) });
  assert.ok(!((await r.json()) as { text: string }).text.includes("another"));
  assert.ok(!readFileSync(secretPath, "utf8").includes("another"), "a dry run writes nothing");
  await a.node.close();
  delete process.env.HEARTH_TEST_SECRET;
}

/* ---------------------------------------- a node built in code edits memory */

{
  const node = createNode(parseV1({ name: "n", backend: { url: beUrl, kind: "none", serves: ["mine"] } }), silentLogger);
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const r = await fetch(`${url}/control`, { method: "POST", body: JSON.stringify({ share: { mine: true } }) });
  const out = (await r.json()) as { share: string[]; config: Status };
  assert.deepEqual(out.share, ["mine"], "the edit applies");
  assert.equal(out.config.path, null, "and the status says there is no file behind it");
  const p = await fetch(`${url}/config`, { method: "PATCH", body: JSON.stringify({ ops: [] }) });
  assert.equal(p.status, 409, "raw file edits need a file");
  await node.close();
}

/* ------------------------------------------ a rename changes the key and nothing else */

{
  writeFileSync(cfgPath, ORIGINAL);
  const a = await boot();
  const r = await a.patch({ ops: [{ path: ["peers", "friend"], rename: "gpu-east" }] });
  assert.equal(r.status, 200);
  await r.text();
  const after = readFileSync(cfgPath, "utf8");
  // The yaml writer collapses the space before an inline comment on any save; nothing else moves.
  assert.equal(after, ORIGINAL.replace("  friend:", "  gpu-east:").replace(/ +# the local/, " # the local"), "comments, flow maps and order untouched");
  const dup = await a.patch({ ops: [{ path: ["backends", "main"], rename: "main" }] });
  assert.equal(dup.status, 400, "renaming onto a name that exists is refused");
  await dup.text();
  const gone = await a.patch({ ops: [{ path: ["peers", "nobody"], rename: "x" }] });
  assert.equal(gone.status, 409, "and so is renaming something that is not there");
  await gone.text();
  await a.node.close();
}

backend.closeAllConnections();
backend.close();
console.log("configfile.test.ts ok");
