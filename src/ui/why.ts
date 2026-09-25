/** Pure derivations over the payload, kept free of DOM so node tests can assert them. */
import type { Backend, Call, Job, Resource } from "./types.js";

/** Resources this backend needs that ANOTHER backend holds; its own hold never blocks it. */
export function blockers(b: Backend, resources: Resource[]): Resource[] {
  const mine = b.resources ?? [];
  return resources.filter((r) => mine.includes(r.name) && r.holder !== null && r.holder !== b.name);
}

/**
 * Why a job is not running, in the order admission decides: hardware held elsewhere, then
 * the backend's own ceilings.
 */
export interface Wait {
  text: string;
  /** blocked = another backend has the card. busy = this one is full.
   *  cold = a load stands between the job and the GPU. lane = ordinary queueing. */
  tone: "blocked" | "busy" | "cold" | "lane";
}

export function waitReason(j: Job, b: Backend | undefined, resources: Resource[]): Wait {
  if (b) {
    const held = blockers(b, resources);
    if (held.length) {
      const r = held[0]!;
      return { tone: "blocked", text: `${r.name} — ${r.holder} has it` };
    }
    if (b.slots !== undefined && b.free === 0) {
      return { tone: "busy", text: `${b.name} full · ${b.slots} in flight` };
    }
    // Only a backend that evicts can make a job wait for a load. Everything
    // else keeps its set resident, so a cold model there is a cold START, not a
    // queue — saying "must unload" about it would be an invention.
    if (b.evicts && b.loaded?.length && !b.loaded.includes(j.model)) {
      return { tone: "cold", text: `${b.loaded.join(", ")} must unload first` };
    }
    if (b.evicts && b.knowsWarm && !b.loaded?.length) {
      return { tone: "cold", text: "cold — nothing is loaded yet" };
    }
  }
  return { tone: "lane", text: j.position ? `${j.position} ahead in ${j.lane}` : `${j.lane} lane` };
}

/**
 * The window's calls as p50/p95 run time, failure rate and queue wait. Wait is kept apart
 * from run time: a slow p95 is a model or card, a long wait is a queue.
 */
export interface CallStats {
  n: number;
  failed: number;
  /** Run time, milliseconds. Null when there is nothing to take a median of. */
  medianMs: number | null;
  p95Ms: number | null;
  /** The worst queue wait in the window, which is what "the queue was bad" means. */
  maxWaitMs: number;
}

export function callStats(calls: Call[] | undefined): CallStats {
  const n = calls?.length ?? 0;
  if (!calls || n === 0) return { n: 0, failed: 0, medianMs: null, p95Ms: null, maxWaitMs: 0 };
  const ran = calls.map((c) => c.ms).sort((a, b) => a - b);
  // Nearest-rank, so a single call is its own p95 rather than an interpolation
  // between it and nothing.
  const at = (q: number): number => ran[Math.min(ran.length - 1, Math.ceil(q * ran.length) - 1)]!;
  return {
    n,
    failed: calls.filter((c) => !c.ok).length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxWaitMs: Math.max(0, ...calls.map((c) => c.waitedMs)),
  };
}
