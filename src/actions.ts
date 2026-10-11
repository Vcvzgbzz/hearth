/**
 * Actions: things a flow step sets off beside routing, named under `actions:` and listed on a
 * step as `do:`. An action never changes where a request goes and never holds it up. Each kind
 * is one entry in KINDS: the key that names it, how its settings are read, and what it does.
 */
import { asRecord, bad, only, resolveSecret, str } from "./config.js";
import type { Logger } from "./log.js";

/** What an action is told about the request and where its flow sent it. Also the `{name}`s a template may use. */
export interface ActionFacts {
  action: string;
  node: string;
  /** The id the client asked for, and the id it runs as. */
  asked: string;
  model: string;
  /** `local`, `peer` or `unavailable`. */
  target: string;
  /** The peer it went to, else empty. */
  peer: string;
  lane: string;
  caller: string;
  tokens: number;
  images: boolean;
  tools: boolean;
  /** The flow and the line of it (from 1) that named this action. */
  flow: string;
  line: number;
  reason: string;
  /** `decided` as the step decides; `ok` or `failed` once the request has ended. */
  outcome: string;
  /** How long the request took, in ms, and what went wrong; 0 and empty until it has ended. */
  ms: number;
  error: string;
  /** The backend here that ran it, else empty; and the request's id, when it has one. */
  backend: string;
  id: string;
  /** Of `ms`: how long it waited for a slot, and how long it ran. */
  queuedMs: number;
  ranMs: number;
}

/** When an action runs, and how often at most (0: every time). */
interface Timing { on: "decided" | "finished" | "failed"; every: number; /** Only for a request that took longer than this, in ms (0: any). */ slowerThan: number }

export type Action = Timing & (
  | { kind: "log"; text: string }
  | { kind: "call"; url: string; method: string; headers: Record<string, string>; body: unknown });

const MOMENTS = ["decided", "finished", "failed"] as const;

/** How long a called URL may take. Nothing waits on it, so this only bounds what a dead one holds open. */
const CALL_TIMEOUT_MS = 5000;

/** `{name}` becomes that fact; a name that is not a fact stays as written. */
const fill = (text: string, facts: ActionFacts): string =>
  text.replace(/\{(\w+)\}/g, (whole, k: string) => (k in facts ? String(facts[k as keyof ActionFacts]) : whole));

/** `fill` on every string inside a body, whatever its shape. */
const fillAll = (v: unknown, facts: ActionFacts): unknown =>
  typeof v === "string" ? fill(v, facts)
  : Array.isArray(v) ? v.map((x) => fillAll(x, facts))
  : typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillAll(x, facts)]))
  : v;

interface Kind<A extends Action> {
  /** The settings this kind takes besides the key that names it. */
  keys: readonly string[];
  parse: (o: Record<string, unknown>, at: string) => Omit<A, keyof Timing>;
  run: (a: A, facts: ActionFacts, log: Logger) => void | Promise<void>;
}

const KINDS: { [K in Action["kind"]]: Kind<Extract<Action, { kind: K }>> } = {
  log: {
    keys: [],
    parse: (o, at) => ({ kind: "log", text: str(o.log, `${at}.log`) }),
    run: (a, facts, log) => log.info("flow.action", { ...facts, text: fill(a.text, facts) }),
  },
  call: {
    keys: ["method", "headers", "body"],
    parse: (o, at) => {
      const url = resolveSecret(str(o.call, `${at}.call`), `${at}.call`);
      if (!/^https?:\/\/\S+$/.test(url)) throw bad(`${at}.call`, "must be an http or https URL");
      const method = str(o.method, `${at}.method`, "POST").toUpperCase();
      if (!["POST", "PUT", "GET"].includes(method)) throw bad(`${at}.method`, "must be POST, PUT or GET");
      const headers = Object.fromEntries(Object.entries(asRecord(o.headers ?? {}, `${at}.headers`))
        .map(([k, v]) => [k, resolveSecret(str(v, `${at}.headers.${k}`), `${at}.headers.${k}`)]));
      return { kind: "call", url, method, headers, body: o.body };
    },
    run: async (a, facts) => {
      const res = await fetch(a.url, {
        method: a.method,
        headers: { "content-type": "application/json", ...a.headers },
        ...(a.method === "GET" ? {} : { body: JSON.stringify(a.body === undefined ? facts : fillAll(a.body, facts)) }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      // Drained so the socket can be reused.
      await res.text().catch(() => "");
      if (!res.ok) throw new Error(`answered ${res.status}`);
    },
  },
};

/** The keys that name an action's kind, for the settings table and the console. */
export const ACTION_KINDS = Object.keys(KINDS) as Action["kind"][];

/** `actions:`, each entry exactly one kind. */
export function actionDecls(raw: unknown): Record<string, Action> {
  const out: Record<string, Action> = {};
  for (const [name, v] of Object.entries(asRecord(raw ?? {}, "actions"))) {
    const at = `actions.${name}`;
    const o = asRecord(v, at);
    const said = ACTION_KINDS.filter((k) => o[k] !== undefined);
    if (said.length !== 1) throw bad(at, `must be one kind of action: ${ACTION_KINDS.join(" or ")}`);
    const kind = KINDS[said[0]!];
    only(o, [said[0]!, "on", "every", "slowerThan", ...kind.keys], at);
    // One that asks how long a request took waits for it to end unless told otherwise.
    const on = str(o.on, `${at}.on`, o.slowerThan === undefined ? "decided" : "finished") as Timing["on"];
    if (!MOMENTS.includes(on)) throw bad(`${at}.on`, `must be one of ${MOMENTS.join(", ")}`);
    const every = o.every === undefined ? 0 : Number(o.every);
    if (!Number.isFinite(every) || every < 0) throw bad(`${at}.every`, "must be a number of ms, 0 or more");
    const slowerThan = o.slowerThan === undefined ? 0 : Number(o.slowerThan);
    if (!Number.isFinite(slowerThan) || slowerThan < 0) throw bad(`${at}.slowerThan`, "must be a number of ms, 0 or more");
    if (slowerThan > 0 && on === "decided") throw bad(`${at}.slowerThan`, "cannot go with `on: decided`: how long a request took is not known as it is decided");
    out[name] = { ...kind.parse(o, at), on, every, slowerThan } as Action;
  }
  return out;
}

/** Set off one action. Fire and forget: one that throws or hangs gets a line in the log and touches nothing else. */
export function runAction(action: Action, facts: ActionFacts, log: Logger): void {
  const run = KINDS[action.kind].run as Kind<Action>["run"];
  void Promise.resolve().then(() => run(action, facts, log)).catch((e: unknown) => {
    log.warn("flow.action_failed", { action: facts.action, kind: action.kind, error: e instanceof Error ? e.message : String(e) });
  });
}
