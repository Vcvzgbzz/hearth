/**
 * The palette, unchanged, expressed as a MUI theme.
 *
 * Colour is instrument semantics here, not decoration:
 *
 *   phosphor green  resident · live · ready     -> success
 *   signal amber    working · hot               -> warning
 *   fault red       broken                      -> error
 *
 * Only the five swatches and the two type faces are kept. NOT a panelled
 * look: this page is a dense table and stays one, so the overrides below flatten
 * MUI's default radii, shadows and 44px-tall controls back down.
 *
 * `fontFamily` is set explicitly because MUI's default is Roboto loaded from
 * Google's CDN. This page is served on loopback behind an SSH tunnel and is
 * routinely opened with no route to the internet at all, so the default would
 * silently fall back to a serif.
 */
import { createTheme, type Theme } from "@mui/material/styles";

export const MONO =
  'ui-monospace,"SF Mono",SFMono-Regular,"Cascadia Mono","Roboto Mono",Menlo,Consolas,monospace';
const SANS = 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

declare module "@mui/material/styles" {
  interface Palette {
    /** Present but recessive — axis labels, backend lines, "nothing here". */
    faint: string;
    /** The heavier rule, under section headings and table heads. */
    line: string;
  }
  interface PaletteOptions {
    faint: string;
    line: string;
  }
}

const swatches = {
  dark: {
    bg: "#201f2c", raise: "#4B4A67", line: "#5b597a", hair: "#302f42",
    ink: "#DDD1C7", dim: "#a7abae", faint: "#6f7573",
    live: "#8DB580", work: "#f59e0b", fault: "#f87171",
  },
  light: {
    bg: "#DDD1C7", raise: "#f2ece5", line: "#cfc6ba", hair: "#eae2d8",
    ink: "#4B4A67", dim: "#7E8987", faint: "#a8a6b0",
    live: "#8DB580", work: "#b45309", fault: "#dc2626",
  },
} as const;

export function makeTheme(mode: "light" | "dark"): Theme {
  const c = swatches[mode];
  return createTheme({
    palette: {
      mode,
      background: { default: c.bg, paper: c.raise },
      text: { primary: c.ink, secondary: c.dim, disabled: c.faint },
      success: { main: c.live },
      warning: { main: c.work },
      error: { main: c.fault },
      divider: c.hair,
      faint: c.faint,
      line: c.line,
    },
    typography: {
      fontFamily: SANS,
      fontSize: 14,
      // Section headings are a quiet label above a rule, not a floating caps chip.
      h2: { fontSize: 13, fontWeight: 600, margin: 0 },
      body2: { fontSize: 12.5 },
      caption: { fontSize: 11.5 },
    },
    shape: { borderRadius: 2 },
    components: {
      // MUI's table is built for a roomy data grid. This one is a dense readout,
      // and its rows were 53px tall before these.
      MuiTableCell: {
        styleOverrides: {
          root: { padding: "7px 12px 7px 0", borderBottom: `1px solid ${c.hair}`, verticalAlign: "baseline" },
          head: { fontWeight: 500, fontSize: 11.5, color: c.dim, padding: "0 12px 6px 0", borderBottom: `1px solid ${c.line}` },
        },
      },
      MuiButton: {
        defaultProps: { size: "small", variant: "outlined", color: "inherit" },
        styleOverrides: {
          root: {
            fontFamily: MONO, fontSize: 11.5, textTransform: "none", minWidth: 0,
            padding: "1px 7px", lineHeight: 1.5, color: c.dim, borderColor: c.line,
            "&:hover": { color: c.live, borderColor: c.live, background: "none" },
            "&.Mui-disabled": { color: c.faint, borderColor: c.line },
          },
        },
      },
      MuiTextField: { defaultProps: { size: "small", variant: "outlined" } },
      MuiInputBase: {
        styleOverrides: { input: { fontFamily: MONO, fontSize: 11.5, padding: "1px 5px" } },
      },
      MuiTooltip: {
        defaultProps: { enterDelay: 200, placement: "top" },
        styleOverrides: {
          tooltip: {
            background: c.raise, color: c.ink, border: `1px solid ${c.line}`,
            fontFamily: MONO, fontSize: 12, fontWeight: 400,
            boxShadow: "0 6px 20px rgba(0,0,0,.35)", maxWidth: 420,
          },
        },
      },
      // A disclosure, not a card: no elevation, no 48px header, no divider line.
      MuiAccordion: {
        defaultProps: { disableGutters: true, elevation: 0, square: true },
        styleOverrides: {
          root: { background: "none", "&:before": { display: "none" } },
        },
      },
      MuiAccordionSummary: {
        styleOverrides: {
          root: { minHeight: 0, padding: 0, "&.Mui-expanded": { minHeight: 0 } },
          content: { margin: 0, "&.Mui-expanded": { margin: 0 } },
        },
      },
      MuiAccordionDetails: { styleOverrides: { root: { padding: "6px 0 4px" } } },
      MuiSwitch: { defaultProps: { size: "small", color: "success" } },
    },
  });
}
