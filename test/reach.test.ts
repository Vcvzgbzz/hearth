/**
 * What a rulebook lets a caller reach, as the keys page lists it. The failures worth catching:
 *
 *   - a model behind a hand-off or a fallback left off the list
 *   - a limit offered that can never fire: tokens on a routed model, jobs on a peer's
 *   - a lane shown that the work will not land in
 */
import assert from "node:assert/strict";

import { parseConfig, type Flow, type HearthConfig } from "../src/config.js";
import { reachOf } from "../src/reach.js";

const cfgOf = (extra: Record<string, unknown>): HearthConfig => parseConfig({
  name: "n",
  backends: { main: { url: "http://127.0.0.1:1", kind: "none", serves: ["a", "b", "c"], routes: [{ path: "/v1/rank", model: "ranker", lane: "chat" }] } },
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

console.log("reach.test.ts ok");
