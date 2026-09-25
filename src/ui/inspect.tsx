/**
 * The inspector: the selected node and every action on it, in one place. Each write shows it
 * is in flight, shows a refusal on its own control, and says so on a read-only surface.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { CopyButton, Legend, Pre, Row, Vitals, Why } from "./bits.js";
import { Graph, type Sel } from "./graph.js";
import { backendIcon, resourceIcon, TypeIcon, type IconKind } from "./icons.js";
import { clock, ctxLabel, displayId, postWrite, since } from "./lib.js";
import { capabilityChips } from "./takes.js";
import { MONO } from "./theme.js";
import { blockers } from "./why.js";
import { yamlScalar as yq } from "../yamlq.js";
import type { Backend, Node, Routing, UiData } from "./types.js";

export interface Ctx {
  /** Whether the write routes are reachable on the socket that served this page. */
  canWarm: boolean;
  /** "open" or "key" — told to us per socket, never guessed. */
  control: UiData["control"];
  refresh: () => void;
}

/* -------------------------------------------------------------- fittings */

/** The rail's value column: clears the widest label ("in flight") and the 26px mark. */
const GUTTER = 64;

/** A label above a value, the unit this panel is built from. */
export function Fact({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string;
}) {
  const body = (
    <Box sx={{ display: "flex", alignItems: "baseline", py: 0.55 }}>
      <Typography component="div" sx={{
        fontSize: 10.5, color: "faint", flex: `0 0 ${GUTTER}px`,
        ...(hint ? { cursor: "help" } : {}),
      }}>{label}</Typography>
      <Box sx={{ fontFamily: MONO, fontSize: 11.5, minWidth: 0, flex: 1 }}>{children}</Box>
    </Box>
  );
  return hint ? <Tooltip title={hint}><Box>{body}</Box></Tooltip> : body;
}

/** A labelled block for list-shaped facts. Not `Section`, the dashboard card in bits.tsx. */
export function FieldGroup({ label, count, note, children }: {
  label: string;
  /** A number, not a sentence — it sits on the heading's own baseline. */
  count?: React.ReactNode;
  /** The sentence, on its own line where it cannot fight the heading. */
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ mt: 2 }}>
      <Box sx={{
        display: "flex", alignItems: "baseline", gap: 1, pb: 0.4,
        borderBottom: "1px solid", borderColor: "divider",
      }}>
        <Typography sx={{
          fontSize: 9.5, fontWeight: 600, letterSpacing: ".07em",
          textTransform: "uppercase", color: "text.secondary",
        }}>{label}</Typography>
        {count !== undefined && (
          <Typography sx={{ fontFamily: MONO, fontSize: 10, color: "faint" }}>{count}</Typography>
        )}
      </Box>
      {note && (
        <Typography sx={{ fontSize: 10, color: "faint", mt: 0.5 }}>{note}</Typography>
      )}
      <Box sx={{ mt: 0.5 }}>{children}</Box>
    </Box>
  );
}

/** The panel header, with the same mark and colour the graph draws for the node. */
export function PanelHead({ icon, tone, name, status, onBack }: {
  icon: IconKind;
  tone: "live" | "work" | "fault" | "idle";
  name: string;
  status: React.ReactNode;
  onBack?: () => void;
}) {
  const colour = tone === "live" ? "success.main" : tone === "work" ? "warning.main"
    : tone === "fault" ? "error.main" : "faint";
  return (
    <Box sx={{ mb: 1.5 }}>
      {onBack && (
        <Box
          role="button" tabIndex={0} onClick={onBack}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onBack(); } }}
          sx={{
            display: "inline-block", mb: 1.25, cursor: "pointer", fontSize: 10.5,
            color: "faint", "&:hover": { color: "text.secondary" },
          }}
        >← everything</Box>
      )}
      <Box sx={{ display: "flex", alignItems: "center" }}>
        <Box sx={{ color: colour, display: "flex", flex: `0 0 ${GUTTER}px` }}>
          <TypeIcon kind={icon} size={28} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography component="h2" sx={{
            fontFamily: MONO, fontSize: 13.5, fontWeight: 600, m: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{name}</Typography>
          <Typography sx={{ fontSize: 11, color: colour, mt: 0.2 }}>{status}</Typography>
        </Box>
      </Box>
    </Box>
  );
}

/** A heading inside the panel. Not the graph's `Head`, which is a node's name line. */
const PanelTitle = ({ children }: { children: React.ReactNode }) => (
  <Typography component="h2" sx={{
    fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase",
    color: "text.secondary", pb: 0.75, mb: 1.5, borderBottom: "1px solid", borderColor: "line",
  }}>{children}</Typography>
);

/** A write whose outcome is shown beside the control, never in its label. */
export function Action({ label, title, path = "/control", body, ctx, tone = "normal", look = "command", on, after, full }: {
  label: string;
  title: string;
  path?: string;
  body: () => unknown;
  ctx: Ctx;
  tone?: "normal" | "primary";
  /** `pill` for a toggle with a readable state, `command` for a fire-once action. */
  look?: "command" | "pill" | "quiet";
  /** For `pill`: whether the state it shows is on. */
  on?: boolean;
  /** Overrides the default refresh-on-success — used where the reply is worth reading. */
  after?: (d: Record<string, unknown>) => void;
  full?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);

  const click = () => {
    if (busy) return;
    // Cleared on click: a refused write changes nothing, so no poll would clear it.
    setFail(null);
    setBusy(true);
    postWrite(path, body(), ctx.control)
      .then((d) => { if (after) after(d); else ctx.refresh(); })
      .catch((e: unknown) => setFail(String((e as Error)?.message ?? e)))
      // finally, not then — a failed write must not leave the control disabled
      // for the rest of the session.
      .finally(() => setBusy(false));
  };

  return (
    <Box sx={{ display: full ? "block" : "inline-block" }}>
      <Tooltip title={title}>
        <Box component="span">
          <Button onClick={click} disabled={busy} fullWidth={full}
                  sx={[
                    { transition: "color 160ms, border-color 160ms, background-color 160ms" },
                    look === "pill" && {
                      borderRadius: 10, px: 1.1, minWidth: 52,
                      color: on ? "success.main" : "faint",
                      borderColor: on ? "success.main" : "line",
                      bgcolor: on ? "rgba(141,181,128,.12)" : "transparent",
                      "&:hover": { borderColor: on ? "success.main" : "text.secondary" },
                    },
                    look === "quiet" && {
                      border: "none", px: 0.5, color: "faint",
                      "&:hover": { border: "none", color: "success.main", background: "none" },
                    },
                    tone === "primary" && { color: "success.main", borderColor: "success.main" },
                    !!fail && { color: "error.main", borderColor: "error.main" },
                  ]}>
            {busy ? "…" : label}
          </Button>
        </Box>
      </Tooltip>
      {fail && (
        <Typography sx={{ mt: 0.5, fontFamily: MONO, fontSize: 10.5, color: "error.main" }}>{fail}</Typography>
      )}
    </Box>
  );
}

/** A switch that still shows its state on a read-only surface, where it cannot be flipped. */
export function Toggle({ label, on, hint, offHint, ctx, body }: {
  label: string;
  on: boolean;
  hint: string;
  offHint: string;
  ctx: Ctx;
  body: (next: boolean) => unknown;
}) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);

  const flip = () => {
    if (busy) return;
    setBusy(true);
    setFail(null);
    postWrite("/control", body(!on), ctx.control)
      .then(() => ctx.refresh())
      .catch((e: unknown) => setFail(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false));
  };

  const text = (
    <Box sx={{ minWidth: 0 }}>
      <Typography component="div" sx={{
        fontFamily: MONO, fontSize: 12, color: on ? "text.primary" : "warning.main",
        fontWeight: on ? 400 : 600,
      }}>{label}{on ? "" : " · paused"}</Typography>
      <Typography component="div" sx={{ fontSize: 10.5, color: "faint", mt: 0.25 }}>
        {on ? hint : offHint}
      </Typography>
    </Box>
  );

  if (!ctx.canWarm) {
    return (
      <Tooltip title={`read-only here — this port serves the status page only. Change it on the main listener: POST /control {"${label}": ${!on}}`}>
        <Row spacing={1} align="center" sx={{ mb: 1.25 }}>
          <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: "50%", ml: 0.5, mr: 1.5,
                                 bgcolor: on ? "success.main" : "warning.main" }} />
          {text}
        </Row>
      </Tooltip>
    );
  }

  return (
    <Box sx={{ mb: 1.25 }}>
      <Row spacing={1} align="center">
        <Switch checked={on} disabled={busy} onChange={flip}
                slotProps={{ input: { "aria-label": label } }} />
        {text}
      </Row>
      {fail && <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: "error.main", ml: 5 }}>{fail}</Typography>}
    </Box>
  );
}

/* ---------------------------------------------------------------- models */

/**
 * Whether we lend a model: intent (config plus override), effective (nothing while lending
 * is paused), and drift (intent differs from the file) shown together.
 */
export function ShareToggle({ model, d, ctx }: { model: string; d: UiData; ctx: Ctx }) {
  if (!d.catalog.includes(model)) {
    return <Typography component="span" sx={{ fontFamily: MONO, fontSize: 11, color: "faint" }}>—</Typography>;
  }
  const ovr = d.controls.models ?? {};
  const inFile = d.configuredShare.includes(model);
  const intent = Object.prototype.hasOwnProperty.call(ovr, model) ? ovr[model]! : inFile;
  const effective = d.share.includes(model);
  const drift = intent !== inFile;
  const why = intent
    ? (effective ? "peers may use this model"
                 : "lending is paused, so this is not going out despite being on the list")
    : "peers cannot use this model";

  return (
    <Row spacing={0.5} align="center" component="span" sx={{ display: "inline-flex" }}>
      {ctx.canWarm ? (
        <Action
          look="pill" on={intent}
          label={intent ? "lent" : "held"}
          title={`${why} — click to ${intent ? "hold" : "lend"}`}
          ctx={ctx}
          // Toggling back to what the config says CLEARS the override rather
          // than pinning the same value by hand, or the pending block keeps
          // reporting a difference after you put everything back.
          body={() => ({ share: { [model]: !intent === inFile ? null : !intent } })}
        />
      ) : (
        <Tooltip title={why}>
          <Typography component="span" sx={{
            fontFamily: MONO, fontSize: 11, color: intent ? "success.main" : "faint",
          }}>{intent ? "lent" : "held"}</Typography>
        </Tooltip>
      )}
      {drift && (
        <Tooltip title="not what hearth.yaml says — reverts on restart">
          <Box component="span" sx={{ color: "warning.main", cursor: "help" }}>*</Box>
        </Tooltip>
      )}
    </Row>
  );
}

/** A model's note: what peers read beside it. Click to edit; Save in the rail keeps it. */
export function NoteEdit({ model, note, ctx }: { model: string; note: string | undefined; ctx: Ctx }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const text = { fontSize: 11, whiteSpace: "normal", maxWidth: 360, mt: 0.25 } as const;

  if (draft === null) {
    if (!ctx.canWarm) return note ? <Typography sx={{ ...text, color: "text.secondary" }}>{note}</Typography> : null;
    return (
      <Tooltip title="what peers see beside this model — click to edit">
        <Typography onClick={() => setDraft(note ?? "")}
                    sx={{ ...text, cursor: "text", color: note ? "text.secondary" : "faint",
                          "&:hover": { color: "text.primary" } }}>
          {note ?? "+ note"}
        </Typography>
      </Tooltip>
    );
  }
  const send = () => {
    setBusy(true);
    setFail(null);
    postWrite("/control", { notes: { [model]: draft.trim() === "" ? null : draft } }, ctx.control)
      .then(() => { setDraft(null); ctx.refresh(); })
      .catch((e: unknown) => setFail(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false));
  };
  return (
    <Box sx={{ mt: 0.5, maxWidth: 360 }}>
      <TextField size="small" multiline minRows={2} fullWidth autoFocus value={draft} disabled={busy}
                 placeholder="what it is for, how to call it"
                 onChange={(e) => setDraft(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === "Escape") setDraft(null);
                   if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
                 }}
                 slotProps={{ htmlInput: { maxLength: 500, "aria-label": `note for ${model}` } }} />
      <Row spacing={0.5} align="center" sx={{ mt: 0.5 }}>
        <Button size="small" onClick={send} disabled={busy}>set</Button>
        <Button size="small" onClick={() => setDraft(null)} disabled={busy}>cancel</Button>
        <Typography sx={{ fontSize: 10, color: fail ? "error.main" : "faint" }}>
          {fail ?? `${draft.length}/500`}
        </Typography>
      </Row>
    </Box>
  );
}

/** Load a model, reporting a decline or already-warm in place rather than as silent success. */
export function LoadAction({ model, peer, ctx }: { model: string; peer: string | null; ctx: Ctx }) {
  const [said, setSaid] = useState<string | null>(null);
  if (said) {
    return <Typography component="span" sx={{ fontFamily: MONO, fontSize: 10.5, color: "faint" }}>{said}</Typography>;
  }
  return (
    <Action look="quiet" label="load" ctx={ctx} path="/v1/warm" body={() => ({ model })}
            title={peer ? `ask ${peer} to load ${model} — they may decline if busy`
                        : `load ${model} here now, evicting whatever is resident`}
            after={(r) => {
              setSaid(r.warmed ? "loaded" : "no change");
              setTimeout(() => { setSaid(null); ctx.refresh(); }, 1400);
            }} />
  );
}

/** One model line: name, warmth, lend state, load. Used in every panel that lists models. */
export function ModelLine({ model, d, ctx, warm, where, peer }: {
  model: string; d: UiData; ctx: Ctx; warm: boolean; where?: string; peer?: string | null;
}) {
  const lendable = d.catalog.includes(model);
  return (
    <Box sx={{
      display: "flex", alignItems: "center", py: 0.65,
      borderBottom: "1px solid", borderColor: "divider",
      "&:last-of-type": { borderBottom: "none" },
    }}>
      {/* An empty gutter, so the name starts on the same line as every value
          and the panel title.
          There was a warmth dot in here. It said the same thing as the right
          column — which already reads "warm" or offers "load" — and once the
          grid put it 64px from the name it described, it had lost the one thing
          that made it legible. */}
      <Box aria-hidden sx={{ flex: `0 0 ${GUTTER}px` }} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography component="div" sx={{
          fontFamily: MONO, fontSize: 11.5, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: warm ? "text.primary" : "text.secondary",
        }}>{model}</Typography>
        {/* Truncates like the name above it. A subtitle that wraps pushes into
            the warm/load column beside it, and the row it collides with is
            whichever model happens to have the most to say about itself. */}
        {where && <Typography component="div" sx={{
          fontFamily: MONO, fontSize: 10, color: "faint",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{where}</Typography>}
      </Box>
      {/* One row shape, always. The load button used to vanish on a warm model,
          so the only warm row in a list of seven was also the only one whose
          buttons did not line up. Warm models say so instead. */}
      <Typography sx={{ fontSize: 10, color: "faint", flexShrink: 0 }}>
        {warm ? "warm" : ctx.canWarm ? <LoadAction model={model} peer={peer ?? null} ctx={ctx} /> : "cold"}
      </Typography>
      {lendable && <ShareToggle model={model} d={d} ctx={ctx} />}
    </Box>
  );
}

/* ----------------------------------------------------------------- peers */

/** The old paste-this snippet, kept for surfaces that cannot write. */
function mapSnippet(n: Node): string {
  const map = (n.unmapped ?? []).map((m) => `        ${yq(m)}: ${yq(m)}`).join("\n");
  const routes = (n.unmapped ?? []).map((m) =>
    `  ${yq(m)}:\n    policy: peer\n    peers: [${yq(n.name)}]\n    fallbackLocal: false`).join("\n");
  return `# in peers[name: ${n.name}], under models:\n${map}\n\n`
    + `# and to actually route to it, under the top-level models:\n${routes}`;
}

/** How an id routes, stating both `policy` and `fallbackLocal`; a mapping only says it MAY leave. */
const POLICY_HINT: Record<Routing["policy"], string> = {
  local: "served here. The mapping exists but nothing routes over it.",
  peer: "always sent to a peer.",
  spillover: "served here until the local queue backs up, then sent to a peer.",
  fastest: "whichever of here and the peer can start it sooner.",
};

function RouteLine({ r, peer }: { r: Routing | undefined; peer: string }) {
  if (!r) return null;
  const named = r.peers.length ? r.peers.includes(peer) : true;
  const fallback = r.policy === "local" ? null
    : r.fallbackLocal ? "falls back here" : "no local fallback";
  return (
    <Tooltip title={`${POLICY_HINT[r.policy]}${
      r.policy === "spillover" ? ` The threshold is ${r.spilloverAt} queued.` : ""
    }${
      r.policy === "local" ? ""
        : r.fallbackLocal
          ? " If no peer can take it, it runs on the local backend."
          : " If no peer can take it, the request is refused rather than run here."
    }${named ? "" : ` This mapping is not in the model's peer list, so ${peer} is not a candidate for it.`}`}>
      <Box component="span" sx={{
        fontSize: 10, color: named ? "faint" : "warning.main", cursor: "help", whiteSpace: "nowrap",
      }}>
        {r.policy}{fallback ? ` · ${fallback}` : ""}{named ? "" : " · not listed"}
      </Box>
    </Tooltip>
  );
}

/** A peer's model map, the allowlist for what leaves this machine. Edits are live until restart. */
function MapEditor({ n, d, ctx }: { n: Node; d: UiData; ctx: Ctx }) {
  const pairs = Object.entries(n.map ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  const unmapped = [...(n.unmapped ?? [])].sort();
  const [names, setNames] = useState<Record<string, string>>({});
  const routing = d.routing ?? {};
  // The default the server would pick, restated here so the control opens on
  // the same answer the button would have given, rather than on a blank that
  // silently means something.
  const defaultPolicy = (mine: string): Routing["policy"] =>
    d.catalog.includes(mine) ? "fastest" : "peer";
  const [policies, setPolicies] = useState<Record<string, Routing["policy"]>>({});

  return (
    <>
      <FieldGroup label="linked" count={pairs.length}>
        {!pairs.length && <Box sx={{ color: "faint" }}>nothing linked — nothing can leave this box for {n.name}</Box>}
        {pairs.map(([mine, theirs]) => (
          <Row key={mine} spacing={1} align="center" sx={{ py: 0.5 }}>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Box sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {mine}{mine !== theirs && <Box component="span" sx={{ color: "faint" }}> → {theirs}</Box>}
              </Box>
              <RouteLine r={routing[mine]} peer={n.name} />
            </Box>
            {ctx.canWarm && (
              <Action label="unlink" title={`stop sending ${mine} to ${n.name}`} ctx={ctx}
                      body={() => ({ unlink: { peer: n.name, mine } })} />
            )}
          </Row>
        ))}
      </FieldGroup>

      {unmapped.length > 0 && (
        <FieldGroup label="offered" count={unmapped.length}
                 note="this peer lends these and you have not mapped, so nothing can route to them">
          {unmapped.map((theirs) => (
            <Row key={theirs} spacing={1} align="center" sx={{ py: 0.5 }}>
              {ctx.canWarm ? (
                <>
                  {/* Prefilled with THEIR id, because the ids match in nearly
                      every case and the field exists for the one where they do
                      not — a peer's `qwen3-coder-30b` arriving as your `coder`. */}
                  <TextField
                    value={names[theirs] ?? theirs}
                    onChange={(e) => setNames((s) => ({ ...s, [theirs]: e.target.value }))}
                    slotProps={{ htmlInput: { "aria-label": `local name for ${theirs}` } }}
                    sx={{ flex: 1, minWidth: 0 }}
                  />
                  {/* The policy is chosen HERE rather than accepted and then
                      corrected in the config file, because it is the decision
                      the link is actually making: whether your prompts leave
                      this box, and what happens when the peer cannot take
                      them. It opens on the same default the server would pick. */}
                  <TextField
                    select
                    value={policies[theirs] ?? defaultPolicy((names[theirs] ?? theirs).trim() || theirs)}
                    onChange={(e) => setPolicies((s) => ({ ...s, [theirs]: e.target.value as Routing["policy"] }))}
                    slotProps={{ htmlInput: { "aria-label": `routing policy for ${theirs}` } }}
                    sx={{ minWidth: 96 }}
                  >
                    {(["fastest", "peer", "spillover", "local"] as const).map((v) => (
                      <MenuItem key={v} value={v} sx={{ fontFamily: MONO, fontSize: 11 }}>
                        {v}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Action label="link" ctx={ctx}
                          title={`route requests for this id to ${n.name} — ${
                            POLICY_HINT[policies[theirs]
                              ?? defaultPolicy((names[theirs] ?? theirs).trim() || theirs)]}`}
                          body={() => {
                            const mine = (names[theirs] ?? theirs).trim() || theirs;
                            return { link: {
                              peer: n.name, mine, theirs,
                              policy: policies[theirs] ?? defaultPolicy(mine),
                            } };
                          }} />
                </>
              ) : (
                <Box sx={{ color: "warning.main" }}>{theirs}</Box>
              )}
            </Row>
          ))}
          {ctx.canWarm ? (
            <Why>
              Linking maps the id and routes it, which are two halves of one thing: a mapping on
              its own only says a request MAY leave. The policy beside each one says whether it
              will. A model you also serve defaults to fastest with a local fallback; one you do
              not defaults to peer and no fallback, since home is a backend that has never heard
              of it.
            </Why>
          ) : (
            <>
              <Pre>{mapSnippet(n)}</Pre>
              <CopyButton text={mapSnippet(n)} />
            </>
          )}
        </FieldGroup>
      )}
    </>
  );
}

/* --------------------------------------------------------------- pending */

/** Runtime changes not in the config file, with the YAML to make them stick. */
function Pending({ d, ctx }: { d: UiData; ctx: Ctx }) {
  const [show, setShow] = useState(false);
  const ov = d.overrides;
  if (!ov?.dirty) return null;

  const drift = [...d.share].sort().join(",") !== [...d.configuredShare].sort().join(",");
  const n = ov.changes.maps.length + ov.changes.routes.length + (ov.changes.notes?.length ?? 0) + (drift ? 1 : 0);
  const toConfig = ov.savesTo === "config";
  const fate = !ov.canSave ? "these revert on restart"
    : ov.unsaved ? "not saved, so a restart discards them"
    : "saved, and kept across a restart";

  return (
    <Box sx={{
      mt: 2, p: 1.5, borderRadius: 2, border: "1px solid", borderColor: "warning.main",
      bgcolor: "background.default",
    }}>
      <Typography sx={{ fontFamily: MONO, fontSize: 11, color: "warning.main", mb: 1 }}>
        {n} runtime change{n === 1 ? "" : "s"} not in the config file — {fate}
      </Typography>
      {ctx.canWarm && ov.canSave && ov.unsaved && (
        <Action full tone="primary"
                label={toConfig ? "save to config" : "save"}
                title={toConfig
                  ? `write these into ${ov.savePath ?? "the config file"}, comments and all`
                  : `keep these across a restart in ${ov.savePath ?? "the state file"}`}
                ctx={ctx} body={() => ({ save: true })} />
      )}
      <Button onClick={() => setShow((s) => !s)} sx={{ mt: 1 }}>
        {show ? "hide" : "show"} the config
      </Button>
      {show && (
        <>
          <Pre>{ov.yaml}</Pre>
          <Why>
            {toConfig
              ? "Save writes these into the config file itself, comments intact, and this block goes away — the file becomes the record again."
              : ov.canSave
                ? "Save keeps these on this box. Pasting puts them where the rest of the config lives — each block replaces the one it names."
                : "Paste into hearth.yaml to keep them. Each block replaces the one it names."}
          </Why>
          <CopyButton text={ov.yaml} />
        </>
      )}
    </Box>
  );
}

/* --------------------------------------------------------------- panels */

export function SelfPanel({ d, ctx }: { d: UiData; ctx: Ctx }) {
  const cap = d.q.capacity;
  const queued = Object.values(cap.queued).reduce((a, b) => a + b, 0);
  const running = d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length;
  return (
    <>
      <Fact label="in flight">{running} running · {queued} queued
        {cap.offbox ? <Box component="span" sx={{ color: "warning.main" }}> · {cap.offbox} off-box</Box> : null}
      </Fact>
      <Fact label="lending">{d.share.length} of {d.catalog.length} models</Fact>

      <FieldGroup label="federation">
        <Toggle label="lending" on={d.controls.lending !== false} ctx={ctx}
                hint="peers may use the models you lend"
                offHint="peers see a healthy node offering nothing"
                body={(next) => ({ lending: next })} />
        <Toggle label="borrowing" on={d.controls.borrowing !== false} ctx={ctx}
                hint="your work may route to a peer"
                offHint="peers are not routing candidates — fallbackLocal:false models refuse"
                body={(next) => ({ borrowing: next })} />
        <Typography sx={{ fontSize: 10.5, color: "faint", mt: 0.5 }}>
          Takes effect immediately, and resets to the config on restart.
        </Typography>
      </FieldGroup>

      <FieldGroup label="models" count={`${d.share.length} lent`}>
        {!d.catalog.length && <Typography sx={{ fontSize: 11, color: "faint" }}>nothing to lend</Typography>}
        {d.catalog.map((m) => (
          <ModelLine key={m} model={m} d={d} ctx={ctx}
                     warm={d.net.readyNow.includes(m)} peer={null} />
        ))}
      </FieldGroup>
      <Pending d={d} ctx={ctx} />
    </>
  );
}

export function PeerPanel({ n, d, ctx }: { n: Node; d: UiData; ctx: Ctx }) {
  const busy = (n.slots ?? 0) - (n.free ?? 0);
  const loaded = n.loaded ?? [];
  return (
    <>
      <Fact label="capacity">{n.up ? `${busy}/${n.slots ?? "?"} busy · ${n.queued ?? 0} queued` : "not answering"}</Fact>
      {n.sending ? <Fact label="ours there">{n.sending} running</Fact> : null}
      {n.lastError && (
        <Fact label="last error">
          <Box sx={{ color: "error.main", overflowWrap: "anywhere" }}>{n.lastError}</Box>
        </Fact>
      )}
      {d.controls.borrowing === false && (
        <Typography sx={{ fontSize: 10.5, color: "warning.main", mt: 1 }}>
          Borrowing is paused, so nothing routes here regardless of what is linked.
        </Typography>
      )}
      <MapEditor n={n} d={d} ctx={ctx} />
      {loaded.length > 0 && (
        <FieldGroup label="warm there" count={loaded.length}>
          {loaded.map((m) => (
            <Typography key={m} sx={{ fontFamily: MONO, fontSize: 11.5, color: "success.main", py: 0.3, pl: `${GUTTER}px` }}>{m}</Typography>
          ))}
        </FieldGroup>
      )}
    </>
  );
}

export function BackendPanel({ b, d, ctx }: { b: Backend; d: UiData; ctx: Ctx }) {
  const resources = d.net.resources ?? [];
  const held = blockers(b, resources);
  const slots = b.slots ?? 0;
  const q = b.queued ?? 0;
  const used = d.q.jobs.filter((j) => !j.offbox && j.backend === b.name && j.state === "running").length;
  const stalled = held.length > 0 && q > 0;
  const proxied = b.proxying ?? [];
  const loaded = new Set(b.loaded ?? []);
  const serves = b.serves ?? [];
  const advertised = (wire: string) => displayId(wire, d.aliases, d.net.available);
  const self = d.net.nodes.find((n) => n.self);

  return (
    <>
      <Fact label="in flight">{used}/{slots || "?"} · {q} queued</Fact>
      {proxied.length > 0 && (
        <Fact label="forwarded"
              hint="hearth passes these straight through and was never asked to schedule them, so they hold no slot and the card arbiter cannot see them">
          <Box sx={{ color: "warning.main" }}>{proxied.length} not scheduled</Box>
        </Fact>
      )}
      <Fact label="kind" hint={b.evicts
        ? "llama-swap — loads one model at a time and unloads the last, so every change of model costs a load"
        : b.kind === "none"
          ? "not an OpenAI server: hearth forwards declared paths to it and never looks inside the body"
          : "keeps one model resident, so nothing here thrashes"}>
        {b.kind ?? "openai"}{b.evicts ? " · evicts" : ""}
      </Fact>
      {b.url && (
        <Fact label="address"><Box sx={{ color: "faint", overflowWrap: "anywhere" }}>{b.url}</Box></Fact>
      )}
      {(b.resources ?? []).length > 0 && (
        <Fact label="hardware" hint="it waits for any other backend using these">
          {(b.resources ?? []).map((r) => {
            const res = resources.find((x) => x.name === r);
            return (
              <Box key={r} sx={{ color: res?.holder === b.name ? "success.main" : res?.holder ? "warning.main" : "faint" }}>
                {r}{res?.holder ? ` · ${res.holder} holding` : " · free"}
              </Box>
            );
          })}
        </Fact>
      )}
      {held.length > 0 && (
        <Fact label={stalled ? "blocked" : "waiting on"}
              hint={stalled
                ? "admission checks hardware before this backend's own ceiling, so this is what it is actually waiting on"
                : "it could not start right now — but it has nothing to start, so this costs nothing"}>
          <Box sx={{ color: stalled ? "warning.main" : "faint" }}>
            {held.map((r) => `${r.holder} holds ${r.name}`).join(", ")}
          </Box>
        </Fact>
      )}
      {b.answering === false && (
        <Fact label="reachable"><Box sx={{ color: "error.main" }}>nothing back in a minute</Box></Fact>
      )}

      {(b.routes ?? []).length > 0 && (
        <FieldGroup label="paths" count={(b.routes ?? []).length}
                 note="reached by POST to this path, not by model id">
          {(b.routes ?? []).map((rt) => (
            <Box key={rt.path} sx={{ py: 0.35, pl: `${GUTTER}px`, fontFamily: MONO, fontSize: 11 }}>
              <Box component="span">{rt.path}</Box>
              <Box component="span" sx={{ color: "faint" }}>
                {!rt.queue ? " · not queued"
                  // A {model} route carries no id of its own: it comes from the
                  // request. Printing the empty string left a dangling arrow
                  // that read as something failing to load.
                  : rt.path.includes("{model}") ? ` · queued as the model in the path · ${rt.lane}`
                  : ` · ${rt.model} · ${rt.lane}`}
              </Box>
            </Box>
          ))}
        </FieldGroup>
      )}

      {serves.length > 0 && (
        <FieldGroup label="models" count={serves.length}>
          {serves.map((wire) => {
            const m = advertised(wire);
            // What it can take, under the name. Absent until the model has been
            // loaded once — the backend has not been asked yet, and a blank
            // subtitle is the honest way to say so.
            const st = self?.stats?.[m];
            const takes = st && [
              st.context !== undefined ? ctxLabel(st.context) : null,
              ...capabilityChips(st),
              // The panel has room for the word, and a cold model's whole
              // subtitle can be a declaration nothing has confirmed.
              st.from === "declared" ? "declared" : null,
              // Not the quantization: it is the one stat here that changes
              // nothing about what you can send, and this line has to share a
              // row with the load button. It is in the models table's tooltip.
            ].filter(Boolean).join(" · ");
            return (
              <ModelLine key={wire} model={m} d={d} ctx={ctx} where={takes || undefined}
                         warm={loaded.has(wire) || loaded.has(m)} peer={null} />
            );
          })}
        </FieldGroup>
      )}
    </>
  );
}

export function ResourcePanel({ name, d }: { name: string; d: UiData }) {
  const r = (d.net.resources ?? []).find((x) => x.name === name);
  const backends = (d.net.nodes.find((n) => n.self)?.backends ?? [])
    .filter((b) => (b.resources ?? []).includes(name));
  const unqueued = backends.filter((b) => (b.proxying ?? []).length > 0);
  const evictions = (d.net.evictions ?? []).filter((e) => e.resources.includes(name)).slice(-6).reverse();
  if (!r) return null;

  return (
    <>
      {r.shared ? (
        <Fact label="shared"
              hint="everything declared on it runs at once, so hearth does not arbitrate it: nothing waits for it and nothing is evicted off it">
          <Box sx={{ color: "faint" }}>not arbitrated — {backends.length} backend(s) use it</Box>
        </Fact>
      ) : (
        <Fact label="holder" hint="who is RUNNING on it, not whose weights are resident — the arbiter frees a card the moment the last job on it finishes, so free-and-still-loaded is the normal resting state">
          <Box sx={{ color: r.holder ? "success.main" : "faint" }}>
            {r.holder ? r.holder : "free"}
          </Box>
        </Fact>
      )}
      {unqueued.length > 0 && (
        <Fact label="also busy" hint="hearth forwards this work rather than scheduling it, so the arbiter does not hold the card and cannot make anything else wait for it">
          <Box sx={{ color: "warning.main" }}>
            {unqueued.map((b) => b.name).join(", ")} · unscheduled
          </Box>
        </Fact>
      )}

      <FieldGroup label={r.shared ? "using it" : "competing"} count={backends.length}>
        {backends.map((b) => {
          const q = b.queued ?? 0;
          const mine = r.holder === b.name;
          return (
            <Box key={b.name} sx={{
              display: "flex", alignItems: "baseline", py: 0.4, pl: `${GUTTER}px`,
              borderBottom: "1px solid", borderColor: "divider",
              "&:last-of-type": { borderBottom: "none" },
            }}>
              <Typography sx={{
                fontFamily: MONO, fontSize: 11.5, flex: 1,
                color: mine ? "success.main" : q > 0 ? "warning.main" : "text.secondary",
              }}>{b.name}</Typography>
              <Typography sx={{ fontSize: 10, color: "faint" }}>
                {r.shared ? (b.queued ?? 0) > 0 ? `${b.queued} queued` : "idle"
                  : mine ? "holding" : q > 0 ? `${q} waiting` : "idle"}
              </Typography>
            </Box>
          );
        })}
      </FieldGroup>

      {evictions.length > 0 && (
        <FieldGroup label="handoffs" count={evictions.length}
                 note="a backend cleared off this card so another could use it">
          {evictions.map((e) => (
            <Box key={`${e.t}:${e.backend}`} sx={{ py: 0.3, pl: `${GUTTER}px`, fontFamily: MONO, fontSize: 11, color: "text.secondary" }}>
              <Box component="span" sx={{ color: "faint" }}>{clock(e.t)} </Box>
              {e.backend} → {e.for}
            </Box>
          ))}
        </FieldGroup>
      )}
    </>
  );
}

/** Nothing selected: the vitals, and what to click. */
function Overview({ d, ctx }: { d: UiData; ctx: Ctx }) {
  const self = d.net.nodes.find((n) => n.self);
  return (
    <>
      <PanelTitle>{self?.name ?? "this node"}</PanelTitle>
      <Box sx={{ mb: 2 }}>
        <Vitals d={d} size="sm" columns="1fr 1fr" />
      </Box>
      <Typography sx={{ fontSize: 11, color: "faint", lineHeight: 1.7 }}>
        Click anything above to act on it. The self node holds the federation switches
        and any unsaved runtime changes; a peer holds its model links; a backend holds
        its models and what it is loaded with; a card says who is standing on it.
      </Typography>
      <Pending d={d} ctx={ctx} />
    </>
  );
}

/* ------------------------------------------------------------- the panel */

/** The selected node's header, shared by the rail and the dashboard cards so they cannot disagree. */
export function PanelHeadFor({ d, sel, onBack }: {
  d: UiData; sel: Sel; onBack?: () => void;
}) {
  const self = d.net.nodes.find((n) => n.self);
  const peer = sel?.kind === "peer" ? d.net.nodes.find((n) => n.name === sel.id) : undefined;
  const backend = sel?.kind === "backend"
    ? (self?.backends ?? []).find((b) => b.name === sel.id) : undefined;
  const card = sel?.kind === "resource"
    ? (d.net.resources ?? []).find((r) => r.name === sel.id) : undefined;

  if (sel?.kind === "self" && self) {
    const queued = Object.values(d.q.capacity.queued).reduce((a, b) => a + b, 0);
    const running = d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length;
    return <PanelHead icon="self" tone={queued ? "work" : "live"} name={self.name}
                      status={running || queued ? `${running} running · ${queued} queued` : "idle"}
                      onBack={onBack} />;
  }
  if (peer) {
    return <PanelHead icon="peer" tone={!peer.up ? "fault" : peer.free === 0 ? "work" : "live"}
                      name={peer.name} status={peer.up ? "answering" : "not answering"}
                      onBack={onBack} />;
  }
  if (backend) {
    const held = blockers(backend, d.net.resources ?? []);
    const q = backend.queued ?? 0;
    const used = d.q.jobs.filter((j) => !j.offbox && j.backend === backend.name && j.state === "running").length;
    const proxied = (backend.proxying ?? []).length;
    const stalled = held.length > 0 && q > 0;
    return <PanelHead icon={backendIcon(backend.kind, (backend.routes ?? []).length > 0)}
                      tone={stalled ? "work" : used || proxied ? "live" : "idle"}
                      name={backend.name}
                      status={stalled ? "blocked" : used ? `${used} running`
                        : proxied ? `${proxied} forwarded` : "idle"}
                      onBack={onBack} />;
  }
  if (card) {
    const backends = (self?.backends ?? []).filter((b) => (b.resources ?? []).includes(card.name));
    const loose = backends.some((b) => (b.proxying ?? []).length > 0);
    return <PanelHead icon={resourceIcon(card.kind)}
                      tone={card.holder ? "live" : loose ? "work" : "idle"}
                      name={card.name}
                      status={card.shared ? "shared — not arbitrated"
                        : card.holder ? `${card.holder} holding`
                        : loose ? "in use, unscheduled" : "free"}
                      onBack={onBack} />;
  }
  return null;
}

export function Inspector({ d, sel, ctx, onSelect }: {
  d: UiData; sel: Sel; ctx: Ctx; onSelect: (s: Sel) => void;
}) {
  const self = d.net.nodes.find((n) => n.self);
  const peer = sel?.kind === "peer" ? d.net.nodes.find((n) => n.name === sel.id) : undefined;
  const backend = sel?.kind === "backend"
    ? (self?.backends ?? []).find((b) => b.name === sel.id)
    : undefined;
  const card = sel?.kind === "resource"
    ? (d.net.resources ?? []).find((r) => r.name === sel.id)
    : undefined;

  // A selection can go away underneath you — a peer removed from the config, a
  // backend renamed. Falling back to the overview beats an empty rail that
  // looks broken.
  const body = sel?.kind === "self" ? <SelfPanel d={d} ctx={ctx} />
    : peer ? <PeerPanel n={peer} d={d} ctx={ctx} />
    : backend ? <BackendPanel b={backend} d={d} ctx={ctx} />
    : card ? <ResourcePanel name={card.name} d={d} />
    : <Overview d={d} ctx={ctx} />;

  return (
    <Box sx={{
      borderLeft: { lg: "1px solid" }, borderTop: { xs: "1px solid", lg: "none" },
      borderColor: "line",
      bgcolor: "background.paper",
      p: 2, overflowY: "auto", minWidth: 0,
    }}>
      <PanelHeadFor d={d} sel={sel} onBack={() => onSelect(null)} />
      {body}
      <Box sx={{ mt: 2.5, pt: 1.5, borderTop: "1px solid", borderColor: "divider" }}>
        <Legend />
      </Box>
      {!ctx.canWarm && (
        <Typography sx={{ mt: 2.5, fontSize: 10.5, color: "faint", lineHeight: 1.6 }}>
          Read-only here — this port serves the status page only. Controls live on the
          main listener.
        </Typography>
      )}
    </Box>
  );
}

// Re-exported so App imports one module for the stage and its rail.
export { Graph };
export type { Sel };
export { since };
