/**
 * The adapter language's syntax: every form it accepts, and every form it refuses with the line and
 * column it broke on. A refusal is a message a config editor shows beside the code, so the place
 * matters as much as the reason.
 */
import assert from "node:assert/strict";

import { compile } from "../src/routing/adapter/index.js";

/** Compile a module whose `request` body is `body`; throws what a wrong file throws. */
const compiles = (body: string, preamble = ""): void => {
  compile("a", `${preamble}export function request(req) {\n${body}\n}\n`);
};

/** A refusal matched by pattern, for the one whose column depends on the nesting cap. */
const refusesMatching = (code: string, re: RegExp): void => {
  assert.throws(() => compile("a", code), (e: unknown) => {
    assert.match(e instanceof Error ? e.message : String(e), re);
    return true;
  });
};

/** The exact refusal a piece of source gets. */
const refuses = (code: string, message: string): void => {
  assert.throws(
    () => compile("a", code),
    (e: unknown) => {
      assert.equal(e instanceof Error ? e.message : String(e), `adapter a: parse error at line ${message}`);
      return true;
    },
    message,
  );
};

// --- the forms the language has ---------------------------------------------

// literals
compiles("const a = 0; const b = 42; const c = 3.5; const d = 1e3; const e = -1; const f = +1;");
compiles('const a = "double"; const b = \'single\'; const c = "a\\n\\t\\"\\\\";');
compiles('const name = "x"; const a = `plain`; const b = `a${name}b${1 + 2}c`;');
compiles("const n = 2; return `x${`y${n}`}z`;");
compiles("const a = true; const b = false; const c = null; const d = undefined;");
compiles("const a = [1, 2, 3]; const b = [...a, 4]; const c = []; const d = [1, ...[2, 3]];");
compiles('const o = { x: 1, y: 2 }; const p = { ...o, z: 3 }; const q = { x }; const r = { "k": 1, 2: 3 }; const s = {};');

// declarations and assignment
compiles("let a = 1; a = 2; a += 3; a -= 4; const b = a;");
compiles("let a = 1; a = a + 1;");

// control flow
compiles("const a = [1, 2]; let n = 0; for (const x of a) { n += x; } for (let x of a) { if (x === 1) continue; }");
compiles('let n = 0; for (const ch of "ab") { n += 1; }');
compiles("let n = 0; while (n < 3) { n += 1; if (n === 2) continue; if (n > 3) break; }");
compiles("const a = 1; if (a === 1) { const b = 2; } else if (a === 2) { const c = 3; } else { const d = 4; }");
compiles("const a = 1 ? 2 : 3; const b = a === 1 ? a : 0;");

// functions, closures and arrows
compiles("function add(a, b) { return a + b; } const x = add(1, 2);");
compiles("function outer() { let n = 0; function inner() { n += 1; return n; } return inner; } const c = outer();");
compiles("const f = (x) => x + 1; const g = (x, y) => { return x + y; }; const h = () => 1; const i = (x) => x;");

// operators, at the precedence the language gives them
compiles("const a = 1 + 2 * 3 - 4 / 2 % 3; const b = !a && a || a ?? 1; const c = 1 < 2 === true !== false; const d = -a + +a;");
compiles("const a = 1; const b = 2; const c = a <= b && a >= b && a < b && a > b;");

// optional chaining, computed access, writes through them
compiles("const o = { p: { q: 1 } }; const f = () => 1; const a = o?.p; const b = o?.p?.q; const c = f?.(); const d = o?.[0];");
compiles("const o = {}; const k = 'x'; o[k] = 1; o[k] += 2; o[k] -= 3; const a = [1]; a[0] = 2; const v = a[a[0]];");

// try, catch, finally, throw, Error
compiles('try { throw new Error("boom"); } catch (e) { const m = e.message; } finally { const done = 1; }');
compiles('try { throw "plain"; } catch (e) { const m = e; }');
compiles("try { const a = 1; } finally { const b = 2; }");
compiles('const e = Error("no new"); const f = new Error("with new");');

// typeof and spread of a string
compiles('const a = typeof 1; const b = [..."ab"];');

// leading export, comments, blank lines
compile("a", "// a comment\nexport function request(req) { return req; /* inline */ }\n");
compile("a", "export function request(req) { return req; }\nexport function response(res, req) { return res; }\n");
compile("a", "export const LIMIT = 10;\nexport function request(req) { return req; }\n");
compile("a", "const LIMIT = 10;\nfunction clamp(n) { return n > LIMIT ? LIMIT : n; }\nexport function request(req) { return clamp(req.n); }\n");

// --- the forms the language refuses -----------------------------------------

// The lexer
refuses('const a = 1;\nconst b = "oops;', '2, column 11: unterminated string');
refuses("const a = 1;\nconst b = `oops;", "2, column 11: unterminated template string");
refuses("const a = 1;\nconst b = 'a\nb';", "2, column 11: unterminated string");
refuses("const a = 1;\n@", '2, column 1: unexpected character "@"');
refuses("const a = 1;\n/* open", "2, column 1: unterminated comment");

// The parser, at a whole line's start so the column is the token's own
const atTop = (line: string): string => `export function request() {\n${line}\n}\n`;
refuses(atTop("class A {}"), "2, column 1: classes are not part of the adapter language");
refuses(atTop("this.x;"), "2, column 1: this is not part of the adapter language");
refuses(atTop("new Array(1);"), "2, column 1: new is only allowed for Error");
refuses(atTop("async function f() {}"), "2, column 1: async and await are not part of the adapter language");
refuses(atTop("await x;"), "2, column 1: async and await are not part of the adapter language");
refuses(atTop("eval(x);"), "2, column 1: eval is not part of the adapter language");
refuses(atTop('import x from "y";'), "2, column 1: import is not part of the adapter language");
refuses(atTop("/re/g.test(x);"), "2, column 1: regex literals are not part of the adapter language");
refuses(atTop("foo: while (true) {}"), "2, column 1: labels are not part of the adapter language");
refuses(atTop("for (const k in o) {}"), "2, column 1: only for...of loops are part of the adapter language");
refuses(atTop("for (;;) {}"), "2, column 1: only for...of loops are part of the adapter language");
refuses(atTop("for (let i = 0; i < 3; i += 1) {}"), "2, column 1: only for...of loops are part of the adapter language");
refuses(atTop("switch (x) {}"), "2, column 1: switch is not part of the adapter language");
refuses(atTop("do {} while (true);"), "2, column 1: do...while is not part of the adapter language");
refuses(atTop("i++;"), "2, column 2: ++ is not part of the adapter language; write += 1 or -= 1 instead");
refuses(atTop("i--;"), "2, column 2: -- is not part of the adapter language; write += 1 or -= 1 instead");
refuses(atTop("a == b;"), "2, column 3: loose equality is not part of the adapter language; write === or !==");
refuses(atTop("const f = function () {};"), "2, column 11: a function must be a declaration or an arrow function");
refuses(atTop("export const x = 1;"), "2, column 1: export is only allowed at the top level");
refuses(atTop("delete req.a;"), "2, column 1: delete is not part of the adapter language");
refuses(atTop("var a = 1;"), "2, column 1: var is not part of the adapter language");
refuses(atTop("void 0;"), "2, column 1: void is not part of the adapter language");
refuses(atTop("in;"), "2, column 1: in is not part of the adapter language");
refuses(atTop("x instanceof y;"), "2, column 3: instanceof is not part of the adapter language");
refusesMatching('export function request() { return ' + "[".repeat(300) + "1" + "]".repeat(300) + "; }", /parse error at line 1, column \d+: the code nests too deeply to read/);
refusesMatching('export function request() { return ' + "!".repeat(300) + "1; }", /parse error at line 1, column \d+: the code nests too deeply to read/);
refuses(atTop("  return );"), "2, column 10: unexpected token )");
refuses(atTop("  return [1, 2;"), "2, column 15: expected ], not ;");
refuses(atTop("  return (1;"), "2, column 12: expected ), not ;");
refuses(atTop('  return { x: 1;'), "2, column 16: expected }, not ;");
refuses("export function request() {", "1, column 27: expected } to close the block");

// The top level holds only consts and functions
refuses("let x = 1;", "1, column 1: the top level may hold only const declarations and functions");
refuses("const a = 1;\nwhile (true) {}", "2, column 1: the top level may hold only const declarations and functions");
refuses('const a = 1;\nconst b = "x";\nrequest(1);', "3, column 1: the top level may hold only const declarations and functions");

// The guard's names are refused in source that names them, not just in data
refuses(atTop("const a = req.__proto__;"), "2, column 15: \"__proto__\" is not a property name the adapter language allows");
refuses(atTop("const a = req.constructor;"), "2, column 15: \"constructor\" is not a property name the adapter language allows");
refuses(atTop("const a = { __proto__: 1 };"), "2, column 13: \"__proto__\" is not a property name the adapter language allows");
refuses(atTop('const a = { "prototype": 1 };'), '2, column 13: "prototype" is not a property name the adapter language allows');

console.log("adapter-parse: ok");
