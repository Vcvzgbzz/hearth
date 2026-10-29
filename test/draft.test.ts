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
import { addPlace, applyOps, dropPlace, orderOf, raisePlace, thenTry, pastedAll, put, wholes, directTo, draftView, factsOf, nodeOf, opsOf, placed, pointStep, problems, rawTo, rebase, refusal, routeId, toOf, toText, unchecked, linesRunning, removed, renamed, scoped, unscoped, followed, summary, routeTyped, withCaller, callersIn, routerFor, usersOf, spread, beside, bayRoom, added, retyped, ordered, movedName, movedBay, movedHardware, BAYS, tidied, arranged, TEMPLATES, restOf, withDo, withRest, placedOn, withPlugin, movePlugin, wireSlot, type Doc, type Landing, type To, callerChoices, paneChoices, copiedRouter, restacked, unstacked, STACK } from "../src/console/draft.js";
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
  // A model one backend declares is placed there, though a backend that declares nothing discovered it too.
  const both = { ...live, net: { nodes: [{ ...live.net.nodes[0], backends: [{ name: "big", serves: ["chat", "side"] }, { name: "small", serves: ["side"] }] }] }, routing: { side: { backend: "small" } } } as unknown as UiData;
  const placedOn = { backends: { big: { url: "http://a" }, small: { url: "http://b", serves: ["side"] } }, models: { side: {}, chat: {} } };
  assert.equal(draftView(placedOn, both).routing?.side?.backend, "small");
  assert.equal(draftView({ ...placedOn, backends: { big: { url: "http://a" }, small: { url: "http://b" } } }, both).routing?.side?.backend, "small");
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

// --- an order: places to try in turn, kept as a rule that tests nothing and drawn as one node ----------------------
{
  // A line that names one place is given somewhere to go when that fails: the place it named, then the new one.
  const made = thenTry(doc(), "pick", 1, { kind: "model", model: "other" })!;
  assert.deepEqual(steps(made)[1]!.to, { flow: "chat-then" });
  assert.deepEqual(steps(made, "chat-then").map((s) => s.to), ["chat", "other"]);
  assert.doesNotThrow(() => parseConfig(made), "a line that only names a model here may stand before the one it falls back to");
  assert.equal(thenTry(doc(), "pick", 1, { kind: "model", model: "chat" }), null, "the same place twice is no order");
  assert.equal(thenTry(doc(), "pick", 1, { kind: "refuse", why: "no" }), null, "only somewhere work can run will do");
  // It answers the paths of the rule that hands to it.
  const typed = thenTry(put(doc(), "flows", "pick", { ...(doc().flows as Record<string, Doc>).pick, takes: ["/v1/embeddings"] }), "pick", 1, { kind: "model", model: "other" })!;
  assert.deepEqual((typed.flows as Record<string, Doc>)["chat-then"]!.takes, ["/v1/embeddings"]);

  // What makes a flow an order: no name enters it and no line of it tests anything.
  const ends = [{ kind: "model", model: "chat" }, { kind: "model", model: "other" }];
  assert.deepEqual(orderOf({ inputs: [], steps: steps(made, "chat-then") }), ends);
  assert.equal(orderOf({ inputs: ["auto"], steps: steps(made, "chat-then") }), null, "a rule a name enters is a rule");
  assert.equal(orderOf({ inputs: [], steps: steps(doc()) }), null, "and so is one whose lines test something");
  assert.equal(orderOf({ inputs: [], steps: [{ to: "chat" }] }), null, "one place is not an order");
  // A line with nothing to test is the point of an order, and still a mistake in a rule.
  assert.ok(!problems(made).some((p) => /never reached/.test(p)));
  assert.ok(problems(put(doc(), "flows", "pick", { inputs: ["auto"], steps: [{ to: "chat" }, { to: "other" }] })).some((p) => /"pick", line 1: choose a condition/.test(p)));

  // Its node: a line let go on it hands to it, each place has an outlet, and any other handle adds a place.
  assert.deepEqual(lands("inorder:chat-then"), { kind: "flow", flow: "chat-then" });
  assert.deepEqual(nodeOf("inorder:chat-then").kind.opens?.("chat-then"), { kind: "flow", id: "chat-then" });
  assert.deepEqual(steps(outlet(made, "inorder:chat-then", "end-1")!.send({ kind: "model", model: "image" })!, "chat-then").map((s) => s.to), ["chat", "image"]);
  const longer = outlet(made, "inorder:chat-then", "new")!.send({ kind: "model", model: "image" })!;
  assert.deepEqual(steps(longer, "chat-then").map((s) => s.to), ["chat", "other", "image"]);
  assert.deepEqual(longer, addPlace(made, "chat-then", { kind: "model", model: "image" }));
  assert.equal(outlet(made, "inorder:chat-then", "new")!.send({ kind: "refuse", why: "no" }), null);
  // A rule's line has an outlet for "then try" beside the one for where it goes.
  assert.deepEqual(outlet(doc(), "flow:pick", "step-1-then")!.send({ kind: "model", model: "other" }), made);

  // A place is tried sooner, or taken out. With one left there is nothing to fall back to: the line names it again.
  assert.deepEqual(steps(raisePlace(made, "chat-then", 1), "chat-then").map((s) => s.to), ["other", "chat"]);
  assert.deepEqual(steps(dropPlace(longer, "chat-then", 0), "chat-then").map((s) => s.to), ["other", "image"]);
  const back = dropPlace(made, "chat-then", 0);
  assert.deepEqual([Object.keys(back.flows as object), steps(back)[1]!.to], [["pick", "heavy"], "other"]);
  // Deleting the order leaves its first place behind, so no line is left handing to nothing.
  const gone = removed(longer, "flows", "chat-then");
  assert.deepEqual([Object.keys(gone.flows as object), steps(gone)[1]!.to], [["pick", "heavy"], "chat"]);
  assert.doesNotThrow(() => parseConfig(gone));
  // Renamed, it keeps the place its node was given.
  const named = renamed(placed(made, "routing/inorder:chat-then", { x: 3, y: 4 }), "flows", "chat-then", "talk")!;
  assert.deepEqual([steps(named)[1]!.to, named.layout], [{ flow: "talk" }, { "routing/inorder:talk": { x: 3, y: 4 } }]);
}

// --- the menu for a right-click among the callers -----------------------------------------------------------------
{
  const d = { ...doc(), apiKeys: [{ key: "k", label: "app" }], routers: { side: { flows: {} } }, callers: { app: "side" } };
  const said = (id: string | null) => callerChoices(d, id).map((c) => (c.head ? (c.label === "" ? "--" : `# ${c.label}`) : `${c.value}${c.on ? " ✓" : ""}`));
  // A key: which router it goes by, with the one in force marked, then what can be done with the key, then a new one.
  assert.deepEqual(said("app"), ["# app goes by", "to:", "to:side ✓", "follow", "new-router", "--", "# its key", "rotate", "revoke", "--", "mint"]);
  // This machine with no key is sent by a router too, and has no key to rotate. It follows everyone else until it is sent somewhere.
  assert.deepEqual(said("local"), ["# local goes by", "to:", "to:side", "follow ✓", "new-router", "--", "mint"]);
  // Everyone else is who the others follow, so it cannot follow.
  assert.deepEqual(said("*"), ["# everyone else goes by", "to: ✓", "to:side", "new-router", "--", "mint"]);
  // The frame the callers stand in: only what adds one. With no draft read, the routers are not offered.
  assert.deepEqual(said(null), ["# callers", "mint"]);
  assert.deepEqual(callerChoices(null, "app").map((c) => c.value).filter(Boolean), ["rotate", "revoke", "mint"]);
  assert.equal(callerChoices(d, "app").find((c) => c.value === "revoke")!.danger, true);
}

// --- the menu for a right-click on the empty part of the topology ------------------------------------------------
{
  // Everything the strip over the picture adds, by the section it joins, then a provider, the versions and the view.
  const menu = paneChoices([{ section: "backends", noun: "backend" }, { section: "resources", noun: "hardware" }, { section: "servers", noun: "machine" }]);
  assert.deepEqual(menu.filter((c) => !c.head).map((c) => [c.label, c.value]), [
    ["New backend…", "add:backends"], ["New hardware…", "add:resources"], ["New machine…", "add:servers"], ["New provider…", "provider"],
    ["Versions…", "versions"], ["Fit everything in view", "fit"],
  ]);
  assert.deepEqual(menu.filter((c) => c.head).map((c) => c.label), ["add", ""], "one heading, and a rule before what is not adding");
}

// --- several nodes picked out on the map, copied and put in again together ----------------------------------------
{
  // Only a node that is a rule or an action in its own right is copied or deleted; the rest are moved and nothing more.
  const many = [{ node: "flow:pick", x: 10, y: 20 }, { node: "refuse:pick:0", x: 0, y: 0 }, { node: "model:chat", x: 5, y: 5 }, { node: "action:note", x: 1, y: 2 }];
  assert.deepEqual(wholes(many).map((w) => [w.kind, w.id, w.node]), [["flow", "pick", "flow:pick"], ["action", "note", "action:note"]]);
  // Each copy goes in under a free name, a little down and right of the node it came from.
  const from = put(doc(), "actions", "note", { log: "hello" });
  const copied = wholes(many).map((w) => ({ ...w, entry: (from[w.kind === "flow" ? "flows" : "actions"] as Record<string, Doc>)[w.id]! }));
  const { doc: out, made } = pastedAll(from, copied);
  assert.deepEqual(made, [{ node: "flow:pick-copy", x: 50, y: 60 }, { node: "action:note-copy", x: 41, y: 42 }]);
  assert.deepEqual(out.layout, { "routing/flow:pick-copy": { x: 50, y: 60 }, "routing/action:note-copy": { x: 41, y: 42 } });
  assert.deepEqual([(out.flows as Record<string, Doc>)["pick-copy"]!.inputs, (out.actions as Record<string, Doc>)["note-copy"]], [[], { log: "hello" }], "a copied rule takes no names");
  assert.doesNotThrow(() => parseConfig(out));
  assert.deepEqual(pastedAll(from, []), { doc: from, made: [] });
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
  // A chat model on that kind of backend (one llama-swap serving image models and an LLM) is still chat when something
  // says so; one a route names keeps its paths whatever it declares.
  const mixed = factsOf({
    ...withFacts,
    backends: { ...(withFacts.backends as object), swap2: { url: "http://127.0.0.1:7", kind: "none", serves: ["pic", "talk", "talk2", "named"], routes: [{ path: "/upstream/{model}/generate", lane: "batch" }, { path: "/sing", model: "named" }] } },
    models: { ...(withFacts.models as object), talk: { stats: { context: 81920 } }, talk2: { emulate: "llama-server" }, named: { stats: { context: 4096 } } },
  }, live);
  assert.deepEqual([mixed.kind("pic"), mixed.kind("talk"), mixed.kind("talk2"), mixed.kind("named")], ["paths", "chat", "chat", "paths"]);
  assert.equal(refusal(null, to("talk"), mixed), null, "a chat line may end on the backend's chat model");
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

  // A box of callers let go among the others takes that place; the order is the layout's, apart from the types', and outlasts a tidy-up.
  const row = ["a", "b", "default"];
  const at = { a: 100, b: 300, default: 500 };
  const last = movedBay(down, row, "a", 520, at);
  assert.deepEqual(ordered(last.layout as never, row, BAYS), ["b", "default", "a"]);
  assert.deepEqual(ordered(movedBay(doc(), row, "default", 200, at).layout as never, row, BAYS), ["a", "default", "b"]);
  // One never moved stands after those that were; let go where it stood, or not one of them, nothing is written.
  assert.deepEqual(ordered(last.layout as never, ["new", ...row], BAYS), ["b", "default", "a", "new"]);
  assert.deepEqual([movedBay(doc(), row, "b", 250, at), movedBay(doc(), row, "c", 0, at)], [doc(), doc()]);
  assert.deepEqual([ordered(last.layout as never, ["auto", "image"]), arranged(last), ordered(tidied(last).layout as never, row, BAYS)], [["image", "auto"], false, ["b", "default", "a"]]);
  assert.doesNotThrow(() => parseConfig(withRest(last, "asked")));

  // A backend put at another place in its hardware keeps it in the layout, beside the bays' order, and through a tidy-up.
  const stack = ["a", "b", "c"];
  const up = restacked(last, stack, "c", 0);
  assert.deepEqual(ordered(up.layout as never, stack, STACK), ["c", "a", "b"]);
  assert.deepEqual(ordered(restacked(doc(), stack, "a", 9).layout as never, stack, STACK), ["b", "c", "a"]);
  assert.deepEqual([ordered(up.layout as never, row, BAYS), arranged(up), ordered(tidied(up).layout as never, stack, STACK)], [["b", "default", "a"], false, ["c", "a", "b"]]);
  // Put where it stands, or not one of them, nothing is written; forgotten, it stands after those placed.
  assert.deepEqual([restacked(doc(), stack, "b", 1), restacked(doc(), stack, "z", 0), unstacked(doc(), "a")], [doc(), doc(), doc()]);
  assert.deepEqual(ordered(unstacked(up, "c").layout as never, stack, STACK), ["a", "b", "c"]);
  assert.doesNotThrow(() => parseConfig(withRest(up, "asked")));
}

// --- boxes that fit together ------------------------------------------------------------------------
{
  // A box that would lie on one above it moves down past it, and takes what is drawn beside it along; one clear of it stays.
  const ys = spread([
    { id: "a", x: 0, y: 0, w: 100, h: 50 }, { id: "b", x: 50, y: 30, w: 100, h: 50 }, { id: "b-side", x: 300, y: 40, w: 50, h: 20 },
    { id: "c", x: 500, y: 30, w: 100, h: 50 }, { id: "d", x: 60, y: 90, w: 100, h: 20 },
  ], new Map([["b", ["b-side"]]]), 10);
  assert.deepEqual(Object.fromEntries(ys), { a: 0, b: 60, "b-side": 70, c: 30, d: 120 });
  // Boxes set against each other are left alone: only one that lies on another is moved, and then to just below it.
  const flush = spread([{ id: "a", x: 0, y: 0, w: 100, h: 50 }, { id: "under", x: 0, y: 50, w: 100, h: 50 }, { id: "beside", x: 100, y: 0, w: 100, h: 50 }, { id: "on", x: 150, y: 40, w: 100, h: 50 }]);
  assert.deepEqual(Object.fromEntries(flush), { a: 0, under: 50, beside: 0, on: 50 });
  // Ends sit level with the lines that reach them, in that order, never closer than a step; one no line reaches goes last.
  const from: Record<string, number[]> = { low: [300, 340], high: [20], mid: [40], none: [] };
  assert.deepEqual(Object.fromEntries(beside(["low", "high", "mid", "none"], (id) => from[id]!, 50)), { high: 0, mid: 50, low: 295, none: 345 });
  // A taller end takes its own room, so the one under it keeps clear.
  assert.deepEqual(Object.fromEntries(beside(["low", "high", "mid", "none"], (id) => from[id]!, (id) => (id === "high" ? 80 : 50))), { high: 0, mid: 80, low: 295, none: 345 });
  // A box of one caller is as wide as the card under it, its chip in the middle: cards under two such boxes side by side stay clear.
  const [chip, edge, card, gap] = [{ w: 150, h: 30, gap: 6, cols: 2 }, { head: 24, pad: 10 }, 200, 12];
  const one = bayRoom(1, chip, edge, card);
  assert.deepEqual(one, { cols: 1, w: 200, h: 64, inset: 25 });
  const middles = [one.w / 2, one.w + gap + one.w / 2];
  assert.ok(middles[1]! - middles[0]! >= card + gap);
  // One wider than the card keeps its own width, a row short of two chips starting at its edge.
  assert.deepEqual(bayRoom(3, chip, edge, card), { cols: 2, w: 326, h: 100, inset: 10 });
}

// --- a router's rulebook as the one on the map --------------------------------------------------------
{
  const own = { only: { inputs: ["auto"], steps: [{ to: "chat" }] }, rest: { inputs: ["*"], steps: [{ to: { refuse: "no" } }] } };
  const full: Doc = { ...withRest(doc(), "asked"), apiKeys: [{ key: "k", label: "app" }, "bare"], routers: { direct: { strict: true, flows: own }, other: { flows: own } }, callers: { local: "direct" },
    layout: { self: { x: 1, y: 1 }, "routing/flow:pick": { x: 2, y: 2 }, "routing@direct/flow:only": { x: 3, y: 3 } } };
  // The view has the router's flows as `flows` and its own places; the default rulebook's places are left out of it.
  const view = scoped(full, "direct");
  assert.deepEqual([view.flows, view.layout], [own, { self: { x: 1, y: 1 }, "routing/flow:only": { x: 3, y: 3 } }]);
  assert.equal(scoped(full, null), full);
  // Untouched, it goes back as it came; an edit to its flows or its map lands in the router and nowhere else.
  assert.deepEqual(unscoped(view, full, "direct"), full);
  const edited = unscoped(placed(pointStep(view, "only", 0, { kind: "model", model: "other" })!, "routing/flow:only", { x: 9, y: 9 }), full, "direct");
  assert.deepEqual([(edited.routers as Record<string, Doc>).direct!.flows, edited.flows, (edited.routers as Record<string, Doc>).other, edited.layout],
    [{ ...own, only: { inputs: ["auto"], steps: [{ to: "other" }] } }, full.flows, (full.routers as Doc).other, { ...(full.layout as object), "routing@direct/flow:only": { x: 9, y: 9 } }]);
  assert.doesNotThrow(() => parseConfig(edited));
  // A router started from the rules shown has those rules and their places on the map, under its own name.
  const copied = copiedRouter(view, { ...full, layout: { ...(full.layout as object), "routing@twin/flow:gone": { x: 7, y: 7 } } }, "twin");
  assert.deepEqual([(copied.routers as Record<string, Doc>).twin, copied.layout],
    [{ flows: own }, { ...(full.layout as object), "routing@twin/flow:only": { x: 3, y: 3 } }]);
  const map = (d: Doc) => Object.fromEntries(Object.entries(d.layout as Doc).filter(([id]) => id.startsWith("routing/")));
  assert.deepEqual(map(scoped(copied, "twin")), map(view));
  const fromDefault = copiedRouter(scoped(full, null), full, "twin");
  assert.deepEqual([(fromDefault.routers as Record<string, Doc>).twin, map(scoped(fromDefault, "twin"))], [{ flows: full.flows }, { "routing/flow:pick": { x: 2, y: 2 } }]);
  assert.doesNotThrow(() => parseConfig(copied));
  // Everyone not named is a caller of its own; the rest go where it does unless they are sent somewhere else.
  assert.deepEqual(callersIn(full), ["*", "local", "app"]);
  assert.deepEqual([routerFor(full, "local"), routerFor(full, "app"), usersOf(full, "direct"), usersOf(full, null)], [{ router: "direct", own: true }, { router: null, own: false }, ["local"], ["*", "app"]]);
  // Moving everyone else takes those who follow along; one sent back to the default router is kept as that.
  const moved = withCaller(full, "*", "other");
  assert.deepEqual([moved.callers, usersOf(moved, "other")], [{ local: "direct", "*": "other" }, ["*", "app"]]);
  assert.deepEqual(withCaller(moved, "app", null).callers, { local: "direct", "*": "other", app: "default" });
  // A caller sent where everyone else goes follows them again; one sent elsewhere stays put when they move back.
  assert.deepEqual(withCaller(moved, "local", "other").callers, { "*": "other" });
  assert.deepEqual(withCaller(withCaller(full, "*", "direct"), "*", null).callers, { local: "direct" });
  assert.equal(withCaller(full, "local", null).callers, undefined);
  assert.doesNotThrow(() => parseConfig(withCaller(moved, "app", null)));
}

// --- a name sent straight to a model that is not chat, and a draft said in words ------------------------
{
  const piped = { ...withRest(doc(), "asked"), backends: { ...(doc().backends as object), voice: { url: "http://127.0.0.1:9", kind: "none", routes: [{ path: "/speak", model: "say", lane: "chat" }, { path: "/upstream/{model}/hum", lane: "chat" }] } } } as Doc;
  const live = { net: { nodes: [{ name: "me", self: true, up: true, free: 1, slots: 1, queued: 0 }] }, routing: {} } as unknown as UiData;
  // The paths a model answers on: one that names it, and any that carry the model in the path.
  assert.deepEqual(factsOf(piped, live).paths("say"), ["/speak", "/upstream/{model}/hum"]);
  // Drawn straight to it, a name becomes a type of its own that takes those paths, and the file loads.
  const typed = routeTyped(piped, "Speech", "say", ["/speak"]);
  assert.deepEqual((typed.flows as Record<string, Doc>).Speech, { takes: ["/speak"], inputs: ["Speech"], steps: [{ to: "say" }] });
  assert.doesNotThrow(() => parseConfig(typed));

  // A type moves any number of places in one go.
  assert.deepEqual(ordered(movedName(doc(), ["a", "b", "c", "d"], "d", -3).layout as never, ["a", "b", "c", "d"]), ["d", "a", "b", "c"]);
  // A caller no longer sent anywhere of its own goes where everyone else does.
  const pinned = { ...doc(), routers: { r: { flows: {} } }, callers: { local: "r", "*": "r" } } as Doc;
  assert.deepEqual([followed(pinned, "local").callers, followed(followed(pinned, "local"), "*").callers], [{ "*": "r" }, undefined]);

  // What a draft changes, a line per thing, in the words the map uses.
  const after = placed(put(withCaller({ ...pinned, backends: { ...(doc().backends as object), extra: { url: "http://127.0.0.1:1" } } }, "local", null), "resources", "gpu0", { kind: "gpu", shared: true }), "self", { x: 1, y: 1 });
  assert.deepEqual(summary(pinned, pointStep(after, "pick", 1, { kind: "model", model: "other" })!), [
    "hardware gpu0: shared changed", "backend extra: added", "rule pick: its lines or what enters it changed", "caller local: now goes by the default router", "where things are placed on the maps",
  ]);
  assert.deepEqual(summary(pinned, pinned), []);
  // A rule or a type under a new name is said as that, not as one gone and one come.
  assert.deepEqual(summary(doc(), renamed(doc(), "flows", "heavy", "big")!), ["rule heavy: renamed to big"]);
  assert.deepEqual(summary(routeId(doc(), "x", { kind: "model", model: "chat" }), retyped(routeId(doc(), "x", { kind: "model", model: "chat" }), "x", "y")!), ["rule x: renamed to y"]);
}

// --- what is written is the change and nothing else -------------------------------------------------
{
  assert.deepEqual(opsOf(doc(), pointStep(doc(), "pick", 1, { kind: "model", model: "other" })!), [{ path: ["flows", "pick", "steps", 1, "to"], value: "other" }]);
  const { servers: _, ...without } = doc();
  assert.deepEqual(opsOf(doc(), without), [{ path: ["servers"], delete: true }]);
}

// --- hardware dragged onto another machine takes what sits in it along -----------------------------
{
  let two = put(put(put(doc(), "servers", "other", { host: "10.0.0.6" }), "resources", "gpu2", { kind: "gpu" }), "resources", "cpu", { kind: "cpu", shared: true });
  two = put(two, "backends", "also", { url: "http://127.0.0.1:8081", kind: "none", serves: ["more"], resources: ["gpu2", "gpu0"] });
  two = put(two, "backends", "small", { url: "http://127.0.0.1:8082", kind: "none", serves: ["tiny"], resources: ["cpu"] });
  two = put(two, "backends", "spill", { url: "http://127.0.0.1:8083", kind: "none", serves: ["huge"], resources: ["gpu2", "cpu"] });
  const b = (d: Doc, n: string) => (d.backends as Record<string, Doc>)[n]!;
  // Every backend here that uses gpu0 goes with it, though "also" sits in gpu2; so gpu2 goes too, and "spill" on it.
  // The one on another machine stays.
  const out = movedHardware(two, "gpu0", "", "other");
  assert.deepEqual([b(out, "near").server, b(out, "also").server, b(out, "spill").server, b(out, "small").server, b(out, "far")], ["other", "other", "other", undefined, b(two, "far")]);
  assert.doesNotThrow(() => parseConfig(out));
  // Shared hardware takes only what sits in it: "spill" uses cpu but sits in gpu2.
  const cpu = movedHardware(two, "cpu", "", "other");
  assert.deepEqual([b(cpu, "small").server, b(cpu, "spill").server], ["other", undefined]);
  assert.doesNotThrow(() => parseConfig(cpu));
  // Back to this machine: the server goes, and one reached by port alone is given a url to reach it by.
  const home = movedHardware(two, "gpu1", "box", "");
  assert.deepEqual([b(home, "far").server, b(home, "far").port, b(home, "far").url], [undefined, undefined, "http://127.0.0.1:7860"]);
  assert.doesNotThrow(() => parseConfig(home));
  // Let go on the machine it is on, or hardware nothing sits in, nothing is written.
  assert.deepEqual([movedHardware(two, "gpu0", "", ""), movedHardware(two, "gpu0", "box", "other")], [two, two]);
}

// Plugins on a line: added last, moved, wired per line in the file's shortest form, and taken off.
{
  const doc: Doc = { version: 3, name: "t", backends: { main: { url: "http://127.0.0.1:1", serves: ["m"] } }, models: { m: { backend: "main" }, e: { kind: "embeddings" } },
    plugins: { a: { use: "http://x:1/a", trust: "http" }, b: { use: "http://x:1/b", trust: "http" } },
    flows: { r: { inputs: ["*"], steps: [{ to: { asked: true } }] } } };
  const one = withPlugin(withPlugin(doc, "r", 0, "a", true)!, "r", 0, "b", true)!;
  const step = (d: Doc) => (d.flows as Record<string, { steps: Doc[] }>).r!.steps[0]!;
  assert.deepEqual(placedOn(step(one)), [{ name: "a", models: {} }, { name: "b", models: {} }]);
  assert.equal(withPlugin(one, "r", 0, "a", true), null, "once per line");
  const moved = movePlugin(one, "r", 0, "b", -1)!;
  const wired = wireSlot(moved, "r", 0, "a", "embed", "e")!;
  assert.deepEqual(step(wired).plugins, ["b", { use: "a", models: { embed: "e" } }]);
  assert.doesNotThrow(() => parseConfig(wired));
  assert.deepEqual(step(wireSlot(wired, "r", 0, "a", "embed", null)!).plugins, ["b", "a"], "back to the plugin's own: the short form again");
  const off = withPlugin(withPlugin(wired, "r", 0, "a", false)!, "r", 0, "b", false)!;
  assert.equal(step(off).plugins, undefined, "none left takes the key away");
  assert.equal(directTo("x", { inputs: ["x"], steps: [{ to: "m", plugins: ["a"] }] }), null, "a line with plugins is drawn as a rule");
  assert.deepEqual(placedOn({ plugins: [{ name: "a", models: { embed: "e" } }] }), [{ name: "a", models: { embed: "e" } }], "the node's own report of a line reads the same");
}

console.log("draft.test.ts ok");
