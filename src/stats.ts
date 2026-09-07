/**
 * What a model can take, and what a request needs.
 *
 * Borrowing made this necessary. Everything on this box is something you chose
 * and can go look up; a model on someone else's machine is a black box with a
 * name, and the first thing you find out the hard way is its context window —
 * usually as a 400 from a stranger's llama.cpp, halfway through an agent loop,
 * after the prompt has already crossed the network.
 *
 * So: learn the few facts that decide whether a request can run at all, carry
 * them over the peer protocol, and compare before dispatching rather than
 * after. Everything here is OPTIONAL on both sides. A backend that reports
 * nothing, a peer speaking an older protocol, a model that has never been
 * loaded — all of them come back with no claim, and no claim means no
 * objection. Refusing what we cannot measure would break every backend that
 * does not answer /props, which includes every one of them until the first
 * load lands.
 */

/**
 * The facts about a model that change what you can send it.
 *
 * Deliberately small. Everything here is (a) free — one /props call already on
 * the warm path answers all of it, (b) STABLE for the life of the loaded
 * process, so it can be cached, and (c) actionable: each field can refuse a
 * request or move it to another node. Token rates and load times are neither
 * stable nor free, and they belong in the call history, which already has them.
 */
export interface ModelStats {
  /** Tokens the process was launched with (-c), NOT what the weights support. */
  context?: number;
  /** Accepts images. */
  vision?: boolean;
  /** Its chat template can express tool calls. */
  tools?: boolean;
  /**
   * Its chat template takes a `reasoning_effort`, so asking for more or less
   * thinking reaches the model instead of being dropped.
   *
   * A capability, not a setting: llama.cpp does not report the launch-time
   * budget, so this says the lever EXISTS, never where it is set. Whether the
   * model then obeys the level is a question about the model, and not one a
   * status page should pretend to answer.
   */
  thinking?: boolean;
  /** e.g. "Q5_K - Medium". Cosmetic, but it is the only quality signal you get
   *  about a model running on hardware you do not own. */
  quant?: string;
}

/** llama.cpp /props -> stats. Every field independently optional: builds differ,
 *  and one missing key must not cost us the others. */
export function statsFromProps(props: unknown): ModelStats {
  const p = (props ?? {}) as Record<string, unknown>;
  const out: ModelStats = {};
  const gen = p.default_generation_settings as { n_ctx?: unknown } | undefined;
  if (typeof gen?.n_ctx === "number" && gen.n_ctx > 0) out.context = gen.n_ctx;
  const mods = p.modalities as { vision?: unknown } | undefined;
  if (typeof mods?.vision === "boolean") out.vision = mods.vision;
  const caps = p.chat_template_caps as
    { supports_tools?: unknown; supports_reasoning_effort?: unknown } | undefined;
  if (typeof caps?.supports_tools === "boolean") out.tools = caps.supports_tools;
  if (typeof caps?.supports_reasoning_effort === "boolean") out.thinking = caps.supports_reasoning_effort;
  if (typeof p.model_ftype === "string" && p.model_ftype !== "") out.quant = p.model_ftype;
  return out;
}

/** Anything at all learned? An empty object is not worth caching or sending. */
export function known(s: ModelStats): boolean {
  return s.context !== undefined || s.vision !== undefined || s.tools !== undefined
    || s.thinking !== undefined || s.quant !== undefined;
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
  if (typeof s.quant === "string") out.quant = s.quant.slice(0, 40);
  return known(out) ? out : undefined;
}

/** What one request is asking a model for. */
export interface Need {
  /** Prompt plus reserved output, estimated. See estimate(). */
  tokens: number;
  images: boolean;
  tools: boolean;
}

/**
 * ponytail: chars/3.5, not a tokenizer. Real tokenization means shipping a
 * vocab per model or asking the backend — which loads it — and both cost more
 * than this decision is worth. Measured under-counts dense text by roughly a
 * tenth, which is the safe direction: this only ever REFUSES, so reading low
 * errs toward letting a borderline request through to the backend that can
 * actually count. Upgrade path if that stops being good enough: /tokenize on
 * an already-warm model, cached per prompt prefix.
 */
const CHARS_PER_TOKEN = 3.5;
/** A rough per-message framing cost (role, delimiters). */
const PER_MESSAGE = 4;
/**
 * One image, flat. Its base64 is tens of thousands of characters and costs
 * around a thousand tokens, so counting those characters would put every vision
 * request over every window — the check would refuse exactly the traffic it
 * exists to protect. Sized high on purpose: over-counting an image costs a
 * request one node, under-counting costs it the whole window.
 */
const TOKENS_PER_IMAGE = 1600;

const chars = (v: unknown): number => (typeof v === "string" ? v.length : 0);

/**
 * What this chat payload needs, without tokenizing anything.
 *
 * Output counts. `max_tokens` is reserved out of the same window as the prompt,
 * so a 30k prompt with 8k reserved does not fit a 32k model, and a check that
 * looked only at the prompt would have said it did.
 */
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
    images: images > 0,
    tools,
  };
}

/**
 * Why this model cannot take this request, or null if nothing says it can't.
 *
 * Null is the answer for an unknown model, and that is the whole design: we
 * refuse only on a fact somebody reported. The backend remains the authority —
 * this just moves the common refusals to the near side of the network, where
 * the message can name both numbers and where the request can still be sent
 * somewhere else instead.
 */
/**
 * Note what is NOT here: thinking.
 *
 * A `reasoning_effort` a template cannot express is ignored by the backend, and
 * the request runs and answers. Refusing it would break work that would have
 * succeeded, to protect nobody — the cost is a shallower answer, which is a
 * thing to SEE (the console shows which models take the lever) and not a thing
 * to fail. Everything in this function is a request that genuinely cannot run.
 */
export function unfit(stats: ModelStats | undefined | null, need: Need): string | null {
  if (!stats) return null;
  if (need.images && stats.vision === false) return "does not accept images";
  if (need.tools && stats.tools === false) return "does not support tool calls";
  if (stats.context !== undefined && need.tokens > stats.context) {
    return `needs about ${need.tokens} tokens, its context window is ${stats.context}`;
  }
  return null;
}
