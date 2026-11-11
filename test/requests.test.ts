/**
 * `/ui/requests`: one record per finished request, with the flow path that decided it and the
 * time to its first byte, kept to a cap, looked up by id, gated as `/ui/logs` is, and saved with
 * `historyFile`.
 *
 *     npx tsx test/requests.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "../src/config/config.js";
import { silentLogger, type Logger } from "../src/observe/log.js";
import { RequestStore } from "../src/observe/requests.js";
import type { RequestTrace } from "../src/observe/uidata.js";
import { createNode } from "../src/server.js";

const trace = (id: string, t: number, more: Partial<RequestTrace> = {}): RequestTrace =>
  ({ id, t, asked: "m", model: "m", caller: "local", target: "local", ok: true, waitedMs: 0, runMs: 1, path: [], actions: [], ...more });

// --- the store: a cap, the newest record for an id, filters -------------------------------------
{
  const s = new RequestStore(3);
  for (let i = 1; i <= 4; i++) s.add(trace(`req_${i}`, i, { ok: i % 2 === 0, model: i < 3 ? "a" : "b" }));
  assert.equal(s.get("req_1"), undefined, "the oldest falls off past the cap");
  assert.equal(s.get("req_4")?.t, 4);
  s.add(trace("req_4", 5, { ok: false, model: "b" }));
  assert.equal(s.get("req_4")?.t, 5, "an id with two attempts finds the last");
  assert.deepEqual(s.list().requests.map((r) => r.t), [5, 4, 3], "newest first");
  assert.equal(s.list().oldest, 3);
  assert.deepEqual(s.list({ limit: 1 }).requests.map((r) => r.t), [5]);
  assert.deepEqual(s.list({ after: 3 }).requests.map((r) => r.t), [5, 4], "only those after `after`");
  assert.deepEqual(s.list({ ok: true }).requests.map((r) => r.t), [4]);
  assert.deepEqual(s.list({ model: "b", ok: false }).requests.map((r) => r.t), [5, 3]);
  s.restore([{ junk: true }, trace("req_0", 0)]);
  assert.deepEqual(s.all().map((r) => r.id), ["req_3", "req_4", "req_4"], "restored records are older than live ones, and junk is passed over");
}

// --- end to end: a two-flow path, first byte, a refusal, the endpoints, and the file -----------
const backend = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { stream?: boolean; model?: string };
    // A held first byte, so time to first byte is something to measure.
    setTimeout(() => {
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
        setTimeout(() => res.end("data: [DONE]\n\n"), 30);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      }
    }, 40);
  });
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const file = join(mkdtempSync(join(tmpdir(), "hearth-req-")), "history.json");
const cfgOf = (host = "127.0.0.1", historyFile: string | null = file) => parseConfig({
  listen: { host },
  backends: { main: { url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, kind: "none", serves: ["small", "big"] } },
  flows: {
    front: { inputs: ["auto"], steps: [{ when: { tokensOver: 1000 }, to: "big" }, { to: { flow: "inner" } }] },
    inner: { inputs: [], steps: [{ to: "small" }] },
  },
  ...(historyFile ? { historyFile } : {}),
});
const lines: Record<string, unknown>[] = [];
const logger: Logger = { ...silentLogger, info: (msg, fields) => { if (msg === "request") lines.push(fields ?? {}); } };

async function boot(host = "127.0.0.1", historyFile: string | null = file) {
  const node = createNode(cfgOf(host, historyFile), logger);
  node.start();
  await new Promise<void>((r) => node.server.listen(0, host, r));
  return { node, url: `http://${host}:${(node.server.address() as AddressInfo).port}` };
}

{
  const { node, url } = await boot();
  const ask = (model: string, stream = false) => fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] }),
  });
  const get = async <T>(p: string): Promise<[number, T]> => { const r = await fetch(url + p); return [r.status, (await r.json()) as T]; };

  const plain = await ask("auto");
  assert.equal(plain.status, 200);
  await plain.text();
  const id = plain.headers.get("x-request-id")!;
  const [, one] = await get<RequestTrace>(`/ui/requests/${id}`);
  assert.deepEqual([one.asked, one.model, one.target, one.backend, one.caller, one.ok], ["auto", "small", "local", "main", "local", true]);
  assert.deepEqual(one.path, [{ flow: "front", step: 1 }, { flow: "inner", step: 0 }], "the deciding step of each flow it passed through");
  assert.equal(one.router, "default", "flows: is the default rulebook");
  assert.deepEqual(one.actions, []);
  assert.ok(one.firstByteMs !== undefined && one.firstByteMs >= 35 && one.firstByteMs <= one.runMs, `a whole answer's first byte is timed (${one.firstByteMs})`);
  assert.equal(one.tokensIn, 3);
  assert.equal(Object.keys(one).some((k) => /messages|body|reply|prompt/.test(k)), false, "no body is kept");
  const line = lines.find((l) => l.id === id)!;
  assert.deepEqual(line.path, one.path, "the log line carries the path");
  assert.equal(line.router, "default");
  assert.equal(line.firstByteMs, one.firstByteMs);

  const streamed = await ask("auto", true);
  await streamed.text();
  const [, s] = await get<RequestTrace>(`/ui/requests/${streamed.headers.get("x-request-id")}`);
  assert.ok(s.firstByteMs !== undefined && s.firstByteMs >= 35 && s.firstByteMs < s.runMs, `a stream's first chunk is timed, before it ends (${s.firstByteMs} < ${s.runMs})`);

  const nope = await ask("nope");
  assert.equal(nope.status, 404);
  await nope.text();
  const [, refused] = await get<RequestTrace>(`/ui/requests/${nope.headers.get("x-request-id")}`);
  assert.deepEqual([refused.target, refused.ok, refused.model, refused.path], ["refused", false, "nope", []], "a refused request is recorded");
  assert.match(refused.error!, /no backend here serves "nope"/);

  const [, all] = await get<{ requests: RequestTrace[]; oldest: number }>("/ui/requests");
  assert.deepEqual(all.requests.map((r) => r.model), ["nope", "small", "small"], "newest first");
  assert.equal(all.oldest, all.requests.at(-1)!.t);
  assert.deepEqual((await get<{ requests: RequestTrace[] }>("/ui/requests?ok=false"))[1].requests.map((r) => r.model), ["nope"]);
  assert.deepEqual((await get<{ requests: RequestTrace[] }>("/ui/requests?model=small&limit=1"))[1].requests.map((r) => r.id), [streamed.headers.get("x-request-id")]);
  assert.deepEqual((await get<{ requests: RequestTrace[] }>("/ui/requests?model=auto&ok=true"))[1].requests.length, 2, "a model filter matches the name asked for too");
  assert.deepEqual((await get<{ requests: RequestTrace[] }>(`/ui/requests?after=${refused.t}`))[1].requests, []);
  assert.deepEqual((await get<{ requests: RequestTrace[] }>("/ui/requests?caller=someone"))[1].requests, []);
  const [missing, envelope] = await get<{ error: { message: string } }>("/ui/requests/req_nothing");
  assert.equal(missing, 404);
  assert.match(envelope.error.message, /no such request/);
  await node.close();
}

// --- saved with historyFile; a file without the section still loads ---------------------------
{
  const { node, url } = await boot();
  const got = (await (await fetch(`${url}/ui/requests`)).json()) as { requests: RequestTrace[] };
  assert.deepEqual(got.requests.map((r) => r.model), ["nope", "small", "small"], "the records survive a restart");
  assert.deepEqual(got.requests[1]!.path, [{ flow: "front", step: 1 }, { flow: "inner", step: 0 }]);
  await node.close();

  const older = join(mkdtempSync(join(tmpdir(), "hearth-req-")), "history.json");
  writeFileSync(older, JSON.stringify({ v: 1, history: { calls: [], minutes: [] }, logs: [] }));
  const b = await boot("127.0.0.1", older);
  assert.deepEqual(((await (await fetch(`${b.url}/ui/requests`)).json()) as { requests: unknown[] }).requests, [], "a file from before records were kept loads with none");
  await b.node.close();
}

// --- gated as /ui/logs is: off loopback, no session is nobody -----------------------------------
{
  const iface = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (!iface) {
    console.log("  .. skipped the off-loopback gate: no non-loopback IPv4 here");
  } else {
    const { node, url } = await boot(iface.address, null);
    for (const p of ["/ui/logs", "/ui/requests", "/ui/requests/req_x"]) {
      const r = await fetch(url + p);
      assert.equal(r.status, 403, `${p} is refused off loopback without a session`);
      await r.text();
    }
    await node.close();
  }
}

backend.closeAllConnections();
backend.close();
console.log("requests.test.ts ok");
