/**
 * The node's load as a fire: how brightly the coals glow under the smoke and
 * how many embers rise off them. Idle is banked, not out; a full queue is a
 * full fire. Pure, so the mapping can be tested without a browser.
 */

/** `load` is 0 for idle to 1 for a full queue; anything else reads as the nearest end. */
export function fire(load: number): { heat: number; embers: number } {
  const l = Number.isFinite(load) ? Math.max(0, Math.min(1, load)) : 0;
  // The coals never go out, and embers stay rare until there is work.
  return { heat: 0.1 + 0.9 * l, embers: 0.02 + 0.46 * l * l };
}

/** What a finished request sends up, as the shader's stoke kind (see Smoke.tsx). */
export const STOKE = { cloud: 0.6, request: 0.5, peerIn: 0.4, peerOut: 0.3, rain: 0.2 } as const;

/**
 * The stoke for one finished request, or null for none: a failure that ran somewhere is rain, one
 * refused before it ran is nothing; one sent to a peer drifts off the side, one a provider answered
 * leaves through the top, one in from a peer is blue-hot, and the rest are the fire's own sparks.
 */
export function stokeOf(r: { ok: boolean; caller: string; backend?: string; peer?: string }, clouds: ReadonlySet<string>): number | null {
  if (!r.ok) return r.backend || r.peer ? STOKE.rain : null;
  if (r.peer) return STOKE.peerOut;
  if (r.backend && clouds.has(r.backend)) return STOKE.cloud;
  if (r.caller.startsWith("peer:")) return STOKE.peerIn;
  return STOKE.request;
}

/** A node's own fire: four numbers in [0, 1) from its name, the same every time it is drawn. */
export function seedOf(name: string): [number, number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    h = (h ^ (h << 13)) >>> 0;
    h = (h ^ (h >>> 17)) >>> 0;
    h = (h ^ (h << 5)) >>> 0;
    out[k] = h / 4294967296;
  }
  return out;
}
