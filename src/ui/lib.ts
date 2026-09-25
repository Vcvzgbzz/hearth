/** The page's non-visual parts (formatting, YAML quoting, fetches), kept apart so they test directly. */
import type { UiData } from "./types.js";

/** "42s" / "3m 07s". */
export const since = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** A context window, the way people say them: 131072 -> "128k". Exact below
 *  1024, because a 512-token embedding window rounded to "1k" would be wrong in
 *  the direction that matters. */
export const ctxLabel = (n: number): string =>
  n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);

/** Wall clock, HH:MM. */
export const clock = (t: number): string => new Date(t).toTimeString().slice(0, 5);

/** Any model id in its display form: a variant shows as its parent, a wire id as its advertised id. */
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
  // Checked before the reverse lookup, or a variant family's parent resolves to its first variant.
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
 * How the page asks for a key; defaults to `window.prompt`. Null means declined, and the
 * caller abandons the write.
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

/** Forget a key only on a 401; a 403 is the cross-origin guard, not a bad key. */
export function forgetKey(): void {
  try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
}

/**
 * POST a write route with this socket's credential; rejects with a message for the control.
 * One request per click, no retry loop.
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
