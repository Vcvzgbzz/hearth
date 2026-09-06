/**
 * The inspector: whatever you clicked, and everything you can do to it.
 *
 * The old page put each control beside the fact it changed, spread down four
 * tables — which meant the two switches that decide whether this box federates
 * at all lived in a section heading two screens down, and the button that
 * decides whether your edits survive a restart was inside a disclosure. Here
 * there is one place where actions happen, it is always in the same place, and
 * what it contains is whatever the graph has selected.
 *
 * Every control on this page writes to a live system with no confirm step, so
 * three things are non-negotiable and are why these are components rather than
 * plain buttons: a write says it is in flight, a refusal is shown ON the control
 * that was refused rather than swallowed, and nothing here silently no-ops on a
 * read-only surface — it says it is read-only and where to go instead.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { CopyButton, Pre, Row, Why } from "./bits.js";
import { Graph, type Sel } from "./graph.js";
import { clock, displayId, postWrite, since } from "./lib.js";
import { MONO } from "./theme.js";
import { blockers } from "./why.js";
import { yamlScalar as yq } from "../yamlq.js";
import type { Backend, Node, UiData } from "./types.js";

export interface Ctx {
  /** Whether the write routes are reachable on the socket that served this page. */
  canWarm: boolean;
  /** "open" or "key" — told to us per socket, never guessed. */
  control: UiData["control"];
  refresh: () => void;
}

/* -------------------------------------------------------------- fittings */

/** A label above a value, the unit this panel is built from. */
export function Field({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string;
}) {
  const body = (
    <Box sx={{ mb: 1.75 }}>
      <Typography component="div" sx={{
        fontSize: 9.5, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase",
        color: "faint", mb: 0.5,
      }}>{label}</Typography>
      <Box sx={{ fontFamily: MONO, fontSize: 12 }}>{children}</Box>
    </Box>
  );
  return hint ? <Tooltip title={hint}><Box>{body}</Box></Tooltip> : body;
}

/** A heading inside the panel. */
const Head = ({ children }: { children: React.ReactNode }) => (
  <Typography component="h2" sx={{
    fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase",
    color: "text.secondary", pb: 0.75, mb: 1.5, borderBottom: "1px solid", borderColor: "line",
  }}>{children}</Typography>
);

/**
 * A write, with its own outcome attached to it.
 *
 * The message goes BESIDE the control, never into its label: a refusal is a
 * sentence and a button is a word, and putting one where the other was turns a
 * control into a paragraph and moves everything under it.
 */
export function Action({ label, title, path = "/control", body, ctx, tone = "normal", after, full }: {
  label: string;
  title: string;
  path?: string;
  body: () => unknown;
  ctx: Ctx;
  tone?: "normal" | "primary";
  /** Overrides the default refresh-on-success — used where the reply is worth reading. */
  after?: (d: Record<string, unknown>) => void;
  full?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);

  const click = () => {
    if (busy) return;
    // Cleared on click, not on success: a refused write changes nothing on the
    // server, so the next poll returns identical state and re-renders nothing.
    // Without this the old error sits under the button through the retry that
    // fixed it.
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
                    { transition: "color 160ms, border-color 160ms" },
                    tone === "primary" && { color: "success.main", borderColor: "success.main" },
                    !!fail && { color: "error.main", borderColor: "error.main" },
                  ]}>
            {busy ? "working…" : label}
          </Button>
        </Box>
      </Tooltip>
      {fail && (
        <Typography sx={{ mt: 0.5, fontFamily: MONO, fontSize: 10.5, color: "error.main" }}>{fail}</Typography>
      )}
    </Box>
  );
}

/**
 * A switch that also works where it cannot be switched.
 *
 * A read-only surface used to render NOTHING for a direction that was on, which
 * is wrong in the case that matters most — the healthy one. Absence of a control
 * is indistinguishable from absence of the feature, and the operator whose only
 * dashboard is the standalone listener reads it as "the deploy did not land".
 */
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
 * Whether we lend a model, and the control to change it.
 *
 * Three facts flattened into one control, and keeping them apart is the whole
 * difficulty: INTENT (the config list, plus any runtime override), EFFECTIVE
 * (nothing goes out at all while lending is paused), and DRIFT (intent differs
 * from the file, so a change nobody remembers making is visible rather than
 * mysterious). Showing only effective makes every row read "held" during a
 * pause and loses the per-model settings you had; showing only intent claims we
 * are lending things while lending is off.
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

/**
 * The load action.
 *
 * Reports in place rather than just refreshing: a decline and an already-warm
 * both return 200 and are worth reading rather than flattening into a silent
 * success.
 */
export function LoadAction({ model, peer, ctx }: { model: string; peer: string | null; ctx: Ctx }) {
  const [said, setSaid] = useState<string | null>(null);
  if (said) {
    return <Typography component="span" sx={{ fontFamily: MONO, fontSize: 10.5, color: "faint" }}>{said}</Typography>;
  }
  return (
    <Action label="load" ctx={ctx} path="/v1/warm" body={() => ({ model })}
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
  return (
    <Row spacing={1} align="center" sx={{
      py: 0.75, borderBottom: "1px solid", borderColor: "divider",
      "&:last-of-type": { borderBottom: "none" },
    }}>
      <Box aria-hidden sx={{
        width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
        bgcolor: warm ? "success.main" : "divider",
      }} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography component="div" sx={{
          fontFamily: MONO, fontSize: 11.5, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: warm ? "text.primary" : "text.secondary",
        }}>{model}</Typography>
        {where && <Typography component="div" sx={{ fontFamily: MONO, fontSize: 10, color: "faint" }}>{where}</Typography>}
      </Box>
      <ShareToggle model={model} d={d} ctx={ctx} />
      {!warm && ctx.canWarm && <LoadAction model={model} peer={peer ?? null} ctx={ctx} />}
    </Row>
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

/**
 * A peer's model map, and the two edits you can make to it.
 *
 * `peers[].models` IS the allowlist deciding which of your prompts may leave
 * this machine, so the second thought this used to buy with a paste-the-YAML
 * disclosure is worth keeping — it is just not worth buying with an ssh session
 * and a restart. The edit is live and temporary, and the pending block on the
 * self panel hands you the YAML to make it stick.
 */
function MapEditor({ n, ctx }: { n: Node; ctx: Ctx }) {
  const pairs = Object.entries(n.map ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  const unmapped = [...(n.unmapped ?? [])].sort();
  const [names, setNames] = useState<Record<string, string>>({});

  return (
    <>
      <Field label={`linked · ${pairs.length}`}
             hint="requests for the id on the left are sent to this peer as the id on the right">
        {!pairs.length && <Box sx={{ color: "faint" }}>nothing linked — nothing can leave this box for {n.name}</Box>}
        {pairs.map(([mine, theirs]) => (
          <Row key={mine} spacing={1} align="center" sx={{ py: 0.5 }}>
            <Box sx={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {mine}{mine !== theirs && <Box component="span" sx={{ color: "faint" }}> → {theirs}</Box>}
            </Box>
            {ctx.canWarm && (
              <Action label="unlink" title={`stop sending ${mine} to ${n.name}`} ctx={ctx}
                      body={() => ({ unlink: { peer: n.name, mine } })} />
            )}
          </Row>
        ))}
      </Field>

      {unmapped.length > 0 && (
        <Field label={`offered · ${unmapped.length} unclaimed`}
               hint="models this peer is lending that you have not mapped, so nothing can route to them">
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
                  <Action label="link" title={`route requests for this id to ${n.name}`} ctx={ctx}
                          body={() => ({ link: { peer: n.name, mine: (names[theirs] ?? theirs).trim() || theirs, theirs } })} />
                </>
              ) : (
                <Box sx={{ color: "warning.main" }}>{theirs}</Box>
              )}
            </Row>
          ))}
          {ctx.canWarm ? (
            <Why>
              Linking maps the id and routes it, which are two halves of one thing: a mapping on
              its own only says a request MAY leave. A model you also serve gets policy fastest
              with a local fallback; one you do not gets policy peer and no fallback, since home
              is a backend that has never heard of it.
            </Why>
          ) : (
            <>
              <Pre>{mapSnippet(n)}</Pre>
              <CopyButton text={mapSnippet(n)} />
            </>
          )}
        </Field>
      )}
    </>
  );
}

/* --------------------------------------------------------------- pending */

/**
 * Runtime changes that are not in the config file.
 *
 * The counterweight to making all of this clickable. Every edit here is live
 * and temporary, which is a fine default and a terrible surprise — six weeks
 * on, a model is being lent that `share:` does not list and the only
 * explanation is a click nobody remembers.
 */
function Pending({ d, ctx }: { d: UiData; ctx: Ctx }) {
  const [show, setShow] = useState(false);
  const ov = d.overrides;
  if (!ov?.dirty) return null;

  const drift = [...d.share].sort().join(",") !== [...d.configuredShare].sort().join(",");
  const n = ov.changes.maps.length + ov.changes.routes.length + (drift ? 1 : 0);
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
  const self = d.net.nodes.find((n) => n.self);
  const cap = d.q.capacity;
  const queued = Object.values(cap.queued).reduce((a, b) => a + b, 0);
  return (
    <>
      <Head>{self?.name ?? "this node"}</Head>
      <Field label="in flight">
        {d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length} running · {queued} queued
        {cap.offbox ? <Box component="span" sx={{ color: "warning.main" }}> · {cap.offbox} off-box</Box> : null}
      </Field>
      <Field label="federation">
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
      </Field>
      <Field label={`lending · ${d.share.length} of ${d.catalog.length}`}>
        {!d.catalog.length && <Box sx={{ color: "faint" }}>nothing to lend</Box>}
        {d.catalog.map((m) => (
          <ModelLine key={m} model={m} d={d} ctx={ctx}
                     warm={d.net.readyNow.includes(m)} peer={null} />
        ))}
      </Field>
      <Pending d={d} ctx={ctx} />
    </>
  );
}

export function PeerPanel({ n, d, ctx }: { n: Node; d: UiData; ctx: Ctx }) {
  const busy = (n.slots ?? 0) - (n.free ?? 0);
  return (
    <>
      <Head>{n.name}</Head>
      <Field label="state">
        <Box sx={{ color: n.up ? "success.main" : "error.main" }}>
          {n.up ? `up · ${busy}/${n.slots ?? "?"} busy · ${n.queued ?? 0} queued` : "not answering"}
        </Box>
        {n.lastError && (
          <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: "error.main", mt: 0.5, overflowWrap: "anywhere" }}>
            {n.lastError}
          </Typography>
        )}
        {n.sending ? <Box sx={{ color: "warning.main", mt: 0.5 }}>{n.sending} of ours running there</Box> : null}
      </Field>
      {d.controls.borrowing === false && (
        <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: "warning.main", mb: 1.75 }}>
          Borrowing is paused, so nothing routes here regardless of what is linked.
        </Typography>
      )}
      <MapEditor n={n} ctx={ctx} />
      {(n.loaded ?? []).length > 0 && (
        <Field label="loaded there" hint="warm on the peer — a request for one of these pays no load">
          {(n.loaded ?? []).map((m) => (
            <Box key={m} sx={{ color: "success.main", py: 0.25 }}>{m}</Box>
          ))}
        </Field>
      )}
    </>
  );
}

export function BackendPanel({ b, d, ctx }: { b: Backend; d: UiData; ctx: Ctx }) {
  const resources = d.net.resources ?? [];
  const held = blockers(b, resources);
  const slots = b.slots ?? 0;
  const q = b.queued ?? 0;
  // Running here, not "would admission refuse" — `free` drops to 0 when another
  // backend takes the card, which is a different question.
  const used = d.q.jobs.filter((j) => !j.offbox && j.backend === b.name && j.state === "running").length;
  const stalled = held.length > 0 && q > 0;
  const loaded = new Set(b.loaded ?? []);
  const serves = b.serves ?? [];
  // A backend reports its own wire ids; the panel speaks the advertised ones.
  const advertised = (wire: string) => displayId(wire, d.aliases, d.net.available);

  return (
    <>
      <Head>{b.name}</Head>
      <Field label="state">
        <Box sx={{ color: stalled ? "warning.main" : used > 0 ? "success.main" : "faint" }}>
          {`${used}/${slots || "?"} in flight · ${q} queued`}
        </Box>
        {held.length > 0 && (
          <Tooltip title={stalled
            ? "admission checks hardware before this backend's own ceiling, so this is what it is actually waiting on"
            : "it could not start right now — but it has nothing to start, so this costs nothing"}>
            <Box sx={{ color: stalled ? "warning.main" : "faint", mt: 0.5, cursor: "help" }}>
              {stalled ? "blocked — " : "idle — "}
              {held.map((r) => `${r.holder} holds ${r.name}`).join(", ")}
            </Box>
          </Tooltip>
        )}
        {(b.proxying ?? []).length > 0 && (
          <Tooltip title="hearth forwards these straight through and was never asked to schedule them, so they hold no slot, wait for nothing, and the card arbiter cannot see them. Declaring the path under this backend's routes: is what changes that — and makes hearth the admission control for it.">
            <Box sx={{ color: "warning.main", mt: 0.5, cursor: "help" }}>
              {(b.proxying ?? []).length} passing through, not scheduled
              {b.proxying![0]?.model ? ` · ${b.proxying!.map((x) => x.model ?? "?").join(", ")}` : ""}
            </Box>
          </Tooltip>
        )}
        {b.answering === false && (
          <Box sx={{ color: "error.main", mt: 0.5 }}>nothing has come back from it in a minute</Box>
        )}
      </Field>
      <Field label="kind" hint={b.evicts
        ? "llama-swap — loads one model at a time and unloads the last, so every change of model costs a load"
        : b.kind === "none"
          ? "not an OpenAI server: hearth forwards declared paths to it and never looks inside the body"
          : "keeps its models resident, so nothing here thrashes"}>
        {b.kind ?? "openai"}{b.evicts ? " · evicts" : ""}
        {b.url && <Box sx={{ color: "faint", overflowWrap: "anywhere" }}>{b.url}</Box>}
      </Field>
      {(b.resources ?? []).length > 0 && (
        <Field label="hardware" hint="it waits for any other backend using these">
          {(b.resources ?? []).map((r) => {
            const res = resources.find((x) => x.name === r);
            return (
              <Box key={r} sx={{ color: res?.holder === b.name ? "success.main" : res?.holder ? "warning.main" : "faint" }}>
                {r}{res?.holder ? ` · ${res.holder} holding` : " · free"}
              </Box>
            );
          })}
        </Field>
      )}
      {(b.routes ?? []).length > 0 && (
        <Field label="paths" hint="reached by POST to this path, not by model id — the body is forwarded untouched">
          {(b.routes ?? []).map((rt) => (
            <Box key={rt.path} sx={{ py: 0.25 }}>
              {rt.path} <Box component="span" sx={{ color: "faint" }}>
                {rt.queue ? `→ ${rt.model} · ${rt.lane}` : "→ not queued"}
              </Box>
            </Box>
          ))}
        </Field>
      )}
      {serves.length > 0 && (
        <Field label={`models · ${serves.length}`}>
          {serves.map((wire) => {
            const m = advertised(wire);
            return (
              <ModelLine key={wire} model={m} d={d} ctx={ctx}
                         warm={loaded.has(wire) || loaded.has(m)} peer={null} />
            );
          })}
        </Field>
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
  if (!r) return <Head>{name}</Head>;

  return (
    <>
      <Head>{name}</Head>
      <Field label="holder" hint="who is RUNNING on it, not whose weights are resident — the arbiter frees a card the moment the last job on it finishes, so free-and-still-loaded is the normal resting state">
        <Box sx={{ color: r.holder ? "success.main" : "faint" }}>
          {r.holder ? `${r.holder} is running on it` : "free"}
        </Box>
        {unqueued.length > 0 && (
          <Tooltip title="The hardware is busy; the queue does not know. hearth forwards this work straight through rather than scheduling it, so the arbiter does not hold the card and cannot make anything else wait for it.">
            <Box sx={{ color: "warning.main", mt: 0.5, cursor: "help" }}>
              but {unqueued.map((b) => b.name).join(", ")} is working on it, unscheduled
            </Box>
          </Tooltip>
        )}
      </Field>
      <Field label={`competing · ${backends.length}`}>
        {backends.map((b) => {
          const q = b.queued ?? 0;
          const mine = r.holder === b.name;
          return (
            <Row key={b.name} spacing={1} align="baseline" sx={{ py: 0.4 }}>
              <Box sx={{ flex: 1, color: mine ? "success.main" : q > 0 ? "warning.main" : "text.secondary" }}>
                {b.name}
              </Box>
              <Box sx={{ color: "faint", fontSize: 10.5 }}>
                {mine ? "holding" : q > 0 ? `${q} waiting` : "idle"}
              </Box>
            </Row>
          );
        })}
      </Field>
      {evictions.length > 0 && (
        <Field label="recent handoffs" hint="a backend cleared off this card so another could use it">
          {evictions.map((e) => (
            <Box key={`${e.t}:${e.backend}`} sx={{ py: 0.25, color: "text.secondary" }}>
              <Box component="span" sx={{ color: "faint" }}>{clock(e.t)} </Box>
              {e.backend} → {e.for}
            </Box>
          ))}
        </Field>
      )}
    </>
  );
}

/** Nothing selected: the vitals, and what to click. */
function Overview({ d }: { d: UiData }) {
  const self = d.net.nodes.find((n) => n.self);
  const peers = d.net.nodes.filter((n) => !n.self);
  const resources = d.net.resources ?? [];
  const running = d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length;
  const queued = Object.values(d.q.capacity.queued).reduce((a, b) => a + b, 0);
  const stat = (label: string, value: React.ReactNode, hot?: boolean) => (
    <Box key={label} sx={{
      p: 1.25, borderRadius: 2, border: "1px solid", borderColor: "line", bgcolor: "background.default",
    }}>
      <Typography sx={{ fontFamily: MONO, fontSize: 17, fontWeight: 600, color: hot ? "warning.main" : "text.primary" }}>
        {value}
      </Typography>
      <Typography sx={{ fontSize: 9.5, letterSpacing: ".05em", textTransform: "uppercase", color: "faint" }}>
        {label}
      </Typography>
    </Box>
  );
  return (
    <>
      <Head>{self?.name ?? "this node"}</Head>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, mb: 2 }}>
        {stat("running", running, running > 0)}
        {stat("queued", queued, queued > 0)}
        {resources.length > 0 && stat("cards busy", `${resources.filter((r) => r.holder).length}/${resources.length}`,
          resources.some((r) => r.holder))}
        {stat("warm", d.net.readyNow.length)}
        {peers.length > 0 && stat("peers", `${peers.filter((n) => n.up).length}/${peers.length}`,
          peers.some((n) => !n.up))}
        {d.q.capacity.offbox ? stat("off-box", d.q.capacity.offbox, true) : null}
      </Box>
      <Typography sx={{ fontSize: 11, color: "faint", lineHeight: 1.7, mb: 1.5 }}>
        <Box component="span" sx={{ color: "success.main" }}>Green</Box> is work hearth
        scheduled: it took a slot and waited its turn.{" "}
        <Box component="span" sx={{ color: "warning.main" }}>Amber</Box> is work hearth is only
        forwarding — image generation arrives on a path it passes straight through, so it runs
        without a slot and the card arbiter cannot see it. Busy either way; managed only when green.
      </Typography>
      <Typography sx={{ fontSize: 11, color: "faint", lineHeight: 1.7 }}>
        Click anything above to act on it. The self node holds the federation switches
        and any unsaved runtime changes; a peer holds its model links; a backend holds
        its models and what it is loaded with; a card says who is standing on it.
      </Typography>
      <Pending d={d} ctx={{ canWarm: false, control: "off", refresh: () => {} }} />
    </>
  );
}

/* ------------------------------------------------------------- the panel */

export function Inspector({ d, sel, ctx, onSelect }: {
  d: UiData; sel: Sel; ctx: Ctx; onSelect: (s: Sel) => void;
}) {
  const peer = sel?.kind === "peer" ? d.net.nodes.find((n) => n.name === sel.id) : undefined;
  const backend = sel?.kind === "backend"
    ? (d.net.nodes.find((n) => n.self)?.backends ?? []).find((b) => b.name === sel.id)
    : undefined;

  // A selection can go away underneath you: a peer is removed from the config,
  // a backend renamed. Falling back to the overview beats an empty rail that
  // looks broken.
  const body = sel?.kind === "self" ? <SelfPanel d={d} ctx={ctx} />
    : peer ? <PeerPanel n={peer} d={d} ctx={ctx} />
    : backend ? <BackendPanel b={backend} d={d} ctx={ctx} />
    : sel?.kind === "resource" ? <ResourcePanel name={sel.id} d={d} />
    : <Overview d={d} />;

  return (
    <Box sx={{
      borderLeft: { md: "1px solid" }, borderTop: { xs: "1px solid", md: "none" },
      borderColor: { xs: "line", md: "line" },
      bgcolor: "background.paper",
      p: 2, overflowY: "auto",
      minWidth: 0,
    }}>
      {sel && (
        <Button onClick={() => onSelect(null)} sx={{ mb: 1.5 }}>← overview</Button>
      )}
      {body}
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
