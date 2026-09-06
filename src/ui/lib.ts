/**
 * The page's non-visual parts: formatting, the YAML quoter, and the two fetches.
 *
 * Separate from the components because these are the bits worth testing
 * directly. They used to be extracted out of the page's source with a regex and
 * run through `new Function`, which was the only way to test anything in a
 * template literal — and which caught two real bugs precisely because it ran
 * them rather than parsing them. Now they are just imports.
 */
import type { UiData } from "./types.js";

/** "42s" / "3m 07s". */
export const since = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** Wall clock, HH:MM. */
export const clock = (t: number): string => new Date(t).toTimeString().slice(0, 5);

/**
 * Resolve any model id to its canonical display form.
 *
 * Three cases:
 *   1. Variant id (aliases[id] is an advertised model in available) -> return parent
 *   2. Backend wire id (some advertised id A has aliases[A] === id) -> return A
 *   3. Already an advertised id -> return it
 *
 * This means "nomic-embed-text-v2-moe:latest" (the wire id) displays as
 * "nomic-embed" everywhere on the page: lanes, charts, tables, hover readouts.
 */
export const displayId = (
  id: string,
  aliases?: Record<string, string>,
  available?: string[],
): string => {
  if (!aliases) return id;
  const avail = new Set(available ?? []);
  // Variant -> parent
  const as = aliases[id];
  if (as && as !== id && avail.has(as)) return as;
  // An advertised id that is nobody's variant is already the display form.
  // This check has to come BEFORE the reverse lookup: the parent of a variant
  // family is also the `as` target of every variant, so without it the parent
  // "resolved" to its first variant while the variant resolved to the parent,
  // and the lanes chart drew both. Found on the live node, 2026-09-05.
  if (avail.has(id)) return id;
  // Wire id -> advertised (reverse lookup)
  for (const [a, w] of Object.entries(aliases)) {
    if (w === id && avail.has(a)) return a;
  }
  return id;
};

export async function load(): Promise<UiData> {
  const r = await fetch("/ui/data", { cache: "no-store" });
  if (!r.ok) throw new Error(`/ui/data returned ${r.status}`);
  return (await r.json()) as UiData;
}

const KEY_STORE = "hearth.apikey";

/**
 * Bearer key for writes, asked for once and kept in localStorage.
 *
 * Returns null if the user dismisses the prompt, and the caller must then
 * abandon the write rather than send an unauthenticated one — a request we
 * already know will 401 is not worth making.
 */
function apiKey(mode: UiData["control"]): string | null {
  if (mode !== "key") return "";
  let k: string | null = null;
  try { k = localStorage.getItem(KEY_STORE); } catch { k = null; }
  if (k) return k;
  const entered = window.prompt(
    "This node requires an API key for controls.\nIt is stored in this browser only.");
  if (!entered) return null;
  try { localStorage.setItem(KEY_STORE, entered.trim()); } catch { /* private mode */ }
  return entered.trim();
}

/** Forget a key the server just rejected, so the next attempt re-prompts
 *  instead of failing forever against a stale value. */
function forgetKey(): void {
  try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
}

/**
 * POST a write route with whatever credential this socket needs.
 *
 * Resolves to a parsed body, or rejects with a message the caller shows on the
 * control itself. A 401 clears the stored key on the way out.
 */
export async function postWrite(
  path: string,
  body: unknown,
  mode: UiData["control"],
): Promise<Record<string, unknown>> {
  const key = apiKey(mode);
  if (key === null) throw new Error("no key");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 401 || r.status === 403) {
    forgetKey();
    throw new Error("key rejected");
  }
  if (!r.ok) {
    const err = d.error as { message?: string } | undefined;
    throw new Error(err?.message ?? (d.note as string) ?? "failed");
  }
  return d;
}
