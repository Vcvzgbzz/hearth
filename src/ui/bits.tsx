/**
 * The handful of primitives every section of the page is built from.
 *
 * These lived in App.tsx while the page was one file. They moved out when the
 * hardware section arrived and needed the same three of them, which is the only
 * reason this file exists — it is not a component library and should not grow
 * into one. Anything used in exactly one place belongs beside that place.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { type SxProps, type Theme } from "@mui/material/styles";
import { useState } from "react";

import { MONO } from "./theme.js";

/**
 * A horizontal Stack with the two system props this page uses.
 *
 * MUI removed system props (alignItems, flexWrap) from its components in v6 --
 * they live in `sx` now. A dozen call sites here want the same two, so they
 * fold in once rather than at each one.
 */
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

/**
 * Push everything after this to the right.
 *
 * `ml: "auto"` on the child is the obvious way and it silently does nothing
 * here: Stack spaces its children with a `& > :not(style) ~ :not(style)`
 * margin rule, whose specificity beats the plain emotion class `sx` generates,
 * so the auto margin is overwritten by the gap every time. Every "right-hand
 * numbers" group on this page was quietly left-aligned because of it. A
 * growing element is not subject to that and needs no !important.
 */
export function Spacer() {
  return <Box component="span" sx={{ flexGrow: 1 }} />;
}

/**
 * The status marker, everywhere.
 *
 * A small dot and a WORD, never a pill. Pills everywhere is the look this page
 * was deliberately built away from, and colour on this page means one of
 * exactly three things — live, working, broken — so the dot carries the state
 * and the word carries the detail.
 */
export function Dot({ color = "faint" }: { color?: string }) {
  return (
    <Box component="span" aria-hidden
         sx={{ fontSize: 8, mr: 0.6, color, position: "relative", top: -2 }}>●</Box>
  );
}

/**
 * A quiet mono tag: a backend's kind, a card name, a lane.
 *
 * Deliberately not a coloured chip. Colour on this page is instrument
 * semantics — live, working, broken — and a tag is none of those, it is a
 * label. Painting them would spend the palette on nouns.
 */
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

/**
 * A heading, a count beside it, and optionally a control group at the far right.
 *
 * `note` sits next to the title because it is a subtitle — "3 of 12 loaded"
 * belongs to the word above it, not to the other end of a 900px rule. `right`
 * is for the controls that do.
 */
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

/**
 * One vital, and whether it is worth looking at.
 *
 * `hot` paints the number amber — "working", the middle state in the palette's
 * three. Everything quiet stays quiet, so the one number that has changed is
 * findable without reading the row.
 *
 * StatTile replaced Vital (a bare bold number) with a labelled box so each
 * vital is legible on its own, not just by position in a list.
 */
export function StatTile({ label, value, hot, title }: {
  label: string;
  value: React.ReactNode;
  hot?: boolean;
  title: string;
}) {
  return (
    <Tooltip title={title}>
      <Box component="span"
           sx={{
             display: "inline-flex", flexDirection: "column",
             px: 1.5, py: 0.75,
             border: "1px solid", borderColor: hot ? "warning.main" : "divider",
             borderRadius: 3,
             background: "background.default",
             minWidth: "64px",
           }}>
        <Box component="span"
              sx={{
                fontFamily: MONO, fontSize: 20, fontWeight: 700, lineHeight: 1.1,
                color: hot ? "warning.main" : "text.primary",
              }}>
          {value}
        </Box>
        <Box component="span"
             sx={{
               fontFamily: MONO, fontSize: 10, color: "faint",
               textTransform: "uppercase", letterSpacing: ".03em",
             }}>
          {label}
        </Box>
      </Box>
    </Tooltip>
  );
}
