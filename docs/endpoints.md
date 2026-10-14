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
| `/v1/evict` | local | `POST { model }` drops a resident model off the backend that serves it. `409` while it is answering a request, when it is not resident, or when the backend can only clear everything and holds other models |
| `/lending` | local | `GET`: every peer with the requests and tokens it ran here (`lent`) and this node ran there (`borrowed`), today and over the 31 days kept, the limits it is held to as `terms` with those of its own named in `own`, `closed`: why it is turned away right now, or `null`, and the same use `byModel` and as tokens `byDay` |
| `/usage` | local | `GET ?days=N` (31 at most): requests, failures and tokens in and out, as day → caller → model, with `prices` for the models that carry one. Days are UTC. Tokens are the backend's own `usage` where its answer carries one; a stream without one is counted by its events, and the request by its estimated size |
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
| `/peer/hello`, `/peer/state` | peers | identity and capacity, per model |

Anything else gets proxied to your backend untouched, so a client already using
`/unload` or llama-swap's `/upstream/<model>/…` keeps working. Those passthrough
paths **are not queued** unless a backend names them: see
[Backends that don't speak the OpenAI API](backends.md#backends-that-dont-speak-the-openai-api).

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
