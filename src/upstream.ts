/**
 * HTTP client for talking to a backend or a peer.
 *
 * Not `fetch`, and that's the important thing about this file. Node's fetch
 * (undici) enforces a 300s headersTimeout measured to the first response
 * header, and an inference server sends nothing at all until it starts
 * generating. A cold model load, a queue on the far side, or just a slow peer
 * blows straight past it. You get "TypeError: fetch failed" while the timeout
 * you actually configured never fires.
 *
 * You can't raise headersTimeout per-request, so there's no fixing it from the
 * outside. Hence node:http, where nothing times out unless the caller says so.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export interface UpstreamResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Raw body chunks. Async-iterable: `for await (const chunk of body)`. */
  body: IncomingMessage;
  /** Drain the whole body to a string. Error path only, where there's nothing
   *  worth streaming and you just want to see what upstream complained about. */
  text: () => Promise<string>;
}

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
  /**
   * Deadline for the response headers only, in ms. Omit it for inference, where
   * the honest answer is "however long it takes". Peer polling sets a short one:
   * a peer that can't answer a capacity check in a couple of seconds is one to
   * route around, not wait for.
   */
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
    /**
     * Single exit for every failure.
     *
     * Worth keeping it that way. The first version set the flag and destroyed
     * the request, assuming the 'error' handler would reject. But that handler
     * bails on an already-settled request, so a headers timeout killed the
     * socket and left the promise pending forever.
     */
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
        text: () =>
          new Promise<string>((done) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => done(Buffer.concat(chunks).toString()));
            // Resolve, don't reject. We're already on the error path and the
            // caller wants whatever detail we managed to read, not a second
            // failure on top.
            res.on("error", () => done(Buffer.concat(chunks).toString()));
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
     * Abort, from either half of the request.
     *
     * `fail` alone isn't enough: `settled` flips the moment headers land, so it
     * does nothing for the common case of a client hanging up mid-stream. That
     * used to mean the generation just kept going into a dead socket, holding a
     * scheduler slot for its full length. I measured 4.6s of wasted GPU past the
     * disconnect on a 3B. On a 27B it's about a minute per cancelled request.
     *
     * Destroying the request makes the response stream emit an error, so a
     * `for await` over the body throws and the caller unwinds on its own.
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
 * Request and parse JSON. This buffers, so it's for control-plane calls only.
 * Never point it at a generation.
 *
 * It has a total deadline, unlike `send`. headersTimeoutMs only covers the
 * handshake, so a peer that answered `200 {` and then went quiet left the
 * promise pending forever. Every poll tick leaked another socket and buffer,
 * and since none of them ever settled, `consecutiveFailures` stayed at zero and
 * the poller never worked out the peer was down.
 *
 * The buffering is fine here because every caller wants a small JSON body
 * quickly or not at all.
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
