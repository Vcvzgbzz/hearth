/**
 * Per-model settings: params, efforts, slots, price, pool, and the stats an operator declares.
 */


import { asRecord, atLeast, bad, count, only, str } from "./read.js";

export interface ModelRoute {
  /** Which backend serves it. null means "work it out from the catalogs".
   *  Naming one is how you break a tie when two backends offer the same id. */
  backend: string | null;
  /** The id sent to the backend when it differs from the advertised one; null when they match. */
  as: string | null;
  /**
   * Go out as whatever `backend` has resident right now, and as `as` only when
   * nothing is loaded there. For clients pinned to one id on a card whose seat
   * gets swapped by hand: a fixed id would swap the card back on every request.
   */
  follow: boolean;
  /**
   * Request fields stamped on every chat completion for this id, after `as` and over the
   * client's own, so several ids can front one resident model with different defaults.
   * Local dispatch only.
   */
  params: Record<string, unknown> | null;
  /**
   * Request fields stamped when a call asks for one `reasoning_effort`, keyed by that level: the
   * lever for a model whose template has another switch. Read on the asked id and on the seat it lands on.
   */
  efforts?: Record<string, Record<string, unknown>>;
  /** The lane every request for this id queues in, over the client's; null lets the client choose. */
  lane: string | null;
  /** What this model can take when nothing can be asked; observed values win field by field. */
  stats: ModelStats | null;
  /** Reshapes this id's backend answers into another server's format; see emulate.ts. */
  emulate: Emulation | null;
  /** Tokens the model's running requests share (vLLM's KV cache, llama.cpp `--kv-unified`); `output` caps each request's counted `max_tokens`, null counts it whole. */
  pool: { tokens: number; output: number | null } | null;
  /** What a million tokens in and out cost, in dollars, where using this model is paid for. null is not priced. */
  price: { in: number; out: number; cached?: number } | null;
  /** A turn shares the backend with this model's running turns only once each has run this long; unset never waits. */
  shareAfterMs?: number;
  /** How long an answer is kept for an identical request; unset or 0 keeps none. */
  cacheMs?: number;
  /**
   * Jobs this model may run at once locally, overriding the backend's `concurrency` either way:
   * vLLM's --max-num-seqs above it, llama.cpp's --parallel below it. A raise applies only while
   * this model is the only one running. `batch:` is the older name.
   */
  concurrency: number | null;
  /** Tokens one video costs this model when sizing a request; unset uses the flat default. */
  videoTokens?: number;
}

/**
 * Declared stats, for a model that has never loaded or a backend that cannot report them.
 * A prediction: the running process wins once it loads. Bad values are errors, unlike a peer's.
 */
export function declaredStats(raw: unknown, id: string): ModelStats | null {
  if (raw === undefined || raw === null) return null;
  const where = `models.${id}.stats`;
  const rec = asRecord(raw, where);
  const out: ModelStats = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "context") {
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw bad(`${where}.context`, `is "${String(v)}" -- expected a positive whole number of tokens`);
      }
      out.context = v;
    } else if (k === "vision" || k === "tools" || k === "thinking" || k === "effort") {
      if (typeof v !== "boolean") {
        throw bad(`${where}.${k}`, `is "${String(v)}" -- expected true or false`);
      }
      out[k] = v;
    } else if (k === "quant") {
      out.quant = str(v, `${where}.quant`);
    } else {
      throw bad(`${where}.${k}`, "is not a model stat -- expected context, vision, tools, thinking, effort or quant");
    }
  }
  return known(out) ? out : null;
}

export function modelParams(raw: unknown, id: string, where = `models.${id}.params`): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  const rec = asRecord(raw, where);
  for (const k of ["model", "messages", "stream", "lane"]) {
    if (k in rec) {
      throw bad(
        `${where}.${k}`, "cannot be stamped -- " +
          (k === "model" ? "use `as` to rename the model on the wire" : `${k} belongs to the request, not the route`),
      );
    }
  }
  return Object.keys(rec).length === 0 ? null : rec;
}

/** `efforts: { none: { … } }`: per level, fields checked like `params`. Empty levels are dropped. */
export function modelEfforts(raw: unknown, id: string): Record<string, Record<string, unknown>> | null {
  if (raw === undefined || raw === null) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [level, fields] of Object.entries(asRecord(raw, `models.${id}.efforts`))) {
    const p = modelParams(fields, id, `models.${id}.efforts.${level}`);
    if (p !== null) out[level] = p;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** A model's own slot count, or null to take its backend's. */
export function modelConcurrency(entry: Record<string, unknown>, id: string): number | null {
  if (entry.concurrency === undefined || entry.concurrency === null) return null;
  return count(entry.concurrency, `models.${id}.concurrency`, 1, 1);
}

/** `price: { in: 3, out: 15, cached: 0.3 }`: dollars per million tokens; `cached` is for input read from the provider's prompt cache. */
export function modelPrice(v: unknown, id: string): ModelRoute["price"] {
  if (v === undefined || v === null) return null;
  const p = asRecord(v, `models.${id}.price`);
  only(p, "price", `models.${id}.price`);
  return {
    in: atLeast(p.in, `models.${id}.price.in`, 0), out: atLeast(p.out, `models.${id}.price.out`, 0),
    ...(p.cached !== undefined ? { cached: atLeast(p.cached, `models.${id}.price.cached`, 0) } : {}),
  };
}

/** `pool: 144000`, or `pool: { tokens: 144000, output: 8192 }`. */
export function modelPool(v: unknown, id: string): ModelRoute["pool"] {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return { tokens: count(v, `models.${id}.pool`, 1, 1), output: null };
  const p = asRecord(v, `models.${id}.pool`);
  only(p, "pool", `models.${id}.pool`);
  return {
    tokens: count(p.tokens, `models.${id}.pool.tokens`, 0, 1),
    output: p.output === undefined || p.output === null ? null : count(p.output, `models.${id}.pool.output`, 1, 1),
  };
}

/** The stable, cacheable facts about a loaded model that can refuse a request or move it. */
export interface ModelStats {
  /** Tokens the process was launched with (-c), NOT what the weights support. */
  context?: number;
  /** Accepts images. */
  vision?: boolean;
  /** Its chat template can express tool calls. */
  tools?: boolean;
  /** It reasons before answering. Observed only as true; `false` is an operator's declaration. */
  thinking?: boolean;
  /** Its template takes `reasoning_effort`. Says the lever exists, not where it is set. */
  effort?: boolean;
  /** e.g. "Q5_K - Medium". Cosmetic, but it is the only quality signal you get
   *  about a model running on hardware you do not own. */
  quant?: string;
  /** The operator's own words on what the model is for and how to use it. */
  note?: string;
  /** Provenance: a declared value is unverified until the process reports its own. */
  from?: "declared" | "observed" | "both";
}

/** A note is a sentence or two, not a manual. */
export const NOTE_MAX = 500;

/** Anything at all learned? An empty object is not worth caching or sending. */
export function known(s: ModelStats): boolean {
  return s.context !== undefined || s.vision !== undefined || s.tools !== undefined
    || s.thinking !== undefined || s.effort !== undefined || s.quant !== undefined
    || s.note !== undefined;
}

export type Emulation = "llama-server";

export const EMULATIONS: readonly Emulation[] = ["llama-server"];
