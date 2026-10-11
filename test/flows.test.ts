/**
 * `flows:`: how requests are routed.
 *
 * A flow takes the ids clients ask for and sends each request to the first step that holds: a
 * model here, a peer, another flow, the fastest of several, or a refusal. What is asserted
 * here is that a file which could loop, dead-end or never answer does not load, that every
 * kind of target and condition decides as written, and that the choice reaches the backend
 * with the step's lane and params.
 *
 *     npx tsx test/flows.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig, rawFlow, type HearthConfig } from "../src/config.js";
import { silentLogger, type Logger } from "../src/log.js";
import { flowsOf, resolve, routedFlow, typeOf, variantsOf, type World } from "../src/route.js";
import { createNode } from "../src/server.js";

const base = (flows: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  backends: { main: { url: "http://127.0.0.1:1", kind: "none", serves: ["small", "big", "eyes"] } },
  scheduler: { lanes: { chat: { priority: 0 }, batch: { priority: 100 } } },
  peers: { friend: { url: "http://10.0.0.2:4141", token: "t", models: { big: "their-big", auto: "their-auto" } } },
  flows,
  ...more,
});
const pick = {
  inputs: ["auto", "small"],
  steps: [
    { when: { images: true }, to: "eyes" },
    { when: { tokensOver: 1000 }, to: "big", lane: "batch", params: { temperature: 0 } },
    { when: { asked: "small", queuedUnder: 2 }, to: "small" },
    { to: { flow: "heavy" } },
  ],
};
const heavy = { inputs: ["big"], steps: [{ when: { caller: "app" }, to: { peer: "friend", model: "big" } }, { to: "big" }] };

// --- config ----------------------------------------------------------------------------------
{
  const cfg = parseConfig(base({ pick, heavy }));
  assert.deepEqual(cfg.flows["pick"]!.steps[1], { when: { tokensOver: 1000 }, to: { model: "big" }, lane: "batch", params: { temperature: 0 }, do: [] });
  assert.deepEqual(cfg.flows["pick"]!.steps[2]!.when, { asked: ["small"], queuedUnder: 2 }, "one name may be written bare");
  assert.deepEqual(cfg.flows["heavy"]!.steps[0]!.to, { peer: "friend", model: "big" });
  assert.deepEqual(parseConfig({ backends: { main: { url: "http://127.0.0.1:1" } } }).flows, {}, "a file with none routes nothing");

  const refuse = (flows: Record<string, unknown>, re: RegExp) => assert.throws(() => parseConfig(base(flows)), re);
  const one = (steps: unknown[], inputs = ["auto"]) => ({ a: { inputs, steps } });
  refuse(one([]), /steps must be a list of steps/);
  refuse(one([{ when: { images: true }, to: "eyes" }]), /must end with a step that always applies/);
  refuse(one([{ to: { peer: "friend" } }]), /must end with a step that always applies/);
  refuse(one([{ to: "small" }, { to: "big" }]), /steps\[0\] has no `when`, so the steps after it can never be reached/);
  refuse(one([{ when: { image: true }, to: "eyes" }, { to: "big" }]), /when\.image is not a setting .* did you mean images/);
  refuse(one([{ to: "big", lane: "nope" }]), /names lane "nope"/);
  refuse(one([{ to: "big", params: { model: "x" } }]), /params\.model cannot be stamped/);
  refuse(one([{ to: { flow: "nowhere" } }]), /names flow "nowhere", which is not under flows/);
  refuse(one([{ to: { peer: "stranger" } }, { to: "big" }]), /names peer "stranger", which is not a peer you borrow from/);
  refuse(one([{ to: { peer: "friend" } }, { to: "big" }], ["eyes"]), /sends "eyes" to friend, which does not map it/);
  refuse(one([{ to: { peer: "friend", flow: "a" } }]), /must say one thing/);
  refuse(one([{ to: { fastest: ["big"] } }]), /fastest must list at least two/);
  refuse(one([{ when: { warm: true }, to: { flow: "a" } }, { to: "big" }]), /tests warm, free, queuedUnder, ready or idle/);
  refuse({ a: { inputs: ["auto"], steps: [{ to: "big" }] }, b: { inputs: ["auto"], steps: [{ to: "big" }] } }, /names "auto", which already enters flows\.a/);
  refuse({ a: { inputs: [], steps: [{ to: { flow: "b" } }] }, b: { inputs: [], steps: [{ to: { flow: "a" } }] } }, /leads back to itself: a → b → a/);
  // A peer may be passed over when it is down, so a step that only names one needs no condition.
  assert.doesNotThrow(() => parseConfig(base(one([{ to: { peer: "friend" } }, { to: { refuse: "only on a peer" } }]))));
  // Routing a model once carried itself is refused, with the command that rewrites it.
  assert.throws(() => parseConfig(base({}, { models: { big: { policy: "peer" } } })), /models\.big\.policy is routing, which now lives under flows: — run `hearth migrate`/);
}

// --- the walk: conditions, targets, and what is passed over -----------------------------------------
{
  const cfg = parseConfig(base({
    pick, heavy,
    race: { inputs: ["eyes"], steps: [{ when: { held: ["eyes"] }, to: { refuse: "the card is in use" } }, { to: { fastest: ["eyes", { peer: "friend", model: "big" }] } }] },
    away: { inputs: [], steps: [{ when: { down: ["friend"] }, to: "small" }, { to: { peer: "friend", model: "big" } }, { to: "small" }] },
  }));
  const world = (over: Partial<World> & { up?: boolean; queued?: number; peerQueued?: number; tokens?: number; images?: boolean } = {}): World => ({
    cfg,
    peers: {
      candidates: (_m, named) => (over.up === false ? [] : named),
      theirModelId: (_p, m) => (m === "big" ? "their-big" : "their-auto"),
      statsFor: () => null,
      loadFor: () => ({ slots: 1, free: 1, queued: over.peerQueued ?? 0, warm: true }),
    },
    need: { tokens: over.tokens ?? 10, images: over.images ?? false, tools: false },
    caller: "key:app", lane: "chat",
    local: () => ({ queued: over.queued ?? 0, free: 1, slots: 1, loaded: ["small", "big", "eyes"] }),
    held: () => false,
    ...over,
  });
  const at = (asked: string, w: World) => { const r = resolve(asked, w); return [r.target, r.target === "peer" ? r.peer : r.model, r.lane, r.via.join(">")]; };

  assert.deepEqual(at("auto", world({ images: true, tokens: 5000 })), ["local", "eyes", "chat", "pick"], "the earlier step wins");
  assert.deepEqual(at("auto", world({ tokens: 5000 })), ["local", "big", "batch", "pick"], "a step's lane rides along");
  assert.deepEqual(resolve("auto", world({ tokens: 5000 })).params, { temperature: 0 });
  assert.deepEqual(at("small", world()), ["local", "small", "chat", "pick"], "which id was asked for can decide");
  assert.deepEqual(at("small", world({ queued: 2 })), ["peer", "friend", "chat", "pick>heavy"], "a busy target hands the request on, here into another flow");
  assert.deepEqual(at("auto", world({ caller: "local" })), ["local", "big", "chat", "pick>heavy"], "a step for another caller is passed over");
  assert.deepEqual(at("auto", world({ up: false })), ["local", "big", "chat", "pick>heavy"], "and so is a peer that is down");
  assert.equal(resolve("small", world({ queued: 2 })).target === "peer" && resolve("small", world({ queued: 2 })).model, "big", "the peer runs the id the step names");
  assert.deepEqual(at("big", world({ noPeers: true })), ["local", "big", "chat", "heavy"], "after a peer has failed, the flow answers without them");
  // Only what a flow takes is offered: any other name is turned away, unless a flow for every other name says what becomes of it.
  const stray = resolve("unrouted", world());
  assert.deepEqual([stray.target, stray.unlisted, stray.reason], ["unavailable", true, '"unrouted" is not offered here (auto, small, big, eyes)']);
  const open = (steps: unknown[]) => ({ ...world(), cfg: parseConfig(base({ pick, heavy, rest: { inputs: ["*"], steps } })) });
  const asItself = resolve("unrouted", open([{ to: { asked: true } }]));
  assert.deepEqual([asItself.target, asItself.model, asItself.via, asItself.unlisted], ["local", "unrouted", ["rest"], undefined], "one that runs them as themselves");
  assert.deepEqual([resolve("unrouted", open([{ to: { refuse: "ask for auto" } }])).reason, resolve("unrouted", open([{ to: { refuse: "ask for auto" } }])).unlisted], ["ask for auto", undefined], "or one that says why not");
  const picky = open([{ when: { caller: "app" }, to: { asked: true } }, { to: "small" }]);
  assert.deepEqual([resolve("unrouted", { ...picky, caller: "key:app" }).model, resolve("unrouted", { ...picky, caller: "local" }).model], ["unrouted", "small"], "with conditions like any other flow");
  assert.equal(resolve("small", open([{ to: { refuse: "no" } }])).via[0], "pick", "a name a flow takes never reaches it");
  assert.throws(() => parseConfig(base({ rest: { inputs: ["*", "small"], steps: [{ to: "big" }] } })), /lists "\*" beside other names/);
  assert.throws(() => parseConfig(base({ rest: { inputs: ["*"], steps: [{ to: { peer: "friend" } }, { to: { asked: true } }] } })), /sends every other name to friend: say which model/);
  assert.throws(() => parseConfig(base({ rest: { inputs: ["*"], steps: [{ to: { asked: false } }] } })), /asked must be true/);

  // fastest: whichever would start soonest, a tie staying with the one listed first.
  assert.deepEqual(at("eyes", world()), ["local", "eyes", "chat", "race"]);
  assert.deepEqual(at("eyes", world({ queued: 3 })), ["peer", "friend", "chat", "race"]);
  assert.deepEqual(at("eyes", world({ queued: 3, peerQueued: 3 })), ["local", "eyes", "chat", "race"]);
  assert.deepEqual(at("eyes", world({ queued: 3, up: false })), ["local", "eyes", "chat", "race"], "with the peer down there is only here");
  const refused = resolve("eyes", world({ held: () => true }));
  assert.deepEqual([refused.target, refused.reason], ["unavailable", "the card is in use"]);

  // The step that decided in each flow, for a page that lights the path.
  assert.deepEqual(resolve("small", world({ queued: 2 })).path, [{ flow: "pick", step: 3 }, { flow: "heavy", step: 0 }]);
  assert.deepEqual(refused.path, [{ flow: "race", step: 0 }]);

  // idle: a model nothing has used for a while, named or the step's own target.
  const quiet = parseConfig(base({
    a: { inputs: ["x"], steps: [{ when: { idle: { model: "big", ms: 600000 } }, to: "big" }, { to: "small" }] },
    b: { inputs: ["y"], steps: [{ when: { idle: { ms: 1000 } }, to: "eyes" }, { to: "small" }] },
  }));
  const since = (ms: Record<string, number>) => (asked: string) => resolve(asked, { ...world(), cfg: quiet, idleMs: (m) => ms[m] ?? 0 }).model;
  assert.equal(since({ big: 700000 })("x"), "big", "idle long enough: it goes there");
  assert.equal(since({ big: 5000 })("x"), "small", "used recently: it goes elsewhere");
  assert.equal(since({ eyes: 2000 })("y"), "eyes", "without a model, the step's own target is the one read");
  assert.equal(since({})("y"), "small");
  assert.throws(() => parseConfig(base({ a: { inputs: ["x"], steps: [{ when: { idle: { model: "big" } }, to: "big" }, { to: "small" }] } })), /idle\.ms is required/);
  assert.throws(() => parseConfig(base({ a: { inputs: ["x"], steps: [{ when: { idle: { ms: 5 } }, to: { refuse: "no" } }, { to: "small" }] } })), /give idle a model/);

  // down: a step for when nobody else can take it.
  const away = (w: World) => resolve("x", { ...w, cfg: { ...cfg, flows: { ...cfg.flows, away: { ...cfg.flows["away"]!, inputs: ["x"] } } } });
  assert.equal(away(world()).target, "peer");
  assert.deepEqual([away(world({ up: false })).target, away(world({ up: false })).model], ["local", "small"]);
}

// --- the common shapes a borrowed model starts from ---------------------------------------------------
{
  const to = (f: ReturnType<typeof routedFlow>) => f!.steps.map((s) => [s.when, s.to]);
  assert.deepEqual(to(routedFlow("big", { policy: "peer", peers: ["friend"] })), [[null, { peer: "friend", model: null }], [null, { model: "big" }]]);
  assert.deepEqual(to(routedFlow("big", { policy: "fastest", peers: ["friend"] })), [[null, { fastest: [{ model: "big" }, { peer: "friend", model: null }] }]]);
  const refuse = { refuse: "no peer could take it, and it does not run here" };
  assert.deepEqual(to(routedFlow("big", { policy: "spillover", peers: ["friend"], spilloverAt: 3, fallbackLocal: false })),
    [[{ down: ["friend"] }, refuse], [{ queuedUnder: 3 }, { model: "big" }], [null, { peer: "friend", model: null }], [null, refuse]]);
  assert.equal(routedFlow("big", { policy: "local", peers: ["friend"] }), null, "an id that only runs here has no flow");
  assert.equal(routedFlow("big", { policy: "peer", peers: [] }), null, "and neither has one no peer can take");
  // Each is a flow the file takes, written the short way.
  const cfg = parseConfig(base({ big: rawFlow(routedFlow("big", { policy: "spillover", peers: ["friend"], spilloverAt: 3, fallbackLocal: false })!) }));
  assert.deepEqual(rawFlow(cfg.flows["big"]!), { inputs: ["big"], steps: [{ when: { down: ["friend"] }, to: refuse }, { when: { queuedUnder: 3 }, to: "big" }, { to: { peer: "friend" } }, { to: refuse }] });
  assert.deepEqual(flowsOf(cfg), cfg.flows);
}

// --- end to end: the chosen id, lane and params reach the backend ---------------------------------
{
  const seen: Record<string, unknown>[] = [];
  const backend = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") seen.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const cfg = parseConfig({
    ...base({ pick, heavy: { inputs: [], steps: [{ to: "big" }] } }),
    backends: { main: { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, kind: "none", serves: ["small", "big", "eyes"] } },
    peers: {},
  });
  const node = createNode(cfg, silentLogger);
  const at = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));
  const ask = (content: unknown, model = "auto") => fetch(`${at}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
  });

  assert.equal((await ask("hi")).status, 200);
  assert.equal(seen.at(-1)!.model, "big", "a name no backend serves runs as what its flow picks, here through a second flow");
  await ask("x".repeat(8000));
  assert.deepEqual([seen.at(-1)!.model, seen.at(-1)!.temperature], ["big", 0], "the step's params ride along");
  await ask([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
  assert.equal(seen.at(-1)!.model, "eyes");
  await ask("hi", "small");
  assert.equal(seen.at(-1)!.model, "small", "a real id that enters a flow may still run as itself");
  const stray = await ask("hi", "eyes");
  assert.equal(stray.status, 404, "a model no flow takes is not offered, though a backend serves it");
  assert.match(((await stray.json()) as { error: { message: string } }).error.message, /"eyes" is not offered here \(auto, small\)/);
  assert.equal(seen.at(-1)!.model, "small", "and nothing was sent for it");
  const offered = (await (await fetch(`${at}/v1/models`)).json()) as { data: { id: string }[] };
  assert.deepEqual(offered.data.map((m) => m.id).sort(), ["auto", "small"], "the list of models is what can be asked for");

  // Asking where a request would go sends nothing, and may try a `flows:` that is not saved.
  const before = seen.length;
  const tryIt = async (body: Record<string, unknown>) => {
    const r = await fetch(`${at}/flows/try`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return [r.status, await r.json()] as [number, Record<string, unknown>];
  };
  const [, went] = await tryIt({ model: "auto", images: true });
  assert.deepEqual([went.target, went.model, went.backend, went.path], ["local", "eyes", "main", [{ flow: "pick", step: 0 }]]);
  const [, draft] = await tryIt({ model: "auto", flows: { mine: { inputs: ["auto"], steps: [{ when: { idle: { model: "small", ms: 0 } }, to: "small" }, { to: "big" }] } } });
  assert.deepEqual([draft.model, draft.path], ["small", [{ flow: "mine", step: 0 }]], "a model nothing has run since startup is idle");
  assert.equal((await tryIt({ model: "auto", flows: { mine: { inputs: ["auto"], steps: [] } } }))[0], 400, "a draft that would not load says so");
  const [, big] = await tryIt({ model: "small", tokens: 9000, flows: {} });
  assert.equal(big.unfit, undefined, "a model that has said nothing about its size is not said to refuse");
  assert.equal(seen.length, before, "nothing was sent to the backend");

  const listed = (await (await fetch(`${at}/v1/models`)).json()) as { data: { id: string }[] };
  assert.ok(listed.data.some((m) => m.id === "auto"), "an input is advertised even when no backend serves it");

  await node.close();
  backend.closeAllConnections();
  backend.close();
}

// --- idle, end to end: borrowing a model nobody is using, without that counting as use -----------------------
{
  const seen: string[] = [];
  const backend = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") seen.push((JSON.parse(Buffer.concat(chunks).toString()) as { model: string }).model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const cfg = parseConfig({
    backends: { main: { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, kind: "none", serves: ["small", "big"] } },
    models: { alias: { as: "big" } },
    flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] }, borrow: { inputs: ["small"], steps: [{ when: { idle: { model: "big", ms: 150 } }, to: "big" }, { to: "small" }] } },
  });
  const node = createNode(cfg, silentLogger);
  const at = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));
  const ask = async (model: string) => {
    await fetch(`${at}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });
    return seen.at(-1);
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  assert.equal(await ask("small"), "small", "just started, the big model has not been idle long enough yet");
  await wait(220);
  assert.equal(await ask("small"), "big", "idle long enough: the request borrows it");
  assert.equal(await ask("small"), "big", "and borrowing is not use: the next one borrows it too");
  await ask("alias");
  assert.equal(await ask("small"), "small", "someone asked for the big model, under another of its names: it is in use");
  await wait(220);
  assert.equal(await ask("small"), "big", "left alone again, it is borrowed again");

  await node.close();
  backend.closeAllConnections();
  backend.close();
}

// --- actions ---------------------------------------------------------------------------------
// A step names actions under `do:`. They are set off when the step decides, told what the flow
// knew, and never by a request that is only being tried.
{
  const actions = { note: { log: "{asked} ran as {model} for {caller}" }, tell: { call: "http://127.0.0.1:1/hook", headers: { "x-key": "k" }, body: { text: "{asked} -> {model}" } } };
  const flows = { a: { inputs: ["small"], steps: [{ when: { images: true }, to: "eyes", do: "note" }, { to: "big", do: ["note", "tell"] }] } };
  const cfg = parseConfig(base(flows, { actions }));
  assert.deepEqual(cfg.flows["a"]!.steps.map((s) => s.do), [["note"], ["note", "tell"]], "one name may be written bare");
  assert.deepEqual(cfg.actions["tell"], { kind: "call", url: "http://127.0.0.1:1/hook", method: "POST", headers: { "x-key": "k" }, body: { text: "{asked} -> {model}" }, on: "decided", every: 0, slowerThan: 0 });
  const refuse = (more: Record<string, unknown>, re: RegExp, f: Record<string, unknown> = {}) => assert.throws(() => parseConfig(base(f, more)), re);
  refuse({}, /do names action "note", which is not under actions/, flows);
  refuse({ actions: { x: { log: "a", call: "http://127.0.0.1:1" } } }, /actions\.x must be one kind of action: log or call/);
  refuse({ actions: { x: {} } }, /must be one kind of action/);
  refuse({ actions: { x: { call: "ftp://somewhere" } } }, /actions\.x\.call must be an http or https URL/);
  refuse({ actions: { x: { log: "a", method: "POST" } } }, /actions\.x\.method is not a setting/);
  refuse({ actions: { x: { call: "env:HEARTH_TEST_UNSET_URL" } } }, /environment variable HEARTH_TEST_UNSET_URL is not set/);
  refuse({ actions: { x: { log: "a", on: "later" } } }, /actions\.x\.on must be one of decided, finished, failed/);
  refuse({ actions: { x: { log: "a", every: -1 } } }, /actions\.x\.every must be a number of ms/);

  const world: World = { cfg, peers: { candidates: () => [], statsFor: () => null, theirModelId: () => undefined, loadFor: () => undefined } as unknown as World["peers"], caller: "local", lane: "chat", local: () => ({ queued: 0, free: 1, slots: 1, loaded: [] }), held: () => false };
  assert.deepEqual(resolve("small", world).actions, [{ name: "note", flow: "a", step: 1 }, { name: "tell", flow: "a", step: 1 }]);
  assert.deepEqual(resolve("small", { ...world, need: { tokens: 1, images: true, tools: false } }).actions, [{ name: "note", flow: "a", step: 0 }]);
  assert.deepEqual(resolve("big", world).actions, [], "a request no flow takes sets nothing off");
}
{
  const posted: { headers: Record<string, unknown>; body: unknown }[] = [];
  const backend = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/hook") posted.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const cfg = parseConfig({
    backends: { main: { url, kind: "none", serves: ["small", "big"] } },
    actions: { note: { log: "{asked} ran as {model}, line {line} of {flow}" }, tell: { call: `${url}/hook`, headers: { "x-key": "k" } }, dead: { call: "http://127.0.0.1:1/nothing" } },
    flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] }, a: { inputs: ["small"], steps: [{ to: "big", do: ["note", "tell", "dead"] }] } },
  });
  const lines: { msg: string; fields: Record<string, unknown> }[] = [];
  const keep = (msg: string, fields: Record<string, unknown> = {}) => { lines.push({ msg, fields }); };
  const log: Logger = { debug: () => {}, info: keep, warn: keep, error: keep };
  const node = createNode(cfg, log);
  const at = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));
  const post = (path: string, body: unknown) => fetch(`${at}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };

  const tried = await (await post("/flows/try", { model: "small" })).json() as { actions: string[] };
  assert.deepEqual(tried.actions, ["note", "tell", "dead"], "a tried request says what it would set off");
  const unsaved = await (await post("/flows/try", { model: "small", actions: { fresh: { log: "x" } }, flows: { a: { inputs: ["small"], steps: [{ to: "big", do: "fresh" }] } } })).json() as { actions: string[] };
  assert.deepEqual(unsaved.actions, ["fresh"], "and takes actions that are not saved yet");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(posted.length + lines.filter((l) => l.msg.startsWith("flow.action")).length, 0, "but sets nothing off");

  assert.equal((await post("/v1/chat/completions", { model: "small", messages: [{ role: "user", content: "hi" }] })).status, 200, "a URL that cannot be reached does not fail the request");
  await until(() => posted.length > 0 && lines.some((l) => l.msg === "flow.action_failed"));
  assert.equal(lines.find((l) => l.msg === "flow.action")?.fields["text"], "small ran as big, line 1 of a");
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.headers["x-key"], "k");
  assert.deepEqual(posted[0]!.body, { action: "tell", node: "hearth", asked: "small", model: "big", target: "local", peer: "", lane: "chat", caller: "local", tokens: (posted[0]!.body as { tokens: number }).tokens, images: false, tools: false, flow: "a", line: 1, reason: "a step 1", outcome: "decided", ms: 0, error: "", backend: "main", id: "", queuedMs: 0, ranMs: 0 });
  assert.equal(lines.find((l) => l.msg === "flow.action_failed")?.fields["action"], "dead", "one that fails is a line in the log");

  await node.close();
  backend.closeAllConnections();
  backend.close();
}

// --- a flow that is off, one that keeps a conversation, and a backend that fails ------------------
{
  const cfg = parseConfig(base({
    quiet: { off: true, note: "parked", inputs: ["eyes"], steps: [{ to: "big" }] },
    keep: { sticky: 60000, inputs: ["small"], steps: [{ when: { images: true }, to: "eyes" }, { to: { fastest: ["small", "big"] } }] },
  }));
  assert.deepEqual([cfg.flows["quiet"]!.off, cfg.flows["quiet"]!.note, cfg.flows["keep"]!.sticky], [true, "parked", 60000]);
  assert.throws(() => parseConfig(base({ a: { sticky: 5, inputs: ["small"], steps: [{ to: "big" }] } })), /sticky must be >= 1000|sticky/);
  const world: World = { cfg, peers: { candidates: () => [], statsFor: () => null, theirModelId: () => undefined, loadFor: () => undefined } as unknown as World["peers"], caller: "local", lane: "chat", local: () => ({ queued: 0, free: 1, slots: 1, loaded: [] }), held: () => false };
  assert.deepEqual([resolve("eyes", world).model, resolve("eyes", world).via], ["eyes", []], "a flow that is off takes nothing");

  // A later turn goes where the conversation started, whatever the steps say now, while that place can take it.
  assert.equal(resolve("small", world).model, "small");
  const held = resolve("small", { ...world, pinned: () => ({ model: "big" }) });
  assert.deepEqual([held.model, held.path, held.reason], ["big", [{ flow: "keep", step: 1 }], "keep kept the conversation where it started"]);
  assert.equal(resolve("small", { ...world, pinned: () => ({ model: "eyes" }), need: { tokens: 1, images: false, tools: false } }).model, "eyes", "even a place its own line would not pick this time");
  assert.equal(resolve("small", { ...world, pinned: () => ({ model: "gone" }) }).model, "small", "somewhere no line names any more is forgotten");
  assert.equal(resolve("small", { ...world, pinned: () => ({ model: "big" }), skip: new Set(["big"]) }).model, "small", "and so is one that has just failed");

  // A model that has just failed is passed over like a peer that is down.
  const failing = resolve("small", { ...world, skip: new Set(["small"]) });
  assert.equal(failing.model, "big");
  assert.equal(resolve("small", { ...world, skip: new Set(["small", "big"]) }).target, "unavailable");
  assert.equal(resolve("big", { ...world, skip: new Set(["big"]) }).target, "unavailable", "a name no flow takes has nowhere else to go");
}
{
  const seen: string[] = [];
  const posted: Record<string, unknown>[] = [];
  let broken = true;
  const backend = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      if (req.url === "/hook") posted.push(body);
      if (req.url === "/v1/chat/completions") seen.push(body["model"] as string);
      const fail = req.url === "/v1/chat/completions" && body["model"] === "small" && broken;
      res.writeHead(fail ? 502 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(fail ? { error: "down" } : { data: [] }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const cfg = parseConfig({
    backends: { main: { url, kind: "none", serves: ["small", "big", "lone"] } },
    actions: {
      after: { call: `${url}/hook`, on: "finished" },
      onFail: { call: `${url}/hook`, on: "failed" },
      rare: { call: `${url}/hook`, every: 60000 },
    },
    flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] },
      a: { inputs: ["small"], steps: [{ when: { tokensUnder: 1000000 }, to: "small" }, { to: "big", do: ["after", "onFail", "rare"] }] },
      b: { inputs: ["lone"], steps: [{ to: "small", do: ["onFail"] }] },
      keep: { sticky: 60000, inputs: ["big"], steps: [{ when: { idle: { model: "lone", ms: 150 } }, to: "lone" }, { to: "big" }] },
    },
  });
  const node = createNode(cfg, silentLogger);
  const at = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));
  const post = (path: string, body: unknown) => fetch(`${at}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const ask = async (model: string, messages: unknown[] = [{ role: "user", content: "hi" }]) => { const r = await post("/v1/chat/completions", { model, messages }); await r.text(); return r.status; };
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };
  const names = () => posted.map((p) => `${String(p["action"])}:${String(p["outcome"])}`).sort();

  // The first line's backend answers 502: nothing of that reaches the client, and the next line runs it.
  assert.equal(await ask("small"), 200);
  assert.deepEqual(seen, ["small", "big"]);
  await until(() => posted.length >= 2);
  assert.deepEqual(names(), ["after:ok", "rare:decided"], "an action waits for the end when it says so, and one for failures stays quiet");
  assert.equal(typeof posted.find((p) => p["action"] === "after")!["ms"], "number");
  // With nowhere else to send it, the backend's own answer is relayed as before.
  assert.equal(await ask("lone"), 502);
  await until(() => posted.length >= 3);
  assert.deepEqual(names(), ["after:ok", "onFail:failed", "rare:decided"]);
  assert.equal(posted.find((p) => p["action"] === "onFail")!["error"], "backend answered 502");
  await ask("small");
  await until(() => posted.length >= 4);
  assert.deepEqual(names(), ["after:ok", "after:ok", "onFail:failed", "rare:decided"], "and `every` holds one back that ran a moment ago");

  // How often each line decided, for the page.
  const page = await (await fetch(`${at}/ui/data`)).json() as { flowHits: Record<string, number[]> };
  assert.deepEqual(page.flowHits["a"], [2, 2], "the line that failed and the one that took over both decided");
  assert.deepEqual(page.flowHits["b"], [1]);

  // What cannot be arranged on demand can be pretended when a request is only tried.
  const tryIt = async (pretend: unknown) => (await (await post("/flows/try", { model: "big", pretend })).json() as { model: string }).model;
  assert.deepEqual([await tryIt({ idle: ["lone"] }), await tryIt({ used: ["lone"] })], ["lone", "big"]);
  // A draft that takes over a name the saved file still routes by its own settings speaks for that name.
  const adopted = await post("/flows/try", { model: "big", flows: { big: { inputs: ["big"], steps: [{ to: "small" }] } } });
  assert.equal(adopted.status, 200);
  const after = await (await fetch(`${at}/ui/data`)).json() as { flowHits: Record<string, number[]> };
  assert.equal(after.flowHits["keep"], undefined, "a tried request is not counted");

  // A conversation stays with the model it started on; a new one is decided afresh.
  broken = false;
  seen.length = 0;
  const opening = [{ role: "user", content: "a long story" }];
  await ask("big", opening);
  await new Promise((r) => setTimeout(r, 220));
  await ask("big", [...opening, { role: "assistant", content: "…" }, { role: "user", content: "go on" }]);
  await ask("big", [{ role: "user", content: "something else" }]);
  assert.deepEqual(seen, ["big", "big", "lone"], "the second turn stayed put though the idle model had become free");

  await node.close();
  backend.closeAllConnections();
  backend.close();
}

// --- more a line can test, and a limit on how much it takes ------------------------------------------
{
  const steps = (when: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ a: { inputs: ["small"], steps: [{ when, to: "big", ...more }, { to: "small" }] } });
  const world = (cfg: HearthConfig, more: Partial<World> = {}): World => ({ cfg, peers: { candidates: () => [], statsFor: () => null, theirModelId: () => undefined, loadFor: () => undefined } as unknown as World["peers"], caller: "key:app", lane: "chat", local: () => ({ queued: 0, free: 1, slots: 1, loaded: [] }), held: () => false, ...more });
  const goes = (when: Record<string, unknown>, more: Partial<World> = {}) => resolve("small", world(parseConfig(base(steps(when))), more)).model;

  assert.deepEqual([goes({ callerNot: ["app"] }), goes({ callerNot: ["other"] })], ["small", "big"], "not this caller");
  assert.deepEqual([goes({ laneNot: "chat" }), goes({ laneNot: "batch" })], ["small", "big"]);
  assert.deepEqual([goes({ askedNot: ["small"] }), goes({ askedNot: ["auto"] })], ["small", "big"]);

  const at = (h: number, m = 0) => ({ now: () => new Date(2020, 0, 1, h, m) });
  assert.deepEqual([goes({ time: { from: "09:00", to: "17:00" } }, at(9)), goes({ time: { from: "09:00", to: "17:00" } }, at(17)), goes({ time: { from: "09:00", to: "17:00" } }, at(8, 59))], ["big", "small", "small"], "from counts, to does not");
  assert.deepEqual([goes({ time: { from: "22:00", to: "06:00" } }, at(23)), goes({ time: { from: "22:00", to: "06:00" } }, at(5, 59)), goes({ time: { from: "22:00", to: "06:00" } }, at(12))], ["big", "big", "small"], "a from later than to runs through midnight");
  assert.throws(() => parseConfig(base(steps({ time: { from: "9am", to: "17:00" } }))), /when\.time\.from must be a time of day as HH:MM/);

  // Ready: no swap needed. Without the node's word on its hardware, only a loaded model is.
  assert.deepEqual([goes({ ready: true }, { ready: () => true }), goes({ ready: true }, { ready: () => false }), goes({ ready: true })], ["big", "small", "small"]);
  assert.equal(goes({ ready: true }, { local: () => ({ queued: 0, free: 1, slots: 1, loaded: ["big"] }) }), "big");
  assert.throws(() => parseConfig(base({ a: { inputs: ["small"], steps: [{ when: { ready: true }, to: { flow: "b" } }, { to: "small" }] }, b: { inputs: [], steps: [{ to: "big" }] } })), /tests warm, free, queuedUnder, ready or idle/);

  // A limit: the line takes that many at once, and the rest go on down the list.
  const capped = parseConfig(base(steps({ images: false }, { max: 2 })));
  assert.equal(capped.flows["a"]!.steps[0]!.max, 2);
  assert.deepEqual([resolve("small", world(capped, { inFlight: () => 1 })).model, resolve("small", world(capped, { inFlight: () => 2 })).model], ["big", "small"]);
  assert.doesNotThrow(() => parseConfig(base({ a: { inputs: ["small"], steps: [{ to: "big", max: 1 }, { to: "small" }] } })), "a limit alone is reason enough for a line to be passed over");
  assert.throws(() => parseConfig(base({ a: { inputs: ["small"], steps: [{ to: "big", max: 1 }] } })), /max cannot be set on the last step/);
  assert.throws(() => parseConfig(base({}, { actions: { x: { log: "a", slowerThan: 5, on: "decided" } } })), /slowerThan cannot go with `on: decided`/);
  assert.equal(parseConfig(base({}, { actions: { x: { log: "a", slowerThan: 5 } } })).actions["x"]!.on, "finished", "asking how long it took is a reason to wait for the end");
}
{
  // Held open until told, so two requests are in flight together.
  let release: (() => void)[] = [];
  const seen: string[] = [];
  const posted: Record<string, unknown>[] = [];
  const backend = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      const answer = () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [] })); };
      if (req.url === "/hook") { posted.push(body); return answer(); }
      if (req.url !== "/v1/chat/completions") return answer();
      seen.push(body["model"] as string);
      if (body["model"] === "big") release.push(answer); else answer();
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const cfg = parseConfig({
    backends: { main: { url, kind: "none", serves: ["small", "big"], concurrency: 4 } },
    actions: { slow: { call: `${url}/hook`, on: "finished", slowerThan: 100 } },
    flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] }, a: { inputs: ["small"], steps: [{ to: "big", max: 1, do: "slow" }, { to: "small", do: "slow" }] } },
  });
  const node = createNode(cfg, silentLogger);
  const at = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));
  const ask = () => fetch(`${at}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "small", messages: [{ role: "user", content: "hi" }] }) });
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };

  const first = ask();
  await until(() => release.length === 1);
  const second = await ask();
  await second.text();
  assert.deepEqual(seen, ["big", "small"], "the line is at its limit, so the second request goes on down the list");
  assert.equal(second.headers.get("x-hearth-model"), "small", "and the answer says which model ran it");
  await new Promise((r) => setTimeout(r, 150));
  release.forEach((go) => go());
  release = [];
  const one = await first;
  await one.text();
  assert.equal(one.headers.get("x-hearth-model"), "big");
  // A node may keep what ran to itself; the setting applies without a restart.
  (cfg as { modelHeader: boolean }).modelHeader = false;
  const asking = ask();
  await until(() => release.length === 1);
  release.forEach((go) => go());
  release = [];
  const quiet = await asking;
  await quiet.text();
  assert.equal(quiet.headers.get("x-hearth-model"), null);
  (cfg as { modelHeader: boolean }).modelHeader = true;
  assert.equal(parseConfig({ backends: { main: { url } } }).modelHeader, true, "on unless the file says otherwise");
  await until(() => posted.length > 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(posted.length, 1, "only the request that took long sets off an action for slow ones");
  const told = posted[0]!;
  assert.deepEqual([told["model"], told["backend"], told["outcome"]], ["big", "main", "ok"]);
  assert.ok((told["ranMs"] as number) >= 100 && (told["ms"] as number) >= (told["ranMs"] as number), "with how long it ran, out of how long it took");
  // Its response closed, so the line has room again.
  const third = ask();
  await until(() => release.length === 1);
  assert.equal(seen.at(-1), "big");
  release.forEach((go) => go());
  await (await third).text();

  await node.close();
  backend.closeAllConnections();
  backend.close();
}

// --- a type comes in variants ------------------------------------------------------------------------
// `Name:variant` asks for the type in that variant, and a step can test which. The name stays one
// field, so chat, a path and a body all carry it the same way.
{
  const flows = {
    LLM: { inputs: ["LLM"], steps: [{ when: { variant: ["fast", "tiny"] }, to: "small" }, { when: { variant: "sharp" }, to: { flow: "more" } }, { to: "big" }] },
    more: { inputs: [], steps: [{ when: { variant: "deep" }, to: "eyes" }, { to: "eyes" }] },
    "odd:name": { inputs: ["odd:name"], steps: [{ to: "small" }] },
    rest: { inputs: ["*"], steps: [{ to: { asked: true } }] },
  };
  const cfg = parseConfig(base(flows));
  const world: World = { cfg, peers: { candidates: () => [], statsFor: () => null, theirModelId: () => undefined, loadFor: () => undefined } as unknown as World["peers"], caller: "local", lane: "chat", local: () => ({ queued: 0, free: 1, slots: 1, loaded: [] }), held: () => false };
  const to = (name: string) => { const r = resolve(name, world); return r.unlisted ? `no: ${r.reason}` : r.model; };
  assert.deepEqual([to("LLM"), to("LLM:fast"), to("LLM:tiny"), to("LLM:sharp")], ["big", "small", "small", "eyes"]);
  assert.deepEqual(variantsOf(cfg.flows, "LLM"), ["fast", "tiny", "sharp", "deep"], "a rule handed on to adds the variants it tests");
  assert.equal(to("LLM:deep"), "big", "a variant only a later rule tests is still a variant, decided by the lines it reaches");
  assert.equal(to("LLM:nope"), 'no: "LLM:nope" is not offered here: LLM comes as LLM:fast, LLM:tiny, LLM:sharp, LLM:deep');
  assert.equal(to("odd:name"), "small", "a name a flow takes as written is itself, colon and all");
  assert.equal(to("qwen:latest"), "qwen:latest", "and one no flow knows goes to the flow for every other name whole");
  assert.deepEqual(typeOf(cfg.flows, "LLM:fast"), { type: "LLM", variant: "fast" });
  assert.throws(() => parseConfig(base({ a: { inputs: ["a"], steps: [{ when: { variant: "x:y" }, to: "small" }, { to: "big" }] } })), /a variant is a plain word/);
}

// --- work that is not chat is asked for by name too ------------------------------------------------
// A backend's own paths (image generation and the like) queue under hearth. The name such a request
// carries, in the path or in the body, is looked up like a chat model's: a flow may take it and say
// which model runs it, and a name no flow takes is not offered.
{
  const got: { url: string; model?: unknown }[] = [];
  const backend = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let model: unknown;
      try { model = (JSON.parse(Buffer.concat(chunks).toString()) as { model?: unknown }).model; } catch { /* no body */ }
      if (req.method === "POST") got.push({ url: req.url ?? "", ...(model !== undefined ? { model } : {}) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const shape = (flows: Record<string, unknown>) => ({
    backends: {
      draw: { url, kind: "none", serves: ["img-a", "img-b"], routes: [{ path: "/upstream/{model}/generate", lane: "chat" }] },
      film: { url, kind: "none", routes: [{ path: "/generate", model: "vid", lane: "chat" }] },
      embed: { url, kind: "none", serves: ["emb"], routes: [{ path: "/v1/embeddings", model: "emb", lane: "chat" }] },
    },
    scheduler: { lanes: { chat: { priority: 0 } } },
    actions: { note: { log: "{asked} drew as {model}" } },
    flows,
  });
  const types = {
    ImageGen: { takes: "/upstream/{model}/generate", inputs: ["ImageGen"], steps: [{ when: { caller: "app" }, to: "img-b" }, { when: { variant: "b" }, to: "img-b" }, { to: "img-a", do: "note" }] },
    VideoGen: { takes: ["/generate"], inputs: ["VideoGen"], steps: [{ to: "vid" }] },
    Embeddings: { inputs: ["Embeddings"], steps: [{ to: "emb" }] },
  };
  const cfg = parseConfig(shape(types));
  assert.deepEqual(cfg.flows["ImageGen"]!.takes, ["/upstream/{model}/generate"], "one path may be written bare");
  assert.throws(() => parseConfig(shape({ x: { takes: ["/nowhere"], inputs: ["x"], steps: [{ to: "vid" }] } })), /takes names "\/nowhere", which no backend declares under routes/);
  assert.throws(() => parseConfig(shape({ x: { takes: ["/generate"], inputs: ["x"], steps: [{ when: { images: true }, to: "vid" }, { to: "vid" }] } })), /steps\[0\]\.when\.images reads a chat request/);

  const lines: Record<string, unknown>[] = [];
  const keep = (msg: string, fields: Record<string, unknown> = {}) => { if (msg === "flow.action") lines.push(fields); };
  const node = createNode(cfg, { debug: () => {}, info: keep, warn: keep, error: keep });
  const at = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));
  const post = async (path: string, body: unknown = {}) => { const r = await fetch(`${at}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const text = await r.text(); return { status: r.status, text }; };

  // A name in the path: the backend is asked for the model the flow picked, and the line's action runs.
  assert.equal((await post("/upstream/ImageGen/generate", { prompt: "a fox" })).status, 200);
  assert.equal(got.at(-1)!.url, "/upstream/img-a/generate");
  assert.equal(lines.at(-1)?.["text"], "ImageGen drew as img-a");
  // A variant rides in the same place the name does.
  assert.equal((await post("/upstream/ImageGen:b/generate", { prompt: "a fox" })).status, 200);
  assert.equal(got.at(-1)!.url, "/upstream/img-b/generate");
  assert.equal((await post("/upstream/ImageGen:c/generate", {})).status, 404);
  const names = (await (await fetch(`${at}/v1/models`)).json()) as { data: { id: string }[] };
  assert.deepEqual(names.data.map((m) => m.id).sort(), ["Embeddings", "ImageGen", "ImageGen:b", "VideoGen"], "and is listed beside its type");
  // A type is offered on the paths it takes and nowhere else: not as chat, and not on a path another type takes.
  const asChat = await post("/v1/chat/completions", { model: "ImageGen", messages: [{ role: "user", content: "hi" }] });
  assert.equal(asChat.status, 404);
  assert.match(asChat.text, /ImageGen.+is not offered as chat: it takes \/upstream\/\{model\}\/generate/);
  assert.equal((await post("/v1/embeddings", { model: "VideoGen", input: "x" })).status, 404);
  // A model named outright is not offered, though a backend serves it and declares the path.
  const direct = await post("/upstream/img-b/generate", { prompt: "a fox" });
  assert.equal(direct.status, 404);
  assert.match(direct.text, /img-b.+is not offered here \(ImageGen, VideoGen, Embeddings\)/);
  // A path with no name in it is asked for by the flow that takes it.
  assert.equal((await post("/generate", { prompt: "a river" })).status, 200);
  assert.equal(got.at(-1)!.url, "/generate");
  // And the model a route names is found on that route's backend, for what a flow reads about it and for a tried request.
  assert.equal(JSON.parse((await post("/flows/try", { model: "VideoGen" })).text).backend, "film");
  // A name in the body goes out as the model the flow picked.
  assert.equal((await post("/v1/embeddings", { model: "Embeddings", input: "x" })).status, 200);
  assert.deepEqual(got.at(-1), { url: "/v1/embeddings", model: "emb" });
  assert.equal((await post("/v1/embeddings", { model: "emb", input: "x" })).status, 404);
  const counted = (await (await fetch(`${at}/ui/data`)).json()) as { flowHits: Record<string, number[]> };
  assert.deepEqual(counted.flowHits["ImageGen"], [0, 1, 1], "and each is counted on the line that decided");
  await node.close();

  // With a flow for every other name that runs them as themselves, each path answers as it did before any of this.
  const open = createNode(parseConfig(shape({ rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } })), silentLogger);
  const at2 = await new Promise<string>((ready) =>
    open.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(open.server.address() as AddressInfo).port}`)));
  for (const [path, body] of [["/upstream/img-b/generate", {}], ["/generate", {}], ["/v1/embeddings", { model: "emb" }]] as const) {
    const r = await fetch(`${at2}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await r.text();
    assert.equal(r.status, 200, `${path} answers as itself`);
  }
  assert.equal(got.at(-1)!.url, "/v1/embeddings");
  // A flow with nothing to take a path leaves it unoffered.
  const shut = createNode(parseConfig(shape({ Embeddings: types.Embeddings })), silentLogger);
  const at3 = await new Promise<string>((ready) =>
    shut.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(shut.server.address() as AddressInfo).port}`)));
  const none = await fetch(`${at3}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await none.text();
  assert.equal(none.status, 404, "a path no flow takes is not offered");
  await open.close();
  await shut.close();
  backend.closeAllConnections();
  backend.close();
}

console.log("flows.test.ts ok");
