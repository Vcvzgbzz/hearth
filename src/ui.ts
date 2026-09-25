/**
 * The status page: an HTML shell with the compiled console (src/ui/, built by esbuild)
 * inlined, so it stays one response behind the same privilege gate.
 */
import { readFileSync } from "node:fs";

/** The compiled console, beside this file once built; the fallback serves tsx runs of src/. */
function clientBundle(): string {
  try {
    return inlineable(readFileSync(new URL("./ui-client.js", import.meta.url), "utf8"));
  } catch {
    return inlineable(readFileSync(new URL("../dist/ui-client.js", import.meta.url), "utf8"));
  }
}

/** Escape `</script` so the bundle can sit inside a `<script>` element. */
const inlineable = (js: string): string => js.replace(/<\/script/gi, "<\\/script");

export const UI_HTML = `<title>Hearth Console</title>
<!-- Without this a phone lays the page out at a 980px virtual viewport and
     zooms out, so the responsive rules never fire — the breakpoints were dead
     code. Caught by measuring the layout viewport on a 375px device, not by
     reading the CSS. -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* Background before React mounts, so a dark theme does not flash white. Keep in step with src/ui/theme.ts. */
  html { background: #EFE8DF; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { html { background: #1a1924; } }
  body { margin: 0; }
</style>
<div id="root"></div>
<script>${clientBundle()}</script>
`;
