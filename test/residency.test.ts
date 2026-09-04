/**
 * Which models a backend that declares `serves` reports as WARM.
 *
 * `serves` exists so a backend that cannot name its own models can still be
 * routed to: a bare llama-server reports the gguf path it was launched with,
 * under every key, warm state included. For that backend the declared names are
 * the best anyone can say, so "something is loaded there" has to mean "these".
 *
 * The trap is applying that translation to a backend that CAN name its models.
 * A llama-swap backend may declare `serves` — to partition ids across two
 * instances, say — and still report exactly which one is resident. Blanket
 * marking all of them warm makes the scheduler's warm bonus fire for models
 * that would in fact cost a full load, which is the swap the bonus exists to
 * avoid. So a reported id we recognise is believed, and the translation is the
 * fallback rather than the rule.
 *
 *     npx tsx test/residency.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

/** A backend whose /running answer we control, including whether the id it
 *  reports is one the config declared. */
function fake(running: () => { model: string; state: string }[]) {
  const server = createServer((req, res) => {
    if (req.url === "/running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: running() }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  return {
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

let reported: { model: string; state: string }[] = [];
const backend = fake(() => reported);
await backend.listen();

const node = createNode(
  parseConfig({
    name: "residency",
    backends: [
      {
        name: "swap",
        url: backend.url(),
        kind: "llama-swap",
        concurrency: 1,
        serves: ["alpha", "beta", "gamma"],
      },
    ],
  }),
  silentLogger,
);
node.start();
const base = await new Promise<string>((ready) =>
  node.server.listen(0, "127.0.0.1", () =>
    ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
);

async function loaded(): Promise<string[]> {
  // refresh(), not ensureFresh(): the latter is TTL-cached and would answer
  // from the previous case's poll.
  await Promise.all(node.pool.all().map((b) => b.state.refresh()));
  const r = await fetch(`${base}/network`);
  const body = (await r.json()) as { nodes: { self?: boolean; loaded: string[] }[] };
  return body.nodes.find((n) => n.self)!.loaded;
}

// --- a backend that names its model is believed ----------------------------
// The whole point. One of three declared models is resident; the other two are
// cold and would each cost a full load.
{
  reported = [{ model: "beta", state: "ready" }];
  assert.deepEqual(
    await loaded(),
    ["beta"],
    "only the model actually reported resident is warm",
  );
}

// --- nothing loaded is nothing warm ---------------------------------------
{
  reported = [];
  assert.deepEqual(await loaded(), []);
}

// --- but an unrecognisable id still falls back to the declared names -------
// This is the case `serves` was built for: the backend is reporting a path, not
// a model id, so the declaration is the only usable answer. Losing this would
// make such a backend read as permanently cold.
{
  reported = [{ model: "/models/some-quant.gguf", state: "ready" }];
  assert.deepEqual(
    (await loaded()).sort(),
    ["alpha", "beta", "gamma"],
    "a backend reporting an id we cannot use falls back to what it declared",
  );
}

node.server.closeAllConnections();
node.server.close();
backend.close();
console.log("residency.test.ts ok");
