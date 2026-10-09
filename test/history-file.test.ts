/** historyFile: a day of calls and the recent log lines survive a restart; nothing older than a day comes back. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { parseV1 } from "./v1.js";

const file = join(mkdtempSync(join(tmpdir(), "hearth-hist-")), "history.json");
const cfgWith = (historyFile?: string) =>
  parseV1({ backend: { url: "http://127.0.0.1:9", kind: "none" }, ...(historyFile ? { historyFile } : {}) });

async function boot(historyFile?: string) {
  const node = createNode(cfgWith(historyFile), silentLogger);
  node.start();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await (await fetch(url + p)).json()) as Record<string, unknown>;
  return { node, url, get };
}

type Day = { calls: { model: string; t: number }[]; minutes: unknown[] };
type Logs = { entries: { msg: string }[]; persisted: boolean };

{
  const a = await boot(file);
  const now = Date.now();
  a.node.history.record({ t: now - 2 * 3_600_000, model: "two-hours-ago", backend: "main", ms: 10, waitedMs: 0, ok: true });
  a.node.history.record({ t: now, model: "just-now", backend: "main", ms: 10, waitedMs: 0, ok: true });
  // A refused cross-origin write is logged as a warning: a line to find after the restart.
  await (await fetch(`${a.url}/control`, { method: "POST", headers: { Origin: "http://elsewhere.example" } })).text();

  const day = (await a.get("/ui/history")) as unknown as Day;
  assert.deepEqual(day.calls.map((c) => c.model), ["two-hours-ago", "just-now"], "the day view holds calls older than ten minutes");
  const live = (await a.get("/ui/data")) as { calls: { model: string }[] };
  assert.deepEqual(live.calls.map((c) => c.model), ["just-now"], "the live view still covers ten minutes");
  const logs = (await a.get("/ui/logs")) as unknown as Logs;
  assert.ok(logs.entries.some((e) => e.msg === "request.cross_origin"), "warnings reach the Logs page");
  assert.equal(logs.persisted, true);
  await a.node.close();
  assert.ok(existsSync(file), "close writes the file");
}

{
  const b = await boot(file);
  const day = (await b.get("/ui/history")) as unknown as Day;
  assert.deepEqual(day.calls.map((c) => c.model), ["two-hours-ago", "just-now"], "the day survives a restart");
  const logs = (await b.get("/ui/logs")) as unknown as Logs;
  assert.ok(logs.entries.some((e) => e.msg === "request.cross_origin"), "and so do the log lines");
  await b.node.close();
  const saved = JSON.parse(readFileSync(file, "utf8")) as { v: number };
  assert.equal(saved.v, 1);
}

{
  // A day-old call is dropped on load rather than shown as recent.
  const c = createNode(cfgWith(), silentLogger);
  c.history.restore({ calls: [{ t: Date.now() - 25 * 3_600_000, model: "old", backend: "main", ms: 1, waitedMs: 0, ok: true }], minutes: "junk" });
  assert.deepEqual(c.history.snapshot().calls, [], "older than a day is gone; a malformed field is ignored");
  await c.close();
}

{
  const d = await boot();
  const logs = (await d.get("/ui/logs")) as unknown as Logs;
  assert.equal(logs.persisted, false, "without historyFile the page says the lines are in memory only");
  await d.node.close();
}

console.log("history-file.test.ts ok");
