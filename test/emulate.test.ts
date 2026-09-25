/**
 * Self-check for `models.<id>.emulate: llama-server` — a vLLM-style backend's answers reshaped
 * into llama-server's, and a route without it left byte-for-byte alone.
 *
 *     npx tsx test/emulate.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { ConfigError, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode, type HearthNode } from "../src/server.js";

const USAGE = { prompt_tokens: 100, completion_tokens: 11, total_tokens: 111, prompt_tokens_details: { cached_tokens: 60 } };

/** Answers the way vLLM does: `reasoning`, no `timings`, usage only when asked for. */
function vllmBackend() {
  const seen: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "vm" }, { id: "plain" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      seen.push(body);
      if (body.stream !== true) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", reasoning: "hmm", content: "391" } }], usage: USAGE }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      const wire = Buffer.from(
        frame({ choices: [{ delta: { reasoning: "thinking" } }] }) +
          frame({ choices: [{ delta: { content: "naïve ✓" } }] }) +
          ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage
            ? frame({ choices: [], usage: USAGE })
            : "") +
          "data: [DONE]\n\n",
      );
      // Split inside the multi-byte characters so a naive per-chunk decode would mangle them.
      const cut = wire.indexOf(Buffer.from("✓")) + 1;
      res.write(wire.subarray(0, cut));
      await new Promise((r) => setTimeout(r, 30));
      res.end(wire.subarray(cut));
    });
  });
  return {
    seen,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    listen: () => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

function listen(node: HearthNode): Promise<string> {
  return new Promise((ready) => {
    node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`));
  });
}

async function chat(url: string, body: Record<string, unknown>) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function events(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(5)) as Record<string, unknown>);
}

const be = vllmBackend();
await be.listen();
const node = createNode(
  parseConfig({
    name: "me",
    backends: [{ name: "v", url: be.url(), kind: "none" }],
    models: { vm: { backend: "v", emulate: "llama-server" }, plain: { backend: "v" } },
  }),
  silentLogger,
);
const url = await listen(node);
await node.pool.first().state.refresh();

// --- config: only known emulations parse ------------------------------------
{
  const base = { name: "x", backend: { url: be.url() } };
  assert.throws(() => parseConfig({ ...base, models: { m: { emulate: "ollama" } } }), ConfigError);
  assert.equal(parseConfig({ ...base, models: { m: {} } }).models.m!.emulate, null);
}

// --- non-streamed: reasoning renamed, timings rebuilt from usage --------------
{
  const r = await chat(url, { model: "vm", messages: [{ role: "user", content: "hi" }] });
  const j = (await r.json()) as { choices: { message: Record<string, unknown> }[]; timings: Record<string, number> };
  assert.equal(j.choices[0]!.message.reasoning_content, "hmm");
  assert.equal(j.choices[0]!.message.reasoning, undefined);
  assert.equal(j.timings.prompt_n, 40, "uncached prompt tokens");
  assert.equal(j.timings.cache_n, 60);
  assert.equal(j.timings.predicted_n, 11);
}

// --- streamed: usage requested, deltas renamed, timings on the usage chunk ---
{
  const r = await chat(url, { model: "vm", stream: true, messages: [{ role: "user", content: "hi" }] });
  const ev = events(await r.text());
  assert.deepEqual(be.seen.at(-1)!.stream_options, { include_usage: true }, "hearth asks for the usage chunk");
  const deltas = ev.flatMap((e) => (e.choices as { delta: Record<string, unknown> }[]).map((c) => c.delta));
  assert.equal(deltas[0]!.reasoning_content, "thinking");
  assert.equal(deltas[0]!.reasoning, undefined);
  assert.equal(deltas[1]!.content, "naïve ✓", "a character split across reads survives");
  const t = ev.find((e) => e.timings)!.timings as Record<string, number>;
  assert.equal(t.predicted_n, 11);
  assert.equal(t.cache_n, 60);
  assert.ok((t.predicted_ms ?? 0) >= 25, "generation time spans first to last token");
}

// --- a route without emulate is relayed untouched ----------------------------
{
  const r = await chat(url, { model: "plain", stream: true, messages: [{ role: "user", content: "hi" }] });
  const text = await r.text();
  assert.equal(be.seen.at(-1)!.stream_options, undefined, "nothing added to the request");
  assert.ok(text.includes('"reasoning":"thinking"') && !text.includes("timings"));
}

await node.close();
be.close();
console.log("emulate.test.ts ok");
