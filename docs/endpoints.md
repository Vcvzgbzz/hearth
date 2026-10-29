# Endpoints

Beyond `/v1/chat/completions` and `/v1/models`:

| path | who | what |
|---|---|---|
| `/ui` | anyone | the console, a static shell; its data takes loopback or a login: topology with live request flow, models and sharing, the queue and recent requests, and the config file by section. ⌘K jumps anywhere |
| `/restart` | local | `POST` drains in-flight work and exits `75`, so a supervisor with `Restart=on-failure` (or `always`) starts the node again; the console offers it while a change waits for a restart. Without a supervisor it only stops. `501` when not run by `hearth serve` |
| `/control` | local | read or change what leaves this node: lending, borrowing, per-model sharing, peer model maps |
| `/queue/events` | local | the caller's own jobs, pushed over SSE: a `snapshot` on connect, then `jobs` whenever the list changes (queued, started, finished, moved in line). One connection serves every job a client has, so it never needs to poll |
| `X-Hearth-Job: <id>` | request header | the client's own id for this request (letters, digits, `._:-`, up to 128). It comes back as the job's `id` on `/queue` and `/queue/events`, so a client can match updates to its own work |
| `X-Request-Id: req_…` | response header | on every answer: this node's id for the request. Its `request` line in the log carries the same `id`, along with `headers`: what the request sent for each header a flow tests (never `Authorization` or `Cookie`). A backend's or peer's own id is not passed on |
| `X-Hearth-Queue: stream` | request header | on a streamed chat, open the stream while the request waits and send `: hearth-queue {"position":N}` comments (how many are ahead, the running turn included). OpenAI-style parsers skip comments. A failure after that arrives as an SSE `data: {"error": …}` frame, since the 200 is already sent |
| `/config` | local | the config file itself: `GET` its text and status, `PATCH` paths or the whole text (`name` labels the version written) |
| `/config/draft` | local | the console's unpublished draft, kept beside the file: `GET`, `PUT` a JSON body, `DELETE` |
| `/config/versions` | local | `GET` the versions written through the node (`at`, `name`, `hash`); `POST { hash, dryRun? }` makes one the file again |
| `/backends/probe` | local | `POST { url, key?, format? }` asks that server for its model list with that key and answers `{ ok, url, models }` or `{ ok: false, problem }`. Nothing is kept; the console uses it before a provider is added |
| `/keys/mint`, `/keys/revoke`, `/keys/rotate` | local | `POST { label, models?, expires?, limits? }` writes a new `apiKeys` entry and answers with its key, once; `POST { label }` removes the entry with that label, or for rotate gives it a new key, answered once, and keeps the rest of it (its label, and so its router, scope, limits and usage). An entry that reads its key from `env:NAME` is not rotated here. All take effect at once |
| `/v1/messages` | local | `POST` a Messages API request: it is served as a chat completion, routed and queued like one, and answered in Messages shapes, streaming included. Text, images, tools and tool results carry over; thinking blocks and cache marks are dropped, and a model's reasoning comes back as a `thinking` block. Errors come in the Messages error shape. See [Messages API clients](#messages-api-clients) |
| `/v1/evict` | local | `POST { model }` drops a resident model off the backend that serves it. `409` while it is answering a request, when it is not resident, or when the backend can only clear everything and holds other models |
| `/lending` | local | `GET`: every peer with the requests and tokens it ran here (`lent`) and this node ran there (`borrowed`), today and over the 31 days kept, the limits it is held to as `terms` with those of its own named in `own`, `closed`: why it is turned away right now, or `null`, and the same use `byModel` and as tokens `byDay` |
| `/plugins` | local | `GET`: each plugin's state, kinds, settings, fail-opens and per-stage calls, errors, refusals, skips and p50/p95. `POST {name, paused}`: pause or resume a running plugin until the next restart; a locked plugin is never paused (409) |
| `/plugins/probe` | local | `POST {url, key?}`: what a plugin service declares at its `/manifest` (its `kinds` and the model slots it `needs`), or why it cannot be read; `key` is `env:NAME`. With `mcp: <path>`: whether an MCP server answers at that path under `url`, its `server` name and how many `tools` it has |
| `/plugins/<name>/*` | local | the API a plugin `serves`, forwarded as sent and streamed back. The caller's key stays here; the plugin's `key` and `x-hearth-caller` go on. 404 for no such plugin, 503 when it is paused or did not start, 502 when the service cannot be reached. A plugin with a `fallback` hands those failures, and a 5xx or 429, to it instead. Not for keys scoped to `models:`. For a plugin that runs an MCP server, `/plugins/<name>/mcp` is that server, over MCP's streamable HTTP without a stream. See [A plugin that serves an API](plugins.md#a-plugin-that-serves-an-api) and [A plugin that speaks MCP](plugins.md#a-plugin-that-speaks-mcp) |
| `/usage` | local | `GET ?days=N` (31 at most): requests, failures and tokens in and out, as day → caller → model, with `prices` for the models that carry one. Days are UTC. Tokens are the backend's own `usage` where its answer carries one; a stream without one is counted by its events, and the request by its estimated size |
| `/report` | local | `GET` the file `hearth report` writes, as a download: versions, the config with its secrets replaced, and this node's health, network view and recent log lines. `409` for a node not started from a config file. The Logs page's **bug report** button |
| `/flows/try` | local | `POST { model, images?, tools?, tokens?, caller?, lane?, headers?, flows?, actions?, pretend? }`: where that request would go right now, the step that decides it in each flow, and the actions those steps name. Sends nothing, sets nothing off and counts nothing. `flows` and `actions` try unsaved sections; `pretend: { idle, used, busy, warm, unready, held }` lists models to read as in that state, `pretend.full` steps to read as at their `max` (each `<step>:<flow>`), and `pretend.now` a time of day to read the clock as |
| `/login`, `/logout` | anyone | `POST {user, pass}` for the operator session cookie; 404 with no `operator` set |
| `/setup` | loopback or an unscoped api key, once | `GET` says `{needed}`; `POST {user, pass}` writes the first `operator` and signs it in. `409` once one exists, `403` for anyone else |
| `/` | anyone | `GET` redirects to `/ui` |
| `/network` | local | every node, what each one serves, and what's **loaded right now**. Also lists peer models you haven't mapped, which is usually the config mistake people actually make |
| `/queue` | local | jobs in flight, with lane, caller and position |
| `/ui/data`, `/ui/events` | loopback, or a login | the page's data, pushed. A snapshot then diffs |
| `/ui/history` | loopback, or a login | the last day of finished calls and per-minute queue depth, for the Queue page's 24 h view |
| `/ui/lending` | loopback, or a login | what `/lending` answers, for the Lending page |
| `/ui/logs` | loopback, or a login | the most recent log lines (up to 5,000), for the Logs page |
| `/healthz` | anyone | whether this node can serve. `503` when it can't. The one unauthenticated endpoint |
| `/peer/hello`, `/peer/state` | peers | identity and capacity, per model, with the limits the peer is held to on each |
| `/peers/invite` | local | `POST { url }`: a one-time code (`hearth-invite:…`) holding `url`, where the other node reaches this one, and a secret. Good for 10 minutes and held in memory, so a restart voids it. What `hearth invite` asks for |
| `/peers/machine` | local | `GET ?peer=<name>`: what that peer's token is bound to (`bound`, or `null`), and the address it last presented it from with the tailnet machine this node's tailscaled says that is (`seen.node`, `null` off the tailnet, `seen.error` when tailscaled cannot be asked). `seen` is `null` until it calls. What the Lending page offers to bind to |
| `/peers/join` | local | `POST { code, as? }`: redeem another node's invite. Asks it to take this node as a peer, then adds it under `peers.<its name>` (or `as`) with the token it answered. An entry already at the code's address, or the one the inviter recognised, takes the url and token instead of a new one: `409` before the inviter is asked when the name is a peer this node borrows from at another address, and a peer it only lends to keeps its entry. What `hearth join` asks for |
| `/peer/join` | anyone holding an open invite | `POST { secret, name, knows? }`: the inviter's half. A live secret, spent on use, adds `peers.<name>` with a fresh `accept` and answers `{ name, token }`. `knows` is the joiner's tokens as HMAC-SHA256 keyed with the secret: a peer sharing one (or bound with `tailnet` to the calling machine) is joined instead, keeping any `accept` it has, and the answer carries the matching proof as `knew`. `403` for a used, expired or unknown secret, `409` for a name already taken by a peer not recognised |

Anything else gets proxied to your backend untouched, so a client already using
`/unload` or llama-swap's `/upstream/<model>/…` keeps working. Those passthrough
paths **are not queued** unless a backend names them: see
[Backends that don't speak the OpenAI API](backends.md#backends-that-dont-speak-the-openai-api).

## Messages API clients

A client that speaks only the Messages API points its base URL at the node.
For Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4300
export ANTHROPIC_AUTH_TOKEN=<one of the node's apiKeys>
export ANTHROPIC_MODEL=my-model
claude
```

Claude Code always sends a credential, and a node with no `apiKeys` refuses
any credential it is shown, so the node needs a key for it. The key goes in
`ANTHROPIC_AUTH_TOKEN`, which is sent as a bearer token; `ANTHROPIC_API_KEY`
is sent as `x-api-key`, which the node does not read. The
model id is one this node offers, or a name a flow takes. Claude Code also asks
for a smaller model for background work under its own name, so a flow that takes
every other name (`inputs: ["*"]`) keeps those requests from a `404`.
`/v1/messages/count_tokens` is not served.

## What `/healthz` actually checks

It answers `200` with counts, or `503` when every backend it is watching has
gone:

```json
{"ok":true,"name":"web",
 "backends":{"total":9,"watched":2,"connected":2},
 "peers":{"total":1,"up":1}}
```

`watched` is the backends whose event stream hearth holds open — llama-swap,
today. That connection is the signal: when the backend dies the stream drops,
and hearth knows within a reconnect without having asked it anything. `503`
means every one of them is gone.

With a [canary](canary.md#canary) configured the body also carries
`"canary":{"degraded":0}`: how many models are answering, but not with an
answer. It is a count for the same reason as the rest, and the field is absent
when no canary is configured.

What this is deliberately NOT built on is "have we heard from it lately". On an
idle box nothing is heard from anything, so that reads silent across the board
while the node is perfectly well — a probe built on it goes red and stays red.
It is a decoration on the page, not a health signal, and the distinction is why
`answering` says so in its own docs.

`watched: 0` is an honest answer too, and worth reading. A node of `single` or
`none` backends — CPU sidecars — is never contacted unless something is being
asked of it, so hearth has no evidence either way and will not invent a verdict.
The check is weak for that config and says so in the number rather than
pretending.

Peers never affect `ok`. A peer being down is a routing input, not this node's
health.

It is unauthenticated and the main port may be bound wide, so it reports counts
and never names. Model ids, backend names and peer names stay behind the page's
gate.
