/**
 * The console.
 *
 * The graph IS the page: what this box is made of and what is moving through it,
 * with one rail beside it holding every action for whatever is selected. The
 * tables did not go away — they answer questions the picture cannot ("which of
 * the fourteen models is warm", "why has that job waited 40 seconds") — but they
 * are now drawers you open, not four screens you scroll past to reach the thing
 * you came for.
 *
 * Three structural rules the old page broke, each of which cost something:
 *
 *   One place for actions. A control beside the fact it changes sounds right and
 *   scatters the controls down four sections, which is how the two switches that
 *   decide whether this box federates at all ended up in a heading two screens
 *   down.
 *
 *   Stable identity across polls. Every list here is keyed by something that
 *   survives a refresh, because reconciliation is what keeps a button's in-flight
 *   state alive through the 3s poll — the old page kept module-level Sets to work
 *   around losing it, three separate times.
 *
 *   Motion means traffic. Nothing on this page animates unless something is
 *   really happening, or the graph becomes wallpaper.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CssBaseline from "@mui/material/CssBaseline";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { ThemeProvider } from "@mui/material/styles";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dot, mono, Row, Spacer, Tag } from "./bits.js";
import { CallsTable, Depth, HistTable, Lanes } from "./charts.js";
import { Graph, type Sel } from "./graph.js";
import { Inspector, LoadAction, ShareToggle, type Ctx } from "./inspect.js";
import { displayId, load, since } from "./lib.js";
import { makeTheme, MONO } from "./theme.js";
import type { Backend, Node, UiData } from "./types.js";
import { waitReason } from "./why.js";
import Dashboard from "./dashboard.js";

/* ------------------------------------------------------------------ data */

/**
 * The poll, guarded on both sides.
 *
 * /ui/data calls peers.ensureFresh(), which can exceed the 3s interval exactly
 * when a peer is timing out — which is exactly when you are watching. Unguarded,
 * requests stack and an older response can land after a newer one and render
 * stale state over fresh. document.hidden stops a forgotten background tab
 * polling a peer-probing endpoint forever.
 */
function useData(): { data: UiData | null; dead: boolean; refresh: () => void } {
  const [data, setData] = useState<UiData | null>(null);
  const [dead, setDead] = useState(false);
  const inFlight = useRef(false);

  const poll = useCallback((force: boolean) => {
    // force=true skips the visibility check but NEVER the in-flight check.
    if (inFlight.current || (document.hidden && !force)) return;
    inFlight.current = true;
    load()
      .then((d) => { setData(d); setDead(false); })
      .catch((e) => { setDead(true); console.error(e); })
      .finally(() => { inFlight.current = false; });
  }, []);

  useEffect(() => {
    // The FIRST load is forced: document.hidden is true more often than you
    // would think — a background tab, a prerender, an embedded pane — and
    // gating the initial fetch on it left the page permanently blank there,
    // waiting on a visibilitychange that may never come.
    poll(true);
    const id = setInterval(() => poll(false), 3000);
    const back = () => { if (!document.hidden) poll(true); };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", back); };
  }, [poll]);

  return { data, dead, refresh: () => poll(true) };
}

/** Now, once a second, so "waited" counts up between polls. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/* --------------------------------------------------------------- drawers */

type Drawer = "queue" | "models" | "history" | null;

function DrawerTab({ label, count, hot, open, onClick }: {
  label: string; count?: React.ReactNode; hot?: boolean; open: boolean; onClick: () => void;
}) {
  return (
    <Button onClick={onClick} aria-expanded={open} sx={[
      {
        borderColor: "transparent", borderRadius: 0, px: 1.5, py: 0.75,
        borderBottom: "2px solid", borderBottomColor: "transparent",
        "&:hover": { borderColor: "transparent", borderBottomColor: "line", background: "none" },
      },
      open && {
        color: "text.primary", borderBottomColor: "success.main",
        "&:hover": { borderBottomColor: "success.main" },
      },
    ]}>
      {label}
      {count !== undefined && (
        <Box component="span" sx={{ ml: 0.75, color: hot ? "warning.main" : "faint" }}>{count}</Box>
      )}
    </Button>
  );
}

/* ----------------------------------------------------------------- queue */

/** Amber for anything the operator could act on, green for work in progress. */
const TONE = { blocked: "warning.main", busy: "text.secondary", cold: "warning.main", lane: "text.secondary" } as const;

/**
 * What is in flight, and for anything that is not, why not.
 *
 * A job waits for exactly one of four reasons and they call for different
 * responses: the backend is full (the ceiling working), the model has to load
 * (fine, once), another backend is holding the card (the interesting one), or
 * it is behind others in its lane. Only one of those is a hardware problem, and
 * a State column that said "queued" hid all four.
 */
function QueueTable({ d }: { d: UiData }) {
  const now = useNow();
  const rank = { running: 0, queued: 1 };
  const jobs = [...d.q.jobs].sort((a, b) => rank[a.state] - rank[b.state] || a.position - b.position);
  const backends = d.net.nodes.find((n) => n.self)?.backends ?? [];
  const resources = d.net.resources ?? [];

  if (!jobs.length) {
    return <Typography sx={{ ...mono, color: "faint", py: 3, textAlign: "center" }}>nothing in flight</Typography>;
  }
  return (
    <Box sx={{ overflowX: "auto" }}>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>Lane</TableCell><TableCell>Model</TableCell><TableCell>Where</TableCell>
            <TableCell>Caller</TableCell><TableCell>Status</TableCell><TableCell align="right">Waited</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {jobs.map((j) => {
            const b = backends.find((x) => x.name === j.backend);
            const wait = j.state === "queued" ? waitReason(j, b, resources) : null;
            return (
              <TableRow key={j.id}>
                <TableCell sx={{ ...mono, color: j.lane === "chat" ? "success.main" : "text.secondary" }}>{j.lane}</TableCell>
                <TableCell sx={{ ...mono, whiteSpace: "nowrap" }}>{displayId(j.model, d.aliases, d.net.available)}</TableCell>
                <TableCell sx={{ ...mono, color: "text.secondary" }}>
                  <Row spacing={0.75} align="baseline" wrap component="span" sx={{ display: "inline-flex" }}>
                    <Box component="span">{j.offbox ? j.peer ?? "peer" : j.backend ?? "—"}</Box>
                    {!j.offbox && (b?.resources ?? []).map((r) => <Tag key={r}>{r}</Tag>)}
                  </Row>
                </TableCell>
                <TableCell sx={{ ...mono, color: "text.secondary" }}>{j.caller}</TableCell>
                <TableCell sx={{ ...mono, color: wait ? TONE[wait.tone] : "success.main" }}>
                  {j.offbox ? "on a peer" : wait ? (
                    <Tooltip title={wait.tone === "blocked"
                      ? "not this backend's own ceiling: another backend is running on hardware this one declared, and admission checks that first"
                      : wait.tone === "cold"
                        ? "this backend swaps, so the model in front has to be unloaded before this one loads — 20-60s of it"
                        : wait.tone === "busy"
                          ? "the backend is at its slot ceiling, which is the ceiling doing its job"
                          : "ordinary queueing: other work scored higher in this lane"}>
                      <Box component="span" sx={{ cursor: "help" }}>
                        <Dot color={TONE[wait.tone]} />{wait.text}
                      </Box>
                    </Tooltip>
                  ) : <><Dot color="success.main" />running</>}
                </TableCell>
                <TableCell align="right" sx={mono}>{since(now - j.since)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}

/* ---------------------------------------------------------------- models */

interface ModelRow {
  model: string;
  on: Node[];
  warmOn: Node[];
  warm: boolean;
  backends: Backend[];
  unknown: boolean;
  route?: { path: string; model: string; lane: string; queue: boolean };
}

/** Resolve an advertised id to the wire id backends actually report. */
const wireOf = (d: UiData, m: string): string => d.aliases?.[m] ?? m;

const backendHas = (d: UiData, b: Backend, m: string, list: "serves" | "loaded"): boolean => {
  const ids = b[list] ?? [];
  return ids.includes(m) || ids.includes(wireOf(d, m));
};

/**
 * Variant groups from the aliases map.
 *
 * X is a variant of P when aliases[X] === P and P is itself in net.available.
 * An `as` naming something not in available is a rename, not a variant — those
 * rows stand alone.
 */
function variantGroups(d: UiData): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [adv, as] of Object.entries(d.aliases ?? {})) {
    if (adv === as) continue;
    if (d.net.available.includes(as) && d.net.available.includes(adv)) {
      if (!groups.has(as)) groups.set(as, []);
      groups.get(as)!.push(adv);
    }
  }
  return groups;
}

/** Which node serves a model, or null when we serve it ourselves. */
function nodeOf(d: UiData, model: string): string | null {
  const self = d.net.nodes.find((n) => n.self);
  if (self?.serves?.includes(model)) return null;
  const p = d.net.nodes.find((n) => !n.self
    && ((n.serves ?? []).includes(model) || (n.configured ?? []).includes(model)));
  return p?.name ?? null;
}

function ModelsTable({ d, ctx, onSelect }: { d: UiData; ctx: Ctx; onSelect: (s: Sel) => void }) {
  const { net } = d;
  const self = net.nodes.find((n) => n.self);
  const backends = self?.backends ?? [];
  const groups = variantGroups(d);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const holders = (m: string) => net.nodes.filter((n) =>
    (n.serves ?? []).includes(m) || (n.configured ?? []).includes(m));

  const variantIds = new Set<string>();
  for (const vs of groups.values()) for (const v of vs) variantIds.add(v);

  const allRows: ModelRow[] = net.available.map((m) => {
    const on = holders(m);
    const mine = backends.filter((b) => backendHas(d, b, m, "serves"));
    return {
      model: m, on, backends: mine,
      warmOn: on.filter((n) => (n.loaded ?? []).includes(m)),
      warm: net.readyNow.includes(m),
      unknown: !net.readyNow.includes(m) && (net.unknownWarm ?? []).includes(m),
    };
  });

  const rows = allRows.filter((r) => !variantIds.has(r.model));
  // Route models are real work with real ids that queue, and they are in no
  // catalogue: a client cannot ask for one by model id, it asks by path.
  for (const b of backends) {
    for (const rt of b.routes ?? []) {
      if (!rt.queue || rows.some((r) => r.model === rt.model)) continue;
      rows.push({ model: rt.model, on: self ? [self] : [], warmOn: [], warm: false,
                  unknown: false, backends: [b], route: rt });
    }
  }
  // Warm first — it is the perishable fact. Alphabetical within a group so rows
  // do not shuffle between polls for no reason.
  rows.sort((x, y) => Number(y.warm) - Number(x.warm) || x.model.localeCompare(y.model));

  const Where = ({ r }: { r: ModelRow }) => {
    const peers = r.on.filter((n) => !n.self);
    if (!r.backends.length && !peers.length) return <Box component="span" sx={{ color: "faint" }}>—</Box>;
    return (
      <Row spacing={0.75} align="baseline" wrap component="span" sx={{ display: "inline-flex" }}>
        {r.backends.map((b) => (
          <Box component="span" key={b.name} onClick={() => onSelect({ kind: "backend", id: b.name })}
               sx={{
                 cursor: "pointer", textDecoration: "underline dotted", textUnderlineOffset: 3,
                 color: backendHas(d, b, r.model, "loaded") ? "success.main" : "text.secondary",
               }}>{b.name}</Box>
        ))}
        {r.route && (
          <Tag title={`reached by POST ${r.route.path}, not /v1/chat/completions — hearth forwards the body untouched and queues it as ${r.model}`}>
            {r.route.path}
          </Tag>
        )}
        {peers.map((n) => (
          <Box component="span" key={n.name} onClick={() => onSelect({ kind: "peer", id: n.name })}
               sx={{
                 cursor: "pointer", textDecoration: "underline dotted", textUnderlineOffset: 3,
                 color: (n.loaded ?? []).includes(r.model) ? "success.main" : "text.secondary",
               }}>{n.name}</Box>
        ))}
      </Row>
    );
  };

  const State = ({ r }: { r: ModelRow }) => (
    <Tooltip title={
      r.route ? "a path, not a model id — this backend does not report what it holds, so neither can we"
      : r.unknown ? "this backend does not report what it has loaded"
      : r.warm && r.warmOn.length && !r.warmOn.some((n) => n.self)
        ? `loaded on ${r.warmOn.map((n) => n.name).join(", ")}, not here` : ""}>
      <Typography component="span" sx={{
        fontFamily: MONO, fontSize: 11,
        color: r.warm ? "success.main" : "faint", fontWeight: r.warm ? 600 : 400,
      }}>
        <Dot color={r.warm ? "success.main" : r.route || r.unknown ? "faint" : "text.secondary"} />
        {r.warm ? "warm" : r.route || r.unknown ? "unknown" : "cold"}
      </Typography>
    </Tooltip>
  );

  return (
    <Box sx={{ overflowX: "auto" }}>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>Model</TableCell><TableCell>Where</TableCell><TableCell>State</TableCell>
            <TableCell>Shared</TableCell><TableCell align="right">Load</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {!rows.length && (
            <TableRow><TableCell colSpan={5} sx={{ color: "faint", py: 2 }}>no models reachable</TableCell></TableRow>
          )}
          {rows.map((r) => {
            const variants = groups.get(r.model);
            const open = expanded[r.model];
            return (
              <Fragment key={r.model}>
                <TableRow sx={r.warm ? undefined : { opacity: 0.6 }}>
                  <TableCell sx={{ ...mono, whiteSpace: "nowrap" }}>
                    {variants?.length ? (
                      <Box component="span" onClick={() => setExpanded((e) => ({ ...e, [r.model]: !e[r.model] }))}
                           sx={{ cursor: "pointer", userSelect: "none" }}>
                        {r.model}
                        <Box component="span" sx={{ color: "faint", ml: 0.5, fontSize: 11 }}>
                          {open ? "−" : "+"}{variants.length}
                        </Box>
                      </Box>
                    ) : r.model}
                  </TableCell>
                  <TableCell sx={{ ...mono, color: "text.secondary" }}><Where r={r} /></TableCell>
                  <TableCell><State r={r} /></TableCell>
                  <TableCell><ShareToggle model={r.model} d={d} ctx={ctx} /></TableCell>
                  <TableCell align="right">
                    {/* No load button for a route model: /v1/warm takes a model id
                        and this one is only ever reached by path. */}
                    {!r.warm && !r.unknown && !r.route && ctx.canWarm && (
                      <LoadAction model={r.model} peer={nodeOf(d, r.model)} ctx={ctx} />
                    )}
                  </TableCell>
                </TableRow>
                {open && variants?.map((v) => {
                  const vr = allRows.find((x) => x.model === v);
                  if (!vr) return null;
                  return (
                    <TableRow key={v} sx={{ bgcolor: "action.hover" }}>
                      <TableCell sx={{ ...mono, pl: 3, whiteSpace: "nowrap",
                                       borderLeft: "2px solid", borderColor: "divider" }}>{v}</TableCell>
                      <TableCell sx={{ ...mono, color: "text.secondary" }}><Where r={vr} /></TableCell>
                      <TableCell><State r={vr} /></TableCell>
                      <TableCell><ShareToggle model={v} d={d} ctx={ctx} /></TableCell>
                      <TableCell align="right">
                        {!vr.warm && !vr.unknown && ctx.canWarm && (
                          <LoadAction model={v} peer={nodeOf(d, v)} ctx={ctx} />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}

/* ---------------------------------------------------------------- history */

function History({ d }: { d: UiData }) {
  const self = d.net.nodes.find((n) => n.self);
  const [numbers, setNumbers] = useState(false);
  // Which models sit on a backend that actually evicts. Everything else cannot
  // thrash by construction.
  const thrashy = useMemo(() => {
    const s = new Set<string>();
    for (const b of self?.backends ?? []) if (b.evicts) for (const m of b.serves ?? []) s.add(m);
    return s.size ? s : null;
  }, [self]);

  return (
    <Box>
      <Box sx={{ mb: 2.5 }}>
        <Typography sx={{ fontSize: 11.5, mb: 0.75 }}>Jobs waiting for the local backend</Typography>
        <Depth hist={d.hist} aliases={d.aliases} available={d.net.available} />
      </Box>
      <Box sx={{ mb: 2 }}>
        <Row align="baseline" spacing={1.25} sx={{ mb: 0.75 }}>
          <Typography sx={{ fontSize: 11.5 }}>{d.calls ? "Which model was in use" : "Which model was loaded"}</Typography>
          {d.calls && (
            <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: "faint" }}>
              track = loaded, segment = one request
            </Typography>
          )}
          <Spacer />
          <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: "faint" }}>
            {/* Only say "thrash" where something actually evicts. */}
            {d.net.evicts === false ? "these backends hold models resident" : "each change of row is a cold load"}
          </Typography>
        </Row>
        <Lanes hist={d.hist} calls={d.calls} thrashy={thrashy} aliases={d.aliases} available={d.net.available} />
      </Box>
      <Button onClick={() => setNumbers((n) => !n)}>{numbers ? "hide" : "show"} the numbers</Button>
      {numbers && (
        <Box sx={{ mt: 1.5 }}>
          <Box sx={{ overflowX: "auto" }}>
            <HistTable hist={d.hist} aliases={d.aliases} available={d.net.available} />
          </Box>
          <CallsTable calls={d.calls} aliases={d.aliases} available={d.net.available} />
        </Box>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------------ page */

function Console({ d, ctx, dead, menu }: { d: UiData | null; ctx: Ctx; dead: boolean; menu?: React.ReactNode }) {
  const [sel, setSel] = useState<Sel>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const self = d?.net.nodes.find((n) => n.self);
  const queued = d ? Object.values(d.q.capacity.queued).reduce((a, b) => a + b, 0) : 0;
  const running = d ? d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length : 0;

  const toggle = (which: Exclude<Drawer, null>) =>
    setDrawer((cur) => (cur === which ? null : which));

  return (
    <Box sx={{
      // Exactly one viewport on a wide screen, so the drawer bar is always
      // reachable without scrolling and the stage takes whatever is left over.
      // minHeight alone let the stage grow the document instead, which put the
      // drawers below the fold. On a narrow screen the rail stacks under the
      // stage and the document scrolls normally, so the clamp is lifted.
      minHeight: "100dvh", height: { md: "100dvh" }, overflow: { md: "hidden" },
      display: "flex", flexDirection: "column", bgcolor: "background.default",
    }}>
      {/* Header. Identity and the two facts you would reload the page to check. */}
      <Box component="header" sx={{
        display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap",
        px: 3, py: 1.25, borderBottom: "1px solid", borderColor: "line",
        bgcolor: "background.paper", flexShrink: 0,
      }}>
        {menu}
        <Typography component="span" sx={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.01em" }}>
          hea<Box component="span" sx={{ color: "success.main" }}>r</Box>th
        </Typography>
        <Tag>{dead ? "unreachable" : self?.name ?? "—"}</Tag>
        <Typography component="span" sx={{ fontFamily: MONO, fontSize: 10.5, color: dead ? "error.main" : "faint" }}>
          <Dot color={dead ? "error.main" : "success.main"} />{dead ? "no answer from /ui/data" : "live"}
        </Typography>
        <Spacer />
        {d && (
          <Row spacing={2} align="baseline" sx={{ fontFamily: MONO, fontSize: 11, color: "text.secondary" }}>
            <Box component="span">
              <Box component="b" sx={{ color: running ? "success.main" : "text.primary" }}>{running}</Box> running
            </Box>
            <Box component="span">
              <Box component="b" sx={{ color: queued ? "warning.main" : "text.primary" }}>{queued}</Box> queued
            </Box>
            {d.q.capacity.resident && (
              <Tooltip title="the first model currently loaded on this node">
                <Box component="span" sx={{ cursor: "help" }}>
                  resident <Box component="span" sx={{ color: "success.main" }}>{d.q.capacity.resident}</Box>
                </Box>
              </Tooltip>
            )}
          </Row>
        )}
      </Box>

      {!d ? (
        <Typography sx={{ color: "faint", p: 4 }}>{dead ? "no answer from /ui/data" : "loading…"}</Typography>
      ) : (
        <>
          {/* Stage and rail. The rail drops under the stage on a narrow screen
              rather than shrinking into a column of wrapped words. */}
          <Box sx={{
            flex: "1 1 auto", minHeight: 0,
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "minmax(0,1fr) 340px" },
          }}>
            <Box sx={{ p: 2, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Graph d={d} sel={sel} onSelect={setSel} />
            </Box>
            <Inspector d={d} sel={sel} ctx={ctx} onSelect={setSel} />
          </Box>

          {/* Drawers. Closed by default: the graph answers most visits, and a
              page that opens with three tables under it is the page this
              replaced. */}
          <Box component="footer" sx={{
            borderTop: "1px solid", borderColor: "line", bgcolor: "background.paper", flexShrink: 0,
          }}>
            <Row spacing={0} align="center" sx={{ px: 1.5, borderBottom: drawer ? "1px solid" : "none", borderColor: "line" }}>
              <DrawerTab label="queue" count={d.q.jobs.length} hot={queued > 0}
                         open={drawer === "queue"} onClick={() => toggle("queue")} />
              <DrawerTab label="models" count={`${d.net.readyNow.length}/${d.net.available.length}`}
                         open={drawer === "models"} onClick={() => toggle("models")} />
              <DrawerTab label="last 10 minutes"
                         open={drawer === "history"} onClick={() => toggle("history")} />
              <Spacer />
              <Typography sx={{ fontFamily: MONO, fontSize: 10, color: "faint", pr: 1.5, display: { xs: "none", sm: "block" } }}>
                polls /ui/data every 3s
              </Typography>
            </Row>
            {drawer && (
              <Box sx={{ p: 2, maxHeight: "45dvh", overflowY: "auto" }}>
                {drawer === "queue" && <QueueTable d={d} />}
                {drawer === "models" && <ModelsTable d={d} ctx={ctx} onSelect={setSel} />}
                {drawer === "history" && <History d={d} />}
              </Box>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------------ views */

/**
 * Which view is showing, remembered per browser.
 *
 * The graph is the default — it is what a visit is usually for. The dashboard is
 * the same facts as a long scroll, for reading every number at once; an operator
 * who prefers that should not re-pick it every reload, so the choice is stored.
 * localStorage can throw (private mode, storage disabled), and a page that
 * refuses to render because it could not remember a preference is worse than one
 * that forgets it, so both sides are guarded and fall back to the graph.
 */
type View = "graph" | "dashboard";
const VIEW_KEY = "hearth.view";

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try { return localStorage.getItem(VIEW_KEY) === "dashboard" ? "dashboard" : "graph"; }
    catch { return "graph"; }
  });
  const choose = useCallback((v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: this session only */ }
  }, []);
  return [view, choose];
}

/**
 * The view switcher.
 *
 * A menu button that folds both views behind one control in the header rather
 * than spending header width on a tab each. The bars are drawn from Boxes so no
 * icon package is pulled in — the runtime dependency stays `yaml` alone — and it
 * is a real menu, so a third view later is one more item, not a layout change.
 */
function ViewMenu({ view, onView }: { view: View; onView: (v: View) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const pick = (v: View) => { onView(v); setAnchor(null); };
  return (
    <>
      <IconButton
        aria-label="switch view" aria-haspopup="menu" aria-expanded={Boolean(anchor)}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ borderRadius: 1.5, p: 0.75, color: "text.secondary", "&:hover": { color: "text.primary" } }}
      >
        <Box aria-hidden sx={{ width: 16, display: "grid", gap: "3px" }}>
          <Box sx={{ height: 2, borderRadius: 1, bgcolor: "currentColor" }} />
          <Box sx={{ height: 2, borderRadius: 1, bgcolor: "currentColor" }} />
          <Box sx={{ height: 2, borderRadius: 1, bgcolor: "currentColor" }} />
        </Box>
      </IconButton>
      <Menu
        anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        <MenuItem selected={view === "graph"} onClick={() => pick("graph")}>Graph</MenuItem>
        <MenuItem selected={view === "dashboard"} onClick={() => pick("dashboard")}>Dashboard</MenuItem>
      </Menu>
    </>
  );
}

/* ------------------------------------------------------------------ page */

export default function App() {
  const { data, dead, refresh } = useData();
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useMemo(() => makeTheme(prefersDark ? "dark" : "light"), [prefersDark]);
  const [view, setView] = useView();
  const ctx: Ctx = {
    canWarm: data?.canWarm ?? false,
    control: data?.control ?? "off",
    refresh,
  };
  // One menu element, handed to whichever view is mounted so it sits inside that
  // view's own header rather than floating over it.
  const menu = <ViewMenu view={view} onView={setView} />;
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {view === "graph"
        ? <Console d={data} ctx={ctx} dead={dead} menu={menu} />
        : <Dashboard d={data} ctx={ctx} dead={dead} menu={menu} />}
    </ThemeProvider>
  );
}
