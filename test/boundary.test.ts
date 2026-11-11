/**
 * The console's error boundary: what it keeps from a thrown error, and what it draws in its place.
 * A server render does not catch, so the catch itself is React's; this checks the parts that are ours.
 *
 *     npx tsx test/boundary.test.ts
 */
import assert from "node:assert/strict";
import * as React from "react";
import { renderToString } from "react-dom/server";

// The page's JSX compiles to `React.createElement` here.
Object.assign(globalThis, { React });
// Imported by a name tsc does not follow: the tests are typechecked without JSX, and this module is .tsx.
const console_ = "../src/console/";
type State = { error: Error | null };
const { Boundary } = (await import(`${console_}Boundary.js`)) as { Boundary: React.ComponentClass<{ children: React.ReactNode }, State> };
const derive = (Boundary as unknown as { getDerivedStateFromError(e: unknown): State }).getDerivedStateFromError;

// An Error is kept as it is; anything else thrown becomes one with its text.
const thrown = new Error("cannot read properties of undefined (reading 'name')");
assert.equal(derive(thrown).error, thrown);
assert.equal(derive("plain text").error?.message, "plain text");

// With no error it draws what it holds.
assert.equal(renderToString(React.createElement(Boundary, null, React.createElement("span", null, "page"))), "<span>page</span>");

// With one it draws the fallback: what happened, the message, and the two ways out.
const b = new Boundary({ children: React.createElement("span", null, "page") });
b.state = { error: new Error("boom <b>") };
const html = renderToString(b.render() as React.ReactElement);
assert.match(html, /This page hit an error/);
assert.match(html, /<pre[^>]*font-mono[^>]*>boom &lt;b&gt;<\/pre>/);
assert.match(html, />try again</);
assert.match(html, />reload</);
assert.doesNotMatch(html, /<span>page<\/span>/);

console.log("boundary: ok");
