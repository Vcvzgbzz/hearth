/**
 * Where things go on the stage, as arithmetic tested without a browser: nothing overflows
 * sideways, rows fill the height, names stay readable, and wires cross as little as possible.
 */
import type { Backend, Node, Resource } from "./types.js";

export const GAP = 18;
export const PAD = 10;
/** Between two rows of the SAME kind. Tighter than the gap between tiers,
 *  because a wrapped row is one band that ran out of width, not a new tier. */
export const STACK = 14;
export const H = { self: 82, peer: 82, backend: 86, resource: 66 } as const;
/** Below this the columns stop being readable and the stage scrolls instead. */
export const MIN_STAGE = 640;
/** Cell widths per kind: rows wrap at `want`, `min` is the hard floor, `max` caps a wide stage. */
export const CELL = {
  peer: { min: 150, want: 170, max: 210 },
  backend: { min: 118, want: 168, max: 184 },
  resource: { min: 120, want: 160, max: 200 },
} as const;
/** The tightest the tiers go before the edges are too short to read, and the
 *  loosest before the stage is mostly empty space with lines across it. */
export const MIN_GAP = 64;
export const MAX_GAP = 240;

/** Fit `n` cells into `inner`, wrapping to as few balanced rows (9 is 5+4) as keep them readable. */
export function grid(
  inner: number, n: number, cell: { min: number; want: number; max: number }, maxRows = 4,
): { sizes: number[]; w: number } {
  if (n === 0) return { sizes: [], w: cell.min };
  const fits = (k: number): number => {
    const per = Math.ceil(n / k);
    return (inner - (per - 1) * GAP) / per;
  };
  // Wrap until cells are comfortable or `maxRows` is hit; past that the stage would clip a tier.
  let k = 1;
  while (k < n && k < maxRows && fits(k) < cell.want) k++;
  const sizes: number[] = [];
  let left = n;
  for (let i = 0; i < k; i++) {
    const take = Math.ceil(left / (k - i));
    sizes.push(take);
    left -= take;
  }
  const per = Math.max(...sizes);
  // Two rows keep half a cell spare so they can be staggered (see layout).
  const w = k === 2 ? (inner - (per - 0.5) * GAP) / (per + 0.5) : fits(k);
  return { sizes, w: Math.max(cell.min, Math.min(cell.max, w)) };
}

/** Where each tier starts: spare height goes to the gaps between tiers, not between wrapped rows. */
export function tiers(height: number, kB: number, kR: number): {
  self: number; backends: number; resources: number; needed: number;
} {
  const bH = kB * H.backend + Math.max(0, kB - 1) * STACK;
  const rH = kR * H.resource + Math.max(0, kR - 1) * STACK;
  const content = H.self + bH + rH;
  // The gap ceiling scales with the stage, so a big monitor is filled rather than letterboxed.
  const cap = Math.max(MAX_GAP, height * 0.3);
  const gap = Math.max(MIN_GAP, Math.min(cap, (height - PAD * 2 - content) / 2));
  const total = content + gap * 2;
  const top = Math.max(PAD, PAD + (height - PAD * 2 - total) / 2);
  return {
    self: top,
    backends: top + H.self + gap,
    resources: top + H.self + gap + bH + gap,
    needed: total + PAD * 2,
  };
}

/* --------------------------------------------------------- ordering */

/**
 * Order backends by the barycentre of their cards, so shared-card backends sit together and
 * wires cross as little as possible. Backends with no hardware go last, in config order.
 */
export function orderBackends(backends: Backend[], resources: Resource[]): Backend[] {
  const rank = new Map(resources.map((r, i) => [r.name, i]));
  const key = (b: Backend): number => {
    const mine = (b.resources ?? []).map((n) => rank.get(n)).filter((i): i is number => i !== undefined);
    // No hardware, no wire: sorts past everything that has one.
    if (!mine.length) return Number.POSITIVE_INFINITY;
    return mine.reduce((a, x) => a + x, 0) / mine.length;
  };
  // Stable, so backends sharing a card keep the order the operator wrote them
  // in and the picture does not reshuffle between polls.
  return [...backends].sort((a, b) => key(a) - key(b));
}

/* ------------------------------------------------------- placement */


export interface Placed {
  id: string;
  kind: "self" | "peer" | "backend" | "resource";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt { x: number; y: number }

export interface Edge {
  id: string;
  from: string;
  to: string;
  /** The drawn shape, flattened, so it can be measured whatever it is. */
  poly: Pt[];
  /** Sibling links leave sideways; parent links leave downwards. */
  dir: "across" | "down";
  d: string;
  /** Where a count sits, and the only point on the path we need in JS. */
  mid: { x: number; y: number };
}

export interface Scene {
  nodes: Map<string, Placed>;
  edges: Edge[];
  width: number;
  height: number;
}

/** The mark's size for a node of this width, shared by layout and NodeBox so edges end at the mark. */
export const glyphFor = (w: number): number =>
  Math.round(Math.max(26, Math.min(36, w * 0.26)));

/** How far inside its box a node's visible content begins, so edges stop at the mark. */
const inset = (p: Placed): number => Math.max(0, (p.h - glyphFor(p.w)) / 2);

/** B(0.5) of a cubic, which is where a label on it belongs. */
const midOf = (p0: number, p1: number, p2: number, p3: number): number =>
  (p0 + 3 * p1 + 3 * p2 + p3) / 8;

/** A cubic bowed by `lift`, so one pair of nodes can carry an out edge and a back edge. */
function curve(a: Placed, b: Placed, dir: "across" | "down", lift = 0): {
  d: string; mid: { x: number; y: number }; poly: Pt[];
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
      poly: flatten([{ x: x1, y: y1 }, { x: x1 + k, y: c1y }, { x: x2 - k, y: c2y }, { x: x2, y: y2 }]),
    };
  }
  // Only the target is inset: a backend's content fills its box, a card's is centred in it.
  const x1 = a.x + a.w / 2, y1 = a.y + a.h;
  const x2 = b.x + b.w / 2, y2 = b.y + inset(b);
  // The fan from self: every edge leaves one point, so none can cross. Card wires are elbows.
  const k = Math.max(20, (y2 - y1) * 0.55);
  const c1x = x1, c1y = y1 + k;
  const c2x = x2, c2y = y2 - k;
  return {
    d: `M ${x1} ${y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`,
    mid: { x: midOf(x1, c1x, c2x, x2), y: midOf(y1, c1y, c2y, y2) },
    poly: flatten([{ x: x1, y: y1 }, { x: c1x, y: c1y }, { x: c2x, y: c2y }, { x: x2, y: y2 }]),
  };
}

/** A clear corridor beside a column, for a wire whose straight descent would pass through a node. */
const corridorFor = (p: Placed, lane: "in" | "out"): number =>
  Math.max(2, p.x - (lane === "in" ? GAP * 2 / 3 : GAP / 3));

/** Is anything in this column between `p` and the tier it is reaching for? */
function blocked(p: Placed, others: Placed[], above: boolean): boolean {
  const x = p.x + p.w / 2;
  return others.some((n) => n !== p && n.x <= x && x <= n.x + n.w
    && (above ? n.y + n.h <= p.y : n.y >= p.y + p.h));
}

/** A backend's wire to its card as a rounded elbow: down, across its card's channel, down. */
function elbow(a: Placed, b: Placed, channelY: number, opts: {
  /** Leave `a` sideways into this corridor — something is stacked below it. */
  exit?: number;
  /** Descend this corridor and enter `b` sideways — something is above it. */
  enter?: number;
} = {}): { d: string; mid: { x: number; y: number }; poly: Pt[] } {
  const sx = opts.exit ?? a.x + a.w / 2;
  const sy = opts.exit === undefined ? a.y + a.h : a.y + a.h / 2;
  const tx = opts.enter ?? b.x + b.w / 2;
  const ty = opts.enter === undefined ? b.y + inset(b) : b.y + b.h / 2;

  const poly: Pt[] = [];
  const parts: string[] = [];
  // The stub out of a's side, when it cannot leave through its own bottom.
  if (opts.exit !== undefined) {
    poly.push({ x: a.x, y: sy });
    parts.push(`M ${a.x} ${sy}`, `L ${sx} ${sy}`);
  } else {
    parts.push(`M ${sx} ${sy}`);
  }
  poly.push({ x: sx, y: sy });

  // Straight down when there is nothing to go around. An elbow with no sideways
  // run is two corners drawn on top of each other.
  if (Math.abs(tx - sx) < 1) {
    parts.push(`L ${tx} ${ty}`);
    poly.push({ x: tx, y: ty });
  } else {
    const dir = tx > sx ? 1 : -1;
    // A stage short enough to squeeze the band flat would otherwise put the
    // channel above the node it leaves, and the wire would set off upwards.
    const cy = Math.min(Math.max(channelY, sy + 4), ty - 4);
    // Corners stay inside all three legs, so a short one rounds off rather than
    // overshooting into the leg beside it.
    const r = Math.max(2, Math.min(10, Math.abs(tx - sx) / 2, cy - sy, ty - cy));
    parts.push(
      `L ${sx} ${cy - r}`,
      `Q ${sx} ${cy} ${sx + dir * r} ${cy}`,
      `L ${tx - dir * r} ${cy}`,
      `Q ${tx} ${cy} ${tx} ${cy + r}`,
      `L ${tx} ${ty}`,
    );
    poly.push({ x: sx, y: cy - r }, { x: sx + dir * r, y: cy },
              { x: tx - dir * r, y: cy }, { x: tx, y: cy + r }, { x: tx, y: ty });
  }

  // The stub into b's side.
  if (opts.enter !== undefined) {
    parts.push(`L ${b.x} ${ty}`);
    poly.push({ x: b.x, y: ty });
  }

  return {
    d: parts.join(" "),
    // On the horizontal run, which is the leg with room for a number on it.
    mid: { x: (sx + tx) / 2, y: Math.min(Math.max(channelY, sy + 4), ty - 4) },
    poly,
  };
}

/** Place everything for a stage size. Deterministic, so nodes stay clickable between polls. */
export function layout(width: number, height: number, peers: Node[],
                backends: Backend[], resources: Resource[]): Scene {
  const nodes = new Map<string, Placed>();
  const inner = width - PAD * 2;

  // How many rows of backends the height can take before the tiers themselves
  // have nowhere to go. Wrapping trades height for width, and this is the
  // budget: past it, a wrapped row would push the cards off the stage.
  const budget = height - PAD * 2 - H.self - H.resource - MIN_GAP * 2 + STACK;
  const maxRows = Math.max(1, Math.min(4, Math.floor(budget / (H.backend + STACK))));
  const bPlan = grid(inner, backends.length, CELL.backend, maxRows);
  const rPlan = grid(inner, resources.length, CELL.resource, 2);
  const Y = tiers(height, Math.max(1, bPlan.sizes.length), Math.max(1, rPlan.sizes.length));

  // Tier 0. Self anchors the left; peers fill from the right so the gap between
  // them is the visual span of the link, and one peer sits opposite us.
  const selfW = Math.min(240, Math.max(190, inner * 0.24));
  nodes.set("self", { id: "self", kind: "self", x: PAD, y: Y.self, w: selfW, h: H.self });
  if (peers.length) {
    // What is left after self has taken its side. Without this a fourth peer
    // pushed the row off the left edge and drew ON TOP of us, which reads as a
    // peer that IS us — the one thing this row exists to distinguish.
    const room = inner - selfW - GAP;
    const pw = Math.max(
      100,
      Math.min(CELL.peer.max, Math.max(CELL.peer.min, (room - (peers.length - 1) * GAP) / peers.length)),
    );
    const span = Math.min(room, peers.length * pw + (peers.length - 1) * GAP);
    const step = peers.length > 1 ? (span - pw) / (peers.length - 1) : 0;
    const start = PAD + inner - span;
    peers.forEach((p, i) => nodes.set(`peer:${p.name}`, {
      id: `peer:${p.name}`, kind: "peer", x: start + i * step, y: Y.self, w: pw, h: H.peer,
    }));
  }

  // Tier 1: backends, filled down each column so orderBackends' neighbours stay neighbours.
  {
    const cols = Math.max(...bPlan.sizes);
    // A column is as deep as the number of rows long enough to reach it, so a
    // short last row leaves the right-hand columns one shallower rather than
    // leaving a hole in the middle of the grid.
    const depth = (c: number): number => bPlan.sizes.filter((n) => n > c).length;
    // Two rows holding the same count line up column for column, so a quarter
    // pitch each way puts the lower row in the gaps of the upper one. Three or
    // more cannot all be staggered; those wires take the corridors instead.
    const pitch = bPlan.w + GAP;
    const aligned = bPlan.sizes.length === 2 && bPlan.sizes[0] === bPlan.sizes[1];
    const starts = bPlan.sizes.map((count, row) => {
      const span = count * bPlan.w + (count - 1) * GAP;
      const centred = PAD + (inner - span) / 2 + (aligned ? (row ? 1 : -1) * pitch / 4 : 0);
      return Math.max(PAD, Math.min(centred, PAD + inner - span));
    });
    let i = 0;
    for (let c = 0; c < cols; c++) {
      for (let row = 0; row < depth(c); row++, i++) {
        const b = backends[i];
        if (!b) break;
        nodes.set(`backend:${b.name}`, {
          id: `backend:${b.name}`, kind: "backend",
          x: starts[row]! + c * pitch,
          y: Y.backends + row * (H.backend + STACK),
          w: bPlan.w, h: H.backend,
        });
      }
    }
  }

  // Tier 2: each card under its backends, then pushed apart within its row.
  {
    const rw = rPlan.w;
    const want = new Map<string, number>();
    for (const r of resources.filter((r) => !r.host)) {
      const members = r.backends
        .map((b) => nodes.get(`backend:${b}`))
        .filter((p): p is Placed => !!p);
      want.set(r.name, members.length
        ? members.reduce((s, p) => s + p.x + p.w / 2, 0) / members.length
        : PAD + inner / 2);
    }
  // The host sits between the cards it completes, so its pair lines clear the other cards.
    for (const r of resources.filter((r) => r.host)) {
      const cards = r.host!.cards.map((c) => want.get(c)).filter((x): x is number => x !== undefined);
      want.set(r.name, cards.length ? cards.reduce((s, x) => s + x, 0) / cards.length : PAD + inner / 2);
    }
    const wanted = resources
      .map((r) => ({ r, x: (want.get(r.name) ?? PAD + inner / 2) - rw / 2 }))
      .sort((a, b) => a.x - b.x);

    let i = 0;
    rPlan.sizes.forEach((count, row) => {
      // Pack in order at the position each card wants...
      const placed: { r: Resource; x: number }[] = [];
      let cursor = PAD;
      for (let c = 0; c < count; c++, i++) {
        const w = wanted[i];
        if (!w) break;
        const x = Math.max(cursor, Math.min(w.x, PAD + inner - rw));
        placed.push({ r: w.r, x });
        cursor = x + rw + GAP;
      }
      // ...then stretch the row to full width, keeping order and proportions.
      if (placed.length > 1) {
        const first = placed[0]!.x;
        const last = placed[placed.length - 1]!.x;
        const used = last - first;
        const room = inner - rw;
        if (used > 0 && used < room) {
          const scale = room / used;
          const packed = placed.map((p) => p.x);
          for (const p of placed) p.x = PAD + (p.x - first) * scale;
          // The stretch must not slide a card past another card's backends, or their wires cross.
          if (!separated(placed, rw, nodes)) placed.forEach((p, k) => (p.x = packed[k]!));
        }
      } else if (placed.length === 1) {
        placed[0]!.x = PAD + (inner - rw) / 2;
      }
      for (const p of placed) {
        nodes.set(`resource:${p.r.name}`, {
          id: `resource:${p.r.name}`, kind: "resource",
          x: p.x, y: Y.resources + row * (H.resource + STACK), w: rw, h: H.resource,
        });
      }
    });
  }

  const edges: Edge[] = [];
  const push = (from: string, to: string, dir: "across" | "down", lift = 0) => {
    const a = nodes.get(from), b = nodes.get(to);
    if (!a || !b) return;
    const { d, mid, poly } = curve(a, b, dir, lift);
    edges.push({ id: `${from}>${to}`, from, to, dir, d, mid, poly });
  };
  // Two arcs per peer, bowed opposite ways (sent and received); the bow widens past one peer.
  const lift = peers.length > 1 ? H.peer / 2 + 18 : 14;
  for (const p of peers) {
    push("self", `peer:${p.name}`, "across", -lift);
    push(`peer:${p.name}`, "self", "across", lift);
  }
  // Self -> backends as elbows through the gaps of the staggered rows, clear of every node.
  {
    const from = nodes.get("self");
    if (from) {
      const channelY = Y.self + H.self + (Y.backends - (Y.self + H.self)) * 0.45;
      const all = backends
        .map((x) => nodes.get(`backend:${x.name}`))
        .filter((p): p is Placed => !!p);
      for (const b of backends) {
        const to = nodes.get(`backend:${b.name}`);
        if (!to) continue;
        // Straight onto its top where the column above it is clear, down the
        // gap beside it and in through the side where it is not.
        const enter = blocked(to, all, true) ? corridorFor(to, "in") : undefined;
        const { d, mid, poly } = elbow(from, to, channelY, { enter });
        edges.push({
          id: `self>backend:${b.name}`,
          from: "self", to: `backend:${b.name}`, dir: "down", d, mid, poly,
        });
      }
    }
  }
  // Backend -> card elbows, one channel per card, rightmost card highest so no legs cross.
  // The host is drawn from its card, not its backend.
  {
    const cards = resources
      .filter((r) => !r.host)
      .map((r) => ({ r, p: nodes.get(`resource:${r.name}`) }))
      .filter((x): x is { r: Resource; p: Placed } => !!x.p)
      .sort((m, n) => (n.p.x + n.p.w / 2) - (m.p.x + m.p.w / 2));

    // The band between the two tiers, kept off both of them so a channel never
    // runs through a node or along its edge.
    const allBackends = backends
      .map((x) => nodes.get(`backend:${x.name}`))
      .filter((q): q is Placed => !!q);
    const bRows = Math.max(1, bPlan.sizes.length);
    const top = Y.backends + (bRows - 1) * (H.backend + STACK) + H.backend;
    const bottom = Y.resources;
    const band = Math.max(0, bottom - top);
    cards.forEach(({ r, p }, i) => {
      // Evenly through the middle of the band, so the outermost channels still
      // have room to turn into and out of.
      const at = (i + 1) / (cards.length + 1);
      const channelY = top + band * (0.25 + 0.5 * at);
      for (const b of r.backends) {
        const a = nodes.get(`backend:${b}`);
        if (!a) continue;
        // Out through the side where its own column continues below it, so the
        // descent goes down the gap rather than through its neighbours.
        const exit = blocked(a, allBackends, false) ? corridorFor(a, "out") : undefined;
        const { d, mid, poly } = elbow(a, p, channelY, { exit });
        edges.push({
          id: `backend:${b}>resource:${r.name}`,
          from: `backend:${b}`, to: `resource:${r.name}`, dir: "down", d, mid, poly,
        });
      }
    });
  }
  const host = resources.find((r) => r.host);
  if (host) {
    for (const card of host.host!.cards) {
      push(`resource:${card}`, `resource:${host.name}`, "across");
    }
  }

  // Fill the stage when the content is shorter than it, so there is no strip of
  // dead page under the cards; grow past it only when even the tight layout
  // does not fit, which is the one case worth a scrollbar.
  return { nodes, edges, width, height: Math.max(height, Y.needed) };
}

/** Does each card in a row sit between its neighbours' backends? Backends on several cards are exempt. */
function separated(row: { r: Resource; x: number }[], rw: number, nodes: Map<string, Placed>): boolean {
  const own = (r: Resource): number[] => r.backends
    .filter((b) => row.filter((o) => o.r.backends.includes(b)).length === 1)
    .map((b) => nodes.get(`backend:${b}`))
    .filter((n): n is Placed => !!n)
    .map((n) => n.x + n.w / 2);
  for (let k = 0; k + 1 < row.length; k++) {
    const left = row[k]!, right = row[k + 1]!;
    if (own(left.r).some((x) => x > right.x + rw / 2 + 1)) return false;
    if (own(right.r).some((x) => x < left.x + rw / 2 - 1)) return false;
  }
  return true;
}

/* -------------------------------------------------------- crossings */

/** A cubic, flattened to a polyline. Enough segments that a bow is not a chord. */
export function flatten(pts: Pt[], steps = 32): Pt[] {
  const [p0, p1, p2, p3] = pts as [Pt, Pt, Pt, Pt];
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, dd = t * t * t;
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x + dd * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + dd * p3.y,
    });
  }
  return out;
}

interface Seg { x1: number; y1: number; x2: number; y2: number }

const side = (s: Seg, x: number, y: number): number =>
  Math.sign((s.x2 - s.x1) * (y - s.y1) - (s.y2 - s.y1) * (x - s.x1));

function segmentsCross(p: Seg, q: Seg): boolean {
  const a = side(p, q.x1, q.y1), b = side(p, q.x2, q.y2);
  const c = side(q, p.x1, p.y1), d = side(q, p.x2, p.y2);
  return a !== b && c !== d && a !== 0 && b !== 0 && c !== 0 && d !== 0;
}

/** Pairs of backend->card wires that cross on the drawn curve, ignoring joins within `MERGE` of a shared card. */
const MERGE = 40;

export function countCrossings(scene: Scene): number {
  const wires = scene.edges
    .filter((e) => e.from.startsWith("backend:") && e.to.startsWith("resource:"))
    .map((e) => ({ to: e.to, line: e.poly }));

  let n = 0;
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const a = wires[i]!, b = wires[j]!;
      const shared = a.to === b.to ? a.line[a.line.length - 1]! : null;
      if (crosses(a.line, b.line, shared)) n++;
    }
  }
  return n;
}

function crosses(a: Pt[], b: Pt[], shared: Pt | null): boolean {
  for (let i = 0; i + 1 < a.length; i++) {
    const p: Seg = { x1: a[i]!.x, y1: a[i]!.y, x2: a[i + 1]!.x, y2: a[i + 1]!.y };
    for (let j = 0; j + 1 < b.length; j++) {
      const q: Seg = { x1: b[j]!.x, y1: b[j]!.y, x2: b[j + 1]!.x, y2: b[j + 1]!.y };
      if (!segmentsCross(p, q)) continue;
      // Near the card they share, this is the join and not a tangle.
      if (shared && Math.hypot(p.x1 - shared.x, p.y1 - shared.y) < MERGE) continue;
      return true;
    }
  }
  return false;
}

/** How many times a wire runs through a node it does not join. */
export function countNodeHits(scene: Scene): number {
  let n = 0;
  for (const e of scene.edges) {
    for (const [id, p] of scene.nodes) {
      if (id === e.from || id === e.to) continue;
      if (polyHitsBox(e.poly, p)) n++;
    }
  }
  return n;
}

/** Pairs of unrelated wires sharing one line, which read as a single wire. */
export function countOverlaps(scene: Scene): number {
  const runs = scene.edges.flatMap((e) => e.poly.slice(1).flatMap((b, i) => {
    const a = e.poly[i]!;
    return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 2
      ? [{ e, x: a.x, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) }] : [];
  }));
  let n = 0;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const p = runs[i]!, q = runs[j]!;
      // A shared end is a trunk, not an overlap.
      if (p.e.from === q.e.from || p.e.to === q.e.to) continue;
      if (Math.abs(p.x - q.x) < 3 && Math.min(p.y2, q.y2) - Math.max(p.y1, q.y1) > 4) n++;
    }
  }
  return n;
}

function polyHitsBox(poly: Pt[], p: Placed): boolean {
  // The visible mark, not the click target: the box is deliberately taller than
  // what it draws, so a wire clipping the empty band above a node's glyph is
  // not something anybody can see.
  const pad = inset(p);
  const l = p.x, r = p.x + p.w, t = p.y + pad, b = p.y + p.h - pad;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!, c = poly[i + 1]!;
    if (a.x >= l && a.x <= r && a.y >= t && a.y <= b) return true;
    const seg: Seg = { x1: a.x, y1: a.y, x2: c.x, y2: c.y };
    const edges: Seg[] = [
      { x1: l, y1: t, x2: r, y2: t }, { x1: r, y1: t, x2: r, y2: b },
      { x1: r, y1: b, x2: l, y2: b }, { x1: l, y1: b, x2: l, y2: t },
    ];
    for (const q of edges) if (segmentsCross(seg, q)) return true;
  }
  return false;
}

/** How long the drawn shape is, for pacing anything that travels along it. */
export function polyLength(poly: Pt[]): number {
  let n = 0;
  for (let i = 0; i + 1 < poly.length; i++) {
    n += Math.hypot(poly[i + 1]!.x - poly[i]!.x, poly[i + 1]!.y - poly[i]!.y);
  }
  return n;
}

/** Several legs of a journey as one path, so a single dot rides from peer through backend to card. */
export function stitch(edges: Edge[]): { d: string; len: number } {
  return {
    // Only the first leg may open the path. `L` on the rest keeps it one shape
    // rather than a set of disconnected subpaths, which is what `M` would make
    // and what offsetPath would then jump between.
    d: edges.map((e, i) => (i === 0 ? e.d : e.d.replace(/^M/, "L"))).join(" "),
    len: edges.reduce((a, e) => a + polyLength(e.poly), 0),
  };
}
