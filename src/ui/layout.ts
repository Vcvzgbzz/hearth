/**
 * Where things go on the stage, as arithmetic.
 *
 * Split out of graph.tsx because it is the one part of the console that can be
 * checked without a browser: given a width, a height and some counts, it says
 * where every node lands. Everything else there needs a DOM to mean anything;
 * this needs a calculator, so it gets tested like arithmetic (test/layout.test.ts).
 *
 * The rules it exists to keep:
 *   nothing overflows sideways   a scrollbar on a page whose job is to be
 *                                looked at is a failure, not a fallback
 *   nothing is left empty        rows spread into the height they are given
 *   names stay readable          a row wraps before its cells get too narrow
 *                                to hold the words in them
 *   wires cross as little as     the picture is only worth having if a line
 *   they can                     can be followed from a backend to its card
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
/** How narrow and how wide a cell of each kind is allowed to get. The floor is
 *  what a name needs; the ceiling stops four backends becoming four billboards. */
/** `want` is where the cell reads comfortably and `min` is the hard floor. A
 *  row wraps at `want`, not at `min`: nine backends technically FIT across
 *  1240px at 122px each, and every subtitle in them says "nothing load…". */
export const CELL = {
  peer: { min: 150, want: 170, max: 210 },
  backend: { min: 118, want: 168, max: 184 },
  resource: { min: 120, want: 160, max: 200 },
} as const;
/** The tightest the tiers go before the edges are too short to read, and the
 *  loosest before the stage is mostly empty space with lines across it. */
export const MIN_GAP = 64;
export const MAX_GAP = 240;

/**
 * Fit `n` cells into `inner`, wrapping to as few rows as will hold them.
 *
 * The old layout gave every kind exactly one row and clamped the cell to a
 * floor, so nine backends wanted 1226px and anything narrower scrolled
 * sideways — on a page whose whole job is to be looked at, not read through a
 * scrollbar. Wrapping trades height for width, and height is what this stage
 * has spare: the same nine backends over two rows get 184px each instead of
 * 118, which is the difference between `swap-image` and `swap-im…`.
 *
 * Rows are balanced rather than filled greedily. 9 over two rows is 5 and 4,
 * not 8 and 1 — a short last row reads as "and one more", which is a claim
 * about the thing rather than about the window it is in.
 */
export function grid(
  inner: number, n: number, cell: { min: number; want: number; max: number }, maxRows = 4,
): { sizes: number[]; w: number } {
  if (n === 0) return { sizes: [], w: cell.min };
  const fits = (k: number): number => {
    const per = Math.ceil(n / k);
    return (inner - (per - 1) * GAP) / per;
  };
  // Wrap until the cells are comfortable or the height runs out, whichever
  // comes first. `maxRows` is a hard stop and not a preference: past it a
  // wrapped row would push the tier below off the bottom of the stage, and the
  // stage clips rather than scrolls vertically — so overflowing the height
  // loses a card silently, while overflowing the width leaves a scrollbar you
  // can at least see and use. Sideways is the failure to prefer.
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

/**
 * Where each tier starts, once we know how many rows each one needs.
 *
 * The spare height goes into the two gaps that mean something — request
 * reaching a backend, backend standing on a card — and not into the gaps
 * between wrapped rows, which are one tier that happened to fold. The old
 * version capped the gap at 150 and centred what was left, so a tall window
 * drew three rows in the middle and left a third of the stage empty below the
 * cards.
 */
export function tiers(height: number, kB: number, kR: number): {
  self: number; backends: number; resources: number; needed: number;
} {
  const bH = kB * H.backend + Math.max(0, kB - 1) * STACK;
  const rH = kR * H.resource + Math.max(0, kR - 1) * STACK;
  const content = H.self + bH + rH;
  // The ceiling scales with the stage: a fixed one drew a small diagram in the
  // middle of a big monitor with a dead band above and below it, which is the
  // complaint this whole file exists to answer. It is still a ceiling, because
  // past some distance an edge stops reading as a connection and starts
  // reading as a line that happens to be there.
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
 * Order the backends so their wires to the cards below cross as little as
 * possible.
 *
 * The tiers are a layered graph and the cards are placed under whichever
 * backends use them, so the ONE thing that decides how tangled the picture is
 * is the order of the backends — and that was the order they appear in the
 * config file, which knows nothing about the hardware.
 *
 * The rule is the barycentre heuristic, and it is the whole of it: a backend
 * sits where its cards sit, on average. Two backends on one card end up beside
 * each other, a backend spanning two cards ends up between them, and cards then
 * land under their own users rather than being dragged across the stage by a
 * neighbour that happened to be declared first.
 *
 * Cards are indexed in the order they arrive, which is the server's own sort.
 * Any stable order works — what matters is that the backends and the cards are
 * ranked on the SAME one, or sorting one against the other just moves the
 * tangle somewhere else.
 *
 * Backends that declare no hardware draw no downward wire at all, so they can
 * go anywhere; they keep their configured order at the end, where they are out
 * of the way of the wires that do exist.
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

/**
 * The mark's size for a node of this width. Shared, not duplicated.
 *
 * The layout needs it because edges must stop where the node LOOKS like it
 * starts, and NodeBox needs it to draw the thing. Two copies of this drifting
 * apart is edges that end near a node instead of at it.
 */
export const glyphFor = (w: number): number =>
  Math.round(Math.max(26, Math.min(36, w * 0.26)));

/**
 * How far inside its own box a node's visible content begins.
 *
 * The box is the click target and it is taller than what it draws: the mark and
 * the text are centred in it, and since the border and fill are gone at rest
 * there is nothing at the boundary to see. An edge drawn to the boundary
 * therefore stops in empty space a good fifteen pixels short of the node, which
 * is exactly what it looks like — six lines converging on nothing above the CPU.
 */
const inset = (p: Placed): number => Math.max(0, (p.h - glyphFor(p.w)) / 2);

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
  // Inset the TARGET only, and this asymmetry is the point. A backend's content
  // fills its box top to bottom — name, state, sparkline — so a line leaving the
  // bottom edge leaves the node. A card's content is a mark and two short lines
  // centred in a taller box, so a line arriving at the top edge stops in empty
  // space above it. Insetting both ends made edges sprout from the middle of the
  // backends instead.
  const x1 = a.x + a.w / 2, y1 = a.y + a.h;
  const x2 = b.x + b.w / 2, y2 = b.y + inset(b);
  // The fan from self down to the backends. Every one of these leaves the SAME
  // point, so no two can cross whatever shape they are — they keep the sweep.
  // Wires down to a CARD converge instead of fanning, and those are routed as
  // elbows by `wireTo` rather than drawn here.
  const k = Math.max(20, (y2 - y1) * 0.55);
  const c1x = x1, c1y = y1 + k;
  const c2x = x2, c2y = y2 - k;
  return {
    d: `M ${x1} ${y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`,
    mid: { x: midOf(x1, c1x, c2x, x2), y: midOf(y1, c1y, c2y, y2) },
    poly: flatten([{ x: x1, y: y1 }, { x: c1x, y: c1y }, { x: c2x, y: c2y }, { x: x2, y: y2 }]),
  };
}

/**
 * A backend's wire down to the card it uses, routed as an elbow.
 *
 * Down out of the backend, across a channel, down into the card — right angles
 * with the corners rounded off, which is how wiring between two rows of things
 * is normally drawn and the only shape here that reads as deliberate rather
 * than as a line that happens to join two points.
 *
 * Every wire to one card shares that card's channel, so a group of sidecars on
 * a shared CPU merges into one trunk and arrives together. That is the relation
 * worth seeing, and it means the six of them occupy one line rather than six.
 *
 * Channels are ordered so nothing has to cross anything: a card further to the
 * right gets a SHALLOWER channel, so its long horizontal run sits above the
 * drops of every card to its left, and those drops turn down before they ever
 * reach it. Verified with countCrossings rather than reasoned about and hoped
 * for — see test/layout.test.ts.
 */
/**
 * A clear vertical corridor beside a column, for a wire that cannot go straight.
 *
 * Descending at a node's own centre is the shape you want, and it only works
 * while nothing else in that column is in the way. Rows are usually staggered —
 * a wrapped row is centred on its own count, so its cells sit in the gaps of the
 * row above — but when every row holds the SAME number the columns line up
 * exactly, and a wire to the second row would be drawn straight through the box
 * in the first.
 *
 * So when the straight descent is blocked, the wire drops through the gap beside
 * the column instead and turns into the node's side. The gap is empty by
 * construction, which is what makes this safe rather than lucky.
 */
const corridorFor = (p: Placed, lane: "in" | "out"): number =>
  Math.max(2, p.x - (lane === "in" ? GAP * 2 / 3 : GAP / 3));

/** Is anything in this column between `p` and the tier it is reaching for? */
function blocked(p: Placed, others: Placed[], above: boolean): boolean {
  const x = p.x + p.w / 2;
  return others.some((n) => n !== p && n.x <= x && x <= n.x + n.w
    && (above ? n.y + n.h <= p.y : n.y >= p.y + p.h));
}

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

/**
 * Place everything for a given stage width.
 *
 * Deterministic: same payload and same width give the same picture every poll.
 * That is not an aesthetic preference — a node that moves between polls cannot
 * be clicked, and a particle mid-flight would jump.
 */
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

  // Tier 1. Backends, over as many rows as it takes to keep a name readable.
  //
  // Filled DOWN each column before moving right, which matters as soon as there
  // is more than one row. `orderBackends` has already put backends that share a
  // card next to each other in the list; filling across would then wrap that
  // run back to the left edge on the next row, and its wires would have to
  // cross the whole stage to reach a card sitting under where the run started.
  // Filling down keeps neighbours in the list neighbours on the stage, which is
  // the only thing the ordering was for.
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

  // Tier 2. A card sits under the backends that declare it, then siblings are
  // pushed apart — two cards drawn on top of each other is worse than two cards
  // slightly away from the backends they belong to, because the edges still say
  // which is which. Cards wrap on the same rule as backends; the packing then
  // runs per row, so a card is only pushed off its own backends by a card it
  // actually shares the row with.
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
    // The host goes by its CARDS, not its backend: it is drawn paired with each
    // card it completes, and a pair line only stays clear of the other cards if
    // the host sits between the ones it pairs with. By its backend it ties with
    // that backend's own card and lands beside it — and the line from the far
    // card then runs straight through the near one.
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
      // ...then stretch the row to the full width, keeping the order and the
      // spacing's proportions. Cards follow the backends above them, and those
      // cluster: six sidecars sharing one CPU drag it to their average, which
      // put every card in the left third and left half the stage empty. The
      // edges are what say which card belongs to which backend — position only
      // has to agree with them about the ORDER.
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
  // Two arcs per peer, bowed opposite ways: what we send them, and what they
  // send us. They are separate facts and one line cannot hold both.
  //
  // The bow grows with the number of peers, because with more than one they sit
  // in a row and an arc to the far one would otherwise be drawn straight
  // through the near one. Past a single peer it has to clear a whole node, so
  // the pair opens up enough to pass above and below the row rather than
  // through it.
  const lift = peers.length > 1 ? H.peer / 2 + 18 : 14;
  for (const p of peers) {
    push("self", `peer:${p.name}`, "across", -lift);
    push(`peer:${p.name}`, "self", "across", lift);
  }
  // Self -> backends, on one channel, for the same reason the tier below uses
  // them: a fan of curves cannot cross ITSELF, which is what made it look safe,
  // but every wire to the lower row was drawn straight through a node in the
  // upper one on its way down. An elbow drops between them instead.
  //
  // It works because the rows are staggered: a wrapped row is centred on its
  // own count, so its cells sit in the GAPS of the row above and a wire coming
  // down to one has somewhere to pass. That offset is load-bearing, not
  // cosmetic — countNodeHits is what says so.
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
  // Backend -> card, as elbows sharing one channel per card.
  //
  // The host is skipped here and drawn from the CARD instead. A backend "using"
  // the host is a fact about a process; a model split across a card and the
  // host is a fact about the hardware, and it is the second one that explains
  // the speed — the two halves exchange on every token. The chain still reads
  // end to end: backend, its card, and the other half.
  //
  // Channels are allotted right to left: the rightmost card's run sits highest,
  // just under the backends, and each card further left runs lower. A card's
  // own drop then turns down BEFORE it reaches any channel belonging to a card
  // to its right, and the drops of the cards to its left are further left than
  // its run ever goes — so no leg meets another. Reversing this order tangles
  // it, which is what the test pins.
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

/**
 * How many pairs of backend->card wires cross where somebody can see it.
 *
 * Measured on the CURVE, not on the straight line between the endpoints, and
 * that distinction is the whole point of this function. A wire leaves its
 * backend going straight down and only then sweeps sideways, so two wires whose
 * chords never meet can still cross on the page — which is exactly what
 * happens to two backends stacked in one column that both feed a card away to
 * one side.
 *
 * Edges that share a card are counted too. They converge on one point, so they
 * necessarily meet THERE; what is being looked for is a pair that has already
 * swapped sides before it arrives, which reads as a tangle rather than as a
 * join. Meetings within `MERGE` of the shared end are ignored for that reason.
 */
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

/**
 * How many times a wire runs across a node it is not attached to.
 *
 * The other half of "does this look tangled", and the half that is easy to
 * miss: wires leaving one point cannot cross EACH OTHER whatever shape they
 * are, so a fan looks provably clean by that measure while every one of its
 * wires is drawn straight through the boxes in the row above its target.
 * Counting crossings alone says nothing about it.
 *
 * A wire is allowed to touch the two nodes it joins. Everything else it passes
 * through is a hit.
 */
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

/**
 * How many pairs of unrelated wires run down the same line. Crossings and node
 * hits both miss this: two wires sharing a corridor read as one wire.
 */
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

/**
 * Several legs of a journey as ONE path, so a single dot can ride the lot.
 *
 * A request does not stop when it reaches the backend — that is where it starts
 * costing something, and the card underneath is busy for as long as it runs. So
 * the legs are joined rather than animated separately: two dots on two edges
 * read as two requests, and one dot that carries on reads as what happened.
 *
 * The legs do not meet. A wire into a backend stops at the top of its mark and
 * the wire out leaves from the bottom or the side, so the join is a straight
 * run through the node — which is the right picture, the dot passing behind the
 * thing that is handling it.
 */
export function stitch(edges: Edge[]): { d: string; len: number } {
  return {
    // Only the first leg may open the path. `L` on the rest keeps it one shape
    // rather than a set of disconnected subpaths, which is what `M` would make
    // and what offsetPath would then jump between.
    d: edges.map((e, i) => (i === 0 ? e.d : e.d.replace(/^M/, "L"))).join(" "),
    len: edges.reduce((a, e) => a + polyLength(e.poly), 0),
  };
}
