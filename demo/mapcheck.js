/**
 * The routing map's two numbers, measured in the page it is drawn on: no box lies on another, and
 * no adapter's edges cross each other (or anything else). Run it on the Routing page, with
 * `npm run demo` up and an adapter on a line:
 *
 *     npm run demo                                    # in one shell
 *     # open http://127.0.0.1:4300/ui#routing
 *     # paste this file's content into the browser console, then: mapcheck()
 *
 * It works on the drawn DOM, not on the layout's arithmetic: what a box measures at the zoom it is
 * drawn at, and the points the edges' own paths go through. Boxes that only touch are not
 * overlapping; two edges that meet at a handle are not crossing.
 */
function mapcheck() {
  const boxes = [...document.querySelectorAll(".react-flow__node")].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.getAttribute("data-id") ?? "?", x: r.left, y: r.top, w: r.width, h: r.height };
  });
  // Every pair whose rectangles share area. Touching (0 or sub-pixel) is not lying on.
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0.5 && oy > 0.5) overlaps.push({ a: a.id, b: b.id, px: [Math.round(ox), Math.round(oy)] });
    }
  }
  // The edges' own paths, as polylines: what is drawn, not what was intended.
  const lines = [...document.querySelectorAll(".react-flow__edge")].map((g) => {
    const path = g.querySelector("path.react-flow__edge-path") ?? g.querySelector("path");
    const total = path?.getTotalLength?.() ?? 0;
    const pts = [];
    const n = Math.max(2, Math.min(120, Math.round(total / 6)));
    for (let k = 0; k <= n; k++) {
      const p = path.getPointAtLength((total * k) / n);
      pts.push({ x: p.x, y: p.y, f: k / n });
    }
    return { id: g.getAttribute("data-id") ?? "?", pts };
  });
  const cross = (a, b, c, d) => {
    const s = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = s(a, b, c), d2 = s(a, b, d), d3 = s(c, d, a), d4 = s(c, d, b);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  /** Do two drawn edges cross somewhere other than at their ends? */
  const crosses = (p, q) => {
    for (let i = 1; i < p.pts.length; i++) {
      const a = p.pts[i - 1], b = p.pts[i];
      if (b.f < 0.04) continue;
      for (let j = 1; j < q.pts.length; j++) {
        const c = q.pts[j - 1], d = q.pts[j];
        if (c.f < 0.04) continue;
        if (cross(a, b, c, d)) return true;
      }
    }
    return false;
  };
  // An adapter's edges: the two that meet its block, found by the ids the map gives them.
  const adapter = lines.filter((l) => /^e:adapt:/.test(l.id));
  const adapterCrossings = [];
  const otherCrossings = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const [p, q] = [lines[i], lines[j]];
      const both = /^e:adapt:/.test(p.id) && /^e:adapt:/.test(q.id);
      // The two edges of one block leave and enter it: they meet at the block, they do not cross it.
      const sameLine = p.id.replace(/:in$|:out$/, "") === q.id.replace(/:in$|:out$/, "");
      if (sameLine || !crosses(p, q)) continue;
      if (both) adapterCrossings.push([p.id, q.id]);
      else if (/^e:adapt:/.test(p.id) || /^e:adapt:/.test(q.id)) otherCrossings.push([p.id, q.id]);
    }
  }
  return {
    nodes: boxes.length,
    edges: lines.length,
    adapterEdges: adapter.length,
    overlaps: overlaps.length,
    overlapsList: overlaps.slice(0, 10),
    adapterCrossings: adapterCrossings.length,
    adapterCrossingsList: adapterCrossings.slice(0, 10),
    adapterAgainstOther: otherCrossings.length,
    adapterAgainstOtherList: otherCrossings.slice(0, 10),
  };
}
