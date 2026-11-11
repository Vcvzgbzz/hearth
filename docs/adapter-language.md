# The adapter language

An adapter is a named block of code that sits on one line of a flow, between a plugin target and
what that target is sent: it reshapes the request on the way in and the answer on the way out. It is
kept in `hearth.yaml` under `adapters:`, and a plugin target names one with `adapt:`. Where a line
may carry one, and how a failed line moves on, is in
[Adapters on a line](routing.md#adapters-on-a-line).

The code runs in hearth's own interpreter, not in Node and not in a JavaScript engine. The language
is a small subset of JavaScript with its own parser and its own value types: no network, disk,
environment, timers, `require` or `process`, and nothing outside the one request or answer the code
is handed. Every run is held to a deadline and a memory budget from inside the interpreter's own
loop, so a loop, a callback or an allocation that would never end is stopped rather than left to
hold the node.

## A module

The text of `adapters.<name>.code` is one module. It exports up to two functions:

```js
export function request(req) {
  return { path: "/api/search", query: { q: req.query.q } };
}

export function response(res, req) {
  const d = JSON.parse(res.body);
  return { contentType: "application/json", body: JSON.stringify({ results: d.results }) };
}
```

- `request(req)` runs before the target is called. What it returns is what the target is sent, or
  `null` when this line has no counterpart for the request.
- `response(res, req)` runs on a 2xx answer from the target. What it returns replaces the answer.
  `req` is the request the caller sent, not the one `request()` made.
- A side that is not exported is passed through: a module may export only `response`, or only
  `request`. A module that exports neither is refused by the config.
- Both sides are synchronous. There is no `await`, no promise and no callback that runs later.

`export` is accepted and ignored in front of a top-level declaration, so the code reads as an ES
module. It is not allowed anywhere else.

**The top level holds only `const` declarations and `function` declarations.** Functions are
declared first, so a `const` may call one written below it. Any other top-level statement is refused
with `the top level may hold only const declarations and functions`.

**The module is frozen after it loads.** Every top-level binding and every value reachable from it
is deep-frozen, so a call cannot change what the next call starts from. Each call therefore begins
from the same state the load ended in; a `const` table is readable and never writable.

The module is compiled when the config is read, which also runs its top-level code: an adapter whose
top-level code throws, or spends its load budget, stops the config loading. An edit to the code is
compiled the same way, so code that does not compile is refused instead of loaded, and a good edit
takes effect on the next request without a restart.

Calls to one adapter run one at a time, so one slow `request()` holds up the next call to the same
adapter. Different adapters do not wait for each other.

## The request and the answer

These are the only fields a side sees, and the only fields it may set. A field it leaves out keeps
the value the caller sent, or the target's answer.

```ts
type Req = {
  method: string;
  path: string;                        // relative to the target plugin's root
  query: Record<string, string>;
  contentType: string | null;
  body: string | null;                 // UTF-8 text; null when the body is not text
};

type Res = {
  status: number;
  contentType: string | null;
  body: string;
};

request(req: Req): Partial<Req> | null
response(res: Res, req: Req): Partial<Res>
```

- **`request()` may return `null`**, which means it has no counterpart for this request on that
  plugin's API: the line fails and the next one is tried.
- **A field set on `request()` replaces that field.** `query` replaces the whole query string, so it
  sends exactly the names and values it returns; `body: null` sends no body; `contentType: null`
  removes the header.
- **Only the names above cross the boundary.** The code never sees the caller's headers or
  credentials; the target still gets its own `key` and `headers`, added after `request()` returns.
- **`response()` only sees a 2xx answer.** No other answer is given to the code. A 5xx or 429 is a
  failed line: the plugin's own `fallback` is tried, then the next line, and with nowhere else to go
  the target's answer is relayed as it came. Any other answer (a 3xx or another 4xx) goes back to the
  caller as it came.
- **What `response()` may return is checked.** `status` has to be a whole HTTP status, 100 to 599;
  `body` has to be a string; `contentType: null` removes the header. A side that returns something
  that is not a plain object (or `null`, for `request()`) is refused the same way.

## What the language has

**Literals.** Decimal numbers (`42`, `3.5`, `1e3`) with no hex, binary or octal form; strings in
single or double quotes; template strings with `${…}` substitutions, nested if needed; `true`,
`false`, `null`, `undefined`.

**Arrays** `[1, 2, 3]`, `[...a, 4]`, and **objects** `{ x: 1, "k": 2, 3: 3 }` with shorthand
(`{ q }`) and spread (`{ ...o, z: 3 }`). Object keys are a bare name, a string or a number; a
computed key (`{ [k]: 1 }`) is not in the language.

**Statements.** `const` and `let`, `if`/`else`, `while`, `for (const x of …)` and
`for (let x of …)`, `break`, `continue`, `return`, `throw`, `try`/`catch`/`finally`, function
declarations, blocks, and expression statements. A `for...of` goes through an array or the characters
of a string. A function is a declaration or an arrow: `x => x + 1`, `(x, y) => x + y`, `() => 1`.

**Expressions and operators**, from loosest to tightest:

| operators | notes |
|---|---|
| `=`, `+=`, `-=` | on a variable, `o.x` or `o[k]`; right-associative |
| `? :` | conditional |
| `??` | nullish; binds more loosely than `||` and `&&`, and the three may be mixed without parentheses |
| `\|\|` | |
| `&&` | |
| `===`, `!==` | strict only |
| `<`, `<=`, `>`, `>=` | numbers, or two strings |
| `+`, `-` | `+` concatenates when either side is a string |
| `*`, `/`, `%` | |
| `!`, unary `-`, unary `+`, `typeof` | |
| `.name`, `[expr]`, `?.name`, `?.[expr]`, `?.()`, `f(…)` | member access, calls, optional chaining |

Optional chaining short-circuits a chain: `a?.b.c` is `undefined` when `a` is null or undefined.

Comments are `// …` and `/* … */`.

## What it refuses

A refusal is a parse error with the line and column it broke on, and a short reason. Each one is a
construct the interpreter cannot hold to its budgets, or one no adapter needs.

| refused | the message says |
|---|---|
| regex literals | `regex literals are not part of the adapter language` |
| `class`, `this` | `classes are not part of the adapter language`, `this is not part of the adapter language` |
| `new` | `new is only allowed for Error` |
| `async`, `await` | `async and await are not part of the adapter language` |
| `eval` | `eval is not part of the adapter language` |
| `import` | `import is not part of the adapter language` |
| `switch` | `switch is not part of the adapter language` |
| `do … while` | `do...while is not part of the adapter language` |
| `for (…; …; …)`, `for (… in …)` | `only for...of loops are part of the adapter language` |
| `break label`, `continue label`, `label:` | `labels are not part of the adapter language` |
| `++`, `--` | `++ is not part of the adapter language; write += 1 or -= 1 instead` |
| `==`, `!=` | `loose equality is not part of the adapter language; write === or !==` |
| a function expression (`const f = function () {}`) | `a function must be a declaration or an arrow function` |
| `var`, `delete`, `void`, `in`, `instanceof` | `… is not part of the adapter language` |
| getters and setters | not parsed |
| code nested more than 256 levels deep | `the code nests too deeply to read` |

**Regex is the important one.** A regular expression runs as one native call, and nothing can
interrupt it once it starts: a pathological pattern on a large input would hold the node, which is
the one thing the interpreter exists to prevent. For the same reason `String.split` takes a string
separator and there is no `replace`, `match`, `search` or regex argument anywhere. Step through the
text instead: `split`, `slice`, `indexOf`, `includes`, `startsWith`, `endsWith`, `replaceAll`.
`split` splits on a string, and `replaceAll` replaces a string with a string.

## Values

A value is a number, a string, a boolean, `null`, `undefined`, an array, an object, or a function the
interpreter made. There are no host objects: an object is a map of names to values with no prototype
of its own, so nothing falls through to JavaScript's prototype chain. A function is a value too, but
it cannot be returned from a side: `an adapter cannot return a function`.

**The key guard.** The names `__proto__`, `constructor` and `prototype` are refused wherever a
property name can appear: a read, a write, a computed key, a spread, an object literal, a key that
arrives through `JSON.parse`, `Object.fromEntries`, or the request itself. The refusal says:

```
"__proto__" is not a property name the adapter language allows
```

Objects here are maps, so those names would mean nothing anyway; refusing them keeps a value that
leaves the interpreter from turning into a prototype mutation somewhere that does honour them.

**Mutation.** An array or object a call makes is mutable, and so are its parameters and its `let`
bindings. Everything the module made at load is frozen, and writing to it fails with
`cannot change a value that belongs to the module`. A `const` binding cannot be reassigned at all:
`cannot assign to x, which a call may not change`. A string cannot be changed.

**Reading.** `o.name` and `o[expr]` read an object entry or an array item; `length` is the length of
a string or an array; an item past the end, or a name that is not there, is `undefined`. Reading
through `null` or `undefined` fails with `cannot read x of undefined`.

**Writing.** `o.name = v`, `o[expr] = v` and the same for an array index; `+=` and `-=` work on a
variable, a property and an item. Writing to a string fails, and an array has no property other than
its items and `length`.

**Equality** is strict: `===` and `!==` compare type and value, and two distinct arrays or objects
are not equal. `typeof` gives JavaScript's name for the type, and is `"undefined"` for a name nothing
declared.

## Builtins

These are the only names the code can reach besides its own. Anything else (`process`, `require`,
`fetch`, `console`, `Buffer`, `globalThis`, `Promise`, `setTimeout`, `Date`, …) is not defined:
naming one is a runtime error, and `typeof` of it is `"undefined"`.

| name | signature | returns |
|---|---|---|
| `JSON.parse` | `JSON.parse(text)` | the value the JSON text describes; a bad text fails with `JSON.parse: …` |
| `JSON.stringify` | `JSON.stringify(value)` | the JSON text, or `undefined` for `undefined` and functions |
| `Math.abs` | `Math.abs(n)` | number |
| `Math.ceil` | `Math.ceil(n)` | number |
| `Math.floor` | `Math.floor(n)` | number |
| `Math.round` | `Math.round(n)` | number |
| `Math.sqrt` | `Math.sqrt(n)` | number |
| `Math.pow` | `Math.pow(base, exp)` | number |
| `Math.min` | `Math.min(…numbers)` | the least, `Infinity` with no arguments |
| `Math.max` | `Math.max(…numbers)` | the most, `-Infinity` with no arguments |
| `Math.random` | `Math.random()` | number in [0, 1) |
| `Math.PI`, `Math.E` | — | the constants |
| `Object.keys` | `Object.keys(o)` | array of names |
| `Object.values` | `Object.values(o)` | array of values |
| `Object.entries` | `Object.entries(o)` | array of `[name, value]` pairs |
| `Object.fromEntries` | `Object.fromEntries(pairs)` | object; a guarded name is refused |
| `Array.isArray` | `Array.isArray(v)` | boolean |
| `Number` | `Number(v)` | number (`NaN` for text that is not a number) |
| `String` | `String(v)` | string |
| `Boolean` | `Boolean(v)` | boolean |
| `parseInt` | `parseInt(text, radix?)` | number, `NaN` for a bad radix or text; radix 10 unless given |
| `parseFloat` | `parseFloat(text)` | number |
| `isNaN` | `isNaN(v)` | boolean |
| `encodeURIComponent` | `encodeURIComponent(text)` | percent-encoded string |
| `decodeURIComponent` | `decodeURIComponent(text)` | string; text that is not percent-encoded fails |
| `Error` | `Error(message?)`, `new Error(message)` | an error value; `new` is accepted only here |

**String methods** (on a string value):

| method | returns |
|---|---|
| `split(sep?)` | array of strings; the whole string when the separator is absent, one character each when it is `""` |
| `slice(start, end?)` | string |
| `trim()` | string |
| `toLowerCase()`, `toUpperCase()` | string |
| `startsWith(s)`, `endsWith(s)`, `includes(s)` | boolean |
| `indexOf(s)` | number, `-1` when not found |
| `replaceAll(old, new)` | string; every occurrence of the string `old` |
| `padStart(length, fill?)` | string; fill is a space unless given |
| `charAt(i)` | string, `""` past the end |

**Array methods** (on an array value; `value` is the item, `index` its place):

| method | returns |
|---|---|
| `map(f)`, `filter(f)` | a new array; `f(value, index)` |
| `find(f)`, `findIndex(f)` | the first item, or its index, where `f(value, index)` is truthy; `undefined` / `-1` when none |
| `some(f)`, `every(f)` | boolean; `f(value, index)` |
| `reduce(f, initial?)` | one value; `f(accumulator, value, index)` |
| `slice(start, end?)`, `concat(…)` | a new array |
| `includes(v)`, `indexOf(v)` | boolean / index, by strict equality |
| `join(sep?)` | string, `,` unless given |
| `push(…values)` | the new length; changes the array |
| `sort(compare)` | the same array, sorted; `compare(a, b)` returns a negative number, zero or a positive number |
| `length` | number (a property, not a method) |

## Limits

Every limit is per run: a `request()` and a `response()` each start with all of them whole. The
values are the constants in `src/routing/adapter/machine.ts`.

| limit | default | bounds |
|---|---|---|
| heap | 16 MiB (16777216 bytes) | string characters, array cells and object entries allocated by one run; a string costs its characters, an array cell or object entry 8 bytes |
| string length | 1048576 characters | one string |
| array length | 65536 elements | one array |
| call depth | 256 | nested calls, callbacks included |
| value nesting | 512 | how deeply a value may nest, on the way in, out and through `JSON.stringify` |
| clock check | every 1000 steps | how often the run reads the clock against its deadline |
| load deadline | 1000 ms | one module's top-level code, while it loads; it is not `timeoutMs` |
| `timeoutMs` | 1000 ms, from 1 to 10000 | each of `request()` and `response()` |

A run that hits a limit stops with one of these messages:

```
step budget exceeded (200 ms)
allocation budget exceeded (16 MiB)
string too long (1048576 characters)
array too long (65536 elements)
call depth exceeded (256)
a value is nested too deeply
```

The number in brackets is the run's own deadline or the cap it hit. A request or an answer holding a
string over the cap never reaches the code: the run fails with `the request is too large to adapt` or
`the answer is too large to adapt`.

**A limit cannot be caught.** `try`/`catch`/`finally` sees a thrown value and the interpreter's type
errors, but a spent budget skips every `catch` and `finally` and ends the call: a run that has spent
its budget cannot be trusted to unwind and carry on.

Native calls (`JSON.parse`, `split`, `join`) run in one piece and are bounded by their input size
before they start. Everything that walks a value — `map`, `filter`, `reduce`, `sort`'s comparator,
`JSON.stringify` — goes through the step counter, so a callback that never ends is still cut off at
the deadline.

## Errors

**A parse error** is reported when the config is read, and names the adapter, the line and the
column:

```
adapter searxng-to-degoog: parse error at line 3, column 14: unexpected token }
```

The config error is about `adapters.<name>.code`, so `hearth serve --check` reports it too, and the
file does not load.

**A module that is not a module** is refused in the same way: `adapter <name>: exports neither
request nor response`, `adapter <name>: request is not a function`, or, when its top-level code
throws or runs out of budget, `adapter <name> loading(): <reason>`.

**A runtime error** names the adapter, the side and, where there is one, the place in the code:

```
adapter my-adapter request(): cannot read x of undefined (line 4, column 12)
```

A thrown value is reported by its message when it is an `Error`, and by its text otherwise. A limit
has no place, because the run stopped at a budget rather than at a step.

**What happens next** depends on the side:

- **`request()` fails** — it throws, runs out of time, or returns `null` — and the line counts as
  failed: the router asks the next line that matches, and `strict: true` turns the next line off. The
  plugin's own `fallback` is not tried, because the failure is the adapter's and the target was never
  asked. With nothing left, the caller gets the failure as a 502. The message is
  `adapter <name> could not carry the request over: <reason>`, or
  `adapter <name> has no counterpart for it on <plugin>'s API` for a `null`.
- **`response()` fails** — it throws, runs out of time, or returns something that is not an answer —
  and the caller gets a 502 naming the adapter: `adapter <name> could not read <plugin>'s answer:
  <reason>`. The target did answer, so there is no next line to try.
- Either way the log has a `flow.adapter_failed` line with the adapter, the side and the reason.

An adapter the router never reaches never runs at all.

## A worked example

[`examples/adapters/searxng-to-degoog.mjs`](../examples/adapters/searxng-to-degoog.mjs) carries a
SearXNG JSON search to degoog's `/api/search` and brings the answer back as SearXNG's JSON. It is a
whole adapter, and the comment at its top is a config that uses it (the code abbreviated here):

```yaml
adapters:
  searxng-to-degoog:
    timeoutMs: 2000
    code: |
      export function request(req) { … }
      export function response(res, req) { … }

plugins:
  search: { serves: http://searxng:8080, trust: http }
  degoog: { serves: http://degoog:4444, trust: http }

flows:
  search:
    inputs: ["*"]
    steps:
      - to: { plugin: search }
      - to: { plugin: degoog, adapt: searxng-to-degoog }
```

- `request()` returns `null` for anything that is not a JSON search, so the first line that cannot
  answer hands the request to the second one, which speaks the other API through the adapter.
- It reads the page number one character at a time, because there is no regex; it maps SearXNG's
  `categories` to degoog's search type with a table and a computed read.
- `response()` parses the answer and `throw`s when it holds no results list. That is a `response()`
  failure, so the caller gets a 502 naming the adapter rather than a broken page.
- It returns a new `contentType` and `body`, and leaves the status as the target gave it.
