/** Queue, Models and history tables, one copy shared by the graph's drawers and the dashboard. */
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
import { LoadAction, NoteEdit, ShareToggle, type Ctx } from "./inspect.js";
import { ctxLabel, displayId, since } from "./lib.js";
import { capabilityChips, capabilityGaps } from "./takes.js";
import { MONO } from "./theme.js";
import type { Backend, Node, UiData } from "./types.js";
import { callStats, waitReason } from "./why.js";

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
 * In-flight jobs, and why each waiting one waits: backend full, model loading, card held by
 * another backend, or behind others in its lane.
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

/** Variant groups: X is a variant of P when aliases[X] === P and P is advertised; otherwise a rename. */
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

/** The model catalogue. `onSelect` links names to the rail; the dashboard omits it. */
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

  /** Window, vision and tools, from our own reading first: a local request runs on our backend. */
  const Takes = ({ r }: { r: ModelRow }) => {
    const src = [...r.on.filter((n) => n.self), ...r.on.filter((n) => !n.self)]
      .find((n) => n.stats?.[r.model]);
    const st = src?.stats?.[r.model];
    if (!st || !src || Object.keys(st).every((k) => k === "note" || k === "from")) {
      return (
        <Tooltip title="nothing reported yet — a model has to be loaded once before its backend will say what it holds">
          <Box component="span" sx={{ color: "faint" }}>—</Box>
        </Tooltip>
      );
    }
    // A declared record is unverified until the model loads, so it is drawn dimmer.
    const declared = st.from === "declared";
    const notes = [
      declared
        ? `declared in ${src.name}'s config — nothing has loaded this model to confirm it`
        : st.from === "both"
          ? `reported by ${src.name}, with declared values where it does not say`
          : `reported by ${src.name}`,
      st.quant ? `quantized ${st.quant}` : null,
      ...capabilityGaps(st),
    ].filter(Boolean).join(" · ");
    return (
      <Tooltip title={notes}>
        <Row spacing={0.75} align="baseline" component="span" sx={{ display: "inline-flex" }}>
          <Typography component="span" sx={{ ...mono, fontSize: 11, color: declared ? "faint" : undefined }}>
            {st.context === undefined ? "—" : ctxLabel(st.context)}
          </Typography>
          {capabilityChips(st).map((c) => <Tag key={c}>{c}</Tag>)}
        </Row>
      </Tooltip>
    );
  };

  // Called, not rendered as <Note>: a component declared in here is a new type every
  // render, and React would remount NoteEdit and drop the draft on each live update.
  const note = (r: ModelRow) => {
    const self = r.on.find((n) => n.self);
    if (self && d.catalog.includes(r.model)) {
      return <NoteEdit model={r.model} note={self.stats?.[r.model]?.note} ctx={ctx} />;
    }
    const text = r.on.map((n) => n.stats?.[r.model]?.note).find(Boolean);
    return text ? (
      <Typography sx={{ fontSize: 11, color: "text.secondary", whiteSpace: "normal", maxWidth: 360, mt: 0.25 }}>
        {text}
      </Typography>
    ) : null;
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
                    {note(r)}
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
  const stats = callStats(d.calls);
  // Which models sit on a backend that actually evicts. Everything else cannot
  // thrash by construction.
  const thrashy = useMemo(() => {
    const s = new Set<string>();
    for (const b of self?.backends ?? []) if (b.evicts) for (const m of b.serves ?? []) s.add(m);
    return s.size ? s : null;
  }, [self]);

  return (
    <Box>
      {/* What the window actually cost, before any of the charts. These are the
          numbers a visit is usually for, and every one of them is arithmetic
          over `calls`, which the page already has. */}
      {stats.n > 0 && (
        <Row align="baseline" spacing={2} wrap sx={{ mb: 2, rowGap: 0.5, fontFamily: MONO, fontSize: 11.5 }}>
          <Box component="span" sx={{ color: "text.secondary" }}>
            <Box component="b" sx={{ color: "text.primary" }}>{stats.n}</Box> call{stats.n === 1 ? "" : "s"}
          </Box>
          <Tooltip title="run time once the request had a slot, not counting the queue">
            <Box component="span" sx={{ color: "text.secondary", cursor: "help" }}>
              median <Box component="b" sx={{ color: "text.primary" }}>{since(stats.medianMs ?? 0)}</Box>
              {" · p95 "}<Box component="b" sx={{ color: "text.primary" }}>{since(stats.p95Ms ?? 0)}</Box>
            </Box>
          </Tooltip>
          {stats.maxWaitMs > 0 && (
            <Tooltip title="the longest anything sat in a queue before it started — the scheduler's doing, kept apart from run time because they call for different answers">
              <Box component="span" sx={{ color: "text.secondary", cursor: "help" }}>
                worst wait <Box component="b" sx={{ color: "warning.main" }}>{since(stats.maxWaitMs)}</Box>
              </Box>
            </Tooltip>
          )}
          <Tooltip title={stats.failed
            ? "requests that ended in an error. The lanes below draw them in red at the moment they failed."
            : "every request in the window completed"}>
            <Box component="span" sx={{ cursor: "help", color: stats.failed ? "error.main" : "faint" }}>
              <Dot color={stats.failed ? "error.main" : "success.main"} />
              {stats.failed ? `${stats.failed} failed` : "none failed"}
            </Box>
          </Tooltip>
        </Row>
      )}
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
