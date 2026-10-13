/**
 * The config editor's field table against the parser it describes.
 *
 * parseConfig takes its allowed keys from this table, so a key cannot be read and not offered.
 * What can still drift is a seed: the editor adding a value the parser then refuses.
 *
 *     npx tsx test/fields.test.ts
 */
import assert from "node:assert/strict";
import { ConfigError, parseConfig } from "../src/config.js";
import { FIELDS, fieldAt, humanMs, nearest, scopeOf, seedOf, type Scope } from "../src/fields.js";

/** A config that loads, with one entry in every section a scope can point into. */
const base = () => ({
  name: "t",
  resources: { gpu0: { kind: "gpu" } },
  servers: { box: { host: "10.0.0.5" } },
  flows: { pick: { inputs: ["m"], steps: [{ to: "m" }] } },
  actions: { tell: { call: "http://127.0.0.1:1/hook" } },
  backends: { card: { url: "http://127.0.0.1:1", kind: "none", resources: ["gpu0"] } },
  scheduler: { lanes: { chat: { priority: 0 } } },
  models: { m: { concurrency: 1 } },
  peers: { p: { url: "http://127.0.0.1:2", token: "t", accept: "a", models: { m: "m" } } },
});

/** Where each scope lives in `base()`. */
const AT: Record<Scope, (string | number)[]> = {
  node: [], listen: ["listen"], backendDefaults: ["backendDefaults"], backend: ["backends", "card"],
  activity: ["backends", "card", "activity"], resource: ["resources", "gpu0"], server: ["servers", "box"], flow: ["flows", "pick"], action: ["actions", "tell"],
  scheduler: ["scheduler"],
  lane: ["scheduler", "lanes", "chat"], model: ["models", "m"], stats: ["models", "m", "stats"],
  pool: ["models", "m", "pool"], price: ["models", "m", "price"], peer: ["peers", "p"], lend: ["peers", "p", "lend"], lending: ["lending"], borrowing: ["borrowing"],
  operator: ["operator"],
};

/** Set `value` at `path` inside `doc`, creating plain objects on the way. */
function setIn(doc: Record<string, unknown>, path: (string | number)[], value: unknown): void {
  let cur = doc as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string | number, unknown>;
  cur[path[path.length - 1]!] = value;
}

const get = (doc: unknown, path: (string | number)[]): unknown =>
  path.reduce<unknown>((cur, k) => (cur as Record<string | number, unknown> | undefined)?.[k], doc);

// --- every seed is a value the parser takes -------------------------------------------------
// Skipped: a field already filled in by base(), and raw ones, which the editor never adds.
for (const [scope, fields] of Object.entries(FIELDS) as [Scope, (typeof FIELDS)[Scope]][]) {
  if (scope === "operator") continue;
  for (const [key, f] of Object.entries(fields)) {
    if (f.type === "raw") continue;
    // A port is refused beside the url base() already gives its backend.
    if (scope === "backend" && key === "port") continue;
    // An action is one kind, and base() made this one a call.
    if (scope === "action" && key === "log") continue;
    const doc = base() as Record<string, unknown>;
    // A nested block the base lacks starts as its own seed, as the editor adds it.
    const parent = fieldAt(AT[scope]);
    if (parent && get(doc, AT[scope]) === undefined) setIn(doc, AT[scope], seedOf(parent));
    const path: (string | number)[] = [...AT[scope], key];
    if (get(doc, path) !== undefined) continue;
    setIn(doc, path, seedOf(f));
    assert.doesNotThrow(() => parseConfig(doc), `${scope}.${key} seeded as ${JSON.stringify(seedOf(f))} must load`);
    assert.equal(fieldAt(path), f, `fieldAt finds ${scope}.${key}`);
  }
}

// --- a key the table does not list is refused, with the one it was probably meant to be ---------
{
  const typo = (patch: Record<string, unknown>) => () => parseConfig({ ...base(), ...patch });
  assert.throws(typo({ models: { m: { lnae: "chat" } } }), /models\.m\.lnae is not a setting of models\.m — did you mean lane\?/);
  assert.throws(typo({ backends: { card: { url: "http://x:1", concurency: 2 } } }), /did you mean concurrency/);
  assert.throws(typo({ shutdownGraceMS: 5 }), /shutdownGraceMS is not a setting — did you mean shutdownGraceMs/);
  assert.throws(typo({ lending: { model: [] } }), /did you mean models/);
  assert.throws(typo({ whatever: 1 }), (e: unknown) => e instanceof ConfigError && !/did you mean/.test(e.message),
    "nothing close is suggested as nothing");
  assert.equal(nearest("Policy", ["policy"]), "policy", "a case slip is the nearest of all");
}

// --- scopes ----------------------------------------------------------------------------------
assert.equal(scopeOf(["backends", "card"]), "backend");
assert.equal(scopeOf(["servers", "box"]), "server");
assert.equal(scopeOf(["lending"]), "lending");
assert.equal(scopeOf(["models", "m", "params"]), null, "params is a free map");
assert.equal(scopeOf(["peers", "p", "models"]), null, "and so is a peer's model map");
assert.equal(scopeOf(["peers", "p", "lend"]), "lend");

// --- units -------------------------------------------------------------------------------------
assert.equal(humanMs(900_000), "15 min");
assert.equal(humanMs(30_000), "30 s");
assert.equal(humanMs(0), "forever");
assert.equal(humanMs(1500), "1500 ms");

console.log("fields.test.ts ok");
