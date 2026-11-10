/**
 * A finished request read back as words: what became of it, the rule lines that decided it as the
 * rules stand now, and the shape the routing map lights a tried request by.
 */
import type { Flow, RequestTrace } from "../observe/uidata.js";
import { toOf, type To } from "./draft.js";

/** A duration as the console writes one: `850 ms`, `3.2 s`, `42 s`. */
export const secs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

/** The rulebook a request went by, as the map names it: null for the rules everyone goes by. */
export const routerOf = (t: RequestTrace): string | null => (t.router && t.router !== "default" ? t.router : null);

/** A recorded request as a tried one (`Tried` in editStore.ts), so the map lights its path the same way. */
export const asTried = (t: RequestTrace): Pick<RequestTrace, "target" | "model" | "path" | "actions" | "backend" | "peer"> & { reason: string } => ({
  target: t.target, model: t.model, reason: t.reason ?? "", path: t.path, actions: t.actions,
  ...(t.backend !== undefined ? { backend: t.backend } : {}), ...(t.peer !== undefined ? { peer: t.peer } : {}),
});

/** Where it ran, in a few words: a backend, `peer <name>`, `cache` or `refused`. */
export const where = (t: RequestTrace): string =>
  t.target === "cache" ? "cache" : t.target === "refused" || t.target === "unavailable" ? "refused" : t.target === "peer" ? `peer ${t.peer ?? "?"}` : t.backend ?? "here";

const refused = (t: RequestTrace) => t.target === "refused" || t.target === "unavailable";

/** One line saying what became of it. */
export function verdict(t: RequestTrace): string {
  if (refused(t)) return `refused: ${t.error ?? t.reason ?? "no reason given"}`;
  if (t.target === "cache") return `${t.asked} answered from the cache in ${secs(t.waitedMs + t.runMs)}`;
  const as = t.model !== "" && t.model !== t.asked ? ` as ${t.model}` : "";
  const on = t.target === "peer" ? ` on the peer ${t.peer ?? "?"}` : t.backend ? ` on ${t.backend}` : "";
  const took = secs(t.waitedMs + t.runMs);
  return t.ok ? `${t.asked} ran${as}${on} in ${took}` : `${t.asked} failed${as}${on} after ${took}${t.error ? `: ${t.error}` : t.status ? ` (${t.status})` : ""}`;
}

/** A line's name in its rule, as the map's strip says it. */
export const lineName = (step: number, of: number): string => (of === 1 ? "its only line" : step === of - 1 ? "its Otherwise line" : `line ${step + 1}`);

/** Where a line sends a request, in words. */
export function sends(to: To): string {
  switch (to.kind) {
    case "model": return `runs it as ${to.model}`;
    case "peer": return `sends it to the peer ${to.peer}${to.model ? ` as ${to.model}` : ""}`;
    case "flow": return `hands it to the rule ${to.flow}`;
    case "fastest": return `runs it on the fastest of ${to.of.map((e) => (e.kind === "peer" ? `the peer ${e.peer}` : e.model)).join(", ")}`;
    case "refuse": return `refuses it: ${to.why}`;
    case "asked": return "runs it as asked";
    case "plugin": return `hands it to the plugin ${to.plugin}`;
    default: return "sends it nowhere yet";
  }
}

/** One rule line that decided, read from the rules as they are now; `gone` when that rule or line is no longer there. */
export type Hop = { flow: string; step: number; line: string; gone: boolean; when: Record<string, unknown>; sends: string };

export function hops(t: RequestTrace, flows: Record<string, Pick<Flow, "steps">> | undefined): Hop[] {
  return t.path.map(({ flow, step }) => {
    const steps = flows?.[flow]?.steps;
    const s = steps?.[step];
    if (!steps || !s) return { flow, step, line: `line ${step + 1}`, gone: true, when: {}, sends: "" };
    return { flow, step, line: lineName(step, steps.length), gone: false, when: s.when ?? {}, sends: sends(toOf(s.to)) };
  });
}

/** Every attempt kept for one id, first attempt first: a request that fell back has one per attempt. */
export const attemptsOf = (traces: RequestTrace[], id: string): RequestTrace[] => traces.filter((r) => r.id === id).sort((a, b) => a.t - b.t);
