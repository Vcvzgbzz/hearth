/**
 * The multipart door, on the branch that has one.
 *
 * `/v1/audio/transcriptions` is a form upload: the model is in a multipart
 * field, not in JSON. The passthrough resolves it (`multipartField`), and the
 * degraded gate is built on that resolution rather than on its own parsing — so
 * a form naming a degraded model is refused exactly like a JSON body is, and a
 * form naming a working one is forwarded with its file part untouched.
 *
 * This test exists only on this branch because `src/multipart.ts` only exists
 * here; the gate itself is told nothing about multipart.
 *
 *   npx tsx test/canary-multipart-gate.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseV1 } from "./v1.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode } from "../src/server.js";

const BOUNDARY = "----hearthCanaryBoundary7MA4YWxk";
const FILE = Buffer.from("RIFF....fake wav bytes....");

/** One form: the model field the passthrough reads, a file part it must not touch. */
function form(model: string): Buffer {
  const head = (name: string, extra = ""): string =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n`;
  return Buffer.concat([
    Buffer.from(head("file", '; filename="a.wav"') + "Content-Type: audio/wav\r\n\r\n"),
    FILE,
    Buffer.from("\r\n" + head("model") + "\r\n" + model + "\r\n"),
    Buffer.from(head("response_format") + "\r\njson\r\n"),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
}

function fakeSwap() {
  let broken = true;
  const seen = { transcriptions: 0 };
  const s = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const j = (b: unknown, code = 200) => {
      const t = JSON.stringify(b);
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(t) });
      res.end(t);
    };
    if (path === "/api/events") { res.writeHead(404); res.end(); return; }
    if (path === "/running") return j({ running: [{ model: "m", state: "ready" }] });
    if (path === "/v1/models") return j({ data: [{ id: "m" }] });
    if (path === "/api/models/unload/m") return j({ ok: true });
    if (path === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => j({
        choices: [{ message: { content: broken ? "!".repeat(200) : "Paris is the capital of France." }, finish_reason: broken ? "length" : "stop" }],
      }));
      return;
    }
    if (path === "/v1/audio/transcriptions") {
      seen.transcriptions++;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => j({ text: "ok", bytes: Buffer.concat(chunks).length }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return {
    s, seen,
    heal: () => { broken = false; },
    url: async () => {
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    },
  };
}

const formPost = async (base: string, model: string) => {
  const r = await fetch(`${base}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: form(model),
  });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, text, body };
};

const statusOf = async (base: string, id: string) => {
  const body = (await (await fetch(`${base}/v1/models`)).json()) as {
    data: { id: string; status?: { value: string } }[];
  };
  return body.data.find((m) => m.id === id)?.status?.value ?? null;
};

const until = async <T>(want: () => Promise<T | null>, ms = 20_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const got = await want().catch(() => null);
    if (got !== null) return got;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the canary");
    await new Promise((r) => setTimeout(r, 100));
  }
};

{
  const swap = fakeSwap();
  const url = await swap.url();
  const node = createNode(parseV1({
    name: "mp",
    backends: [{ name: "swap", url, kind: "llama-swap", serves: ["m"] }],
    canary: { models: { m: { intervalMs: 100 } } },
  }), silentLogger);
  node.start();
  const base = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));

  await until(async () => ((await statusOf(base, "m")) === "degraded" ? true : null));

  // The model named in the FORM is what the gate reads.
  const refused = await formPost(base, "m");
  assert.equal(refused.status, 503, "a form naming a degraded model must be refused");
  const err = refused.body.error as Record<string, unknown>;
  assert.equal(err.code, "model_degraded");
  assert.equal(err.model, "m");
  assert.equal(err.backend, "swap");
  assert.equal(swap.seen.transcriptions, 0, "and the upload never reaches the backend");

  // A form naming something else is not this model's business.
  const other = await formPost(base, "some-other-model");
  assert.notEqual(other.status, 503, "a form for another model is not refused by this gate");
  assert.equal(swap.seen.transcriptions, 1, "and does reach the backend");

  // Healed: the same form goes through, file part and all.
  swap.heal();
  await until(async () => ((await statusOf(base, "m")) !== "degraded" ? true : null));
  const before = swap.seen.transcriptions;
  const ok = await formPost(base, "m");
  assert.equal(ok.status, 200, "a working model's upload passes again");
  assert.equal(swap.seen.transcriptions, before + 1);
  assert.ok(ok.text.includes("bytes"), "with the body forwarded");

  await node.close();
  swap.s.closeAllConnections();
  swap.s.close();
}

console.log("canary-multipart-gate.test.ts ok");
