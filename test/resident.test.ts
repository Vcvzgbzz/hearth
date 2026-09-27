/**
 * Resident backends: small always-loaded services that share a card instead of taking turns.
 *
 * The two ways this goes wrong are opposites. Treated as an ordinary backend, every tiny
 * request of the resident would take the card and evict the big model on it. Treated as
 * shared hardware, nobody would ever ask it to move, and a big load lands on top of it.
 *
 *     npx tsx test/resident.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { ConfigError, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { BackendPool } from "../src/pool.js";

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { open, wait: () => p };
}

// The resident: records what hearth asks of it, in order.
const calls: string[] = [];
const resident = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    calls.push(`${req.url} ${body}`);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise<void>((r) => resident.listen(0, "127.0.0.1", r));
const residentUrl = `http://127.0.0.1:${(resident.address() as AddressInfo).port}`;

const config = (url: string) => parseConfig({
  name: "t",
  resources: { gpu1: { kind: "gpu" } },
  backends: [
    { name: "render", url: "http://127.0.0.1:1", kind: "none", serves: ["image"], resources: ["gpu1"] },
    { name: "memory", url, kind: "none", serves: ["memory"], resources: ["gpu1"], resident: true },
  ],
});

// --- the resident's own requests never take the card -------------------------------
{
  calls.length = 0;
  const p = new BackendPool(config(residentUrl), silentLogger, 50);
  const held = gate();
  void p.get("memory")!.scheduler.submit({ lane: "chat", model: "memory", caller: "t" }, () => held.wait());
  await tick();
  assert.equal(p.resources().find((r) => r.name === "gpu1")!.holder, null, "a rerank does not hold the card");
  let rendered = false;
  await p.get("render")!.scheduler.submit({ lane: "chat", model: "image", caller: "t" }, async () => { rendered = true; });
  assert.equal(rendered, true, "a render starts while the resident is busy: it never waits on it");
  assert.ok(p.resources().find((r) => r.name === "gpu1")!.backends.includes("memory"), "but it is drawn on the card");
  held.open();
  await sleep(120);
}

// --- another backend's turn yields the resident first, then resumes it once the card is free
{
  calls.length = 0;
  const order: string[] = [];
  const p = new BackendPool(config(residentUrl), silentLogger, 50);
  await p.get("render")!.scheduler.submit({ lane: "chat", model: "image", caller: "t" }, async () => {
    order.push(`render after ${calls.length} call(s): ${calls.join(" | ")}`);
  });
  assert.match(order[0]!, /render after 1 call\(s\): \/yield \{"seconds":3600\}/, "yielded before the render ran");
  assert.equal(calls.filter((c) => c.startsWith("/resume")).length, 0, "not resumed while the card might be reused");
  await sleep(120);
  assert.deepEqual(calls.map((c) => c.split(" ")[0]), ["/yield", "/resume"], "resumed once the card stayed free");
}

// --- a burst of turns resumes once, after the last -----------------------------------
{
  calls.length = 0;
  const p = new BackendPool(config(residentUrl), silentLogger, 80);
  for (let i = 0; i < 3; i++) {
    await p.get("render")!.scheduler.submit({ lane: "chat", model: "image", caller: "t" }, async () => {});
    await sleep(20); // gaps shorter than the resume delay
  }
  await sleep(160);
  assert.equal(calls.filter((c) => c.startsWith("/resume")).length, 1, "one resume for the whole burst");
}

// --- a resident that does not answer never holds up a turn ---------------------------
{
  const p = new BackendPool(config("http://127.0.0.1:1"), silentLogger, 50);
  let rendered = false;
  await p.get("render")!.scheduler.submit({ lane: "chat", model: "image", caller: "t" }, async () => { rendered = true; });
  assert.equal(rendered, true, "the render runs even though the yield failed");
}

// --- config -------------------------------------------------------------------------
{
  const b = config(residentUrl).backends.find((x) => x.name === "memory")!;
  assert.deepEqual(b.resident, { yield: "/yield", resume: "/resume" }, "resident: true means the default paths");
  assert.throws(() => parseConfig({
    name: "t", resources: { cpu: { kind: "cpu", shared: true } },
    backends: [{ name: "m", url: "http://127.0.0.1:1", kind: "none", serves: ["m"], resources: ["cpu"], resident: true }],
  }), ConfigError, "a resident on shared hardware has nothing to yield");
  assert.throws(() => parseConfig({
    name: "t", backends: [{ name: "m", url: "http://127.0.0.1:1", kind: "none", serves: ["m"], resident: { yield: "nope" } , resources: ["g"] }],
  }), ConfigError, "paths must be paths");
}

resident.close();
console.log("resident.test.ts ok");
