/** The console: an HTML shell with the compiled bundle and stylesheet inlined, so it is one response. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** A built asset beside this file; the fallback serves tsx runs of src/. */
function asset(name: string): string {
  try {
    return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  } catch {
    return readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8");
  }
}

const THEME = `try{var t=localStorage.getItem("hearth.theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;
const APP = asset("console.js").replace(/<\/script/gi, "<\\/script");
const hashOf = (script: string): string => `'sha256-${createHash("sha256").update(script).digest("base64")}'`;

/** What the page may do: run the two scripts it ships with, talk to this node, and sit in no one's frame. */
export const CONSOLE_CSP = [
  "default-src 'none'",
  `script-src ${hashOf(THEME)} ${hashOf(APP)}`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const CONSOLE_HTML = `<!doctype html>
<title>hearth</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23e65909' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4'/%3E%3C/svg%3E">
<script>${THEME}</script>
<style>${asset("console.css").replace(/<\/style/gi, "<\\/style")}</style>
<div id="root"></div>
<script>${APP}</script>
`;
