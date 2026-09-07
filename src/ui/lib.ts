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
/** A context window, the way people say them: 131072 -> "128k". Exact below
 *  1024, because a 512-token embedding window rounded to "1k" would be wrong in
 *  the direction that matters. */
export const ctxLabel = (n: number): string =>
  n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);

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
 * How the page asks for a key.
 *
 * A function rather than `window.prompt` directly so the console can ask in the
 * page — with room to say what the key is and where to find it, which a native
 * prompt has no space for. The default is still `window.prompt`, so anything
 * importing this outside the console (a test, a bare script) keeps working.
 *
 * Resolves to null when the user declines, and the caller must then abandon the
 * write rather than send an unauthenticated one: a request we already know will
 * 401 is not worth making.
 */
export type KeyAsker = () => Promise<string | null>;

let askForKey: KeyAsker = async () =>
  window.prompt("This node requires an API key for controls.\nIt is stored in this browser only.");

export function setKeyAsker(fn: KeyAsker): void {
  askForKey = fn;
}

export function storedKey(): string | null {
  try { return localStorage.getItem(KEY_STORE); } catch { return null; }
}

/** Remember a key, so the question is asked once per browser and not per click. */
export function rememberKey(key: string): void {
  try { localStorage.setItem(KEY_STORE, key.trim()); } catch { /* private mode */ }
}

/**
 * Forget a key the server actually REJECTED.
 *
 * Only ever called for a 401. A 403 used to clear it too, and that was wrong in
 * the way that made this feature hated: 403 is the cross-origin guard refusing
 * the request's SHAPE, and the credential it threw away was perfectly good. One
 * of those wiped the stored key, so the next click asked again — and the one
 * after that.
 */
export function forgetKey(): void {
  try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
}

/**
 * POST a write route with whatever credential this socket needs.
 *
 * Resolves to a parsed body, or rejects with a message the caller shows on the
 * control itself.
 *
 * Deliberately NOT a retry loop. An earlier version re-asked in place on a 401
 * and resent, which reads well and is a small state machine wired through a
 * promise into a dialog — and it was wrong in a way that took longer to see
 * than it took to write. A rejected key clears and the control says so; the
 * next click asks again. One request per click, always.
 */
export async function postWrite(
  path: string,
  body: unknown,
  mode: UiData["control"],
): Promise<Record<string, unknown>> {
  let key = "";
  if (mode === "key") {
    key = storedKey() ?? "";
    if (!key) {
      const entered = await askForKey();
      // Abandon rather than send a request we already know will 401.
      if (!entered) throw new Error("no key");
      key = entered.trim();
      rememberKey(key);
    }
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;

  if (r.status === 401) {
    forgetKey();
    throw new Error("key rejected — click again to re-enter it");
  }
  if (!r.ok) {
    // 403 included: the cross-origin guard, or a route this socket does not
    // serve. The key is not the problem, so it stays put.
    const err = d.error as { message?: string } | undefined;
    throw new Error(err?.message ?? (d.note as string) ?? "failed");
  }
  return d;
}
