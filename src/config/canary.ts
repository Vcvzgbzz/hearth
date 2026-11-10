/**
 * The canary: the probe it sends, how it judges an answer, and who it tells.
 */
import type { BackendConfig } from "./backends.js";
import { asRecord, bad, bool, count, resolveSecret, str } from "./read.js";

/**
 * How a canary asks its question and what counts as an answer. Small and
 * specific on purpose: a question with one right answer, in a handful of
 * tokens, judged by a pattern.
 */
export interface CanaryProbe {
  /** Sent as the only user message. */
  prompt: string;
  /** Compiled and matched against the answer; a bad pattern fails at --check. */
  expect: string;
  /** Room for the answer. A reasoning model needs more, since its trace shares this budget. */
  maxTokens: number;
  /** Deadline for the whole probe, in ms. */
  timeoutMs: number;
  /** How long between probes of one model, in ms. */
  intervalMs: number;
  /** This many consecutive failures puts the model in `degraded`. */
  failureThreshold: number;
  /** This many consecutive clean probes brings it back. */
  recoverAfter: number;
  /**
   * Watch this id only while it goes out as this backend id: for a `follow` id, whose card may
   * hold a model the question, or the cost of a wrong verdict, does not fit. null always watches.
   */
  onlyAs: string | null;
}

/** Where a state change is announced, and with what. */
export interface CanaryNotify {
  /** POSTed a JSON body describing the change. */
  url: string;
  /** Sent as-is; values may be `env:NAME` so a key stays out of the config file. */
  headers: Record<string, string>;
  /** A hook that hangs must not hang the canary. */
  timeoutMs: number;
}

/**
 * The gentlest nudge for a degraded seat: for a swapping backend, drop just that
 * model so the next request has to load it again. Present only where declared,
 * and `unload: false` keeps it to notification only.
 */
export interface CanaryRecovery {
  /** Ask the backend to unload this one model. */
  unload: boolean;
  /** Never attempt it twice for one model inside this window, in ms. */
  cooldownMs: number;
}

/**
 * The opt-in canary: which models are asked, how, and what happens when one
 * stops answering. Absent means no probes at all, and no traffic inspection.
 */
export interface CanaryConfig {
  /** Every probe inherits these; a model or backend entry overrides field by field. */
  defaults: CanaryProbe;
  /** Model ids asked directly, with overrides. Presence is the opt-in. */
  models: Record<string, Partial<CanaryProbe>>;
  /** Backends whose whole served set is asked, with overrides. */
  backends: Record<string, Partial<CanaryProbe>>;
  /** Also watch relayed completions; a degenerate one brings the next probe forward. */
  passive: boolean;
  notify: CanaryNotify | null;
  recovery: CanaryRecovery | null;
}

/** The question the canary asks when the operator does not write one. One right answer, one line. */
export const DEFAULT_CANARY_PROMPT = "What is the capital of France? Reply with the city name only.";

/** A pattern that will be compiled later; refuse it now, where `--check` can still report it. */
function pattern(text: string, where: string): string {
  try {
    new RegExp(text);
  } catch (e) {
    throw bad(where, `is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }
  return text;
}

/** Only the probe fields actually written down, so a neighbour's override is not inherited. */
function probeOverrides(raw: unknown, where: string): Partial<CanaryProbe> {
  const o = asRecord(raw ?? {}, where);
  const out: Partial<CanaryProbe> = {};
  if (o.prompt !== undefined) {
    const prompt = str(o.prompt, `${where}.prompt`).trim();
    if (prompt === "") throw bad(`${where}.prompt`, "must not be empty");
    out.prompt = prompt;
  }
  if (o.expect !== undefined) {
    out.expect = pattern(str(o.expect, `${where}.expect`), `${where}.expect`);
  }
  if (o.maxTokens !== undefined) out.maxTokens = count(o.maxTokens, `${where}.maxTokens`, 1, 1);
  if (o.timeoutMs !== undefined) out.timeoutMs = count(o.timeoutMs, `${where}.timeoutMs`, 1, 1);
  if (o.intervalMs !== undefined) out.intervalMs = count(o.intervalMs, `${where}.intervalMs`, 1, 1);
  if (o.failureThreshold !== undefined) {
    out.failureThreshold = count(o.failureThreshold, `${where}.failureThreshold`, 1, 1);
  }
  if (o.recoverAfter !== undefined) out.recoverAfter = count(o.recoverAfter, `${where}.recoverAfter`, 1, 1);
  if (o.onlyAs !== undefined) {
    const onlyAs = str(o.onlyAs, `${where}.onlyAs`).trim();
    if (onlyAs === "") throw bad(`${where}.onlyAs`, "must not be empty");
    out.onlyAs = onlyAs;
  }
  return out;
}

/**
 * The `canary:` block. Off unless present, and it must name something to ask:
 * a canary that probes nothing looks configured and protects nothing.
 */
export function canaryDecl(v: unknown, backends: readonly BackendConfig[]): CanaryConfig | null {
  if (v === undefined || v === null || v === false) return null;
  const c = asRecord(v, "canary");

  const prompt = str(c.prompt, "canary.prompt", DEFAULT_CANARY_PROMPT).trim();
  if (prompt === "") throw bad("canary.prompt", "must not be empty");
  const defaults: CanaryProbe = {
    prompt,
    expect: pattern(str(c.expect, "canary.expect", "Paris"), "canary.expect"),
    maxTokens: count(c.maxTokens, "canary.maxTokens", 512, 1),
    timeoutMs: count(c.timeoutMs, "canary.timeoutMs", 30_000, 1),
    intervalMs: count(c.intervalMs, "canary.intervalMs", 30_000, 1),
    failureThreshold: count(c.failureThreshold, "canary.failureThreshold", 2, 1),
    recoverAfter: count(c.recoverAfter, "canary.recoverAfter", 1, 1),
    onlyAs: null,
  };

  const models: Record<string, Partial<CanaryProbe>> = {};
  if (c.models !== undefined) {
    for (const [id, raw] of Object.entries(asRecord(c.models, "canary.models"))) {
      if (id.trim() === "") throw bad("canary.models", "a model id must not be empty");
      models[id] = probeOverrides(raw, `canary.models.${id}`);
    }
  }

  const scoped: Record<string, Partial<CanaryProbe>> = {};
  if (c.backends !== undefined) {
    const declared = backends.map((b) => b.name);
    for (const [name, raw] of Object.entries(asRecord(c.backends, "canary.backends"))) {
      if (!declared.includes(name)) {
        throw bad(
          `canary.backends.${name}`,
          `names a backend that is not declared (${declared.join(", ") || "none"})`,
        );
      }
      scoped[name] = probeOverrides(raw, `canary.backends.${name}`);
    }
  }

  if (Object.keys(models).length === 0 && Object.keys(scoped).length === 0) {
    throw bad(
      "canary",
      "names no models — add `models:` with at least one id, or `backends:` naming one " +
        "whose whole served set you want asked",
    );
  }

  let notify: CanaryNotify | null = null;
  if (c.notify !== undefined && c.notify !== null && c.notify !== false) {
    const n = asRecord(c.notify, "canary.notify");
    const url = str(n.url, "canary.notify.url").trim();
    if (url === "") throw bad("canary.notify.url", "must not be empty");
    const headers: Record<string, string> = {};
    if (n.headers !== undefined) {
      for (const [k, raw] of Object.entries(asRecord(n.headers, "canary.notify.headers"))) {
        headers[k] = resolveSecret(str(raw, `canary.notify.headers.${k}`), `canary.notify.headers.${k}`);
      }
    }
    notify = { url, headers, timeoutMs: count(n.timeoutMs, "canary.notify.timeoutMs", 5_000, 1) };
  }

  let recovery: CanaryRecovery | null = null;
  if (c.recovery !== undefined && c.recovery !== null && c.recovery !== false) {
    const r = asRecord(c.recovery, "canary.recovery");
    recovery = {
      // Declaring the block IS the flag; `unload: false` is how you keep it to a notification.
      unload: bool(r.unload, "canary.recovery.unload", true),
      cooldownMs: count(r.cooldownMs, "canary.recovery.cooldownMs", 600_000, 1),
    };
  }

  return {
    defaults,
    models,
    backends: scoped,
    passive: bool(c.passive, "canary.passive", false),
    notify,
    recovery,
  };
}
