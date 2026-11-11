/**
 * Adapter code written to break the interpreter: the ways out of the value layer, the ways to make
 * one allocation or one loop enormous, and the way an error is supposed to escape.
 *
 * Every case must end with the right error inside `timeoutMs + 50 ms` of wall clock, with
 * `timeoutMs` at 200, and every one of them runs in its own compiled module.
 */
import assert from "node:assert/strict";

import { call, compile } from "../src/routing/adapter/index.js";

const TIMEOUT = 200;
const BUDGET = TIMEOUT + 50;
const request = { method: "GET", path: "/", query: {}, contentType: null, body: null };

/** Compile `code` and run its request side, requiring `re` and an ending inside the budget. */
function endsWith(name: string, code: string, re: RegExp): void {
  const module = compile(name, code);
  const at = Date.now();
  assert.throws(
    () => call(module, "request", [request], TIMEOUT),
    (e: unknown) => {
      assert.match(e instanceof Error ? e.message : String(e), re, name);
      return true;
    },
    name,
  );
  const took = Date.now() - at;
  assert.ok(took <= BUDGET, `${name} ended after ${took} ms, past the ${BUDGET} ms budget`);
}

/** Source the parser must refuse before a single step runs. */
function refused(code: string, re: RegExp): void {
  assert.throws(() => compile("h", code), re);
}

const body = (source: string): string => `export function request(req) {\n${source}\n}\n`;

/** `let s = "a"` doubled `times` times: 2^times characters. */
const doubled = (times: number): string => `let s = "a";\nlet i = 0;\nwhile (i < ${times}) { s = s + s; i += 1; }`;

/** An array of `count` copies of a `chars`-character string. */
const filled = (count: number, chars: string): string =>
  `const s = ${JSON.stringify(chars)};\nconst a = [];\nlet i = 0;\nwhile (i < ${count}) { a.push(s); i += 1; }`;

// --- the three budgets ------------------------------------------------------

endsWith("while-true", body("while (true) {}"), /step budget exceeded \(200 ms\)/);
endsWith(
  "no-end-in-sight",
  body(`${doubled(20)}\nwhile (true) { s = s.slice(0, 1); }`),
  /step budget exceeded \(200 ms\)/,
);
endsWith(
  "allocation",
  body(`${doubled(19)}\nconst keep = [];\nwhile (true) { keep.push(s + "x"); }`),
  /allocation budget exceeded/,
);
endsWith("push-forever", body("const a = [];\nwhile (true) { a.push(1); }"), /array too long/);
endsWith("deep-recursion-through-map", body("function down(n) { return [n].map(down); }\ndown(1);"), /call depth exceeded/);
endsWith(
  "recursion-through-filter",
  body("const f = (a) => a.filter((x) => f([x])).length;\nreturn f([1]);"),
  /call depth exceeded/,
);

// --- native calls are bounded by the size checks before them ----------------

endsWith("huge-split", body(`${doubled(20)}\nreturn s.split("").length;`), /array too long/);
endsWith("huge-join", body(`${filled(65_536, "0123456789abcdefg")}\nreturn a.join("").length;`), /string too long/);
endsWith("huge-stringify", body(`${filled(65_536, "0123456789abcdefg")}\nreturn JSON.stringify(a).length;`), /string too long/);
endsWith("doubling-a-megabyte", body(`${doubled(21)}\nreturn s.length;`), /string too long/);
endsWith("template-doubling", body(`let s = "a";\nlet i = 0;\nwhile (i < 21) { s = \`\${s}\${s}\`; i += 1; }\nreturn s.length;`), /string too long/);

// --- a comparator that never ends -------------------------------------------

endsWith("sort-never-ends", body("return [3, 1, 2].sort((a, b) => { while (true) {} });"), /step budget exceeded/);

// --- a limit cannot be caught ----------------------------------------------

endsWith(
  "catch-a-step-limit",
  body("try { while (true) {} } catch (e) { return null; } finally { return null; }\nreturn null;"),
  /step budget exceeded/,
);
endsWith(
  "catch-an-allocation-limit",
  body(`${doubled(19)}\nconst keep = [];\ntry { while (true) { keep.push(s + "x"); } } catch (e) { return "caught"; }`),
  /allocation budget exceeded/,
);
endsWith(
  "catch-a-depth-limit",
  body("function down(n) { return [n].map(down); }\ntry { return down(1); } catch (e) { return 'caught'; }"),
  /call depth exceeded/,
);

// --- every way to the guard's names ----------------------------------------

// In source that names them, the parser refuses them.
refused(body("const a = req.__proto__;"), /"__proto__" is not a property name/);
refused(body("const a = req.constructor;"), /"constructor" is not a property name/);
refused(body("const a = { __proto__: 1 };"), /"__proto__" is not a property name/);
refused(body("const a = { constructor: 1 };"), /"constructor" is not a property name/);
refused(body("const a = { prototype: 1 };"), /"prototype" is not a property name/);
refused(body("const a = req?.__proto__;"), /"__proto__" is not a property name/);
refused(body("req.constructor = 1;"), /"constructor" is not a property name/);

// Everywhere else, the guard runs on the key as the interpreter sees it.
endsWith("read-computed-proto", body('return req["__proto__"];'), /"__proto__" is not a property name/);
endsWith("read-computed-constructor", body('return req["con" + "structor"];'), /"constructor" is not a property name/);
endsWith("read-computed-prototype", body('return req["pro" + "totype"];'), /"prototype" is not a property name/);
endsWith("write-computed-proto", body('const o = {}; o["__proto__"] = 1; return o;'), /"__proto__" is not a property name/);
endsWith("write-computed-constructor", body('const o = []; o["constructor"] = 1; return o;'), /"constructor" is not a property name/);
endsWith("array-read-proto", body('return [1, 2]["__proto__"];'), /"__proto__" is not a property name/);
endsWith("string-read-constructor", body('return "x"["constructor"];'), /"constructor" is not a property name/);
endsWith("upcase-key", body('return req["__PROTO__"] ?? req["constructor"];'), /"constructor" is not a property name/);
endsWith("json-parse-proto", body('return JSON.parse(\'{"__proto__": 1}\');'), /"__proto__" is not a property name/);
endsWith("json-parse-constructor", body('return JSON.parse(\'{"constructor": 1}\');'), /"constructor" is not a property name/);
endsWith("json-parse-nested", body('return JSON.parse(\'{"a": {"prototype": 1}}\');'), /"prototype" is not a property name/);
endsWith("from-entries-proto", body('return Object.fromEntries([["__proto__", 1]]);'), /"__proto__" is not a property name/);
endsWith("from-entries-constructor", body('return Object.fromEntries([["constructor", 1]]);'), /"constructor" is not a property name/);
endsWith("spread-json-proto", body('const from = JSON.parse(\'{"__proto__": 1}\');\nreturn { ...from };'), /"__proto__" is not a property name/);
endsWith("request-body-proto", body('return req["__" + "proto__"];'), /"__proto__" is not a property name/);

// --- module state is frozen, and writing it is an error ---------------------

endsWith("frozen-push", `const LIST = [1, 2];\n${body("LIST.push(3);\nreturn LIST;")}`, /cannot change a value that belongs to the module/);
endsWith("frozen-index", `const LIST = [1, 2];\n${body("LIST[0] = 9;\nreturn LIST;")}`, /cannot change a value that belongs to the module/);
endsWith("frozen-property", `const OBJ = { k: 1 };\n${body("OBJ.k = 9;\nreturn OBJ;")}`, /cannot change a value that belongs to the module/);
endsWith(
  "frozen-nested",
  `const OBJ = { nested: { deep: [1] } };\n${body("OBJ.nested.deep.push(2);\nreturn OBJ;")}`,
  /cannot change a value that belongs to the module/,
);
endsWith(
  "frozen-sort",
  `const LIST = [2, 1];\n${body("LIST.sort((a, b) => a - b);\nreturn LIST;")}`,
  /cannot change a value that belongs to the module/,
);
endsWith("frozen-new-key", `const OBJ = {};\n${body("OBJ.k = 1;\nreturn OBJ;")}`, /cannot change a value that belongs to the module/);

// Reading the same state is fine, so a run cannot be starved of its own tables.
assert.deepEqual(
  call(
    compile("h", `const LIST = [1, 2];\nconst OBJ = { nested: { deep: [1] } };\n${body("return [LIST.length, OBJ.nested.deep[0]];")}`),
    "request",
    [request],
    TIMEOUT,
  ),
  [2, 1],
);

console.log("adapter-hostile: ok");
