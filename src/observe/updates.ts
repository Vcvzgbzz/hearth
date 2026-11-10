/**
 * Whether a newer hearth is published. Asked of the npm registry when `hearth serve` starts and
 * once a day after, while `updateCheck` is on. The request names the package and nothing else.
 */
import type { Logger } from "./log.js";

export const UPDATE_EVERY_MS = 24 * 60 * 60_000;
const ASK_MS = 10_000;

/** Is `latest` a later release than `current`? Pre-release tags are not offered as updates. */
export function newer(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current.replace(/-.*$/, ""));
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** The version the registry calls latest, or null when it cannot be asked. */
export async function latestVersion(name: string, registry = "https://registry.npmjs.org"): Promise<string | null> {
  try {
    const r = await fetch(`${registry}/${name.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(ASK_MS) });
    if (!r.ok) return null;
    const v = ((await r.json()) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Ask now and every `everyMs`, telling `found` the newer version or null. `enabled` is read at each
 * turn, so switching the setting off stops the asking without a restart. Returns the stop.
 */
export function watchUpdates(o: {
  name: string; current: string; enabled: () => boolean; found: (latest: string | null) => void; log: Logger;
  registry?: string; everyMs?: number;
}): () => void {
  let said: string | null = null;
  const turn = async (): Promise<void> => {
    if (!o.enabled()) {
      o.found(null);
      return;
    }
    const latest = await latestVersion(o.name, o.registry);
    // An unanswered check changes nothing: the notice stays until a check says otherwise.
    if (latest === null) return;
    const update = newer(latest, o.current) ? latest : null;
    o.found(update);
    if (update !== null && update !== said) o.log.info("update.available", { current: o.current, latest: update, hint: `npm i -g ${o.name}` });
    said = update;
  };
  void turn();
  const timer = setInterval(() => void turn(), o.everyMs ?? UPDATE_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
