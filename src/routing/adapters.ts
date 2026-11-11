/**
 * The adapter sandbox: the code a flow line's `adapt:` names, run where it can do nothing but
 * reshape one request or one answer.
 *
 * The engine is hearth's own interpreter (`routing/adapter/`): the code runs in a language with no
 * way to reach the network, the disk, the environment or this process, and every call is held to a
 * deadline and to a memory budget from inside the interpreter's own loop. `Adapters` keeps the
 * compiled modules the live config names, recompiled when a name's code changes, so an edit takes
 * effect without a restart.
 */
import type { AdapterDecl } from "../config/adapters.js";
import type { HearthConfig } from "../config/config.js";
import { type AdapterModule, type Side, call, compile } from "./adapter/index.js";
import { LIMITS } from "./adapter/machine.js";

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

/** The heap one adapter call may use. */
export const ADAPTER_MEMORY_BYTES = LIMITS.heap;

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
function requestOf(what: unknown, at: string): Partial<AdapterRequest> | null {
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
function answerOf(what: unknown, at: string): Partial<AdapterAnswer> {
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

/** One adapter, as its config names it. Each side is held to `timeoutMs`. */
export class Adapter {
  private module: AdapterModule | null = null;
  /** Calls run one at a time, so one adapter's deadline is its own and not the request's. */
  private serial: Promise<unknown> = Promise.resolve();
  /** Calls running now, so a module is not dropped under one. */
  private busy = 0;
  private retired = false;

  constructor(
    readonly name: string,
    private readonly code: string,
    readonly timeoutMs: number,
  ) {}

  /** The request as the target should get it, or null when this line has no counterpart for it. An unexported side passes it through. */
  async request(req: AdapterRequest): Promise<Partial<AdapterRequest> | null> {
    const out = await this.run("request", [req]).catch((e: unknown) => {
      throw this.plain("request", e);
    });
    return out === undefined ? {} : requestOf(out, `adapter ${this.name} request()`);
  }

  /** The target's 2xx answer, reshaped into the shape the caller asked for. An unexported side passes it through. */
  async response(res: AdapterAnswer, req: AdapterRequest): Promise<Partial<AdapterAnswer>> {
    const out = await this.run("response", [res, req]).catch((e: unknown) => {
      throw this.plain("response", e);
    });
    return out === undefined ? {} : answerOf(out, `adapter ${this.name} response()`);
  }

  /**
   * The interpreter's message without its own `adapter <name> <side>(): ` prefix: the caller of an
   * adapter already names the adapter and the side in the sentence it reports the failure with.
   */
  private plain(side: Side, e: unknown): Error {
    if (!(e instanceof Error)) return new Error(String(e));
    const prefix = `adapter ${this.name} ${side}(): `;
    return e.message.startsWith(prefix) ? new Error(e.message.slice(prefix.length)) : e;
  }

  /** Let it be dropped: its module goes now when it has no call running, and when the last one ends otherwise. */
  close(): void {
    this.retired = true;
    if (this.busy === 0) this.module = null;
  }

  private run(side: Side, args: readonly unknown[]): Promise<unknown> {
    const done = this.serial.then(() => {
      this.busy += 1;
      try {
        const module = this.module ?? (this.module = compile(this.name, this.code));
        return call(module, side, args, this.timeoutMs);
      } finally {
        this.busy -= 1;
        if (this.retired && this.busy === 0) this.module = null;
      }
    });
    this.serial = done.then(() => undefined, () => undefined);
    return done;
  }
}

/** The adapters the live config names, compiled on first use and dropped when a name's code changes. */
export class Adapters {
  private from: Record<string, AdapterDecl> | null = null;
  private readonly kept = new Map<string, { decl: AdapterDecl; adapter: Adapter }>();

  constructor(private readonly cfg: () => HearthConfig) {}

  /** The adapter `name` names, or null when there is none: the config refuses a line that names a missing one. */
  get(name: string): Adapter | null {
    const decls = this.cfg().adapters;
    if (decls !== this.from) {
      this.close();
      this.from = decls;
    }
    const decl = decls[name];
    if (decl === undefined) return null;
    const held = this.kept.get(name);
    if (held?.decl === decl) return held.adapter;
    held?.adapter.close();
    const adapter = new Adapter(name, decl.code, decl.timeoutMs);
    this.kept.set(name, { decl, adapter });
    return adapter;
  }

  /** Drop every module: what a live edit and a shutdown both need, without pulling a running call's module away. */
  close(): void {
    for (const { adapter } of this.kept.values()) adapter.close();
    this.kept.clear();
    this.from = null;
  }
}

/** Compile `code` as an adapter module, throwing what the compiler says when it would never run. */
export function checkAdapterCode(name: string, code: string): void {
  compile(name, code);
}
