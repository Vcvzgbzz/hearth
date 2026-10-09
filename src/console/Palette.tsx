/** ⌘K: jump to anything on the node, or flip a switch, without leaving the keyboard. */
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { control, go, select, useStore, type Page } from "./store.js";
import { Card, cx } from "./ui.js";

type Cmd = { id: string; label: string; hint: string; run: () => void };

export function Palette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const d = useStore((s) => s.data);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
        setAt(0);
      } else if (e.key === "Escape") setOpen(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const cmds = useMemo<Cmd[]>(() => {
    if (!d) return [];
    const self = d.net.nodes.find((n) => n.self)!;
    const page = (p: Page, label: string): Cmd => ({ id: `p:${p}`, label, hint: "page", run: () => go(p) });
    const out: Cmd[] = [page("topology", "Topology"), page("models", "Models"), page("queue", "Queue"), page("logs", "Logs"), page("config", "Config")];
    for (const b of self.backends ?? []) out.push({ id: `b:${b.name}`, label: b.name, hint: "backend", run: () => { go("topology"); select({ kind: "backend", id: b.name }); } });
    for (const p of d.net.nodes.filter((n) => !n.self)) out.push({ id: `n:${p.name}`, label: p.name, hint: p.up ? "peer" : "peer · down", run: () => { go("topology"); select({ kind: "peer", id: p.name }); } });
    for (const r of d.net.resources ?? []) out.push({ id: `r:${r.name}`, label: r.name, hint: r.holder ? `hardware · ${r.holder}` : "hardware", run: () => { go("topology"); select({ kind: "resource", id: r.name }); } });
    out.push({ id: "c:lend", label: d.controls.lending ? "Pause lending" : "Resume lending", hint: "switch", run: () => void control({ lending: !d.controls.lending }, d.controls.lending ? "lending paused" : "lending resumed") });
    out.push({ id: "c:borrow", label: d.controls.borrowing ? "Pause borrowing" : "Resume borrowing", hint: "switch", run: () => void control({ borrowing: !d.controls.borrowing }, d.controls.borrowing ? "borrowing paused" : "borrowing resumed") });
    for (const m of d.catalog) {
      const lent = d.configuredShare.includes(m);
      out.push({ id: `s:${m}`, label: `${lent ? "Hold" : "Lend"} ${m}`, hint: "sharing", run: () => void control({ share: { [m]: !lent } }, lent ? `holding ${m}` : `lending ${m}`) });
    }
    return out;
  }, [d]);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = cmds.filter((c) => words.every((w) => `${c.label} ${c.hint}`.toLowerCase().includes(w))).slice(0, 12);
  if (!open) return null;
  const run = (c: Cmd | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-[15vh]" onClick={() => setOpen(false)}>
      <Card className="h-fit w-full max-w-lg overflow-hidden shadow-2xl">
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search size={15} className="text-dim" />
            <input autoFocus value={q} placeholder="Jump to a backend, peer, page — or lend, hold, pause…"
                   onChange={(e) => { setQ(e.target.value); setAt(0); }}
                   onKeyDown={(e) => {
                     if (e.key === "ArrowDown") { e.preventDefault(); setAt((a) => Math.min(a + 1, hits.length - 1)); }
                     if (e.key === "ArrowUp") { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
                     if (e.key === "Enter") run(hits[at]);
                   }}
                   className="h-11 flex-1 bg-transparent text-[13px] outline-none" />
            <kbd className="rounded border border-line px-1.5 text-[10px] text-dim">esc</kbd>
          </div>
          <div className="max-h-80 overflow-auto py-1">
            {hits.map((c, i) => (
              <button key={c.id} onMouseEnter={() => setAt(i)} onClick={() => run(c)}
                      className={cx("flex w-full items-center px-3 py-2 text-left", i === at && "bg-muted")}>
                <span>{c.label}</span>
                <span className="ml-auto text-[11px] text-dim">{c.hint}</span>
              </button>
            ))}
            {hits.length === 0 && <div className="px-3 py-6 text-center text-dim">Nothing matches.</div>}
          </div>
        </div>
      </Card>
    </div>
  );
}
