/**
 * A backend that keeps failing is rested. The failures worth catching:
 *
 *   - every request still paying for a failed try at a backend that has failed three times running
 *   - a rested backend never tried again, or tried by a request with nowhere else to go being refused
 *   - one success not clearing what was counted against it
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

let broken = true;
let tried = 0;
const serve = (id: string, flaky: boolean) => createServer((req, res) => {
  const say = (status: number, o: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  req.resume();
  if (req.url === "/v1/models") return say(200, { data: [{ id }] });
  if (req.url !== "/v1/chat/completions") return say(404, {});
  if (flaky) tried++;
  if (flaky && broken) return say(503, { error: { message: "overloaded" } });
  say(200, { choices: [{ message: { role: "assistant", content: id } }] });
});
const [flaky, steady] = [serve("flaky", true), serve("steady", false)];
await Promise.all([flaky, steady].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
const port = (s: typeof flaky) => (s.address() as AddressInfo).port;

const cfgPath = join(mkdtempSync(join(tmpdir(), "hearth-cooldown-")), "hearth.yaml");
writeFileSync(cfgPath, `name: node-under-test
backendDefaults: {restMs: 300}
backends:
  a: {url: "http://127.0.0.1:${port(flaky)}", kind: none, serves: [flaky]}
  b: {url: "http://127.0.0.1:${port(steady)}", kind: none, serves: [steady]}
flows:
  chat:
    inputs: [chat]
    steps:
      - {when: {tools: false}, to: {model: flaky}}
      - {to: {model: steady}}
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
`);
const node = createNode(loadConfig(cfgPath), silentLogger);
node.start();
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const ask = async (model = "chat") => {
  const r = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });
  return { status: r.status, by: r.status === 200 ? ((await r.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content : await r.text() };
};
const resting = async () => ((await (await fetch(`${url}/network`)).json()) as { nodes: { backends?: { name: string; restingMs?: number }[] }[] }).nodes.flatMap((n) => n.backends ?? []).find((b) => b.name === "a")?.restingMs ?? 0;

try {
  for (let i = 0; i < 3; i++) assert.deepEqual(await ask(), { status: 200, by: "steady" }, "a failure before anything is sent moves on down the flow");
  assert.equal(tried, 3);
  assert.ok((await resting()) > 0, "three in a row rest it, and the page is told");

  for (let i = 0; i < 4; i++) assert.equal((await ask()).by, "steady");
  assert.equal(tried, 3, "while it rests, nothing with another line that fits is sent to it");

  assert.equal((await ask("flaky")).status, 503, "a request with nowhere else to go still tries it");
  assert.equal(tried, 4);

  await new Promise((r) => setTimeout(r, 350));
  assert.equal((await ask()).by, "steady");
  assert.equal(tried, 5, "the rest over, the next request tries it");
  assert.equal((await ask()).by, "steady");
  assert.equal(tried, 5, "and one more failure rests it again");

  broken = false;
  await new Promise((r) => setTimeout(r, 350));
  assert.equal((await ask()).by, "flaky", "mended, it answers the first request after the rest");
  assert.equal(await resting(), 0);
  broken = true;
  assert.equal((await ask()).by, "steady");
  assert.equal((await ask()).by, "steady");
  assert.equal(await resting(), 0, "having answered, it starts from nothing: two failures do not rest it");
  console.log("cooldown.test.ts ok");
} finally {
  await node.close();
  flaky.close();
  steady.close();
}
