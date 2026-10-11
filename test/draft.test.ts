/**
 * The routing map's draft: what a drawn line changes in hearth.yaml.
 *
 * Every result is fed back through parseConfig, because an edit made by drawing has to be one
 * the file would accept. What a line means is asked of the node kinds at each end of it, as
 * the canvas asks: an outlet to send, and somewhere for it to land.
 *
 *     npx tsx test/draft.test.ts
 */
import assert from "node:assert/strict";

import { parseConfig } from "../src/config.js";
import { applyOps, directTo, draftView, factsOf, nodeOf, opsOf, placed, pointStep, problems, rawTo, rebase, refusal, routeId, toOf, toText, unchecked, linesRunning, removed, renamed, spread, beside, added, retyped, ordered, movedName, tidied, arranged, TEMPLATES, restOf, withDo, withRest, type Doc, type Landing, type To } from "../src/console/draft.js";
import type { UiData } from "../src/console/types.js";

const doc = (): Doc => ({
  servers: { box: { host: "10.0.0.5" } },
  resources: { gpu0: { kind: "gpu" }, gpu1: { kind: "gpu" } },
  backends: {
    near: { url: "http://127.0.0.1:8080", kind: "none", serves: ["chat"], resources: ["gpu0"] },
    far: { server: "box", port: 7860, kind: "none", serves: ["image"], resources: ["gpu1"] },
    path: { url: "https://127.0.0.1/llm", kind: "none", serves: ["other"] },
  },
  peers: { friend: { url: "http://10.0.0.2:4141", token: "t", models: { chat: "theirs", auto: "theirs" } } },
  flows: {
    pick: { inputs: ["auto"], steps: [{ when: { images: true }, to: "image" }, { to: "chat" }] },
    heavy: { inputs: ["image"], steps: [{ to: "image" }] },
  },
});
const steps = (d: Doc | null, flow = "pick") => ((d!.flows as Record<string, Doc>)[flow]!.steps as Doc[]);
/** What a line let go on `node` means, and the outlet `handle` of `node` in a draft. */
const lands = (node: string): Landing | undefined => nodeOf(node).kind.lands?.(nodeOf(node).id);
const outlet = (d: Doc, node: string, handle: string | null) => nodeOf(node).kind.outlet?.(d, nodeOf(node).id, handle) ?? null;

// --- a target reads the same from the file and from the node, and writes back as short as it can ----
{
  for (const raw of ["chat", { peer: "friend" }, { peer: "friend", model: "chat" }, { flow: "heavy" }, { fastest: ["chat", { peer: "friend" }] }, { refuse: "no" }]) {
    assert.deepEqual(rawTo(toOf(raw)), raw);
  }
  assert.deepEqual(toOf({ model: "chat" }), { kind: "model", model: "chat" }, "the node's own shape for a model");
  assert.deepEqual(toOf({ peer: "friend", model: null }), { kind: "peer", peer: "friend", model: null });
  assert.equal(toText(toOf({ fastest: ["chat", { peer: "friend" }] })), "fastest of 2");
  assert.equal(toText(toOf({ peer: "friend" })), "friend (peer)");
}

// --- a line is drawn from an outlet of one node onto another: each kind says what that means ------------
{
  assert.deepEqual(lands("model:chat"), { kind: "model", model: "chat" });
  assert.deepEqual(lands("peer:friend"), { kind: "peer", peer: "friend", model: null });
  assert.deepEqual(lands("flow:heavy"), { kind: "flow", flow: "heavy" });
  assert.deepEqual(lands("action:note"), { kind: "action", action: "note" });
  assert.equal(lands("self"), undefined, "this node is not somewhere a request goes");
  assert.equal(lands("refuse:pick:0"), undefined);

  // A rule's line: sent somewhere else, it keeps its conditions.
  const line = outlet(doc(), "flow:pick", "step-0")!;
  assert.deepEqual([line.when, line.rule], [{ images: true }, "pick"]);
  const repointed = line.send(lands("peer:friend") as To);
  assert.deepEqual(steps(repointed)[0], { when: { images: true }, to: { peer: "friend" } });
  assert.doesNotThrow(() => parseConfig(repointed));
  assert.deepEqual(steps(outlet(doc(), "flow:pick", "step-1")!.send(lands("flow:heavy") as To))[1], { to: { flow: "heavy" } });
  assert.equal(line.send({ kind: "model", model: "image" }), null, "already pointing there");
  assert.equal(line.send({ kind: "flow", flow: "pick" }), null, "a rule does not feed itself");
  assert.equal(outlet(doc(), "flow:pick", "step-5"), null);
  assert.equal(outlet(doc(), "model:chat", null), null, "a model has no outlet");

  // A name's own outlet says where requests for it go.
  const name = outlet(doc(), "self", "ask-chat")!;
  assert.equal(name.name, "chat");
  assert.deepEqual((name.send({ kind: "peer", peer: "friend", model: null })!.flows as Record<string, unknown>)["chat"], { inputs: ["chat"], steps: [{ to: { peer: "friend" } }] });
  assert.equal(name.also, undefined, "only a rule's line runs an action");

  // One place of a fastest-of, or one more of them; nothing but a model or a peer will do.
  const racing = pointStep(doc(), "pick", 1, { kind: "fastest", of: [{ kind: "model", model: "chat" }, { kind: "model", model: "other" }] })!;
  const place = outlet(racing, "fastest:pick:1", "end-1")!;
  assert.equal(place.endsOnly, true);
  assert.deepEqual(steps(place.send({ kind: "peer", peer: "friend", model: null }))[1]!.to, { fastest: ["chat", { peer: "friend" }] });
  assert.deepEqual(steps(outlet(racing, "fastest:pick:1", "new")!.send({ kind: "model", model: "image" }))[1]!.to, { fastest: ["chat", "other", "image"] });
  assert.equal(place.send({ kind: "flow", flow: "heavy" }), null);

  // A click on a node opens the rule or the action it belongs to.
  const opens = (node: string) => nodeOf(node).kind.opens?.(nodeOf(node).id);
  assert.deepEqual([opens("flow:pick"), opens("fastest:a:b:2"), opens("refuse:pick:0"), opens("action:note"), opens("model:chat")],
    [{ kind: "flow", id: "pick" }, { kind: "flow", id: "a:b" }, { kind: "flow", id: "pick" }, { kind: "action", id: "note" }, undefined]);
}

// --- an action, run from a line ------------------------------------------------------------------------
{
  const acting: Doc = { ...doc(), actions: { note: { log: "{asked} ran as {model}" }, tell: { call: "http://127.0.0.1:9/hook" } } };
  const ran = outlet(acting, "flow:pick", "step-0")!.also!("note")!;
  assert.deepEqual(steps(ran)[0], { when: { images: true }, to: "image", do: ["note"] });
  assert.doesNotThrow(() => parseConfig(ran));
  assert.equal(outlet(ran, "flow:pick", "step-0")!.also!("note"), null, "already running it");
  assert.deepEqual(steps(withDo(ran, "pick", 0, "tell", true))[0]!.do, ["note", "tell"]);
  assert.deepEqual(steps(withDo(ran, "pick", 0, "note", false))[0], { when: { images: true }, to: "image" }, "the last one taken off leaves no empty list behind");

  // A one-line flow that runs something is a rule to be seen, not a bare line from the name.
  assert.equal(directTo("heavy", { inputs: ["image"], steps: [{ to: "image" }] }), null);
  assert.deepEqual(directTo("image", { inputs: ["image"], steps: [{ to: "chat" }] }), { kind: "model", model: "chat" });
  assert.equal(directTo("image", { inputs: ["image"], steps: [{ to: "chat", do: ["note"] }] }), null);

  const live = { net: { nodes: [{ name: "me", self: true, up: true, free: 1, slots: 1, queued: 0 }] }, routing: {} } as unknown as UiData;
  assert.deepEqual(draftView(acting, live).actions, { note: { kind: "log", says: "{asked} ran as {model}" }, tell: { kind: "call", says: "http://127.0.0.1:9/hook" } });

  // Taking an action away takes it off every line that ran it, so what is left still loads.
  const without = removed(withDo(ran, "pick", 1, "note", true)!, "actions", "note");
  assert.deepEqual([Object.keys(without.actions as object), steps(without).map((s) => s.do)], [["tell"], [undefined, undefined]]);
  assert.doesNotThrow(() => parseConfig(without));
  assert.deepEqual(Object.keys(removed(ran, "flows", "heavy").flows as object), ["pick"]);
  // Every rule to start from is one the file takes once its lines say where they go.
  for (const t of TEMPLATES) {
    const filled = { ...doc(), flows: { [t.name]: { inputs: ["auto"], steps: t.steps.map((s, i) => ({ ...s, to: i === 0 ? "image" : "chat", ...(s.when && "caller" in (s.when as object) ? { when: { caller: ["app"] } } : {}) })) } } };
    assert.doesNotThrow(() => parseConfig(filled), `the "${t.label}" rule loads`);
  }

  // Renaming follows the name everywhere it is used; a name that is taken is refused.
  assert.deepEqual(linesRunning(ran, "note"), [["pick", 0]]);
  const called = renamed(placed(ran, "routing/action:note", { x: 1, y: 2 }), "actions", "note", "jot")!;
  assert.deepEqual([Object.keys(called.actions as object), steps(called)[0]!.do, called.layout], [["jot", "tell"], ["jot"], { "routing/action:jot": { x: 1, y: 2 } }]);
  assert.doesNotThrow(() => parseConfig(called));
  const handed = pointStep(doc(), "pick", 1, { kind: "flow", flow: "heavy" })!;
  const moved = renamed(handed, "flows", "heavy", "big-ones")!;
  assert.deepEqual([Object.keys(moved.flows as object), steps(moved)[1]!.to], [["pick", "big-ones"], { flow: "big-ones" }]);
  assert.doesNotThrow(() => parseConfig(moved));
  assert.equal(renamed(acting, "actions", "note", "tell"), null);

  // Text an action would write out as typed, and what is only known at the end, are said before saving.
  const texts = (a: Doc) => problems({ ...withRest(doc(), "asked"), actions: { x: a } }).join("\n");
  assert.match(texts({ log: "{model} took {duration}" }), /uses \{duration\}, which is not something it is told/);
  assert.match(texts({ log: "{model} took {ms}" }), /only known with "on" set to finished or failed/);
  assert.equal(texts({ log: "{model} took {ms}", on: "finished" }), "");
  assert.match(texts({ log: "x", slowerThan: 20000, on: "decided" }), /"slowerThan", which is only known once a request has ended/);
  assert.equal(texts({ log: "{model} took {ms}", slowerThan: 20000 }), "", "asking how long it took is a reason to wait for the end");
  assert.match(texts({ log: "x", call: "http://127.0.0.1:9/a" }), /is two kinds at once/);

  const said = problems({ ...ran, actions: { empty: { log: "" }, odd: {} } }).join("\n");
  assert.match(said, /Rule "pick", line 1: it runs the action "note", which is gone/);
  assert.match(said, /The action "empty" needs something to do/);
  assert.match(said, /The action "odd" needs something to do/);
}

// --- a name on the node, dragged to where requests for it go ---------------------------------------------
{
  const flowsOf = (d: Doc) => d.flows as Record<string, { inputs: string[]; steps: Doc[] }>;
  // Onto another model or a peer: a flow of its own, which the canvas draws as a line and not a rule.
  const redirected = routeId(doc(), "chat", { kind: "peer", peer: "friend", model: null });
  assert.deepEqual(flowsOf(redirected)["chat"], { inputs: ["chat"], steps: [{ to: { peer: "friend" } }] });
  assert.deepEqual(directTo("chat", flowsOf(redirected)["chat"]!), { kind: "peer", peer: "friend", model: null });
  assert.equal(directTo("pick", flowsOf(doc())["pick"]!), null, "a flow with conditions is a rule");
  assert.doesNotThrow(() => parseConfig({ ...redirected, flows: { ...flowsOf(redirected), chat: { inputs: ["chat"], steps: [{ to: { peer: "friend" } }, { to: "chat" }] } } }));

  // Onto a rule: it enters that rule and leaves the one it was in.
  const entered = routeId(doc(), "auto", { kind: "flow", flow: "heavy" });
  assert.deepEqual([flowsOf(entered)["pick"]!.inputs, flowsOf(entered)["heavy"]!.inputs], [[], ["image", "auto"]]);
  assert.doesNotThrow(() => parseConfig(entered));

  // Back onto its own model, where other names run as themselves: it does too, which takes no flow at all.
  const home = routeId(withRest(redirected, "asked"), "chat", { kind: "model", model: "chat" });
  assert.equal(flowsOf(home)["chat"], undefined);
  assert.deepEqual(flowsOf(routeId(doc(), "image", { kind: "model", model: "image" }))["heavy"]!.inputs, [], "and out of any rule that took it");

  // Somewhere that is not one model becomes a rule of its own, beside any flow already using the name.
  const refused = routeId(doc(), "pick", { kind: "refuse", why: "no" });
  assert.deepEqual(flowsOf(refused)["pick-2"], { inputs: ["pick"], steps: [{ to: { refuse: "no" } }] });
}

// --- what becomes of a name no rule takes, and offering a model under its own name ----------------------------
{
  assert.deepEqual(restOf(doc()), { mode: "none", name: null });
  assert.match(problems(doc()).join("\n"), /Say what happens to a name no type takes/);
  const open = withRest(doc(), "asked");
  assert.deepEqual([restOf(open), (open.flows as Record<string, unknown>)["anything-else"]], [{ mode: "asked", name: "anything-else" }, { inputs: ["*"], steps: [{ to: { asked: true } }] }]);
  assert.doesNotThrow(() => parseConfig(open));
  const shut = withRest(open, "refuse");
  assert.deepEqual([restOf(shut).mode, Object.keys(shut.flows as object).filter((n) => n.startsWith("anything")).length], ["refuse", 1], "changing it replaces the one flow");
  assert.equal(restOf({ ...doc(), flows: { r: { inputs: ["*"], steps: [{ when: { caller: ["app"] }, to: { asked: true } }, { to: { refuse: "no" } }] } } }).mode, "rule");
  assert.deepEqual(rawTo(toOf({ asked: true })), { asked: true });

  // Where other names run as themselves, a name sent to its own model needs no flow; where they are refused, it needs one to be offered at all.
  const flowsOf = (d: Doc) => d.flows as Record<string, unknown>;
  assert.equal(flowsOf(routeId(open, "other", { kind: "model", model: "other" }))["other"], undefined);
  const offered = routeId(shut, "other", { kind: "model", model: "other" });
  assert.deepEqual(flowsOf(offered)["other"], { inputs: ["other"], steps: [{ to: "other" }] });
  assert.deepEqual(directTo("other", flowsOf(offered)["other"] as { inputs: string[]; steps: Doc[] }), { kind: "model", model: "other" }, "drawn as a line from the name, not as a rule");
  assert.doesNotThrow(() => parseConfig(offered));
}

// --- a draft made on one file, carried over to the file as someone else has since saved it ------------------
{
  const mine = routeId(doc(), "chat", { kind: "peer", peer: "friend", model: null });
  const theirs = placed(doc(), "self", { x: 1, y: 2 });
  const moved = rebase(doc(), mine, theirs);
  assert.ok("doc" in moved, "edits to different things both stand");
  assert.deepEqual([(moved as { doc: Doc }).doc.layout, ((moved as { doc: Doc }).doc.flows as Record<string, unknown>)["chat"]], [{ self: { x: 1, y: 2 } }, { inputs: ["chat"], steps: [{ to: { peer: "friend" } }] }]);
  assert.deepEqual(applyOps(doc(), opsOf(doc(), mine)), mine, "ops applied to the file they were made on give the draft back");
  // Both changed the same rule: neither is thrown away without a person saying which.
  const clash = rebase(doc(), pointStep(doc(), "pick", 1, { kind: "model", model: "other" })!, pointStep(doc(), "pick", 1, { kind: "model", model: "image" })!);
  assert.deepEqual(clash, { clash: "flows.pick" });
  // A draft read back after its own save: the file already says what it wanted, so nothing clashes.
  const saved = rebase(doc(), mine, mine);
  assert.deepEqual(saved, { doc: mine });
  const { servers: _gone, ...dropped } = doc();
  assert.deepEqual(rebase(doc(), dropped, dropped), { doc: dropped }, "a removal that already happened included");
}

// --- what a person can fix is said before the file refuses it -----------------------------------------------------
{
  assert.deepEqual(problems(withRest(doc(), "asked")), [], "a file that is in order has nothing to say");
  const broken = { ...doc(), servers: { box: { host: "10.0.0.5" }, spare: {} }, flows: { lonely: { inputs: [], steps: [{ when: {}, to: "chat" }, { to: "" }] } },
    backends: { ...(doc().backends as object), other: { server: "box", port: 1, resources: ["gpu0"] } } };
  const said = problems(broken).join("\n");
  assert.match(said, /Nothing reaches the rule "lonely"/);
  assert.match(said, /"lonely", line 1: choose a condition/);
  assert.match(said, /"lonely", the Otherwise line: choose where/);
  assert.match(said, /server "spare" needs its address/);
  assert.match(said, /hardware "gpu0" is used on this machine and box/);
}

// --- a line that cannot work is known before it is drawn ---------------------------------------------------------
{
  // A backend with paths of its own answers its models there, not as chat; what a model takes is declared or seen.
  const withFacts: Doc = {
    ...doc(),
    backends: { ...(doc().backends as object), draw: { url: "http://127.0.0.1:9", kind: "none", serves: ["paint"], routes: [{ path: "/generate", model: "paint", lane: "chat" }] } },
    models: { chat: { stats: { vision: false, context: 8000 } } },
  };
  const live = { net: { nodes: [{ name: "me", self: true, up: true, free: 1, slots: 1, queued: 0, stats: { other: { tools: false } } }, { name: "friend", up: true, free: 1, slots: 1, queued: 0, stats: { chat: { vision: true } } }] }, routing: {} } as unknown as UiData;
  const facts = factsOf(withFacts, live);
  assert.deepEqual([facts.kind("paint"), facts.kind("chat"), facts.kind("auto")], ["paths", "chat", "chat"], "a name nothing serves is chat: a rule answers for it");

  const to = (model: string) => ({ kind: "model" as const, model });
  assert.match(refusal(null, to("paint"), facts)!, /paint is not a chat model/, "a chat request cannot run as a model that is not chat");
  assert.match(refusal({ images: true }, to("chat"), facts)!, /chat does not take images/);
  assert.match(refusal({ tokensOver: 9000 }, to("chat"), facts)!, /over 9000 tokens, and chat holds 8000/);
  assert.match(refusal({ tools: true }, to("other"), facts)!, /other does not take tools/, "what the running node has seen counts too");
  assert.equal(refusal({ images: true }, { kind: "peer", peer: "friend", model: "chat" }, facts), null, "a peer's copy is judged by what the peer says");
  assert.equal(refusal({ tokensOver: 4000 }, to("chat"), facts), null);
  assert.match(refusal({ images: true }, { kind: "fastest", of: [to("image"), to("chat")] }, facts)!, /chat does not take images/, "every place a choice could land has to be able to take it");

  // Nothing said is not a refusal: the line stands, marked as not checked.
  assert.equal(refusal({ images: true }, to("image"), facts), null);
  assert.equal(unchecked({ images: true }, to("image"), facts), true);
  assert.equal(unchecked({ images: true }, { kind: "peer", peer: "friend", model: "chat" }, facts), false);
  assert.equal(unchecked({ caller: ["app"] }, to("image"), facts), false, "a line that tests nothing about the model has nothing to check");

  // A condition changed after the line was drawn is caught the same way, as something to fix.
  const stale = { ...withFacts, flows: { r: { inputs: ["auto", "paint"], steps: [{ when: { images: true }, to: "chat" }, { to: "image" }] } } };
  const said = problems(stale, factsOf(stale, live)).join("\n");
  assert.match(said, /Rule "r", line 1: This line is for requests with images, and chat does not take images/);
  // A model only a route names (a path with no name in it) is not chat either.
  const filmed = factsOf({ ...withFacts, backends: { ...(withFacts.backends as object), film: { url: "http://127.0.0.1:8", kind: "none", routes: [{ path: "/generate", model: "film-model", lane: "chat" }] } } }, live);
  assert.equal(filmed.kind("film-model"), "paths");
  // A rule that takes a path may end at any model here, one whose backend declares no path included, but never at a peer.
  assert.equal(refusal(null, to("paint"), facts, true), null);
  assert.equal(refusal(null, to("chat"), facts, true), null);
  assert.match(refusal(null, { kind: "peer", peer: "friend", model: null }, facts, true)!, /a peer is only ever sent chat/);
}

// --- where a node was put is part of the file ----------------------------------------------------------
{
  const moved = placed(placed(doc(), "flow:pick", { x: 610.4, y: -20.6 }), "machine:box", { x: 900, y: 40 });
  assert.deepEqual(moved.layout, { "flow:pick": { x: 610, y: -21 }, "machine:box": { x: 900, y: 40 } });
  assert.deepEqual(parseConfig(moved).layout, moved.layout);
  assert.deepEqual(parseConfig(doc()).layout, {}, "a file that places nothing is laid out as before");
  assert.throws(() => parseConfig({ ...doc(), layout: { self: { x: "left" } } }), /layout\.self\.x must be a number/);
}

// --- copies, and the types on the Router ------------------------------------------------------------
{
  // A copy goes in under a free name and takes no names of its own; a second copy gets the next one.
  const once = added(doc(), "flows", "pick", (doc().flows as Record<string, Doc>).pick!);
  const twice = added(once.doc, "flows", "pick", (doc().flows as Record<string, Doc>).pick!);
  assert.deepEqual([once.name, twice.name], ["pick-copy", "pick-copy-2"]);
  assert.deepEqual([(twice.doc.flows as Record<string, Doc>)["pick-copy"]!.inputs, steps(twice.doc, "pick-copy-2")], [[], steps(doc())]);
  assert.doesNotThrow(() => parseConfig(withRest(twice.doc, "asked")));

  // A type's new name follows into the rule it enters, a line that tests it, and a flow named after it.
  const tested = pointStep({ ...doc(), flows: { ...(doc().flows as Doc), pick: { inputs: ["auto"], steps: [{ when: { asked: ["auto"] }, to: "image" }, { to: "chat" }] } } }, "pick", 1, { kind: "model", model: "other" })!;
  const smart = retyped(tested, "auto", "smart")!;
  assert.deepEqual([(smart.flows as Record<string, Doc>).pick!.inputs, steps(smart)[0]!.when], [["smart"], { asked: ["smart"] }]);
  const photo = retyped(routeId(doc(), "image", { kind: "model", model: "other" }), "image", "photo")!;
  assert.deepEqual([Object.keys(photo.flows as object), (photo.flows as Record<string, Doc>).photo], [["pick", "heavy", "photo"], { inputs: ["photo"], steps: [{ to: "other" }] }]);
  assert.doesNotThrow(() => parseConfig(withRest(photo, "asked")));
  // A name another rule takes, the catch-all, and one with a variant's colon in it are refused.
  assert.deepEqual([retyped(doc(), "auto", "image"), retyped(doc(), "*", "all"), retyped(doc(), "auto", "a:b"), retyped(doc(), "auto", "")], [null, null, null, null]);

  // The order of the types is kept with the layout, follows a rename, and outlasts a tidy-up.
  const down = movedName(doc(), ["auto", "image"], "auto", 1);
  assert.deepEqual(ordered(down.layout as never, ["auto", "image", "new"]), ["image", "auto", "new"]);
  assert.equal(movedName(doc(), ["auto", "image"], "auto", -1).layout, undefined);
  assert.deepEqual(ordered(retyped(down, "auto", "smart")!.layout as never, ["smart", "image"]), ["image", "smart"]);
  const put = placed(down, "routing/flow:pick", { x: 5, y: 5 });
  assert.deepEqual([arranged(down), arranged(put), arranged(tidied(put)), ordered(tidied(put).layout as never, ["auto", "image"])], [false, true, false, ["image", "auto"]]);
  assert.equal(tidied(placed(doc(), "routing/flow:pick", { x: 5, y: 5 })).layout, undefined);
  assert.doesNotThrow(() => parseConfig(withRest(put, "asked")));
}

// --- boxes that fit together ------------------------------------------------------------------------
{
  // A box that would lie on one above it moves down past it, and takes what is drawn beside it along; one clear of it stays.
  const ys = spread([
    { id: "a", x: 0, y: 0, w: 100, h: 50 }, { id: "b", x: 50, y: 30, w: 100, h: 50 }, { id: "b-side", x: 300, y: 40, w: 50, h: 20 },
    { id: "c", x: 500, y: 30, w: 100, h: 50 }, { id: "d", x: 60, y: 90, w: 100, h: 20 },
  ], new Map([["b", ["b-side"]]]), 10);
  assert.deepEqual(Object.fromEntries(ys), { a: 0, b: 60, "b-side": 70, c: 30, d: 120 });
  // Ends sit level with the lines that reach them, in that order, never closer than a step; one no line reaches goes last.
  const from: Record<string, number[]> = { low: [300, 340], high: [20], mid: [40], none: [] };
  assert.deepEqual(Object.fromEntries(beside(["low", "high", "mid", "none"], (id) => from[id]!, 50)), { high: 0, mid: 50, low: 295, none: 345 });
}

// --- what is written is the change and nothing else -------------------------------------------------
{
  assert.deepEqual(opsOf(doc(), pointStep(doc(), "pick", 1, { kind: "model", model: "other" })!), [{ path: ["flows", "pick", "steps", 1, "to"], value: "other" }]);
  const { servers: _, ...without } = doc();
  assert.deepEqual(opsOf(doc(), without), [{ path: ["servers"], delete: true }]);
}

console.log("draft.test.ts ok");
