/**
 * Api keys: each one's label, scope, router and limits.
 */
import { ANY } from "./flows.js";
import { asRecord, atLeast, bad, num, only, resolveSecret, str, strList } from "./read.js";

/** What bounds one key. 0 is no limit; `expires` is the first moment it no longer works, or null for never. */
export interface KeyRule {
  expires: number | null;
  requestsPerMinute: number;
  tokensPerDay: number;
  /** What it may spend in a UTC day, in dollars, on models that carry a `price`. 0 is no limit. */
  dollarsPerDay: number;
  /** The lane its requests queue in where neither the model nor a route says; null leaves it to the request. */
  lane: string | null;
  /** Jobs it may run at once over every model; more wait in line. 0 is no limit. */
  maxConcurrent: number;
  /** One model's own limits, each beside the key's. Keyed by the id a job runs as; an id no longer reached does nothing. */
  models: Record<string, KeyModelRule>;
}

/** What one model is held to for one key. */
export interface KeyModelRule {
  maxConcurrent?: number;
  tokensPerDay?: number;
  requestsPerMinute?: number;
}

const NO_RULE: KeyRule = { expires: null, requestsPerMinute: 0, tokensPerDay: 0, dollarsPerDay: 0, lane: null, maxConcurrent: 0, models: {} };

/** Every name a flow takes, in `flows:` and in each router's: what a client may ask for besides a model. Read off the file as written. */
export function typeNames(root: Record<string, unknown>): string[] {
  const inputsOf = (flows: unknown): string[] =>
    Object.values(typeof flows === "object" && flows !== null ? flows : {}).flatMap((f) => {
      const inputs = (f as { inputs?: unknown } | null)?.inputs;
      return Array.isArray(inputs) ? inputs.filter((n): n is string => typeof n === "string" && n !== ANY) : [];
    });
  const routers = typeof root.routers === "object" && root.routers !== null ? Object.values(root.routers) : [];
  return [...inputsOf(root.flows), ...routers.flatMap((r) => inputsOf((r as { flows?: unknown } | null)?.flows))];
}

/** `apiKeys:` entries: a bare secret, or `{ key, label }`. Labels are shown wherever caller ids are. */
export function apiKeyList(
  v: unknown, where: string, routeIds: Set<string>, lanes: readonly string[],
): { keys: string[]; labels: string[]; models: (string[] | null)[]; rules: KeyRule[] } {
  if (v === undefined) return { keys: [], labels: [], models: [], rules: [] };
  if (!Array.isArray(v)) throw bad(where, "must be a list");
  const keys: string[] = [];
  const labels: string[] = [];
  const models: (string[] | null)[] = [];
  const rules: KeyRule[] = [];
  // Both refuse a duplicate, and neither message ever names the secret.
  const seenKey = new Map<string, number>();
  const seenLabel = new Map<string, number>();
  const take = (key: string, label: string, at: string, scope: string[] | null = null, rule: KeyRule = NO_RULE): void => {
    // The first match wins in localCaller, so a repeated secret makes every
    // later entry unreachable — including its label, which would then be a name
    // the operator sees in the config and never in a log.
    const dupKey = seenKey.get(key);
    if (dupKey !== undefined) {
      throw bad(
        `${at}.key`, `repeats ${where}[${dupKey}] -- the first match wins, so this entry can never be the one that authenticates`,
      );
    }
    seenKey.set(key, keys.length);
    if (label !== "") {
      // Two keys under one label would be one caller sharing one budget, so refuse it.
      const dupLabel = seenLabel.get(label);
      if (dupLabel !== undefined) {
        throw bad(
          `${at}.label`, `"${label}" is already used by ${where}[${dupLabel}] -- two keys under one name share one caller identity, and with it one maxPerCaller budget`,
        );
      }
      seenLabel.set(label, keys.length);
    }
    keys.push(key);
    labels.push(label);
    models.push(scope);
    rules.push(rule);
  };
  v.forEach((raw, i) => {
    const at = `${where}[${i}]`;
    if (typeof raw === "string") {
      take(resolveSecret(raw, at), "", at);
      return;
    }
    const entry = asRecord(raw, at);
    only(entry, ["key", "label", "models", "expires", "limits", "lane"], at);
    const key = resolveSecret(str(entry.key, `${at}.key`), `${at}.key`);
    // A blank label is a typo, not "no label" — the string form is how you say
    // no label — so it is refused rather than silently falling back to the hash.
    const label = str(entry.label, `${at}.label`).trim();
    if (label === "") throw bad(`${at}.label`, "must not be empty");
    // A scope names routes, not backend ids: an unknown id is refused here
    // rather than found as a 403 on the client, and a scoped key can only ever
    // reach ids whose lane and params the operator wrote down.
    let scope: string[] | null = null;
    if (entry.models !== undefined) {
      scope = strList(entry.models, `${at}.models`);
      if (scope.length === 0) throw bad(`${at}.models`, "must name at least one model");
      for (const id of scope) {
        if (!routeIds.has(id)) {
          throw bad(`${at}.models`, `names "${id}", which is not a route in models: or a name a flow takes`);
        }
      }
    }
    // A day, and the key works through the end of it (UTC).
    let expires: number | null = null;
    if (entry.expires !== undefined) {
      const day = str(entry.expires, `${at}.expires`);
      const t = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
      if (Number.isNaN(t)) throw bad(`${at}.expires`, `must be a day as YYYY-MM-DD (got ${day})`);
      expires = t + 86_400_000;
    }
    const limits = entry.limits === undefined ? {} : asRecord(entry.limits, `${at}.limits`);
    only(limits, ["requestsPerMinute", "tokensPerDay", "dollarsPerDay", "maxConcurrent", "models"], `${at}.limits`);
    const cap = (k: "requestsPerMinute" | "tokensPerDay"): number => {
      const n = num(limits[k], `${at}.limits.${k}`, 0);
      if (!Number.isInteger(n) || n < 0) throw bad(`${at}.limits.${k}`, "must be a whole number, 0 or more");
      return n;
    };
    const jobs = (raw: unknown, here: string): number => {
      const n = num(raw, here, 0);
      if (!Number.isInteger(n) || n < 1) throw bad(here, "must be a whole number, 1 or more");
      return n;
    };
    const lane = entry.lane === undefined ? null : str(entry.lane, `${at}.lane`);
    if (lane !== null && !lanes.includes(lane)) throw bad(`${at}.lane`, `of key "${label}" is "${lane}", which is not in scheduler.lanes (${lanes.join(", ")})`);
    const own: Record<string, KeyModelRule> = {};
    for (const [id, raw] of Object.entries(limits.models === undefined ? {} : asRecord(limits.models, `${at}.limits.models`))) {
      const here = `${at}.limits.models.${id}`;
      if (id.trim() === "") throw bad(`${at}.limits.models`, "names a model with an empty id");
      const m = asRecord(raw, here);
      only(m, ["maxConcurrent", "tokensPerDay", "requestsPerMinute"], here);
      const rule: KeyModelRule = {};
      if (m.maxConcurrent !== undefined) rule.maxConcurrent = jobs(m.maxConcurrent, `${here}.maxConcurrent`);
      for (const k of ["tokensPerDay", "requestsPerMinute"] as const) {
        if (m[k] === undefined) continue;
        const n = num(m[k], `${here}.${k}`, 0);
        if (!Number.isInteger(n) || n < 0) throw bad(`${here}.${k}`, "must be a whole number, 0 or more");
        rule[k] = n;
      }
      own[id] = rule;
    }
    take(key, label, at, scope, {
      expires, requestsPerMinute: cap("requestsPerMinute"), tokensPerDay: cap("tokensPerDay"), dollarsPerDay: atLeast(limits.dollarsPerDay, `${at}.limits.dollarsPerDay`, 0),
      lane, maxConcurrent: limits.maxConcurrent === undefined ? 0 : jobs(limits.maxConcurrent, `${at}.limits.maxConcurrent`), models: own,
    });
  });
  return { keys, labels, models, rules };
}
