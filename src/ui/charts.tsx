/**
 * The two charts, and the table that says the same thing for a screen reader.
 *
 * Hand-drawn SVG rather than a charting library, which is a deliberate hold:
 * both of these are one series each with tuned proportions, and @mui/x-charts
 * would cost a dependency and a fight over the same tick labels. If a third
 * chart with a different shape ever turns up, revisit.
 *
 * Two bugs the old imperative version had are structurally gone here rather
 * than fixed: the chart height and the viewBox came from separate literals and
 * drifted (viewBox 130 against H 150, silently squashed), and the lanes tooltip
 * closed over the enclosing loop cursor so `hist[i]` was undefined by the time
 * anyone hovered. Both now come from one expression each.
 */
import Box from "@mui/material/Box";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";
import { useRef, useState } from "react";

import { clock, displayId, since } from "./lib.js";
import { MONO } from "./theme.js";
import type { Sample, Call } from "./types.js";

const axis = { fontSize: 10, fontFamily: MONO } as const;
const fill = { display: "block", width: "100%", height: "auto", overflow: "visible" } as const;
// Shared grid layout for Depth and Lanes so their x-axes align.
const LABEL_COL = "minmax(150px, 22%)";
const TRACK_COL = "1fr";
const COL_GAP = 1; // MUI spacing units (8px)

function Empty({ msg }: { msg: string }) {
  const t = useTheme();
  return (
    <svg viewBox="0 0 900 60" style={fill}>
      <text x={12} y={34} style={axis} fill={t.palette.faint}>{msg}</text>
    </svg>
  );
}

/**
 * Queue depth over the window.
 *
 * One series, so no legend: the heading names it. Area plus an emphasised
 * endpoint, recessive grid, crosshair on hover.
 *
 * `hist.length < 2` is not a formality. History.start() takes a sample
 * immediately "so the graph has a point immediately, not in 5s" -- with one
 * sample every x() divides by zero, the browser silently drops a path full of
 * NaN, and you get a blank chart under a header claiming "1 samples".
 */
export function Depth({ hist, aliases, available }: { hist: Sample[]; aliases?: Record<string, string>; available?: string[] }) {
  const t = useTheme();
  const [at, setAt] = useState<number | null>(null);
  if (!hist || hist.length < 2) return <Empty msg="warming up" />;

  const W = 900, H = 120, TOP = 10, B = 24;
  // L=0, R=0 so the plot fills the track column edge to edge, aligned with Lanes.
  const L = 0, R = 0;
  const peak = Math.max(1, ...hist.map((d) => d.queued));
  const flatZero = peak === 0 || !hist.some((d) => d.queued > 0);
  const x = (i: number) => L + (i / (hist.length - 1)) * (W - L - R);
  const y = (v: number) => TOP + (1 - v / peak) * (H - TOP - B);

  const pts = hist.map((d, i) => [x(i), y(d.queued)] as const);
  const line = pts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)} ${b.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  const hovered = at === null ? null : hist[at];

  // Fold a variant id to its parent if the parent is available (same as Lanes).
  // One rule for every id on the page (variant -> parent, wire id -> advertised),
  // so the hover readout, the lanes and the tables never disagree about a name.
  const fold = (id: string): string => displayId(id, aliases, available);

  // Y-axis: 0 and the peak only; anything more is noise at this size.
  // (Gridlines at each integer were added in the redesign to give the line
  // context; they are recessive, not labels.) The labels live in the left
  // grid column as HTML, at the same percentage heights as the gridlines, so
  // the plot itself can span the track column edge to edge like a lane.
  const yLabels = [];
  for (let v = 0; v <= peak; v++) {
    if (v !== 0 && v !== peak) continue;
    const pct = ((TOP + (1 - v / peak) * (H - TOP - B)) / H) * 100;
    yLabels.push(
      <Box key={v} component="span" sx={{
        position: "absolute",
        left: 0,
        top: `${pct}%`,
        transform: "translateY(-50%)",
        textAlign: "right",
        fontSize: 10,
        fontFamily: MONO,
        color: "faint",
        userSelect: "none",
      }}>{v}</Box>
    );
  }

  // Gridlines (no labels - those are in the left column now)
  const gridlines = [];
  for (let v = 0; v <= peak; v++) {
    gridlines.push(
      <line key={v} x1={L} x2={W - R} y1={y(v)} y2={y(v)}
            stroke={t.palette.divider} strokeWidth={1} />
    );
  }

  // X-axis time ticks rendered as HTML spans below the track column.
  const tickInterval = Math.max(1, Math.floor(hist.length / 5));
  const ticks = [];
  for (let i = 0; i < hist.length; i += tickInterval) {
    ticks.push(
      <Box key={`t${i}`} component="span"
           sx={{ position: "absolute", left: `${(i / (hist.length - 1)) * 100}%`,
                transform: "translateX(-50%)", bottom: 0, whiteSpace: "nowrap",
                fontSize: 11, fontFamily: MONO, color: "faint" }}>
        {clock(hist[i]!.t)}
      </Box>
    );
  }
  ticks.push(
    <Box key="now" component="span"
         sx={{ position: "absolute", right: 0, bottom: 0, whiteSpace: "nowrap",
               fontSize: 11, fontFamily: MONO, color: "faint" }}>
      now
    </Box>
  );

  return (
    <>
      <Box sx={{ display: "grid", gridTemplateColumns: `${LABEL_COL} ${TRACK_COL}`, columnGap: COL_GAP }}>
        {/* Y-axis labels in the left column */}
        <Box sx={{ position: "relative" }}>
          {yLabels}
        </Box>
        {/* Chart track */}
        <Box sx={{ position: "relative" }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Queue depth over the last 10 minutes, peaking at ${peak} jobs.`}
            style={fill}
            onMouseMove={(e) => {
              const bb = e.currentTarget.getBoundingClientRect();
              const rel = ((e.clientX - bb.left) / bb.width) * W;
              setAt(Math.max(0, Math.min(hist.length - 1,
                Math.round(((rel - L) / (W - L - R)) * (hist.length - 1)))));
            }}
            onMouseLeave={() => setAt(null)}
          >
            {gridlines}
            <path d={`${line} L ${x(hist.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`}
                  fill={t.palette.success.main} fillOpacity={0.12} stroke="none" />
            <path d={line} fill="none" stroke={t.palette.success.main}
                  strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={last[0]} cy={last[1]} r={4} fill={t.palette.success.main}
                    stroke={t.palette.background.default} strokeWidth={2} />
            {at !== null && (
              <line x1={x(at)} x2={x(at)} y1={TOP} y2={H - B} stroke={t.palette.text.secondary}
                    strokeWidth={1} strokeDasharray="2 3" pointerEvents="none" />
            )}
          </svg>
          {/* Custom hover readout box - positioned inside the relative wrapper */}
          {hovered && (
            <Box
              sx={{
                position: "absolute",
                top: 0,
                left: `${((at ?? 0) / (hist.length - 1)) * 100}%`,
                transform: "translateX(-50%)",
                bgcolor: t.palette.background.paper,
                border: `1px solid ${t.palette.line}`,
                borderRadius: 1,
                px: 1,
                py: 0.5,
                fontSize: 11.5,
                fontFamily: MONO,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                zIndex: 10,
              }}
            >
              <b>{hovered.queued}</b> queued · {clock(hovered.t)}
              {hovered.residents?.length ? (
                <Box component="span" sx={{ color: "text.secondary", display: "block" }}>
                  warm: {[...new Set(hovered.residents.map(fold))].sort().join(", ")}
                </Box>
              ) : null}
            </Box>
          )}
        </Box>
      </Box>
      {/* Time ticks below the chart */}
      <Box sx={{ position: "relative", height: 16, mt: 0.25 }}>
        {ticks}
      </Box>
      <Typography variant="caption"
                  sx={{ color: "faint", fontFamily: MONO, display: "block", textAlign: "right" }}>
        {flatZero ? "queue empty for the whole window" : `peak ${peak} · ${hist.length} samples · 5s apart`}
      </Typography>
    </>
  );
}

/**
 * Which model was in use, over the window.
 *
 * One grid row per lane (model). The faint residency band shows what was loaded
 * (from hist[].residents). Bright segments overlaid on the band show individual
 * requests from `calls`. Failed calls are drawn in the fault colour.
 *
 * Identity by POSITION, not hue. One lane per model; a swap is a step between
 * rows, so A-B-A-B thrash reads as a staircase. Everything stays ember, which
 * keeps colour meaning exactly one thing on this page: warm.
 *
 * `thrashy` is the set of models on a backend that actually evicts. A backend
 * that keeps everything resident produces an unbroken bar edge to edge, which
 * is structurally incapable of showing the thrash this chart exists to show --
 * four such rows above the one that moves buried the signal. Those sort down
 * and draw dim.
 *
 * This was "Which model was loaded, over the window." until per-request
 * `calls` arrived; the residency band is still exactly that chart, the
 * segments are the new layer on top of it.
 */
export function Lanes({
  hist, calls, thrashy, aliases, available,
}: {
  hist: Sample[];
  calls?: Call[];
  thrashy: Set<string> | null;
  aliases?: Record<string, string>;
  available?: string[];
}) {
  const t = useTheme();
  // The readout is drawn INSIDE the chart's own position:relative wrapper, at the
  // pointer. `x`/`y` are pointer offsets from that wrapper, taken on every move,
  // so the box follows the segment the pointer is on and never anchors to the
  // viewport or to the page: a `position: fixed` box at (20, 20) is how the first
  // version of this appeared over the Models table, four sections away.
  const [hover, setHover] = useState<{ type: "call" | "track"; data: Call | { model: string; time: number; loaded: boolean; active: boolean; index: number }; x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const at = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  if (!hist || hist.length < 2) return <Empty msg="warming up" />;

  // Fold a variant id to its parent if the parent is available.
  const fold = (id: string): string => displayId(id, aliases, available);

  const foldedResidents = hist.map((d) => (d.residents ?? []).map((r) => fold(r)));

  const rowH = 10, gap = 8, rowTotal = rowH + gap;

  const canThrash = (m: string) => !thrashy || thrashy.has(m);
  // Several backends means several models warm at once, so this flattens a list
  // per sample rather than reading one name.
  const models = [...new Set(foldedResidents.flat())]
    .sort((a, b) => (canThrash(b) ? 1 : 0) - (canThrash(a) ? 1 : 0));
  const nowWarm = new Set(foldedResidents[foldedResidents.length - 1]!);

  // A swap is any change in the warm set, which on a multi-backend node means
  // "one of the backends swapped", not necessarily the GPU.
  // Swaps between variants of the same parent are not counted (they are the
  // same weights).
  const swaps = foldedResidents.filter((r, i) =>
    i > 0 && r.join("") !== foldedResidents[i - 1]!.join("")).length;

  /** Contiguous runs of one model, as [firstSample, lastSample] index pairs. */
  const runs = (m: string): [number, number][] => {
    const has = (k: number) => foldedResidents[k]!.includes(m);
    const out: [number, number][] = [];
    for (let i = 0; i < foldedResidents.length; i++) {
      if (!has(i)) continue;
      let j = i;
      while (j + 1 < foldedResidents.length && has(j + 1)) j++;
      out.push([i, Math.min(j + 1, foldedResidents.length - 1)]);
      i = j;
    }
    return out;
  };

  // Time range for the chart
  const windowMs = 10 * 60 * 1000;
  const tEnd = hist[hist.length - 1]!.t;
  const tStart = tEnd - windowMs;

  // Map calls to pixel coordinates: each call runs from (t - ms) to t
  const callSegments = calls?.map((c) => ({
    ...c,
    display: fold(c.model),
    startPct: Math.max(0, ((c.t - c.ms - c.waitedMs) - tStart) / windowMs) * 100,
    runPct: Math.max(0, ((c.t - c.ms) - tStart) / windowMs) * 100,
    endPct: Math.min(100, ((c.t) - tStart) / windowMs) * 100,
  }))?.filter((c) => c.endPct > 0 && c.startPct < 100) ?? [];

  // Group call segments by lane
  const callsByModel: Record<string, (typeof callSegments)> = {};
  for (const c of callSegments) {
    const lane = callsByModel[c.display] || [];
    lane.push(c);
    callsByModel[c.display] = lane;
  }

  // Check if hist[].active names this model at this sample (tint brighter)
  const isUsing = (sampleIdx: number, model: string): boolean => {
    const active = hist[sampleIdx]!.active ?? [];
    return active.some((a) => fold(a) === model);
  };

  // One SVG per lane, each with width 100% so it fills its cell.
  const laneSvg = (m: string) => {
    // A lane on a backend that never evicts used to draw in the divider colour:
    // it cannot show thrash, so it was demoted to context. Now that the caption
    // says "track = loaded", a dim track reads as "not loaded", which for an
    // ollama model kept resident is the opposite of the truth. Loaded is green
    // everywhere; the non-evicting lanes still sort down and stay a shade
    // quieter, and the swap count still ignores them.
    const bar = !canThrash(m) ? alpha(t.palette.success.main, 0.45)
      : nowWarm.has(m) ? t.palette.success.main : t.palette.text.secondary;
    const laneCalls = callsByModel[m] ?? [];

    const handleSvgMove = (e: React.MouseEvent<SVGSVGElement>) => {
      // If over a segment, let the segment's own handler deal with it
      if ((e.target as Element).getAttribute("data-call")) return;
      // Compute sample index from pointer position
      const bb = e.currentTarget.getBoundingClientRect();
      const frac = (e.clientX - bb.left) / bb.width;
      const i = Math.max(0, Math.min(hist.length - 1, Math.round(frac * (hist.length - 1))));
      const loaded = foldedResidents[i]!.includes(m);
      const active = isUsing(i, m);
      setHover({ type: "track", data: { model: m, time: hist[i]!.t, loaded, active, index: i }, ...at(e) });
    };

    return (
      <Box key={m} sx={{ position: "relative" }}>
        <svg viewBox="0 0 1000 20" preserveAspectRatio="none"
             style={{ display: "block", width: "100%", height: rowH, marginTop: gap / 2 }}
             onMouseMove={handleSvgMove}
             onMouseLeave={() => setHover(null)}>
          <rect x="0" y="4" width="1000" height="10" fill={t.palette.divider} rx={5} />
          {runs(m).map(([i0, j0], ri) => {
            const x0 = (i0 / (hist.length - 1)) * 1000;
            const x1 = ((j0 + 1) / (hist.length - 1)) * 1000;
            // Brighten slightly if model is actively in use during this run
            const anyActive = Array.from({ length: j0 - i0 + 1 }).some((_, k) => isUsing(i0 + k, m));
            const runColor = anyActive
              ? (canThrash(m) ? t.palette.success.main : t.palette.line)
              : bar;
            return (
              <rect key={ri} x={x0} y="4" width={Math.max(2, x1 - x0)} height="10"
                    fill={runColor} rx={5} opacity={anyActive ? 1 : 0.7} />
            );
          })}
          {/* Cursor line for track hover */}
          {hover?.type === "track" && (hover.data as { model: string; index: number }).model === m && (
            <line x1={((hover.data as { index: number }).index / (hist.length - 1)) * 1000}
                  x2={((hover.data as { index: number }).index / (hist.length - 1)) * 1000}
                  y1="0" y2="20" stroke={t.palette.text.secondary}
                  strokeWidth="1" strokeDasharray="2 3" pointerEvents="none" />
          )}
          {/* Call segments overlaid on residency band */}
          {laneCalls.map((c, ci) => {
            const widthPx = Math.max(2, (c.endPct - c.startPct) / 100 * 1000);
            return (
              <g key={ci}>
                {/* Waited time as dimmer lead-in segment */}
                {c.waitedMs > 0 && (
                  <rect x={c.startPct * 10} y="4"
                        width={Math.max(1, (c.runPct - c.startPct) / 100 * 1000)}
                        height="10" fill={c.ok ? t.palette.success.main : t.palette.error.main}
                        opacity={0.3} rx={3} data-call="1"
                        onMouseEnter={(e) => setHover({ type: "call", data: c, ...at(e) })}
                        onMouseMove={(e) => setHover({ type: "call", data: c, ...at(e) })}
                        onMouseLeave={() => setHover(null)} />
                )}
                {/* Run time as bright segment */}
                <rect x={c.runPct * 10} y="4" width={widthPx} height="10"
                      fill={c.ok ? t.palette.success.main : t.palette.error.main}
                      rx={3} data-call="1"
                      onMouseEnter={(e) => setHover({ type: "call", data: c, ...at(e) })}
                      onMouseMove={(e) => setHover({ type: "call", data: c, ...at(e) })}
                      onMouseLeave={() => setHover(null)} />
              </g>
            );
          })}
        </svg>
      </Box>
    );
  };

  // Time ticks as HTML spans under the track column, evenly spaced.
  const tickInterval = Math.max(1, Math.floor(hist.length / 5));
  const ticks = [];
  for (let i = 0; i < hist.length; i += tickInterval) {
    ticks.push(
      <Box key={`t${i}`} component="span"
           sx={{ position: "absolute", left: `${(i / (hist.length - 1)) * 100}%`,
                transform: "translateX(-50%)", bottom: 0, whiteSpace: "nowrap",
                fontSize: 11, fontFamily: MONO, color: "faint" }}>
        {clock(hist[i]!.t)}
      </Box>
    );
  }
  ticks.push(
    <Box key="now" component="span"
         sx={{ position: "absolute", right: 0, bottom: 0, whiteSpace: "nowrap",
               fontSize: 11, fontFamily: MONO, color: "faint" }}>
      now
    </Box>
  );

  // Custom hover readout box - positioned inside the relative wrapper
  const hoverBox = (hovered: typeof hover) => {
    if (!hovered) return null;
    if (hovered.type === "call") {
      const c = hovered.data as Call;
      const started = clock(c.t - c.ms - c.waitedMs);
      const ranSec = Math.round(c.ms / 1000);
      const waitedSec = Math.round(c.waitedMs / 1000);
      return (
        <Box
          sx={{
            position: "absolute",
            // Centred on the pointer, sitting just above it, and clamped so the
            // box never leaves the chart at either edge.
            left: Math.min(Math.max(hovered.x, 150), Math.max(150, (rootRef.current?.clientWidth ?? 300) - 150)),
            top: hovered.y - 12,
            transform: "translate(-50%, -100%)",
            bgcolor: t.palette.background.paper,
            border: `1px solid ${t.palette.line}`,
            borderRadius: 1,
            px: 1.25,
            py: 0.75,
            fontSize: 11.5,
            fontFamily: MONO,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 100,
            boxShadow: `0 4px 12px ${t.palette.mode === "dark" ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.15)"}`,
          }}
        >
          <b>{fold(c.model)}</b> · {c.backend}
          <Box component="span" sx={{ display: "block" }}>
            started {started} · ran {ranSec}s · waited {waitedSec}s · {c.ok ? "ok" : "failed"}
          </Box>
        </Box>
      );
    }
    if (hovered.type === "track") {
      const d = hovered.data as { model: string; time: number; loaded: boolean; active: boolean; index: number };
      return (
        <Box
          sx={{
            position: "absolute",
            left: Math.min(Math.max(hovered.x, 150), Math.max(150, (rootRef.current?.clientWidth ?? 300) - 150)),
            top: hovered.y - 12,
            transform: "translate(-50%, -100%)",
            bgcolor: t.palette.background.paper,
            border: `1px solid ${t.palette.line}`,
            borderRadius: 1,
            px: 1.25,
            py: 0.75,
            fontSize: 11.5,
            fontFamily: MONO,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 100,
            boxShadow: `0 4px 12px ${t.palette.mode === "dark" ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.15)"}`,
          }}
        >
          <b>{d.model}</b> · {clock(d.time)}
          <Box component="span" sx={{ display: "block" }}>
            {d.loaded ? "loaded" : "not loaded"} · {d.active ? "in use" : "idle"}
          </Box>
        </Box>
      );
    }
    return null;
  };

  return (
    <Box ref={rootRef} sx={{ position: "relative" }}>
      <Box role="img" aria-label={`Resident models over time across ${models.length} models, with ${swaps} swaps.`}>
        <Box sx={{ display: "grid", gridTemplateColumns: `${LABEL_COL} ${TRACK_COL}`, columnGap: COL_GAP }}>
          {/* Lane labels - L2 fix: wider min, left-aligned, ellipsis at end */}
          <Box component="div" sx={{
            fontFamily: MONO, fontSize: 11.5,
            display: "flex", flexDirection: "column", justifyContent: "center",
            pr: 1,
            minWidth: 150,
            maxWidth: "40%",
          }}>
            {models.map((m) => (
              <Box key={m} sx={{
                height: rowTotal,
                display: "flex", alignItems: "center",
                justifyContent: "flex-start",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                fontWeight: nowWarm.has(m) ? 700 : 400,
                color: !canThrash(m) ? "faint"
                  : nowWarm.has(m) ? "success.main" : "text.secondary",
              }} title={m}>
                {m}
              </Box>
            ))}
          </Box>
          {/* Lanes */}
          <Box component="div">
            {models.map((m) => laneSvg(m))}
            <Box sx={{ height: 16, position: "relative" }}>{ticks}</Box>
          </Box>
        </Box>
      </Box>
      {/* Custom hover readout for per-call segments */}
      {hoverBox(hover)}
    </Box>
  );
}

/**
 * The same window as a table, for anyone the SVG does not serve.
 *
 * Collapses runs of identical samples into one row with a time range and
 * sample count, so a 10-minute window of steady state is one row, not 120.
 * Loaded ids are folded through aliases the same way as the lanes chart.
 */
export function HistTable({ hist, aliases, available }: { hist: Sample[]; aliases?: Record<string, string>; available?: string[] }) {
  if (!hist || !hist.length) {
    return (
      <Table size="small">
        <TableBody>
          <TableRow><TableCell sx={{ color: "faint", fontFamily: MONO }}>no samples</TableCell></TableRow>
        </TableBody>
      </Table>
    );
  }

  // Fold a resident id through aliases to its parent (or itself).
  const fold = (id: string): string => displayId(id, aliases, available);

  // Fold and sort a residents list for stable comparison and display.
  const foldResidents = (residents: string[] | undefined): string[] => {
    if (!residents) return [];
    const folded = residents.map(fold);
    return [...new Set(folded)].sort();
  };

  // Collapse consecutive samples with the same queued count and folded loaded set.
  type Run = {
    start: number;
    end: number;
    queued: number;
    loaded: string[];
    count: number;
  };
  const runs: Run[] = [];
  let current: Run | null = null;
  for (const d of hist) {
    const loaded = foldResidents(d.residents);
    if (
      current &&
      d.queued === current.queued &&
      loaded.join("") === current.loaded.join("")
    ) {
      current.end = d.t;
      current.count++;
    } else {
      if (current) runs.push(current);
      current = { start: d.t, end: d.t, queued: d.queued, loaded, count: 1 };
    }
  }
  if (current) runs.push(current);

  return (
    <Table size="small">
      <TableHead>
        <TableRow sx={{ borderBottom: "2px solid", borderColor: "divider" }}>
          <TableCell sx={{ width: 140 }}>Time</TableCell>
          <TableCell sx={{ width: 80 }}>Queued</TableCell>
          <TableCell>Loaded</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {runs.map((run, i) => (
          <TableRow key={i}
            sx={{ bgcolor: i % 2 === 1 ? "action.hover" : "inherit", borderBottom: "1px solid", borderColor: "divider" }}>
            <TableCell sx={{ fontFamily: MONO }}>
              {run.count > 1 ? (
                <>
                  {clock(run.start)}–{clock(run.end)}{" "}
                  <Box component="span" sx={{ color: "faint", fontSize: 10 }}>({run.count})</Box>
                </>
              ) : clock(run.start)}
            </TableCell>
            <TableCell sx={{ fontFamily: MONO, fontWeight: 600, color: run.queued > 0 ? "warning.main" : "inherit" }}>
              {run.queued}
            </TableCell>
            <TableCell sx={{ fontFamily: MONO, color: "text.secondary" }}>
              {run.loaded.length > 0 ? run.loaded.join(", ") : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * A table of every finished call that ended inside the window, newest first.
 * Collapsed by default with its own toggle, separate from the samples table.
 */
export function CallsTable({ calls, aliases, available }: { calls?: Call[]; aliases?: Record<string, string>; available?: string[] }) {
  const [open, setOpen] = useState(false);
  if (!calls || !calls.length) return null;

  const fold = (id: string): string => displayId(id, aliases, available);

  const sorted = [...calls].sort((a, b) => b.t - a.t); // newest first

  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="body2" sx={{ color: "faint", cursor: "pointer" }}
                  onClick={() => setOpen(!open)}>
        {open ? "− " : "+ "}Calls ({sorted.length})
      </Typography>
      {open && (
        <Table size="small" sx={{ mt: 1, width: "auto" }}>
          <TableHead>
            <TableRow sx={{ borderBottom: "2px solid", borderColor: "divider" }}>
              <TableCell sx={{ width: 80 }}>Ended</TableCell>
              <TableCell>Model</TableCell>
              <TableCell>Backend</TableCell>
              <TableCell sx={{ width: 60 }}>Ran</TableCell>
              <TableCell sx={{ width: 60 }}>Waited</TableCell>
              <TableCell sx={{ width: 60 }}>Ok</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted.map((c, i) => (
              <TableRow key={i} sx={{ borderBottom: "1px solid", borderColor: "divider" }}>
                <TableCell sx={{ fontFamily: MONO }}>{clock(c.t)}</TableCell>
                <TableCell sx={{ fontFamily: MONO }}>{fold(c.model)}</TableCell>
                <TableCell sx={{ fontFamily: MONO, color: "text.secondary" }}>{c.backend}</TableCell>
                <TableCell sx={{ fontFamily: MONO }}>{since(c.ms)}</TableCell>
                <TableCell sx={{ fontFamily: MONO }}>{since(c.waitedMs)}</TableCell>
                <TableCell sx={{ fontFamily: MONO, color: c.ok ? "success.main" : "error.main" }}>
                  {c.ok ? "✓" : "✗"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}