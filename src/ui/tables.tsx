/**
 * The three tables, shared.
 *
 * Queue, Models and the last-ten-minutes history. The graph console opens these
 * as drawers; the dashboard stacks them down a scroll. They live here, in one
 * copy, for exactly the reason the second console was turned down the first time:
 * a fix to how a queue row is keyed, or how "blocked" is told from "busy", has to
 * land in one place or the two views drift. Everything here keys off a stable id
 * and reads the current shape of /ui/data — `j.id`, `proxying`, `queued > 0` —
 * because both callers get whichever is correct here, together.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { Fragment, useEffect, useMemo, useState } from "react";

import { Dot, mono, Row, Spacer, Tag } from "./bits.js";
import { CallsTable, Depth, HistTable, Lanes } from "./charts.js";
import { type Sel } from "./graph.js";
import { LoadAction, ShareToggle, type Ctx } from "./inspect.js";
import { ctxLabel, displayId, since } from "./lib.js";
import { MONO } from "./theme.js";
import type { Backend, Node, UiData } from "./types.js";
import { waitReason } from "./why.js";

/** Now, once a second, so "waited" counts up between polls. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
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
export function QueueTable({ d }: { d: UiData }) {
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

/**
 * The model catalogue.
 *
 * `onSelect` is optional: the graph console passes it so a backend or peer name
 * jumps the rail to that node; the dashboard has no rail, so it omits it and the
 * names render as plain text rather than dead links.
 */
export function ModelsTable({ d, ctx, onSelect }: { d: UiData; ctx: Ctx; onSelect?: (s: Sel) => void }) {
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

  const Link = ({ label, sel, warm }: { label: string; sel: Sel; warm: boolean }) => (
    <Box component="span"
         onClick={onSelect ? () => onSelect(sel) : undefined}
         sx={{
           cursor: onSelect ? "pointer" : "default",
           textDecoration: onSelect ? "underline dotted" : "none", textUnderlineOffset: 3,
           color: warm ? "success.main" : "text.secondary",
         }}>{label}</Box>
  );

  const Where = ({ r }: { r: ModelRow }) => {
    const peers = r.on.filter((n) => !n.self);
    if (!r.backends.length && !peers.length) return <Box component="span" sx={{ color: "faint" }}>—</Box>;
    return (
      <Row spacing={0.75} align="baseline" wrap component="span" sx={{ display: "inline-flex" }}>
        {r.backends.map((b) => (
          <Link key={b.name} label={b.name} sel={{ kind: "backend", id: b.name }}
                warm={backendHas(d, b, r.model, "loaded")} />
        ))}
        {r.route && (
          <Tag title={`reached by POST ${r.route.path}, not /v1/chat/completions — hearth forwards the body untouched and queues it as ${r.model}`}>
            {r.route.path}
          </Tag>
        )}
        {peers.map((n) => (
          <Link key={n.name} label={n.name} sel={{ kind: "peer", id: n.name }}
                warm={(n.loaded ?? []).includes(r.model)} />
        ))}
      </Row>
    );
  };

  /**
   * What this model can take: window first, then the two capabilities that
   * change whether a request runs at all.
   *
   * Reads the node's own numbers rather than a merged map, self first: a local
   * request runs on the local backend, so when both we and a peer serve an id,
   * the number that describes what YOU will get is ours. The tooltip names
   * whose reading it is, because on a borrowed model it is not ours.
   */
  const Takes = ({ r }: { r: ModelRow }) => {
    const src = [...r.on.filter((n) => n.self), ...r.on.filter((n) => !n.self)]
      .find((n) => n.stats?.[r.model]);
    const st = src?.stats?.[r.model];
    if (!st || !src) {
      return (
        <Tooltip title="nothing reported yet — a model has to be loaded once before its backend will say what it holds">
          <Box component="span" sx={{ color: "faint" }}>—</Box>
        </Tooltip>
      );
    }
    // A declared record is the operator's word about a model that has not been
    // loaded yet, so it is drawn dimmer and says so. Not pedantry: it is the
    // one number here that nothing has checked, and the case it exists for —
    // a cold model — is exactly when nobody can check it.
    const declared = st.from === "declared";
    const notes = [
      declared
        ? `declared in ${src.name}'s config — nothing has loaded this model to confirm it`
        : st.from === "both"
          ? `reported by ${src.name}, with declared values where it does not say`
          : `reported by ${src.name}`,
      st.quant ? `quantized ${st.quant}` : null,
      st.vision === false ? "text only, no images" : null,
      st.tools === false ? "no tool calls" : null,
      st.thinking === false ? "no thinking level" : null,
    ].filter(Boolean).join(" · ");
    return (
      <Tooltip title={notes}>
        <Row spacing={0.75} align="baseline" component="span" sx={{ display: "inline-flex" }}>
          <Typography component="span" sx={{ ...mono, fontSize: 11, color: declared ? "faint" : undefined }}>
            {st.context === undefined ? "—" : ctxLabel(st.context)}
          </Typography>
          {st.vision === true && <Tag>vision</Tag>}
          {st.tools === true && <Tag>tools</Tag>}
          {st.thinking === true && <Tag>thinking</Tag>}
        </Row>
      </Tooltip>
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
            <TableCell>Takes</TableCell>
            <TableCell>Shared</TableCell><TableCell align="right">Load</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {!rows.length && (
            <TableRow><TableCell colSpan={6} sx={{ color: "faint", py: 2 }}>no models reachable</TableCell></TableRow>
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
                  <TableCell><Takes r={r} /></TableCell>
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
                      <TableCell><Takes r={vr} /></TableCell>
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

export function History({ d }: { d: UiData }) {
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
