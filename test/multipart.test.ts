/**
 * Multipart bodies through the passthrough: /v1/audio/transcriptions and friends.
 *
 * Found on a live node: a `curl -F file=@a.wav -F model=...` upload to
 * /v1/audio/transcriptions came back 422 from the speech server, "file: Field
 * required, model: Field required". Two separate faults stacked up:
 *
 *   1. The client's header arrives as lowercase `content-type`, and the upstream
 *      client defaulted `Content-Type` with different capitalisation. Node keys
 *      headers case-insensitively, so the JSON default silently REPLACED
 *      `multipart/form-data; boundary=...` and the backend parsed a form as JSON.
 *   2. The model was only ever read from a JSON body, so a form upload could not
 *      be routed by model, nor have an aliased id rewritten.
 *
 *     npx tsx test/multipart.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { parseV1 } from "./v1.js";
import { silentLogger } from "../src/observe/log.js";
import { createNode, type HearthNode } from "../src/server.js";
import { multipartField, replaceMultipartField } from "../src/wire/multipart.js";
import { send } from "../src/wire/upstream.js";

interface Seen { path: string; contentType: string[]; contentLength: string | undefined; body: Buffer }

/** A backend that records exactly what reached it. */
function recorder(models: string[]) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // rawHeaders keeps duplicates and original case, so a doubled header shows.
      const contentType: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]!.toLowerCase() === "content-type") contentType.push(req.rawHeaders[i + 1]!);
      }
      seen.push({
        path: req.url ?? "", contentType,
        contentLength: req.headers["content-length"], body: Buffer.concat(chunks),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "ok" }));
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
    node.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`),
    );
  });
}

/** Build a form by hand so the exact bytes are known, binary file part included. */
function form(boundary: string, model: string, file: Buffer): Buffer {
  const head = (name: string, extra = "") =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n`;
  return Buffer.concat([
    Buffer.from(head("file", '; filename="a.wav"') + "Content-Type: audio/wav\r\n\r\n"),
    file,
    Buffer.from("\r\n" + head("model") + "\r\n" + model + "\r\n"),
    Buffer.from(head("response_format") + "\r\njson\r\n"),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

// A file part that would fool a careless parser: CRLFs, a fake boundary-looking
// line, a fake `name="model"` header, and bytes that are not valid UTF-8.
const FILE = Buffer.concat([
  Buffer.from("RIFF\r\n--not-the-boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nWRONG\r\n"),
  Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x2d, 0x2d]),
]);
const BOUNDARY = "----hearthTestBoundary7MA4YWxk";

// --- the parser on its own --------------------------------------------------
{
  const ct = `multipart/form-data; boundary=${BOUNDARY}`;
  const body = form(BOUNDARY, "whisper-x", FILE);
  assert.equal(multipartField(body, ct, "model"), "whisper-x", "reads the model field");
  assert.equal(multipartField(body, ct, "response_format"), "json");
  assert.equal(multipartField(body, ct, "nope"), undefined, "an absent field is undefined");
  assert.equal(multipartField(body, "application/json", "model"), undefined, "not a form, no answer");
  assert.equal(multipartField(body, "multipart/form-data", "model"), undefined, "no boundary, no answer");
  assert.equal(multipartField(Buffer.from("garbage"), ct, "model"), undefined, "a broken form never throws");
  // Quoted boundary and extra parameters, as some clients send.
  assert.equal(
    multipartField(body, `multipart/form-data; charset=utf-8; boundary="${BOUNDARY}"`, "model"),
    "whisper-x",
  );
  // A file part named `model` is not a text field to route on.
  const filey = Buffer.from(
    `--b\r\nContent-Disposition: form-data; name="model"; filename="m.bin"\r\n\r\nX\r\n--b--\r\n`,
  );
  assert.equal(multipartField(filey, "multipart/form-data; boundary=b", "model"), undefined);

  const out = replaceMultipartField(body, ct, "model", "real-whisper")!;
  assert.equal(multipartField(out, ct, "model"), "real-whisper", "the field is rewritten");
  assert.deepEqual(out, form(BOUNDARY, "real-whisper", FILE), "and every other byte is untouched");
  assert.equal(replaceMultipartField(body, ct, "nope", "x"), undefined, "nothing to replace");
}

// --- the upstream client must not add a second Content-Type -----------------
{
  const be = recorder(["m"]);
  await be.listen();
  const up = await send(`${be.url()}/x`, {
    method: "POST", raw: Buffer.from("abc"),
    headers: { "content-type": "multipart/form-data; boundary=zz" },
  });
  await up.text();
  assert.deepEqual(be.seen.at(-1)!.contentType, ["multipart/form-data; boundary=zz"],
    "a lowercase content-type from the caller is the only one sent");

  const up2 = await send(`${be.url()}/x`, { method: "POST", raw: Buffer.from("{}") });
  await up2.text();
  assert.deepEqual(be.seen.at(-1)!.contentType, ["application/json"],
    "the JSON default still applies when the caller sent none");
  be.close();
}

// --- end to end through a node with two backends ----------------------------
const chat = recorder(["c1"]);
const stt = recorder(["real-whisper"]);
await chat.listen();
await stt.listen();

const node = createNode(
  parseV1({
    name: "mp-test",
    // `chat` is first on purpose: an unrouted form used to fall through to it.
    backends: [
      { name: "chat", url: chat.url(), kind: "single", serves: ["c1"] },
      { name: "stt", url: stt.url(), kind: "none", serves: ["real-whisper"] },
    ],
    models: { "whisper-nice": { backend: "stt", as: "real-whisper" } },
  }),
  silentLogger,
);
const url = await listen(node);

{
  // Sent with a lowercase header name, exactly as curl and node's fetch put it on the wire.
  const body = form(BOUNDARY, "real-whisper", FILE);
  const r = await fetch(`${url}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  });
  assert.equal(r.status, 200);
  assert.equal(chat.seen.length, 0, "the form is routed by its model field, not to the first backend");
  const got = stt.seen.at(-1)!;
  assert.equal(got.path, "/v1/audio/transcriptions");
  assert.deepEqual(got.contentType, [`multipart/form-data; boundary=${BOUNDARY}`],
    "exactly one Content-Type reaches the backend, and it is the form's");
  assert.deepEqual(got.body, body, "the body is forwarded byte for byte, binary file part included");
  assert.equal(got.contentLength, String(body.length));
}

{
  // An aliased id in a form is rewritten, like it is in a JSON body.
  const body = form(BOUNDARY, "whisper-nice", FILE);
  const r = await fetch(`${url}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  });
  assert.equal(r.status, 200);
  assert.equal(chat.seen.length, 0);
  const got = stt.seen.at(-1)!;
  const want = form(BOUNDARY, "real-whisper", FILE);
  assert.deepEqual(got.body, want, "only the model field changes; the file bytes do not");
  assert.equal(got.contentLength, String(want.length), "and Content-Length matches the new body");
}

{
  // JSON passthrough is unchanged.
  const r = await fetch(`${url}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "whisper-nice", input: "hi" }),
  });
  assert.equal(r.status, 200);
  const got = stt.seen.at(-1)!;
  assert.deepEqual(got.contentType, ["application/json"]);
  assert.equal((JSON.parse(got.body.toString()) as { model: string }).model, "real-whisper");
}

await node.close();
chat.close();
stt.close();
console.log("multipart.test.ts ok");
