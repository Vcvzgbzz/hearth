/**
 * What every route handler is given: the node's services, and the request it is answering. Each
 * file under `routes/` takes a `RouteContext` and returns its handlers; `server.ts` puts them in
 * the route table.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Answers } from "../wire/answers.js";
import type { Callers } from "../access/callers.js";
import type { createCanary } from "../observe/canary.js";
import type { BackendConfig } from "../config/backends.js";
import type { HearthConfig } from "../config/config.js";
import type { ConfigFile } from "../config/configfile.js";
import type { Controls } from "../peers/controls.js";
import type { History } from "../observe/history.js";
import type { Limits } from "../access/limits.js";
import type { Logger, LogRing } from "../observe/log.js";
import type { PeerRegistry } from "../peers/peers.js";
import type { Plugins } from "../plugins/plugins.js";
import type { BackendPool } from "../queue/pool.js";
import type { RequestLog } from "../observe/requestlog.js";
import type { tailscaleWhois } from "../peers/tailscale.js";
import type { Usage } from "../observe/usage.js";
import type { Worlds } from "../routing/world.js";
import type { Refusal } from "../errors.js";

/** One request with its caller already resolved by the route table. */
export interface Call {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  /** The peer whose token authenticated this, or null for a local caller. */
  peer: string | null;
  /** Who to bill and to log: a peer's name, "local", or "key:<label>".
   *  Empty for routes that need no caller. */
  caller: string;
  /** The ids a scoped key may run, or null for an unscoped caller. */
  models: string[] | null;
  /** A plugin calling back in with the token hearth gave it: no plugin runs on this request. */
  internal?: boolean;
  /** The request body, when a route already read it to check something before passing it on. */
  body?: Buffer;
}

export type Handler = (c: Call) => Promise<void>;

export interface RouteContext {
  cfg: HearthConfig;
  log: Logger;
  logs: LogRing;
  pool: BackendPool;
  peers: PeerRegistry;
  plugins: Plugins;
  controls: Controls;
  config: ConfigFile;
  canary: ReturnType<typeof createCanary>;
  /** Requests and tokens per caller per model per day. */
  usage: Usage;
  /** The same, for what this node ran on each peer. */
  borrowed: Usage;
  history: History;
  /** Answers kept for the models that say so. */
  answers: Answers;
  callers: Callers;
  limits: Limits;
  worlds: Worlds;
  requests: RequestLog;
  whois: ReturnType<typeof tailscaleWhois>;
  /** The JSON body, held to `maxBodyBytes`. */
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  /** The raw body, held to `maxBodyBytes`. */
  readBody(req: IncomingMessage): Promise<Buffer>;
  /** A config refusal as `{error: {message, path}}`, so a form can put it beside its field; anything else as `fail` answers it. */
  failConfig(res: ServerResponse, e: unknown): void;
  /** The 503 a degraded model owes a client, or null. */
  degraded(model: string): Refusal | null;
  /** A local backend's deadlines, first byte and mid-answer silence: its own, else the node defaults. */
  backendDeadline(b: BackendConfig): { headersTimeoutMs?: number; idleTimeoutMs?: number };
  /** Push the console's state to every open page now. */
  broadcast(): void;
  /** Stop counting a long-lived stream as in-flight work, so shutdown does not wait on an open page. */
  notWork(res: ServerResponse): void;
  /** `POST /restart`'s hook and the newer release the console mentions, both set by `hearth serve` after the node is made. */
  lifecycle: { onRestart: (() => void) | null; update: string | null };
}
