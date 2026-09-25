/**
 * The dashboard view: every number down one scroll, built from the same tables and panels
 * the graph uses so the two cannot disagree. Presentational; the shell owns poll and theme.
 */
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

import { Identity, Legend, Row, Section, Spacer, Vitals } from "./bits.js";
import {
  BackendPanel, PanelHeadFor, PeerPanel, ResourcePanel, SelfPanel, type Ctx,
} from "./inspect.js";
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

export default function Dashboard({ d, ctx, dead, live, menu }: {
  d: UiData | null; ctx: Ctx; dead: boolean; live: boolean; menu?: ReactNode;
}) {
  const self = d?.net.nodes.find((n) => n.self);
  const peers = (d?.net.nodes ?? []).filter((n) => !n.self);
  const resources = d?.net.resources ?? [];
  const backends = self?.backends ?? [];

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
          <Identity name={self?.name} dead={dead} live={live} />
          <Spacer />
          {d?.q.capacity.resident && (
            <Typography component="span" sx={{ fontFamily: MONO, fontSize: 11, color: "text.secondary" }}>
              resident <Box component="span" sx={{ color: "success.main" }}>{d.q.capacity.resident}</Box>
            </Typography>
          )}
        </Row>
        {d && <Vitals d={d} columns="repeat(auto-fit, minmax(120px, 1fr))" />}
      </Box>

      {!d ? (
        <Typography sx={{ color: "faint", mt: 4 }}>
          {dead ? `no answer from ${live ? "/ui/events" : "/ui/data"}` : "loading…"}
        </Typography>
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
                {resources.map((r) => (
                  <Card key={`r:${r.name}`}>
                    <PanelHeadFor d={d} sel={{ kind: "resource", id: r.name }} />
                    <ResourcePanel name={r.name} d={d} />
                  </Card>
                ))}
              </Box>
            )}
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              {backends.map((b) => (
                <Card key={`b:${b.name}`}>
                  <PanelHeadFor d={d} sel={{ kind: "backend", id: b.name }} />
                  <BackendPanel b={b} d={d} ctx={ctx} />
                </Card>
              ))}
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
              <Card>
                <PanelHeadFor d={d} sel={{ kind: "self" }} />
                <SelfPanel d={d} ctx={ctx} />
              </Card>
              {peers.map((n) => (
                <Card key={n.name}>
                  <PanelHeadFor d={d} sel={{ kind: "peer", id: n.name }} />
                  <PeerPanel n={n} d={d} ctx={ctx} />
                </Card>
              ))}
            </Box>
          </Section>

          <Section title="Last 10 minutes" card>
            <History d={d} />
          </Section>
        </>
      )}

      <Box sx={{ mt: 4, pt: 1.5, borderTop: "1px solid", borderColor: "line" }}>
        <Legend />
      </Box>

      <Typography sx={{ mt: 1.5, color: "faint", fontSize: 11.5 }}>
        {live ? "Pushed from " : "Polls "}
        <Box component="code" sx={{ fontFamily: MONO, fontSize: 11 }}>{live ? "/ui/events" : "/ui/data"}</Box>
        {live ? " as it changes." : " every 3s."} The same
        facts as the graph, laid out to read top to bottom instead of by clicking. Forward the port over SSH
        rather than widening the bind.
      </Typography>
    </Container>
  );
}
