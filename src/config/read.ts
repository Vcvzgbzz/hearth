/**
 * Reading one config field: the type checks every section shares, and the error that names the field it is about.
 */
import { FIELDS, nearest, type Scope } from "./fields.js";

/**
 * A validation finding. `path` is the field it is about (e.g. `backends.card.kind`),
 * or null for a whole-config one; the sentence keeps the field too, because a
 * journal line has nothing else to say where it came from.
 */
export class ConfigError extends Error {
  constructor(
    readonly path: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export function bad(path: string | null, text: string): ConfigError {
  return new ConfigError(path, path !== null && !text.startsWith(path) ? `${path} ${text}` : text);
}

/** Refuse a key this place does not take: a typo would otherwise load as the default, silently. */
export function only(rec: Record<string, unknown>, allowed: Scope | readonly string[], where: string): void {
  const keys = typeof allowed === "string" ? Object.keys(FIELDS[allowed]) : allowed;
  for (const k of Object.keys(rec)) {
    if (keys.includes(k)) continue;
    const near = nearest(k, keys);
    throw bad(where ? `${where}.${k}` : k, `is not a setting${where ? ` of ${where}` : ""}${near ? ` — did you mean ${near}?` : ""}`);
  }
}

/** `env:NAME` indirection, so tokens live in the environment and the config
 *  stays committable. A missing variable is fatal, because starting up with an
 *  empty token means every peer call 401s and nothing says why. */
export function resolveSecret(value: string, where: string): string {
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const got = process.env[name];
  if (!got) throw bad(where, `${where}: environment variable ${name} is not set`);
  return got;
}

export function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw bad(where, "must be a mapping");
  }
  return v as Record<string, unknown>;
}

export function str(v: unknown, where: string, fallback?: string): string {
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw bad(where, "is required");
  }
  if (typeof v !== "string") throw bad(where, "must be a string");
  return v;
}

export function num(v: unknown, where: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw bad(where, "must be a number");
  }
  return v;
}

/** Whole number, at least `min` (`concurrency: 0` would queue forever). */
export function count(v: unknown, where: string, fallback: number, min = 1): number {
  const n = num(v, where, fallback);
  if (!Number.isInteger(n) || n < min) {
    throw bad(where, `must be a whole number >= ${min} (got ${n})`);
  }
  return n;
}

export function stringList(v: unknown, at: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad(at, "must be a list of names");
  return v as string[];
}

/** Number, at least `min`, fractions fine; for tuning weights where a negative inverts the meaning. */
export function atLeast(v: unknown, where: string, fallback: number, min = 0): number {
  const n = num(v, where, fallback);
  if (n < min) throw bad(where, `must be >= ${min} (got ${n})`);
  return n;
}

export function bool(v: unknown, where: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw bad(where, "must be true or false");
  return v;
}

export function strList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw bad(where, "must be a list of strings");
  }
  return v as string[];
}

export function trimUrl(u: string, where: string): string {
  if (!/^https?:\/\//.test(u)) {
    throw bad(where, `must start with http:// or https:// (got ${u})`);
  }
  return u.replace(/\/+$/, "");
}
