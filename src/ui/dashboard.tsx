/**
 * The dashboard view.
 *
 * Every number at once, down one scroll: the vitals, then the hardware, the
 * queue, the models, the peers and the last ten minutes — the read the graph
 * answers a click at a time. It is built entirely from the pieces the graph
 * already uses: the three tables come from tables.tsx, and each hardware, card
 * and peer section is the SAME panel the inspector rail draws for a selection.
 * Nothing here re-derives what a slot count or a blocked backend means, so the
 * two views cannot disagree — which is the whole reason the first attempt at a
 * second console, a restored copy of the old one, was right to be turned down.
 *
 * Presentational only: the shell owns the poll, the theme and the view menu, and
 * hands this {d, ctx, dead} plus the `menu` element to seat in the header.
 */
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

import { Dot, Row, Section, Spacer, StatTile, Tag } from "./bits.js";
import { BackendPanel, PeerPanel, ResourcePanel, SelfPanel, type Ctx } from "./inspect.js";
import { History, ModelsTable, QueueTable } from "./tables.js";
import { MONO } from "./theme.js";
import type { UiData } from "./types.js";

/** A bordered card, so a stacked panel reads as its own thing on the scroll. */
function Card({ children }: { children: ReactNode }) {
  return (
    <Box sx={{
      p: 2, borderRadius: 2, border: "1px solid", borderColor: "line",
      bgcolor: "background.default", minWidth: 0,
    }}>
      {children}
    </Box>
  );
}

export default function Dashboard({ d, ctx, dead, menu }: {
  d: UiData | null; ctx: Ctx; dead: boolean; menu?: ReactNode;
}) {
  const self = d?.net.nodes.find((n) => n.self);
  const peers = (d?.net.nodes ?? []).filter((n) => !n.self);
  const resources = d?.net.resources ?? [];
  const backends = self?.backends ?? [];
  const running = d ? d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length : 0;
  const queued = d ? Object.values(d.q.capacity.queued).reduce((a, b) => a + b, 0) : 0;
  const cardsBusy = resources.filter((r) => r.holder).length;

  return (
    <Container maxWidth={false} sx={{ maxWidth: 960, py: 3, pb: 8, bgcolor: "background.default", minHeight: "100dvh" }}>
      {/* The status band: identity, the two facts you reload to check, and the
          vitals as tiles. The menu sits first, where the graph header keeps it. */}
      <Box sx={{
        bgcolor: "background.paper", border: "1px solid", borderColor: "line",
        borderRadius: 3, p: 2, mb: 2,
      }}>
        <Row spacing={1.5} align="center" wrap sx={{ mb: d ? 1.75 : 0 }}>
          {menu}
          <Typography component="span" sx={{ fontSize: 16, fontWeight: 700, letterSpacing: "-.01em" }}>
            hea<Box component="span" sx={{ color: "success.main" }}>r</Box>th
          </Typography>
          <Tag>{dead ? "unreachable" : self?.name ?? "—"}</Tag>
          <Typography component="span" sx={{ fontFamily: MONO, fontSize: 10.5, color: dead ? "error.main" : "faint" }}>
            <Dot color={dead ? "error.main" : "success.main"} />{dead ? "no answer from /ui/data" : "live"}
          </Typography>
          <Spacer />
          {d?.q.capacity.resident && (
            <Typography component="span" sx={{ fontFamily: MONO, fontSize: 11, color: "text.secondary" }}>
              resident <Box component="span" sx={{ color: "success.main" }}>{d.q.capacity.resident}</Box>
            </Typography>
          )}
        </Row>
        {d && (
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 1 }}>
            {resources.length > 0 && (
              <StatTile label="cards busy" value={`${cardsBusy}/${resources.length}`} hot={cardsBusy > 0}
                        title="hardware with a backend running on it right now" />
            )}
            <StatTile label="running" value={running} hot={running > 0} title="jobs in flight on this box" />
            <StatTile label="queued" value={queued} hot={queued > 0}
                      title="jobs admitted to a queue and not started — the Queue table says why each waits" />
            {d.q.capacity.offbox ? (
              <StatTile label="off-box" value={d.q.capacity.offbox} title="our jobs currently running on a peer" />
            ) : null}
            <StatTile label="warm" value={d.net.readyNow.length}
                      title="models loaded somewhere reachable — here or on a peer" />
            {peers.length > 0 && (
              <StatTile label="peers" value={`${peers.filter((n) => n.up).length}/${peers.length}`}
                        hot={peers.some((n) => !n.up)} title="peers answering their /peer/state probe" />
            )}
          </Box>
        )}
      </Box>

      {!d ? (
        <Typography sx={{ color: "faint", mt: 4 }}>{dead ? "no answer from /ui/data" : "loading…"}</Typography>
      ) : (
        <>
          {/* Hardware first: it decides whether anything below it can run. Each
              card is the inspector's own resource / backend panel. */}
          <Section title="Hardware" card
                   note={<Typography component="span" sx={{ fontSize: 11.5, color: "faint" }}>
                     cards, and the backends that take turns on them
                   </Typography>}>
            {!resources.length && !backends.length && (
              <Typography sx={{ color: "faint" }}>no backends reachable</Typography>
            )}
            {/* Cards are small and uniform, so they tile; backends are detailed
                and vary a lot in height, so they stack full width rather than
                leaving a short one floating beside a tall one. */}
            {resources.length > 0 && (
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 280px))",
                         gap: 1.5, mb: backends.length ? 1.5 : 0 }}>
                {resources.map((r) => <Card key={`r:${r.name}`}><ResourcePanel name={r.name} d={d} /></Card>)}
              </Box>
            )}
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              {backends.map((b) => <Card key={`b:${b.name}`}><BackendPanel b={b} d={d} ctx={ctx} /></Card>)}
            </Box>
          </Section>

          <Section title="Queue" card>
            <QueueTable d={d} />
          </Section>

          <Section title="Models" card>
            <ModelsTable d={d} ctx={ctx} />
          </Section>

          <Section title="Peers" card>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              <Card><SelfPanel d={d} ctx={ctx} /></Card>
              {peers.map((n) => <Card key={n.name}><PeerPanel n={n} d={d} ctx={ctx} /></Card>)}
            </Box>
          </Section>

          <Section title="Last 10 minutes" card>
            <History d={d} />
          </Section>
        </>
      )}

      <Typography sx={{ mt: 4, pt: 1.5, borderTop: "1px solid", borderColor: "line", color: "faint", fontSize: 11.5 }}>
        Polls <Box component="code" sx={{ fontFamily: MONO, fontSize: 11 }}>/ui/data</Box> every 3s. The same
        facts as the graph, laid out to read top to bottom instead of by clicking. Forward the port over SSH
        rather than widening the bind.
      </Typography>
    </Container>
  );
}
