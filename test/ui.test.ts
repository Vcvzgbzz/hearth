/**
 * The console and the one endpoint that feeds it.
 *
 * Two things worth asserting. The first is the gate: /ui/data and /ui/events
 * take loopback or an operator session, and a valid api key does NOT open them.
 * If that check ever softens into localCaller, a node bound to 0.0.0.0 starts
 * handing its queue contents and model inventory to anyone holding a chat key.
 *
 * The second is that /ui/data actually carries what the page draws. src/console/types.ts
 * now states the shape the console consumes, but nothing connects it to the
 * server that builds the payload, so a renamed field would still surface as a
 * blank panel rather than a failure.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";

import { History } from "../src/history.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { CONSOLE_HTML } from "../src/ui.js";
import { parseV1 } from "./v1.js";

// --- the shell must actually carry the console -----------------------------
// The class of bug this replaces is gone rather than tested for: the page was a
// TypeScript template literal containing JavaScript, and a `\"` in the inner
// layer collapsed to a bare `"` on the way out, terminating the emitted string
// and making the script unparseable. tsc saw perfectly valid TypeScript, every
// other test here passed, and the browser rendered a blank page. Shipped
// exactly that on 2026-08-16 and only found it by opening a browser.
//
// src/console/ is ordinary .tsx now, so esbuild fails the build on a syntax error
// and `npm run typecheck` covers the rest. What is still worth asserting is the
// join: `npm test` runs build:console first, and if the bundle went missing or empty
// the page would serve a mount point and nothing to mount into it — which looks
// exactly like the old blank page.
{
  assert.match(CONSOLE_HTML, /<div id="root">/, "the shell must have a mount point");
  const script = CONSOLE_HTML.match(/<div id="root"><\/div>\n<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  assert.ok(script.length > 10_000, "the compiled console must be inlined, not a stub");
  assert.ok(script.includes("react-dom"), "and it must actually be the bundle");
  // The HTML parser ends a script at the first literal `</script`, wherever it
  // appears — inside a string literal included.
  assert.ok(!script.includes("</script"), "nothing in the bundle may close the tag early");
  // esbuild reads tsconfig.json by default, which does not set `jsx` because it
  // is the config for the SERVER half. Built that way the bundle emits classic
  // `React.createElement` against a global that nothing defines, and the page is
  // blank with one ReferenceError in a console nobody is watching — which is how
  // this was found. The fix is `--tsconfig=tsconfig.ui.json` in build:console; this is
  // what notices if it goes missing.
  //
  // ponytail: pins the one symptom rather than rendering the page. A real mount
  // check wants jsdom; add it if a second bug of this shape gets through.
  assert.ok(!script.includes("React.createElement"),
    "the bundle must use the automatic JSX runtime — build:console lost its --tsconfig");
}

// --- the ring buffer, on its own ------------------------------------------
{
  let depth = 0;
  // keep=3, so a fourth sample must push the first one out rather than grow.
  const h = new History(() => ({ queued: depth++, residents: ["m1"], perBackend: [] }), 10_000, 3);
  h.sample(); h.sample(); h.sample(); h.sample();
  const all = h.all();
  assert.equal(all.length, 3, "the window must be a ring, not a growing array");
  assert.deepEqual(all.map((s) => s.queued), [1, 2, 3], "the oldest sample is dropped");
  assert.deepEqual(all[0]!.residents, ["m1"]);

  // start() takes one immediately: a graph that is blank for the first 5s
  // reads as broken.
  const h2 = new History(() => ({ queued: 7, residents: [], perBackend: [] }), 10_000, 5);
  // A reader that reports usage sees it stored per reading, one entry per
  // finished call; a reader that does not report it gets empty lists, not
  // undefined, so the chart never has to guard.
  const h3 = new History(() => ({ queued: 0, residents: ["m1"], perBackend: [], active: ["m1"] }), 10_000, 2, 3);
  h3.sample();
  assert.deepEqual(h3.all()[0]!.active, ["m1"]);
  h.sample();
  assert.deepEqual(h.all().at(-1)!.active, [], "absent usage reads as none");
  // Calls are their own ring: one entry per finished request, capped, and
  // reported only inside the samples' window so the two never disagree about
  // how far back the page can see.
  const call = (t: number) => ({ t, model: "m1", backend: "b", ms: 100, waitedMs: 0, ok: true });
  h3.record(call(Date.now() - 60_000_000)); // long before the window
  h3.record(call(Date.now() - 1000));
  h3.record(call(Date.now()));
  assert.equal(h3.calls().length, 2, "a call older than the window is not reported");
  h3.record(call(Date.now())); h3.record(call(Date.now()));
  assert.equal(h3.calls().length, 3, "the ring is capped at keepCalls");
  h2.start();
  assert.equal(h2.all().length, 1, "start() samples once up front");
  h2.stop();
  const after = h2.all().length;
  h2.stop(); // idempotent
  assert.equal(h2.all().length, after);
}

// --- the served page and its data -----------------------------------------
const backend = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }));
    return;
  }
  if (req.url === "/running") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ running: [{ model: "m1", state: "ready" }] }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

// apiKeys ARE set here on purpose: the page's gate must not depend on them.
const node = createNode(
  parseV1({
    name: "ui-test",
    // Serves /running, so it IS a llama-swap backend. Under the old boolean
    // this said false and still expected /running to be polled, which is the
    // contradiction `kind` removed.
    backend: { url: backendUrl, kind: "llama-swap" },
    apiKeys: ["secret-key"],
  }),
  silentLogger,
);
node.start();
const base = await new Promise<string>((ready) =>
  node.server.listen(0, "127.0.0.1", () =>
    ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
);

{
  const page = await fetch(`${base}/ui`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store",
    "a cached copy of a live status page is a lie");
  const html = await page.text();
  assert.match(html, /<title>hearth<\/title>/);
  assert.ok(html.includes("/ui/data") && html.includes("/ui/events"), "the page must fetch its own endpoints");
  assert.match(html, /restart hearth to apply/, "the page says what is waiting on a restart");
  assert.ok(!html.includes("secret-key"), "no credential may appear in the page");
  for (const gone of ["/ui/classic", "/ui/next"]) {
    assert.notEqual((await fetch(`${base}${gone}`)).status, 200, `${gone} is gone with the previous console`);
  }
}

{
  // A llama-swap backend tries SSE first and only falls back to /running when
  // that 404s, so warm state lands a round trip later than it used to. Wait for
  // it rather than racing it.
  await node.pool.first().state.ensureFresh();
  const r = await fetch(`${base}/ui/data`);
  assert.equal(r.status, 200);
  const d = (await r.json()) as {
    net: { nodes: { name: string; self?: boolean; slots?: number | null }[];
           readyNow: string[]; available: string[] };
    q: { jobs: unknown[]; capacity: { slots: number; queued: Record<string, number> } };
    hist: { t: number; queued: number; residents: string[]; active: string[] }[];
    calls: { t: number; model: string; backend: string; ms: number; waitedMs: number; ok: boolean }[];
  };

  // Every field the page reads, in one assertion block, so a rename fails here
  // rather than as an empty panel someone notices a week later.
  const self = d.net.nodes.find((n) => n.self);
  assert.ok(self, "the page keys everything off the self node");
  assert.equal(self.name, "ui-test");
  assert.equal(self.slots, 1, "slots is new — the graph draws pips from it");
  assert.deepEqual(d.net.readyNow, ["m1"], "loaded models are the warm chips");
  assert.deepEqual(d.net.available.sort(), ["m1", "m2"]);
  assert.ok(Array.isArray(d.q.jobs));
  assert.equal(d.q.capacity.slots, 1);
  assert.ok(Array.isArray(d.hist));
  assert.ok(d.hist.length >= 1, "start() must have seeded a sample");
  assert.equal(typeof d.hist[0]!.t, "number");
  assert.equal(d.hist[0]!.queued, 0);
  // The very first sample is taken before the backend's first refresh has
  // landed, so `resident` is null there and fills in from the next one. That is
  // the honest answer — we genuinely do not know yet — and it self-corrects
  // within one interval, so it is asserted rather than papered over.
  assert.deepEqual(d.hist[0]!.residents, [], "nothing is known to be loaded yet");
  // Usage rides on the same reading as residency. Nothing has run yet, so both
  // are empty; the shape is what the lanes chart keys off to tell "loaded"
  // from "in use", and a missing field would silently draw everything idle.
  assert.deepEqual(d.hist[0]!.active, [], "nothing is running at the first reading");
  assert.deepEqual(d.calls, [], "and no call has finished here yet");

  await node.pool.first().state.ensureFresh();
  node.history.sample();
  const later = (await (await fetch(`${base}/ui/data`)).json()) as typeof d;
  assert.deepEqual(later.hist.at(-1)!.residents, ["m1"],
    "once the backend has been read, the lane chart has something to draw");
  // The page compares this with the one it was loaded under, and reloads when a restart changed it.
  assert.match((later as unknown as { build: string }).build, /^[0-9a-f]{12}$/);
}

// --- the hardware the page draws ------------------------------------------
//
// The three things the console could not express at all until it was given
// them, and the reason each is on the wire:
//
//   resources  a card is the thing that decides whether a backend may run,
//              and it appeared NOWHERE in the payload
//   routes     a route backend has an empty `serves`, so without these it
//              renders as a bare name with nothing beside it, forever
//   holder     "free" and "somebody else has it" are the difference between
//              idle and blocked, which the page drew identically
//
// Asserted here rather than in the components because this is the join: the
// page can only draw a card if the server names one.
{
  const shared = createNode(
    parseV1({
      name: "two-cards",
      backends: [
        { name: "swap", url: backendUrl, kind: "llama-swap", resources: ["gpu0"] },
        { name: "img", url: backendUrl, kind: "llama-swap", serves: ["image"], resources: ["gpu1"] },
        {
          name: "video", url: backendUrl, kind: "none", concurrency: 1, resources: ["gpu1"],
          routes: [{ path: "/generate", model: "video-wan" }],
        },
        { name: "embed", url: backendUrl, llamaSwapExtras: false, serves: ["embed"] },
      ],
    }),
    silentLogger,
  );
  shared.start();
  const at = await new Promise<string>((ready) =>
    shared.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(shared.server.address() as AddressInfo).port}`)),
  );
  const d = (await (await fetch(`${at}/ui/data`)).json()) as {
    net: {
      resources: { name: string; holder: string | null; backends: string[] }[];
      evictions: unknown[];
      nodes: { self?: boolean; backends?: {
        name: string; resources: string[]; answering: boolean;
        routes: { path: string; model: string; lane: string; queue: boolean }[];
      }[] }[];
    };
  };

  assert.deepEqual(
    d.net.resources.map((r) => [r.name, r.holder, r.backends.join("+")]),
    [["gpu0", null, "swap"], ["gpu1", null, "img+video"]],
    "every declared card, who is on it, and who takes turns for it",
  );
  assert.ok(Array.isArray(d.net.evictions), "handoffs are a list, empty until one happens");

  const backends = d.net.nodes.find((n) => n.self)!.backends!;
  const video = backends.find((b) => b.name === "video")!;
  assert.deepEqual(video.resources, ["gpu1"]);
  assert.deepEqual(video.routes, [{ path: "/generate", model: "video-wan", lane: "batch", queue: true }],
    "a route backend is described by its paths, since it has no models to show");
  assert.deepEqual(backends.find((b) => b.name === "embed")!.resources, [],
    "a backend that declares nothing competes for nothing, and draws as unpinned");
  // Silence is only evidence where we are listening. None of these backends
  // has an event stream — the mock has no /api/events — so hearth is never in
  // contact with them unless something is being asked, and it says nothing
  // rather than saying `false` and having the page draw a fault against a
  // backend that is perfectly well. The stream-backed case is pinned in
  // healthz.test.ts, where the mock can actually hold one open.
  for (const b of backends) {
    assert.ok(!("answering" in b),
      `${b.name}: not knowing whether we have heard from it is its own answer`);
  }

  await shared.close();
}

// --- the gate --------------------------------------------------------------
//
// The real test: bind a second node to every interface and knock on it from
// this machine's own LAN address, which is not loopback. Sandboxes without a
// routable interface skip it rather than pretend.
{
  const iface = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);

  if (!iface) {
    console.log("  .. skipped the off-box probe: no non-loopback interface here");
  } else {
    const wide = createNode(
      parseV1({
        name: "wide",
        backend: { url: backendUrl, llamaSwapExtras: false },
        listen: { host: "0.0.0.0" },
        apiKeys: ["secret-key"],
      }),
      silentLogger,
    );
    wide.start();
    const port = await new Promise<number>((ready) =>
      wide.server.listen(0, "0.0.0.0", () =>
        ready((wide.server.address() as AddressInfo).port)),
    );
    const remote = `http://${iface.address}:${port}`;

    // The shell is static — every byte of data comes from /ui/data and /ui/events — so it
    // may go out wide; the gate that matters is the one on the data stream.
    const page = await fetch(`${remote}/ui`);
    assert.equal(page.status, 200, "/ui is a static shell, open to anyone who can reach it");
    await page.text();

    for (const path of ["/ui/data", "/ui/events"]) {
      const bare = await fetch(`${remote}${path}`);
      assert.equal(bare.status, 403, `${path} must refuse an off-box caller`);

      // The point of the whole test: a VALID api key still does not open it.
      // A key runs models and edits config; the dashboard is a login, not a key.
      const keyed = await fetch(`${remote}${path}`, {
        headers: { Authorization: "Bearer secret-key" },
      });
      assert.equal(keyed.status, 403,
        `${path} stays closed for a valid api key`);
      assert.match(await keyed.text(), /logged-in operator/);
    }

    // ...while a route that IS key-gated still works from the same place, so
    // the 403s above are this gate and not a broken listener.
    const models = await fetch(`${remote}/v1/models`, {
      headers: { Authorization: "Bearer secret-key" },
    });
    assert.equal(models.status, 200, "the wide bind itself works with a key");

    await wide.close();
  }
}

// --- the page's numbers follow the LOADED model's ceiling ------------------
//
// A seat with concurrency 4 fronting a model started with --parallel 2 used to
// draw "2/4 free" next to two jobs that could never use those slots — a steady
// state that reads as a stuck queue rather than a cap doing its job. The
// aggregate a protocol-1 peer scores us by stays on the backend's number, which
// is the one it has always been given.
{
  const capped = createNode(
    parseV1({
      name: "capped",
      backend: { url: backendUrl, kind: "llama-swap", concurrency: 4 },
      models: { m1: { concurrency: 2 }, m2: { concurrency: 4 } },
      share: ["m1"],
    }),
    silentLogger,
  );
  capped.start();
  const at = await new Promise<string>((ready) =>
    capped.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(capped.server.address() as AddressInfo).port}`)),
  );
  // m1 is what /running reports, so it is the resident one whose number binds.
  await capped.pool.first().state.ensureFresh();

  const d = (await (await fetch(`${at}/ui/data`)).json()) as {
    net: { nodes: { self?: boolean; slots?: number; free?: number;
                    backends?: { slots: number; free: number }[] }[] };
    q: { capacity: { slots: number; free: number } };
  };
  assert.deepEqual(
    [d.q.capacity.slots, d.q.capacity.free], [2, 2],
    "the vitals must show what the loaded model can actually take",
  );
  const self = d.net.nodes.find((n) => n.self)!;
  assert.deepEqual([self.slots, self.free], [2, 2], "and so must the node row");
  assert.deepEqual([self.backends![0]!.slots, self.backends![0]!.free], [2, 2],
    "including the per-backend line under it");

  // /peer/state wants a peer credential, so this asks the pool the same
  // question the endpoint does: the aggregate it sends is deliberately NOT
  // narrowed, or every protocol-1 borrower's score changes under it.
  const agg = capped.pool.aggregate();
  assert.deepEqual(
    [agg.slots, agg.free], [4, 4],
    "the frozen protocol-1 aggregate keeps answering with the backend's number",
  );
  const perModel = capped.pool.capacityFor("m1");
  assert.deepEqual(
    [perModel.slots, perModel.free], [2, 2],
    "while protocol 2 asks per model and gets the real one",
  );
  await capped.close();
}

// --- which ids are one seat under another name -----------------------------
//
// `models.<id>.as` rewrites an advertised id on the way to a local backend.
// When the target is itself an advertised model, the two ids are one set of
// weights with different defaults (per-model `params`), and a page that draws
// them as unrelated rows is wrong about how many models there are. The console
// folds those under their parent, which it can only do if the server says
// which ids alias which - so the join is asserted here, like `resources` and
// `routes` above.
{
  const aliased = createNode(
    parseV1({
      name: "aliases",
      backend: { url: backendUrl, kind: "llama-swap" },
      models: {
        "m1-fast": { as: "m1" },
        // A rename onto a backend-only wire id, not a variant. Sent the same
        // way; the page decides, because it is the one holding the catalog.
        friendly: { as: "m2-on-the-wire" },
      },
    }),
    silentLogger,
  );
  aliased.start();
  const abase = await new Promise<string>((ready) =>
    aliased.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(aliased.server.address() as AddressInfo).port}`)),
  );
  const d = (await (await fetch(`${abase}/ui/data`)).json()) as { aliases: Record<string, string> };
  assert.deepEqual(d.aliases, { "m1-fast": "m1", friendly: "m2-on-the-wire" },
    "every `as` goes on the wire, keyed by the advertised id");
  await aliased.close();
}

// --- where each id is allowed to go ----------------------------------------
//
// A peer mapping only says a request MAY leave this box. A flow says whether it
// will, and what happens when the peer cannot take it -- the difference between
// a slow request and a refusal. Neither can be read off the mapping, so the
// console can only state them if the server sends the flows.
{
  const routed = createNode(
    parseV1({
      name: "routing",
      backend: { url: backendUrl, kind: "llama-swap" },
      peers: [{ name: "friend", url: "http://127.0.0.1:1", token: "t", models: { shared: "shared", theirs: "theirs" } }],
      models: {
        shared: { policy: "fastest", fallbackLocal: true },
        theirs: { policy: "peer", peers: ["friend"], fallbackLocal: false },
      },
    }),
    silentLogger,
  );
  routed.start();
  const rbase = await new Promise<string>((ready) =>
    routed.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(routed.server.address() as AddressInfo).port}`)),
  );
  const rd = (await (await fetch(`${rbase}/ui/data`)).json()) as {
    flows: Record<string, { inputs: string[]; steps: { to: Record<string, unknown> }[] }>;
  };
  assert.deepEqual(rd.flows.shared?.steps.map((s) => s.to), [{ fastest: [{ model: "shared" }, { peer: "friend", model: null }] }],
    "a model we also serve keeps home as an option");
  assert.deepEqual(rd.flows.theirs?.steps.map((s) => Object.keys(s.to)[0]), ["peer", "refuse"],
    "no local fallback is its own step, so the page can say what happens when the peer cannot take it");
  await routed.close();
}

await node.close();
backend.closeAllConnections();
backend.close();
console.log("ui.test.ts ok");
