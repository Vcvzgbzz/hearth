/**
 * The source of an adapter module, as a line runs it: `request()` and `response()` read out of the
 * file the operator wrote, so the console can show each side where it is used. Pure and read-only:
 * the code is trusted, and nothing here runs or changes it. A module whose sides cannot be told
 * apart is shown whole, which is what a reader needs anyway.
 */
import { readFileSync } from "node:fs";

/** What a module's two sides look like, for a reader: each declaration's text, and the file it is in. */
export interface AdapterSource {
  /** `request()`'s declaration, exactly as written; null when the module declares none. */
  request: string | null;
  /** `response()`'s declaration, exactly as written; null when the module declares none. */
  response: string | null;
  /** The whole module, always: what is shown when the two sides cannot be told apart. */
  whole: string;
  /** Why the sides are not shown apart, when they are not. */
  note?: string;
}

/** The most of a module the console is sent: a file larger than this is not what an adapter is. */
export const SOURCE_MAX = 64 * 1024;

/** Every comment and string body blanked to spaces, the same length, so an offset still points at the code. */
function masked(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const to = end < 0 ? text.length : end;
      blank(i, to);
      i = to;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const to = end < 0 ? text.length : end + 2;
      blank(i, to);
      i = to;
    } else if (c === "'" || c === '"' || c === "`") {
      // A template literal may hold `${ ... }`, which may hold another template: nesting is followed
      // so the quote that closes this one is the right one.
      let j = i + 1;
      let depth = 0;
      while (j < text.length) {
        const d = text[j]!;
        if (d === "\\") { j += 2; continue; }
        if (c === "`" && d === "$" && text[j + 1] === "{") { depth++; j += 2; continue; }
        if (c === "`" && d === "}" && depth > 0) { depth--; j++; continue; }
        if (d === c && depth === 0) { j++; break; }
        j++;
      }
      blank(i + 1, Math.max(i + 1, j - 1));
      i = j;
    } else i++;
  }
  return out.join("");
}

/** Where the code that starts at `from` ends: the `}` that closes a body opened at `open`, or the end of an expression. */
function endOfBody(code: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/** The index just past the `)` that closes the one at `open`. */
function endOfParams(code: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * Where one side's declaration starts and ends in a module's code, or null: a `function request(...)`, a method
 * `request(...) {`, or a property `request: (...) => {` / `request: function (...)`. Only the forms a
 * module actually uses are looked for; one that is written another way is shown whole instead.
 */
function spanOf(code: string, name: "request" | "response"): { start: number; end: number } | null {
  // `function request(` — with `async`, `export` and `export default` allowed before it.
  const declared = new RegExp(`(?<![\\w$])(?:async\\s+)?function\\s+${name}\\s*\\(`, "g");
  // `request(req) {` — a method in an object literal, after a comma or a `{`.
  const method = new RegExp(`(?<![\\w$])${name}\\s*\\(`, "g");
  // `request: (req) => {`, `request: function (req) {`, `request: async (req) => {`.
  const property = new RegExp(`(?<![\\w$])${name}\\s*:\\s*(?:async\\s+)?(?:function\\s*)?\\(`, "g");
  for (const found of [declared, property, method]) {
    found.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = found.exec(code)) !== null) {
      // A name used as a call (`request(req)` inside the code) is not its declaration: the parenthesis
      // must be followed by a body, which a call's is not.
      const paren = m.index + m[0].length - 1;
      const after = endOfParams(code, paren);
      if (after === null) continue;
      let i = after;
      while (i < code.length && /\s/.test(code[i]!)) i++;
      if (code.startsWith("=>", i)) {
        i += 2;
        while (i < code.length && /\s/.test(code[i]!)) i++;
      }
      if (code[i] !== "{") continue;
      const end = endOfBody(code, i);
      if (end === null) continue;
      return { start: m.index, end };
    }
  }
  return null;
}

/**
 * A module's source, split into the two declarations a line calls. Both are found, or the module is
 * shown whole with a note saying why: an adapter that cannot be read this way is still an adapter,
 * and half a module with the other half hidden would be worse than the file.
 */
export function splitAdapterSource(text: string): AdapterSource {
  const long = text.length > SOURCE_MAX;
  const whole = long ? text.slice(0, SOURCE_MAX) : text;
  const sizeNote = long ? `the module is larger than ${SOURCE_MAX / 1024} KB: the first ${SOURCE_MAX / 1024} KB is shown` : undefined;
  const code = masked(whole);
  const request = spanOf(code, "request");
  const response = spanOf(code, "response");
  if (request === null || response === null) {
    const missing = [request === null ? "request()" : null, response === null ? "response()" : null].filter((x): x is string => x !== null);
    return { request: null, response: null, whole, note: sizeNote ?? `no ${missing.join(" or ")} could be read out of the file, so the whole module is shown` };
  }
  return {
    request: whole.slice(request.start, request.end),
    response: whole.slice(response.start, response.end),
    whole,
    ...(sizeNote !== undefined ? { note: sizeNote } : {}),
  };
}

/** A code plugin's file, read and split; null when it cannot be read, which is the node's log's to say. */
export function readAdapterSource(path: string): AdapterSource | null {
  try {
    return splitAdapterSource(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
