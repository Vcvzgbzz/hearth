/**
 * Self-check for the two things the console can now change: which models we
 * lend, and which of a peer's models we can reach.
 *
 * The failures worth catching are both "it looked like it worked":
 *
 *   - a per-model change that only lands on ONE of the four share gates, so
 *     `share` reads right on the status page while a peer can still borrow the
 *     model you just withheld
 *   - a link that writes the mapping and not the route, which is a model that
 *     appears mapped, appears reachable, and quietly runs at home forever
 *
 * Both are invisible from the response to the write, which is why they are
 * asserted from the far side — a peer's request, and a routing decision.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Controls } from "../src/controls.js";
import { silentLogger } from "../src/log.js";
import { link, setShare, unlink } from "../src/configfile.js";
import { decide } from "../src/route.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

/* --------------------------------------------- the objects, in isolation */

{
  const c = new Controls();
  assert.deepEqual(c.share(["a", "b"]), ["a", "b"], "the config decides");
  c.set({ lending: false });
  assert.deepEqual(c.share(["a", "b"]), [], "the master switch wins: a pause lends nothing");

  // Per-model lending edits share: itself, keeping the file's order and appending new ids.
  const cfg = parseV1({ name: "me", backend: { url: "http://127.0.0.1:1", serves: ["a", "b", "c"] }, share: ["a", "b"] });
  setShare(cfg, "a", false);
  assert.deepEqual(cfg.share, ["b"], "withholding one leaves the rest");
  setShare(cfg, "c", true);
  setShare(cfg, "a", true);
  assert.deepEqual(cfg.share, ["b", "c", "a"], "and lending appends");
}

{
  // A link is TWO writes. The route is the half that gets forgotten, so it is
  // asserted through decide() rather than by reading cfg back.
  const cfg = parseV1({
    name: "me",
    backend: { url: "http://127.0.0.1:1", serves: ["local-only"], kind: "none" },
    peers: [{ name: "friend", url: "http://127.0.0.1:2", token: "t", models: { known: "known" } }],
  });
  const peers = {
    candidates: (m: string, named: string[]) =>
      cfg.peers.filter((p) => p.models[m] && (!named.length || named.includes(p.name))).map((p) => p.name),
    theirModelId: (peer: string, m: string) => cfg.peers.find((p) => p.name === peer)?.models[m],
  } as never;

  assert.equal(decide("theirs", cfg, peers, { queued: 0, free: 1, slots: 1, loaded: [] }).target,
    "local", "unmapped and unrouted, so it stays home");

  link(cfg, "friend", "theirs", "their-name", "peer", false);
  const after = decide("theirs", cfg, peers, { queued: 0, free: 1, slots: 1, loaded: [] });
  assert.equal(after.target, "peer", "a link must route, not just map");
  assert.equal(after.target === "peer" && after.theirModel, "their-name",
    "and dispatch under THEIR id");

  // An existing route that names its peers is an operator being specific.
  // Widening it to everyone would send work to boxes they left out.
  cfg.models.pinned = { backend: null, as: null, follow: false, policy: "peer", peers: ["friend"], spilloverAt: 1, fallbackLocal: true, concurrency: null, params: null, lane: null, whenHeld: null, stats: null, emulate: null, pool: null };
  link(cfg, "friend", "pinned", "pinned", "peer", true);
  assert.deepEqual(cfg.models.pinned!.peers, ["friend"], "an existing peer list is kept");

  assert.throws(() => link(cfg, "nobody", "x", "x", "peer", false), /not a configured peer/,
    "peers are added in the file, not here");

  // A route that NAMES its peers, with two peers mapping the model. Testing
  // "does any peer map this" said yes because the OTHER one did, so the route
  // survived pointing at a peer it no longer had — and then would not save,
  // with an error about a line nobody had touched.
  {
    const two = parseV1({
      name: "me",
      backend: { url: "http://127.0.0.1:1", serves: ["local-only"], kind: "none" },
      peers: [
        { name: "a", url: "http://127.0.0.1:2", token: "t", models: { shared: "shared" } },
        { name: "b", url: "http://127.0.0.1:3", token: "t", models: { shared: "shared" } },
      ],
      models: { shared: { policy: "peer", peers: ["a"] } },
    });
    unlink(two, "a", "shared");
    assert.equal(two.models.shared, undefined,
      "the route named only the peer we unlinked, so it is retired");
    assert.equal(two.peers[1]!.models.shared, "shared", "the other peer keeps its mapping");
  }

  // Narrowing a list is not the same as emptying it: `peers: []` means "anyone
  // who maps it", which is WIDER than the list we started from.
  {
    const three = parseV1({
      name: "me",
      backend: { url: "http://127.0.0.1:1", serves: ["x"], kind: "none" },
      peers: [
        { name: "a", url: "http://127.0.0.1:2", token: "t", models: { shared: "shared" } },
        { name: "b", url: "http://127.0.0.1:3", token: "t", models: { shared: "shared" } },
      ],
      models: { shared: { policy: "peer", peers: ["a", "b"] } },
    });
    unlink(three, "a", "shared");
    assert.deepEqual(three.models.shared!.peers, ["b"], "only the unlinked peer comes out");
  }

  // A route carries facts about YOUR machine too. Deleting the whole entry on
  // an unlink threw away a batch size and a backend pin that had nothing to do
  // with the peer — silently, and irreversibly once the config was written.
  {
    const rich = parseV1({
      name: "me",
      backends: [
        { name: "gpu", url: "http://127.0.0.1:1", serves: ["vllm-model"], kind: "none" },
        { name: "cpu", url: "http://127.0.0.1:9", serves: ["other"], kind: "none" },
      ],
      peers: [{ name: "a", url: "http://127.0.0.1:2", token: "t", models: { "vllm-model": "theirs" } }],
      models: { "vllm-model": { policy: "peer", backend: "gpu", batch: 32 } },
    });
    unlink(rich, "a", "vllm-model");
    assert.equal(rich.models["vllm-model"]!.policy, "local", "it stops going away");
    assert.equal(rich.models["vllm-model"]!.concurrency, 32, "and keeps what was never about the peer");
    assert.equal(rich.models["vllm-model"]!.backend, "gpu");
  }

  // Declared stats are the same kind of fact: yours, about your machine, and
  // the only thing that can check a model nobody has loaded. An unlink that
  // deleted the entry would take the window with it.
  {
    const declared = parseV1({
      name: "me",
      backend: { url: "http://127.0.0.1:1", serves: ["small"], kind: "none" },
      peers: [{ name: "a", url: "http://127.0.0.1:2", token: "t", models: { small: "theirs" } }],
      models: { small: { policy: "peer", stats: { context: 4096 } } },
    });
    unlink(declared, "a", "small");
    assert.equal(declared.models.small!.policy, "local");
    assert.equal(declared.models.small!.stats?.context, 4096, "the declared window survives an unlink");
  }

  // Unlink drops a route we invented, and leaves one the file declared. The
  // second is the important half: rewriting the operator's stated intent would
  // make the file on disk and the config in memory disagree about something
  // nobody changed.
  unlink(cfg, "friend", "theirs");
  assert.equal(cfg.models.theirs, undefined, "our own route goes with the mapping");
  unlink(cfg, "friend", "known");
  assert.equal(cfg.peers[0]!.models.known, undefined, "a file mapping can still be removed");

}

/* ----------------------------------------------------- and through HTTP */

function stubBackend() {
  const s = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mine" }, { id: "spare" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
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

const cfg = parseV1({
  name: "node-under-test",
  backend: { url: be.url(), kind: "none" },
  share: ["mine"],
  peerTokens: { friend: "their-token" },
  peers: [{ name: "friend", url: "http://127.0.0.1:1", token: "t", models: { borrowed: "theirs" } }],
  models: { borrowed: { policy: "peer", peers: ["friend"], fallbackLocal: true } },
});
const node = createNode(cfg, silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;

const control = (body: unknown) =>
  fetch(`${url}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const asPeer = { Authorization: "Bearer their-token", "Content-Type": "application/json" };
const borrow = (model: string) =>
  fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: asPeer,
    body: JSON.stringify({ model, messages: [] }),
  });
const advertised = async () => {
  const r = await fetch(`${url}/peer/state`, { headers: { Authorization: "Bearer their-token" } });
  return ((await r.json()) as { serves: string[] }).serves;
};

{
  assert.equal((await borrow("mine")).status, 200, "the configured share is lendable to start");

  assert.equal((await control({ share: { mine: false } })).status, 200);
  assert.equal((await borrow("mine")).status, 403, "GATE 1: the peer chat path");
  assert.deepEqual(await advertised(), [], "GATE 2: and we stop advertising it");

  assert.equal((await control({ share: { spare: true } })).status, 200);
  assert.deepEqual(await advertised(), ["spare"], "something the file never shared can be lent");
  assert.equal((await borrow("spare")).status, 200, "and is then actually borrowable");

  // Advertising a model no backend serves would 404 every request for it, and
  // the peer's operator cannot tell that from a broken link.
  const bad = await control({ share: { nonexistent: true } });
  assert.equal(bad.status, 400, "lending something we cannot serve is refused");

  assert.equal((await control({ share: { mine: true, spare: false } })).status, 200);
  assert.deepEqual(await advertised(), ["mine"], "and both edits can be put back");
}

{
  // The write routes are the only ones here that change anything, so a peer
  // reaching them would let someone else decide what we lend.
  const r = await fetch(`${url}/control`, {
    method: "POST",
    headers: asPeer,
    body: JSON.stringify({ share: { mine: false } }),
  });
  assert.equal(r.status, 401, "a peer token is not authority over our own controls");
  assert.deepEqual(await advertised(), ["mine"], "and nothing changed");
}

{
  const r = await control({ link: { peer: "friend", mine: "new-thing", theirs: "their-thing" } });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { config: { path: string | null; restartPending: string[] } };
  assert.equal(d.config.path, null, "a node built in code keeps edits in memory, and says so");
  assert.deepEqual(d.config.restartPending, [], "a link applies live");

  const net = await (await fetch(`${url}/network`)).json() as {
    nodes: { self: boolean; map?: Record<string, string> }[];
  };
  const friend = net.nodes.find((n) => !n.self)!;
  assert.equal(friend.map!["new-thing"], "their-thing", "the page sees the pair it just added");

  // Both at once took link's fields and performed the unlink, which is a
  // mapping removed by someone who was adding one.
  const both = await control({
    link: { peer: "friend", mine: "new-thing", theirs: "x" },
    unlink: { peer: "friend", mine: "new-thing" },
  });
  assert.equal(both.status, 400, "link and unlink together is a mistake, not a merge");

  assert.equal((await control({ unlink: { peer: "friend", mine: "new-thing" } })).status, 200);
  const after = await (await fetch(`${url}/network`)).json() as { nodes: { self: boolean; map?: Record<string, string> }[] };
  assert.equal(after.nodes.find((n) => !n.self)!.map!["new-thing"], undefined, "and taking it back removes it");
}

await node.close();
await new Promise<void>((r) => be.server.close(() => r()));
console.log("sharing.test.ts ok");
