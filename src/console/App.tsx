/** hearth console 2.0: a sidebar of pages over one live store, the topology first. */
import { AlertTriangle, Boxes, CheckCircle2, FileCog, Flame, ListOrdered, LogOut, Moon, Network, Sun, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { Config } from "./config.js";
import { History, Inspector, Models, Queue } from "./pages.js";
import { Palette } from "./Palette.js";
import type { UiData } from "./types.js";
import { go, login, logout, restartNode, select, useStore, type Page } from "./store.js";
import { Topology } from "./Topology.js";
import { Button, Card, cx, Pill } from "./ui.js";

const PAGES: { id: Page; label: string; icon: typeof Network }[] = [
  { id: "topology", label: "Topology", icon: Network },
  { id: "models", label: "Models", icon: Boxes },
  { id: "queue", label: "Queue", icon: ListOrdered },
  { id: "config", label: "Config", icon: FileCog },
];

function useTheme(): [boolean, () => void] {
  const saved = (() => { try { return localStorage.getItem("hearth.theme"); } catch { return null; } })();
  const [dark, setDark] = useState(saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  return [dark, () => setDark((d) => {
    try { localStorage.setItem("hearth.theme", d ? "light" : "dark"); } catch { /* per-browser nicety only */ }
    return !d;
  })];
}

function ConfigPill() {
  const c = useStore((s) => s.data?.config);
  if (!c) return null;
  const tone = c.error ? "bad" : c.restartPending.length ? "warn" : "ok";
  const text = c.error ? "config does not load" : c.restartPending.length ? `restart to apply ${c.restartPending.length}` : c.path ? "saved" : "in memory";
  return (
    <span className="flex items-center gap-2">
      <button onClick={() => go("config")} title={c.path ?? undefined}><Pill tone={tone}>{text}</Pill></button>
      {!c.error && c.restartPending.length > 0 && (
        <button className="text-[12px] text-dim hover:text-fg" onClick={() => {
          if (confirm("Restart hearth? Running requests finish first, everyone is signed out, and it only comes back if systemd (or similar) restarts it.")) void restartNode();
        }}>restart</button>
      )}
    </span>
  );
}

type Finding = { tone: "bad" | "warn"; text: string; go: () => void };

/** First time each peer was seen down, so the sentence can say for how long. */
const downSince = new Map<string, number>();
const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

/** What needs attention, worst first: a config that will not load, then outages, then backlog, then restarts. */
function findings(d: UiData): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const self = d.net.nodes.find((n) => n.self)!;
  if (d.config.error) out.push({ tone: "bad", text: "hearth.yaml does not load — running the last good config", go: () => go("config") });
  for (const p of d.net.nodes.filter((n) => !n.self)) {
    if (p.up) { downSince.delete(p.name); continue; }
    const since = downSince.get(p.name) ?? now;
    downSince.set(p.name, since);
    const linked = Object.keys(p.map ?? {});
    out.push({
      tone: "bad",
      text: `${p.name} down${now - since > 5000 ? ` for ${dur(now - since)}` : ""}${linked.length ? ` · ${linked.slice(0, 2).join(", ")} ${linked.length > 2 ? "and more " : ""}cannot go there` : ""}`,
      go: () => { go("topology"); select({ kind: "peer", id: p.name }); },
    });
  }
  // A link to a model the peer no longer lends routes nowhere: every request for it fails or falls back.
  for (const p of d.net.nodes.filter((n) => !n.self && n.up)) {
    const dead = Object.keys(p.map ?? {}).filter((m) => !(p.serves ?? []).includes(m));
    if (dead.length) {
      out.push({
        tone: "warn", text: `${p.name} no longer offers ${dead.slice(0, 2).join(", ")}${dead.length > 2 ? ` and ${dead.length - 2} more` : ""} — relink or remove`,
        go: () => { go("topology"); select({ kind: "peer", id: p.name }); },
      });
    }
  }
  for (const b of self.backends ?? []) {
    if (b.answering === false) out.push({ tone: "bad", text: `${b.name} not answering`, go: () => { go("topology"); select({ kind: "backend", id: b.name }); } });
  }
  const waiting = new Map<string, number[]>();
  for (const j of d.q.jobs) if (j.state === "queued" && j.backend) waiting.set(j.backend, [...(waiting.get(j.backend) ?? []), j.since]);
  for (const [name, since] of waiting) {
    const oldest = now - Math.min(...since);
    if (since.length >= 3 || oldest > 30_000) {
      out.push({
        tone: "warn", text: `${name} backed up — ${since.length} waiting, oldest ${dur(oldest)}`,
        go: () => { go("topology"); select({ kind: "backend", id: name }); },
      });
    }
  }
  if (d.config.restartPending.length) out.push({ tone: "warn", text: `restart to apply ${d.config.restartPending.join(", ")}`, go: () => go("config") });
  return out;
}

/** One sentence answering "is anything wrong?": the worst finding, or what is working when nothing is. */
function Health() {
  const d = useStore((s) => s.data);
  if (!d) return null;
  const f = findings(d);
  if (f.length === 0) {
    const cards = (d.net.resources ?? []).filter((r) => !r.shared && r.holder).length;
    const queued = d.q.jobs.filter((j) => j.state === "queued").length;
    return (
      <span className="flex items-center gap-2 text-[12px] text-dim">
        <CheckCircle2 size={14} className="text-ok" />
        <span className="text-fg">All clear</span>
        <span>· {cards === 0 ? "cards idle" : `${cards} card${cards === 1 ? "" : "s"} working`}</span>
        <span>· {queued === 0 ? "nothing waiting" : `${queued} waiting`}</span>
      </span>
    );
  }
  const [worst, ...rest] = f;
  const Icon = worst!.tone === "bad" ? XCircle : AlertTriangle;
  return (
    <button onClick={worst!.go} title={f.map((x) => x.text).join("\n")}
            className={cx("flex min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-[12px] hover:bg-muted", worst!.tone === "bad" ? "text-bad" : "text-warn")}>
      <Icon size={14} className="shrink-0" />
      <span className="truncate">{worst!.text}</span>
      {rest.length > 0 && <span className="shrink-0 text-dim">+{rest.length} more</span>}
    </button>
  );
}

const WINDOW_MS = 10 * 60_000;

/**
 * The last ten minutes as a pulse: every finished request a tick (height by how long it ran,
 * red if it failed), queue depth a soft area behind. Rhythm and trend, which counts cannot show.
 */
function Activity() {
  const hist = useStore((s) => s.data!.hist);
  const calls = useStore((s) => s.data!.calls ?? []);
  const now = Date.now();
  const W = 1000;
  const H = 48;
  const x = (t: number) => ((t - (now - WINDOW_MS)) / WINDOW_MS) * W;
  const recent = calls.filter((c) => c.t > now - WINDOW_MS);
  const longest = Math.max(1000, ...recent.map((c) => c.ms));
  const depth = hist.filter((h) => h.t > now - WINDOW_MS);
  const peak = Math.max(4, ...depth.map((h) => h.queued));
  const area = depth.length > 1
    ? `M${x(depth[0]!.t)},${H} ` + depth.map((h) => `L${x(h.t)},${H - (h.queued / peak) * (H - 6)}`).join(" ") + ` L${x(depth[depth.length - 1]!.t)},${H} Z`
    : "";
  const failed = recent.filter((c) => !c.ok).length;
  return (
    <div className="flex items-end gap-4">
      <div className="min-w-0 flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-12 w-full" aria-label="requests over the last ten minutes">
          {area && <path d={area} fill="var(--warn)" opacity={0.12} />}
          <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--border)" />
          {recent.map((c, i) => {
            const h = 4 + Math.sqrt(c.ms / longest) * (H - 8);
            return <rect key={i} x={x(c.t) - 0.75} y={H - h} width={1.5} height={h} rx={0.75}
                         fill={c.ok ? "var(--ok)" : "var(--bad)"} opacity={c.ok ? 0.75 : 1} />;
          })}
        </svg>
        <div className="mt-1 flex justify-between text-[10px] text-dim"><span>10 min ago</span><span>now</span></div>
      </div>
      <div className="shrink-0 pb-4 text-right text-[11px] leading-4 text-dim">
        <div><b className="tabular font-semibold text-fg">{recent.length}</b> requests</div>
        <div className={failed ? "text-bad" : undefined}><b className="tabular font-semibold">{failed}</b> failed</div>
      </div>
    </div>
  );
}

function LoginCard() {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const setup = useStore((s) => s.setupRequired);
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const msg = setup && pass !== confirm ? "the passwords do not match" : await login(user, pass, setup);
    setBusy(false);
    if (msg !== null) setErr(msg);
  };
  return (
    <div className="grid flex-1 place-items-center p-5">
      <Card className="w-full max-w-sm p-5">
        <form onSubmit={submit}>
          <div className="flex items-center gap-2 text-base font-semibold">
            <Flame size={16} className="text-accent" />
            {setup ? "set up hearth" : "log in to hearth"}
          </div>
          <p className="mt-1 text-dim">{setup
            ? "This node has no operator yet. Create the login that opens the whole console — dashboard, config, controls — from anywhere on your network."
            : "This page is loopback-only. A login opens the whole console — dashboard, config, controls — from anywhere on your network."}</p>
          <input autoFocus value={user} onChange={(e) => setUser(e.target.value)} placeholder="username"
                 className="mt-3 h-9 w-full rounded-lg border border-line bg-bg px-3 text-sm focus:border-accent focus:outline-none" />
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="password"
                 className="mt-2 h-9 w-full rounded-lg border border-line bg-bg px-3 text-sm focus:border-accent focus:outline-none" />
          {setup && (
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="password again"
                   className="mt-2 h-9 w-full rounded-lg border border-line bg-bg px-3 text-sm focus:border-accent focus:outline-none" />
          )}
          {err !== null && <div className="mt-2 text-sm text-bad">{err}</div>}
          <div className="mt-4 flex justify-end">
            <Button tone="primary" type="submit" disabled={busy || user === "" || pass === ""}>
              {busy ? "signing in…" : setup ? "create login" : "log in"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function KeyDialog() {
  const ask = useStore((s) => s.askKey);
  const [key, setKey] = useState("");
  if (!ask) return null;
  const done = (k: string | null) => { ask(k); setKey(""); };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => done(null)}>
      <Card className="w-full max-w-sm p-5 shadow-2xl">
        <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); done(key); }}>
          <div className="text-base font-semibold">This node needs a key</div>
          <p className="mt-1 text-dim">Reading is open; changing something needs one of the node's apiKeys. It is kept in this browser only.</p>
          <input autoFocus type="password" value={key} onChange={(e) => setKey(e.target.value)}
                 className="mt-3 h-9 w-full rounded-lg border border-line bg-bg px-3 font-mono focus:border-accent focus:outline-none" />
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => done(null)}>cancel</Button>
            <Button tone="primary" type="submit">use key</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Toast() {
  const t = useStore((s) => s.toast);
  if (!t) return null;
  return (
    <div role="status" className={cx(
      "fixed bottom-4 right-4 z-40 max-w-md rounded-lg border bg-panel px-4 py-2.5 shadow-lg",
      t.tone === "ok" ? "border-line" : "border-bad text-bad",
    )}>{t.text}</div>
  );
}

export default function App() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  const dead = useStore((s) => s.dead);
  const loginRequired = useStore((s) => s.loginRequired);
  const page = useStore((s) => s.page);
  const [dark, toggleTheme] = useTheme();

  useEffect(() => {
    const onHash = () => useStore.setState({ page: (location.hash.slice(1) as Page) || "topology", sel: null });
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // Signed out, nothing else works: the card is the whole page.
  if (loginRequired) return <div className="flex h-full"><LoginCard /></div>;

  const self = data?.net.nodes.find((n) => n.self);
  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col border-r border-line bg-panel px-3 py-4 max-md:w-14 max-md:px-2">
        <div className="mb-6 flex items-center gap-2 px-2">
          <Flame size={18} className="text-accent" />
          <span className="font-semibold tracking-tight max-md:hidden">hearth</span>
        </div>
        {PAGES.map((p) => (
          <button key={p.id} onClick={() => go(p.id)} aria-current={page === p.id ? "page" : undefined}
                  className={cx("mb-0.5 flex h-8 items-center gap-2.5 rounded-lg px-2 text-left transition-colors",
                    page === p.id ? "bg-muted font-medium text-fg" : "text-dim hover:bg-muted/60 hover:text-fg")}>
            <p.icon size={15} />
            <span className="max-md:hidden">{p.label}</span>
          </button>
        ))}
        <div className="mt-auto px-2 text-[11px] text-dim max-md:hidden">
          <div><kbd className="rounded border border-line px-1">⌘K</kbd> to jump</div>
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
          <span className="shrink-0 font-semibold">{self?.name ?? "…"}</span>
          {dead ? <Pill tone="bad">unreachable</Pill> : <Pill tone={live ? "ok" : "warn"} pulse={live}>{live ? "live" : "polling"}</Pill>}
          {data?.operator && <span className="max-sm:hidden"><Pill tone="ok">signed in as {data.operator}</Pill></span>}
          <div className="ml-2 min-w-0 flex-1 overflow-hidden"><Health /></div>
          <div className="flex shrink-0 items-center gap-3">
            {data?.operator && (
              <button onClick={() => { void logout(); }} className="flex items-center gap-1.5 text-[12px] text-dim hover:text-fg" title="end this browser's session">
                <LogOut size={14} /> sign out
              </button>
            )}
            <ConfigPill />
            <button onClick={toggleTheme} aria-label="toggle theme" className="text-dim hover:text-fg">
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>

        {!data ? (
          <div className="grid flex-1 place-items-center text-dim">{dead ? "hearth is not answering" : "connecting…"}</div>
        ) : page === "topology" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
            <Activity />
            <Card className="relative min-h-[420px] flex-1 overflow-hidden">
              <Topology />
              <Inspector />
            </Card>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {page === "models" && <Models />}
            {page === "queue" && <><Queue /><History /></>}
            {page === "config" && <Config />}
          </div>
        )}
      </main>

      <Palette />
      <KeyDialog />
      <Toast />
    </div>
  );
}
