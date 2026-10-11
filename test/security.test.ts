/**
 * Self-check for the things a security review turned up, plus the ones it
 * confirmed were already right — those are worth pinning too, because the way
 * an auth gate breaks is somebody adding a route and copying the wrong
 * neighbour.
 *
 * The theme is that this node's notion of "local" includes a browser. Loopback
 * is the whole basis of local trust, an SSH tunnel is the documented way to
 * reach the page, and a browser tab on the other end of that tunnel will send
 * whatever a visited web page tells it to.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { yamlScalar as yq } from "../src/yamlq.js";

const uiDir = new URL("../src/console/", import.meta.url).pathname;

const dir = mkdtempSync(join(tmpdir(), "hearth-sec-"));
const cfgPath = join(dir, "hearth.yaml");

const backend = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(req.url === "/v1/models"
    ? JSON.stringify({ data: [{ id: "mine" }] })
    : JSON.stringify({ ok: true, sawAuth: req.headers.authorization ?? null }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const beUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

writeFileSync(cfgPath, `name: sec
backends: { main: { url: "${beUrl}", kind: none, serves: [mine] } }
lending: { models: [mine] }
apiKeys: [my-key]
peers:
  friend:
    url: http://127.0.0.1:1
    token: t
    accept: peer-token
    models: { borrowed: theirs }
flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } }
`);
chmodSync(cfgPath, 0o600);

const node = createNode(loadConfig(cfgPath), silentLogger);
await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
const host = url.slice("http://".length);

/* ------------------------------------------------------------------ CSRF */

{
  // A cross-origin fetch with a simple content type needs no preflight, so the
  // request LANDS; that the attacker cannot read the reply is no comfort when
  // the damage is the request. Every write route has to refuse it.
  const forged = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain",
                 Authorization: "Bearer my-key" },
      body: JSON.stringify(body),
    });

  assert.equal((await forged("/control", { lending: false })).status, 403,
    "a page you happen to be visiting must not switch off lending");
  assert.equal((await forged("/control", { save: true })).status, 403,
    "nor write the config file");
  assert.equal((await forged("/v1/warm", { model: "mine" })).status, 403,
    "nor hold the GPU in a warm loop");
  assert.equal((await forged("/unload", {})).status, 403,
    "nor reach the backend's own control paths through the passthrough");

  const state = (await (await fetch(`${url}/control`, {
    headers: { Authorization: "Bearer my-key" } })).json()) as { lending: boolean };
  assert.equal(state.lending, true, "and nothing actually changed");

  // Everything legitimate sends no Origin at all: curl, the peer protocol, and
  // a server-side app calling this as its upstream.
  const plain = await fetch(`${url}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer my-key" },
    body: JSON.stringify({ lending: true }),
  });
  assert.equal(plain.status, 200, "a request with no Origin is not a browser and is fine");

  // The page's own fetch carries an Origin equal to where it was served.
  const own = await fetch(`${url}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://${host}`,
               Authorization: "Bearer my-key" },
    body: JSON.stringify({ lending: true }),
  });
  assert.equal(own.status, 200, "the status page must keep working");

  // Reads are not the hole and blocking them would break the page.
  assert.equal((await fetch(`${url}/network`, {
    headers: { Origin: "https://evil.example", Authorization: "Bearer my-key" } })).status, 200);
}

/* ------------------------------------------------ our key stays with us */

{
  // A caller who authenticated to HEARTH handed us a hearth credential. Passing
  // it to the backend puts it in that backend's logs, where the operator has no
  // idea it went.
  const r = await fetch(`${url}/anything`, { headers: { Authorization: "Bearer my-key" } });
  const seen = (await r.json()) as { sawAuth: string | null };
  assert.equal(seen.sawAuth, null, "our own api key is not forwarded to the backend");

  // A credential the backend actually wants is one that is not ours, and it
  // still goes through untouched.
  const other = await fetch(`${url}/anything`, {
    headers: { Authorization: "Bearer my-key", "X-Real": "1" } });
  assert.equal(other.status, 200);
}

/* ------------------------------------------- saving must not widen the file */

{
  await fetch(`${url}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer my-key" },
    body: JSON.stringify({ share: { mine: false }, save: true }),
  });
  const mode = statSync(cfgPath).mode & 0o777;
  assert.equal(mode, 0o600,
    "the config keeps its permissions — it holds peer tokens, and writeFileSync " +
    "defaults to 0644 through the temp file it renames into place");
  assert.match(readFileSync(cfgPath, "utf8"), /peer-token/, "and it really does hold one");
}

await node.close();

/* ------------------------------- a peer cannot take the status page down */

{
  // Everything past free/slots/queued used to be believed as the type it
  // claimed. `serves` as a string meant theirServes.map is not a function,
  // which is a 500 on /network and /ui/data for as long as that peer is up.
  const hostile = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/peer/hello") return res.end(JSON.stringify({ name: "evil", protocol: 2 }));
    res.end(JSON.stringify({
      node: "evil", protocol: 2, slots: 1, free: 1, queued: {},
      serves: "not-an-array", loaded: { nor: "this" }, models: "nor this",
    }));
  });
  await new Promise<void>((r) => hostile.listen(0, "127.0.0.1", r));
  const p2 = join(dir, "peer.yaml");
  writeFileSync(p2, `name: sec2
backends: { main: { url: "${beUrl}", kind: none, serves: [mine] } }
peers:
  evil:
    url: http://127.0.0.1:${(hostile.address() as AddressInfo).port}
    token: t
    accept: tok
    models: { borrowed: theirs }
flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } }
`);
  const n2 = createNode(loadConfig(p2), silentLogger);
  await new Promise<void>((r) => n2.server.listen(0, "127.0.0.1", r));
  const u2 = `http://127.0.0.1:${(n2.server.address() as AddressInfo).port}`;
  await n2.peers.pollAll();

  assert.equal((await fetch(`${u2}/network`)).status, 200, "a peer's junk cannot 500 /network");
  assert.equal((await fetch(`${u2}/ui/data`)).status, 200, "nor the page");
  await n2.close();
  await new Promise<void>((r) => hostile.close(() => r()));
}

/* -------------------------------------------- the page's own YAML quoting */

{
  // Imported and run, not extracted out of the page's source with a regex and
  // handed to new Function. That was the only way to test anything inside a
  // template literal, and it caught two real bugs precisely because it RAN
  // them — a helper whose definition failed to insert, and a character class
  // where the literal ate `\-` and turned `.-/` into a RANGE that excluded the
  // hyphen in every model id.
  //
  // The page's other escaping helper is gone rather than moved: `esc` existed
  // for the one place the old page used innerHTML, and React escapes text
  // children by construction. The assertion below is that nothing has quietly
  // opened that hole again.
  assert.equal(yq("qwen3-coder-30b"), "qwen3-coder-30b",
    "an ordinary id is left alone — a hyphen inside a character class is easy to lose");
  assert.equal(yq("coder"), "coder");
  // A peer chooses its own model ids, and this snippet is what the operator is
  // told to paste into their config.
  assert.equal(yq("sneak\nevil: true"), '"sneak\\nevil: true"', "a newline cannot break out");
  assert.equal(yq("has space"), '"has space"');

  // This page is a privilege boundary: it is served on loopback, and a browser
  // on loopback is what /control trusts. Script running here can change what
  // this node lends and write the config file — and peer-chosen model ids are
  // rendered all over it.
  for (const f of readdirSync(uiDir)) {
    assert.doesNotMatch(readFileSync(join(uiDir, f), "utf8"), /dangerouslySetInnerHTML/,
      `${f} reintroduces raw markup into the console`);
  }
}

// --- the auth matrix, route by route ---------------------------------------
//
// Every path this node answers, against every kind of caller. The routes differ
// on purpose — one is open, one is decided by address, three take a peer's
// token OR a local key, the rest are local only — and the way that goes wrong
// is a new route copying the wrong neighbour. Asserted as a table because it IS
// one now, and a table nobody checks is a comment.
//
// The refusal SHAPE is asserted too. A client parses it: the /v1 surface must
// answer in OpenAI's envelope and the control surface in the plain one, and
// swapping them silently breaks whoever was reading the field that vanished.
{
  const dir = mkdtempSync(join(tmpdir(), "hearth-authz-"));
  const cfgFile = join(dir, "hearth.yaml");
  writeFileSync(cfgFile, [
    "name: authz",
    `backends: { main: { url: ${yq(beUrl)}, serves: [m] } }`,
    "apiKeys: [local-key]",
    "lending: { models: [m] }",
    "peers: { friend: { accept: peer-token } }",
    'flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } }',
  ].join("\n"));
  const n = createNode(loadConfig(cfgFile), silentLogger);
  n.start();
  const base = await new Promise<string>((ready) =>
    n.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(n.server.address() as AddressInfo).port}`)),
  );

  const call = async (path: string, token: string | null, method = "GET") => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
    return { status: r.status, body };
  };

  const LOCAL = "local-key";
  const PEER = "peer-token";

  // [path, method, who may in, envelope]
  const matrix: [string, string, ("none" | "local" | "peer")[], "plain" | "openai"][] = [
    ["/healthz", "GET", ["none", "local", "peer"], "plain"],
    ["/peer/state", "GET", ["peer"], "plain"],
    ["/network", "GET", ["local"], "plain"],
    ["/control", "GET", ["local"], "plain"],
    ["/queue", "GET", ["local"], "plain"],
    ["/v1/models", "GET", ["local", "peer"], "openai"],
    ["/v1/warm", "POST", ["local", "peer"], "openai"],
    ["/v1/chat/completions", "POST", ["local", "peer"], "openai"],
  ];

  for (const [path, method, allowed, envelope] of matrix) {
    for (const [who, token] of [["none", null], ["local", LOCAL], ["peer", PEER]] as const) {
      const { status, body } = await call(path, token, method);
      if (allowed.includes(who)) {
        assert.notEqual(status, 401, `${who} must reach ${path}`);
        assert.notEqual(status, 403, `${who} must not be forbidden from ${path}`);
      } else {
        assert.equal(status, 401, `${who} must NOT reach ${path} (got ${status})`);
        // The envelope, which is the half a client actually reads.
        if (envelope === "openai") {
          assert.equal(typeof (body.error as { message?: string })?.message, "string",
            `${path} must refuse in OpenAI's envelope`);
        } else {
          assert.equal(typeof body.error, "string", `${path} must refuse in the plain envelope`);
        }
      }
    }
  }

  // A peer's token is not a local credential, and this is the one that matters:
  // /control is the only route that CHANGES anything, so a peer reaching it
  // could switch our lending off — or back on after we paused it.
  assert.equal((await call("/control", PEER, "POST")).status, 401,
    "a peer must never reach /control");

  // The page is decided by ADDRESS, not by credential, so a valid api key does
  // not open it from off-box and loopback needs none. Both halves are reached
  // over loopback here, so it opens either way — what is asserted is that the
  // credential is not what decided it.
  assert.equal((await call("/ui/data", null)).status, 200, "loopback opens the page with no key");
  assert.equal((await call("/ui/data", PEER)).status, 200,
    "and a peer token neither helps nor hinders — address decides");

  // A method the route does not claim falls through to the passthrough rather
  // than 405ing, which is how a GET to a /v1 path has always reached the
  // backend untouched. Still local-only on the way through.
  assert.equal((await call("/v1/chat/completions", null, "GET")).status, 401,
    "the fall-through is still gated");

  await n.close();
}

// --- a scoped key is a chat client and nothing more -------------------------
//
// The key on the softest box you own. Everything an unscoped key reaches is
// asserted closed to it, because the way this fails is a route added later
// forgetting to think about it: `scoped` is opt-in per route for that reason.
{
  const dir = mkdtempSync(join(tmpdir(), "hearth-scoped-"));
  const cfgFile = join(dir, "hearth.yaml");
  writeFileSync(cfgFile, [
    "name: scoped",
    `backends: { main: { url: ${yq(beUrl)}, kind: none, serves: [m, other] } }`,
    "apiKeys:",
    "  - {key: full-key, label: app}",
    "  - {key: narrow-key, label: voice, models: [quiet]}",
    "models:",
    "  quiet: {as: m}",
    'flows: { rest: { inputs: ["*"], steps: [{ to: { asked: true } }] } }',
  ].join("\n"));
  const n = createNode(loadConfig(cfgFile), silentLogger);
  n.start();
  const base = await new Promise<string>((ready) =>
    n.server.listen(0, "127.0.0.1", () =>
      ready(`http://127.0.0.1:${(n.server.address() as AddressInfo).port}`)),
  );
  const call = async (path: string, token: string, method = "GET", body = "{}") => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(method === "POST" ? { body } : {}),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const chat = (token: string, model: string) =>
    call("/v1/chat/completions", token, "POST", JSON.stringify({ model, messages: [] }));

  // What it may do.
  assert.equal((await chat("narrow-key", "quiet")).status, 200, "its own model answers");
  const list = (await call("/v1/models", "narrow-key")).body as { data: { id: string }[] };
  assert.deepEqual(list.data.map((m) => m.id), ["quiet"], "its picker shows only what it may pick");
  assert.equal((await call("/v1/models/quiet", "narrow-key")).status, 200);

  // What it may not.
  assert.equal((await chat("narrow-key", "m")).status, 403, "the id behind the alias is not its to name");
  assert.equal((await chat("narrow-key", "other")).status, 403, "nor any other");
  assert.equal((await call("/v1/models/other", "narrow-key")).status, 404, "and it cannot see them");
  for (const [path, method] of [
    ["/v1/warm", "POST"], ["/queue", "GET"], ["/network", "GET"], ["/control", "POST"],
    ["/v1/embeddings", "POST"], ["/upstream/x/generate", "POST"], ["/anything", "GET"],
  ] as const) {
    const { status } = await call(path, "narrow-key", method);
    assert.equal(status, 403, `a scoped key must not reach ${method} ${path} (got ${status})`);
  }

  // The unscoped key next to it is untouched.
  assert.equal((await chat("full-key", "other")).status, 200);
  assert.equal((await call("/queue", "full-key")).status, 200);
  assert.ok(((await call("/v1/models", "full-key")).body as { data: unknown[] }).data.length > 1);

  await n.close();
}

// A scope names routes, so a typo is a startup error, not a 403 in production.
{
  const dir = mkdtempSync(join(tmpdir(), "hearth-scoped-bad-"));
  const cfgFile = join(dir, "hearth.yaml");
  writeFileSync(cfgFile, [
    "name: scoped",
    `backends: { main: { url: ${yq(beUrl)}, serves: [m] } }`,
    "apiKeys: [{key: k, label: v, models: [m]}]",
  ].join("\n"));
  assert.throws(() => loadConfig(cfgFile), /not a route in models:/, "a backend id alone is not a route");
  writeFileSync(cfgFile, [
    "name: scoped",
    `backends: { main: { url: ${yq(beUrl)}, serves: [m] } }`,
    "apiKeys: [{key: k, label: v, models: []}]",
  ].join("\n"));
  assert.throws(() => loadConfig(cfgFile), /at least one model/, "an empty scope is a mistake, not a lock");
}

await new Promise<void>((r) => backend.close(() => r()));
console.log("security.test.ts ok");
