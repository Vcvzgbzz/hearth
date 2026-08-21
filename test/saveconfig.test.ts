/**
 * Self-check for writing runtime changes back into the config file.
 *
 * This is the one thing on the page that edits a file a person maintains by
 * hand, so the failures are all "it worked and ruined something":
 *
 *   - comments stripped, which is most of the value of a config someone wrote
 *   - an edit made in another window silently overwritten
 *   - a file written that parses as YAML and then fails to LOAD, discovered at
 *     the next restart rather than at the click that caused it
 *   - the page still reporting pending changes afterwards, which is the nag
 *     this replaced
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "hearth-cfg-"));
const cfgPath = join(dir, "hearth.yaml");

function stubBackend() {
  const s = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.url === "/v1/models"
      ? JSON.stringify({ data: [{ id: "mine" }] })
      : JSON.stringify({ choices: [{ message: { role: "assistant", content: "local" } }] }));
  });
  return {
    server: s,
    listen: () => new Promise<void>((r) => s.listen(0, "127.0.0.1", r)),
    url: () => `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
  };
}
const be = stubBackend();
await be.listen();

// Comment-heavy on purpose: a config nobody commented is not the one worth
// protecting, and the round trip has to survive comments in every position —
// above a key, beside a value, and inside a nested mapping.
const ORIGINAL = `# hearth on the test box.
#
# Two peers, one of which is a friend.
name: node-under-test

backend:
  url: ${be.url()}          # the local llama-swap
  kind: none
  serves: [mine, spare]

# Empty by default, since lending is opt-in per model.
share: [mine]

peerTokens:
  friend: shhh

peers:
  - name: friend
    url: http://127.0.0.1:1
    token: t
    models:
      # my id: their id. Also the allowlist.
      borrowed: theirs

models:
  borrowed:
    policy: peer
    fallbackLocal: true
`;

const boot = async () => {
  const node = createNode(loadConfig(cfgPath), silentLogger);
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  return {
    node,
    post: (body: unknown) =>
      fetch(`${url}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    read: async () => (await (await fetch(`${url}/control`)).json()) as {
      share: string[]; dirty: boolean; unsaved: boolean; savesTo: string | null; savePath: string | null;
    },
  };
};

/* --------------------------------------------- the config is the destination */

{
  writeFileSync(cfgPath, ORIGINAL);
  const a = await boot();

  const before = await a.read();
  assert.equal(before.savesTo, "config", "a writable config file wins over any sidecar");
  assert.equal(before.savePath, cfgPath, "and the page is told which file, not left to guess");

  assert.equal((await a.post({ share: { mine: false, spare: true } })).status, 200);
  assert.equal((await a.post({ link: { peer: "friend", mine: "extra", theirs: "their-extra" } })).status, 200);
  assert.equal((await a.read()).dirty, true);

  assert.equal((await a.post({ save: true })).status, 200);

  const after = await a.read();
  // The whole point. A saved change is IN the file, so there is nothing left to
  // report and the block on the page goes away instead of nagging.
  assert.equal(after.dirty, false, "after saving there is nothing left that differs from the file");
  assert.equal(after.unsaved, false);
  assert.deepEqual(after.share.slice().sort(), ["spare"], "and the running state is unchanged by the write");
  await a.node.close();

  const written = readFileSync(cfgPath, "utf8");
  const comments = (t: string) => t.split("\n").filter((l) => l.trim().startsWith("#")).length;
  assert.equal(comments(written), comments(ORIGINAL),
    "every comment survives — losing them is worse than not saving at all");
  assert.match(written, /# my id: their id\. Also the allowlist\./,
    "including the ones inside the block being edited");
  assert.match(written, /the local llama-swap/, "and the ones beside a value");
  // A config is usually in a repo, so a save that reformats lines nobody
  // touched turns every diff into noise. The default flow padding rewrote every
  // [a, b] in the file as [ a, b ].
  assert.match(written, /serves: \[mine, spare\]/, "untouched flow lists keep their spacing");
  // A list we DID edit keeps the shape its author chose. doc.set() with a plain
  // array builds a node with no opinion about style, and yaml renders those as
  // blocks — so `share: [mine]` came back as two lines.
  assert.match(written, /^share: \[/m, "an inline list stays inline after being rewritten");

  // Order too. Sorting was deterministic and reordered a list somebody had
  // grouped on purpose, which is a changed line a save did not mean to change.
  {
    const ordered = join(dir, "ordered.yaml");
    writeFileSync(ordered, ORIGINAL.replace("share: [mine]", "share: [spare, mine]"));
    const n = createNode(loadConfig(ordered), silentLogger);
    await new Promise<void>((r) => n.server.listen(0, "127.0.0.1", r));
    const u = `http://127.0.0.1:${(n.server.address() as AddressInfo).port}`;
    const send = (b: unknown) => fetch(`${u}/control`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await send({ share: { glimmer: true } });   // not in the catalog: refused
    await send({ share: { mine: false } });
    await send({ save: true });
    await n.close();
    assert.match(readFileSync(ordered, "utf8"), /^share: \[spare\]/m,
      "the surviving entry keeps its position rather than being re-sorted");
  }

  // The same file written the other way round. Rendering is whole-document, so
  // the wrong setting rewrites every line using the other style — and it is not
  // a hypothetical preference: one real config used both and got churned in
  // both directions on consecutive saves.
  {
    const padded = join(dir, "padded.yaml");
    writeFileSync(padded, ORIGINAL.replace("serves: [mine, spare]", "serves: [ mine, spare ]"));
    const n = createNode(loadConfig(padded), silentLogger);
    await new Promise<void>((r) => n.server.listen(0, "127.0.0.1", r));
    const u = `http://127.0.0.1:${(n.server.address() as AddressInfo).port}`;
    await fetch(`${u}/control`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ share: { mine: false } }) });
    await fetch(`${u}/control`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ save: true }) });
    await n.close();
    assert.match(readFileSync(padded, "utf8"), /serves: \[ mine, spare \]/,
      "a padded file stays padded");
  }

  // Reload from the file itself rather than trusting the process that wrote it.
  const reloaded = loadConfig(cfgPath);
  assert.deepEqual(reloaded.share.slice().sort(), ["spare"]);
  assert.equal(reloaded.peers[0]!.models.extra, "their-extra");
  assert.equal(reloaded.models.extra!.policy, "peer",
    "not served here, so it routes to the peer");
  assert.equal(reloaded.models.extra!.fallbackLocal, false);
  assert.equal(reloaded.peers[0]!.models.borrowed, "theirs", "untouched entries stay untouched");

  // And a fresh process agrees, which is the claim the button is making.
  const b = await boot();
  const back = await b.read();
  assert.deepEqual(back.share.slice().sort(), ["spare"]);
  assert.equal(back.dirty, false, "a restart finds nothing pending, because it is all in the file");
  await b.node.close();
}

/* ---------------------------------------------------- somebody else edited it */

{
  writeFileSync(cfgPath, ORIGINAL);
  const a = await boot();
  assert.equal((await a.post({ share: { mine: false } })).status, 200);

  // The realistic version of this is an ssh session hours ago, not a race.
  writeFileSync(cfgPath, `${ORIGINAL}\n# somebody was in here\n`);
  const future = new Date(Date.now() + 10_000);
  utimesSync(cfgPath, future, future);

  const refused = await a.post({ save: true });
  assert.equal(refused.status, 409, "saving over an edit we never saw is a refusal");
  assert.match(await refused.text(), /changed on disk/);
  assert.match(readFileSync(cfgPath, "utf8"), /somebody was in here/, "and their edit survives");

  const still = await a.read();
  assert.equal(still.dirty, true, "the change is still live and still unsaved, not silently dropped");
  await a.node.close();
}

/* ------------------------- unlinking the last peer takes the route with it */

{
  // Found by pressing Save on a real box. The route survived an unlink if it
  // had come from the file, which left `policy: peer` with nothing mapping it —
  // a config parseConfig refuses, reached from an ordinary sequence of clicks,
  // and reported as an error about a line nobody touched.
  writeFileSync(cfgPath, ORIGINAL);
  const a = await boot();
  assert.equal((await a.post({ unlink: { peer: "friend", mine: "borrowed" } })).status, 200);
  assert.equal((await a.post({ link: { peer: "friend", mine: "other", theirs: "theirs" } })).status, 200);
  const saved = await a.post({ save: true });
  assert.equal(saved.status, 200, "and it saves, rather than failing on a route nobody asked about");
  await a.node.close();

  const reloaded = loadConfig(cfgPath);
  assert.equal(reloaded.models.borrowed, undefined,
    "the route goes with the last mapping — it could never have fired again");
  assert.equal(reloaded.peers[0]!.models.borrowed, undefined);
  assert.equal(reloaded.models.other!.policy, "peer");
}

/* ----------------------- unlinking a peer's LAST model is an ordinary thing */

{
  // The complaint that caused this: one peer, one mapping, unlink it, press
  // Save, and get a wall of red saying a peer mapping nothing cannot be loaded.
  // It can now, and the peer keeps everything that makes it a peer.
  writeFileSync(cfgPath, ORIGINAL);
  const a = await boot();
  assert.equal((await a.post({ unlink: { peer: "friend", mine: "borrowed" } })).status, 200);
  const saved = await a.post({ save: true });
  assert.equal(saved.status, 200, "no warning, no dead end — it just saves");
  assert.equal((await a.read()).dirty, false);
  await a.node.close();

  const reloaded = loadConfig(cfgPath);
  assert.deepEqual(reloaded.peers[0]!.models, {}, "the peer is still configured, borrowing nothing");
  assert.equal(reloaded.peers[0]!.token, "t", "with the token that took a conversation to obtain");
  assert.equal(reloaded.peers[0]!.url, "http://127.0.0.1:1");
  assert.match(readFileSync(cfgPath, "utf8"), /# my id: their id\. Also the allowlist\./,
    "and the notes about the relationship");
}

/* ------------------------------- a writable file in a read-only directory */

{
  // The normal case on a hardened unit, not an edge one:
  // ReadWritePaths=/etc/hearth.yaml makes that file writable and leaves /etc
  // read-only, so staging a sibling temp file fails while the file itself is
  // fine. Refusing to save there would mean refusing on the configuration the
  // README recommends.
  const locked = mkdtempSync(join(tmpdir(), "hearth-ro-"));
  const roCfg = join(locked, "hearth.yaml");
  writeFileSync(roCfg, ORIGINAL);
  chmodSync(locked, 0o500);
  try {
    const node = createNode(loadConfig(roCfg), silentLogger);
    await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
    const post = (body: unknown) =>
      fetch(`${url}/control`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    assert.equal((await post({ share: { mine: false } })).status, 200);
    assert.equal((await post({ save: true })).status, 200, "a writable file is enough, directory or not");
    assert.deepEqual(loadConfig(roCfg).share, [], "and the write actually landed");
    await node.close();
  } finally {
    chmodSync(locked, 0o700);
  }
}

/* ------------------------------------------ read-only config falls back to state */

{
  writeFileSync(cfgPath, ORIGINAL);
  const statePath = join(dir, "state", "overrides.json");
  const cfg = parseConfig({
    ...(await import("yaml")).parse(ORIGINAL),
    stateFile: statePath,
  });
  // configPath is set by loadConfig and by nothing else, so a config that never
  // came from a file behaves exactly like one that cannot be written.
  assert.equal(cfg.configPath, null);
  const node = createNode(cfg, silentLogger);
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const state = (await (await fetch(`${url}/control`)).json()) as { savesTo: string; savePath: string };
  assert.equal(state.savesTo, "state", "no writable config, so the sidecar is the destination");
  assert.equal(state.savePath, statePath);
  await node.close();
}

await new Promise<void>((r) => be.server.close(() => r()));
console.log("saveconfig.test.ts ok");
