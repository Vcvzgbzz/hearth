/**
 * The node graph: what this box is made of, and what is moving through it.
 *
 * The page used to be four stacked tables, and the thing they could not show is
 * the thing hearth exists to manage — that a request goes to a backend, that a
 * backend stands on a card, and that another backend is waiting for the same
 * card. Those are edges, and a table has no edges.
 *
 * Structure, three rows, top to bottom:
 *
 *   self and its peers   who we are, who we can borrow from
 *   backends             the admission domains
 *   cards                the silicon they take turns on
 *
 * Nodes are ordinary HTML positioned absolutely; only the edges and the things
 * travelling along them are SVG. Text in SVG cannot wrap, cannot use the theme's
 * type scale without restating it, and cannot be a focusable control without
 * hand-rolling one — and every node here is a control. So the SVG layer is
 * strictly lines, and sits behind.
 *
 * Nothing here is decorative motion. A particle on an edge is a job that is
 * really in flight (`q.jobs`) or a request that really just finished (`calls`),
 * and an edge with no traffic is drawn still. A dashboard that animates when
 * nothing is happening teaches you to ignore it.
 */
import Box from "@mui/material/Box";
import GlobalStyles from "@mui/material/GlobalStyles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import { useEffect, useMemo, useRef, useState } from "react";

import { MONO } from "./theme.js";
import { displayId } from "./lib.js";
import { blockers } from "./why.js";
import type { Backend, Call, Job, Node, Resource, UiData } from "./types.js";

/** What the inspector is currently showing. Null is the overview. */
export type Sel =
  | { kind: "self" }
  | { kind: "peer"; id: string }
  | { kind: "backend"; id: string }
  | { kind: "resource"; id: string }
  | null;

export const selEq = (a: Sel, b: Sel): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind
    && (a.kind === "self" || b.kind === "self" || a.id === (b as { id: string }).id));

/* ----------------------------------------------------------------- layout */

const GAP = 18;
const PAD = 10;
const H = { self: 76, peer: 76, backend: 80, resource: 58 } as const;
/** Below this the columns stop being readable and the stage scrolls instead. */
const MIN_STAGE = 640;
/** The tightest the three rows go before the edges are too short to read. */
const MIN_GAP = 72;
const MAX_GAP = 150;

/** Row tops for a given stage height: the rows share whatever is spare. */
function rows(height: number): [number, number, number] {
  const content = H.self + H.backend + H.resource;
  const gap = Math.max(MIN_GAP, Math.min(MAX_GAP, (height - content - PAD * 2) / 2));
  const top = Math.max(PAD, (height - content - gap * 2) / 2);
  return [top, top + H.self + gap, top + H.self + gap + H.backend + gap];
}

interface Placed {
  id: string;
  kind: "self" | "peer" | "backend" | "resource";
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Edge {
  id: string;
  from: string;
  to: string;
  /** Sibling links leave sideways; parent links leave downwards. */
  dir: "across" | "down";
  d: string;
  /** Where a count sits, and the only point on the path we need in JS. */
  mid: { x: number; y: number };
}

interface Scene {
  nodes: Map<string, Placed>;
  edges: Edge[];
  width: number;
  height: number;
}

/** B(0.5) of a cubic, which is where a label on it belongs. */
const midOf = (p0: number, p1: number, p2: number, p3: number): number =>
  (p0 + 3 * p1 + 3 * p2 + p3) / 8;

/**
 * A cubic with its control points pushed out along the direction of travel.
 *
 * `lift` bows the curve off the straight line between two nodes, which is what
 * lets one pair carry two edges: out and back are different facts about a peer
 * — whether you are leaning on them or they on you — and drawn on one line they
 * are indistinguishable.
 */
function curve(a: Placed, b: Placed, dir: "across" | "down", lift = 0): {
  d: string; mid: { x: number; y: number };
} {
  if (dir === "across") {
    // Right-to-left when the target is left of the source, so the return leg
    // starts at the peer and a particle on it travels the way the work does.
    const back = b.x < a.x;
    const x1 = back ? a.x : a.x + a.w, y1 = a.y + a.h / 2 + lift * 0.5;
    const x2 = back ? b.x + b.w : b.x, y2 = b.y + b.h / 2 + lift * 0.5;
    const k = Math.max(28, Math.abs(x2 - x1) * 0.42) * (back ? -1 : 1);
    const c1y = y1 + lift, c2y = y2 + lift;
    return {
      d: `M ${x1} ${y1} C ${x1 + k} ${c1y} ${x2 - k} ${c2y} ${x2} ${y2}`,
      mid: { x: midOf(x1, x1 + k, x2 - k, x2), y: midOf(y1, c1y, c2y, y2) },
    };
  }
  const x1 = a.x + a.w / 2, y1 = a.y + a.h;
  const x2 = b.x + b.w / 2, y2 = b.y;
  const k = Math.max(20, (y2 - y1) * 0.55);
  return {
    d: `M ${x1} ${y1} C ${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`,
    mid: { x: midOf(x1, x1, x2, x2), y: midOf(y1, y1 + k, y2 - k, y2) },
  };
}

/**
 * Place everything for a given stage width.
 *
 * Deterministic: same payload and same width give the same picture every poll.
 * That is not an aesthetic preference — a node that moves between polls cannot
 * be clicked, and a particle mid-flight would jump.
 */
function layout(width: number, height: number, self: Node | undefined, peers: Node[],
                backends: Backend[], resources: Resource[]): Scene {
  const nodes = new Map<string, Placed>();
  const inner = width - PAD * 2;
  const ROW_Y = rows(height);

  // Row 0. Self anchors the left; peers fill from the right so the gap between
  // them is the visual span of the link, and one peer sits opposite us.
  const selfW = Math.min(240, Math.max(190, inner * 0.24));
  nodes.set("self", { id: "self", kind: "self", x: PAD, y: ROW_Y[0], w: selfW, h: H.self });
  if (peers.length) {
    const pw = Math.min(210, Math.max(150, (inner * 0.55 - (peers.length - 1) * GAP) / peers.length));
    const span = peers.length * pw + (peers.length - 1) * GAP;
    const start = PAD + inner - span;
    peers.forEach((p, i) => nodes.set(`peer:${p.name}`, {
      id: `peer:${p.name}`, kind: "peer", x: start + i * (pw + GAP), y: ROW_Y[0], w: pw, h: H.peer,
    }));
  }

  // Row 1. Backends share the full width; below the clamp the stage scrolls
  // rather than squeezing a name into 60px.
  const n = backends.length;
  if (n) {
    const bw = Math.min(170, Math.max(104, (inner - (n - 1) * GAP) / n));
    const span = n * bw + (n - 1) * GAP;
    const start = PAD + Math.max(0, (inner - span) / 2);
    backends.forEach((b, i) => nodes.set(`backend:${b.name}`, {
      id: `backend:${b.name}`, kind: "backend", x: start + i * (bw + GAP), y: ROW_Y[1], w: bw, h: H.backend,
    }));
  }

  // Row 2. A card sits under the backends that declare it, then siblings are
  // pushed apart — two cards drawn on top of each other is worse than two cards
  // slightly away from the backends they belong to, because the edges still say
  // which is which.
  const rw = Math.min(200, Math.max(120, (inner - (resources.length - 1) * GAP) / Math.max(1, resources.length)));
  const wanted = resources.map((r) => {
    const members = r.backends
      .map((b) => nodes.get(`backend:${b}`))
      .filter((p): p is Placed => !!p);
    const mid = members.length
      ? members.reduce((s, p) => s + p.x + p.w / 2, 0) / members.length
      : PAD + inner / 2;
    return { r, x: mid - rw / 2 };
  }).sort((a, b) => a.x - b.x);

  let cursor = PAD;
  for (const w of wanted) {
    const x = Math.max(cursor, Math.min(w.x, PAD + inner - rw));
    nodes.set(`resource:${w.r.name}`, {
      id: `resource:${w.r.name}`, kind: "resource", x, y: ROW_Y[2], w: rw, h: H.resource,
    });
    cursor = x + rw + GAP;
  }

  const edges: Edge[] = [];
  const push = (from: string, to: string, dir: "across" | "down", lift = 0) => {
    const a = nodes.get(from), b = nodes.get(to);
    if (!a || !b) return;
    const { d, mid } = curve(a, b, dir, lift);
    edges.push({ id: `${from}>${to}`, from, to, dir, d, mid });
  };
  // Two arcs per peer, bowed opposite ways: what we send them, and what they
  // send us. They are separate facts and one line cannot hold both.
  for (const p of peers) {
    push("self", `peer:${p.name}`, "across", -14);
    push(`peer:${p.name}`, "self", "across", 14);
  }
  for (const b of backends) push("self", `backend:${b.name}`, "down");
  for (const r of resources) for (const b of r.backends) push(`backend:${b}`, `resource:${r.name}`, "down");

  void self;
  return { nodes, edges, width, height };
}

/* --------------------------------------------------------------- traffic */

/**
 * Which edge a job travels on, or null if we cannot place it.
 *
 * A job we accepted FROM a peer takes the return leg — and then also runs on one
 * of our backends, so it legitimately appears on two edges. That is what is
 * happening: it arrived from over there, and it is running down here.
 */
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

const laneColor = (lane: string): string =>
  lane === "chat" ? "success.main" : lane === "image" || lane === "edit" ? "warning.main" : "text.secondary";

interface Spark { key: string; edge: string; color: string }

/**
 * One-shot sparks for requests that finished since the last poll.
 *
 * Running jobs already draw themselves, and at a homelab's duty cycle most
 * requests begin and end between two 3s polls — the queue is empty every time
 * you look, and the graph would sit dead while the box was busy. `calls` is the
 * record of exactly those, so a finished call gets one particle.
 *
 * The first payload carries up to ten minutes of them and fires NONE: seeding
 * the seen-set is the whole reason this keeps one.
 */
function useSparks(calls: Call[] | undefined): Spark[] {
  const seen = useRef<Set<string> | null>(null);
  const [sparks, setSparks] = useState<Spark[]>([]);

  useEffect(() => {
    if (!calls) return;
    const key = (c: Call) => `${c.t}:${c.model}:${c.backend}`;
    if (seen.current === null) { seen.current = new Set(calls.map(key)); return; }
    const fresh = calls.filter((c) => !seen.current!.has(key(c)));
    if (!fresh.length) return;
    for (const c of fresh) seen.current.add(key(c));
    // A burst of fifty would be a smear, not information. The newest few carry
    // the same message: that backend is working.
    const add = fresh.slice(-6).map((c) => ({
      key: `${key(c)}:${Math.random().toString(36).slice(2, 7)}`,
      edge: `self>backend:${c.backend}`,
      color: c.ok ? "success.main" : "error.main",
    }));
    setSparks((s) => [...s, ...add]);
    const t = setTimeout(() => setSparks((s) => s.filter((x) => !add.some((a) => a.key === x.key))), 1100);
    return () => clearTimeout(t);
  }, [calls]);

  // The set grows with a bounded 10-minute window, so it cannot run away — but
  // a long-lived tab still trims it against the window it is given.
  useEffect(() => {
    if (!calls || !seen.current || seen.current.size < 2000) return;
    seen.current = new Set(calls.map((c) => `${c.t}:${c.model}:${c.backend}`));
  }, [calls]);

  return sparks;
}

/* ----------------------------------------------------------------- nodes */

/** The shell every node shares: the click target, the selected ring, the tone. */
function NodeBox({ p, tone, selected, dim, onSelect, onHover, title, children }: {
  p: Placed;
  tone: "live" | "work" | "fault" | "idle";
  selected: boolean;
  /** Something else is hovered and this is not connected to it. */
  dim?: boolean;
  onSelect: () => void;
  onHover: (on: boolean) => void;
  title: string;
  children: React.ReactNode;
}) {
  const edge = tone === "live" ? "success.main" : tone === "work" ? "warning.main"
    : tone === "fault" ? "error.main" : "line";
  return (
    <Tooltip title={title}>
      <Box
        role="button"
        tabIndex={0}
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
          boxSizing: "border-box", px: 1.5, py: 1, cursor: "pointer",
          display: "flex", flexDirection: "column", justifyContent: "center", gap: 0.5,
          borderRadius: 2.5, border: "1px solid", borderColor: selected ? "success.main" : edge,
          bgcolor: "background.paper",
          // The selected ring is a shadow rather than a thicker border so the
          // box does not change size and shift its own text on click.
          boxShadow: selected ? "0 0 0 2px rgba(141,181,128,.35)" : "0 1px 2px rgba(0,0,0,.18)",
          transition: "border-color 180ms, box-shadow 180ms, transform 180ms, opacity 180ms",
          "&:hover": { transform: "translateY(-1px)", borderColor: selected ? "success.main" : "text.secondary" },
          "&:focus-visible": { outline: "2px solid", outlineColor: "success.main", outlineOffset: 2 },
        }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

/** The node's name line: a status dot, the name, and a number on the right. */
function Head({ tone, name, right }: { tone: string; name: string; right?: React.ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
      <Box component="span" aria-hidden sx={{
        width: 6, height: 6, borderRadius: "50%", flexShrink: 0, bgcolor: tone,
      }} />
      <Typography component="span" sx={{
        fontFamily: MONO, fontSize: 12.5, fontWeight: 600, minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{name}</Typography>
      {right !== undefined && <Box sx={{ ml: "auto", flexShrink: 0 }}>{right}</Box>}
    </Box>
  );
}

const Sub = ({ children, color = "faint" }: { children: React.ReactNode; color?: string }) => (
  <Typography component="span" sx={{
    fontFamily: MONO, fontSize: 10.5, color, display: "block",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  }}>{children}</Typography>
);

/**
 * The last ten minutes of finished requests on one backend, as bars.
 *
 * The graph is honest about live traffic and therefore still most of the time —
 * at a homelab duty cycle a visit usually lands between requests, and a page
 * that is correct and blank is a page you stop opening. `calls` is the record
 * of what has actually been used, so the node can say "busy all morning" while
 * nothing is in flight this second.
 */
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
  const resources = d.net.resources ?? [];

  const scene = useMemo(
    () => layout(box.w, box.h, self, peers, backends, resources),
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
    const bump = (id: string) => m.set(id, (m.get(id) ?? 0) + 1);
    for (const j of jobs) for (const e of edgesOf(j, peerNames)) bump(e);
    for (const sp of sparks) if (!m.has(sp.edge)) m.set(sp.edge, 0);
    for (const r of resources) {
      if (r.holder && !m.has(`backend:${r.holder}>resource:${r.name}`)) {
        m.set(`backend:${r.holder}>resource:${r.name}`, 0);
      }
    }
    return m;
  }, [jobs, sparks, resources, peerNames]);

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

  const path = (id: string) => scene.edges.find((e) => e.id === id)?.d;
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
              const n = traffic.get(e.id);
              const hot = n !== undefined;
              const off = !!near && !near.has(e.from) && !near.has(e.to);
              // Literal colours, not theme keys: MUI's `sx` maps `color` and
              // `bgcolor` onto the palette but NOT `stroke`, so `stroke:
              // "success.main"` emits that string as CSS, the browser drops the
              // declaration, and every edge on the page draws with no stroke at
              // all. Which is exactly how this shipped the first time.
              return (
                <path key={e.id} d={e.d} fill="none"
                      stroke={hot ? t.palette.success.main : t.palette.line}
                      strokeWidth={hot ? 1.4 : 1}
                      strokeDasharray={hot ? "3 8" : undefined}
                      opacity={off ? 0.12 : hot ? 0.85 : 0.55}
                      style={{
                        animation: hot ? "hearth-dash 900ms linear infinite" : undefined,
                        transition: "stroke 240ms, opacity 240ms",
                      }} />
              );
            })}
            {/* Three dots reads as "some"; a 3 reads as three. */}
            {scene.edges.map((e) => {
              const n = traffic.get(e.id) ?? 0;
              if (n < 2) return null;
              return (
                <g key={`n:${e.id}`} opacity={near && !near.has(e.from) && !near.has(e.to) ? 0.15 : 1}>
                  <circle cx={e.mid.x} cy={e.mid.y} r={8} fill={t.palette.background.paper}
                          stroke={t.palette.success.main} strokeWidth={1} />
                  <text x={e.mid.x} y={e.mid.y + 3.5} textAnchor="middle"
                        fill={t.palette.success.main}
                        style={{ font: `600 9px ${MONO}` }}>{n}</text>
                </g>
              );
            })}
          </svg>

          {/* The moving half, in its own layer so a job that ends does not
              re-render every edge under it. */}
          <Box aria-hidden sx={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {jobs.map((j, i) => {
              const p = path(edgeOf(j, peerNames) ?? "");
              if (!p) return null;
              return (
                <Box key={`${j.model}:${j.caller}:${j.since}`} sx={{
                  position: "absolute", width: 7, height: 7, borderRadius: "50%",
                  bgcolor: laneColor(j.lane),
                  boxShadow: "0 0 6px currentColor", color: laneColor(j.lane),
                  offsetPath: `path("${p}")`, offsetRotate: "0deg",
                  // Staggered so two jobs on one edge read as two things, not
                  // one brighter thing.
                  animation: `hearth-flow 1800ms linear infinite ${i * -260}ms`,
                }} />
              );
            })}
            {sparks.map((s) => {
              const p = path(s.edge);
              if (!p) return null;
              return (
                <Box key={s.key} sx={{
                  position: "absolute", width: 5, height: 5, borderRadius: "50%",
                  bgcolor: s.color, opacity: 0.85,
                  offsetPath: `path("${p}")`, offsetRotate: "0deg",
                  animation: "hearth-flow 1000ms cubic-bezier(.4,0,.5,1) 1 both",
                }} />
              );
            })}
          </Box>

          {/* Self */}
          {(() => {
            const p = scene.nodes.get("self")!;
            const running = d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length;
            const queued = Object.values(d.q.capacity.queued).reduce((a, b) => a + b, 0);
            return (
              <NodeBox p={p} tone={queued ? "work" : "live"} selected={sel?.kind === "self"}
                       dim={dimmed("self")} onHover={(on) => setHover(on ? "self" : null)}
                       onSelect={() => onSelect({ kind: "self" })}
                       title="this node — click for federation switches and unsaved runtime changes">
                <Head tone={queued ? "warning.main" : "success.main"} name={self?.name ?? "this node"}
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
              <NodeBox key={n.name} p={p} tone={!n.up ? "fault" : n.free === 0 ? "work" : "live"}
                       selected={sel?.kind === "peer" && sel.id === n.name}
                       dim={dimmed(`peer:${n.name}`)}
                       onHover={(on) => setHover(on ? `peer:${n.name}` : null)}
                       onSelect={() => onSelect({ kind: "peer", id: n.name })}
                       title={n.up
                         ? `${n.name} is answering — click to link or unlink its models`
                         : `${n.name} is not answering${n.lastError ? `: ${n.lastError}` : ""}`}>
                <Head tone={!n.up ? "error.main" : "success.main"} name={n.name}
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
            const used = slots - (b.free ?? 0);
            const held = blockers(b, resources);
            const q = queuedFor(b.name);
            const loaded = (b.loaded ?? []).map((m) => displayId(m, d.aliases, d.net.available));
            const tone = held.length ? "work" : used > 0 ? "live" : q > 0 ? "work" : "idle";
            return (
              <NodeBox key={b.name} p={p} tone={tone}
                       selected={sel?.kind === "backend" && sel.id === b.name}
                       dim={dimmed(`backend:${b.name}`)}
                       onHover={(on) => setHover(on ? `backend:${b.name}` : null)}
                       onSelect={() => onSelect({ kind: "backend", id: b.name })}
                       title={held.length
                         ? `blocked — ${held.map((r) => `${r.holder} has ${r.name}`).join(", ")}`
                         : `${b.name}${b.url ? ` · ${b.url}` : ""} — click for its models`}>
                <Head tone={held.length ? "warning.main" : used > 0 ? "success.main" : "faint"} name={b.name}
                      right={<Pips used={Math.max(0, used)} slots={slots} />} />
                <Sub color={held.length ? "warning.main" : loaded.length ? "success.main" : "faint"}>
                  {held.length ? "blocked" : loaded.length ? loaded.join(", ")
                    : b.knowsWarm === false ? "warmth unknown" : "nothing loaded"}
                </Sub>
                {q > 0 && <Sub color="warning.main">{q} waiting</Sub>}
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
            return (
              <NodeBox key={r.name} p={p} tone={r.holder ? "live" : "idle"}
                       selected={sel?.kind === "resource" && sel.id === r.name}
                       dim={dimmed(`resource:${r.name}`)}
                       onHover={(on) => setHover(on ? `resource:${r.name}` : null)}
                       onSelect={() => onSelect({ kind: "resource", id: r.name })}
                       title={r.holder
                         ? `${r.holder} is running on ${r.name}; everything else declared on it waits`
                         : `${r.name} is free — free and still loaded is the normal resting state`}>
                <Head tone={r.holder ? "success.main" : "faint"} name={r.name} />
                <Sub color={r.holder ? "success.main" : "faint"}>
                  {r.holder ? `${r.holder} holding` : "free"}
                  {waiting.length ? ` · ${waiting.length} waiting` : ""}
                </Sub>
                {/* A card is either held or not; there is no partial. The bar is
                    a presence, not a percentage. */}
                <Box sx={{
                  height: 3, borderRadius: 2, mt: 0.25,
                  bgcolor: r.holder ? "success.main" : "divider",
                  opacity: r.holder ? 1 : 0.7,
                  animation: r.holder ? "hearth-breathe 2.4s ease-in-out infinite" : undefined,
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
