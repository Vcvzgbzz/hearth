/**
 * The console.
 *
 * Two views behind one shell. The graph IS the default page: what this box is
 * made of and what is moving through it, with one rail beside it holding every
 * action for whatever is selected, and the tables as drawers you open rather
 * than four screens you scroll past. The dashboard is the same facts laid out to
 * read top to bottom — a menu in the header switches between them, and the choice
 * is remembered. Both are handed the same poll and the same theme from here, and
 * the tables and every backend/peer panel are shared modules, so the two views
 * cannot drift apart.
 *
 * Three structural rules the old page broke, each of which cost something:
 *
 *   One place for actions. A control beside the fact it changes sounds right and
 *   scatters the controls down four sections, which is how the two switches that
 *   decide whether this box federates at all ended up in a heading two screens
 *   down.
 *
 *   Stable identity across polls. Every list here is keyed by something that
 *   survives a refresh, because reconciliation is what keeps a button's in-flight
 *   state alive through the 3s poll.
 *
 *   Motion means traffic. Nothing on this page animates unless something is
 *   really happening, or the graph becomes wallpaper.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CssBaseline from "@mui/material/CssBaseline";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { ThemeProvider } from "@mui/material/styles";
import { Menu01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dot, Row, Spacer, Tag } from "./bits.js";
import Dashboard from "./dashboard.js";
import { Graph, type Sel } from "./graph.js";
import { Inspector, type Ctx } from "./inspect.js";
import { load, setKeyAsker } from "./lib.js";
import { History, ModelsTable, QueueTable } from "./tables.js";
import { makeTheme, MONO } from "./theme.js";
import type { UiData } from "./types.js";

/* ------------------------------------------------------------------ data */

/**
 * The poll, guarded on both sides.
 *
 * /ui/data calls peers.ensureFresh(), which can exceed the 3s interval exactly
 * when a peer is timing out — which is exactly when you are watching. Unguarded,
 * requests stack and an older response can land after a newer one and render
 * stale state over fresh. document.hidden stops a forgotten background tab
 * polling a peer-probing endpoint forever.
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
    // The FIRST load is forced: document.hidden is true more often than you
    // would think — a background tab, a prerender, an embedded pane — and
    // gating the initial fetch on it left the page permanently blank there,
    // waiting on a visibilitychange that may never come.
    poll(true);
    const id = setInterval(() => poll(false), 3000);
    const back = () => { if (!document.hidden) poll(true); };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", back); };
  }, [poll]);

  return { data, dead, refresh: () => poll(true) };
}

/* --------------------------------------------------------------- drawers */

type Drawer = "queue" | "models" | "history" | null;

function DrawerTab({ label, count, hot, open, onClick }: {
  label: string; count?: React.ReactNode; hot?: boolean; open: boolean; onClick: () => void;
}) {
  return (
    <Button onClick={onClick} aria-expanded={open} sx={[
      {
        borderColor: "transparent", borderRadius: 0, px: 1.5, py: 0.75,
        borderBottom: "2px solid", borderBottomColor: "transparent",
        "&:hover": { borderColor: "transparent", borderBottomColor: "line", background: "none" },
      },
      open && {
        color: "text.primary", borderBottomColor: "success.main",
        "&:hover": { borderBottomColor: "success.main" },
      },
    ]}>
      {label}
      {count !== undefined && (
        <Box component="span" sx={{ ml: 0.75, color: hot ? "warning.main" : "faint" }}>{count}</Box>
      )}
    </Button>
  );
}

/* ------------------------------------------------------------ graph view */

function Console({ d, ctx, dead, menu }: {
  d: UiData | null; ctx: Ctx; dead: boolean; menu?: React.ReactNode;
}) {
  const [sel, setSel] = useState<Sel>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const self = d?.net.nodes.find((n) => n.self);
  const queued = d ? Object.values(d.q.capacity.queued).reduce((a, b) => a + b, 0) : 0;
  const running = d ? d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length : 0;

  const toggle = (which: Exclude<Drawer, null>) =>
    setDrawer((cur) => (cur === which ? null : which));

  return (
    <Box sx={{
      // Exactly one viewport on a wide screen, so the drawer bar is always
      // reachable without scrolling and the stage takes whatever is left over.
      minHeight: "100dvh", height: { md: "100dvh" }, overflow: { md: "hidden" },
      display: "flex", flexDirection: "column", bgcolor: "background.default",
    }}>
      {/* Header. Identity and the two facts you would reload the page to check. */}
      <Box component="header" sx={{
        display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap",
        px: 3, py: 1.25, borderBottom: "1px solid", borderColor: "line",
        bgcolor: "background.paper", flexShrink: 0,
      }}>
        {menu}
        <Typography component="span" sx={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.01em" }}>
          hea<Box component="span" sx={{ color: "success.main" }}>r</Box>th
        </Typography>
        <Tag>{dead ? "unreachable" : self?.name ?? "—"}</Tag>
        <Typography component="span" sx={{ fontFamily: MONO, fontSize: 10.5, color: dead ? "error.main" : "faint" }}>
          <Dot color={dead ? "error.main" : "success.main"} />{dead ? "no answer from /ui/data" : "live"}
        </Typography>
        <Spacer />
        {d && (
          <Row spacing={2} align="baseline" sx={{ fontFamily: MONO, fontSize: 11, color: "text.secondary" }}>
            <Box component="span">
              <Box component="b" sx={{ color: running ? "success.main" : "text.primary" }}>{running}</Box> running
            </Box>
            <Box component="span">
              <Box component="b" sx={{ color: queued ? "warning.main" : "text.primary" }}>{queued}</Box> queued
            </Box>
            {d.q.capacity.resident && (
              <Tooltip title="the first model currently loaded on this node">
                <Box component="span" sx={{ cursor: "help" }}>
                  resident <Box component="span" sx={{ color: "success.main" }}>{d.q.capacity.resident}</Box>
                </Box>
              </Tooltip>
            )}
          </Row>
        )}
      </Box>

      {!d ? (
        <Typography sx={{ color: "faint", p: 4 }}>{dead ? "no answer from /ui/data" : "loading…"}</Typography>
      ) : (
        <>
          {/* Stage and rail. The rail drops under the stage on a narrow screen
              rather than shrinking into a column of wrapped words. */}
          <Box sx={{
            flex: "1 1 auto", minHeight: 0,
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "minmax(0,1fr) 340px" },
          }}>
            <Box sx={{ p: 2, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Graph d={d} sel={sel} onSelect={setSel} />
            </Box>
            <Inspector d={d} sel={sel} ctx={ctx} onSelect={setSel} />
          </Box>

          {/* Drawers. Closed by default: the graph answers most visits, and a
              page that opens with three tables under it is the page this
              replaced. */}
          <Box component="footer" sx={{
            borderTop: "1px solid", borderColor: "line", bgcolor: "background.paper", flexShrink: 0,
          }}>
            <Row spacing={0} align="center" sx={{ px: 1.5, borderBottom: drawer ? "1px solid" : "none", borderColor: "line" }}>
              <DrawerTab label="queue" count={d.q.jobs.length} hot={queued > 0}
                         open={drawer === "queue"} onClick={() => toggle("queue")} />
              <DrawerTab label="models" count={`${d.net.readyNow.length}/${d.net.available.length}`}
                         open={drawer === "models"} onClick={() => toggle("models")} />
              <DrawerTab label="last 10 minutes"
                         open={drawer === "history"} onClick={() => toggle("history")} />
              <Spacer />
              <Typography sx={{ fontFamily: MONO, fontSize: 10, color: "faint", pr: 1.5, display: { xs: "none", sm: "block" } }}>
                polls /ui/data every 3s
              </Typography>
            </Row>
            {drawer && (
              <Box sx={{ p: 2, maxHeight: "45dvh", overflowY: "auto" }}>
                {drawer === "queue" && <QueueTable d={d} />}
                {drawer === "models" && <ModelsTable d={d} ctx={ctx} onSelect={setSel} />}
                {drawer === "history" && <History d={d} />}
              </Box>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}

/* -------------------------------------------------------------- the key */

/**
 * Asking for the API key, in the page.
 *
 * This was `window.prompt`, which has room for a sentence and no room for the
 * two things an operator actually needs: what this key IS, and where to get it.
 * So the first write on a keyed node opened a bare box asking for a secret, with
 * a rejection indistinguishable from a click that did nothing.
 *
 * Mounted once by the shell and handed to lib.ts, which resolves the promise it
 * hands back — so `postWrite` can wait for a person without the write path
 * knowing anything about React.
 */
function KeyDialog() {
  const [resolve, setResolve] = useState<((k: string | null) => void) | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    setKeyAsker(() => new Promise<string | null>((r) => {
      setValue("");
      // Stored through a setter function, or React would call the resolver
      // instead of storing it — useState treats a function argument as an
      // updater, and a promise that resolves itself on mount is a fine way to
      // spend an afternoon.
      setResolve(() => r);
    }));
  }, []);

  const done = (k: string | null) => {
    resolve?.(k);
    setResolve(null);
  };

  return (
    <Dialog open={resolve !== null} onClose={() => done(null)} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>
        This node needs a key for controls
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", mb: 1.5, lineHeight: 1.7 }}>
          Reading is open on this socket; changing something is not. The key is stored
          in this browser only and never leaves it. If the node refuses it you will be
          told on the control, and asked again next time.
        </Typography>
        <TextField
          autoFocus fullWidth type="password" value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) done(value.trim()); }}
          slotProps={{ htmlInput: { "aria-label": "API key", spellCheck: false } }}
        />
        <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: "faint", mt: 1.5 }}>
          {/* Points at the CONFIG, not at anyone's box. An earlier version of
              this line printed the exact ssh command that fetches the key on the
              node it was written for — a host alias and an env path, baked into
              a public repo and wrong for every other operator. Whoever is
              looking at this dialog knows where their own config lives. */}
          any key from this node&apos;s apiKeys list
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => done(null)}>cancel</Button>
        <Button onClick={() => done(value.trim() || null)} disabled={!value.trim()}>use key</Button>
      </DialogActions>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ views */

/**
 * Which view is showing, remembered per browser.
 *
 * The graph is the default — it is what a visit is usually for. An operator who
 * prefers the dashboard's every-number-at-once read should not re-pick it every
 * reload, so the choice is stored. localStorage can throw (private mode, storage
 * disabled), and a page that refuses to render because it could not remember a
 * preference is worse than one that forgets it, so both sides are guarded and
 * fall back to the graph.
 */
type View = "graph" | "dashboard";
const VIEW_KEY = "hearth.view";

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try { return localStorage.getItem(VIEW_KEY) === "dashboard" ? "dashboard" : "graph"; }
    catch { return "graph"; }
  });
  const choose = useCallback((v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: this session only */ }
  }, []);
  return [view, choose];
}

/** The view switcher: both views folded behind one menu in the header. */
function ViewMenu({ view, onView }: { view: View; onView: (v: View) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const pick = (v: View) => { onView(v); setAnchor(null); };
  return (
    <>
      <IconButton
        aria-label="switch view" aria-haspopup="menu" aria-expanded={Boolean(anchor)}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ borderRadius: 1.5, p: 0.5, color: "text.secondary", "&:hover": { color: "text.primary" } }}
      >
        <HugeiconsIcon icon={Menu01Icon} size={18} color="currentColor" strokeWidth={2}
                       aria-hidden style={{ display: "block" }} />
      </IconButton>
      <Menu
        anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        <MenuItem selected={view === "graph"} onClick={() => pick("graph")}>Graph</MenuItem>
        <MenuItem selected={view === "dashboard"} onClick={() => pick("dashboard")}>Dashboard</MenuItem>
      </Menu>
    </>
  );
}

/* ------------------------------------------------------------------ page */

export default function App() {
  const { data, dead, refresh } = useData();
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useMemo(() => makeTheme(prefersDark ? "dark" : "light"), [prefersDark]);
  const [view, setView] = useView();
  const ctx: Ctx = {
    canWarm: data?.canWarm ?? false,
    control: data?.control ?? "off",
    refresh,
  };
  // One menu element, handed to whichever view is mounted so it sits inside that
  // view's own header rather than floating over it.
  const menu = <ViewMenu view={view} onView={setView} />;
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <KeyDialog />
      {view === "graph"
        ? <Console d={data} ctx={ctx} dead={dead} menu={menu} />
        : <Dashboard d={data} ctx={ctx} dead={dead} menu={menu} />}
    </ThemeProvider>
  );
}
