/**
 * What a plugin's token and service may reach, what happens when a service or a warm read is
 * briefly away, a peer that goes silent mid-answer, and a burst of wrong passwords.
 *
 *     npx tsx test/hardening.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { BackendState } from "../src/queue/backend.js";
import { parseConfig } from "../src/config/config.js";
import { silentLogger } from "../src/observe/log.js";
import { hashPassword } from "../src/access/login.js";
import { createNode } from "../src/server.js";

const listen = async (s: Server, port = 0): Promise<string> => {
  await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const jsonOf = (rs: ServerResponse, body: unknown) => rs.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
const freePort = async (): Promise<number> => {
  const s = createServer();
  await listen(s);
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
};

let running = true;
const backend = createServer(async (rq, rs) => {
  for await (const _ of rq) void _;
  if (rq.url === "/running") {
    if (!running) return rs.writeHead(500).end();
    return jsonOf(rs, { running: [{ model: "m", state: "ready" }] });
  }
  if (rq.url === "/v1/models") return jsonOf(rs, { data: [{ id: "m" }] });
  if (rq.url === "/v1/chat/completions") return jsonOf(rs, { choices: [{ message: { role: "assistant", content: "hi" } }] });
  if (rq.url === "/v1/embeddings") return jsonOf(rs, { data: [] });
  rs.writeHead(404).end();
});
const backendUrl = await listen(backend);

// --- a warm read that fails keeps the list for a while, then lets go ------------
{
  const st = new BackendState(backendUrl, "llama-swap", silentLogger);
  await st.refresh();
  assert.deepEqual(st.loaded(), ["m"]);
  running = false;
  await st.refresh();
  assert.deepEqual(st.loaded(), ["m"], "one failed read must not empty the card, or a neighbour loads on top");
  const real = Date.now;
  Date.now = () => real() + 61_000;
  await st.refresh();
  Date.now = real;
  assert.deepEqual(st.loaded(), [], "a backend that stays unreadable must not hold its card for good");
  running = true;
}

// --- a service plugin that comes up after hearth ---------------------------------
{
  const hooks: { request: { headers?: Record<string, string> }; internal: { token: string } }[] = [];
  const service = createServer(async (rq, rs) => {
    let raw = "";
    for await (const c of rq) raw += c;
    if (rq.url === "/manifest") return jsonOf(rs, { apiVersion: 1, kinds: { chat: ["routed"] } });
    hooks.push(JSON.parse(raw));
    jsonOf(rs, {});
  });
  const servicePort = await freePort();
  const node = createNode(parseConfig({
    name: "n",
    backends: { main: { url: backendUrl, kind: "llama-swap", serves: ["m"] } },
    models: { m: { backend: "main" } },
    flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } },
    apiKeys: [{ key: "k-app", label: "app" }],
    plugins: { memory: { use: `http://127.0.0.1:${servicePort}/`, trust: "http", reads: ["headers"], everyLine: true } },
  }), silentLogger);
  await node.startPlugins();
  const url = await listen(node.server);
  try {
    const healthz = async () => (await fetch(`${url}/healthz`)).json() as Promise<{ ok: boolean; degraded: boolean; plugins: { total: number; failed: number } }>;
    assert.equal(node.plugins.status()[0]!.state, "failed");
    const before = await healthz();
    assert.deepEqual([before.ok, before.degraded, before.plugins], [true, true, { total: 1, failed: 1 }], "a plugin that did not start shows on /healthz");

    await listen(service, servicePort);
    await node.plugins.retryFailed();
    assert.equal(node.plugins.status()[0]!.state, "running", "a service that was late is picked up without a restart");
    assert.equal(node.plugins.status()[0]!.error, null);
    assert.equal((await healthz()).degraded, false);

    const chat = await fetch(`${url}/v1/chat/completions`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer k-app", Cookie: "c=1", "X-Api-Key": "s", "X-Project": "p" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(chat.status, 200);
    await chat.text();
    const hook = hooks.at(-1)!;
    assert.equal(hook.request.headers!["x-project"], "p", "`reads: headers` still sends the headers");
    for (const h of ["authorization", "cookie", "x-api-key"]) assert.equal(hook.request.headers![h], undefined, `${h} stays on this node`);

    const auth = { Authorization: `Bearer ${hook.internal.token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(`${url}/v1/models`, { headers: auth })).status, 200, "a plugin's token reaches model routes");
    const embed = await fetch(`${url}/v1/embeddings`, { method: "POST", headers: auth, body: JSON.stringify({ model: "m", input: "x" }) });
    assert.equal(embed.status, 200, "and the passthrough under /v1, for an embedding slot");
    for (const [path, method] of [["/config", "GET"], ["/config", "PATCH"], ["/keys/mint", "POST"], ["/control", "POST"], ["/v1/evict", "POST"], ["/usage", "GET"]] as const) {
      assert.equal((await fetch(url + path, { method, headers: auth, ...(method === "GET" ? {} : { body: "{}" }) })).status, 403, `${method} ${path} is closed to a plugin's token`);
    }
  } finally {
    await node.close();
    service.close();
  }
}

// --- a peer that starts an answer and goes silent is cut --------------------------
{
  const peer = createServer((rq, rs) => {
    if (rq.url === "/peer/state" || rq.url === "/peer/hello") {
      return jsonOf(rs, { free: 1, slots: 1, queued: {}, resident: null, loaded: ["theirs"], serves: ["theirs"], models: { theirs: { free: 1, slots: 1, queued: 0, warm: true } } });
    }
    rs.writeHead(200, { "Content-Type": "text/event-stream" });
    rs.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  });
  const node = createNode(parseConfig({
    name: "n",
    backends: { card: { url: "http://127.0.0.1:1", kind: "none", serves: ["here"] } },
    backendDefaults: { idleMs: 200 },
    peers: { a: { url: await listen(peer), token: "t", models: { chat: "theirs" } } },
    flows: { chat: { inputs: ["chat"], steps: [{ to: { peer: "a" } }, { to: { refuse: "no peer" } }] } },
  }), silentLogger);
  const url = await listen(node.server);
  try {
    const res = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "chat", stream: true, messages: [{ role: "user", content: "hi" }] }), signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 200, "the answer has to start, or this says nothing about a stall");
    const ended = await res.text().then(() => "closed", (e: Error) => (e.name === "TimeoutError" ? "hung" : "closed"));
    assert.equal(ended, "closed", "a stalled peer stream must end, as a stalled backend's does");
  } finally {
    await node.close();
    peer.closeAllConnections();
    peer.close();
  }
}

// --- a parallel burst of wrong passwords is held to the limit ---------------------
{
  const node = createNode(parseConfig({
    name: "n",
    backends: { card: { url: "http://127.0.0.1:1", kind: "none", serves: ["m"] } },
    operator: { user: "op", passHash: await hashPassword("right-horse") },
  }), silentLogger);
  const url = await listen(node.server);
  try {
    const guess = () => fetch(`${url}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: "op", pass: "wrong" }) }).then((r) => r.status);
    const got = await Promise.all(Array.from({ length: 30 }, guess));
    assert.equal(got.filter((s) => s === 401).length, 10, "only the limit reach scrypt, however many arrive at once");
    assert.equal(got.filter((s) => s === 429).length, 20);
  } finally {
    await node.close();
  }
}

backend.close();
console.log("hardening.test.ts ok");
