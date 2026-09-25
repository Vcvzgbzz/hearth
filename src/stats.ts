/**
 * What a model can take and what a request needs, compared before dispatch. Every field is
 * optional on both sides: no claim means no objection.
 */

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

/** What a chat template says when the model behind it reasons. */
const THINKS = /<\/?think>|enable_thinking|reasoning_content/;

/** llama.cpp /props -> stats. Every field independently optional: builds differ,
 *  and one missing key must not cost us the others. */
export function statsFromProps(props: unknown): ModelStats {
  const p = (props ?? {}) as Record<string, unknown>;
  const out: ModelStats = {};
  const gen = p.default_generation_settings as { n_ctx?: unknown } | undefined;
  if (typeof gen?.n_ctx === "number" && gen.n_ctx > 0) out.context = gen.n_ctx;
  const mods = p.modalities as { vision?: unknown } | undefined;
  if (typeof mods?.vision === "boolean") out.vision = mods.vision;
  const caps = p.chat_template_caps as {
    supports_tools?: unknown; supports_reasoning_effort?: unknown; supports_preserve_reasoning?: unknown;
  } | undefined;
  if (typeof caps?.supports_tools === "boolean") out.tools = caps.supports_tools;
  if (typeof caps?.supports_reasoning_effort === "boolean") out.effort = caps.supports_reasoning_effort;
  // Any one sign is enough; none is not a "no" (see ModelStats.thinking).
  if (
    caps?.supports_reasoning_effort === true
    || caps?.supports_preserve_reasoning === true
    || (typeof p.chat_template === "string" && THINKS.test(p.chat_template))
  ) out.thinking = true;
  if (typeof p.model_ftype === "string" && p.model_ftype !== "") out.quant = p.model_ftype;
  return out;
}

/** vLLM /v1/models -> stats. One process serves one window, whatever names it answers to. */
export function statsFromModels(body: unknown): ModelStats {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return {};
  for (const d of data) {
    const n = (d as { max_model_len?: unknown } | null)?.max_model_len;
    if (typeof n === "number" && n > 0) return { context: n };
  }
  return {};
}

/** Anything at all learned? An empty object is not worth caching or sending. */
export function known(s: ModelStats): boolean {
  return s.context !== undefined || s.vision !== undefined || s.tools !== undefined
    || s.thinking !== undefined || s.effort !== undefined || s.quant !== undefined
    || s.note !== undefined;
}

/** Drop anything that is not the type it claims to be. Peer input: a field that
 *  arrives as a string would otherwise be compared against a number and quietly
 *  decide routing. */
export function cleanStats(v: unknown): ModelStats | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const s = v as Record<string, unknown>;
  const out: ModelStats = {};
  if (typeof s.context === "number" && s.context > 0) out.context = s.context;
  if (typeof s.vision === "boolean") out.vision = s.vision;
  if (typeof s.tools === "boolean") out.tools = s.tools;
  if (typeof s.thinking === "boolean") out.thinking = s.thinking;
  if (typeof s.effort === "boolean") out.effort = s.effort;
  if (typeof s.quant === "string") out.quant = s.quant.slice(0, 40);
  if (typeof s.note === "string" && s.note !== "") out.note = s.note.slice(0, NOTE_MAX);
  if (!known(out)) return undefined;
  // Provenance survives the peer hop: a lender that DECLARED a window rather
  // than measuring it is telling the borrower something real about how much to
  // trust the number.
  if (s.from === "declared" || s.from === "observed" || s.from === "both") out.from = s.from;
  return out;
}

/** Declared stats under observed ones, per field: the running process wins where it reports. */
export function mergeStats(
  declared: ModelStats | null | undefined,
  observed: ModelStats | null | undefined,
): ModelStats | null {
  if (!declared && !observed) return null;
  if (!declared) return { ...observed!, from: "observed" };
  if (!observed) return { ...declared, from: "declared" };
  // Spreading is per-field precisely because statsFromProps only sets the keys
  // it actually saw: an absent `vision` is an absent KEY, not an undefined one,
  // so it cannot overwrite a declared value with nothing.
  return { ...declared, ...observed, from: "both" };
}

/** What one request is asking a model for. */
export interface Need {
  /** Prompt plus reserved output, estimated. See estimate(). */
  tokens: number;
  /** The reserved output alone (`max_tokens`), already counted in `tokens`. */
  output?: number;
  images: boolean;
  tools: boolean;
}

/**
 * ponytail: chars/3.5, not a tokenizer; reads dense text about a tenth low, the safe side for
 * a check that only refuses. Upgrade: /tokenize on a warm model, cached per prefix.
 */
const CHARS_PER_TOKEN = 3.5;
/** A rough per-message framing cost (role, delimiters). */
const PER_MESSAGE = 4;
/** One image, flat, sized high: counting its base64 would put every vision request over every window. */
const TOKENS_PER_IMAGE = 1600;

const chars = (v: unknown): number => (typeof v === "string" ? v.length : 0);

/** What this chat payload needs, without tokenizing: prompt plus reserved `max_tokens`. */
export function needsOf(payload: Record<string, unknown>): Need {
  let text = 0;
  let images = 0;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const raw of messages) {
    text += PER_MESSAGE * CHARS_PER_TOKEN;
    const m = (raw ?? {}) as Record<string, unknown>;
    text += chars(m.role) + chars(m.name);
    if (typeof m.content === "string") {
      text += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const raw2 of m.content) {
        const part = (raw2 ?? {}) as Record<string, unknown>;
        // Both spellings in the wild: OpenAI's image_url, and the input_image
        // of the newer responses-style bodies some clients send anyway.
        if (part.type === "image_url" || part.type === "input_image" || part.image_url) {
          images++;
        } else {
          text += chars(part.text);
        }
      }
    }
    // Tool results are content too, and they are the big ones in an agent loop.
    if (Array.isArray(m.tool_calls)) text += JSON.stringify(m.tool_calls).length;
  }
  const tools = Array.isArray(payload.tools) && payload.tools.length > 0;
  if (tools) text += JSON.stringify(payload.tools).length;
  const reserve = typeof payload.max_tokens === "number"
    ? payload.max_tokens
    : typeof payload.max_completion_tokens === "number"
      ? payload.max_completion_tokens
      : 0;
  return {
    tokens: Math.ceil(text / CHARS_PER_TOKEN) + images * TOKENS_PER_IMAGE + Math.max(0, reserve),
    output: Math.max(0, reserve),
    images: images > 0,
    tools,
  };
}

/** Smallest output worth shrinking `max_tokens` to; below it the client is refused so it can compact. */
const MIN_OUTPUT = 1024;
/** Headroom for what a chat template adds around the messages. */
const TEMPLATE_TOKENS = 256;

/**
 * When only the reserved output overflows, lower `max_tokens` to the room the prompt leaves
 * (prompt padded a tenth, plus template headroom) and return the resulting need.
 */
export function fitOutput(stats: ModelStats | undefined | null, need: Need, payload: Record<string, unknown>): Need {
  const context = stats?.context;
  const output = need.output ?? 0;
  if (context === undefined || need.tokens <= context || output === 0) return need;
  const room = context - Math.ceil((need.tokens - output) * 1.1) - TEMPLATE_TOKENS;
  if (room < MIN_OUTPUT || room >= output) return need;
  payload[typeof payload.max_tokens === "number" ? "max_tokens" : "max_completion_tokens"] = room;
  return { ...need, tokens: need.tokens - output + room, output: room };
}

/** Why this model cannot take this request, or null. Refuses only on reported facts. */
export function unfit(stats: ModelStats | undefined | null, need: Need): string | null {
  if (!stats) return null;
  if (need.images && stats.vision === false) return "does not accept images";
  if (need.tools && stats.tools === false) return "does not support tool calls";
  if (stats.context !== undefined && need.tokens > stats.context) {
    // Agent harnesses key on the trailing phrase to compact and retry; the numbers stay first for people.
    return `needs about ${need.tokens} tokens, its context window is ${stats.context} (context length exceeded)`;
  }
  return null;
}
