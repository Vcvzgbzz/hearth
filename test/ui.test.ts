/**
 * The status page and the one endpoint that feeds it.
 *
 * Two things worth asserting. The first is the gate: /ui and /ui/data are
 * loopback-only, and unlike everything else on this server that is NOT relaxed
 * by configuring apiKeys, because a browser loading a page cannot present a
 * bearer token. If that check ever softens into localCaller, a node bound to
 * 0.0.0.0 starts handing its queue contents and model inventory to the network.
 *
 * The second is that /ui/data actually carries what the page draws. src/ui/types.ts
 * now states the shape the console consumes, but nothing connects it to the
 * server that builds the payload, so a renamed field would still surface as a
 * blank panel rather than a failure.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { History } from "../src/history.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { UI_HTML } from "../src/ui.js";
import { blockers, waitReason } from "../src/ui/why.js";

// --- the shell must actually carry the console -----------------------------
// The class of bug this replaces is gone rather than tested for: the page was a
// TypeScript template literal containing JavaScript, and a `\"` in the inner
// layer collapsed to a bare `"` on the way out, terminating the emitted string
// and making the script unparseable. tsc saw perfectly valid TypeScript, every
// other test here passed, and the browser rendered a blank page. Shipped
// exactly that on 2026-08-16 and only found it by opening a browser.
//
// src/ui/ is ordinary .tsx now, so esbuild fails the build on a syntax error
// and `npm run typecheck` covers the rest. What is still worth asserting is the
// join: `npm test` runs build:ui first, and if the bundle went missing or empty
// the page would serve a mount point and nothing to mount into it — which looks
// exactly like the old blank page.
{
  assert.match(UI_HTML, /<div id="root">/, "the shell must have a mount point");
  const script = UI_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  assert.ok(script.length > 10_000, "the compiled console must be inlined, not a stub");
  assert.ok(script.includes("react-dom"), "and it must actually be the bundle");
  // The HTML parser ends a script at the first literal `</script`, wherever it
  // appears — inside a string literal included.
  assert.ok(!script.includes("</script"), "nothing in the bundle may close the tag early");
  // esbuild reads tsconfig.json by default, which does not set `jsx` because it
  // is the config for the SERVER half. Built that way the bundle emits classic
  // `React.createElement` against a global that nothing defines, and the page is
  // blank with one ReferenceError in a console nobody is watching — which is how
  // this was found. The fix is `--tsconfig=tsconfig.ui.json` in build:ui; this is
  // what notices if it goes missing.
  //
  // ponytail: pins the one symptom rather than rendering the page. A real mount
  // check wants jsdom; add it if a second bug of this shape gets through.
  assert.ok(!script.includes("React.createElement"),
    "the bundle must use the automatic JSX runtime — build:ui lost its --tsconfig");
}

// --- why a job is waiting -------------------------------------------------
//
// The page's one piece of real derivation, and the one thing on it that is a
// claim rather than a readout: "blocked" and "full" and "cold" are different
// problems with different answers, and getting the ORDER wrong is how a job
// waiting on somebody else's GPU gets reported as this backend being busy.
// Admission checks hardware before either of the backend's own ceilings, so
// this must too.
{
  const gpu0 = { name: "gpu0", holder: "video", backends: ["swap", "video"] };
  const free = { name: "gpu1", holder: null, backends: ["other"] };
  const job = { lane: "chat", model: "coder", caller: "x", state: "queued" as const,
                position: 3, since: 0 };

  const swap = { name: "swap", resources: ["gpu0"], slots: 4, free: 0, evicts: true,
                 knowsWarm: true, loaded: ["other-model"] };
  assert.equal(waitReason(job, swap, [gpu0, free]).tone, "blocked",
    "hardware held by another backend outranks this backend being full");
  assert.match(waitReason(job, swap, [gpu0, free]).text, /gpu0/);

  // Same backend, nobody on the card: now the ceiling is the real answer.
  const idle = { ...gpu0, holder: null };
  assert.equal(waitReason(job, swap, [idle, free]).tone, "busy");

  // Room to run, but the wrong model is resident on a backend that evicts.
  assert.equal(waitReason(job, { ...swap, free: 2 }, [idle]).tone, "cold");
  assert.match(waitReason(job, { ...swap, free: 2 }, [idle]).text, /must unload/);

  // A backend that keeps everything resident cannot make a job wait for a
  // load, so claiming it did would be an invention.
  assert.equal(waitReason(job, { ...swap, free: 2, evicts: false }, [idle]).tone, "lane");

  // Holding the resource ourselves never blocks us: that is what concurrency
  // is for, and a backend running its second job is not waiting on its first.
  assert.deepEqual(blockers({ name: "video", resources: ["gpu0"] }, [gpu0]), []);
  assert.equal(blockers({ name: "swap", resources: ["gpu0"] }, [gpu0]).length, 1);
  assert.deepEqual(blockers({ name: "loner" }, [gpu0]), [],
    "a backend that declares nothing competes for nothing");
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
  parseConfig({
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
  assert.match(html, /<title>Hearth Console<\/title>/);
  assert.match(html, /fetch\("\/ui\/data"/, "the page must fetch its own endpoint");
  assert.ok(!html.includes("MOCK_NETWORK"), "the draft's mock data must not ship");

  // These used to name the DOM helpers that drew each thing. The bundle is
  // minified, so every identifier in it is now a mangled two letters — but
  // string literals survive verbatim, and the operator-facing copy is a better
  // thing to pin anyway: it is what actually went missing the time this
  // mattered, and a rename that keeps the words keeps the feature.
  //
  // /network has always computed `unmapped`, and a redesign once dropped it
  // from the page — silently removing the only thing that tells you a peer
  // started offering something you cannot ask for. The data being on the wire
  // is tested in server.test.ts; this checks the page still does something
  // with it, because that is the half that went missing.
  //
  // The words moved when the console became a graph: the count is on the peer
  // node ("N unclaimed") and the sentence is in the inspector beside the link
  // controls. Pinning the sentence rather than the count keeps this checking
  // that the page EXPLAINS the state, which is the part that went missing.
  assert.match(html, /you have not mapped, so nothing can route to them/,
    "the page must still render unmapped peer models, and say what it means in words");
  assert.match(html, /peers may use this model/, "the sharing toggle must survive");
  assert.match(html, /not in the config file/,
    "and the record of what is not in the file");
  assert.ok(!html.includes("secret-key"), "no credential may appear in the page");
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
    parseConfig({
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
  assert.equal(typeof backends[0]!.answering, "boolean",
    "and whether we have heard from it lately, so silence is not drawn as idle");

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
      parseConfig({
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

    for (const path of ["/ui", "/ui/data"]) {
      const bare = await fetch(`${remote}${path}`);
      assert.equal(bare.status, 403, `${path} must refuse an off-box caller`);

      // The point of the whole test: a VALID api key still does not open it.
      // Every other route on this server would accept this request.
      const keyed = await fetch(`${remote}${path}`, {
        headers: { Authorization: "Bearer secret-key" },
      });
      assert.equal(keyed.status, 403,
        `${path} must stay loopback-only even for a valid api key`);
      assert.match(await keyed.text(), /loopback-only/);
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

// --- the second listener ---------------------------------------------------
//
// uiListen exists so a headless box can see the page without a tunnel, which
// means it gets bound somewhere reachable. The whole safety of that rests on
// this socket serving the page AND NOTHING ELSE: no /v1, no passthrough to the
// backend, no peer protocol, no /healthz. If this test ever goes green on a
// path other than the page, a widened uiListen has widened the whole node.
{
  const withUi = createNode(
    parseConfig({
      name: "ui-port",
      backend: { url: backendUrl, llamaSwapExtras: false },
      // 0.0.0.0 on purpose: this is the risky configuration, so test that one.
      // The port here only has to be valid; the listen below takes an ephemeral
      // one so the test cannot collide with anything.
      uiListen: { host: "0.0.0.0", port: 4142 },
    }),
    silentLogger,
  );
  withUi.start();
  assert.ok(withUi.uiServer, "uiListen must produce a second server");
  const uiPort = await new Promise<number>((ready) =>
    withUi.uiServer!.listen(0, "0.0.0.0", () =>
      ready((withUi.uiServer!.address() as AddressInfo).port)),
  );
  const ui = `http://127.0.0.1:${uiPort}`;

  // The page and its data are served, with no credential and no loopback check.
  const page = await fetch(`${ui}/ui`);
  assert.equal(page.status, 200, "the page is the point of this port");
  assert.match(await page.text(), /<title>Hearth Console<\/title>/);
  assert.equal((await fetch(`${ui}/`)).status, 200, "bare root serves the page too");
  const data = await fetch(`${ui}/ui/data`);
  assert.equal(data.status, 200);
  const payload = (await data.json()) as {
    net: unknown;
    canWarm?: boolean;
    controls?: { lending: boolean; borrowing: boolean };
  };
  assert.ok(payload.net, "and it carries real data");

  // The standalone listener is READ-ONLY but must still be able to SHOW
  // federation state. This is the operator's only dashboard in a headless
  // deployment, and the page renders these as disabled indicators there.
  //
  // Reported 2026-08-16: the page used to render nothing at all for a direction
  // that was ON, so the healthy case looked identical to the feature not having
  // shipped. Absence of a control is indistinguishable from absence of the
  // feature, which sent an operator hunting for a failed deploy.
  assert.equal(payload.canWarm, false, "this socket cannot perform actions, and says so");
  assert.equal(typeof payload.controls?.lending, "boolean", "but it still reports lending state");
  assert.equal(typeof payload.controls?.borrowing, "boolean", "and borrowing state");

  // Everything else is a 404 — including, especially, the paths that would
  // otherwise reach the GPU or the backend.
  for (const path of [
    "/v1/models",
    "/v1/chat/completions",
    "/queue",
    "/network",
    "/healthz",
    "/peer/state",
    "/running",            // passthrough to the backend
    "/upstream/m1/x",      // passthrough to the backend
    "/ui/../v1/models",    // not a way around it either
  ]) {
    const r = await fetch(`${ui}${path}`);
    assert.equal(r.status, 404, `${path} must not be reachable on the ui port`);
  }

  // Writes are OFF by default, so the control routes are not on this socket.
  for (const p of ["/control", "/v1/warm"]) {
    const r = await fetch(`${ui}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lending: false, model: "m1" }),
    });
    assert.equal(r.status, 404, `${p} must not be writable unless uiListen.control says so`);
  }

  // A POST to the chat path must not reach the backend either.
  const post = await fetch(`${ui}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m1", messages: [] }),
  });
  assert.equal(post.status, 404, "no method gets you off this port");

  await withUi.close();
}

// --- uiListen validation ---------------------------------------------------
{
  // Same socket as the main listener would fail inside listen() with an errno
  // nobody reads. It fails here instead.
  assert.throws(
    () =>
      parseConfig({
        backend: { url: "http://127.0.0.1:9292" },
        listen: { host: "127.0.0.1", port: 4141 },
        uiListen: { host: "127.0.0.1", port: 4141 },
      }),
    /same address as listen/,
  );
  // Unset means no second server at all, which is the default and the safe one.
  const plain = parseConfig({ backend: { url: "http://127.0.0.1:9292" } });
  assert.equal(plain.uiListen, null, "no second listener unless asked for");
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
    parseConfig({
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
    parseConfig({
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

await node.close();
backend.closeAllConnections();
backend.close();
console.log("ui.test.ts ok");

// --- uiListen.control: key -------------------------------------------------
// Opt-in clickable controls on the standalone status listener.
//
// The claim being tested is narrow and worth stating exactly: this adds a
// SOCKET, not an AUTHORITY. localCaller already accepts a valid apiKey from any
// address, so a keyed write to /control was always possible on the main
// listener; `control: key` serves that same gated route on the status port too.
// What must NOT change is what an UNAUTHENTICATED caller can do there, and what
// a PEER can do there — which is, in both cases, look at the page.
{
  const cfg = parseConfig({
    name: "ui-writable",
    backend: { url: backendUrl, llamaSwapExtras: false },
    apiKeys: ["s3cret-key"],
    peerTokens: { friend: "peer-token" },
    share: ["m1"],
    uiListen: { host: "127.0.0.1", port: 4143, control: "key" },
  });
  const node = createNode(cfg, silentLogger);
  node.start();
  const port = await new Promise<number>((ready) =>
    node.uiServer!.listen(0, "127.0.0.1", () =>
      ready((node.uiServer!.address() as AddressInfo).port)),
  );
  const ui = `http://127.0.0.1:${port}`;

  // The page still loads with no credential — reading was never gated here.
  assert.equal((await fetch(`${ui}/ui`)).status, 200, "the page is still open");
  const boot = (await (await fetch(`${ui}/ui/data`)).json()) as { canWarm: boolean; control: string };
  assert.equal(boot.canWarm, true, "the page is told it may write");
  assert.equal(boot.control, "key", "and told that writes need a key");

  const post = (path: string, body: unknown, auth?: string) =>
    fetch(`${ui}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    });

  // THE property. Opening the write route must not open it to everyone.
  assert.equal(
    (await post("/control", { lending: false })).status,
    401,
    "an unauthenticated write on the status port is refused",
  );

  // A PEER token is not an api key. A borrowed connection must never be able to
  // reach in and toggle federation, whatever socket it arrives on.
  assert.equal(
    (await post("/control", { lending: false }, "Bearer peer-token")).status,
    401,
    "a peer token grants nothing here",
  );

  // The real key works, and actually changes the state.
  const ok = await post("/control", { lending: false }, "Bearer s3cret-key");
  assert.equal(ok.status, 200, "a valid apiKey may write from the status port");
  const after = (await (await fetch(`${ui}/ui/data`)).json()) as {
    controls: { lending: boolean };
  };
  assert.equal(after.controls.lending, false, "and the change took effect");
  await post("/control", { lending: true }, "Bearer s3cret-key");

  // Only the two write routes, and only POST. Everything else stays 404, so
  // enabling controls does not quietly widen the port into a general API.
  for (const [path, method] of [
    ["/control", "GET"],
    ["/v1/models", "GET"],
    ["/v1/chat/completions", "POST"],
    ["/queue", "GET"],
    ["/network", "GET"],
    ["/peer/state", "GET"],
    ["/healthz", "GET"],
  ] as const) {
    const r = await fetch(`${ui}${path}`, {
      method,
      ...(method === "POST"
        ? { headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret-key" }, body: "{}" }
        : { headers: { Authorization: "Bearer s3cret-key" } }),
    });
    assert.equal(r.status, 404, `${method} ${path} must stay off the status port even with control:key`);
  }

  await node.close();
}

// --- the config combination that cannot work is refused --------------------
// control:key with no apiKeys would render clickable controls, prompt for a key
// and then 401 every write, because localCaller falls back to loopback-only
// with no keys configured. Caught at --check, where a person is reading.
{
  assert.throws(
    () =>
      parseConfig({
        name: "no-keys",
        backend: { url: "http://127.0.0.1:1" },
        uiListen: { host: "0.0.0.0", port: 4142, control: "key" },
      }),
    /requires apiKeys/,
    "control:key without apiKeys is a config error, not a runtime surprise",
  );

  assert.throws(
    () =>
      parseConfig({
        name: "bad-mode",
        backend: { url: "http://127.0.0.1:1" },
        apiKeys: ["k"],
        uiListen: { host: "0.0.0.0", port: 4142, control: "trusted" },
      }),
    /must be false or/,
    "there is deliberately no `trusted` mode; an unknown value is refused",
  );
}
