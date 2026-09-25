/** Primitives both views draw, in one copy so they cannot disagree. Not a component library. */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { type SxProps, type Theme } from "@mui/material/styles";
import { useState } from "react";

import { MONO } from "./theme.js";
import type { UiData } from "./types.js";

/** A horizontal Stack with the two layout props this page uses, now that MUI moved them to `sx`. */
export function Row({ align = "baseline", wrap, component, spacing = 1.5, sx, children }: {
  align?: "baseline" | "center";
  wrap?: boolean;
  /** "span", for a control that sits inside a line of text. */
  component?: "span";
  spacing?: number;
  sx?: SxProps<Theme>;
  children?: React.ReactNode;
}) {
  return (
    <Stack
      direction="row"
      spacing={spacing}
      {...(component ? { component } : {})}
      sx={[{ alignItems: align, ...(wrap ? { flexWrap: "wrap" } : {}) },
           ...(Array.isArray(sx) ? sx : [sx])]}
    >
      {children}
    </Stack>
  );
}

export const mono = { fontFamily: MONO, fontSize: 12.5 } as const;

/** Push what follows to the right. `ml: "auto"` loses to Stack's gap rule, a growing element does not. */
export function Spacer() {
  return <Box component="span" sx={{ flexGrow: 1 }} />;
}

/** The status marker: a dot for the state and a word for the detail, never a pill. */
export function Dot({ color = "faint" }: { color?: string }) {
  return (
    <Box component="span" aria-hidden
         sx={{ fontSize: 8, mr: 0.6, color, position: "relative", top: -2 }}>●</Box>
  );
}

/** A quiet mono label (kind, card, lane), uncoloured: colour here means state, not nouns. */
export function Tag({ title, color = "faint", children }: {
  title?: string;
  color?: string;
  children: React.ReactNode;
}) {
  const el = (
    <Box component="span"
         sx={{ fontFamily: MONO, fontSize: 10.5, color, border: 1,
               borderColor: "divider", borderRadius: 0.5, px: 0.6, py: "1px",
               whiteSpace: "nowrap", cursor: title ? "help" : "inherit" }}>
      {children}
    </Box>
  );
  return title ? <Tooltip title={title}>{el}</Tooltip> : el;
}

/** Copy a block to the clipboard, falling back to selecting it. */
export function CopyButton({ text }: { text: string }) {
  const [label, setLabel] = useState("copy");
  return (
    <Button
      sx={{ mt: 0.75 }}
      onClick={async () => {
        try {
          // Only available in a secure context, which loopback is and a
          // plain-http tailnet address is not, so the prompt below is the real
          // fallback.
          await navigator.clipboard.writeText(text);
          setLabel("copied");
        } catch {
          window.prompt("Copy this:", text);
          setLabel("copy");
        }
        setTimeout(() => setLabel("copy"), 2500);
      }}
    >
      {label}
    </Button>
  );
}

export function Pre({ children }: { children: string }) {
  return (
    <Box component="pre" sx={{
      m: "7px 0 4px", p: "8px 10px", bgcolor: "background.default",
      border: 1, borderColor: "divider", borderRadius: 1, overflowX: "auto",
      color: "text.secondary", fontSize: 11.5, lineHeight: 1.5, userSelect: "all",
      fontFamily: MONO,
    }}>{children}</Box>
  );
}

export function Why({ children }: { children: React.ReactNode }) {
  return <Typography variant="caption" sx={{ color: "faint", display: "block", mt: 0.6 }}>{children}</Typography>;
}

/** A heading with a count beside it and optional controls at the far right. */
export function Section({ title, note, right, children, card }: {
  title: string;
  note?: React.ReactNode;
  right?: React.ReactNode;
  card?: boolean;
  children: React.ReactNode;
}) {
  const header = (
    <Row spacing={1.5} align="baseline" wrap sx={{ mb: card ? 1.5 : 1.5 }}>
      <Typography variant="h2">{title}</Typography>
      {note}
      {right ? <><Spacer />{right}</> : null}
    </Row>
  );
  if (card) {
    return (
      <Box component="section" sx={{
        mt: 3,
        border: "1px solid", borderColor: "line",
        borderRadius: 3,
        p: 2,
        bgcolor: "background.paper",
      }}>
        {header}
        {children}
      </Box>
    );
  }
  return (
    <Box component="section" sx={{ mt: 3 }}>
      {header}
      {children}
    </Box>
  );
}

/** One labelled vital; `hot` paints it amber so the number that changed stands out. */
export function StatTile({ label, value, hot, title, size = "lg" }: {
  label: string;
  /** A string or number, not a node: it is also the tile's accessible name. */
  value: string | number;
  hot?: boolean;
  title: string;
  /** "sm" for the rail, which has 340px for two columns of these. */
  size?: "sm" | "lg";
}) {
  return (
    <Tooltip title={title}>
      <Box component="span"
           aria-label={`${label}: ${value}`}
           sx={{
             display: "inline-flex", flexDirection: "column",
             px: size === "sm" ? 1.25 : 1.5, py: 0.75,
             border: "1px solid", borderColor: hot ? "warning.main" : "divider",
             borderRadius: 3,
             background: "background.default",
             minWidth: "64px",
           }}>
        <Box component="span"
              sx={{
                fontFamily: MONO, fontSize: size === "sm" ? 17 : 20, fontWeight: 700, lineHeight: 1.1,
                color: hot ? "warning.main" : "text.primary",
              }}>
          {value}
        </Box>
        <Box component="span"
             sx={{
               fontFamily: MONO, fontSize: size === "sm" ? 9.5 : 10, color: "faint",
               textTransform: "uppercase", letterSpacing: ".03em",
             }}>
          {label}
        </Box>
      </Box>
    </Tooltip>
  );
}

/** The six vitals, derived once and shared by the rail and the dashboard. */
export function Vitals({ d, size = "lg", columns }: {
  d: UiData;
  size?: "sm" | "lg";
  /** A CSS grid template. The rail has room for two columns; the band tiles. */
  columns: string;
}) {
  const peers = d.net.nodes.filter((n) => !n.self);
  // Only hardware that is actually arbitrated. A shared resource can never have
  // a holder, so counting it would grow the denominator and report the box as
  // less busy the more CPU sidecars it declares.
  const arbitrated = (d.net.resources ?? []).filter((r) => !r.shared);
  const cardsBusy = arbitrated.filter((r) => r.holder).length;
  const running = d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length;
  const queued = Object.values(d.q.capacity.queued).reduce((a, b) => a + b, 0);

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: columns, gap: 1 }}>
      {arbitrated.length > 0 && (
        <StatTile size={size} label="cards busy" value={`${cardsBusy}/${arbitrated.length}`}
                  hot={cardsBusy > 0} title="hardware with a backend running on it right now" />
      )}
      <StatTile size={size} label="running" value={running} hot={running > 0}
                title="jobs in flight on this box" />
      <StatTile size={size} label="queued" value={queued} hot={queued > 0}
                title="jobs admitted to a queue and not started — the Queue table says why each waits" />
      {d.q.capacity.offbox ? (
        <StatTile size={size} label="off-box" value={d.q.capacity.offbox}
                  title="our jobs currently running on a peer" />
      ) : null}
      <StatTile size={size} label="warm" value={d.net.readyNow.length}
                title="models loaded somewhere reachable — here or on a peer" />
      {peers.length > 0 && (
        <StatTile size={size} label="peers" value={`${peers.filter((n) => n.up).length}/${peers.length}`}
                  hot={peers.some((n) => !n.up)} title="peers answering their /peer/state probe" />
      )}
    </Box>
  );
}

/** What the colours mean, at the foot of the rail and the dashboard. */
export function Legend() {
  const items: [string, string, string][] = [
    ["success.main", "scheduled",
     "Work hearth admitted: it took a slot, waited its turn, and the card arbiter can see it."],
    ["warning.main", "forwarded",
     "Work hearth passes straight through without scheduling — image generation arrives on a path it forwards verbatim. It holds no slot, waits for nothing, and the card arbiter cannot see it. Busy either way; managed only when green."],
    ["cold.main", "off-card",
     "Weights that are not on the card. Breathing, it is a model being read in: tens of seconds for a large one, and nothing else can have the card until it lands. Steady, it is a model whose weights did not FIT — part of it is assigned to the host and computed on the CPU, so every token pays for it, not just the first. Whether that part is served from RAM or read off the disk depends on whether the model fits in host RAM. A trade rather than a fault: it is what lets a model too big for the card run at all."],
    ["error.main", "not answering",
     "A peer or a watched backend that has gone quiet on a connection that should be talking."],
  ];
  return (
    <Row spacing={1.5} align="center" wrap sx={{ rowGap: 0.5 }}>
      {items.map(([color, word, title]) => (
        <Tooltip key={word} title={title}>
          <Box component="span" sx={{ fontSize: 10.5, color: "faint", cursor: "help", whiteSpace: "nowrap" }}>
            <Dot color={color} />{word}
          </Box>
        </Tooltip>
      ))}
    </Row>
  );
}

/** Wordmark, node name and connection state. The name stays visible when the connection drops. */
export function Identity({ name, dead, live, size = "lg" }: {
  name: string | undefined;
  dead: boolean;
  /** On the pushed stream rather than the poll. */
  live: boolean;
  size?: "sm" | "lg";
}) {
  const source = live ? "/ui/events" : "/ui/data";
  return (
    <>
      <Typography component="span"
                  sx={{ fontSize: size === "sm" ? 15 : 16, fontWeight: 700, letterSpacing: "-.01em" }}>
        hea<Box component="span" sx={{ color: "success.main" }}>r</Box>th
      </Typography>
      <Tag>{name ?? "—"}</Tag>
      <Tooltip title={dead
        ? `Nothing is coming back from ${source}. The page is showing the last thing it heard.`
        : live
          ? "Changes are pushed as they happen; an idle box sends nothing at all."
          : "Polled every 3s, because the event stream did not connect here."}>
        <Typography component="span" sx={{
          fontFamily: MONO, fontSize: 10.5, cursor: "help",
          color: dead ? "error.main" : "faint",
        }}>
          <Dot color={dead ? "error.main" : "success.main"} />
          {dead ? `no answer from ${source}` : live ? "live" : "polling"}
        </Typography>
      </Tooltip>
    </>
  );
}
