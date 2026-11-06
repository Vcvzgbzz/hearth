/**
 * MCP for plugins (docs/plugins.md#a-plugin-that-speaks-mcp): checking a served MCP endpoint by its handshake,
 * and running an MCP server that speaks over stdin and stdout behind `/plugins/<name>/mcp`. The program is
 * started once and shared: hearth initializes it itself, answers each caller's `initialize` from that, and gives
 * every request an id of its own on the way in, so callers' ids never meet.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { PluginRun } from "./config.js";
import type { Logger } from "./log.js";

const PROTOCOL = "2025-03-26";
const CLIENT = { name: "hearth", version: "1" };

/** What a plugin's MCP server said of itself, or why it could not be asked. */
export interface McpState {
  /** `http` for a served endpoint, `stdio` for a program hearth runs. */
  transport: "http" | "stdio";
  /** Its own name and version, from its answer to `initialize`. */
  server: string | null;
  tools: number | null;
  error: string | null;
  checkedAt: number;
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown };

const serverName = (r: unknown): string | null => {
  const info = (r as { serverInfo?: { name?: unknown; version?: unknown } } | null)?.serverInfo;
  return typeof info?.name === "string" ? (typeof info.version === "string" ? `${info.name} ${info.version}` : info.name) : null;
};

/** The JSON-RPC answer in a reply that is either JSON or a stream of `data:` lines. */
export function rpcAnswer(text: string, id: number | string): Message | null {
  const one = (s: string): Message | null => { try { return JSON.parse(s) as Message; } catch { return null; } };
  const t = text.trimStart();
  const all = t.startsWith("{") || t.startsWith("[") ? [one(t)].flat() : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => one(l.slice(5).trim()));
  // A server may send a number id back as a string, as a program over stdin may (see StdioMcp.receive).
  const same = (v: unknown) => v === id || (typeof v === "string" && typeof id === "number" && v === String(id));
  return (all.flat() as (Message | null)[]).find((m) => m !== null && same(m.id)) ?? null;
}

/** Asks a served MCP endpoint who it is and how many tools it has, as a client would, and ends the session. */
export async function checkHttp(url: string, key: string | null, timeoutMs: number): Promise<McpState> {
  const base: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const state: McpState = { transport: "http", server: null, tools: null, error: null, checkedAt: Date.now() };
  let session: string | null = null;
  const call = async (body: Message): Promise<Message | null> => {
    const r = await fetch(url, { method: "POST", headers: { ...base, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...body }), signal: AbortSignal.timeout(timeoutMs) });
    session ??= r.headers.get("mcp-session-id");
    if (!r.ok && r.status !== 202) throw new Error(`answered ${r.status}${r.status === 401 || r.status === 403 ? ": it wants a key" : ""}`);
    return body.id === undefined ? null : rpcAnswer(await r.text(), body.id as number);
  };
  try {
    const init = await call({ id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
    if (!init || init.error) throw new Error(init ? `initialize was refused: ${JSON.stringify(init.error)}` : "no answer to initialize");
    state.server = serverName(init.result);
    await call({ method: "notifications/initialized" });
    const tools = await call({ id: 2, method: "tools/list" });
    const list = (tools?.result as { tools?: unknown[] } | undefined)?.tools;
    state.tools = Array.isArray(list) ? list.length : 0;
  } catch (e) {
    state.error = e instanceof Error ? (e.name === "TimeoutError" ? `no answer in ${timeoutMs} ms` : e.message) : String(e);
  } finally {
    if (session) void fetch(url, { method: "DELETE", headers: { ...base, "mcp-session-id": session }, signal: AbortSignal.timeout(timeoutMs) }).catch(() => {});
  }
  return state;
}

/** An answer for the caller: its status, content type and body. */
export interface Answer { status: number; type: string; body: string }

/** One MCP server program, started by hearth and shared by every caller of `/plugins/<name>/mcp`. */
export class StdioMcp {
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending = new Map<number, (m: Message) => void>();
  private init: unknown = null;
  private restarts = 0;
  private stopped = false;
  readonly state: McpState = { transport: "stdio", server: null, tools: null, error: "starting", checkedAt: 0 };

  constructor(private name: string, private run: PluginRun, private log: Logger, private timeoutMs: number) {}

  /** Starts the program and initializes it; a program that exits is started again, waiting longer each time. */
  async start(): Promise<void> {
    this.stopped = false;
    const env: Record<string, string> = { ...this.run.env };
    // The program sees what its config gives it, and what it needs to find and cache its own files.
    for (const k of ["PATH", "HOME", "TMPDIR", "SystemRoot", "APPDATA", "LOCALAPPDATA", "USERPROFILE"]) if (process.env[k] !== undefined && env[k] === undefined) env[k] = process.env[k]!;
    const child = spawn(this.run.command, this.run.args, { env, ...(this.run.cwd ? { cwd: this.run.cwd } : {}), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.receive(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s: string) => this.log.debug("plugin.mcp_stderr", { plugin: this.name, text: s.slice(0, 500) }));
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.init = null;
      for (const [, answer] of this.pending) answer({ id: null, error: { code: -32000, message: `the MCP server ${why}` } });
      this.pending.clear();
      this.state.error = `the MCP server ${why}`;
      this.state.checkedAt = Date.now();
      if (this.stopped) return;
      const wait = Math.min(60_000, 1_000 * 2 ** Math.min(this.restarts++, 6));
      this.log.warn("plugin.mcp_exited", { plugin: this.name, why, restartInMs: wait });
      setTimeout(() => { if (!this.stopped) void this.start(); }, wait).unref();
    };
    child.on("exit", (code, signal) => gone(signal ? `was stopped (${signal})` : `exited with code ${code}`));
    child.on("error", (e) => gone(`could not be started: ${e.message}`));
    try {
      const init = await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
      if (init.error) throw new Error(`initialize was refused: ${JSON.stringify(init.error)}`);
      this.init = init.result;
      this.state.server = serverName(init.result);
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = await this.request("tools/list", {});
      const list = (tools.result as { tools?: unknown[] } | undefined)?.tools;
      this.state.tools = Array.isArray(list) ? list.length : 0;
      this.state.error = null;
      this.restarts = 0;
    } catch (e) {
      this.state.error = e instanceof Error ? e.message : String(e);
    }
    this.state.checkedAt = Date.now();
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }

  private write(m: Message): void {
    this.child?.stdin.write(JSON.stringify(m) + "\n");
  }

  private request(method: string, params: unknown): Promise<Message> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      if (!this.child) return resolve({ id, error: { code: -32000, message: this.state.error ?? "the MCP server is not running" } });
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ id, error: { code: -32001, message: `the MCP server gave no answer in ${this.timeoutMs} ms` } }); }, this.timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** A line from the program: an answer to one of ours, or a request of its own, which hearth does not grant. */
  private receive(line: string): void {
    let m: Message;
    try { m = JSON.parse(line) as Message; } catch { return; }
    if (m.method !== undefined && m.id !== undefined && m.id !== null) {
      this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "hearth does not answer requests from an MCP server" } });
      return;
    }
    // An id sent back as a string ("7" for 7) is still the request it answers.
    const id = typeof m.id === "string" && /^\d+$/.test(m.id) ? Number(m.id) : m.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const answer = this.pending.get(id)!;
      this.pending.delete(id);
      answer({ ...m, id });
      return;
    }
    if (m.id !== undefined && m.id !== null) this.log.warn("plugin.mcp_unmatched", { plugin: this.name, id: m.id, hint: "an answer for no request hearth is waiting on" });
  }

  /**
   * One HTTP request to `/plugins/<name>/mcp`, answered as MCP's streamable HTTP does without a stream: a JSON
   * answer for a request, 202 for a notification, and 405 for the GET that would open a stream of its own.
   */
  async handle(method: string, body: Buffer | undefined): Promise<Answer & { session?: string }> {
    const json = (status: number, v: unknown): Answer => ({ status, type: "application/json", body: JSON.stringify(v) });
    if (method === "DELETE") return { status: 200, type: "text/plain", body: "" };
    if (method !== "POST") return { status: 405, type: "text/plain", body: "this MCP server answers POST only" };
    let msg: Message | Message[];
    try { msg = JSON.parse(body?.toString() ?? "") as Message | Message[]; } catch { return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } }); }
    const one = async (m: Message): Promise<Message | null> => {
      if (m.id === undefined || m.id === null) return null;
      if (m.method === "initialize") {
        if (this.init === null) return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: this.state.error ?? "the MCP server is not ready" } };
        return { jsonrpc: "2.0", id: m.id, result: this.init };
      }
      const a = await this.request(m.method ?? "", m.params);
      return { jsonrpc: "2.0", id: m.id, ...(a.error !== undefined ? { error: a.error } : { result: a.result }) };
    };
    // Notifications go on to the program, but its own `initialized` was sent by hearth already.
    const notify = (m: Message) => { if ((m.id === undefined || m.id === null) && m.method && m.method !== "notifications/initialized") this.write({ jsonrpc: "2.0", method: m.method, params: m.params }); };
    const list = Array.isArray(msg) ? msg : [msg];
    // In the batch's order: each request is written to the program as `one` starts it, so a notification before it goes first.
    const answers = (await Promise.all(list.map((m) => { notify(m); return one(m); }))).filter((a): a is Message => a !== null);
    const session = list.some((m) => m.method === "initialize") ? randomUUID() : undefined;
    if (answers.length === 0) return { status: 202, type: "text/plain", body: "" };
    return { ...json(200, Array.isArray(msg) ? answers : answers[0]), ...(session ? { session } : {}) };
  }
}
