/**
 * `hearth report`: what a bug report needs in one file. The version and platform, the config with
 * its secrets taken out, whether it loads, and from the running node its health, its view of the
 * network and its recent log lines. Every secret the config resolves to is scrubbed from all of it.
 */
import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";

import { loadConfig, type HearthConfig } from "./config.js";
import { maskedText } from "./configfile.js";

/** The most recent log lines kept: enough to hold an incident, short enough to paste. */
export const REPORT_LOG_LINES = 300;
/** How long one question to the node may take before the report says it did not answer. */
const ASK_MS = 5_000;

/** Every secret the config resolves to, `env:` ones included, longest first so one inside another is still caught. */
export function secretsOf(cfg: HearthConfig): string[] {
  const all = [
    ...cfg.apiKeys,
    ...Object.values(cfg.peerTokens),
    ...cfg.peers.map((p) => p.token),
    ...cfg.backends.flatMap((b) => [b.key ?? "", ...Object.values(b.headers)]),
    ...Object.values(cfg.actions).flatMap((a) => (a.kind === "call" ? Object.values(a.headers) : [])),
    ...Object.values(cfg.canary?.notify?.headers ?? {}),
    cfg.operator?.passHash ?? "",
  ];
  return [...new Set(all.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
}

/** `text` with each of `secrets` replaced by a stand-in naming it only by number. */
export function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((t, s, i) => t.split(s).join(`<secret ${i + 1}>`), text);
}

/** Where to reach the node from this machine: loopback, unless it listens on one address only. */
export function nodeUrl(cfg: HearthConfig): string {
  const h = cfg.listen.host;
  const host = h === "0.0.0.0" || h === "::" || h === "" ? "127.0.0.1" : h.includes(":") ? `[${h}]` : h;
  return `http://${host}:${cfg.listen.port}`;
}

/** One of the paths the report reads from the node, answered as text: the body, or why there is none. */
export type Ask = (path: "/healthz" | "/network" | "/ui/logs") => Promise<{ ok: boolean; text: string }>;

/** One GET to the node, answered as text: the body, or why there is none. */
async function ask(base: string, path: string, key: string | null): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await fetch(`${base}${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(ASK_MS) });
    const text = await r.text();
    return { ok: r.ok, text: r.ok ? text : `${r.status}: ${text.slice(0, 300)}` };
  } catch (e) {
    return { ok: false, text: `no answer: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const pretty = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** The report for the config at `path`, as Markdown; `version` is this build's. The node is asked over loopback unless `asked` answers for it. */
export async function bugReport(path: string, version: string, asked?: Ask): Promise<string> {
  const out: string[] = [
    "# hearth bug report",
    "",
    "Secrets from the config are replaced. Read it before posting: hostnames, addresses and model names are left in.",
    "",
    `- hearth ${version}`,
    `- node ${process.version}, ${platform()} ${release()} ${arch()}`,
    `- written ${new Date().toISOString()}`,
    "",
  ];
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    out.push(`## Config`, "", `${path} could not be read: ${e instanceof Error ? e.message : String(e)}`, "");
  }
  let cfg: HearthConfig | null = null;
  let loads = "";
  if (text !== null) {
    try {
      cfg = loadConfig(path);
      loads = "loads: ok";
    } catch (e) {
      loads = `does not load: ${e instanceof Error ? e.message : String(e)}`;
    }
    out.push(`## Config (${path}, ${loads})`, "", "```yaml", maskedText(text).trimEnd(), "```", "");
  }
  if (cfg !== null) {
    const base = nodeUrl(cfg);
    // An unscoped key, since /network is closed to a scoped one; none is needed when the node has none.
    const i = cfg.apiKeyModels.findIndex((m) => m === null);
    const key = cfg.apiKeys.length > 0 && i >= 0 ? cfg.apiKeys[i]! : null;
    const from: Ask = asked ?? ((p) => ask(base, p, p === "/network" ? key : null));
    const [health, net, logs] = await Promise.all([from("/healthz"), from("/network"), from("/ui/logs")]);
    out.push(asked ? "## The node" : `## The node at ${base}`, "", "### /healthz", "", "```json", pretty(health.text), "```", "");
    out.push("### /network", "", "```json", pretty(net.text), "```", "");
    out.push(`### Recent log lines`, "");
    if (logs.ok) {
      const entries = ((JSON.parse(logs.text) as { entries?: unknown[] }).entries ?? []).slice(-REPORT_LOG_LINES);
      out.push(`The last ${entries.length}, oldest first.`, "", "```", ...entries.map((e) => JSON.stringify(e)), "```", "");
    } else out.push("```", logs.text, "```", "");
  }
  const report = out.join("\n");
  return cfg === null ? report : scrub(report, secretsOf(cfg));
}
