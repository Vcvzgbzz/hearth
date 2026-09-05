/**
 * The console.
 *
 * Same page as before, same facts in the same order, rebuilt on MUI. The one
 * structural change is that in-flight and failure state now lives in the
 * component that owns the control instead of in module-level Sets keyed by
 * model name. Those Sets existed for a single reason -- the 3s poll called
 * replaceChildren and built a FRESH button, so a `disabled` flag set on click
 * lasted until the next tick and the control came back live while the POST was
 * still going. That was worked around three separate times (`warming`,
 * `flipping`, `busy`/`failed`). Reconciliation keeps the same element mounted
 * across a poll, so the state simply stays put; the keys on every list below
 * are what makes that true and are not cosmetic.
 */
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import CssBaseline from "@mui/material/CssBaseline";
import Divider from "@mui/material/Divider";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { ThemeProvider } from "@mui/material/styles";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CopyButton, Dot, mono, Pre, Row, Section, Spacer, Tag, Why } from "./bits.js";
import { Depth, HistTable, Lanes } from "./charts.js";
import { Hardware } from "./hardware.js";
import { load, postWrite, since } from "./lib.js";
import { waitReason } from "./why.js";
import { yamlScalar as yq } from "../yamlq.js";
import { makeTheme, MONO } from "./theme.js";
import type { Backend, Net, Node, UiData } from "./types.js";

/* ------------------------------------------------------------------ data */

/**
 * The poll, guarded on both sides.
 *
 * /ui/data calls peers.ensureFresh(), which can exceed the 3s interval exactly
 * when a peer is timing out -- which is exactly when you are watching.
 * Unguarded, requests stack and an older response can land after a newer one
 * and render stale state over fresh.
 *
 * document.hidden stops a forgotten background tab polling a peer-probing
 * endpoint forever. The server already worries about this becoming a load
 * generator; this is the client half of that.
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
    // The FIRST load is forced, deliberately. document.hidden is true more often
    // than you would think -- a background tab, a prerender, an embedded pane --
    // and gating the initial fetch on it left the page permanently blank in
    // those contexts, waiting on a visibilitychange that may never come.
    poll(true);
    const id = setInterval(() => poll(false), 3000);
    // Catch up immediately on return rather than waiting out the interval.
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

/* -------------------------------------------------------------- controls */

interface Ctx {
  /** Whether the write routes are reachable on the socket that served this page. */
  canWarm: boolean;
  /** "open" or "key" -- told to us per socket, never guessed. */
  control: UiData["control"];
  refresh: () => void;
}

/**
 * A small control that posts and reports its own outcome in place.
 *
 * The message goes BESIDE the control, not into it. It used to be assigned to
 * the button's own textContent, which turned a sentence into the label of a
 * bordered box -- a paragraph of red spanning the width of the page, where a
 * word had been.
 */
function WriteButton({
  label, title, path = "/control", body, ctx, after,
}: {
  label: string;
  title: string;
  path?: string;
  body: () => unknown;
  ctx: Ctx;
  /** Overrides the default "refresh on success" -- the warm button reports first. */
  after?: (d: Record<string, unknown>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const click = () => {
    if (busy) return;
    // Clearing on click matters more than it sounds: a failed write changes
    // nothing on the server, so the next poll returns identical state and
    // nothing re-renders. Without this the old message sits under the button
    // through the retry that fixed it.
    setFail(null);
    setNote(null);
    setBusy(true);
    postWrite(path, body(), ctx.control)
      .then((d) => {
        if (after) after(d);
        // Only a SUCCESS refreshes immediately. On failure the redraw would
        // replace the message with unchanged state, and a refused write would
        // look exactly like a click that did nothing.
        else ctx.refresh();
      })
      .catch((e: unknown) => setFail(String((e as Error)?.message ?? e)))
      // finally, not then: a failed write must not leave the control stuck for
      // the rest of the session.
      .finally(() => setBusy(false));
  };

  const btn = (
    <Button
      onClick={click}
      disabled={busy}
      sx={fail ? { color: "error.main", borderColor: "error.main" } : undefined}
    >
      {busy ? "…" : note ?? label}
    </Button>
  );
  return (
    <Row spacing={1} align="baseline" component="span" sx={{ display: "inline-flex" }}>
      {title ? <Tooltip title={title}>{btn}</Tooltip> : btn}
      {fail && (
        <Typography variant="caption" sx={{ color: "error.main", fontFamily: MONO }}>{fail}</Typography>
      )}
    </Row>
  );
}

/**
 * One federation switch.
 *
 * On a read-only surface this shows the state and is simply not clickable. It
 * used to render NOTHING for a direction that was on, which was wrong in the
 * case that matters most -- the healthy one. An operator whose only dashboard
 * is the standalone uiListen port saw nothing before or after the feature
 * shipped, and reasonably read that as "the deploy did not land". Absence of a
 * control is indistinguishable from absence of the feature.
 */
function FedSwitch({ dir, on, ctx }: { dir: "lending" | "borrowing"; on: boolean; ctx: Ctx }) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);

  const label = (
    <Typography component="span" variant="body2"
                sx={{ fontFamily: MONO, color: on ? "text.secondary" : "error.main",
                      fontWeight: on ? 400 : 600 }}>
      {dir}{on ? "" : " PAUSED"}
    </Typography>
  );

  if (!ctx.canWarm) {
    // Saying "you cannot do it here" without saying "do it there" just moves
    // the dead end.
    return (
      <Tooltip title={`read-only here -- this port serves the status page only. Change it on the main listener: POST /control {"${dir}": ${on ? "false" : "true"}}`}>
        <Row spacing={0.5} align="center" component="span">
          <Box component="span" sx={{ fontSize: 8, color: on ? "success.main" : "error.main" }}>●</Box>
          {label}
        </Row>
      </Tooltip>
    );
  }

  const flip = () => {
    if (busy) return;
    setBusy(true);
    setFail(null);
    postWrite("/control", { [dir]: !on }, ctx.control)
      .then(() => ctx.refresh())
      .catch((e: unknown) => setFail(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <Tooltip title={on
      ? `pause ${dir} -- takes effect immediately, and resets to the config on restart`
      : `resume ${dir}`}>
      <Row spacing={0.5} align="center" component="span">
        <Switch checked={on} disabled={busy} onChange={flip} slotProps={{ input: { "aria-label": dir } }} />
        {label}
        {fail && <Typography variant="caption" sx={{ color: "error.main", fontFamily: MONO }}>{fail}</Typography>}
      </Row>
    </Tooltip>
  );
}

/* ---------------------------------------------------------------- models */

/**
 * Whether we are lending this model, and the control to change it.
 *
 * Three facts get flattened into one cell, and keeping them apart is the whole
 * difficulty:
 *
 *   intent     what we mean to lend -- the config list, or the runtime override
 *              on top of it
 *   effective  what is ACTUALLY going out, which is nothing at all while the
 *              master lending switch is paused
 *   drift      whether intent differs from the file, so a change nobody
 *              remembers making is visible rather than mysterious
 *
 * Showing only `effective` would make every row read "held" during a pause and
 * lose the per-model settings you had. Showing only `intent` would claim we are
 * lending things while lending is off. So it renders intent and says when that
 * is not what is happening.
 */
function ShareCell({ model, d, ctx }: { model: string; d: UiData; ctx: Ctx }) {
  // Not ours to lend. A model that only exists on a peer is in this table
  // because it is reachable, not because we serve it.
  if (!d.catalog.includes(model)) {
    return <Typography component="span" variant="caption" sx={{ color: "faint", fontFamily: MONO }}>—</Typography>;
  }
  const ovr = d.controls.models ?? {};
  const inFile = d.configuredShare.includes(model);
  const intent = Object.prototype.hasOwnProperty.call(ovr, model) ? ovr[model]! : inFile;
  const effective = d.share.includes(model);
  const drift = intent !== inFile;
  const label = intent ? "lent" : "held";
  const why = intent
    ? (effective ? "peers may use this model"
                 : "lending is paused, so this is not going out despite being on the list")
    : "peers cannot use this model";
  const next = !intent;

  return (
    <Box component="span" sx={{ whiteSpace: "nowrap" }}>
      {ctx.canWarm ? (
        <WriteButton
          label={label}
          title={`${why} — click to ${next ? "lend" : "hold"}`}
          ctx={ctx}
          // Toggling back to whatever the config says CLEARS the override rather
          // than pinning the same value by hand. Otherwise the pending block
          // would keep reporting a difference after you had put everything back.
          body={() => ({ share: { [model]: next === inFile ? null : next } })}
        />
      ) : (
        <Tooltip title={why}>
          <Typography component="span" variant="caption"
                      sx={{ fontFamily: MONO, color: intent ? "success.main" : "faint" }}>{label}</Typography>
        </Tooltip>
      )}
      {drift && (
        // An override is a fact about the config, not a state of the system, so
        // it is a mark next to the value rather than another colour competing
        // with the palette's three.
        <Tooltip title="not what hearth.yaml says — reverts on restart">
          <Box component="span" sx={{ color: "warning.main", cursor: "help", ml: 0.5 }}>*</Box>
        </Tooltip>
      )}
    </Box>
  );
}

/**
 * Which node serves a model, or null when we serve it ourselves.
 *
 * Our own node wins even if a peer also has it: a model we can load here is not
 * "on" someone else's machine, and labelling it with their name would send the
 * reader looking in the wrong place.
 */
function nodeOf(net: Net, model: string): string | null {
  const self = net.nodes.find((n) => n.self);
  if (self?.serves?.includes(model)) return null;
  const p = net.nodes.find((n) => !n.self
    && ((n.serves ?? []).includes(model) || (n.configured ?? []).includes(model)));
  return p?.name ?? null;
}

/**
 * Where a model actually lives: the local backend and the card it sits on, or
 * the peers that have it.
 *
 * The old column said "Node", which on a single-node install is the same word
 * on every row. The useful answer is one level down — WHICH backend, and which
 * card that backend competes for — because that is what decides whether asking
 * for this model right now costs a queue, a load, or somebody else's eviction.
 */
function Where({ r }: { r: ModelRow }) {
  const peers = r.on.filter((n) => !n.self);
  if (!r.backends.length && !peers.length) {
    return <Box component="span" sx={{ color: "faint" }}>—</Box>;
  }
  return (
    <Row spacing={0.75} align="baseline" wrap component="span" sx={{ display: "inline-flex" }}>
      {/* Every local backend that lists it, not the first one found. Two
          backends serving one id is the normal shape of a big model that also
          has a small copy, and naming one of them sends the reader to the wrong
          card. */}
      {r.backends.map((b) => {
        const hot = (b.loaded ?? []).includes(r.model);
        return (
          <Row key={b.name} spacing={0.75} align="baseline" component="span" sx={{ display: "inline-flex" }}>
            <Box component="span"
                 sx={{ color: hot ? "success.main" : "text.secondary", fontWeight: hot ? 600 : 400 }}>
              {b.name}
            </Box>
            {(b.resources ?? []).map((res) => (
              <Tag key={res} title={`${b.name} runs on ${res}, and waits for any other backend using it`}>
                {res}
              </Tag>
            ))}
          </Row>
        );
      })}
      {r.route && (
        <Tag title={`reached by POST ${r.route.path}, not /v1/chat/completions — hearth forwards the body untouched and queues it as ${r.model}`}>
          {r.route.path}
        </Tag>
      )}
      {peers.map((n) => (
        <Box component="span" key={n.name}
             sx={{ color: (n.loaded ?? []).includes(r.model) ? "success.main" : "text.secondary" }}>
          {n.name}
        </Box>
      ))}
    </Row>
  );
}

interface ModelRow {
  model: string;
  on: Node[];
  warmOn: Node[];
  warm: boolean;
  warmHere: boolean;
  unknown: boolean;
  /** Local backends that list it. Usually one; never assume it. */
  backends: Backend[];
  route?: { path: string; model: string; lane: string; queue: boolean };
}

function Models({ d, ctx }: { d: UiData; ctx: Ctx }) {
  const { net } = d;
  const unknown = net.unknownWarm ?? [];
  const self = net.nodes.find((n) => n.self);
  const backends = self?.backends ?? [];
  // Every node that can serve this model, not just the first one found. At two
  // nodes "the first" was harmless; at seven it hides most of the fleet's
  // redundancy, which is the main thing this page is consulted for. A peer's
  // configured list counts too -- a peer we have mapped but that is down still
  // tells you where a model lives.
  const holders = (m: string) => net.nodes.filter((n) =>
    (n.serves ?? []).includes(m) || (n.configured ?? []).includes(m));

  const rows: ModelRow[] = net.available.map((m) => {
    const on = holders(m);
    const mine = backends.filter((b) => (b.serves ?? []).includes(m));
    return {
      model: m,
      on,
      backends: mine,
      warmOn: on.filter((n) => (n.loaded ?? []).includes(m)),
      warm: net.readyNow.includes(m),
      warmHere: mine.some((b) => (b.loaded ?? []).includes(m)),
      unknown: !net.readyNow.includes(m) && unknown.includes(m),
    };
  });

  // Route models are real work with real ids that queue and appear in the queue
  // table, and they were in NO list on this page: they are not in the catalog,
  // because a client cannot ask for them by model id — it asks by path. So they
  // come from the routes themselves. Unqueued paths (a progress endpoint) are
  // left out: their `model` is a label on something that never waits.
  for (const b of backends) {
    for (const rt of b.routes ?? []) {
      if (!rt.queue || rows.some((r) => r.model === rt.model)) continue;
      rows.push({
        model: rt.model, on: self ? [self] : [], warmOn: [], warm: false,
        warmHere: false, unknown: false, backends: [b], route: rt,
      });
    }
  }

  // Warm first -- it is the perishable fact. Alphabetical within a group so rows
  // do not shuffle between polls for no reason.
  rows.sort((x, y) => Number(y.warm) - Number(x.warm) || x.model.localeCompare(y.model));

  return (
    <Section title="Models" note={
      <Typography component="span" variant="body2" sx={{ color: "faint" }}>
        {rows.filter((r) => r.warm).length} of {rows.length} loaded
      </Typography>
    }>
      <Box sx={{ overflowX: "auto" }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Model</TableCell><TableCell>Where</TableCell><TableCell>State</TableCell>
              <TableCell>Shared</TableCell><TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {!rows.length && (
              <TableRow><TableCell colSpan={5} sx={{ color: "faint", py: 1.75 }}>no models reachable</TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.model}>
                <TableCell sx={mono}>{r.model}</TableCell>
                <TableCell sx={{ ...mono, color: "text.secondary" }}><Where r={r} /></TableCell>
                <TableCell>
                  <Tooltip title={
                    // Warmth is a UNION across nodes, so "warm" can mean "warm
                    // somewhere else". A local request would still pay the load.
                    r.route ? "a path, not a model id — this backend does not report what it holds, so neither can we"
                    : r.unknown ? "this backend does not report what it has loaded"
                    : r.warm && r.warmOn.length && !r.warmOn.some((n) => n.self)
                      ? `loaded on ${r.warmOn.map((n) => n.name).join(", ")}, not here`
                      : ""
                  }>
                    <Typography component="span" variant="caption"
                                sx={{ fontFamily: MONO, color: r.warm ? "success.main" : "text.secondary",
                                      fontWeight: r.warm ? 600 : 400 }}>
                      {/* A WORD, not a pill. Pills everywhere is the look this
                          page was deliberately built away from. */}
                      <Dot color={r.warm ? "success.main" : r.route || r.unknown ? "faint" : "text.secondary"} />
                      {r.warm ? "warm" : r.route || r.unknown ? "unknown" : "cold"}
                    </Typography>
                  </Tooltip>
                </TableCell>
                <TableCell><ShareCell model={r.model} d={d} ctx={ctx} /></TableCell>
                <TableCell align="right">
                  {/* No load button for a route model: /v1/warm takes a model id
                      and this one is only ever reached by path, so the button
                      would resolve it to whichever backend happens to be first. */}
                  {!r.warm && !r.unknown && !r.route && ctx.canWarm && (
                    <LoadButton model={r.model} peer={nodeOf(net, r.model)} ctx={ctx} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Section>
  );
}

/**
 * The load action.
 *
 * It reports its own outcome in place rather than just refreshing, because a
 * decline and an already-warm both return 200 and are worth reading rather than
 * flattening into a silent success.
 */
function LoadButton({ model, peer, ctx }: { model: string; peer: string | null; ctx: Ctx }) {
  const [said, setSaid] = useState<string | null>(null);
  return (
    <>
      <WriteButton
        label="load"
        title={peer
          ? `ask ${peer} to load ${model} — they may decline if busy`
          : `load ${model} here now, evicting whatever is resident`}
        path="/v1/warm"
        ctx={ctx}
        body={() => ({ model })}
        after={(d) => {
          setSaid(d.warmed ? "loaded" : "no change");
          setTimeout(() => { setSaid(null); ctx.refresh(); }, 1200);
        }}
      />
      {said && <Typography component="span" variant="caption" sx={{ ml: 1, color: "faint" }}>{said}</Typography>}
    </>
  );
}

/* ----------------------------------------------------------------- nodes */

/** The old paste-this snippet, for surfaces that cannot write. */
function mapSnippet(n: Node): string {
  // Indented to sit under `models:` inside this peer's entry, which is where it
  // has to go. Same id on both sides is the common case; the left is the name
  // you ask for and the right is theirs.
  const map = (n.unmapped ?? []).map((m) => `        ${yq(m)}: ${yq(m)}`).join("\n");
  const routes = (n.unmapped ?? []).map((m) =>
    `  ${yq(m)}:\n    policy: peer\n    peers: [${yq(n.name)}]\n    fallbackLocal: false`).join("\n");
  return `# in peers[name: ${n.name}], under models:\n${map}\n\n`
    + `# and to actually route to it, under the top-level models:\n${routes}`;
}

/**
 * A peer's model map, and the two edits you can make to it.
 *
 * This replaced a read-only disclosure that printed the YAML you would have to
 * paste. That was the right shape while `peers[].models` was config-only -- it
 * IS the allowlist deciding which of your prompts may leave the machine. What
 * it was not was usable: a peer adds a model, you read the snippet, you ssh to
 * the box, you edit the file, you restart, and by then you have lost interest.
 *
 * So the click is here, and the second thought is kept by other means: the edit
 * is live but temporary, and the pending block hands you the same YAML to make
 * it stick. The snippet survives on the read-only listener, where there is
 * nothing to click and pasting is still the only route.
 */
function MapBlock({ n, ctx }: { n: Node; ctx: Ctx }) {
  const pairs = Object.entries(n.map ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  const unmapped = [...(n.unmapped ?? [])].sort();
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  if (!pairs.length && !unmapped.length) return null;

  const many = unmapped.length > 1;
  return (
    <Box sx={{ flexBasis: "100%", pl: 0.25, mt: 0.5, fontFamily: MONO, fontSize: 11.5 }}>
      <Accordion expanded={open} onChange={(_, v) => setOpen(v)}>
        <AccordionSummary>
          {/* Amber only when there is something unclaimed. A fully mapped peer
              is not a warning, and painting it as one is how a colour stops
              meaning anything. */}
          <Typography variant="caption" sx={{ fontFamily: MONO, cursor: "pointer",
                                              color: unmapped.length ? "warning.main" : "text.secondary" }}>
            {open ? "- " : "+ "}
            {unmapped.length
              ? `${unmapped.length} model${many ? "s" : ""} offered here you cannot reach: ${unmapped.join(", ")}`
              : `${pairs.length} model${pairs.length > 1 ? "s" : ""} mapped to ${n.name}`}
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          {/* width:auto so the columns hug the ids. A full-width table puts the
              arrow halfway across the page from both names it joins. */}
          <Table size="small" sx={{ width: "auto", "& td": { padding: "4px 10px 4px 0" } }}>
            <TableBody>
              {pairs.map(([mine, theirs]) => (
                <TableRow key={mine}>
                  <TableCell sx={mono}>{mine}</TableCell>
                  <TableCell sx={{ color: "faint" }}>→</TableCell>
                  <TableCell sx={mono}>{theirs}</TableCell>
                  <TableCell>
                    {ctx.canWarm && (
                      <WriteButton label="unlink" title={`stop sending ${mine} to ${n.name}`} ctx={ctx}
                                   body={() => ({ unlink: { peer: n.name, mine } })} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {unmapped.map((theirs) => (
                <TableRow key={theirs}>
                  <TableCell>
                    {/* Prefilled with THEIR id, because the ids match in nearly
                        every case and the field exists for the one where they do
                        not. Editable, so a peer's `qwen3-coder-30b` can arrive as
                        your `coder` without needing a second concept for it. */}
                    <TextField
                      value={names[theirs] ?? theirs}
                      onChange={(e) => setNames((s) => ({ ...s, [theirs]: e.target.value }))}
                      slotProps={{ htmlInput: { "aria-label": `local name for ${theirs}`, size: 15 } }}
                    />
                  </TableCell>
                  <TableCell sx={{ color: "faint" }}>→</TableCell>
                  <TableCell sx={mono}>{theirs}</TableCell>
                  <TableCell>
                    {ctx.canWarm && (
                      <WriteButton label="link" title={`route requests for this id to ${n.name}`} ctx={ctx}
                                   body={() => ({ link: { peer: n.name, mine: (names[theirs] ?? theirs).trim() || theirs, theirs } })} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {ctx.canWarm ? (
            <Why>
              Linking maps the id and routes it, which are two halves of one thing: a mapping on
              its own only says a request MAY leave. A model you also serve gets policy fastest
              with a local fallback; one you do not gets policy peer and no fallback, since home
              is a backend that has never heard of it.
            </Why>
          ) : unmapped.length ? (
            <>
              <Pre>{mapSnippet(n)}</Pre>
              <Why>
                fallbackLocal: false because you have no local copy — without it a request falls
                back to a backend that has never heard of this model.
              </Why>
              <CopyButton text={mapSnippet(n)} />
            </>
          ) : null}
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}

/**
 * The peers, and only the peers.
 *
 * Our own node used to be the first row here, with its backends as a one-line
 * strip underneath. That strip is now the Hardware section — a card and the
 * backends inside it — so repeating the node here would be the same facts
 * twice, the second time worse. What is left is the thing this section was
 * always for: other boxes, whether they answer, and what they will let us ask
 * for.
 */
function Nodes({ d, ctx }: { d: UiData; ctx: Ctx }) {
  const peers = d.net.nodes.filter((n) => !n.self);
  if (!peers.length) {
    return (
      <Typography variant="body2" sx={{ color: "faint" }}>
        No peers configured — nothing queued here can leave this box.
      </Typography>
    );
  }
  return (
    <>
      {peers.map((n) => {
        const busy = (n.slots ?? 0) - (n.free ?? 0);
        // The hot flag paints the number amber -- "working", the middle state in
        // the palette's three. Reserved for pressure that is true right now: no
        // free slot, or somebody waiting. Everything idle stays quiet, so a
        // saturated node is findable in a list of seven without reading any of it.
        const num = (label: string, value: React.ReactNode, hot?: boolean) => (
          <Box component="span" key={label}>
            <Box component="b" sx={{ color: hot ? "warning.main" : "text.primary", fontWeight: 600 }}>{value}</Box>
            {` ${label}`}
          </Box>
        );
        return (
          <Row key={n.name} spacing={1.25} align="baseline" wrap
                 sx={{ py: 1.1, borderBottom: 1, borderColor: "divider", "&:last-of-type": { borderBottom: 0 } }}>
            <Typography component="span" sx={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{n.name}</Typography>
            <Typography component="span" variant="caption"
                        sx={{ fontFamily: MONO, color: n.up ? "text.secondary" : "error.main" }}>
              <Dot color={n.up ? "success.main" : "error.main"} />
              {n.up ? "up" : "down"}
            </Typography>
            {n.lastError && (
              <Typography component="span" variant="body2" sx={{ color: "text.secondary" }}>
                {String(n.lastError).slice(0, 80)}
              </Typography>
            )}
            <Spacer />
            <Row spacing={2} sx={{ fontFamily: MONO, fontSize: 12, color: "text.secondary" }}>
              {num("busy", `${busy}/${n.slots ?? "?"}`, n.up && n.free === 0 && (n.slots ?? 0) > 0)}
              {num("queued", n.queued ?? 0, (n.queued ?? 0) > 0)}
              {n.sending ? num("sending", n.sending) : null}
            </Row>
            {/* What we may ask this peer for, and what it offers that we have
                not claimed. */}
            <MapBlock n={n} ctx={ctx} />
          </Row>
        );
      })}
    </>
  );
}

/**
 * Runtime changes that are not in the config file.
 *
 * The counterweight to making all of this clickable. Every edit on this page is
 * live and temporary, which is a fine default and a terrible surprise -- six
 * weeks on, a model is being lent that `share:` does not list and the only
 * explanation is a click nobody remembers. This block is the answer to "why is
 * it doing that", and its copy button is the answer to "make it stop being a
 * surprise".
 */
function Pending({ d, ctx }: { d: UiData; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const ov = d.overrides;
  if (!ov?.dirty) return null;

  // Share drift is computed here rather than sent: the server already says
  // whether ANYTHING is pending, and this only decides whether to count the
  // share list as one of the changes in the summary line.
  const drift = [...d.share].sort().join(",") !== [...d.configuredShare].sort().join(",");
  const n = ov.changes.maps.length + ov.changes.routes.length + (drift ? 1 : 0);
  const toConfig = ov.savesTo === "config";
  // Three states, and which one you are in depends on where a save would go. A
  // config save leaves nothing behind -- the file becomes the record and this
  // block disappears -- so "saved" only ever describes the sidecar.
  const fate = !ov.canSave ? " — these revert on restart"
    : ov.unsaved ? " — not saved, so a restart discards them"
    : " — saved, and kept across a restart";

  return (
    <Box sx={{ mt: 1.75, fontFamily: MONO, fontSize: 11.5 }}>
      {/* The state and its action sit OUTSIDE the disclosure, and the config to
          paste sits inside it. Both were inside at first, which put the one
          button that decides whether your work survives a restart behind a click
          on a line that reads like a status message. */}
      <Row spacing={1.5} align="baseline" wrap>
        <Typography component="span" variant="caption" sx={{ color: "warning.main", fontFamily: MONO }}>
          {n} runtime change{n === 1 ? "" : "s"} not in the config file{fate}
        </Typography>
        {ctx.canWarm && ov.canSave && ov.unsaved && (
          <WriteButton
            label={toConfig ? "save to config" : "save"}
            title={toConfig
              ? `write these into ${ov.savePath ?? "the config file"}, comments and all`
              : `keep these across a restart in ${ov.savePath ?? "the state file"}`}
            ctx={ctx}
            body={() => ({ save: true })}
          />
        )}
      </Row>
      <Accordion expanded={open} onChange={(_, v) => setOpen(v)}>
        <AccordionSummary>
          <Typography variant="caption" sx={{ color: "text.secondary", cursor: "pointer", fontFamily: MONO }}>
            {open ? "- " : "+ "}show the config to paste
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Pre>{ov.yaml}</Pre>
          <Why>
            {toConfig
              ? "Save writes these into the config file itself, comments intact, and this block goes away — the file becomes the record again. The text is here in case you would rather paste it somewhere else."
              : ov.canSave
                ? "Save keeps these on this box. Pasting puts them where the rest of the config lives — each block replaces the one it names."
                : "Paste into hearth.yaml to keep them. Each block replaces the one it names."}
          </Why>
          <CopyButton text={ov.yaml} />
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}

/* ----------------------------------------------------------------- queue */

/** Amber for anything the operator could act on, green for work in progress. */
const TONE = {
  blocked: "warning.main",
  busy: "text.secondary",
  cold: "warning.main",
  lane: "text.secondary",
} as const;

/**
 * What is in flight, and for anything that is not, why not.
 *
 * The old table had a State column that said "queued" — which is the one thing
 * about a queued job you already knew from it being in the queue. A job waits
 * for exactly one of four reasons and they call for different responses: the
 * backend is full (fine, that is the ceiling working), the model has to load
 * (fine, once), another backend is holding the card (this is the interesting
 * one), or it is simply behind others in its lane. Only one of those is a
 * hardware problem, and it was invisible.
 */
function Queue({ d }: { d: UiData }) {
  const now = useNow();
  const rank = { running: 0, queued: 1 };
  const jobs = [...d.q.jobs].sort((a, b) =>
    rank[a.state] - rank[b.state] || a.position - b.position);
  const backends = d.net.nodes.find((n) => n.self)?.backends ?? [];
  const resources = d.net.resources ?? [];
  const waiting = jobs.filter((j) => j.state === "queued").length;

  return (
    <Section title="Queue" note={
      <Typography component="span" variant="body2" sx={{ color: "faint" }}>
        {jobs.length - waiting} running · {waiting} waiting
      </Typography>
    }>
      <Box sx={{ overflowX: "auto" }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Lane</TableCell><TableCell>Model</TableCell><TableCell>Where</TableCell>
              <TableCell>Caller</TableCell><TableCell>Status</TableCell>
              <TableCell align="right">Waited</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {!jobs.length && (
              <TableRow><TableCell colSpan={6} sx={{ color: "faint", py: 1.75 }}>nothing in flight</TableCell></TableRow>
            )}
            {jobs.map((j) => {
              const b = backends.find((x) => x.name === j.backend);
              const wait = j.state === "queued" ? waitReason(j, b, resources) : null;
              return (
                <TableRow key={`${j.model}:${j.caller}:${j.since}`}>
                  <TableCell sx={{ ...mono, color: j.lane === "chat" ? "success.main" : "text.secondary" }}>{j.lane}</TableCell>
                  <TableCell sx={mono}>{j.model}</TableCell>
                  <TableCell sx={{ ...mono, color: "text.secondary" }}>
                    <Row spacing={0.75} align="baseline" wrap component="span" sx={{ display: "inline-flex" }}>
                      <Box component="span">{j.offbox ? j.peer ?? "peer" : j.backend ?? "—"}</Box>
                      {!j.offbox && (b?.resources ?? []).map((res) => <Tag key={res}>{res}</Tag>)}
                    </Row>
                  </TableCell>
                  <TableCell sx={{ ...mono, color: "text.secondary" }}>{j.caller}</TableCell>
                  <TableCell sx={{ ...mono, color: wait ? TONE[wait.tone] : "success.main" }}>
                    {j.offbox ? (
                      <>on a peer</>
                    ) : wait ? (
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
                    ) : (
                      <><Dot color="success.main" />running</>
                    )}
                  </TableCell>
                  <TableCell align="right" sx={mono}>{since(now - j.since)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
    </Section>
  );
}

/* ------------------------------------------------------------------ page */

/**
 * One vital, and whether it is worth looking at.
 *
 * `hot` paints the number amber — "working", the middle state in the palette's
 * three. Everything quiet stays quiet, so the one number that has changed is
 * findable without reading the row.
 */
function Vital({ n, label, hot, title }: {
  n: React.ReactNode; label: string; hot?: boolean; title: string;
}) {
  return (
    <Tooltip title={title}>
      <Box component="span" sx={{ cursor: "help" }}>
        <Box component="b" sx={{ color: hot ? "warning.main" : "text.primary", fontWeight: 600 }}>{n}</Box>
        {` ${label}`}
      </Box>
    </Tooltip>
  );
}

function Console({ d, ctx, dead }: { d: UiData | null; ctx: Ctx; dead: boolean }) {
  const self = d?.net.nodes.find((n) => n.self);
  const cap = d?.q.capacity;
  const queuedTotal = cap ? Object.values(cap.queued).reduce((a, b) => a + b, 0) : 0;
  const jobs = d?.q.jobs ?? [];
  const running = jobs.filter((j) => j.state === "running" && !j.offbox).length;
  const resources = d?.net.resources ?? [];
  const cardsBusy = resources.filter((r) => r.holder).length;
  const peers = (d?.net.nodes ?? []).filter((n) => !n.self);

  // Which models sit on a backend that actually evicts. Everything else cannot
  // thrash by construction, so it is drawn as context rather than signal.
  const thrashy = useMemo(() => {
    const s = new Set<string>();
    for (const b of self?.backends ?? []) if (b.evicts) for (const m of b.serves ?? []) s.add(m);
    return s.size ? s : null;
  }, [self]);

  return (
    <Container maxWidth={false} sx={{ maxWidth: 940, py: 3.5, pb: 8 }}>
      {/* The vitals, on one line. This was four KPI tiles, each with a big
          number and a sentence underneath explaining it -- which is a lot of
          page for four numbers, and the sentences said things the numbers
          already said.

          What is NOT here any more is `free/slots`. It summed the free slots of
          every backend, including backends that share a card and can never be
          free at the same time: a node whose two llama-swaps declare `gpu1`
          reported 32 free slots for 16 that exist. Summing across an exclusion
          set is exactly the error per-backend `free` used to make, one level up,
          and there is no honest single number to replace it with — so the
          headline counts work and cards, and slots live on the backend rows
          where they mean something. */}
      <Row spacing={1.5} align="baseline" wrap
             sx={{ pb: 1.25, borderBottom: 1, borderColor: "line" }}>
        <Typography component="span" sx={{ fontSize: 15, fontWeight: 650, letterSpacing: "-.01em" }}>
          hea<Box component="span" sx={{ color: "success.main" }}>r</Box>th
        </Typography>
        <Typography component="span" sx={{ color: "text.secondary" }}>
          node <Box component="b" sx={{ color: "text.primary", fontFamily: MONO, fontSize: 13 }}>
            {dead ? "unreachable" : self?.name ?? "—"}
          </Box>
        </Typography>
        {d && <Spacer />}
        {d && (
          <Row spacing={2.25} align="baseline" wrap
                 sx={{ fontFamily: MONO, fontSize: 12.5, color: "text.secondary" }}>
            {resources.length > 0 && (
              <Vital n={`${cardsBusy}/${resources.length}`} label="cards busy" hot={cardsBusy > 0}
                     title="hardware with a backend running on it right now. Everything else declared on that card is waiting." />
            )}
            <Vital n={running} label="running" hot={running > 0}
                   title="jobs in flight on this box" />
            <Vital n={queuedTotal} label="queued" hot={queuedTotal > 0}
                   title="jobs admitted to a queue and not started. The Queue table says why each one waits." />
            {cap?.offbox ? (
              <Vital n={cap.offbox} label="off-box" title="our jobs currently running on a peer" />
            ) : null}
            <Vital n={d.net.readyNow.length} label="warm"
                   title="models loaded somewhere reachable — here or on a peer" />
            {peers.length > 0 && (
              <Vital n={`${peers.filter((n) => n.up).length}/${peers.length}`} label="peers"
                     hot={peers.some((n) => !n.up)} title="peers answering their /peer/state probe" />
            )}
            <Box component="span" sx={{ color: "faint" }}>
              <Dot color="success.main" />live
            </Box>
          </Row>
        )}
      </Row>

      {!d ? (
        <Typography sx={{ color: "faint", mt: 4 }}>{dead ? "no answer from /ui/data" : "loading…"}</Typography>
      ) : (
        <>
          {/* Hardware first, deliberately. It is the thing that decides whether
              anything below it can run, and every other section on the page is
              a consequence of it. */}
          <Hardware d={d} />

          <Queue d={d} />

          <Models d={d} ctx={ctx} />

          <Section title="Peers" right={
            // Rendered in the heading so a paused node says so at the top rather
            // than leaving you to infer it from an empty list further down.
            <Row spacing={2} align="center">
              <FedSwitch dir="lending" on={d.controls.lending !== false} ctx={ctx} />
              <FedSwitch dir="borrowing" on={d.controls.borrowing !== false} ctx={ctx} />
            </Row>
          }>
            <Nodes d={d} ctx={ctx} />
            <Pending d={d} ctx={ctx} />
          </Section>

          <Section title="Last 10 minutes">
            <Box sx={{ mb: 2.75 }}>
              <Typography variant="body2" sx={{ mb: 0.75 }}>Jobs waiting for the local backend</Typography>
              <Depth hist={d.hist} />
            </Box>
            <Box sx={{ mb: 2.75 }}>
              <Row align="baseline" spacing={1.25} sx={{ mb: 0.75 }}>
                <Typography variant="body2">Which model was loaded</Typography>
                <Spacer />
                <Typography variant="caption" sx={{ color: "faint", fontFamily: MONO }}>
                  {/* Only say "thrash" where something actually evicts. An ollama
                      backend keeps its models resident under keep_alive. */}
                  {d.net.evicts === false
                    ? "these backends hold models resident"
                    : "each change of row is a cold load"}
                </Typography>
              </Row>
              <Lanes hist={d.hist} thrashy={thrashy} />
            </Box>
            <NumbersTable d={d} />
          </Section>
        </>
      )}

      <Divider sx={{ mt: 5.5, borderColor: "line" }} />
      <Typography variant="body2" sx={{ pt: 1.75, color: "faint" }}>
        Polls <Box component="code" sx={{ fontFamily: MONO, fontSize: 11.5 }}>/ui/data</Box> every 3s.
        Cards come from each backend&rsquo;s <Box component="code" sx={{ fontFamily: MONO, fontSize: 11.5 }}>resources:</Box>{" "}
        — a backend that declares none competes for nothing and appears under &ldquo;unpinned&rdquo;.
        Forward the port over SSH rather than widening the bind.
      </Typography>
    </Container>
  );
}

function NumbersTable({ d }: { d: UiData }) {
  const [open, setOpen] = useState(false);
  return (
    <Accordion expanded={open} onChange={(_, v) => setOpen(v)}>
      <AccordionSummary>
        <Typography variant="body2" sx={{ color: "faint", cursor: "pointer" }}>
          {open ? "− " : "+ "}Show the numbers
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Box sx={{ overflowX: "auto" }}><HistTable hist={d.hist} /></Box>
      </AccordionDetails>
    </Accordion>
  );
}

export default function App() {
  const { data, dead, refresh } = useData();
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useMemo(() => makeTheme(dark ? "dark" : "light"), [dark]);
  const ctx: Ctx = {
    canWarm: data?.canWarm === true,
    control: data?.control === "key" ? "key" : "open",
    refresh,
  };
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Console d={data} ctx={ctx} dead={dead} />
    </ThemeProvider>
  );
}
