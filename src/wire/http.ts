/**
 * HTTP building blocks every route shares: reading a body, answering in OpenAI's error envelope,
 * relaying an upstream answer, and the header rules for crossing a proxy hop. No node state.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { createHash, timingSafeEqual } from "node:crypto";

import { BodyTooLargeError, Refusal, refusalOf } from "../errors.js";
import type { RelayWatch } from "../observe/canary.js";
import { streamErrorFrame } from "./emulate.js";
import type { UpstreamResponse } from "./upstream.js";

/** Constant-time compare over sha256 digests, so neither length nor content leaks. */
export function secretEq(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

/** Stable, non-reversible id for an api key. Safe for logs and /queue. */
export function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization;
  if (typeof h !== "string") return "";
  return h.replace(/^Bearer\s+/i, "").trim();
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** OpenAI's error envelope, since that's what clients parse. Extra fields ride beside `type`. */
export function apiError(
  res: ServerResponse,
  status: number,
  message: string,
  type = "invalid_request_error",
  extra?: Record<string, unknown>,
): void {
  json(res, status, { error: { message, type, ...extra } });
}

/** The refusal's shape: OpenAI's envelope on /v1, plain `{error}` elsewhere. */
export type Envelope = "plain" | "openai";

export function refuse(res: ServerResponse, status: number, msg: string, env: Envelope): void {
  if (env === "openai") apiError(res, status, msg, status === 401 ? "authentication_error" : "permission_error");
  else json(res, status, { error: msg });
}

/** Thrown, not returned, so the caller can answer 413 rather than the 400 an
 *  unparseable body would otherwise get. */
export function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        // Don't destroy the socket here. It races the response, and the client
        // sees a connection reset instead of a status, which looks like a crash.
        // Pausing is enough to stop us buffering while the caller writes 413.
        req.pause();
        reject(new BodyTooLargeError(limitBytes));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The JSON body: 413 over `limitBytes`, 400 when not a JSON object. */
export async function readJson(req: IncomingMessage, limitBytes: number): Promise<Record<string, unknown>> {
  const raw = await readBody(req, limitBytes);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString());
  } catch (e) {
    throw new Refusal(400, `body was not JSON: ${String(e)}`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Refusal(400, "body must be a JSON object");
  return body as Record<string, unknown>;
}

/** Answer any failure with its status, or end a response already under way. */
export function fail(res: ServerResponse, e: unknown): void {
  if (res.headersSent) {
    // A stream opened early for queue position carries the failure in-band; a 200 cannot be taken back.
    const early = String(res.getHeader("Content-Type") ?? "").includes("text/event-stream");
    if (early && !res.writableEnded) {
      const r = refusalOf(e);
      res.end(streamErrorFrame(r.status, r.message));
    } else res.end();
    return;
  }
  const r = refusalOf(e);
  // The rest of an oversized body is never read, so the connection cannot be reused.
  if (e instanceof BodyTooLargeError) res.setHeader("Connection", "close");
  apiError(res, r.status, r.message, r.type, r.extra ?? undefined);
}

/** Connection-level headers that cannot cross a proxy hop; Content-Length is left to the runtime. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

export function forwardable(
  headers: IncomingMessage["headers"] | UpstreamResponse["headers"],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    // Cookies belong to this node's own origin: a backend is neither shown the operator's session nor able to set one.
    if (v === undefined || HOP_BY_HOP.has(name) || name === "cookie" || name === "set-cookie") continue;
    out[k] = v;
  }
  return out;
}

/** An upstream's answer headers for relaying: its own request id gives way to the one this node gave the request. */
export function relayable(up: UpstreamResponse): Record<string, string | string[]> {
  const { "x-request-id": _theirs, ...rest } = forwardable(up.headers);
  return rest;
}

/** Said to a caller whose own key was fine: a 401 passed on from the backend would read as this node refusing them. */
export const KEY_REFUSED = "the backend refused the key this node sends it; the key you sent this node was accepted";
export const refusedKey = (status: number): boolean => status === 401 || status === 403;

/**
 * Relay an upstream answer verbatim, all headers included, and return its status: a backend's 4xx
 * reaches the client but is not a success. `pipeline` settles even if the client disconnects.
 *
 * `watch`, when given, sees each chunk on its way past and is never allowed to
 * delay, alter or hold one: the transform writes the same buffer straight on.
 */
export async function pipeThrough(up: UpstreamResponse, res: ServerResponse, watch?: RelayWatch): Promise<number> {
  if (res.headersSent) {
    // Opened early for queue position: the status cannot change now, so a failure is a frame.
    if (up.status >= 400) {
      res.end(streamErrorFrame(up.status, await up.text()));
      return up.status;
    }
  } else {
    res.writeHead(up.status, {
      ...relayable(up),
      // Ours, not a peer's own id for it: the name this node knows the model by.
      ...(res.hasHeader("x-hearth-model") ? { "x-hearth-model": String(res.getHeader("x-hearth-model")) } : {}),
      "Content-Type": up.headers["content-type"] ?? "application/json",
      // Tell any proxy in front not to buffer, or a streamed answer arrives all
      // at once at the end and looks like a hang.
      "X-Accel-Buffering": "no",
    });
  }
  if (watch === undefined) {
    await pipeline(up.body, res);
  } else {
    await pipeline(up.body, watch.through(), res);
    watch.end();
  }
  return up.status;
}

/** Open a server-sent event stream. */
export function openEventStream(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
}

/** One server-sent event. Backpressure is ignored: a slow reader loses freshness, never buffers memory. */
export function writeEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

/** A request's headers as a flow reads them: one value per lower-case name, the first where a name was sent twice. */
export const headersOf = (req: IncomingMessage): Record<string, string> =>
  Object.fromEntries(Object.entries(req.headers).flatMap(([k, v]) => { const one = Array.isArray(v) ? v[0] : v; return typeof one === "string" ? [[k.toLowerCase(), one]] : []; }));

/** The caller's own id for this request (`X-Hearth-Job`), so its updates on /queue/events can be matched; ignored if malformed. */
export function jobId(req: IncomingMessage): string | undefined {
  const v = req.headers["x-hearth-job"];
  return typeof v === "string" && /^[\w.:-]{1,128}$/.test(v) ? v : undefined;
}
