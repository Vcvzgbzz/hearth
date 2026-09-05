/**
 * What the hardware is doing, which is the question this page exists to answer.
 *
 * The old page drew a flat strip of backends, because when it was written a
 * backend WAS the unit of contention: one backend, one queue, one GPU. It is
 * not any more. Two backends pinned to the same card are two admission domains
 * and one piece of silicon — only one of them may run, and hearth unloads the
 * loser's model to let the winner in. Nothing in a list of backends can show
 * that, so the card is the container here and the backends sit inside the one
 * they compete for.
 *
 * Three states that a flat strip collapsed into one word:
 *
 *   idle       nothing to do
 *   blocked    something to do, and another backend is standing on the card
 *   holding    running, and everything else on that card is waiting for it
 *
 * "idle" and "blocked" looked identical before — both drew as `name · idle`, and
 * the second one is the interesting half.
 *
 * A config that declares no `resources` gets no cards, because it has no
 * contention to draw: it falls back to one plain group, which is the old strip
 * with the states the old strip could not say.
 */
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import { Dot, Row, Section, Spacer, Tag, Why } from "./bits.js";
import { clock } from "./lib.js";
import { blockers } from "./why.js";
import { MONO } from "./theme.js";
import type { Backend, Eviction, Job, Resource, UiData } from "./types.js";

/**
 * Slots in use, as pips.
 *
 * A pip per slot up to a point, then a fraction: past a couple of dozen the
 * pips stop being countable and start being a texture, and a backend with
 * `concurrency: 128` would push everything beside it off the row.
 */
function Meter({ used, slots }: { used: number; slots: number }) {
  if (!slots) return null;
  const label = `${used} of ${slots} slot${slots === 1 ? "" : "s"} in use`;
  if (slots > 24) {
    return (
      <Tooltip title={label}>
        <Box component="span" sx={{ fontFamily: MONO, fontSize: 11.5, color: used ? "success.main" : "faint" }}>
          {used}/{slots}
        </Box>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={label}>
      <Box component="span" aria-label={label}
           sx={{ display: "inline-flex", gap: "2px", alignItems: "center", verticalAlign: "middle" }}>
        {Array.from({ length: slots }, (_, i) => (
          <Box component="span" key={i}
               sx={{ width: 4, height: 11, borderRadius: "1px",
                     bgcolor: i < used ? "success.main" : "divider" }} />
        ))}
      </Box>
    </Tooltip>
  );
}

const kindNote = (b: Backend): string =>
  b.evicts
    ? "llama-swap — loads one model at a time and unloads the last one, so every change of model costs a load"
    : b.kind === "none"
      ? "not an OpenAI server: hearth forwards declared paths to it and queues them, and never looks inside the body"
      : "keeps its models resident, so nothing here thrashes";

/**
 * One backend, inside the card it competes for.
 *
 * The second line is the point of the row: what this backend is actually
 * holding. For an ordinary backend that is the resident model; for a route
 * backend there is no model at all and it is the paths it fronts — which is why
 * `video` used to render as a bare name with nothing beside it forever.
 */
function BackendRow({ b, resources, jobs }: { b: Backend; resources: Resource[]; jobs: Job[] }) {
  const held = blockers(b, resources);
  const slots = b.slots ?? 0;
  const used = slots - (b.free ?? 0);
  const queued = b.queued ?? 0;
  const mine = jobs.filter((j) => j.backend === b.name && !j.offbox);
  const runningModels = [...new Set(mine.filter((j) => j.state === "running").map((j) => j.model))];

  // Ordered the way admission decides: hardware, then this backend's own
  // ceiling. A blocked backend that also happens to be full is blocked — the
  // fullness is not what is stopping the next job.
  const state = held.length
    // Every blocker, not the first: a model spanning two cards is drawn under
    // both of them, and naming only one leaves the row under the OTHER card
    // saying something that has nothing to do with the card it sits in.
    ? { word: `blocked · ${held.map((r) => `${r.holder} has ${r.name}`).join(", ")}`, color: "warning.main",
        why: `this backend has work it cannot start: ${held.map((r) => r.name).join(", ")} ${held.length > 1 ? "are" : "is"} in use by ${[...new Set(held.map((r) => r.holder))].join(", ")}. It runs when they let go.` }
    : used > 0
      ? { word: `${used} running`, color: "success.main",
          why: runningModels.length ? `running ${runningModels.join(", ")}` : "" }
      // Before "idle", because a backend that stopped answering keeps its last
      // slot counts and an empty queue, and draws as idle — which is the one
      // word it is certainly not.
      : b.answering === false && b.knowsWarm
        ? { word: "not answering", color: "error.main",
            why: "nothing has come back from this backend in over a minute. The numbers here are the last ones we had, and work sent to it may simply fail." }
        : queued > 0
          ? { word: `${queued} queued`, color: "warning.main", why: "admitted nothing yet this poll" }
          : { word: "idle", color: "faint", why: "nothing queued and nothing running" };

  const routes = b.routes ?? [];
  const loaded = b.loaded ?? [];

  return (
    <Box sx={{ py: 0.85, borderTop: 1, borderColor: "divider", "&:first-of-type": { borderTop: 0 } }}>
      <Row spacing={1.25} align="baseline" wrap>
        <Typography component="span" sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600 }}>
          {b.name}
        </Typography>
        <Tag title={kindNote(b)}>{b.kind ?? "openai"}</Tag>
        {/* Why this row appears twice. A model large enough to span both cards
            declares both, so it belongs to both and takes both to run. */}
        {(b.resources ?? []).length > 1 && (
          <Tag color="warning.main"
               title={`${b.name} takes ${(b.resources ?? []).join(" and ")} together, so it waits for every backend on either of them`}>
            spans {(b.resources ?? []).join("+")}
          </Tag>
        )}
        <Tooltip title={state.why}>
          <Typography component="span" variant="caption" sx={{ fontFamily: MONO, color: state.color, cursor: "help" }}>
            <Dot color={state.color} />{state.word}
          </Typography>
        </Tooltip>
        <Spacer />
        <Row spacing={1.25} align="center" sx={{ fontFamily: MONO, fontSize: 11.5, color: "faint" }}>
          {queued > 0 && (
            <Box component="span" sx={{ color: "warning.main" }}>{queued} queued</Box>
          )}
          <Meter used={used} slots={slots} />
        </Row>
      </Row>

      {/* What it is holding. A model for most backends; a set of paths for one
          that fronts something that does not speak OpenAI at all. */}
      <Row spacing={2.25} align="baseline" wrap sx={{ mt: 0.4, pl: 0.25 }}>
        {routes.map((r) => {
          const hot = runningModels.includes(r.model);
          return (
            <Tooltip key={r.path}
                     title={r.queue
                       ? `POST ${r.path} is queued here as ${r.model}, in the ${r.lane} lane. hearth forwards the body untouched and never looks inside it.`
                       : `${r.path} is forwarded but never queued — a status endpoint should not wait behind a render`}>
              <Typography component="span" variant="caption"
                          sx={{ fontFamily: MONO, cursor: "help",
                                color: hot ? "success.main" : r.queue ? "text.secondary" : "faint" }}>
                <Box component="span" sx={{ color: "faint" }}>POST </Box>
                {r.path}
                <Box component="span" sx={{ color: "faint" }}> → </Box>
                {r.model}
                {r.queue ? "" : <Box component="span" sx={{ color: "faint" }}> (unqueued)</Box>}
              </Typography>
            </Tooltip>
          );
        })}
        {!routes.length && loaded.length > 0 && (
          <Typography component="span" variant="caption" sx={{ fontFamily: MONO, color: "success.main" }}>
            <Dot color="success.main" />resident: {loaded.join("  ")}
          </Typography>
        )}
        {!routes.length && !loaded.length && (
          <Tooltip title={b.knowsWarm === false
            ? "this backend cannot report what it has loaded, so neither can we"
            : "nothing is loaded here — the next request pays for a load"}>
            <Typography component="span" variant="caption" sx={{ fontFamily: MONO, color: "faint", cursor: "help" }}>
              {b.knowsWarm === false ? "cannot report what it holds" : "nothing resident"}
            </Typography>
          </Tooltip>
        )}
      </Row>
    </Box>
  );
}

/**
 * One card and the backends that take turns on it.
 *
 * The header says which of the two states that matter it is in, and they are
 * not "busy" and "free": a card nobody is running on may still have a model
 * sitting in its memory, and the next backend to want it pays for that. The
 * arbiter releases on the last job finishing, the weights stay until something
 * evicts them, and the gap between those two facts is where the 20-60s goes.
 */
function Card({ r, backends, jobs, resources, sole }: {
  r: Resource | null;
  backends: Backend[];
  jobs: Job[];
  resources: Resource[];
  /** The only group on the page, because nothing declares hardware. */
  sole?: boolean;
}) {
  const holder = r?.holder ?? null;
  const resident = backends.filter((b) => (b.loaded ?? []).length);
  const shared = backends.length > 1;

  const head = !r
    ? { word: "no declared hardware", color: "faint",
        why: "these backends declare no `resources`, so they compete for nothing and never wait for each other" }
    : holder
      ? { word: `in use by ${holder}`, color: "warning.main",
          why: `${holder} is running, so every other backend on ${r.name} waits` }
      : resident.length
        ? { word: `free · ${resident.map((b) => b.name).join(", ")} still resident`, color: "success.main",
            why: `nothing is running on ${r.name}, but ${resident.map((b) => b.name).join(", ")} left ${resident.length > 1 ? "their models" : "its model"} in its memory. Dispatching to a different backend here unloads that first.` }
        : { word: "free", color: "faint", why: `nothing is running on ${r.name} and nothing is resident on it` };

  return (
    <Box sx={{
      border: 1, borderColor: holder ? "warning.main" : "line", borderRadius: 1,
      p: "8px 12px 6px", mb: 1.25, bgcolor: "background.default",
    }}>
      {/* No header when this is the only group: "unpinned · no declared
          hardware" under a heading that already says "none pinned to hardware"
          is the same sentence twice. */}
      {!sole && (
      <Row spacing={1.25} align="baseline" wrap sx={{ pb: 0.6 }}>
        <Typography component="span"
                    sx={{ fontFamily: MONO, fontSize: 13.5, fontWeight: 650,
                          color: r ? "text.primary" : "text.secondary" }}>
          {r ? r.name : "unpinned"}
        </Typography>
        <Tooltip title={head.why}>
          <Typography component="span" variant="caption" sx={{ fontFamily: MONO, color: head.color, cursor: "help" }}>
            <Dot color={head.color} />{head.word}
          </Typography>
        </Tooltip>
        <Spacer />
        {shared && r && (
          <Tooltip title={`${backends.map((b) => b.name).join(", ")} all declare ${r.name}. hearth admits one of them at a time and unloads the others' models before dispatching.`}>
            <Typography component="span" variant="caption"
                        sx={{ color: "faint", fontFamily: MONO, cursor: "help" }}>
              {backends.length} backends · one at a time
            </Typography>
          </Tooltip>
        )}
      </Row>
      )}
      {backends.map((b) => <BackendRow key={b.name} b={b} resources={resources} jobs={jobs} />)}
    </Box>
  );
}

/**
 * The handoffs, which are the expensive thing that happens here.
 *
 * hearth logs `pool.evict` and nothing else ever surfaced it, so the resident
 * model changed between two polls and the page said only that it had changed.
 * A handoff is a deliberate unload to give a card away; the next request to the
 * evicted backend pays a full cold load for it. Worth seeing, and worth being
 * mildly annoyed by.
 */
function Handoffs({ evictions }: { evictions: Eviction[] }) {
  const [all, setAll] = useState(false);
  if (!evictions.length) return null;
  const recent = [...evictions].reverse();
  const shown = all ? recent : recent.slice(0, 4);
  return (
    <Box sx={{ mt: 1.5 }}>
      <Row spacing={1.5} align="baseline" wrap sx={{ mb: 0.5 }}>
        <Typography component="span" variant="caption"
                    sx={{ color: "warning.main", fontFamily: MONO }}>
          {evictions.length} handoff{evictions.length === 1 ? "" : "s"} this session
        </Typography>
        {recent.length > shown.length && (
          <Typography component="span" variant="caption"
                      sx={{ color: "faint", cursor: "pointer", textDecoration: "underline" }}
                      onClick={() => setAll(true)}>
            show all
          </Typography>
        )}
      </Row>
      {shown.map((e) => (
        <Typography key={`${e.t}:${e.backend}`} variant="caption"
                    sx={{ display: "block", fontFamily: MONO, color: "text.secondary" }}>
          <Box component="span" sx={{ color: "faint" }}>{clock(e.t)}</Box>{"  "}
          {e.for} took {e.resources.join(", ")}
          <Box component="span" sx={{ color: "faint" }}> · unloaded </Box>{e.backend}
        </Typography>
      ))}
      <Why>
        A handoff is an unload, not a queue: the evicted backend's next request pays a full cold
        load for it. If two of these appear per minute, the two backends want the card at the same
        rate and one of them wants a different one.
      </Why>
    </Box>
  );
}

export function Hardware({ d }: { d: UiData }) {
  const self = d.net.nodes.find((n) => n.self);
  const backends = self?.backends ?? [];
  const resources = d.net.resources ?? [];
  const jobs = d.q.jobs;
  if (!backends.length) return null;

  const unpinned = backends.filter((b) => !(b.resources ?? []).length);
  // A backend spanning two cards appears under both, deliberately: it is the
  // fact that it takes both of them that makes it worth drawing twice.
  const cards = resources.map((r) => ({
    r,
    backends: backends.filter((b) => (b.resources ?? []).includes(r.name)),
  }));
  const busy = resources.filter((r) => r.holder).length;

  return (
    <Section
      title={resources.length ? "Hardware" : "Backends"}
      note={
        <Typography component="span" variant="body2" sx={{ color: "faint" }}>
          {resources.length
            ? `${busy} of ${resources.length} card${resources.length === 1 ? "" : "s"} in use`
            : `${backends.length} backend${backends.length === 1 ? "" : "s"}, none pinned to hardware`}
        </Typography>
      }
    >
      {cards.map(({ r, backends: bs }) => (
        <Card key={r.name} r={r} backends={bs} jobs={jobs} resources={resources} />
      ))}
      {unpinned.length > 0 && (
        <Card r={null} backends={unpinned} jobs={jobs} resources={resources} sole={!cards.length} />
      )}
      <Handoffs evictions={d.net.evictions ?? []} />
    </Section>
  );
}
