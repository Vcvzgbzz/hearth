/**
 * Two backends that run the same model under two names of ours, on one routed path: the name
 * pinned to the spare runs there when asked for, and a form that falls back carries the spare's id.
 *
 *     npx tsx test/fallback-names.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseV1 } from "./v1.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

/** A backend stand-in that records each POST body as text and answers `status`. */
function fake() {
  let status = 200;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST") seen.push(Buffer.concat(chunks).toString());
      res.writeHead(req.method === "POST" ? status : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.method === "POST" ? { ok: status === 200 } : { data: [] }));
    });
  });
  return {
    seen,
    answer: (s: number) => { status = s; },
    listen: () => new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready)),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

const gpu = fake();
const spare = fake();
await gpu.listen();
await spare.listen();
const node = createNode(parseV1({
  name: "names",
  resources: { gpu: { kind: "gpu" }, cpu: { kind: "cpu", shared: true } },
  backends: [
    {
      name: "gpu", url: gpu.url(), kind: "none", serves: ["voice"], resources: ["gpu"],
      routes: [{ path: "/v1/audio/speech", lane: "chat", model: "voice", fallback: { backend: "spare", model: "speak-cpu" } }],
    },
    { name: "spare", url: spare.url(), kind: "none", resources: ["cpu"] },
  ],
  models: { speak: { backend: "gpu", as: "voice" }, "speak-cpu": { backend: "spare", as: "voice" } },
}), silentLogger);
node.start();
const at = await new Promise<string>((ready) =>
  node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
);
const json = async (model: string) => {
  const r = await fetch(`${at}/v1/audio/speech`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, input: "x" }),
  });
  await r.text();
  return r.status;
};
const form = async (model: string) => {
  const f = new FormData();
  f.set("model", model);
  f.set("file", new Blob(["abc"]), "a.bin");
  const r = await fetch(`${at}/v1/audio/speech`, { method: "POST", body: f });
  await r.text();
  return r.status;
};
const field = (body: string) => /name="model"\r\n\r\n([^\r]*)/.exec(body)?.[1];

try {
  assert.equal(await json("speak-cpu"), 200);
  assert.equal(gpu.seen.length, 0, "a name pinned to the spare is not the first backend's, though both run its id");
  assert.equal((JSON.parse(spare.seen.at(-1)!) as { model: string }).model, "voice", "and it goes out under the spare's id");

  assert.equal(await json("speak"), 200);
  assert.equal(gpu.seen.length, 1, "the name pinned to the first backend runs there");

  gpu.answer(503);
  spare.seen.length = 0;
  assert.equal(await form("speak"), 200);
  assert.equal(field(spare.seen.at(-1)!), "voice", "a form that falls back names the spare's id in its model field");
  assert.match(spare.seen.at(-1)!, /abc/, "and its file part is intact");
} finally {
  await node.close();
  gpu.close();
  spare.close();
}
console.log("fallback-names.test.ts ok");
