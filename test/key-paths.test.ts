/**
 * A key's limits on the paths a request takes after its first choice. The failures worth catching:
 *
 *   - work going to a peer refused by a cap the key was told it skips
 *   - a failed peer's retry running past the key's limit, uncounted
 *   - a model's own limit checked on the first model and not the one that ran
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
const ok = { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };

/** A server that answers what `answer` says; null leaves the request waiting in `gates`. */
function server(answer: (url: string) => number | null, gates: (() => void)[] = []) {
  return createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const say = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url === "/peer/state" || req.url === "/peer/hello") return say(200, { free: 8, slots: 8, queued: {}, resident: null, loaded: ["theirs"], serves: ["theirs"] });
      if (req.url === "/v1/models") return say(200, { data: [] });
      const status = answer(req.url ?? "");
      if (status === null) gates.push(() => say(200, ok));
      else say(status, status === 200 ? ok : { error: { message: "no" } });
    });
  });
}

const here: (() => void)[] = [];
const away: (() => void)[] = [];
const card = await listen(server((url) => (url === "/v1/rank" ? 500 : null), here));
const broken = await listen(server(() => 500));
const spare = await listen(server(() => 200));
const friend = await listen(server(() => null, away));
const bad = await listen(server(() => 500));

const node = createNode(parseConfig({
  name: "paths-under-test",
  scheduler: { maxPerCaller: 1 },
  backends: {
    card: { url: card, kind: "none", serves: ["local"], concurrency: 8, routes: [{ path: "/v1/rank", model: "ranker", lane: "chat", fallback: { backend: "spare", model: "kept" } }] },
    broken: { url: broken, kind: "none", serves: ["down"], concurrency: 8 },
    spare: { url: spare, kind: "none", serves: ["kept", "moved-to"], concurrency: 8 },
  },
  peers: { friend: { url: friend, token: "t", models: { lent: "theirs" } }, bad: { url: bad, token: "t", models: { failing: "theirs" } } },
  flows: {
    out: { inputs: ["out"], steps: [{ to: { peer: "friend", model: "lent" } }, { to: { refuse: "no peer" } }] },
    back: { inputs: ["back"], steps: [{ to: { peer: "bad", model: "failing" } }, { to: "local" }] },
    moved: { inputs: ["moved"], steps: [{ to: "down" }, { to: "moved-to" }] },
    rest: { inputs: ["*"], steps: [{ to: { asked: true } }] },
  },
  apiKeys: [
    { key: "boss-secret", label: "boss" },
    { key: "many-secret", label: "many", limits: { maxConcurrent: 3 } },
    { key: "one-secret", label: "one", limits: { maxConcurrent: 1 } },
    { key: "last-secret", label: "last", limits: { models: { "moved-to": { requestsPerMinute: 1 } } } },
    { key: "rank-secret", label: "rank", limits: { models: { kept: { requestsPerMinute: 1 } } } },
  ],
}), silentLogger);
node.start();
const url = await listen(node.server);
const post = (key: string, path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
const ask = (key: string, model: string) => post(key, "/v1/chat/completions", { model, messages: [{ role: "user", content: "hi" }] });
const until = async (done: () => boolean) => { for (let i = 0; !done() && i < 300; i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(done()); };
const settle = () => new Promise<void>((r) => setTimeout(r, 60));
const queue = async () => ((await (await fetch(`${url}/queue`, { headers: { Authorization: "Bearer boss-secret" } })).json()) as { jobs: { caller: string; state: string; held?: string }[] }).jobs;
await settle();

// Work bound for a peer skips the node's cap as local work does, once the key says how many it may run.
const lent = [ask("many-secret", "out"), ask("many-secret", "out")];
await until(() => away.length === 2);
while (away.length > 0) away.shift()!();
assert.deepEqual((await Promise.all(lent)).map((r) => r.status), [200, 200]);

// A failed peer's retry here is held to the key's limit, and counted.
const running = ask("one-secret", "local");
await until(() => here.length === 1);
const retried = ask("one-secret", "back");
await settle();
assert.equal(here.length, 1, "the retry waits for the key's job to end");
assert.deepEqual((await queue()).filter((j) => j.state === "queued").map((j) => [j.caller, j.held]), [["key:one", "key"]]);
here.shift()!();
await until(() => here.length === 1);
here.shift()!();
assert.deepEqual([(await running).status, (await retried).status], [200, 200]);

// A model's own limit holds on the model that ran, not only the first one the rules named.
assert.equal((await ask("last-secret", "moved")).status, 200, "the first line failed and the next ran");
const second = await ask("last-secret", "moved");
assert.equal(second.status, 429);
assert.match(await second.text(), /requests a minute of moved-to/);

// The same on a routed path: the limit is on what its fallback ran as.
assert.equal((await post("rank-secret", "/v1/rank", {})).status, 200);
const third = await post("rank-secret", "/v1/rank", {});
assert.equal(third.status, 429);
assert.match(await third.text(), /requests a minute of kept/);

await node.close();
console.log("key-paths.test.ts ok");
process.exit(0);
