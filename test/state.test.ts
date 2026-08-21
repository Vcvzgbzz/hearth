/**
 * Self-check for the sidecar: what survives a restart, and what must not.
 *
 * The failures worth catching are all about the SECOND source of truth, which
 * is the price of persistence and the reason saving is opt-in:
 *
 *   - a saved state that keeps overriding a config someone has since edited,
 *     so a change to the YAML silently does nothing
 *   - a saved state that looks "in the config" after a restart, so the page
 *     stops offering the YAML for something that is still only on this box
 *   - a corrupt file taking the node down, turning a lost preference into an
 *     outage
 *   - a save that failed reporting success, so the operator restarts believing
 *     the work is kept
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { readState } from "../src/overrides.js";
import { createNode } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "hearth-state-"));
// A subdirectory that does NOT exist, since the real path is a StateDirectory=
// that systemd may not have created yet on the very first start.
const statePath = join(dir, "nested", "overrides.json");

function stubBackend() {
  const s = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "mine" }, { id: "spare" }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "local" } }] }));
  });
  return {
    server: s,
    listen: () => new Promise<void>((r) => s.listen(0, "127.0.0.1", r)),
    url: () => `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
  };
}

const be = stubBackend();
await be.listen();

const makeCfg = (stateFile: string | undefined) =>
  parseConfig({
    name: "persisted",
    backend: { url: be.url(), kind: "none", serves: ["mine", "spare"] },
    share: ["mine"],
    ...(stateFile ? { stateFile } : {}),
    peerTokens: { friend: "their-token" },
    peers: [{ name: "friend", url: "http://127.0.0.1:1", token: "t", models: { borrowed: "theirs" } }],
    models: { borrowed: { policy: "peer", peers: ["friend"], fallbackLocal: true } },
  });

async function boot(stateFile: string | undefined) {
  const node = createNode(makeCfg(stateFile), silentLogger);
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  return {
    node,
    control: (body: unknown) =>
      fetch(`${url}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    read: async () => (await (await fetch(`${url}/control`)).json()) as {
      share: string[];
      dirty: boolean;
      unsaved: boolean;
      canSave: boolean;
    },
  };
}

/* ------------------------------------------------- nothing without opting in */

{
  const a = await boot(undefined);
  const before = await a.read();
  assert.equal(before.canSave, false, "persistence is off unless a path is configured");

  await a.control({ share: { mine: false } });
  const refused = await a.control({ save: true });
  assert.equal(refused.status, 400, "and Save says so rather than silently doing nothing");
  assert.match((await refused.text()), /stateFile/, "naming the key that turns it on");
  await a.node.close();
}

/* --------------------------------------------------- save, restart, still there */

{
  const a = await boot(statePath);
  const fresh = await a.read();
  assert.equal(fresh.canSave, true);
  // Nothing overridden and no sidecar: there is nothing to save, and offering
  // to save nothing is an invitation to write an empty file.
  assert.equal(fresh.unsaved, false, "a node with no overrides has no unsaved work");

  assert.equal((await a.control({ share: { mine: false, spare: true } })).status, 200);
  assert.equal(
    (await a.control({ link: { peer: "friend", mine: "linked", theirs: "their-linked" } })).status, 200);

  const mid = await a.read();
  assert.equal(mid.unsaved, true, "changed and not yet saved");

  const saved = await a.control({ save: true });
  assert.equal(saved.status, 200);
  const after = (await saved.json()) as { unsaved: boolean; dirty: boolean };
  assert.equal(after.unsaved, false, "saving clears it");
  assert.equal(after.dirty, true,
    "but SAVED is not IN THE CONFIG — the page must keep offering the YAML");
  await a.node.close();

  // The file itself, since a restart is the only consumer and it is the one
  // thing a unit test can check that the running process cannot.
  const onDisk = readState(statePath, silentLogger)!;
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.share, { mine: false, spare: true });
  assert.equal(onDisk.maps.friend!.linked, "their-linked");
  assert.equal(onDisk.routes.linked!.policy, "peer",
    "not served here, so it routes to the peer with no fallback");
  assert.equal(onDisk.routes.linked!.fallbackLocal, false);

  const b = await boot(statePath);
  const back = await b.read();
  assert.deepEqual(back.share.slice().sort(), ["spare"],
    "a fresh process lends what was saved, not what the file says");
  assert.equal(back.unsaved, false, "and starts clean rather than looking pending");
  assert.equal(back.dirty, true, "while still differing from the config file");

  // Reverting everything and saving must leave NO trace. A sidecar full of
  // no-ops is a thing someone finds later and has to reason about.
  await b.control({ share: { mine: null, spare: null } });
  await b.control({ unlink: { peer: "friend", mine: "linked" } });
  await b.control({ save: true });
  assert.equal(existsSync(statePath), false, "an empty state removes the file");
  const clean = await b.read();
  assert.deepEqual(clean.share, ["mine"], "and we are back to the config exactly");
  assert.equal(clean.dirty, false);
  await b.node.close();
}

/* ------------------------------------------------------ the file goes wrong */

{
  writeFileSync(statePath, "{ this is not json");
  const a = await boot(statePath);
  const r = await a.read();
  assert.deepEqual(r.share, ["mine"],
    "a truncated sidecar starts from the config rather than refusing to start");
  assert.equal(r.canSave, true, "and saving still works, which is what fixes it");
  await a.node.close();

  // A version we do not understand is not a file to guess at.
  writeFileSync(statePath, JSON.stringify({ version: 99, share: { mine: false } }));
  const b = await boot(statePath);
  assert.deepEqual((await b.read()).share, ["mine"], "an unknown version is ignored, not parsed");
  await b.node.close();

  // A sidecar written before unlink learned to take the route with it. The
  // dangling route goes back on restore, and the node cannot then save its way
  // out of a state it did not choose — which is what happened on web.
  writeFileSync(statePath, JSON.stringify({
    version: 1, savedAt: "", share: {},
    maps: { friend: { borrowed: null } }, routes: {},
  }));
  const d = await boot(statePath);
  const view = (await (await fetch(
    `http://127.0.0.1:${(d.node.server.address() as AddressInfo).port}/control`)).json()) as {
      changes: { routes: { model: string; removed: boolean }[] };
    };
  assert.ok(view.changes.routes.some((r) => r.model === "borrowed" && r.removed),
    "restoring an unmapped model drops its route, the same as unlinking would");
  await d.node.close();

  // A peer the config no longer has. The trust decision that made it a peer was
  // withdrawn, and a sidecar must not put it back.
  writeFileSync(statePath, JSON.stringify({
    version: 1, savedAt: "", share: {},
    maps: { "deleted-friend": { x: "y" } }, routes: {},
  }));
  const c = await boot(statePath);
  const net = (await (await fetch(
    `http://127.0.0.1:${(c.node.server.address() as AddressInfo).port}/network`)).json()) as {
      nodes: { name: string }[];
    };
  assert.ok(!net.nodes.some((n) => n.name === "deleted-friend"),
    "a peer removed from the config stays removed");
  await c.node.close();
}

await new Promise<void>((r) => be.server.close(() => r()));
console.log("state.test.ts ok");
