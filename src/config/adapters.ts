/**
 * `adapters:`: named blocks of code that sit on a route's line and reshape the request and the
 * answer. The code is compiled here, so a file with one that would never run does not load.
 */
import { checkAdapterCode } from "../routing/adapters.js";
import { asRecord, bad, only } from "./read.js";

/** `adapters.<name>`: an ES module that exports `request`, `response`, or both. */
export interface AdapterDecl {
  /** The module's source: `export function request(req) { … }`, `response(res, req)`, or both. */
  code: string;
  /** The deadline for each of `request()` and `response()`, in ms. */
  timeoutMs: number;
}

/** What `adapters.<name>.timeoutMs` may be, and what it is when unset. */
export const ADAPTER_TIMEOUT_MS = { def: 1000, max: 10_000 } as const;

const ADAPTER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `adapters:`. Code that does not compile, or exports neither side, is refused here rather than at the first request. */
export function adapterDecls(raw: unknown): Record<string, AdapterDecl> {
  const out: Record<string, AdapterDecl> = {};
  for (const [name, v] of Object.entries(asRecord(raw ?? {}, "adapters"))) {
    const at = `adapters.${name}`;
    if (!ADAPTER_NAME.test(name)) throw bad(at, "an adapter's name is lowercase letters, digits and dashes");
    const r = asRecord(v, at);
    only(r, ["code", "timeoutMs"], at);
    if (typeof r.code !== "string") throw bad(`${at}.code`, "is required: the code an adapter runs, as an ES module");
    const timeoutMs = r.timeoutMs === undefined ? ADAPTER_TIMEOUT_MS.def : r.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ADAPTER_TIMEOUT_MS.max) {
      throw bad(`${at}.timeoutMs`, `must be a whole number of ms from 1 to ${ADAPTER_TIMEOUT_MS.max}`);
    }
    try {
      checkAdapterCode(name, r.code);
    } catch (e) {
      throw bad(`${at}.code`, e instanceof Error ? e.message : String(e));
    }
    out[name] = { code: r.code, timeoutMs };
  }
  return out;
}
