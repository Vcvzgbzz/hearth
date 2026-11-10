/**
 * What happened to each request: the one-line request log, the call history, usage per caller,
 * and the console's rail of recent calls. Also carries the request being handled through async
 * calls, so a line logged deep in routing still has its request id.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";

import type { HearthConfig } from "../config/config.js";
import type { History } from "./history.js";
import { headersOf } from "../wire/http.js";
import type { Logger } from "./log.js";
import type { Meter, Usage } from "./usage.js";
import { derived } from "../config/derived.js";
import { RequestStore } from "./requests.js";
import type { RequestTrace } from "./uidata.js";

/** One request this node asked for, where it ran, and how it ended; `backend` and `peer` are both absent when it never ran. */
export interface RecentCall { t: number; /** The request id, as `/ui/requests/<id>` finds it. */ id?: string; model: string; caller: string; backend?: string; peer?: string; target?: "cache"; ms: number; ok: boolean }
const RECENT_KEPT = 12;

/** Per-request timing for the one-line request log; `waitedMs` shows whether admission queued it. */
export interface Timing {
  enqueuedAt: number;
  startedAt: number;
  /** Reads what the answer cost as it is written, where the request is one worth counting. */
  meter?: Meter;
  /** The size the request was judged to be, for an answer that does not say. */
  need?: number;
  /** When the first byte after `startedAt` was written to the client; see `firstByte`. */
  firstByteAt?: number;
}

/** What routing decided for a request, for its trace; a request turned away before routing has only what was known. */
export interface Traced {
  asked?: string;
  path?: RequestTrace["path"];
  reason?: string;
  router?: string;
  actions?: string[];
  plugins?: string[];
  fallbackFrom?: string;
  images?: true;
  tools?: true;
}

/** `t`, with the time of the first write to `res` once it has started running kept on it: a stream's first chunk, or a whole answer. */
export function firstByte(res: { write: unknown; end: unknown }, t: Timing): Timing {
  const write = res.write as (...a: unknown[]) => unknown;
  const end = res.end as (...a: unknown[]) => unknown;
  const seen = (): void => {
    if (t.startedAt > 0 && t.firstByteAt === undefined) t.firstByteAt = Date.now();
  };
  res.write = function (this: unknown, ...a: unknown[]) { seen(); return write.apply(this, a); };
  res.end = function (this: unknown, ...a: unknown[]) { if (a[0] !== undefined && typeof a[0] !== "function") seen(); return end.apply(this, a); };
  return t;
}

/** A timing for a request turned away before it ran. */
export const notRun = (): Timing => ({ enqueuedAt: Date.now(), startedAt: 0 });

export class RequestLog {
  private readonly asking = new AsyncLocalStorage<{ id: string; req: IncomingMessage }>();
  /** One record per finished request, for `/ui/requests`. */
  readonly traces = new RequestStore();
  /** The requests this node made most recently, newest first. */
  private readonly latest: RecentCall[] = [];
  /** Header names any flow's rules test, read again only when a rulebook is replaced. */
  private readonly testedNames = derived(
    () => this.rulebooks(),
    () => {
      const names = new Set<string>();
      for (const flows of this.rulebooks()) {
        for (const step of Object.values(flows).flatMap((f) => f.steps)) {
          for (const name of [...Object.keys(step.when?.header ?? {}), ...Object.keys(step.when?.headerNot ?? {})]) {
            if (name !== "authorization" && name !== "cookie") names.add(name);
          }
        }
      }
      return [...names];
    },
  );

  constructor(
    private readonly cfg: HearthConfig,
    private readonly log: Logger,
    private readonly history: History,
    private readonly usage: Usage,
    private readonly borrowed: Usage,
  ) {}

  /** `flows:` and every router's flows. */
  private rulebooks(): HearthConfig["flows"][] {
    return [this.cfg.flows, ...Object.values(this.cfg.routers).map((r) => r.flows)];
  }

  /** Run `fn` as the handling of request `id`. */
  run<T>(id: string, req: IncomingMessage, fn: () => T): T {
    return this.asking.run({ id, req }, fn);
  }

  /** The id of the request being handled, or "" outside one. */
  id(): string {
    return this.asking.getStore()?.id ?? "";
  }

  /** A copy, so the page's last frame keeps what it had and the next change is seen as one. */
  recent(): RecentCall[] {
    return [...this.latest];
  }

  /** The headers of this request that some rule tests, as sent: what a routing decision turned on. Credentials are never among them. */
  private testedHeaders(): Record<string, string> | undefined {
    const req = this.asking.getStore()?.req;
    if (!req) return undefined;
    const names = this.testedNames();
    if (names.length === 0) return undefined;
    const sent = headersOf(req);
    const out: Record<string, string> = {};
    for (const name of names) if (sent[name] !== undefined) out[name] = sent[name]!.slice(0, 200);
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Log one request, record it in the call history, usage and traces, and put it on the rail. */
  record(t: Timing, fields: Record<string, unknown>, ok: boolean, error?: unknown, route: Traced = {}): void {
    const started = t.startedAt || Date.now();
    // A call that actually ran on a local backend is a use of that model,
    // whether or not it succeeded: the weights were busy either way. Admission
    // refusals (startedAt 0) and peer dispatches are not local uses.
    if (t.startedAt > 0 && fields.target === "local" && typeof fields.model === "string") {
      this.history.record({
        t: Date.now(), model: fields.model, backend: String(fields.backend ?? ""),
        ms: Date.now() - started, waitedMs: started - t.enqueuedAt, ok,
      });
    }
    // Whoever asked used it, here or on a peer; an admission refusal used nothing.
    const used = t.startedAt > 0 ? t.meter?.read(t.need) ?? null : null;
    if (t.startedAt > 0 && typeof fields.model === "string") {
      const who = typeof fields.caller === "string" && fields.caller !== "" ? fields.caller : typeof fields.forPeer === "string" ? `peer:${fields.forPeer}` : "local";
      this.usage.add(who, fields.model, ok, used);
      if (fields.target === "peer" && typeof fields.peer === "string") this.borrowed.add(fields.peer, fields.model, ok, used);
    }
    // What this node asked for, wherever it ran, for the console's rail; work done for a peer is not this node's request.
    const id = this.asking.getStore()?.id;
    if (fields.forPeer === undefined && typeof fields.model === "string") {
      this.latest.unshift({
        t: Date.now(), ...(id ? { id } : {}), model: fields.model, caller: typeof fields.caller === "string" && fields.caller !== "" ? fields.caller : "local",
        ...(fields.target === "peer" && typeof fields.peer === "string" ? { peer: fields.peer } : t.startedAt > 0 ? { backend: String(fields.backend ?? "") } : fields.target === "cache" ? { target: "cache" as const } : {}),
        ms: t.startedAt > 0 ? Date.now() - started : 0, ok,
      });
      if (this.latest.length > RECENT_KEPT) this.latest.length = RECENT_KEPT;
    }
    const headers = this.testedHeaders();
    const now = Date.now();
    const firstByteMs = t.startedAt > 0 && t.firstByteAt !== undefined ? t.firstByteAt - t.startedAt : undefined;
    const said = error ? String(error).slice(0, 200) : undefined;
    const path = route.path ?? [];
    const tokens = used ? { tokensIn: used.in, tokensOut: used.out, ...(used.cached ? { tokensCached: used.cached } : {}), ...(used.est ? { tokensEstimated: true as const } : {}) } : {};
    this.log.info("request", {
      ...(id ? { id } : {}),
      ...fields,
      // A passthrough line's `path` is the URL path it came in on, so the flow path goes beside it there.
      ...(path.length > 0 ? { [fields.path === undefined ? "path" : "flowPath"]: path } : {}),
      ...(route.router !== undefined ? { router: route.router } : {}),
      ...tokens,
      ...(headers ? { headers } : {}),
      waitedMs: started - t.enqueuedAt,
      runMs: now - started,
      ...(firstByteMs !== undefined ? { firstByteMs } : {}),
      ok,
      ...(said !== undefined ? { error: said } : {}),
    });
    const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
    const model = str(fields.model) ?? "";
    const opt = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : { [k]: v }) as Partial<Record<K, V>>;
    this.traces.add({
      id: id ?? "", t: now, asked: route.asked ?? model, model,
      caller: str(fields.caller) ?? (str(fields.forPeer) ? `peer:${fields.forPeer}` : "local"),
      ...opt("lane", str(fields.lane)),
      target: (str(fields.target) ?? "local") as RequestTrace["target"],
      ...opt("backend", str(fields.backend)),
      ...opt("peer", str(fields.peer)),
      ...opt("status", typeof fields.status === "number" ? fields.status : undefined),
      ok,
      ...opt("error", said),
      waitedMs: started - t.enqueuedAt,
      runMs: now - started,
      ...opt("firstByteMs", firstByteMs),
      ...tokens,
      path,
      ...opt("reason", route.reason ?? str(fields.reason)),
      ...opt("router", route.router),
      actions: route.actions ?? [],
      ...opt("plugins", route.plugins ?? (str(fields.plugin) ? [fields.plugin as string] : undefined)),
      ...opt("headers", headers),
      ...opt("fallbackFrom", route.fallbackFrom),
      ...opt("images", route.images),
      ...opt("tools", route.tools),
    });
  }

  /** A request turned away before it was routed: on the rail and in the log, with nothing used. */
  refused(c: { peer: string | null; caller: string }, model: string, e: unknown): void {
    if (model === "") return;
    this.record(notRun(), { model, target: "refused", ...(c.peer !== null ? { forPeer: c.peer } : { caller: c.caller }) }, false, e instanceof Error ? e.message : e);
  }
}
