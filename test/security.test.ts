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
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";
import { UI_HTML } from "../src/ui.js";

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
backend: { url: "${beUrl}", kind: none, serves: [mine] }
share: [mine]
apiKeys: [my-key]
peerTokens: { friend: peer-token }
peers:
  - name: friend
    url: http://127.0.0.1:1
    token: t
    models: { borrowed: theirs }
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
backend: { url: "${beUrl}", kind: none, serves: [mine] }
peerTokens: { evil: tok }
peers:
  - name: evil
    url: http://127.0.0.1:${(hostile.address() as AddressInfo).port}
    token: t
    models: { borrowed: theirs }
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

/* ------------------------------------------- the page's own escaping helpers */

{
  // Extracted and run, not just parsed. The suite already checks the script
  // PARSES, which cannot see a helper whose definition failed to land or a
  // regex that a template literal quietly rewrote — both of which happened
  // while writing this.
  const script = UI_HTML.match(/<script>([\s\S]*)<\/script>/)![1]!;
  const yq = new Function(`${script.match(/const yq = [^\n]+/)![0]}\nreturn yq;`)() as (v: string) => string;
  const esc = new Function(`${script.match(/const esc = [\s\S]*?\}\)\[c\]\);/)![0]}\nreturn esc;`)() as (v: string) => string;

  assert.equal(yq("qwen3-coder-30b"), "qwen3-coder-30b",
    "an ordinary id is left alone — a hyphen inside a character class is easy to lose");
  assert.equal(yq("coder"), "coder");
  // A peer chooses its own model ids, and this snippet is what the operator is
  // told to paste into their config.
  assert.equal(yq("sneak\nevil: true"), '"sneak\\nevil: true"', "a newline cannot break out");
  assert.equal(yq("has space"), '"has space"');
  assert.equal(esc('<img src=x onerror="p()">'),
    "&lt;img src=x onerror=&quot;p()&quot;&gt;", "markup cannot reach innerHTML intact");
}

await new Promise<void>((r) => backend.close(() => r()));
console.log("security.test.ts ok");
