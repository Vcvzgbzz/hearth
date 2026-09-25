/**
 * The console's stage geometry, checked without a browser.
 *
 * The graph laid every kind of node out in exactly one row and clamped the
 * cell to a floor. Nine backends therefore wanted 1226px, and on anything
 * narrower the page — whose entire job is to be looked at — grew a horizontal
 * scrollbar and truncated every name to `swap-im…`. Meanwhile the three rows
 * were capped 150px apart and centred, so a tall window drew them in a band
 * across the middle and left a third of the stage empty underneath.
 *
 * Nothing tested it, because testing it appeared to need a DOM. It does not:
 * this half is arithmetic over a width, a height and some counts. What follows
 * is the arithmetic.
 *
 *     npx tsx test/layout.test.ts
 */
import assert from "node:assert/strict";

import {
  CELL, countCrossings, countNodeHits, countOverlaps, GAP, grid, H, layout, MIN_GAP, orderBackends,
  PAD, polyLength, STACK, stitch, tiers,
} from "../src/ui/layout.js";
import type { Backend, Node, Resource } from "../src/ui/types.js";

/** The width a row of `count` cells actually occupies. */
const span = (count: number, w: number) => count * w + (count - 1) * GAP;

// --- nothing overflows sideways, at any size anyone has ---------------------
// The bug, stated as a property. Every window between a phone and a wall
// display, against every backend count this thing has plausibly got.
for (const width of [640, 800, 900, 1024, 1200, 1280, 1440, 1512, 1600, 1920, 2560, 3440]) {
  for (const n of [1, 2, 3, 5, 7, 8, 9, 11, 14, 20]) {
    const inner = width - PAD * 2;
    const { sizes, w } = grid(inner, n, CELL.backend, 4);
    const widest = Math.max(...sizes);
    // Either it fits, or it ran out of rows to wrap into — the one case where
    // the stage is allowed to scroll sideways, because the alternative is
    // clipping a card off the bottom where nobody sees it.
    assert.ok(span(widest, w) <= inner + 0.5 || sizes.length === 4,
      `${n} backends at ${width}px overflow: ${span(widest, w).toFixed(0)} > ${inner}`);
    assert.equal(sizes.reduce((a, b) => a + b, 0), n, "every backend is placed exactly once");
  }
}

// --- a row wraps before its cells stop being readable -----------------------
// Nine across 1240px "fit" at 122px each, and every subtitle in them read
// "nothing load…". Fitting is not the test; being readable is.
{
  const { sizes, w } = grid(1240, 9, CELL.backend, 4);
  assert.equal(sizes.length, 2, "nine backends wrap rather than squeeze");
  assert.deepEqual(sizes, [5, 4], "and they balance — 5 and 4, not 8 and 1");
  assert.ok(w >= CELL.backend.want, `cells reach a comfortable width (${w.toFixed(0)}px)`);
}

// --- but not when there is genuinely room ----------------------------------
{
  const { sizes } = grid(1700, 9, CELL.backend, 4);
  assert.equal(sizes.length, 1, "a wide window keeps one row, which reads best of all");
}

// --- height is a budget, and wrapping spends it -----------------------------
// Wrapping trades height for width. On a short window there is nothing to
// trade with, and a wrapped row would push the cards off the bottom — so the
// hard floor takes over and the cells get narrow instead.
{
  const short = grid(900, 9, CELL.backend, 1);
  assert.equal(short.sizes.length, 1, "no room to wrap means no wrapping");
  assert.ok(short.w >= CELL.backend.min,
    "the cell keeps its floor and the stage scrolls, rather than clipping a card");
  const tall = grid(900, 9, CELL.backend, 4);
  assert.ok(tall.sizes.length > 1, "room to wrap means wrapping");
  assert.ok(tall.w > short.w, "which is the whole trade: height for readable width");
}

// --- the tiers fill the stage rather than sitting in a band -----------------
for (const height of [640, 795, 900, 1100, 1400]) {
  const t = tiers(height, 2, 1);
  assert.ok(t.self >= PAD, "the top tier is on the stage");
  const bottom = t.resources + H.resource;
  assert.ok(bottom <= height - PAD + 0.5,
    `nothing hangs off the bottom at ${height}px (ends ${bottom.toFixed(0)})`);
  // "Fills" means the strip left under the cards is not worth having. The gap
  // ceiling scales with the stage so this holds on a wall display too, where a
  // fixed ceiling drew a small diagram marooned in the middle.
  assert.ok(height - bottom <= height * 0.15,
    `no dead band under the cards at ${height}px (${(height - bottom).toFixed(0)}px spare)`);
  // And what is left is shared top and bottom, never dumped at one end.
  assert.ok(Math.abs((t.self - PAD) - (height - PAD - bottom)) < 2,
    "leftover height is centred, not pushed to one side");
  assert.ok(t.backends > t.self && t.resources > t.backends, "tiers stay in order");
}

// --- a short stage keeps the tiers apart enough to read the edges -----------
{
  const t = tiers(300, 1, 1);
  assert.ok(t.backends - (t.self + H.self) >= MIN_GAP - 0.5,
    "edges keep a minimum length even when the window is too short for them");
  assert.ok(t.needed > 300, "and the stage says it needs more room, rather than overlapping");
}

// --- wrapped rows stack tighter than tiers do ------------------------------
// A wrapped row is one tier that ran out of width. Spacing it like a tier
// would say it is a different kind of thing.
{
  const t = tiers(900, 3, 1);
  const tierGap = t.backends - (t.self + H.self);
  assert.ok(STACK < tierGap, "rows of a kind sit closer than the kinds do");
  assert.equal(t.resources - t.backends, 3 * H.backend + 2 * STACK + tierGap,
    "and the tier below starts past all of them");
}

// --- the host sits between the cards it completes ---------------------------
// A model split across two cards and the host draws a pair line from each card
// to the host. Placed by its backend, the host tied with that backend's own
// card and landed beside it, so the line from the other card ran straight
// through the near one.
{
  const spec: [string, string[]][] = [
    ["swap-image", ["gpu0"]], ["video", ["gpu0"]], ["swap", ["gpu1"]], ["swap-deep", ["gpu1", "gpu0"]],
    ["guard", ["cpu"]], ["judge", ["cpu"]], ["expander", ["cpu"]],
    ["embed", ["cpu"]], ["classifier", ["cpu"]], ["tts", ["cpu"]],
  ];
  const backends: Backend[] = spec.map(([name, resources]) => ({ name, resources }));
  const resources: Resource[] = [
    ...["gpu0", "gpu1", "cpu"].map((name) => ({
      name, kind: name === "cpu" ? ("cpu" as const) : ("gpu" as const), holder: null,
      backends: spec.filter(([, rs]) => rs.includes(name)).map(([n]) => n),
    })),
    { name: "host", kind: "other", shared: true, holder: null, backends: ["swap-deep"],
      host: { cards: ["gpu1", "gpu0"], detail: "deep · 27 layers" } } as Resource,
  ];
  const scene = layout(1200, 740, [], orderBackends(backends, resources), resources);
  const x = (id: string) => scene.nodes.get(`resource:${id}`)!.x;
  const lo = Math.min(x("gpu0"), x("gpu1"));
  const hi = Math.max(x("gpu0"), x("gpu1"));
  assert.ok(x("host") > lo && x("host") < hi, "the host sits between its two cards");
  assert.equal(countNodeHits(scene), 0, "so neither pair line crosses the other card");
}

console.log("layout.test.ts ok");

// --- wires that do not cross each other ------------------------------------
//
// The tiers are a layered graph, so how tangled the picture is comes down to
// one thing: the order of the backends. That used to be the order they appear
// in the config file, which knows nothing about which card each one uses — so a
// config grouped by purpose drew a dozen crossings, and every wire had to be
// traced rather than followed.
//
// Two halves, and both are needed. Ordering puts backends that share a card
// beside each other; filling the wrapped rows DOWN each column keeps them
// beside each other once there is more than one row, instead of wrapping the
// run back to the left edge with its card left behind on the right.
{
  const mk = (spec: [string, string[]][]) => {
    const backends: Backend[] = spec.map(([name, resources]) => ({ name, resources }));
    const names = [...new Set(spec.flatMap(([, rs]) => rs))].sort();
    const resources: Resource[] = names.map((name) => ({
      name,
      kind: name === "cpu" ? ("cpu" as const) : ("gpu" as const),
      holder: null,
      backends: spec.filter(([, rs]) => rs.includes(name)).map(([n]) => n),
    }));
    return { backends, resources };
  };

  // Two cards and a shared cpu with six sidecars on it; `cpu` sorts before the cards.
  const real = mk([
    ["swap", ["gpu1"]], ["swap-image", ["gpu0"]], ["video", ["gpu0"]],
    ["guard", ["cpu"]], ["judge", ["cpu"]], ["expander", ["cpu"]],
    ["embed", ["cpu"]], ["classifier", ["cpu"]], ["tts", ["cpu"]],
  ]);

  // Declared interleaved, which is what grouping a config by purpose looks
  // like, plus one backend spanning two cards.
  const interleaved = mk([
    ["guard", ["cpu"]], ["swap", ["gpu1"]], ["judge", ["cpu"]], ["swap-image", ["gpu0"]],
    ["embed", ["cpu"]], ["video", ["gpu0"]], ["tts", ["cpu"]], ["deep", ["gpu0", "gpu1"]],
    ["classifier", ["cpu"]],
  ]);

  // Eight sidecars on one shared cpu: a group far too big for one row, which is
  // the case that forced the wires straight.
  const manyCpu = mk([
    ["gpu", ["gpu1"]],
    ...Array.from({ length: 8 }, (_, i) => [`side${i}`, ["cpu"]] as [string, string[]]),
  ]);
  // Two cards, no shared hardware, nothing in common between the halves.
  const split = mk([
    ["a", ["g0"]], ["b", ["g0"]], ["c", ["g0"]],
    ["d", ["g1"]], ["e", ["g1"]], ["f", ["g1"]],
  ]);

  // Every window a laptop or a monitor might give the stage, not the three that
  // happened to look right: the tier wraps to one, two and three rows across
  // this range, and the wrap is what used to decide whether wires tangled.
  // With and without peers, because the peer row is drawn with its own arcs and
  // more than one of them sit side by side.
  const peerSets: Node[][] = [
    [],
    [{ name: "p1", up: true, free: 1, slots: 1, queued: 0 }],
    [{ name: "p1", up: true, free: 1, slots: 1, queued: 0 },
     { name: "p2", up: false, free: null, slots: null, queued: null }],
  ];

  let checked = 0;
  for (const [label, { backends, resources }] of
       [["real", real], ["interleaved", interleaved],
        ["manyCpu", manyCpu], ["split", split]] as const) {
    const ordered = orderBackends(backends, resources);
    for (const peers of peerSets) {
      for (let w = 660; w <= 2000; w += 40) {
        for (const h of [600, 800, 1000, 1200]) {
          const scene = layout(w, h, peers, ordered, resources);
          assert.equal(countCrossings(scene), 0,
            `${label} at ${w}x${h} with ${peers.length} peer(s) crosses its own wires`);
          // The measure that "wires from one point cannot cross each other"
          // says nothing about: a fan is provably clean by crossings alone
          // while every one of its wires is drawn through a box in the row
          // above its target. Columns line up exactly whenever the rows hold
          // the same number of backends, which is what makes this bite.
          assert.equal(countNodeHits(scene), 0,
            `${label} at ${w}x${h} with ${peers.length} peer(s) runs a wire through a node`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 1500, `the sweep must actually run (${checked} layouts)`);

  // Ten backends wrap 5/5, the columns line up, and a wire into the lower row
  // used to share its corridor with one leaving the upper row.
  {
    const resources = [
      { name: "gpu0", backends: ["swap-image", "swap-deep", "video"] },
      { name: "gpu1", backends: ["swap", "swap-deep"] },
      { name: "cpu", backends: ["guard", "judge", "expander", "embed", "classifier", "tts"] },
    ] as Resource[];
    const backends = ["swap", "swap-image", "swap-deep", "video", "guard", "judge", "expander",
      "embed", "classifier", "tts"].map((name) => ({
      name, resources: resources.filter((r) => r.backends.includes(name)).map((r) => r.name),
    })) as Backend[];
    const ordered = orderBackends(backends, resources);
    for (let w = 660; w <= 2000; w += 40) {
      for (const h of [600, 800, 1000, 1200]) {
        const scene = layout(w, h, peerSets[1]!, ordered, resources);
        assert.equal(countOverlaps(scene), 0, `live at ${w}x${h} runs two wires down one line`);
      }
    }
  }

  // The shape itself, not just its outcome: right angles with rounded corners,
  // and one shared channel per card so a group of sidecars arrives as one trunk
  // rather than as six lines converging on a point.
  {
    const scene = layout(963, 620, [], orderBackends(real.backends, real.resources), real.resources);
    const wires = scene.edges.filter((e) => e.from.startsWith("backend:")
                                         && e.to.startsWith("resource:"));
    assert.ok(wires.every((e) => e.d.includes(" Q ")),
      "a backend's wire turns corners rather than sweeping");

    const channels = new Map<string, Set<number>>();
    for (const e of wires) {
      if (!channels.has(e.to)) channels.set(e.to, new Set());
      channels.get(e.to)!.add(Math.round(e.mid.y));
    }
    for (const [card, ys] of channels) {
      assert.equal(ys.size, 1, `${card}'s wires must share one channel, got ${ys.size}`);
    }

    // Right to left: the rightmost card runs highest. Reversing this is what
    // makes a card's drop cut through the run of the card beside it.
    const byCard = [...channels].map(([card, ys]) => ({
      x: scene.nodes.get(card)!.x, y: [...ys][0]!,
    })).sort((a, b) => b.x - a.x);
    for (let i = 1; i < byCard.length; i++) {
      assert.ok(byCard[i]!.y > byCard[i - 1]!.y,
        "a card further left must run in a lower channel than one to its right");
    }

    // The band belongs to the wires: no channel may run through a tier.
    const rows = [...scene.nodes.values()].filter((n) => n.kind === "backend");
    const lowestBackend = Math.max(...rows.map((n) => n.y + n.h));
    const highestCard = Math.min(...[...scene.nodes.values()]
      .filter((n) => n.kind === "resource").map((n) => n.y));
    for (const e of wires) {
      assert.ok(e.mid.y > lowestBackend && e.mid.y < highestCard,
        `a channel at ${e.mid.y} must sit between the tiers, not across one`);
    }
  }

  // The ordering is what does it, not the fill alone: the interleaved config
  // still crosses if the backends are left in the order they were declared.
  const asDeclared = layout(1500, 900, [], interleaved.backends, interleaved.resources);
  assert.ok(countCrossings(asDeclared) > 0,
    "the fixture must actually be tangled without ordering, or it proves nothing");

  // A backend spanning two cards belongs BETWEEN them, which is what the
  // average of its cards means and the reason it is an average at all.
  const order = orderBackends(interleaved.backends, interleaved.resources).map((b) => b.name);
  assert.ok(order.indexOf("deep") > order.indexOf("swap-image")
            && order.indexOf("deep") < order.indexOf("swap"),
    `a backend on gpu0+gpu1 sits between them (got ${order.join(" ")})`);

  // Backends with no hardware draw no wire, so they sort out of the way rather
  // than splitting a run of backends that do.
  const withBare = mk([["a", ["gpu0"]], ["b", ["gpu1"]]]);
  withBare.backends.splice(1, 0, { name: "bare" });
  const bareOrder = orderBackends(withBare.backends, withBare.resources).map((b) => b.name);
  assert.equal(bareOrder[bareOrder.length - 1], "bare",
    "a backend that competes for nothing goes last, not through the middle");

  // Stable: the same payload gives the same picture every poll, or a node moves
  // out from under the pointer between refreshes.
  const twice = orderBackends(real.backends, real.resources).map((b) => b.name);
  assert.deepEqual(orderBackends(real.backends, real.resources).map((b) => b.name), twice);
}

// --- one dot, the whole journey --------------------------------------------
//
// A request does not stop when it reaches the backend; that is where it starts
// costing something, and the card under it is busy for as long as it runs. The
// dot rides both legs as one path, so the legs have to join into a single shape
// rather than a set of subpaths — `M` on the second leg would make offsetPath
// jump rather than carry on.
{
  const { backends, resources } = (() => {
    const spec: [string, string[]][] = [["swap", ["gpu1"]], ["side", ["cpu"]]];
    return {
      backends: spec.map(([name, rs]) => ({ name, resources: rs })) as Backend[],
      resources: ["gpu1", "cpu"].map((name) => ({
        name, kind: name === "cpu" ? ("cpu" as const) : ("gpu" as const),
        holder: null, backends: spec.filter(([, rs]) => rs.includes(name)).map(([n]) => n),
      })) as Resource[],
    };
  })();

  const scene = layout(1400, 900, [], orderBackends(backends, resources), resources);
  const first = scene.edges.find((e) => e.id === "self>backend:swap")!;
  const second = scene.edges.find((e) => e.id === "backend:swap>resource:gpu1")!;
  const { d, len } = stitch([first, second]);

  assert.equal((d.match(/M/g) ?? []).length, 1,
    "a stitched run opens once; a second M would break it into subpaths");
  assert.ok(d.startsWith("M"), "and it opens at the beginning");
  assert.ok(len > polyLength(first.poly) && len > polyLength(second.poly),
    "the length covers both legs, which is what paces the dot");
  assert.equal(Math.round(len),
    Math.round(polyLength(first.poly) + polyLength(second.poly)));

  // One leg on its own is untouched — a backend that competes for nothing has
  // no card to carry on to.
  assert.equal(stitch([first]).d, first.d);
}
