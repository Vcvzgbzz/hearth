/** The requests this node made, newest first, beside the Topology map; pointing at one lights the box that ran it. */
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useEffect, useState } from "react";

import { select, useStore } from "./store.js";
import { cx, mono } from "./ui.js";

const OPEN_KEY = "hearth.rail";
const SHOWN = 10;

type Item = { key: string; model: string; caller: string; backend?: string; peer?: string; live: boolean; at: number; ms?: number; ok?: boolean };

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

/** Mark the map box with this id as the one being pointed at, or none. */
function light(id: string | null): void {
  for (const el of document.querySelectorAll(".react-flow__node[data-lit]")) el.removeAttribute("data-lit");
  if (id) document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.setAttribute("data-lit", "");
}

/** The map box a request ran in, as Topology names it. */
const target = (i: Item) => (i.peer ? `peer:${i.peer}` : i.backend ? `backend:${i.backend}` : null);

export function Rail() {
  const d = useStore((s) => s.data)!;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) !== "closed"; } catch { return true; } });
  const toggle = () => setOpen((o) => { try { localStorage.setItem(OPEN_KEY, o ? "closed" : "open"); } catch { /* per-browser nicety only */ } return !o; });
  // Nothing stays lit once the rail is gone.
  useEffect(() => () => light(null), [open]);
  // A peer's work running here is theirs, not a request this node made.
  const peers = new Set((d.ledger ?? []).map((l) => l.peer));
  const items: Item[] = [
    ...d.q.jobs.filter((j) => j.state === "running" && !peers.has(j.caller)).map((j) => ({
      key: j.id, model: j.model, caller: j.caller || "local", ...(j.peer ? { peer: j.peer } : { backend: j.backend }), live: true, at: j.since,
    })),
    ...(d.recent ?? []).map((r, n) => ({ key: `done:${r.t}:${n}`, model: r.model, caller: r.caller, backend: r.backend, peer: r.peer, live: false, at: r.t, ms: r.ms, ok: r.ok })),
  ].slice(0, SHOWN);


  if (!open) {
    return (
      <button type="button" onClick={toggle} title="show recent requests" aria-label="show recent requests"
              className="flex w-8 shrink-0 flex-col items-center gap-2 border-r border-line bg-panel pt-3 text-dim hover:text-fg max-md:hidden">
        <ChevronsRight size={14} />
        <span className="text-[11px] [writing-mode:vertical-rl]">recent requests</span>
      </button>
    );
  }
  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-line bg-panel max-md:hidden">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-dim">recent requests</span>
          <button type="button" onClick={toggle} aria-label="hide recent requests" title="hide" className="ml-auto text-dim hover:text-fg"><ChevronsLeft size={14} /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {items.length === 0 && <p className="p-2 text-[12px] text-dim">Requests this node makes show here. Point at one to light up where it ran.</p>}
          {items.map((i) => {
            const where = i.peer ? `the peer ${i.peer}` : i.backend ? i.backend : null;
            const to = target(i);
            return (
              <button type="button" key={i.key} disabled={to === null}
                   onMouseEnter={() => light(to)} onMouseLeave={() => light(null)} onFocus={() => light(to)} onBlur={() => light(null)}
                   onClick={() => { if (to) select({ kind: to.startsWith("peer:") ? "peer" : "backend", id: to.slice(to.indexOf(":") + 1) }); }}
                   title={to ? "point to light it up on the map, click for its settings" : undefined}
                   className={cx("rounded-lg border bg-panel px-2.5 py-2 text-left text-[12px] enabled:hover:bg-muted focus-visible:outline-2 focus-visible:outline-accent", i.live ? "border-accent/50" : "border-line", i.ok === false && "border-bad/40")}>
                <div className={cx("flex items-center gap-1.5 font-medium", mono)}>
                  <span aria-hidden className={cx("size-1.5 shrink-0 rounded-full", i.live ? "animate-pulse bg-accent" : i.ok === false ? "bg-bad" : "bg-ok")} />
                  <span className="truncate">{i.model}</span>
                </div>
                <div className="text-dim">
                  from {i.caller} · {where === null ? "did not run" : `${i.live ? "running on" : "ran on"} ${where}`}
                </div>
                <div className="text-dim">
                  {i.live ? `for ${ago(Date.now() - i.at)}` : `${i.ok === false ? "failed after" : "took"} ${(i.ms! / 1000).toFixed(1)} s · ${ago(Date.now() - i.at)} ago`}
                </div>
              </button>
            );
          })}
        </div>
      </div>
  );
}
