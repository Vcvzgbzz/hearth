/**
 * The status page: an HTML shell with the compiled console inlined into it.
 *
 * This file used to BE the page — 1400 lines of HTML, CSS and DOM code inside a
 * TypeScript template literal, where every backtick and dollar-brace had to be escaped
 * and nothing type-checked the payload it consumed. That escaping broke the
 * page repeatedly, including twice in ways tsc could not see: a `\"` collapses
 * to a bare `"` on the way out, terminating the emitted string, and the browser
 * then renders a completely blank page because the whole script died at parse
 * time. The real source now lives in src/ui/ as ordinary .tsx, and esbuild
 * turns it into dist/ui-client.js at build time.
 *
 * Still one response, deliberately. Serving the bundle from its own path would
 * mean adding it to UI_PATHS on the standalone listener and to the loopback
 * gate on the main one — an edit to a privilege boundary, in two places, to
 * save a round trip on a page reached over an SSH tunnel.
 *
 * React, MUI and emotion are bundled in here and are devDependencies: nothing
 * is added to what `npm install @vcvzgbzz/hearth` pulls down, and `files`
 * already ships dist.
 */
import { readFileSync } from "node:fs";

/**
 * The compiled console.
 *
 * Beside this file once built (dist/ui.js next to dist/ui-client.js). The
 * fallback is for running from source — `npm run dev` and the tests both load
 * src/ui.ts through tsx, where the sibling does not exist. `npm run build:ui`
 * runs before the tests for exactly this reason.
 */
function clientBundle(): string {
  try {
    return inlineable(readFileSync(new URL("./ui-client.js", import.meta.url), "utf8"));
  } catch {
    return inlineable(readFileSync(new URL("../dist/ui-client.js", import.meta.url), "utf8"));
  }
}

/**
 * Make a bundle safe to sit inside a `<script>` element.
 *
 * The HTML parser ends the script at the first literal `</script`, wherever it
 * appears — inside a string literal included. Nothing in the current bundle
 * contains one, which is precisely why this would be found the hard way, on
 * some future dependency bump, as a blank page.
 */
const inlineable = (js: string): string => js.replace(/<\/script/gi, "<\\/script");

export const UI_HTML = `<title>Hearth Console</title>
<!-- Without this a phone lays the page out at a 980px virtual viewport and
     zooms out, so the responsive rules never fire — the breakpoints were dead
     code. Caught by measuring the layout viewport on a 375px device, not by
     reading the CSS. -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* The page background, before React has mounted. CssBaseline paints the same
     colours a moment later; without these the first frame is white, which on a
     dark theme is a flash you notice every reload. Both swatches come from
     src/ui/theme.ts and must be kept in step with it. */
  html { background: #DDD1C7; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { html { background: #201f2c; } }
  body { margin: 0; }
</style>
<div id="root"></div>
<script>${clientBundle()}</script>
`;
