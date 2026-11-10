/**
 * What a rulebook lets a caller reach, as the keys page lists it. The failures worth catching:
 *
 *   - a model behind a hand-off or a fallback left off the list
 *   - a limit offered that can never fire: tokens on a routed model, jobs on a peer's
 *   - a lane shown that the work will not land in
 */
import assert from "node:assert/strict";

import { parseConfig, type HearthConfig } from "../src/config/config.js";
import type { Flow } from "../src/config/flows.js";
import { reachOf } from "../src/routing/reach.js";

const cfgOf = (extra: Record<string, unknown>): HearthConfig => parseConfig({
  name: "n",
  backends: { spare: { url: "http://127.0.0.1:3", kind: "none", serves: ["e"] }, main: { url: "http://127.0.0.1:1", kind: "none", serves: ["a", "b", "c", "d"], routes: [{ path: "/v1/rank", model: "ranker", lane: "chat" }, { path: "/v1/embed", lane: "batch" }] } },
  peers: { friend: { url: "http://127.0.0.1:2", token: "t", models: { a: "a", far: "far" } } },
  models: { pinned: { lane: "batch" } },
  ...extra,
});
const rules = (raw: Record<string, unknown>): { cfg: HearthConfig; flows: Record<string, Flow> } => {
  const cfg = cfgOf({ flows: { ...raw, rest: { inputs: ["*"], steps: [{ to: { refuse: "no" } }] } } });
  return { cfg, flows: cfg.flows };
};
const ends = (cfg: HearthConfig, flows: Record<string, Flow>, type: string) => reachOf(cfg, flows).find((t) => t.type === type)!.ends;

// Hand-offs are followed, and a refusal reaches nothing.
{
  const { cfg, flows } = rules({
    top: { inputs: ["chat"], steps: [{ to: "a", when: { variant: ["x"] } }, { to: { flow: "next" }, when: { variant: ["x"] } }, { to: { refuse: "no" } }] },
    next: { inputs: [], steps: [{ to: "b", when: { variant: ["x"] } }, { to: { refuse: "no" } }] },
  });
  assert.deepEqual(reachOf(cfg, flows).map((t) => t.type), ["chat"], "the * input is no type, and a flow nobody names is not one");
  assert.deepEqual(ends(cfg, flows, "chat").map((e) => e.id), ["a", "b"]);
}

// Every end of a fastest; a peer's, with whose; one id here and there is one end.
{
  const { cfg, flows } = rules({
    top: { inputs: ["chat"], steps: [{ to: { fastest: [{ model: "a" }, { peer: "friend", model: "a" }] }, when: { variant: ["x"] } }, { to: { peer: "friend", model: "far" } }, { to: { refuse: "no" } }] },
  });
  assert.deepEqual(ends(cfg, flows, "chat").map((e) => [e.id, e.here, e.peers]), [["a", true, ["friend"]], ["far", false, ["friend"]]]);
}

// A step that goes to a plugin, where the node has them.
{
  const { cfg, flows } = rules({ tools: { inputs: ["tools"], steps: [{ to: "a" }] } });
  (flows.tools!.steps[0]! as { to: unknown }).to = { plugin: "search" };
  assert.deepEqual(ends(cfg, flows, "tools").map((e) => [e.id, e.plugin]), [["search", true]]);
}

// A name that runs as itself.
{
  const { cfg, flows } = rules({ own: { inputs: ["c"], steps: [{ to: { asked: true } }] } });
  assert.deepEqual(ends(cfg, flows, "c").map((e) => e.id), ["c"]);
}

// Chat or a path, which says whether tokens are counted, and the lane each lands in.
{
  const { cfg, flows } = rules({
    talk: { inputs: ["chat"], steps: [{ to: "a", when: { variant: ["x"] } }, { to: "pinned" }] },
    rank: { inputs: ["rank"], takes: ["/v1/rank"], steps: [{ to: "a", when: { variant: ["x"] } }, { to: "ranker" }] },
  });
  assert.deepEqual(ends(cfg, flows, "rank").map((e) => [e.id, e.chat]), [["a", true], ["ranker", false]], "a reached by chat as well counts tokens");
  assert.equal(ends(cfg, flows, "rank")[1]!.lane, "chat", "a routed model lands in its route's lane");
  assert.equal(ends(cfg, flows, "chat")[0]!.lane, null, "a chat model with no lane of its own takes the key's");
  assert.equal(ends(cfg, flows, "chat")[1]!.lane, "batch", "a model's own lane holds");
}

// A route that names no model still pins the lane of what the backend serves through it.
{
  const { cfg, flows } = rules({ embed: { inputs: ["embed"], takes: ["/v1/embed"], steps: [{ to: "d" }] } });
  assert.deepEqual(ends(cfg, flows, "embed").map((e) => [e.id, e.chat, e.lane]), [["d", false, "batch"]]);
}

// A path belongs to one backend, so what stands in for it there as a fallback lands in that route's lane.
{
  const { cfg, flows } = rules({ embed: { inputs: ["embed"], takes: ["/v1/embed"], steps: [{ to: "d", when: { variant: ["x"] } }, { to: "e" }] } });
  assert.equal(ends(cfg, flows, "embed")[1]!.lane, "batch");
}

// A step's lane and one on the name asked for are where the work lands, so the page says so.
{
  const cfg = cfgOf({ models: { pinned: { lane: "batch" }, named: { lane: "batch" } }, flows: {
    stepped: { inputs: ["chat"], steps: [{ to: "a", lane: "batch", when: { variant: ["x"] } }, { to: "b", when: { variant: ["y"] } }, { to: { flow: "later" }, lane: "batch", when: { variant: ["z"] } }, { to: { refuse: "no" } }] },
    later: { inputs: [], steps: [{ to: "c" }] },
    named: { inputs: ["named"], steps: [{ to: "a" }] },
    twice: { inputs: ["twice"], steps: [{ to: "a", lane: "batch", when: { variant: ["x"] } }, { to: "a" }] },
    rest: { inputs: ["*"], steps: [{ to: { refuse: "no" } }] },
  } });
  assert.deepEqual(ends(cfg, cfg.flows, "chat").map((e) => [e.id, e.lane]), [["a", "batch"], ["b", null], ["c", "batch"]], "a step's lane holds through a hand-off");
  assert.equal(ends(cfg, cfg.flows, "named")[0]!.lane, "batch", "a lane on the name asked for");
  assert.equal(ends(cfg, cfg.flows, "twice")[0]!.lane, "varies", "two steps, two lanes: neither alone is true");
}

// A route's lane beats a model's own, since a routed request queues in the route's.
{
  const cfg = cfgOf({ models: { d: { lane: "batch" } }, flows: {
    rank: { inputs: ["rank"], takes: ["/v1/rank"], steps: [{ to: "d" }] },
    rest: { inputs: ["*"], steps: [{ to: { refuse: "no" } }] },
  } });
  assert.equal(ends(cfg, cfg.flows, "rank")[0]!.lane, "chat");
}

// Where the rule for everything else lands is reached too, and a name run as itself leaves that open.
{
  const cfg = cfgOf({ flows: { rest: { inputs: ["*"], steps: [{ to: "a" }] } } });
  assert.deepEqual(reachOf(cfg, cfg.flows).map((t) => [t.type, t.ends.map((e) => e.id), t.asAsked]), [["anything else", ["a"], undefined]]);
  const open = cfgOf({ flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } } });
  assert.deepEqual(reachOf(open, open.flows).map((t) => [t.type, t.ends.length, t.asAsked]), [["anything else", 0, true]]);
}

// A hand-off to a flow that is switched off still runs its steps; only a name that enters it runs as itself.
{
  const cfg = cfgOf({ flows: {
    top: { inputs: ["top"], steps: [{ to: { flow: "resting" } }] },
    resting: { inputs: ["quiet"], off: true, steps: [{ to: "a" }] },
    rest: { inputs: ["*"], steps: [{ to: { refuse: "no" } }] },
  } });
  assert.deepEqual(ends(cfg, cfg.flows, "top").map((e) => e.id), ["a"]);
  assert.deepEqual(ends(cfg, cfg.flows, "quiet").map((e) => e.id), ["quiet"]);
}

console.log("reach.test.ts ok");
