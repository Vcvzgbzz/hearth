/**
 * Running adapter code: what expressions evaluate to, how closures, `try` and the module's frozen
 * top level behave, and every name on the builtin whitelist.
 */
import assert from "node:assert/strict";

import { call, compile } from "../src/routing/adapter/index.js";

/** Compile a module whose `request` body is `body`, and run it. */
function run(body: string, preamble = "", arg: unknown = {}): unknown {
  const module = compile("t", `${preamble}export function request(req) {\n${body}\n}\n`);
  return call(module, "request", [arg], 1000);
}

/** Run `src` as the request body: an expression is returned, a run of statements is run as written. */
const STATEMENT = /^(let|const|try|if|for|while|return|throw)\b/;
const value = (src: string, arg: unknown = {}): unknown => run(STATEMENT.test(src) ? src : `return (${src});`, "", arg);

/** What a run throws, as a message to match. */
const refuses = (body: string, re: RegExp, preamble = "", arg: unknown = {}): void => {
  assert.throws(() => run(body, preamble, arg), re, body);
};

// --- expressions ------------------------------------------------------------

// arithmetic, and the precedence that decides it
assert.equal(value("1 + 2 * 3"), 7);
assert.equal(value("(1 + 2) * 3"), 9);
assert.equal(value("7 / 2"), 3.5);
assert.equal(value("7 % 2"), 1);
assert.equal(value("-3 + +4"), 1);
assert.equal(value("2 * 3 % 4"), 2);

// strings
assert.equal(value("'a' + 1"), "a1");
assert.equal(value("1 + 'a'"), "1a");
assert.equal(value("'a' + 'b'"), "ab");
assert.equal(value('"a" === \'a\''), true);
assert.equal(value("'5' * 2"), 10);
assert.equal(value("`a${1 + 1}b`"), "a2b");
assert.equal(value("`${'x'}${'y'}`"), "xy");

// booleans, null, undefined, typeof
assert.equal(value("!0"), true);
assert.equal(value("!''"), true);
assert.equal(value("typeof 1"), "number");
assert.equal(value("typeof 'a'"), "string");
assert.equal(value("typeof true"), "boolean");
assert.equal(value("typeof undefined"), "undefined");
assert.equal(value("typeof null"), "object");
assert.equal(value("typeof []"), "object");
assert.equal(value("typeof (() => 1)"), "function");
assert.equal(value("typeof nothingDeclaredHere"), "undefined");

// comparisons and equality
assert.equal(value("3 < 4"), true);
assert.equal(value("'a' < 'b'"), true);
assert.equal(value("'10' < '9'"), true);
assert.equal(value("'10' < 9"), false);
assert.equal(value("1 === 1"), true);
assert.equal(value("1 === '1'"), false);
assert.equal(value("1 !== 2"), true);
assert.equal(value("null === null"), true);
assert.equal(value("null === undefined"), false);
assert.equal(value("(0 / 0) === (0 / 0)"), false);

// && || ?? and the conditional, which yield an operand rather than a boolean
assert.equal(value("0 || 'x'"), "x");
assert.equal(value("1 && 'y'"), "y");
assert.equal(value("null ?? 'd'"), "d");
assert.equal(value("undefined ?? 'd'"), "d");
assert.equal(value("0 ?? 'd'"), 0);
assert.equal(value("false ? 1 : 2"), 2);

// arrays, objects, spread
assert.deepEqual(value("[1, ...[2, 3]]"), [1, 2, 3]);
assert.deepEqual(value("[...'ab']"), ["a", "b"]);
assert.deepEqual(value("({ ...{ a: 1 }, b: 2 })"), { a: 1, b: 2 });
assert.deepEqual(value("({ a: 1, 'b': 2, 3: 'three' })"), { a: 1, b: 2, 3: "three" });
assert.deepEqual(value("[1, 2, 3].slice(1)"), [2, 3]);

// member access, computed access, and optional chaining on nothing
assert.equal(value("({ a: 1 }).a"), 1);
assert.equal(value("({ a: 1 })['a']"), 1);
assert.equal(value("[10, 20][1]"), 20);
assert.equal(value("'abc'.length"), 3);
assert.equal(value("[1, 2].length"), 2);
assert.equal(value("({}).missing"), undefined);
assert.equal(value("null?.x"), undefined);
assert.equal(value("undefined?.x"), undefined);
assert.equal(value("({ a: null }).a?.b"), undefined);
assert.equal(value("({ a: null }).a?.b.c"), undefined, "a chain short-circuits");
assert.equal(value("({}).f?.()"), undefined);
assert.equal(value("({ a: 1 }).a?.toString"), undefined, "optional only short-circuits nullish");
refuses("return ({}).missing.x;", /cannot read x of undefined/);

// assignment returns the value it wrote
assert.equal(value("let a = 1; a = 5; return a;"), 5);
assert.equal(value("let a = 1; return (a = 4) + 1;"), 5);
assert.equal(value("let a = 1; a += 2; a -= 1; return a;"), 2);
assert.equal(value("const o = {}; o.x = 1; o.x += 2; return o.x;"), 3);
assert.equal(value("const o = {}; const k = 'a'; o[k] = 9; return o[k];"), 9);
assert.equal(value("const a = [0, 0]; a[1] = 7; return a[1];"), 7);
refuses("let a = 1; a = 2; const b = 1; b = 2;", /cannot assign to b, which a call may not change/);

// --- control flow -----------------------------------------------------------

assert.equal(value("let n = 0; for (const x of [1, 2, 3]) { n += x; } return n;"), 6);
assert.equal(value("let s = ''; for (const ch of 'abc') { s += ch + '-'; } return s;"), "a-b-c-");
assert.equal(value("let n = 0; while (n < 5) { n += 1; } return n;"), 5);
assert.equal(value("let n = 0; for (const x of [1, 2, 3]) { if (x === 2) continue; n += x; } return n;"), 4);
assert.equal(value("let n = 0; while (true) { n += 1; break; } return n;"), 1);
assert.equal(value("let n = 0; for (const x of [1, 2]) { for (const y of [10, 20]) { n += x * y; } } return n;"), 90);
assert.equal(value("if (true) return 'yes'; return 'no';"), "yes");
assert.equal(value("if (false) { return 1; } else { return 2; }"), 2);

// --- functions and closures -------------------------------------------------

const functions = `
function add(a, b) { return a + b; }
const twice = (x) => x * 2;
const shout = (s) => s.toUpperCase();
function factorial(n) { if (n <= 1) return 1; return n * factorial(n - 1); }
export function request() {
  const make = (start) => { let n = start; return () => { n += 1; return n; }; };
  const counter = make(10);
  counter();
  counter();
  return { sum: add(1, 2), double: twice(4), loud: shout("hi"), fact: factorial(5), counted: counter() };
}
`;
assert.deepEqual(call(compile("t", functions), "request", [], 1000), { sum: 3, double: 8, loud: "HI", fact: 120, counted: 13 });

// A function's own `let` may be changed by it; a module-level one may not.
assert.equal(value("let n = 0; return (() => { n += 1; return n; })();"), 1);

// --- try, catch, finally ----------------------------------------------------

assert.equal(value("try { throw new Error('boom'); } catch (e) { return e.message; }"), "boom");
assert.equal(value("try { throw 'plain'; } catch (e) { return e; }"), "plain");
assert.equal(value("try { null.x; } catch (e) { return typeof e; }"), "object");
assert.equal(value("try { null.x; } catch (e) { return e.message; }"), "cannot read x of null");
assert.equal(value("try { throw 42; } catch (e) { return e + 1; }"), 43);
assert.equal(value("let done = false; try { throw new Error('x'); } catch (e) { done = true; } finally { done = true; } return done;"), true);
assert.equal(value("let n = 0; try { throw 'x'; } catch (e) { } finally { n = 1; } return n;"), 1);
assert.equal(value("let n = 0; try { n = 1; } finally { n += 1; } return n;"), 2);
// A returned value still runs the finally, and the finally's own return wins.
assert.equal(value("const f = () => { try { return 1; } finally { return 2; } }; return f();"), 2);
refuses("try { throw new Error('boom'); } catch (e) { } throw new Error('after');", /after/);

// --- frozen module state ----------------------------------------------------

const frozen = "const LIST = [1, 2];\nconst OBJ = { k: 1, nested: { deep: [1] } };\n";
assert.equal(run("return LIST.length;", frozen), 2);
assert.equal(run("return OBJ.nested.deep[0];", frozen), 1);
refuses("LIST.push(3);", /cannot change a value that belongs to the module/, frozen);
refuses("LIST[0] = 9;", /cannot change a value that belongs to the module/, frozen);
refuses("OBJ.k = 9;", /cannot change a value that belongs to the module/, frozen);
refuses("OBJ.nested.deep.push(2);", /cannot change a value that belongs to the module/, frozen);
refuses("OBJ.nested.newKey = 1;", /cannot change a value that belongs to the module/, frozen);
// What a closure captured while the module loaded is module state too: it cannot be written.
refuses("return next();", /cannot assign to n, which a call may not change/, "const next = (() => { let n = 0; return () => { n += 1; return n; }; })();\n");
refuses("request = () => 1;", /cannot assign to request, which a call may not change/);
// A function's own state, made during the call, is its own and may change.
assert.equal(value("const make = () => { let n = 0; return () => { n += 1; return n; }; }; const c = make(); c(); return c();"), 2);

// A copy of frozen state is the call's own, and may be changed.
assert.deepEqual(run("const copy = [...LIST]; copy.push(3); return copy;", frozen), [1, 2, 3]);
assert.deepEqual(run("const copy = { ...OBJ }; copy.k = 9; return copy.k;", frozen), 9);

// --- JSON -------------------------------------------------------------------

assert.deepEqual(value(`JSON.parse('{"a":[1,2],"b":null}')`), { a: [1, 2], b: null });
assert.equal(value("JSON.stringify({ a: 1, b: [true, null, 'x'] })"), '{"a":1,"b":[true,null,"x"]}');
assert.equal(value("JSON.stringify('a\\nb')"), '"a\\nb"');
assert.equal(value("JSON.stringify(undefined)"), undefined);
refuses("JSON.parse('{oops');", /JSON\.parse/);
refuses("JSON.parse('{\"__proto__\":1}');", /"__proto__" is not a property name/);

// --- string methods ---------------------------------------------------------

assert.deepEqual(value("'a,b,c'.split(',')"), ["a", "b", "c"]);
assert.deepEqual(value("'abc'.split('')"), ["a", "b", "c"]);
assert.deepEqual(value("''.split(',')"), [""]);
assert.equal(value("'abcdef'.slice(1, 3)"), "bc");
assert.equal(value("'abcdef'.slice(-2)"), "ef");
assert.equal(value("'  x  '.trim()"), "x");
assert.equal(value("'AbC'.toLowerCase()"), "abc");
assert.equal(value("'AbC'.toUpperCase()"), "ABC");
assert.equal(value("'abc'.startsWith('ab')"), true);
assert.equal(value("'abc'.endsWith('bc')"), true);
assert.equal(value("'abc'.includes('b')"), true);
assert.equal(value("'abc'.indexOf('b')"), 1);
assert.equal(value("'abc'.indexOf('z')"), -1);
assert.equal(value("'a-b-a'.replaceAll('-', '+')"), "a+b+a");
assert.equal(value("'a-b-a'.replaceAll('-', '')"), "aba");
assert.equal(value("'ab'.replaceAll('', '-')"), "-a-b-");
assert.equal(value("'5'.padStart(3, '0')"), "005");
assert.equal(value("'5'.padStart(3)"), "  5");
assert.equal(value("'abc'.padStart(2)"), "abc");
assert.equal(value("'abc'.charAt(1)"), "b");
assert.equal(value("'abc'.charAt(9)"), "");
assert.equal(value("'abc'.charAt(1.5)"), "b");

// --- array methods ----------------------------------------------------------

assert.deepEqual(value("[1, 2, 3].map((x) => x * 2)"), [2, 4, 6]);
assert.deepEqual(value("[1, 2, 3].map((x, i) => x + i)"), [1, 3, 5]);
assert.deepEqual(value("[1, 2, 3, 4].filter((x) => x % 2 === 0)"), [2, 4]);
assert.equal(value("[1, 2, 3].find((x) => x > 1)"), 2);
assert.equal(value("[1, 2, 3].findIndex((x) => x > 1)"), 1);
assert.equal(value("[1, 2, 3].find((x) => x > 9)"), undefined);
assert.equal(value("[1, 2, 3].some((x) => x === 2)"), true);
assert.equal(value("[1, 2, 3].every((x) => x > 0)"), true);
assert.equal(value("[1, 2, 3].every((x) => x > 1)"), false);
assert.equal(value("[1, 2, 3].reduce((a, b) => a + b)"), 6);
assert.equal(value("[1, 2, 3].reduce((a, b) => a + b, 10)"), 16);
refuses("return [].reduce((a, b) => a + b);", /reduce of an empty array/);
assert.deepEqual(value("[1, 2, 3].slice(1)"), [2, 3]);
assert.deepEqual(value("[1, 2, 3].slice(0, -1)"), [1, 2]);
assert.deepEqual(value("[1, 2].concat([3], 4)"), [1, 2, 3, 4]);
assert.equal(value("[1, 2].includes(2)"), true);
assert.equal(value("[1, 2].includes('2')"), false);
assert.equal(value("[1, 2, 2].indexOf(2)"), 1);
assert.equal(value("[1, 2].indexOf(9)"), -1);
assert.equal(value("[1, 2, 3].join('-')"), "1-2-3");
assert.equal(value("[1, null, undefined, 2].join('-')"), "1---2");
assert.equal(value("[1, 2].join()"), "1,2");
assert.deepEqual(value("const a = [1]; return [a.push(2), a.length, a];"), [2, 2, [1, 2]]);
assert.deepEqual(value("[3, 1, 2].sort((a, b) => a - b)"), [1, 2, 3]);
assert.deepEqual(value("[3, 1, 2].sort((a, b) => b - a)"), [3, 2, 1]);
assert.deepEqual(value("['b', 'a'].sort((a, b) => (a < b ? -1 : 1))"), ["a", "b"]);
assert.deepEqual(value("const a = [2, 1]; a.sort((x, y) => x - y); return a;"), [1, 2], "sort is in place");

// --- object functions -------------------------------------------------------

assert.deepEqual(value("Object.keys({ a: 1, b: 2 })"), ["a", "b"]);
assert.deepEqual(value("Object.values({ a: 1, b: 2 })"), [1, 2]);
assert.deepEqual(value("Object.entries({ a: 1 })"), [["a", 1]]);
assert.deepEqual(value("Object.fromEntries([['a', 1], ['b', 2]])"), { a: 1, b: 2 });
refuses("Object.fromEntries([['__proto__', 1]]);", /"__proto__" is not a property name/);

// --- Math -------------------------------------------------------------------

assert.equal(value("Math.abs(-2)"), 2);
assert.equal(value("Math.ceil(1.2)"), 2);
assert.equal(value("Math.floor(1.8)"), 1);
assert.equal(value("Math.round(1.5)"), 2);
assert.equal(value("Math.sqrt(9)"), 3);
assert.equal(value("Math.pow(2, 10)"), 1024);
assert.equal(value("Math.min(3, 1, 2)"), 1);
assert.equal(value("Math.max(3, 1, 2)"), 3);
assert.equal(value("Math.PI"), Math.PI);
assert.equal(value("Math.E"), Math.E);
const random = value("Math.random()");
assert.equal(typeof random, "number");
assert.ok((random as number) >= 0 && (random as number) < 1);

// --- type conversions and URL encoding --------------------------------------

assert.equal(value("Number('12')"), 12);
assert.equal(value("Number('')"), 0);
assert.equal(value("Number(null)"), 0);
assert.equal(value("Number('x')"), Number.NaN);
assert.equal(value("String(12)"), "12");
assert.equal(value("String(null)"), "null");
assert.equal(value("String([1, 2])"), "1,2");
assert.equal(value("Boolean(0)"), false);
assert.equal(value("Boolean('')"), false);
assert.equal(value("Boolean([])"), true);
assert.equal(value("parseInt('42px')"), 42);
assert.equal(value("parseInt('ff', 16)"), 255);
assert.equal(value("parseFloat('1.5x')"), 1.5);
assert.equal(value("isNaN('x')"), true);
assert.equal(value("isNaN('1')"), false);
assert.equal(value("encodeURIComponent('a b&c')"), "a%20b%26c");
assert.equal(value("decodeURIComponent('a%20b')"), "a b");
refuses("decodeURIComponent('%');", /not a valid percent-encoded string/);

// --- errors, thrown and made ------------------------------------------------

assert.equal(value("const e = new Error('no new'); return e.message;"), "no new");
assert.equal(value("const e = Error('plain call'); return e.message;"), "plain call");
assert.equal(value("try { throw new Error('a' + 1); } catch (e) { return e.message; }"), "a1");
assert.equal(value("try { (undefined)(); } catch (e) { return e.message; }"), "undefined is not a function");
assert.equal(value("const o = {}; try { o.x.y = 1; } catch (e) { return e.message; }"), "cannot set y of undefined");

// --- the sandbox has nothing of the host ------------------------------------

const probe = value(`({
  process: typeof process, require: typeof require, fetch: typeof fetch, module: typeof module,
  console: typeof console, Buffer: typeof Buffer, window: typeof window, document: typeof document,
  globalThis: typeof globalThis, Promise: typeof Promise, setTimeout: typeof setTimeout,
  eval: "refused at parse time",
})`);
assert.deepEqual(probe, {
  process: "undefined",
  require: "undefined",
  fetch: "undefined",
  module: "undefined",
  console: "undefined",
  Buffer: "undefined",
  window: "undefined",
  document: "undefined",
  globalThis: "undefined",
  Promise: "undefined",
  setTimeout: "undefined",
  eval: "refused at parse time",
});
refuses("return process;", /process is not defined/);

// --- sides a module does not define -----------------------------------------

const onlyResponse = compile("t", "export function response(res) { return { body: 'no' }; }");
assert.equal(call(onlyResponse, "request", [{}], 1000), undefined, "an undefined side is undefined");
assert.deepEqual(call(onlyResponse, "response", [{ status: 200, contentType: null, body: "" }], 1000), { body: "no" });

const onlyRequest = compile("t", "export function request() { return { path: '/x' }; }");
assert.deepEqual(call(onlyRequest, "request", [{}], 1000), { path: "/x" });
assert.equal(call(onlyRequest, "response", [{}], 1000), undefined);

console.log("adapter-run: ok");
