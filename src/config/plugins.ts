/**
 * Plugins: what each one is, where it runs, and the lines it sits on.
 */
import { asRecord, bad, bool, only, resolveSecret, str, stringList } from "./read.js";

/**
 * What hearth sends a plugin service on every call: its `key` as a bearer token and its own `headers`, names
 * lowercased so one of them replaces a caller's header of the same name. A header named `authorization` wins over `key`.
 */
export function pluginAuth(decl: { key: string | null; headers?: Record<string, string> }): Record<string, string> {
  const more = Object.fromEntries(Object.entries(decl.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  return { ...(decl.key ? { authorization: `Bearer ${decl.key}` } : {}), ...more };
}

/** What a request is, which decides the plugins that may see it. hearth sets it; a client or plugin cannot. */
export const REQUEST_KINDS = ["chat", "embeddings", "rerank", "image", "video", "speech", "transcription", "other"] as const;

export type RequestKind = (typeof REQUEST_KINDS)[number];

/** Points in a request's life a plugin can hook, in the order a request meets them. */
export const PLUGIN_STAGES = ["request", "routed", "parallel", "stream", "response", "log", "error"] as const;

export type PluginStage = (typeof PLUGIN_STAGES)[number];

/** Conditions a plugin's `when` may test: the request's own facts, never the node's load. */
export interface PluginWhen {
  asked?: string[];
  askedNot?: string[];
  caller?: string[];
  callerNot?: string[];
  lane?: string[];
  target?: ("local" | "peer")[];
  header?: Record<string, string[]>;
}

/** `plugins.<name>`: code or a service that reads or changes requests at the stages it hooks. */
export interface PluginDecl {
  /** `file:<path>` or `npm:<package>@<version>` for code; an http(s) URL for a service. Null for a plugin that only `serves`. */
  use: string | null;
  /** A service's own API, answered at `/plugins/<name>/*`; null when it has none. */
  serves: string | null;
  /** The path under `serves` where an MCP endpoint answers (`/mcp` for a plugin that runs one); null when it speaks no MCP. */
  mcp: string | null;
  /** An MCP server hearth starts and speaks to over stdin and stdout, answered at `/plugins/<name>/mcp`; null when it has none. */
  run: PluginRun | null;
  trust: "code" | "http";
  /** For `file:`, the sha256 of the file, as `sha256-<hex>`; a file that differs is not loaded. */
  integrity: string | null;
  /** For a service: sent as a bearer token on every call, so the service can tell hearth from anyone else. */
  key: string | null;
  /** For a service: headers sent on every call beside (or instead of) its key, such as an API that reads its key from `X-Api-Key`. Values may be `env:NAME`. */
  headers: Record<string, string>;
  /** Another plugin that answers `/plugins/<name>/*` when this one cannot; it serves the same API and is sent the same request. */
  fallback: { plugin: string } | null;
  /** Narrows what the plugin itself declares; absent hooks all of it. */
  kinds: Partial<Record<RequestKind, PluginStage[]>> | null;
  when: PluginWhen | null;
  timeoutMs: number;
  /** The plugin could not answer: carry on without it, or refuse the request. */
  onError: "skip" | "refuse";
  /** The plugin said no: refuse, or let it through marked. */
  onFail: "refuse" | "flag";
  /** No router may turn it off. */
  locked: boolean;
  /** A plugin that fails to start stops the node instead of being turned off. */
  required: boolean;
  /** What a service is sent: the messages, the headers, the reply. Code sees all of it. */
  reads: ("messages" | "headers" | "reply")[];
  /** Runs on every request of its kinds, on every line, before routing as well as after; otherwise it runs where a flow step places it. */
  everyLine: boolean;
  /** The models wired into its slots, by slot name: the default wherever it runs. */
  models: Record<string, string>;
  config: Record<string, unknown>;
}

/** A program hearth starts as an MCP server. `env` values may be `env:NAME`; the program sees these, and of hearth's own only what it needs to find and cache its files (PATH, HOME, TMPDIR). */
export interface PluginRun { command: string; args: string[]; env: Record<string, string>; cwd: string | null }

/** A plugin placed on a flow step, with the models this line wires into its slots over the plugin's own. */
export interface StepPlugin { name: string; models: Record<string, string> }

/** A router's say over global plugins: turn one off, or give it settings of its own. */
export type RouterPlugin = "off" | { config: Record<string, unknown> };

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `models:` on a plugin or a placement: slot name to model id. Which slots exist is the plugin's to say, checked once it has started. */
export function slotModels(raw: unknown, at: string): Record<string, string> {
  if (raw === undefined) return {};
  const out: Record<string, string> = {};
  for (const [slot, id] of Object.entries(asRecord(raw, at))) out[slot] = str(id, `${at}.${slot}`);
  return out;
}

function pluginWhen(raw: unknown, at: string): PluginWhen | null {
  if (raw === undefined || raw === null) return null;
  const w = asRecord(raw, at);
  only(w, ["asked", "askedNot", "caller", "callerNot", "lane", "target", "header"], at);
  const out: PluginWhen = {};
  for (const k of ["asked", "askedNot", "caller", "callerNot", "lane"] as const) if (w[k] !== undefined) out[k] = stringList(w[k], `${at}.${k}`);
  if (w.target !== undefined) {
    const t = stringList(w.target, `${at}.target`);
    if (t.some((x) => x !== "local" && x !== "peer")) throw bad(`${at}.target`, "takes local and/or peer");
    out.target = t as ("local" | "peer")[];
  }
  if (w.header !== undefined) {
    out.header = Object.fromEntries(Object.entries(asRecord(w.header, `${at}.header`)).map(([h, v]) => [h.toLowerCase(), stringList(v, `${at}.header.${h}`)]));
  }
  return out;
}

/** `plugins.<name>.run`: the program an MCP server is, started by hearth and spoken to over its stdin and stdout. */
function pluginRun(raw: unknown, at: string): PluginRun | null {
  if (raw === undefined) return null;
  const r = asRecord(raw, at);
  only(r, ["command", "args", "env", "cwd"], at);
  const command = str(r.command, `${at}.command`);
  const args = r.args === undefined ? [] : stringList(r.args, `${at}.args`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(r.env ?? {}, `${at}.env`))) env[k] = resolveSecret(str(v, `${at}.env.${k}`), `${at}.env.${k}`);
  return { command, args, env, cwd: r.cwd === undefined ? null : str(r.cwd, `${at}.cwd`) };
}

/** `plugins:`. A plugin is code only when its entry says `trust: code`, so copying a line never runs code by accident. */
export function pluginDecls(raw: unknown): Record<string, PluginDecl> {
  const out: Record<string, PluginDecl> = {};
  for (const [name, v] of Object.entries(asRecord(raw ?? {}, "plugins"))) {
    const at = `plugins.${name}`;
    if (!PLUGIN_NAME.test(name)) throw bad(at, "a plugin's name is lowercase letters, digits and dashes");
    const r = asRecord(v, at);
    only(r, ["use", "serves", "mcp", "run", "trust", "integrity", "key", "headers", "fallback", "kinds", "when", "timeoutMs", "onError", "onFail", "locked", "required", "peers", "reads", "everyLine", "models", "config"], at);
    const serves = r.serves === undefined ? null : str(r.serves, `${at}.serves`).replace(/\/$/, "");
    if (serves !== null && !/^https?:\/\/[^/]/.test(serves)) throw bad(`${at}.serves`, "is the http(s) URL of the service's own API");
    const run = pluginRun(r.run, `${at}.run`);
    if (run !== null && serves !== null) throw bad(`${at}.run`, "starts an MCP server here, so the plugin serves nothing else: leave serves out");
    // `/plugins/probe` is the console's own route, so a plugin of that name could never be reached.
    if ((serves !== null || run !== null) && name === "probe") throw bad(at, "a plugin that serves cannot be named probe: /plugins/probe is taken");
    if (r.use === undefined && serves === null && run === null) throw bad(`${at}.use`, "is required, unless the plugin only serves an API (serves: <url>) or runs an MCP server (run: { command })");
    if (r.use !== undefined && run !== null) throw bad(`${at}.run`, "is a plugin of its own: an MCP server hearth starts; leave use out");
    // `mcp` on a served API names the path its MCP endpoint answers at; a plugin that runs one is an MCP server.
    if (r.mcp !== undefined && serves === null) throw bad(`${at}.mcp`, run !== null ? "is implied by run" : "says a served API speaks MCP: it needs serves");
    const mcp = run !== null ? "/mcp" : r.mcp === undefined || r.mcp === false ? null : r.mcp === true ? "/mcp" : str(r.mcp, `${at}.mcp`);
    if (mcp !== null && !mcp.startsWith("/")) throw bad(`${at}.mcp`, "is true, or the path its MCP endpoint answers at, like /mcp");
    const use = r.use === undefined ? null : str(r.use, `${at}.use`);
    const service = run === null && (use === null || /^https?:\/\//.test(use));
    if (use !== null && !service && !/^(file:.+|npm:(@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/.test(use)) throw bad(`${at}.use`, "is file:<path>, npm:<package>@<exact version, like 1.2.3>, or an http(s) URL");
    if (serves !== null && !service) throw bad(`${at}.serves`, "is for a service; code answers its own routes inside hearth");
    const trust = r.trust;
    if (trust !== "code" && trust !== "http") throw bad(`${at}.trust`, run !== null ? "must be code: run starts a program on this machine, and saying so is the opt-in" : service ? "must be http for a service" : "must be code: this plugin runs inside hearth, and saying so is the opt-in");
    if (service !== (trust === "http")) throw bad(`${at}.trust`, run !== null ? "run starts a program on this machine: trust: code" : service ? "a URL is a service: trust: http" : "a file or package runs inside hearth: trust: code");
    if (r.peers !== undefined && r.peers !== false) throw bad(`${at}.peers`, "plugins on requests peers send here are not built yet; leave it unset");
    let kinds: PluginDecl["kinds"] = null;
    if (r.kinds !== undefined) {
      kinds = {};
      for (const [k, stages] of Object.entries(asRecord(r.kinds, `${at}.kinds`))) {
        if (!(REQUEST_KINDS as readonly string[]).includes(k)) throw bad(`${at}.kinds.${k}`, `is not a request kind (${REQUEST_KINDS.join(", ")})`);
        const list = stringList(stages, `${at}.kinds.${k}`);
        for (const st of list) if (!(PLUGIN_STAGES as readonly string[]).includes(st)) throw bad(`${at}.kinds.${k}`, `"${st}" is not a stage (${PLUGIN_STAGES.join(", ")})`);
        kinds[k as RequestKind] = list as PluginStage[];
      }
    }
    const reads = r.reads === undefined ? ["messages"] : stringList(r.reads, `${at}.reads`);
    for (const x of reads) if (!["messages", "headers", "reply"].includes(x)) throw bad(`${at}.reads`, `"${x}" is not messages, headers or reply`);
    const timeoutMs = r.timeoutMs === undefined ? (service ? 300 : 1000) : r.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw bad(`${at}.timeoutMs`, "must be a number of ms, 1 or more");
    const pick = <T extends string>(v: unknown, opts: readonly T[], def: T, where: string): T => {
      if (v === undefined) return def;
      if (typeof v !== "string" || !(opts as readonly string[]).includes(v)) throw bad(where, `must be ${opts.join(" or ")}`);
      return v as T;
    };
    const integrity = r.integrity === undefined ? null : str(r.integrity, `${at}.integrity`);
    if (r.key !== undefined && !service) throw bad(`${at}.key`, "is for a service; code runs inside hearth and needs none");
    const key = r.key === undefined ? null : resolveSecret(str(r.key, `${at}.key`), `${at}.key`);
    if (r.headers !== undefined && !service) throw bad(`${at}.headers`, "is for a service; code runs inside hearth and needs none");
    const headers = Object.fromEntries(Object.entries(asRecord(r.headers ?? {}, `${at}.headers`))
      .map(([k, v]) => [k, resolveSecret(str(v, `${at}.headers.${k}`), `${at}.headers.${k}`)]));
    if (integrity !== null && !/^sha256-[0-9a-f]{64}$/.test(integrity)) throw bad(`${at}.integrity`, "is sha256-<64 hex digits>");
    let fallback: PluginDecl["fallback"] = null;
    if (r.fallback !== undefined) {
      const f = typeof r.fallback === "string" ? { plugin: r.fallback } : asRecord(r.fallback, `${at}.fallback`);
      if (typeof r.fallback !== "string") only(f, ["plugin"], `${at}.fallback`);
      if (serves === null || mcp !== null) throw bad(`${at}.fallback`, "is for a plugin that serves an API other than MCP");
      fallback = { plugin: str(f.plugin, `${at}.fallback.plugin`) };
    }
    out[name] = {
      use, serves, mcp, run, trust, integrity, key, headers, fallback, kinds, when: pluginWhen(r.when, `${at}.when`), timeoutMs,
      onError: pick(r.onError, ["skip", "refuse"] as const, "skip", `${at}.onError`),
      onFail: pick(r.onFail, ["refuse", "flag"] as const, "refuse", `${at}.onFail`),
      locked: bool(r.locked, `${at}.locked`, false),
      required: bool(r.required, `${at}.required`, false),
      reads: reads as PluginDecl["reads"],
      everyLine: bool(r.everyLine, `${at}.everyLine`, false),
      models: slotModels(r.models, `${at}.models`),
      config: r.config === undefined ? {} : asRecord(r.config, `${at}.config`),
    };
  }
  // A fallback is one hop: the plugin it names answers with its own API and is not followed further.
  for (const [name, p] of Object.entries(out)) {
    if (p.fallback === null) continue;
    const at = `plugins.${name}.fallback`;
    const to = out[p.fallback.plugin];
    if (p.fallback.plugin === name) throw bad(at, "names the plugin itself");
    if (!to) throw bad(at, `names ${p.fallback.plugin}, which is not a plugin under plugins:`);
    if (to.serves === null || to.mcp !== null) throw bad(at, `names ${p.fallback.plugin}, which serves no API other than MCP`);
  }
  return out;
}

/** `routers.<name>.plugins`: only global plugins, and never a locked one turned off. */
export function routerPlugins(raw: unknown, at: string, plugins: Record<string, PluginDecl>): Record<string, RouterPlugin> {
  const out: Record<string, RouterPlugin> = {};
  for (const [name, v] of Object.entries(asRecord(raw ?? {}, at))) {
    const p = plugins[name];
    if (!p) throw bad(`${at}.${name}`, "is not a plugin under plugins:");
    if (v === "off") {
      if (p.locked) throw bad(`${at}.${name}`, "is locked: no router can turn it off");
      if (!p.everyLine) throw bad(`${at}.${name}`, "runs only on the lines it is placed on: take it off this router's lines instead");
      out[name] = "off";
    } else {
      const r = asRecord(v, `${at}.${name}`);
      only(r, ["config"], `${at}.${name}`);
      out[name] = { config: asRecord(r.config ?? {}, `${at}.${name}.config`) };
    }
  }
  return out;
}
