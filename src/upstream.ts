/**
 * HTTP client for backends and peers, on node:http rather than fetch: undici's 300s
 * headersTimeout cannot be raised per request, and inference sends no headers until it starts.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export interface UpstreamResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Raw body chunks. Async-iterable: `for await (const chunk of body)`. */
  body: IncomingMessage;
  /** Drain the body to a string, capped at `maxBytes`; error and control-plane paths only. */
  text: (maxBytes?: number) => Promise<string>;
}

/** The most of a buffered body we hold, so a peer's oversized reply costs bounded memory. */
const MAX_TEXT_BYTES = 1 << 20;

export class UpstreamError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
    /** Set when the failure was an actual response rather than a transport
     *  fault, so a caller can tell "you're asking too often" apart from "you're
     *  unreachable". Those want very different responses. */
    public readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON-serialized as the body. Omit for GET. */
  json?: unknown;
  /** Raw body, forwarded byte-for-byte, for proxying a request we didn't build
   *  and shouldn't be reinterpreting. Ignored if `json` is set. */
  raw?: Buffer;
  signal?: AbortSignal;
  /** Deadline for response headers only, in ms. Omit for inference; peer polls set a short one. */
  headersTimeoutMs?: number;
  /** Total deadline for `getJson`, body included. Defaults to 2x the headers
   *  timeout. Does nothing in `send`, which is for streams. */
  totalTimeoutMs?: number;
}

/** Fire a request, hand back the response as soon as headers land, don't touch
 *  the body. */
export function send(url: string, opts: RequestOptions = {}): Promise<UpstreamResponse> {
  const secure = url.startsWith("https://");
  if (!secure && !url.startsWith("http://")) {
    return Promise.reject(new UpstreamError(`unsupported url: ${url}`));
  }
  const doRequest = secure ? httpsRequest : httpRequest;

  return new Promise<UpstreamResponse>((resolve, reject) => {
    const body =
      opts.json !== undefined
        ? Buffer.from(JSON.stringify(opts.json))
        : (opts.raw ?? null);

    const headers: Record<string, string> = { ...opts.headers };
    if (body) {
      headers["Content-Type"] ??= "application/json";
      headers["Content-Length"] = String(body.length);
    }

    let settled = false;
    /** Single exit for every failure, so a headers timeout always settles the promise. */
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      req.destroy();
      reject(e);
    };

    const req = doRequest(url, { method: opts.method ?? (body ? "POST" : "GET"), headers }, (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      const status = res.statusCode ?? 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: res.headers,
        body: res,
        text: (maxBytes = MAX_TEXT_BYTES) =>
          new Promise<string>((done) => {
            const chunks: Buffer[] = [];
            let size = 0;
            let stopped = false;
            const finish = () => {
              if (stopped) return;
              stopped = true;
              done(Buffer.concat(chunks).toString());
            };
            res.on("data", (c: Buffer) => {
              if (stopped) return;
              size += c.length;
              if (size > maxBytes) {
                // Whatever we have is enough to report with, and reading the
                // rest only costs memory. Destroying the socket rather than
                // pausing: nobody is going to read this body afterwards.
                res.destroy();
                finish();
                return;
              }
              chunks.push(c);
            });
            res.on("end", finish);
            // Resolve, don't reject. We're already on the error path and the
            // caller wants whatever detail we managed to read, not a second
            // failure on top.
            res.on("error", finish);
          }),
      });
    });

    // Opt-in, and headers only. Once the body starts flowing there's no
    // deadline at all, which is what you want for a long generation.
    const headerTimer =
      opts.headersTimeoutMs != null
        ? setTimeout(
            () => fail(new UpstreamError(`no response headers in ${opts.headersTimeoutMs}ms`)),
            opts.headersTimeoutMs,
          )
        : undefined;

    req.on("error", (e) =>
      fail(e instanceof UpstreamError ? e : new UpstreamError(String(e), e)),
    );

    /**
     * Abort from either side. Destroying the request also stops a generation whose client hung
     * up mid-stream, instead of it holding a slot to the end.
     */
    const abort = () => {
      if (settled) {
        req.destroy(new UpstreamError("aborted"));
        return;
      }
      fail(new UpstreamError("aborted"));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        abort();
        return;
      }
      opts.signal.addEventListener("abort", abort, { once: true });
      req.on("close", () => opts.signal?.removeEventListener("abort", abort));
    }

    req.end(body ?? undefined);
  });
}

/**
 * Request and parse JSON, for control-plane calls only; never a generation. Has a total
 * deadline, so a peer that stalls mid-body still fails.
 */
export async function getJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const totalMs = opts.totalTimeoutMs ?? (opts.headersTimeoutMs ?? 10_000) * 2;
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), totalMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, own.signal])
    : own.signal;

  try {
    return await readJson<T>(url, { ...opts, signal }, totalMs);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson<T>(url: string, opts: RequestOptions, totalMs: number): Promise<T> {
  const res = await send(url, opts);
  const text = await res.text();
  if (opts.signal?.aborted) {
    throw new UpstreamError(`${url} did not finish a response body in ${totalMs}ms`);
  }
  if (!res.ok) {
    throw new UpstreamError(
      `${url} returned ${res.status}: ${text.slice(0, 200)}`,
      undefined,
      res.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(`${url} did not return JSON: ${text.slice(0, 200)}`);
  }
}
