/**
 * The node graph: self and peers, backends, then the cards they share, with an edge for each
 * relation. Nodes are HTML, edges SVG behind them; geometry lives in layout.ts. Motion only
 * ever means a real job in flight or one that just finished.
 */
import Box from "@mui/material/Box";
import GlobalStyles from "@mui/material/GlobalStyles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import { useEffect, useMemo, useRef, useState } from "react";

import { backendIcon, resourceIcon, TypeIcon, type IconKind } from "./icons.js";
import { MONO } from "./theme.js";
import { displayId } from "./lib.js";
import { SparkLedger, type Spark } from "./sparks.js";
import { blockers } from "./why.js";
import {
  glyphFor, layout, MIN_STAGE, orderBackends, polyLength, stitch, type Placed,
} from "./layout.js";
import type { Call, Job, Resource, UiData } from "./types.js";

/** The synthetic node for weights off the card: the host side, not a claim about RAM or disk. */
const HOST = "host";

/** What the inspector is currently showing. Null is the overview. */
export type Sel =
  | { kind: "self" }
  | { kind: "peer"; id: string }
  | { kind: "backend"; id: string }
  | { kind: "resource"; id: string }
  | null;

/* ----------------------------------------------------------------- layout */

/* --------------------------------------------------------------- traffic */

/** Which edge a job travels on, or null. A job accepted from a peer is on two: the return leg and our backend. */
function edgeOf(j: Job, peerNames: Set<string>): string | null {
  if (j.offbox) return j.peer ? `self>peer:${j.peer}` : null;
  if (peerNames.has(j.caller)) return `peer:${j.caller}>self`;
  return j.backend ? `self>backend:${j.backend}` : null;
}

/** Every edge a job puts traffic on: the peer leg it arrived by, and the backend. */
function edgesOf(j: Job, peerNames: Set<string>): string[] {
  const out: string[] = [];
  const first = edgeOf(j, peerNames);
  if (first) out.push(first);
  if (!j.offbox && peerNames.has(j.caller) && j.backend) out.push(`self>backend:${j.backend}`);
  return out;
}

/** Dots travel at one speed everywhere, with a floor and ceiling on each trip's duration. */
const PX_PER_MS = 1 / 3;
const pace = (len: number): number =>
  Math.round(Math.min(4200, Math.max(1200, len / PX_PER_MS)));

const laneColor = (lane: string): string =>
  lane === "chat" ? "success.main" : lane === "image" || lane === "edit" ? "warning.main" : "text.secondary";

/** Feeds frames to the SparkLedger (sparks.ts) and disposes it on unmount. */
function useSparks(calls: Call[] | undefined): Spark[] {
  const [sparks, setSparks] = useState<Spark[]>([]);
  const ledger = useRef<SparkLedger | null>(null);
  if (ledger.current === null) ledger.current = new SparkLedger(setSparks);

  // No per-frame cleanup: cancelling the timer on every frame strands sparks.
  useEffect(() => { ledger.current!.feed(calls); }, [calls]);
  useEffect(() => () => ledger.current!.dispose(), []);

  return sparks;
}

/* ----------------------------------------------------------------- nodes */

/** The shell every node shares: the click target, the selected ring, the tone. */
function NodeBox({ p, tone, icon, selected, peer, dim, onSelect, onHover, title, label, children }: {
  p: Placed;
  tone: "live" | "work" | "fault" | "cold" | "idle";
  icon: IconKind;
  selected: boolean;
  /** What this node is, in a few words: its accessible name, with the tooltip as its description. */
  label: string;
  /** A peer machine: a live peer takes the peer hue, self takes the success green. */
  peer?: boolean;
  /** Something else is hovered and this is not connected to it. */
  dim?: boolean;
  onSelect: () => void;
  onHover: (on: boolean) => void;
  title: string;
  children: React.ReactNode;
}) {
  // A healthy peer reads as the cool peer hue rather than self's green, so
  // same-shape machines still tell apart at a glance; down and busy keep the
  // shared state colours, which must stay consistent across the stage.
  const colour = tone === "live" ? (peer ? "peer.main" : "success.main")
    : tone === "work" ? "warning.main" : tone === "fault" ? "error.main"
    : tone === "cold" ? "cold.main" : "faint";
  // Big enough to be the thing you see first, and still inside a node narrow
  // enough that nine backends fit a laptop without the stage scrolling.
  const glyph = glyphFor(p.w);
  return (
    <Tooltip title={title} describeChild>
      <Box
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        sx={{
          position: "absolute", left: p.x, top: p.y, width: p.w, height: p.h,
          opacity: dim ? 0.35 : 1,
          boxSizing: "border-box", px: 1, py: 0.75, cursor: "pointer",
          display: "flex", alignItems: "center", gap: 1.25,
          // No border or fill at rest; the surface returns on hover and selection.
          borderRadius: 2.5,
          border: "1px solid",
          borderColor: selected ? "success.main" : "transparent",
          bgcolor: selected ? "background.paper" : "transparent",
          boxShadow: selected ? "0 0 0 2px rgba(141,181,128,.3)" : "none",
          transition: "border-color 160ms, background-color 160ms, box-shadow 160ms, opacity 180ms",
          "&:hover": {
            bgcolor: "background.paper",
            borderColor: selected ? "success.main" : "line",
          },
          "&:focus-visible": { outline: "2px solid", outlineColor: "success.main", outlineOffset: 2 },
        }}
      >
        <Box sx={{ color: colour, display: "flex", transition: "color 200ms" }}>
          <TypeIcon kind={icon} size={glyph} />
        </Box>
        <Box sx={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 0.25 }}>
          {children}
        </Box>
      </Box>
    </Tooltip>
  );
}

/** The node's name line: a status dot, the name, and a number on the right. */
function Head({ name, right }: { name: string; right?: React.ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
      <Typography component="span" sx={{
        fontFamily: MONO, fontSize: 12.5, fontWeight: 600, minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{name}</Typography>
      {right !== undefined && <Box sx={{ ml: "auto", flexShrink: 0 }}>{right}</Box>}
    </Box>
  );
}

const Sub = ({ children, color = "faint", sx }: {
  children: React.ReactNode; color?: string; sx?: Record<string, unknown>;
}) => (
  <Typography component="span" sx={{
    fontFamily: MONO, fontSize: 10.5, color, display: "block",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    ...sx,
  }}>{children}</Typography>
);

/** The last ten minutes of finished requests on one backend, as bars, so an idle moment still shows use. */
function Sparks({ calls, now }: { calls: Call[]; now: number }) {
  const BUCKETS = 20;
  const WINDOW = 10 * 60_000;
  const bars = new Array<number>(BUCKETS).fill(0);
  for (const c of calls) {
    const age = now - c.t;
    if (age < 0 || age > WINDOW) continue;
    const i = BUCKETS - 1 - Math.min(BUCKETS - 1, Math.floor(age / (WINDOW / BUCKETS)));
    bars[i] = (bars[i] ?? 0) + 1;
  }
  const peak = Math.max(...bars);
  if (!peak) {
    return <Box aria-hidden sx={{ height: 12, borderBottom: "1px solid", borderColor: "divider", opacity: 0.5 }} />;
  }
  return (
    <Box aria-label={`${calls.length} requests in the last ten minutes`}
         sx={{ display: "flex", alignItems: "flex-end", gap: "1px", height: 12 }}>
      {bars.map((v, i) => (
        <Box key={i} sx={{
          flex: 1, minWidth: 0,
          // A bucket with nothing in it still draws a floor, so the row reads as
          // a timeline rather than a gap in the layout.
          height: v ? `${Math.max(18, (v / peak) * 100)}%` : "1px",
          bgcolor: v ? "success.main" : "divider",
          opacity: v ? 0.55 + 0.45 * (v / peak) : 1,
          borderRadius: "1px",
        }} />
      ))}
    </Box>
  );
}

/** Slots as pips, or a fraction once pips stop being countable. */
function Pips({ used, slots }: { used: number; slots: number }) {
  if (!slots) return null;
  if (slots > 12) {
    return <Sub color={used ? "success.main" : "faint"}>{used}/{slots}</Sub>;
  }
  return (
    <Box aria-label={`${used} of ${slots} slots in use`}
         sx={{ display: "flex", gap: "2px", alignItems: "center" }}>
      {Array.from({ length: slots }, (_, i) => (
        <Box key={i} sx={{
          width: 4, height: 8, borderRadius: "1px",
          bgcolor: i < used ? "success.main" : "divider",
          transition: "background-color 200ms",
        }} />
      ))}
    </Box>
  );
}

/* ----------------------------------------------------------------- stage */

export function Graph({ d, sel, onSelect }: {
  d: UiData;
  sel: Sel;
  onSelect: (s: Sel) => void;
}) {
  const t = useTheme();
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: MIN_STAGE, h: 380 });

  // Measured, not guessed: every position below is a pixel, and a stage laid
  // out for the wrong width puts the edges somewhere the nodes are not.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = (w: number, h: number) =>
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    const ro = new ResizeObserver(([e]) => {
      if (e) measure(Math.max(MIN_STAGE, e.contentRect.width), Math.max(320, e.contentRect.height));
    });
    ro.observe(el);
    measure(Math.max(MIN_STAGE, el.clientWidth), Math.max(320, el.clientHeight));
    return () => ro.disconnect();
  }, []);

  const self = d.net.nodes.find((n) => n.self);
  const peers = d.net.nodes.filter((n) => !n.self);
  const backends = self?.backends ?? [];
  // The host node, synthesised only while some model has weights there, and placed like a card.
  const declared = d.net.resources ?? [];
  const spilling = backends
    .map((b) => ({
      b,
      split: (b.offload ?? []).filter((o) => o.cpuLayers !== null || o.cpuExpertsAll),
    }))
    .filter((x) => x.split.length > 0);
  const hostNode: Resource | null = spilling.length && !declared.some((r) => r.name === HOST)
    ? {
        name: HOST,
        kind: "other",
        // Several backends can have weights there at once and none of them
        // waits for another, which is exactly what `shared` means.
        shared: true,
        holder: null,
        backends: spilling.map((x) => x.b.name),
        host: {
          // The cards this is the other half OF. A split model is running on a
          // card AND here at once, and the pair is the thing worth drawing:
          // every token crosses between them.
          cards: [...new Set(spilling.flatMap((x) => x.b.resources ?? []))]
            .filter((name) => declared.some((r) => r.name === name && !r.shared)),
          detail: spilling
            .flatMap((x) => x.split.map((o) => `${o.model} · ${
              o.cpuExpertsAll ? "all experts" : `${o.cpuLayers} layers`}`))
            .join(", "),
        },
      }
    : null;
  const resources = hostNode ? [...declared, hostNode] : declared;

  const scene = useMemo(
    // Laid out in hardware order so the wires to the cards do not cross; nodes are drawn by name.
    () => layout(box.w, box.h, peers, orderBackends(backends, resources), resources),
    // The identity of these arrays changes every poll; their SHAPE is what the
    // layout depends on, and re-running it on unchanged shape would recompute
    // the same numbers three times a second for nothing.
    [box.w, box.h, peers.map((p) => p.name).join(), backends.map((b) => b.name).join(),
     resources.map((r) => `${r.name}:${r.backends.join("+")}`).join()],
  );

  const [hover, setHover] = useState<string | null>(null);
  const jobs = d.q.jobs.filter((j) => j.state === "running");
  const sparks = useSparks(d.calls);
  const peerNames = useMemo(() => new Set(peers.map((p) => p.name)), [peers.map((p) => p.name).join()]);
  // One clock for every sparkline, so twenty of them do not each hold a timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Which edges are carrying anything and how much, so a still edge stays still
  // and a busy one can say how busy.
  const traffic = useMemo(() => {
    const m = new Map<string, number>();
    // Edges whose traffic hearth is NOT scheduling. Drawn amber rather than
    // green, because "this is busy" and "I am managing this" are different
    // claims and the whole point of drawing passthrough is that they differ.
    const loose = new Set<string>();
    const bump = (id: string) => m.set(id, (m.get(id) ?? 0) + 1);
    for (const j of jobs) for (const e of edgesOf(j, peerNames)) bump(e);
    const managed = new Set(m.keys());

    for (const b of backends) {
      const n = (b.proxying ?? []).length;
      if (!n) continue;
      const toBackend = `self>backend:${b.name}`;
      for (let i = 0; i < n; i++) bump(toBackend);
      if (!managed.has(toBackend)) loose.add(toBackend);
    }

    /**
     * Hardware edges light for the backend using the hardware, not for the arbiter's holder:
     * shared hardware has no holder. Scheduled work is green even on shared hardware.
     */
    for (const b of backends) {
      const running = jobs.some((j) => !j.offbox && j.backend === b.name);
      // Observed activity joins forwarded, never running: it is work hearth
      // watches but did not admit, so the card leg lights amber and the arbiter
      // still holds no one for it.
      const forwarded = (b.proxying ?? []).length > 0
        || (b.activity?.ok === true && b.activity.running > 0);
      if (!running && !forwarded) continue;
      for (const r of b.resources ?? []) {
        const toCard = `backend:${b.name}>resource:${r}`;
        if (!m.has(toCard)) m.set(toCard, 0);
        if (!running && forwarded) loose.add(toCard);
      }
    }

    // A spark lights the whole run it travels, card leg included — the edge it
    // is moving along must not be the one edge still drawn as idle.
    for (const sp of sparks) {
      const first = `self>backend:${sp.backend}`;
      if (!m.has(first)) m.set(first, 0);
      const b = backends.find((x) => x.name === sp.backend);
      for (const r of b?.resources ?? []) {
        const toCard = `backend:${sp.backend}>resource:${r}`;
        if (!m.has(toCard)) m.set(toCard, 0);
      }
    }
    return { count: m, loose };
  }, [jobs, sparks, resources, backends, peerNames]);

  // Hovering one node quietens everything not attached to it. With five
  // backends over two cards the edges already cross; the picture is only worth
  // having if you can pull one thread out of it.
  const near = useMemo(() => {
    if (!hover) return null;
    const s = new Set<string>([hover]);
    for (const e of scene.edges) {
      if (e.from === hover) s.add(e.to);
      if (e.to === hover) s.add(e.from);
    }
    return s;
  }, [hover, scene]);
  const dimmed = (id: string) => !!near && !near.has(id);

  /** One edge on its own, paced the same way. */
  const one = (id: string): { d: string; ms: number }[] => {
    const e = scene.edges.find((x) => x.id === id);
    return e ? [{ d: e.d, ms: pace(polyLength(e.poly)) }] : [];
  };


  /**
   * A request's whole journey as one stitched path, through the backend and down to its card.
   * A backend spanning two cards gets one dot per card.
   */
  const runs = (backend: string): { d: string; ms: number }[] => {
    const first = scene.edges.find((e) => e.id === `self>backend:${backend}`);
    if (!first) return [];
    const cards = scene.edges.filter(
      (e) => e.from === `backend:${backend}` && e.to.startsWith("resource:"),
    );
    const legs = cards.length ? cards.map((c) => [first, c]) : [[first]];
    return legs.map((set) => {
      const joined = stitch(set);
      return { d: joined.d, ms: pace(joined.len) };
    });
  };
  const queuedFor = (backend: string) =>
    d.q.jobs.filter((j) => j.state === "queued" && !j.offbox && j.backend === backend).length;

  return (
    <>
      <GlobalStyles styles={{
        "@keyframes hearth-flow": { from: { offsetDistance: "0%" }, to: { offsetDistance: "100%" } },
        "@keyframes hearth-dash": { to: { strokeDashoffset: -22 } },
        "@keyframes hearth-breathe": { "0%,100%": { opacity: 0.55 }, "50%": { opacity: 1 } },
        // Motion here is information, but nobody needs it badly enough to
        // override a system-level request to stop moving things.
        "@media (prefers-reduced-motion: reduce)": {
          "*": { animation: "none !important" },
        },
      }} />
      <Box ref={wrap} sx={{ overflowX: "auto", overflowY: "hidden", height: "100%", minHeight: 340 }}>
        <Box sx={{ position: "relative", height: scene.height, width: scene.width, minWidth: MIN_STAGE }}>
          <svg aria-hidden width={scene.width} height={scene.height}
               style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {scene.edges.map((e) => {
              const n = traffic.count.get(e.id);
              const hot = n !== undefined;
              const loose = traffic.loose.has(e.id);
              const off = !!near && !near.has(e.from) && !near.has(e.to);
              // Literal colours: `sx` does not map `stroke` onto the palette.
              // Weights on the host are a standing condition, so that edge is lit and still.
              const spill = e.to === `resource:${HOST}`;
              return (
                <path key={e.id} d={e.d} fill="none"
                      stroke={spill ? t.palette.cold.main
                        : loose ? t.palette.warning.main : hot ? t.palette.success.main : t.palette.line}
                      strokeWidth={spill || hot ? 1.4 : 1}
                      strokeDasharray={hot && !spill ? "3 8" : undefined}
                      opacity={off ? 0.12 : spill ? 0.75 : hot ? 0.85 : 0.55}
                      style={{
                        animation: hot && !spill ? "hearth-dash 900ms linear infinite" : undefined,
                        transition: "stroke 240ms, opacity 240ms",
                      }} />
              );
            })}
            {/* Three dots reads as "some"; a 3 reads as three. */}
            {scene.edges.map((e) => {
              const n = traffic.count.get(e.id) ?? 0;
              if (n < 2) return null;
              const loose = traffic.loose.has(e.id);
              return (
                <g key={`n:${e.id}`} opacity={near && !near.has(e.from) && !near.has(e.to) ? 0.15 : 1}>
                  <circle cx={e.mid.x} cy={e.mid.y} r={8} fill={t.palette.background.paper}
                          stroke={loose ? t.palette.warning.main : t.palette.success.main} strokeWidth={1} />
                  <text x={e.mid.x} y={e.mid.y + 3.5} textAnchor="middle"
                        fill={loose ? t.palette.warning.main : t.palette.success.main}
                        style={{ font: `600 9px ${MONO}` }}>{n}</text>
                </g>
              );
            })}
          </svg>

          {/* The moving half, in its own layer so a job that ends does not
              re-render every edge under it. */}
          <Box aria-hidden sx={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {jobs.flatMap((j, i) => {
              // Off-box work ends at the peer; work accepted from a peer also runs down to our card.
              const legs = j.offbox
                ? one(edgeOf(j, peerNames) ?? "")
                : [
                    ...(peerNames.has(j.caller) ? one(`peer:${j.caller}>self`) : []),
                    ...(j.backend ? runs(j.backend) : []),
                  ];
              return legs.map((leg, k) => (
                <Box key={`${j.id}:${k}`} sx={{
                  position: "absolute", width: 7, height: 7, borderRadius: "50%",
                  bgcolor: laneColor(j.lane),
                  boxShadow: "0 0 6px currentColor", color: laneColor(j.lane),
                  offsetPath: `path("${leg.d}")`, offsetRotate: "0deg",
                  // Staggered so two jobs on one edge read as two things, not
                  // one brighter thing.
                  animation: `hearth-flow ${leg.ms}ms linear infinite ${i * -260}ms`,
                }} />
              ));
            })}
            {backends.flatMap((b) => (b.proxying ?? []).flatMap((x, i) =>
              // Forwarded work reaches the card as surely as scheduled work
              // does — the whole point of drawing it is that the GPU is busy
              // with something hearth is not managing.
              runs(b.name).map((leg, k) => (
                <Box key={`${x.id}:${k}`} sx={{
                  position: "absolute", width: 7, height: 7, borderRadius: "50%",
                  // Hollow, so an unqueued request is not mistaken for a job the
                  // scheduler is managing. It is moving and it is real; nothing
                  // is holding a slot for it.
                  bgcolor: "transparent", border: "1.5px solid", borderColor: "warning.main",
                  offsetPath: `path("${leg.d}")`, offsetRotate: "0deg",
                  animation: `hearth-flow ${leg.ms}ms linear infinite ${i * -300}ms`,
                }} />
              )),
            ))}
            {sparks.flatMap((s) =>
              // A finished request's journey, replayed once.
              runs(s.backend).map((leg, k) => (
                <Box key={`${s.key}:${k}`} sx={{
                  position: "absolute", width: 5, height: 5, borderRadius: "50%",
                  bgcolor: s.color, opacity: 0.85,
                  offsetPath: `path("${leg.d}")`, offsetRotate: "0deg",
                  animation: `hearth-flow ${Math.round(leg.ms * 0.55)}ms cubic-bezier(.4,0,.5,1) 1 both`,
                }} />
              )),
            )}
          </Box>

          {/* Self */}
          {(() => {
            const p = scene.nodes.get("self")!;
            const running = d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length;
            const queued = Object.values(d.q.capacity.queued).reduce((a, b) => a + b, 0);
            return (
              <NodeBox p={p} tone={queued ? "work" : "live"} icon="self"
                       label={`${self?.name ?? "this node"}, this node, ${running} running, ${queued} queued`}
                       selected={sel?.kind === "self"}
                       dim={dimmed("self")} onHover={(on) => setHover(on ? "self" : null)}
                       onSelect={() => onSelect({ kind: "self" })}
                       title="this node — click for federation switches and unsaved runtime changes">
                <Head name={self?.name ?? "this node"}
                      right={<Typography component="span" sx={{ fontFamily: MONO, fontSize: 10, color: "faint" }}>self</Typography>} />
                <Sub>{running} running · {queued} queued{d.q.capacity.offbox ? ` · ${d.q.capacity.offbox} off-box` : ""}</Sub>
                <Sub color={d.controls.lending === false || d.controls.borrowing === false ? "warning.main" : "faint"}>
                  {d.controls.lending === false && d.controls.borrowing === false ? "lending + borrowing paused"
                    : d.controls.lending === false ? "lending paused"
                    : d.controls.borrowing === false ? "borrowing paused"
                    : `${d.share.length} model${d.share.length === 1 ? "" : "s"} lent`}
                </Sub>
              </NodeBox>
            );
          })()}

          {/* Peers */}
          {peers.map((n) => {
            const p = scene.nodes.get(`peer:${n.name}`);
            if (!p) return null;
            const busy = (n.slots ?? 0) - (n.free ?? 0);
            const unmapped = (n.unmapped ?? []).length;
            return (
              <NodeBox key={n.name} p={p} peer tone={!n.up ? "fault" : n.free === 0 ? "work" : "live"}
                       icon="peer"
                       label={`${n.name}, peer, ${n.up ? `${busy} of ${n.slots ?? "unknown"} busy` : "not answering"}`}
                       selected={sel?.kind === "peer" && sel.id === n.name}
                       dim={dimmed(`peer:${n.name}`)}
                       onHover={(on) => setHover(on ? `peer:${n.name}` : null)}
                       onSelect={() => onSelect({ kind: "peer", id: n.name })}
                       title={n.up
                         ? `${n.name} is answering — click to link or unlink its models`
                         : `${n.name} is not answering${n.lastError ? `: ${n.lastError}` : ""}`}>
                <Head name={n.name}
                      right={<Pips used={Math.max(0, busy)} slots={n.slots ?? 0} />} />
                <Sub color={n.up ? "faint" : "error.main"}>
                  {n.up ? `${busy}/${n.slots ?? "?"} busy · ${n.queued ?? 0} queued` : "down"}
                </Sub>
                <Sub color={unmapped ? "warning.main" : "faint"}>
                  {unmapped ? `${unmapped} unclaimed` : `${Object.keys(n.map ?? {}).length} linked`}
                </Sub>
              </NodeBox>
            );
          })}

          {/* Backends */}
          {backends.map((b) => {
            const p = scene.nodes.get(`backend:${b.name}`);
            if (!p) return null;
            const slots = b.slots ?? 0;
            const q = b.queued ?? queuedFor(b.name);
            // What is running here, not what admission would refuse.
            const used = jobs.filter((j) => !j.offbox && j.backend === b.name).length;
            const held = blockers(b, resources);
            // Blocked means WAITING, not merely unlucky. A backend with nothing
            // to do is idle no matter who holds the card it would have wanted,
            // and painting it amber is how a colour stops meaning anything.
            const stalled = held.length > 0 && q > 0;
            const loaded = (b.loaded ?? []).map((m) => displayId(m, d.aliases, d.net.available));
            const loading = (b.loading ?? []).map((m) => displayId(m, d.aliases, d.net.available));
            const split = (b.offload ?? []).filter((o) => o.cpuLayers !== null || o.cpuExpertsAll);
            const proxied = b.proxying ?? [];
            // A declared activity path: running is amber like forwarded work; an unread value is unknown, not idle.
            const active = b.activity?.ok === true && b.activity.running > 0;
            // Queued in the backend's own queue: waiting, not idle.
            const waiting = b.activity?.ok === true && (b.activity.queued ?? 0) > 0;
            // Silence from a backend whose event stream we hold; outranks every other state.
            const mute = b.answering === false;
            // A load outranks a running job for the node's own colour: the job IS
            // the load, and "running" is the least useful of the two things to
            // say about a backend that will be busy for another minute.
            const tone = mute ? "fault"
              : loading.length ? "cold"
              : stalled ? "work"
              : used > 0 || proxied.length || active ? "live" : q > 0 || waiting ? "work" : "idle";
            return (
              <NodeBox key={b.name} p={p} tone={tone}
                       icon={backendIcon(b.kind, (b.routes ?? []).length > 0)}
                       label={`${b.name}, backend, ${mute ? "no answer in a minute"
                         : loading.length ? `loading ${loading.join(", ")}`
                         : stalled ? "blocked"
                         : used > 0 ? `${used} running`
                         : proxied.length ? `${proxied.length} forwarded`
                         : active ? `${b.activity?.running} working`
                         : waiting ? `${b.activity?.queued} queued`
                         : b.activity && !b.activity.ok ? "activity unknown" : "idle"}`}
                       selected={sel?.kind === "backend" && sel.id === b.name}
                       dim={dimmed(`backend:${b.name}`)}
                       onHover={(on) => setHover(on ? `backend:${b.name}` : null)}
                       onSelect={() => onSelect({ kind: "backend", id: b.name })}
                       title={mute
                         ? `Nothing has come back from ${b.name} in a minute. hearth holds an event stream to it, so this is silence on a connection that should be talking — not merely a quiet backend. Anything below is the last thing it said.`
                         : loading.length
                         ? `${b.name} is loading ${loading.join(", ")} from disk. Nothing else can start on its card until that finishes, and a cold load of a large model is tens of seconds — the request waiting on it is not stuck.`
                         : stalled
                         ? `${q} waiting on hardware someone else holds — ${held.map((r) => `${r.holder} has ${r.name}`).join(", ")}`
                         : held.length
                           ? `idle. ${held.map((r) => `${r.holder} holds ${r.name}`).join(", ")}, so it could not start anyway — but it has nothing to start.`
                         : proxied.length
                           ? `${proxied.length} request(s) are being forwarded straight through to ${b.name}. hearth is not scheduling them: they hold no slot, wait for nothing, and the card arbiter cannot see them.`
                           : `${b.name}${b.url ? ` · ${b.url}` : ""} — click for its models`}>
                <Head name={b.name} right={<Pips used={Math.max(0, used)} slots={slots} />} />
                {/* A load outranks everything else this line could say. While it
                    runs the backend has nothing loaded and a job running, and
                    both of those readings are true and useless — the fact that
                    matters is that a file is coming off a disk and the wait is
                    expected. It breathes because it is the one state here that
                    ends on its own. */}
                <Sub color={mute ? "error.main"
                  : loading.length ? "cold.main"
                  : stalled ? "warning.main" : loaded.length ? "success.main" : "faint"}
                     sx={loading.length && !mute ? { animation: "hearth-breathe 1.8s ease-in-out infinite" } : undefined}>
                  {mute ? "no answer in a minute"
                    : loading.length ? `loading ${loading.join(", ")}`
                    : stalled ? `blocked · ${held.map((r) => r.name).join(", ")}`
                    : loaded.length ? loaded.join(", ")
                    : held.length ? `${held.map((r) => r.name).join(", ")} busy`
                    : b.knowsWarm === false ? "warmth unknown" : "nothing loaded"}
                </Sub>
                {split.length > 0 && (
                  // Repeated here so it shows where you look when asking why this backend is slow.
                  <Sub color="cold.main">
                    {/* The model is named on the line above; repeating it here
                        only bought a truncated ellipsis, the same way it did
                        for the forwarded count. */}
                    {split.map((o) => o.cpuExpertsAll
                      ? "experts on host"
                      : `${o.cpuLayers} layers on host`).join(", ")}
                  </Sub>
                )}
                {q > 0 && <Sub color="warning.main">{q} waiting</Sub>}
                {proxied.length > 0 && (
                  // The model is already on the line above; repeating it here
                  // only bought a truncated ellipsis.
                  <Sub color="warning.main">
                    {proxied.length} forwarded
                  </Sub>
                )}
                {active && (
                  // Amber like forwarded work, and for the same reason: real work
                  // on the card that hearth is watching, not scheduling.
                  <Sub color="warning.main">
                    {b.activity?.running} working{b.activity?.queued ? `, ${b.activity.queued} queued` : ""}
                  </Sub>
                )}
                {!active && waiting && (
                  // Waiting, with nothing on the card yet — so not amber, which
                  // means work is running. Said anyway: it is the difference
                  // between a backend at rest and one with a queue.
                  <Sub color="faint">{b.activity?.queued} queued</Sub>
                )}
                {b.activity && !b.activity.ok && (
                  // The read did not come back — NOT a claim that it is idle.
                  // Muted, not amber: nothing is known to be running here, only
                  // that we cannot say, which must read apart from a confirmed rest.
                  <Sub color="faint">activity unknown</Sub>
                )}
                <Sparks calls={(d.calls ?? []).filter((c) => c.backend === b.name)} now={now} />
              </NodeBox>
            );
          })}

          {/* Cards */}
          {resources.map((r) => {
            const p = scene.nodes.get(`resource:${r.name}`);
            if (!p) return null;
            const waiting = backends.filter((b) => (b.resources ?? []).includes(r.name)
              && b.name !== r.holder && (b.queued ?? 0) > 0);
            // Work on this card that the arbiter knows nothing about. Drawing it
            // as "free" was true of the arbiter and false of the hardware; the
            // fix is to say both things rather than to fake a holder.
            const unqueued = backends.filter((b) => (b.resources ?? []).includes(r.name)
              && ((b.proxying ?? []).length > 0
                || (b.activity?.ok === true && b.activity.running > 0)));
            // For shared hardware there is no holder to report, so what is worth
            // saying is how many of the things on it are actually working.
            const inUse = backends.filter((b) => (b.resources ?? []).includes(r.name)
              && jobs.some((j) => !j.offbox && j.backend === b.name));
            // A card whose backend is mid-load is not merely busy: nothing else
            // can have it for as long as the read takes, and that is the number
            // worth knowing when you are looking at why a queue is not moving.
            const filling = backends.filter((b) => (b.resources ?? []).includes(r.name)
              && (b.loading ?? []).length > 0);
            return (
              <NodeBox key={r.name} p={p}
                       // Shared hardware is never "held", so it never goes green
                       // for a holder. Busy is still busy: work on it still reads
                       // as work.
                       tone={r.host || filling.length ? "cold"
                         : r.holder ? "live" : unqueued.length ? "work"
                         : r.shared && inUse.length ? "live" : "idle"}
                       icon={r.host ? "ram" : resourceIcon(r.kind)}
                       label={`${r.name}, ${r.host ? "host memory" : "hardware"}, ${
                         r.host ? "holding weights that did not fit on a card"
                           : filling.length ? "loading a model"
                           : r.shared ? `shared, ${inUse.length} working`
                           : r.holder ? `${r.holder} holding`
                           : unqueued.length ? "in use, unscheduled" : "free"}`}
                       selected={sel?.kind === "resource" && sel.id === r.name}
                       dim={dimmed(`resource:${r.name}`)}
                       onHover={(on) => setHover(on ? `resource:${r.name}` : null)}
                       onSelect={() => onSelect({ kind: "resource", id: r.name })}
                       title={r.host
                         ? `Weights that did not fit on a card: ${r.host.detail}. They are assigned to the host and computed on the CPU, so EVERY token pays for them — this is the model's running speed, not a startup cost. Whether they are served from RAM or read off the disk depends on whether the model fits in RAM, which cannot be seen from here. It is the trade that lets a model too big for the card run at all, so it is a fact to know rather than a fault to clear.`
                         : filling.length
                         ? `${filling.map((b) => b.name).join(", ")} is reading a model onto ${r.name}. A cold load is tens of seconds and nothing else can have the card until it finishes — so a queue that looks stopped is waiting on a disk, not on a decision.`
                         : r.shared
                         ? `${r.name} is shared: everything declared on it runs at once, so hearth does not arbitrate it and nothing waits for it. ${backends.filter((b) => (b.resources ?? []).includes(r.name)).length} backend(s) use it.`
                         : r.holder
                         ? `${r.holder} is running on ${r.name}; everything else declared on it waits`
                         : unqueued.length
                           ? `${r.name} is busy: ${unqueued.map((b) => b.name).join(", ")} is working on it. But hearth is not scheduling that work — it was forwarded straight through — so hearth cannot make anything else wait for this card while it runs.`
                           : `${r.name} is free — free and still loaded is the normal resting state`}>
                <Head name={r.name} />
                <Sub color={r.host || filling.length ? "cold.main"
                  : r.holder || (r.shared && inUse.length) ? "success.main"
                  : unqueued.length ? "warning.main" : "faint"}
                     sx={filling.length && !r.host
                       ? { animation: "hearth-breathe 1.8s ease-in-out infinite" }
                       : undefined}>
                  {/* Steady, not breathing. A load ends; this does not. */}
                  {r.host ? r.host.detail
                    : filling.length
                    ? `${filling[0]!.name} · loading`
                    : r.shared
                    ? (inUse.length ? `${inUse.length} of ${backends.filter((b) => (b.resources ?? []).includes(r.name)).length} working` : "shared · idle")
                    : r.holder ? `${r.holder} holding`
                    : unqueued.length ? `${unqueued[0]!.name} · in use`
                    : "free"}
                  {!r.shared && waiting.length ? ` · ${waiting.length} waiting` : ""}
                </Sub>
                {/* A card is either held or not; there is no partial. The bar is
                    a presence, not a percentage. */}
                <Box sx={{
                  height: 3, borderRadius: 2, mt: 0.25,
                  bgcolor: r.holder ? "success.main" : unqueued.length ? "warning.main" : "divider",
                  opacity: r.holder || unqueued.length ? 1 : 0.7,
                  // Only for hardware something is HOLDING. A shared resource is
                  // never held, and a bar that pulses on one would be claiming
                  // the exclusivity this whole change exists to deny.
                  animation: (r.holder || unqueued.length) && !r.shared
                    ? "hearth-breathe 2.4s ease-in-out infinite" : undefined,
                  transition: "background-color 240ms",
                }} />
              </NodeBox>
            );
          })}
        </Box>
      </Box>
    </>
  );
}
