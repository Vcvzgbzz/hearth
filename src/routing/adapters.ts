/**
 * The adapter contract: what a `trust: code` plugin's `setup` returns as `adapt`, and the check that
 * what its `request()` and `response()` hand back is a shape a line can send and answer with. A
 * routing line names the plugin with `adapt:`; the plugin itself loads like any other code plugin.
 */

/** A request as an adapter sees it: relative to the target plugin's root, and never with the caller's credentials. */
export interface AdapterRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  contentType: string | null;
  /** UTF-8 text. A body that is not text is null, and an adapter that sets no body leaves it as it was. */
  body: string | null;
}

/** An answer as an adapter sees it, and the shape a `response()` may return in place of it. */
export interface AdapterAnswer {
  status: number;
  contentType: string | null;
  body: string;
}

/** What a plugin another line names with `adapt:` returns from its `setup`: the two sides of one translation. */
export interface Adapter {
  /** The request on the target's API, as only the fields it changes; null when this line has no counterpart for it. */
  request(req: AdapterRequest): Partial<AdapterRequest> | null | Promise<Partial<AdapterRequest> | null>;
  /** The target's 2xx answer, reshaped into the shape the caller asked for. */
  response(res: AdapterAnswer, req: AdapterRequest): Partial<AdapterAnswer> | Promise<Partial<AdapterAnswer>>;
}

/** An adapter as one line uses it: named, so a failure can name it, and both sides held to its plugin's `timeoutMs`. */
export interface LineAdapter {
  readonly name: string;
  request(req: AdapterRequest): Promise<Partial<AdapterRequest> | null>;
  response(res: AdapterAnswer, req: AdapterRequest): Promise<Partial<AdapterAnswer>>;
}

/**
 * How one call through an adapter went, as the console remembers it: only the last one, in memory,
 * because that is what a map can light a block with.
 */
export interface AdapterCall {
  /** When it ended, in ms since the epoch. */
  t: number;
  /** Which of the two sides ran. */
  side: "request" | "response";
  /** The code ran and gave an answer. A `null` from `request()` is an answer: this line has no counterpart. */
  ok: boolean;
  /** Why it failed, as the code or its deadline said. */
  error?: string;
  /** The plugin the line sent the request to. */
  plugin?: string;
}

function objectOf(what: unknown, at: string): Record<string, unknown> {
  if (typeof what !== "object" || what === null || Array.isArray(what)) throw new Error(`${at} returned ${what === null ? "null" : typeof what}, not an object`);
  return what as Record<string, unknown>;
}

const text = (v: unknown, at: string): string => (typeof v === "string" ? v : (() => { throw new Error(`${at} is not a string`); })());
const maybeText = (v: unknown, at: string): string | null => (v === null ? null : text(v, at));

function queryOf(v: unknown, at: string): Record<string, string> {
  const o = objectOf(v, at);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) out[k] = text(x, `${at}.${k}`);
  return out;
}

/** What a `request()` returned, with only the fields it may set. */
export function requestOf(what: unknown, at: string): Partial<AdapterRequest> | null {
  if (what === null) return null;
  const o = objectOf(what, at);
  const out: Partial<AdapterRequest> = {};
  if (o.method !== undefined) out.method = text(o.method, `${at} method`);
  if (o.path !== undefined) out.path = text(o.path, `${at} path`);
  if (o.query !== undefined) out.query = queryOf(o.query, `${at} query`);
  if (o.contentType !== undefined) out.contentType = maybeText(o.contentType, `${at} contentType`);
  if (o.body !== undefined) out.body = maybeText(o.body, `${at} body`);
  return out;
}

/** What a `response()` returned, with only the fields it may set. */
export function answerOf(what: unknown, at: string): Partial<AdapterAnswer> {
  const o = objectOf(what, at);
  const out: Partial<AdapterAnswer> = {};
  if (o.status !== undefined) {
    const status = o.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) throw new Error(`${at} status is not an HTTP status`);
    out.status = status;
  }
  if (o.contentType !== undefined) out.contentType = maybeText(o.contentType, `${at} contentType`);
  if (o.body !== undefined) out.body = text(o.body, `${at} body`);
  return out;
}
