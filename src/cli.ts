#!/usr/bin/env node
/**
 * hearth serve [--config path] [--check]
 * hearth init  [--config path]
 * hearth set-operator <user> <pass> [--config path]
 * hearth migrate [--config path]
 *
 * `init` probes the usual local server ports and writes a runnable config; `serve --check`
 * validates and exits, for ExecStartPre. `set-operator` writes the login credential into the
 * config: the file holds only a scrypt salt:hash of the password, which verifies and reveals
 * nothing. The previous file is backed up beside it, and a restart picks the login up.
 * `migrate` rewrites an older hearth.yaml into the current layout, keeping comments and a backup.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs } from "node:util";

import { CONFIG_VERSION, ConfigError, loadConfig, parseConfig } from "./config.js";
import { mayLeave } from "./route.js";
import { writeFileAtomic } from "./configfile.js";
import { LEVELS, createLogger, type Level } from "./log.js";
import { hashPassword } from "./login.js";
import { migrateDoc, routedMarker, unguarded, v1Marker } from "./migrate.js";
import { createNode } from "./server.js";
import { getJson } from "./upstream.js";
import { parseDocument } from "yaml";

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
# Everything runs locally until you add a peer or a cloud backend AND a flow
# sends something to it. Nothing leaves this machine by default.
#
# Every setting: https://github.com/Vcvzgbzz/hearth/blob/main/docs/configuration.md
version: ${CONFIG_VERSION}
name: ${JSON.stringify(hostnameGuess())}

listen:
  # Loopback on purpose. Widen it only if you mean to, and read the README's
  # security notes first.
  host: 127.0.0.1
  port: 4141

backends:
  main:
    # ${found ? "Found by probing." : "GUESS. Nothing answered on the usual ports, so set this yourself."}
    url: ${backendUrl}
    # llama-swap reports what is loaded, which lets the scheduler prefer it.
    # Use none for a server that cannot say.
    kind: llama-swap
  # A provider's API can be a backend too. A request sent to it leaves this
  # machine and this network, so nothing goes there unless a flow says so.
  # provider:
  #   url: https://api.example.com/v1
  #   cloud: true
  #   key: env:PROVIDER_KEY
  #   serves: [their-model]

backendDefaults:
  # One GPU fits one model at a time. Only raise this if your backend really
  # does serve in parallel (vLLM batches, llama.cpp can too with --parallel).
  concurrency: 1

scheduler:
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

# The console is on /ui. Off this machine it asks for a login: create one in the
# console on this machine, or with \`hearth set-operator <user> <pass>\`.
#
# Keep the console's day of history and recent logs across restarts.
# historyFile: /var/lib/hearth/history.json

# Keys allowed on the OpenAI endpoints. Empty means no auth, which is only
# reasonable while this is bound to loopback. Setting it means loopback needs a
# key too, including any local tool you point at this.
apiKeys: []
#   - { key: env:APP_KEY, label: app }
#   # A key can have a last day and limits, and \`models: [name]\` holds it to the names listed.
#   - { key: env:GUEST_KEY, label: guest, expires: 2030-12-31, limits: { requestsPerMinute: 20, tokensPerDay: 200000 } }

# --- lending and borrowing (both optional) ---------------------------------
#
# Models peers may run here. Empty lends nothing. Borrowed work enters your
# lowest-priority lane and is capped, so a guest can't queue ahead of you.
lending:
  models: []
#   tokensPerDay: 500000   # per peer, in a UTC day
#
# One entry per friend. url + token to borrow from them, accept to lend to
# them, or both. Generate a token with
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
peers: {}
#   friend:
#     url: http://100.x.y.z:4141
#     token: env:HEARTH_TO_FRIEND      # you present this to them
#     accept: env:HEARTH_FROM_FRIEND   # they present this to you
#     lend: { models: [my-big-model] } # their own limits, over lending: above
#     models:
#       # my id: their id. Also the allowlist: a model that isn't mapped can
#       # never be sent to them, whatever a flow below says.
#       my-big-model: their-big-model
#
# models: per-model settings and notes.
models: {}
#   my-big-model:
#     note: the 70B, for long documents
#   their-model:
#     price: { in: 3, out: 15 }   # dollars per million tokens: usage is then shown as spend
#
# flows: what can be asked for, and where each request goes. Only a name a flow
# takes is offered; the flow with "*" says what becomes of every other name.
flows:
  anything-else:
    inputs: ["*"]
    steps:
      # Runs any model your backend serves under its own name. Change this to
      # { refuse: "..." } once the flows above it name everything you offer.
      - to: { asked: true }
#   LLM:                              # callers ask for LLM, never for a model
#     inputs: [LLM]
#     steps:
#       - to: { peer: friend }        # try the peer first
#       - to: my-big-model            # else run it here
`;
}

function hostnameGuess(): string {
  // node:os, not process.env.HOSTNAME: that is a shell variable and is missing under systemd, `sh -c` and Docker.
  return hostname() || "hearth";
}

const USAGE = `usage: hearth [command] [--config path]

  serve                        run the node (the default)
  init                         probe for a local inference server and write hearth.yaml
  set-operator <user> <pass>   set the console login
  migrate                      rewrite an older hearth.yaml in the current layout, keeping a backup

  -c, --config <path>          the config file (default: ${DEFAULT_CONFIG})
      --check                  with serve: load the config, say whether it is valid, and exit
      --log <level>            debug, info, warn or error
  -v, --version
  -h, --help
`;

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        check: { type: "boolean", default: false },
        log: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (e) {
    // A mistyped flag is answered with how to type it, not a stack trace.
    console.error(`${e instanceof Error ? e.message.split(". ")[0] : String(e)}\n\n${USAGE}`);
    process.exit(1);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals[0] === "help") {
    console.log(USAGE);
    return;
  }
  if (values.version) {
    console.log((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version);
    return;
  }

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

  if (command === "set-operator") {
    const [user, pass] = positionals.slice(1);
    if (!user || !pass) {
      console.error("usage: hearth set-operator <user> <pass> [--config path]");
      process.exit(1);
    }
    if (!existsSync(configPath)) {
      console.error(`${configPath} does not exist — run hearth init first`);
      process.exit(1);
    }
    const text = readFileSync(configPath, "utf8");
    let doc;
    try {
      doc = parseDocument(text);
    } catch {
      console.error(`${configPath} is not valid YAML — fix it before adding a login`);
      process.exit(1);
    }
    // The password leaves this process as a hash only: salt and 64 bytes of scrypt, both hex.
    const passHash = await hashPassword(pass);
    doc.setIn(["operator"], doc.createNode({ user, passHash }));
    // The file is the source of truth, so keep the pre-edit bytes beside it.
    const backup = `${configPath}.bak-${new Date().toISOString().slice(0, 10)}`;
    writeFileSync(backup, text);
    // Long lines must not fold: the passHash line is 160 chars and would break if wrapped.
    writeFileAtomic(configPath, doc.toString({ lineWidth: 0 }));
    console.log(`operator login set for "${user}" in ${configPath}`);
    console.log(`the file's previous state is at ${backup}; a running hearth picks the login up on its own.`);
    return;
  }

  if (command === "migrate") {
    if (!existsSync(configPath)) {
      console.error(`${configPath} does not exist`);
      process.exit(1);
    }
    const text = readFileSync(configPath, "utf8");
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
      console.error(`${configPath} is not valid YAML: ${doc.errors[0]!.message}`);
      process.exit(1);
    }
    const raw = doc.toJS() as Record<string, unknown> | null;
    if (!raw || (v1Marker(raw) === null && routedMarker(raw) === null && !unguarded(raw))) {
      console.log(`${configPath} is already in the current layout; nothing to do`);
      return;
    }
    let moved: string[];
    try {
      moved = migrateDoc(doc);
    } catch (e) {
      console.error(`${configPath} was left alone: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    // Same flow style as the file had, so a migration does not respace every list.
    const out = doc.toString({ flowCollectionPadding: /[[{] \S/.test(text), lineWidth: 0 });
    // Checked before writing: a migration that cannot load is a bug here, not something to leave behind.
    try {
      parseConfig(parseDocument(out).toJS());
    } catch (e) {
      // An env: secret this shell cannot see is not the migration's problem; the service has it.
      if (!(e instanceof ConfigError && /environment variable/.test(e.message))) {
        console.error(`migrated config does not load, so ${configPath} was left alone: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    }
    const backup = `${configPath}.before-migrate-${new Date().toISOString().slice(0, 10)}`;
    writeFileSync(backup, text);
    writeFileAtomic(configPath, out);
    for (const line of moved) console.log(`  ${line}`);
    console.log(`${configPath} is rewritten; the file as it was is at ${backup}`);
    return;
  }

  if (command !== "serve") {
    console.error(`unknown command "${command}". Try: hearth serve | hearth init | hearth set-operator | hearth migrate`);
    process.exit(1);
  }

  if (!existsSync(configPath)) {
    console.error(`no ${configPath} here. Run \`hearth init\` to write one, or point at yours with --config.`);
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
    console.log(`config: ok (${cfg.peers.length} peer(s), ${Object.keys(cfg.flows).length} flow(s))`);
    return;
  }

  const level = (values.log ?? "info") as Level;
  if (!LEVELS.includes(level)) {
    console.error(`--log must be one of: ${LEVELS.join(", ")}`);
    process.exit(1);
  }
  const node = createNode(cfg, createLogger(level));
  // The node's logger, so startup and shutdown lines reach the console's Logs page too.
  const log = node.log;

  node.start();
  node.server.listen(cfg.listen.port, cfg.listen.host, () => {
    log.info("listening", {
      name: cfg.name,
      addr: `${cfg.listen.host}:${cfg.listen.port}`,
      backends: cfg.backends.map((b) => `${b.name}=${b.url} (${b.concurrency})`),
      peers: cfg.peers.map((p) => p.name),
      // Said out loud at startup on purpose. You should be able to see in one
      // line which prompts can leave this machine and which can arrive.
      routedAway: [...new Set(Object.values(cfg.flows).flatMap((f) => f.inputs))].filter((id) => mayLeave(cfg, id)),
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
        // A proxy on this port (tailscale serve, nginx, a port-forward) makes every caller look
        // like loopback, which without apiKeys means trusted.
        ...(cfg.apiKeys.length === 0
          ? { warning: "anything proxying to this port makes its callers look like loopback, which is trusted here — do not front this with `tailscale serve` or userspace networking" }
          : {}),
      });
    }
  });

  // A second signal stops immediately instead of waiting out the grace again.
  let stopping = false;
  const shutdown = (sig: string, code = 0) => {
    if (stopping) {
      log.warn("shutdown.forced", { signal: sig });
      process.exit(1);
    }
    stopping = true;
    log.info("shutting down", { signal: sig, graceMs: cfg.shutdownGraceMs });
    void node.close(cfg.shutdownGraceMs).then(() => process.exit(code));
  };
  // 75 (EX_TEMPFAIL) is a failure to systemd, so Restart=on-failure brings the node back.
  node.onRestart = () => shutdown("restart", 75);
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
