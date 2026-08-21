#!/usr/bin/env node
/**
 * hearth serve [--config path] [--check]
 * hearth init  [--config path]
 *
 * `init` pokes the ports a local inference server usually sits on and writes a
 * config you can run as-is. `serve --check` validates and exits, which is what
 * you want in ExecStartPre so a bad edit fails the deploy instead of the next
 * request.
 */
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs } from "node:util";

import { ConfigError, loadConfig } from "./config.js";
import { LEVELS, createLogger, type Level } from "./log.js";
import { createNode } from "./server.js";
import { getJson } from "./upstream.js";

const DEFAULT_CONFIG = "hearth.yaml";

/** Where a local OpenAI-compatible server usually lives: llama-swap,
 *  llama-server, ollama, vllm, LM Studio. */
const PROBE_PORTS = [9292, 8080, 11434, 8000, 1234];

async function probeBackend(): Promise<string | null> {
  for (const port of PROBE_PORTS) {
    const url = `http://127.0.0.1:${port}`;
    try {
      await getJson<unknown>(`${url}/v1/models`, { headersTimeoutMs: 1_000 });
      return url;
    } catch {
      // Nothing home, or not OpenAI-shaped. Next.
    }
  }
  return null;
}

function starterConfig(backendUrl: string, found: boolean): string {
  return `# hearth: a queue in front of your inference server.
#
# Everything runs locally until you add a peer AND point a model at it. Nothing
# leaves this machine by default.
name: ${JSON.stringify(hostnameGuess())}

listen:
  # Loopback on purpose. Widen it only if you mean to, and read the README's
  # security notes first.
  host: 127.0.0.1
  port: 4141

backend:
  # ${found ? "Found by probing." : "GUESS. Nothing answered on the usual ports, so set this yourself."}
  url: ${backendUrl}
  # llama-swap has /running, which lets the scheduler prefer whatever model is
  # already loaded. Harmless to leave on elsewhere, it just never applies.
  llamaSwapExtras: true

scheduler:
  # One GPU fits one model at a time. Only raise this if your backend really
  # does serve in parallel (vLLM batches, llama.cpp can too with --parallel).
  concurrency: 1
  # Per caller, per lane. 0 is off, and that's the default until apiKeys can
  # tell callers apart. Without keys every request is the same identity, so a
  # cap here would be a global limit rather than fairness.
  maxPerCaller: 0
  # Lower number goes first, and waiting earns priority so nothing starves.
  # Pick one per request with a "lane" field in the body. We strip it before
  # the request reaches your backend.
  lanes:
    chat: { priority: 0 }     # a person is watching this
    batch: { priority: 100 }  # a render nobody is waiting on

# The status page is on /ui, loopback-only. On a headless box or in a container
# there is no browser on loopback, so uncomment this to give it its own socket.
# That port serves the page and nothing else, but it takes no credential either
# (a browser cannot send one), so put it somewhere only you can reach.
# uiListen:
#   host: 127.0.0.1
#   port: 4142

# Keys allowed on the OpenAI endpoints. Empty means no auth, which is only
# reasonable while this is bound to loopback. Setting it means loopback needs a
# key too, including any local tool you point at this.
apiKeys: []

# --- lending and borrowing (both optional) ---------------------------------
#
# share: models you're willing to run for a peer. Empty lends nothing.
share: []
#
# Borrowed work is pinned to your lowest-priority lane and capped, so a guest
# can't queue ahead of you. Override with peerLane / peerMaxConcurrent.
#
# peerTokens: the token each peer presents to you. Generate with
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
peerTokens: {}
#   friend: env:HEARTH_PEER_FRIEND
#
# peers: nodes YOU can send work to.
peers: []
#   - name: friend
#     url: http://100.x.y.z:4141
#     token: env:HEARTH_TOKEN_FRIEND
#     models:
#       # my id: their id. Also the allowlist: a model that isn't mapped can
#       # never be sent to them, whatever the policy below says.
#       my-big-model: their-big-model
#
# models: routing policy. Anything not listed here stays local.
models: {}
#   my-big-model:
#     policy: peer        # local | peer | spillover | fastest
#     peers: [friend]
#     fallbackLocal: true
`;
}

function hostnameGuess(): string {
  // node:os, not process.env.HOSTNAME. HOSTNAME is a bash shell variable and
  // isn't exported, so it's missing under systemd, under `sh -c` and in Docker.
  // This returned "hearth" for basically every install.
  return hostname() || "hearth";
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      check: { type: "boolean", default: false },
      log: { type: "string" },
    },
  });

  const command = positionals[0] ?? "serve";
  const configPath = values.config ?? DEFAULT_CONFIG;

  if (command === "init") {
    if (existsSync(configPath)) {
      console.error(`${configPath} already exists, so not overwriting it.`);
      process.exit(1);
    }
    process.stderr.write("probing for a local inference server...\n");
    const found = await probeBackend();
    writeFileSync(configPath, starterConfig(found ?? "http://127.0.0.1:9292", found !== null));
    console.log(
      found
        ? `wrote ${configPath}, pointing at ${found}`
        : `wrote ${configPath}, but nothing answered on ${PROBE_PORTS.join(", ")}, so set backend.url yourself`,
    );
    return;
  }

  if (command !== "serve") {
    console.error(`unknown command "${command}". Try: hearth serve | hearth init`);
    process.exit(1);
  }

  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    // Someone has to go and fix this, so print a sentence, not a stack trace.
    console.error(e instanceof ConfigError ? `config: ${e.message}` : e);
    process.exit(1);
  }

  if (values.check) {
    console.log(`config: ok (${cfg.peers.length} peer(s), ${Object.keys(cfg.models).length} routed model(s))`);
    return;
  }

  const level = (values.log ?? "info") as Level;
  if (!LEVELS.includes(level)) {
    console.error(`--log must be one of: ${LEVELS.join(", ")}`);
    process.exit(1);
  }
  const log = createLogger(level);
  const node = createNode(cfg, log);

  node.start();
  node.server.listen(cfg.listen.port, cfg.listen.host, () => {
    log.info("listening", {
      name: cfg.name,
      addr: `${cfg.listen.host}:${cfg.listen.port}`,
      backends: cfg.backends.map((b) => `${b.name}=${b.url} (${b.concurrency})`),
      peers: cfg.peers.map((p) => p.name),
      // Said out loud at startup on purpose. You should be able to see in one
      // line which prompts can leave this machine and which can arrive.
      routedAway: Object.entries(cfg.models)
        .filter(([, r]) => r.policy !== "local")
        .map(([m]) => m),
      shared: cfg.share,
    });
    // Accurate rather than alarmist. Without apiKeys, anyone off loopback still
    // needs a valid peer token, so binding wide isn't an open door. Worth
    // saying that loopback is the only unauthenticated path, though.
    if (cfg.listen.host !== "127.0.0.1") {
      log.warn("listening.wide", {
        host: cfg.listen.host,
        detail:
          cfg.apiKeys.length === 0
            ? "no apiKeys: loopback is trusted, everything else needs a peer token"
            : "apiKeys required off loopback",
        peersAccepted: Object.keys(cfg.peerTokens),
        // The sentence above is only true while nothing rewrites the source
        // address. Anything that proxies to this port — `tailscale serve`,
        // userspace-mode tailscaled, nginx, a container port-forward — makes
        // every request look like loopback, and with no apiKeys that promotes
        // an anonymous caller to a trusted local one. Said here because the
        // process cannot detect it and the operator can.
        ...(cfg.apiKeys.length === 0
          ? { warning: "anything proxying to this port makes its callers look like loopback, which is trusted here — do not front this with `tailscale serve` or userspace networking" }
          : {}),
      });
    }
  });

  if (node.uiServer && cfg.uiListen) {
    const { host, port } = cfg.uiListen;
    node.uiServer.listen(port, host, () => {
      log.info("listening.ui", {
        addr: `${host}:${port}`,
        detail: "status page only; every other path on this port is a 404",
      });
      if (host !== "127.0.0.1") {
        // No credential can gate this: a browser navigating to a url cannot
        // present a bearer token. Reachable therefore means readable.
        log.warn("listening.ui_wide", {
          host,
          detail:
            "anyone who can reach this port can read the queue, caller ids and model inventory — no key required",
        });
      }
    });
  }

  const shutdown = (sig: string) => {
    log.info("shutting down", { signal: sig });
    void node.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
