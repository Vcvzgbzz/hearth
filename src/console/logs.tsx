/**
 * The Logs page: hearth's recent log lines as sentences, newest first, with the raw fields one
 * click away. journald (or wherever stdout goes) stays the full record; this is the readable tail.
 */
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { Card, cx, Empty, mono, Pill, type Tone } from "./ui.js";

export interface LogEntry {
  t: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields: Record<string, unknown>;
}

const ms = (v: unknown) => (typeof v !== "number" ? "?" : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}s`);
const s = (v: unknown) => (v === undefined || v === null ? "?" : String(v));

/** One sentence per kind of line; anything unlisted falls back to its name and fields. */
const SAY: Record<string, (f: Record<string, unknown>) => string> = {
  request: (f) => {
    const where = f.forPeer ? ` for ${s(f.forPeer)}` : f.target && f.target !== "local" ? ` sent to ${s(f.target)}` : "";
    const how = f.ok ? `ran ${ms(f.runMs)}` : `failed after ${ms(f.runMs)}${f.error ? `: ${s(f.error)}` : f.status ? ` (${s(f.status)})` : ""}`;
    return `${s(f.model)}${where}, ${s(f.lane)} lane: waited ${ms(f.waitedMs)}, ${how}`;
  },
  "request.failed": (f) => `A request failed: ${s(f.error)}`,
  "request.cross_origin": (f) => `Refused a cross-origin ${s(f.method)} to ${s(f.path)}`,
  listening: (f) => `Started as ${s(f.name)} on ${s(f.addr)}`,
  "listening.wide": (f) => `Listening beyond loopback on ${s(f.host)}`,
  "shutting down": (f) => `Shutting down (${s(f.signal)}), waiting up to ${ms(f.graceMs)} for work in flight`,
  "shutdown.forced": () => "Shutdown forced before the drain finished",
  "drain.start": (f) => `Draining ${s(f.inFlight)} request(s) before stopping`,
  "drain.done": (f) => `Drained in ${ms(f.ms)}`,
  "drain.cut": (f) => `Drain cut off: ${s(f.abandoned)} request(s) abandoned`,
  "restart.requested": (f) => `Restart requested by ${s(f.caller)}`,
  "login.ok": (f) => `${s(f.caller).replace(/^operator:/, "")} signed in from ${s(f.ip)}`,
  "login.failed": (f) => `Failed sign-in${f.user ? ` as ${s(f.user)}` : ""} from ${s(f.ip)}`,
  "setup.operator": (f) => `Console login created for ${s(f.caller).replace(/^operator:/, "")} from ${s(f.ip)}`,
  "peer.up": (f) => `Peer ${s(f.peer)} is up`,
  "peer.down": (f) => `Peer ${s(f.peer)} is down${f.error ? `: ${s(f.error)}` : ""}`,
  "peer.mapping_drift": (f) => `Peer ${s(f.peer)} no longer offers a model mapped to it`,
  "backend.events_connected": (f) => `Watching ${s(f.url)}`,
  "backend.events_lost": (f) => `Lost the event stream from ${s(f.url)}`,
  "pool.evict": (f) => `${s(f.backend)} gave up its card for ${s(f.for)}`,
  warm: (f) => `Warmed ${s(f.model)}`,
  "warm.failed": (f) => `Could not warm ${s(f.model)} on ${s(f.backend)}: ${s(f.error)}`,
  "config.saved": () => "Config saved",
  "config.patched": (f) => `Config edited${Array.isArray(f.restartPending) && f.restartPending.length ? `; restart to apply ${f.restartPending.join(", ")}` : ""}`,
  "config.reloaded": () => "Config reloaded from disk",
  "config.invalid": (f) => `Config does not load: ${s(f.error)}. Still running the last good one`,
  "canary.degraded": (f) => `${s(f.model)} taken out of rotation: ${s(f.detail)}`,
  "canary.recovered": (f) => `${s(f.model)} back in rotation`,
  "history.unwritable": (f) => `Could not save history to ${s(f.path)}: ${s(f.error)}`,
};

export function say(e: LogEntry): string {
  const f = SAY[e.msg];
  if (f) {
    try {
      return f(e.fields);
    } catch { /* fall through to the raw form */ }
  }
  const rest = Object.entries(e.fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  return `${e.msg.replace(/[._]/g, " ")}${rest ? ` · ${rest}` : ""}`;
}

const TONE: Record<LogEntry["level"], Tone> = { debug: "dim", info: "dim", warn: "warn", error: "bad" };

const when = (iso: string) => {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString() : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString()}`;
};

export function Logs() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [level, setLevel] = useState<"all" | "warn" | "error">("all");
  const [requests, setRequests] = useState(true);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch("/ui/logs", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { entries: LogEntry[]; persisted: boolean };
        if (live) { setEntries(d.entries); setPersisted(d.persisted); }
      } catch { /* the header already says when the node is unreachable */ }
    };
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (entries ?? []).map((e, i) => ({ e, i, text: say(e) })).reverse().filter(({ e, text }) =>
    (level === "all" || (level === "warn" ? e.level !== "info" && e.level !== "debug" : e.level === "error"))
    && (requests || e.msg !== "request")
    && words.every((w) => `${text} ${e.msg}`.toLowerCase().includes(w)));

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="mr-auto">
          <div className="font-medium">Logs</div>
          <div className="text-[11px] text-dim">
            The most recent lines, newest first.{persisted ? "" : " Kept in memory only: set historyFile to keep them across restarts."}
          </div>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" aria-label="search logs"
               className="h-8 w-56 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none" />
        <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)} aria-label="level"
                className="h-8 rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none">
          <option value="all">all levels</option>
          <option value="warn">warnings and errors</option>
          <option value="error">errors</option>
        </select>
        <label className="flex items-center gap-1.5 text-[12px] text-dim">
          <input type="checkbox" checked={requests} onChange={(e) => setRequests(e.target.checked)} />requests
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {entries === null ? <Empty>loading…</Empty> : shown.length === 0 ? <Empty>{entries.length ? "Nothing matches." : "Nothing logged yet."}</Empty> : (
          <ul>
            {shown.slice(0, 1000).map(({ e, i, text }) => (
              <li key={i} className="border-b border-line/50 last:border-0">
                <button type="button" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}
                        className="flex w-full items-start gap-3 px-4 py-1.5 text-left hover:bg-muted/40">
                  <ChevronRight size={12} className={cx("mt-1 shrink-0 text-dim transition-transform", open === i && "rotate-90")} />
                  <span className="tabular w-32 shrink-0 text-[12px] text-dim">{when(e.t)}</span>
                  <span className={cx("min-w-0 flex-1 text-[13px]", e.level === "error" && "text-bad")}>
                    {e.level !== "info" && <span className="mr-2"><Pill tone={TONE[e.level]}>{e.level}</Pill></span>}{text}
                  </span>
                </button>
                {open === i && (
                  <pre className={cx(mono, "mx-4 mb-2 ml-[10.5rem] overflow-auto rounded-md bg-muted/50 p-2 text-[11px] leading-4")}>
                    {JSON.stringify({ msg: e.msg, ...e.fields }, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
