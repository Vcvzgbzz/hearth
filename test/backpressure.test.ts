/**
 * A client that hangs up while the response is backpressured shouldn't take the
 * whole node with it.
 *
 * This one was invisible for a while. hearth forwarded the body with a loop
 * that awaited 'drain' whenever write() returned false, and if the client
 * vanished at exactly that moment 'drain' never fired. The loop sat on that
 * promise rather than on the body iterator, so aborting the upstream didn't
 * unstick it either. run() never settled and the scheduler slot never came
 * back. At the default concurrency of 1 that wedges the node for everyone,
 * permanently, without a word in the log.
 *
 * The last assertion is the one that matters: a request after the disconnect
 * still gets served. That hangs forever against the old code, so it races a
 * deadline instead of trusting the runner to notice.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

/** Far more than any socket buffer holds, so the far side is definitely
 *  mid-backpressure when we cut it off. */
const FLOOD_CHUNKS = 64;
const CHUNK = Buffer.alloc(1 << 20, 0x61); // 1 MiB

const backend = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "flood" }, { id: "small" }] }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { model?: string };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (body.model !== "flood") {
      res.end('data: {"ok":true}\n\ndata: [DONE]\n\n');
      return;
    }
    // Ignoring our own backpressure on purpose. We want hearth's reader fed
    // faster than its writer can drain to the client.
    for (let i = 0; i < FLOOD_CHUNKS; i++) res.write(CHUNK);
    res.end();
  });
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const node = createNode(
  parseConfig({
    name: "wedge-test",
    backend: { url: backendUrl, llamaSwapExtras: false },
    scheduler: { concurrency: 1 },
  }),
  silentLogger,
);
node.start();
const port = await new Promise<number>((ready) =>
  node.server.listen(0, "127.0.0.1", () => ready((node.server.address() as AddressInfo).port)),
);

/**
 * Raw socket, because we need a client that reads nothing at all.
 *
 * fetch() and friends drain the body as fast as it shows up, which is the one
 * case that never backpressures. No 'data' listener here, so the socket stays
 * paused, the kernel buffer fills, and hearth's write() starts returning false.
 */
function deadWeightClient(): Promise<void> {
  return new Promise((done) => {
    const sock = connect(port, "127.0.0.1", () => {
      const body = JSON.stringify({ model: "flood", messages: [] });
      sock.write(
        `POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      // Long enough for the flood to land and the writer to stall.
      setTimeout(() => {
        sock.destroy();
        done();
      }, 500);
    });
    sock.on("error", () => done());
  });
}

// --- the wedge -------------------------------------------------------------
{
  await deadWeightClient();

  // Let the disconnect unwind through the scheduler.
  await new Promise((r) => setTimeout(r, 200));

  const capacity = node.pool.first().scheduler.capacity();
  assert.equal(
    capacity.free,
    1,
    `the slot was never released: ${capacity.running} job(s) still running after the client vanished`,
  );
}

// --- and the node still works ----------------------------------------------
//
// The real claim. Never resolves against the old code, hence the race.
{
  const served = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "small", messages: [] }),
  }).then((r) => r.text());

  const result = await Promise.race([
    served,
    new Promise<"WEDGED">((r) => setTimeout(() => r("WEDGED"), 3_000)),
  ]);

  assert.notEqual(result, "WEDGED", "the node stopped serving after one client hung up mid-stream");
  assert.match(result as string, /"ok":true/);
}

await node.close();
backend.closeAllConnections();
backend.close();
console.log("backpressure.test.ts ok");
