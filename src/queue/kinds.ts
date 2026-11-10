/**
 * What each backend `kind` can do, in one table: adding a kind is one entry here, and
 * test/kinds.test.ts holds every entry to the same contract.
 */
import type { Logger } from "../observe/log.js";
import { statsFromModels, statsFromProps } from "../routing/stats.js";
import { known, type ModelStats } from "../config/models.js";
import { getJson, send } from "../wire/upstream.js";
import type { KindName } from "../config/kinds.js";

/** llama-swap's states for a model that is serving, and one loading off the disk. */
const READY = "ready";
const STARTING = "starting";

/**
 * Where a resident model's weights were assigned when not all fit on the card, read off its
 * launch command (nothing else reports it). Says "on the host", not whether RAM or disk serves them.
 */
export interface Placement {
  /** Layers whose experts are computed on the CPU, from `--n-cpu-moe`. */
  cpuLayers: number | null;
  /** Every layer of MoE experts, from `--cpu-moe` with no number. */
  cpuExpertsAll: boolean;
  /** The whole model runs on the CPU: `-ngl 0`, and no card is involved. */
  cpuOnly: boolean;
}

/** Placement from a llama-server command line: only `--n-cpu-moe N`, `--cpu-moe` and `-ngl 0`, which stand alone. */
export function parsePlacement(cmd: string): Placement | null {
  const flag = (...names: string[]): string | null => {
    for (const n of names) {
      const m = new RegExp(`(?:^|\\s)${n}(?:[=\\s]+)(\\S+)`).exec(cmd);
      if (m) return m[1]!;
    }
    return null;
  };
  const has = (...names: string[]): boolean =>
    names.some((n) => new RegExp(`(?:^|\\s)${n}(?:\\s|$)`).test(cmd));

  const moe = flag("--n-cpu-moe", "-ncmoe");
  const cpuLayers = moe !== null && /^\d+$/.test(moe) ? Number(moe) : null;
  const cpuExpertsAll = has("--cpu-moe");
  const ngl = flag("--n-gpu-layers", "-ngl");
  const cpuOnly = ngl === "0";

  if (cpuLayers === null && !cpuExpertsAll && !cpuOnly) return null;
  return { cpuLayers, cpuExpertsAll, cpuOnly };
}

/** One reading of what a backend holds. */
export interface WarmReading {
  loaded: string[];
  loading: string[];
  /** Null where the kind cannot say. */
  placements: Map<string, Placement> | null;
}

/** llama-swap's model list, as /running and the event stream both report it. */
export interface ModelStatus {
  id: string;
  state: string;
}

export interface Kind {
  /** Pushes model status on /api/events; everything else is polled. */
  events: boolean;
  /** Can report what is loaded; false means an empty set is "cannot tell", never "cold". */
  knowsWarm: boolean;
  /** One model whatever the id: everything listed is resident, and its stats are one answer. */
  single: boolean;
  /** Serves several resident models side by side, so a model's ceiling counts only its own jobs. */
  coresident: boolean;
  /** What is loaded now, given the /v1/models catalogue; null when the kind has no answer. */
  readWarm(url: string, catalog: string[]): Promise<WarmReading | null>;
  /** Stats for a model; asks nothing that would load a cold one. Rejects or returns {} when unknown. */
  stats(url: string, wire: string, loaded: readonly string[]): Promise<ModelStats>;
  /**
   * Clear the card for a neighbour: true once cleared, false if unreachable, throws on a refusal.
   * Absent: this kind cannot, so it must not share an exclusive resource.
   */
  unload?(url: string, log: Logger): Promise<boolean>;
  /**
   * Drop ONE model, leaving everything else resident: true once dropped, false where the
   * backend would not. What the canary's gentle recovery leans on — clearing the whole card
   * to fix one model would evict a neighbour that was working. Absent: no per-model drop.
   */
  unloadModel?(url: string, wire: string, log: Logger): Promise<boolean>;
  /** Placement for a resident set, read when the set changes; absent where the kind cannot say. */
  placement?(url: string): Promise<Map<string, Placement>>;
}

const QUICK = { headersTimeoutMs: 2_000, totalTimeoutMs: 2_000 };

/** llama-server answers /props; vLLM has none and reports max_model_len on /v1/models. */
async function openaiStats(base: string): Promise<ModelStats> {
  const stats = await getJson<unknown>(`${base}/props`, QUICK).then(statsFromProps, () => ({}));
  return known(stats) ? stats : statsFromModels(await getJson<unknown>(`${base}/v1/models`, QUICK));
}

type Running = { running?: { model?: string; state?: string; cmd?: string }[] };

function placementsOf(running: Running): Map<string, Placement> {
  const out = new Map<string, Placement>();
  for (const r of running.running ?? []) {
    const p = r.model && r.cmd ? parsePlacement(r.cmd) : null;
    if (p && r.model) out.set(r.model, p);
  }
  return out;
}

const llamaSwap: Kind = {
  events: true,
  knowsWarm: true,
  single: false,
  coresident: false,
  async readWarm(url) {
    const running = await getJson<Running>(`${url}/running`, { headersTimeoutMs: 3_000 });
    const rows = running.running ?? [];
    const inState = (state: string) =>
      rows.filter((r) => (r.state ?? READY) === state).map((r) => r.model ?? "").filter((m) => m !== "");
    return { loaded: inState(READY), loading: inState(STARTING), placements: placementsOf(running) };
  },
  async stats(url, wire, loaded) {
    // Probing a cold model through llama-swap loads it.
    if (!loaded.includes(wire)) return {};
    return openaiStats(`${url}/upstream/${encodeURIComponent(wire)}`);
  },
  async unload(url, log) {
    const at = `${url}/api/models/unload`;
    let res;
    try {
      res = await send(at, { method: "POST", headersTimeoutMs: 30_000 });
    } catch (e) {
      // Down is not refused: residency stays as last read, so the caller will not load on top.
      log.warn("backend.unload_failed", { url: at, detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
    res.body.resume();
    if (!res.ok) {
      log.warn("backend.unload_refused", { url: at, status: res.status });
      throw new Error(`${at} answered ${res.status}: the card was not cleared`);
    }
    return true;
  },
  async unloadModel(url, wire, log) {
    // llama-swap's own API: `POST /api/models/unload/:model_id`. Encoded, so an id
    // with a slash in it stays one path segment instead of becoming a deeper route.
    const at = `${url}/api/models/unload/${encodeURIComponent(wire)}`;
    let res;
    try {
      res = await send(at, { method: "POST", headersTimeoutMs: 30_000 });
    } catch (e) {
      log.warn("backend.unload_model_failed", { url: at, wire, detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
    res.body.resume();
    if (!res.ok) {
      // A refusal is not a drop, and the caller must not think the seat was cleared.
      log.warn("backend.unload_model_refused", { url: at, wire, status: res.status });
      return false;
    }
    return true;
  },
  async placement(url) {
    return placementsOf(await getJson<Running>(`${url}/running`, { headersTimeoutMs: 3_000 }));
  },
};

const ollama: Kind = {
  events: false,
  knowsWarm: true,
  single: false,
  coresident: true,
  async readWarm(url) {
    // /api/ps is a set: several models resident at once, each with its own keep_alive.
    const ps = await getJson<{ models?: { model?: string; name?: string }[] }>(`${url}/api/ps`, { headersTimeoutMs: 3_000 });
    const loaded = (ps.models ?? []).map((m) => m.model ?? m.name ?? "").filter((m) => m !== "");
    return { loaded, loading: [], placements: null };
  },
  async stats(url, wire) {
    const n = await ollamaContext(url, wire);
    return n === null ? {} : { context: n };
  },
};

const single: Kind = {
  events: false,
  knowsWarm: true,
  single: true,
  coresident: false,
  async readWarm(_url, catalog) {
    return { loaded: [...catalog], loading: [], placements: null };
  },
  stats: (url) => openaiStats(url),
};

const none: Kind = {
  events: false,
  knowsWarm: false,
  single: false,
  coresident: false,
  async readWarm() {
    return null;
  },
  async stats() {
    return {};
  },
};

export const KINDS = { "llama-swap": llamaSwap, ollama, single, none } as const satisfies Record<KindName, Kind>;

/** Context for an ollama model from /api/show, which does not load it; `num_ctx` overrides the maximum. */
async function ollamaContext(url: string, wire: string): Promise<number | null> {
  const show = await send(`${url}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    json: { name: wire },
    headersTimeoutMs: 2_000,
  });
  const text = await show.text();
  if (!show.ok) throw new Error(`ollama /api/show returned ${show.status}: ${text.slice(0, 200)}`);
  let parsed: { model_info?: Record<string, unknown>; parameters?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`ollama /api/show did not return JSON: ${text.slice(0, 200)}`);
  }
  let maxCtx: number | null = null;
  for (const [k, v] of Object.entries(parsed.model_info ?? {})) {
    if (k.endsWith(".context_length") && typeof v === "number") {
      maxCtx = v;
      break;
    }
  }
  if (!maxCtx) return null;
  const m = parsed.parameters ? /num_ctx\s+(\d+)/.exec(parsed.parameters) : null;
  if (m) {
    const n = parseInt(m[1]!, 10);
    if (n > 0 && n <= maxCtx) return n;
  }
  return maxCtx;
}

/** Split llama-swap's event-stream payload into the same reading /running gives. */
export function readingFromStatus(models: ModelStatus[]): { catalog: string[]; loaded: string[]; loading: string[] } {
  return {
    catalog: models.map((m) => m.id),
    loaded: models.filter((m) => m.state === READY).map((m) => m.id),
    loading: models.filter((m) => m.state === STARTING).map((m) => m.id),
  };
}
