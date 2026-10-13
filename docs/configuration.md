# Configuration

Every key with its default. Only one backend's `url` is required. A key hearth
does not know is refused at startup, with the nearest real one suggested, so a
typo never loads as a default.

```yaml
name: box
backends:
  main: { url: "http://127.0.0.1:8080", kind: llama-swap }
```

A file in the earlier layout (`backend:`, `share:`, `peerTokens:`, lists for
`backends:` and `peers:`) is refused with one line pointing at `hearth migrate`,
which rewrites it in place, comments kept, with the original saved beside it.

| key | default | what it does |
|---|---|---|
| `version` | `3` | the layout this file is written in. `hearth init` and `hearth migrate` write it. A file that names a later layout than the node reads is refused; one with no `version` is read as the current layout |
| `name` | hostname | how this node identifies itself to peers |
| `listen.host` / `.port` | `127.0.0.1` / `4141` | widening the host is deliberate, see Security |
| `backends.<name>` | — | a server hearth fronts, with its own queue. At least one. See [Backends](backends.md) |
| `backends.<name>.url` | — | the OpenAI-compatible server. Required unless `server` and `port` are set |
| `backends.<name>.server` | this machine | the `servers` entry this backend runs on. See [Backends on another machine](backends.md#backends-on-another-machine) |
| `backends.<name>.port` | — | with `server` and no `url`: the backend is `http://<server host>:<port>` |
| `backends.<name>.kind` | `llama-swap` | where warm state comes from: `llama-swap`, `ollama`, `single`, `none` |
| `backends.<name>.serves` | discover | model ids this backend serves. Declaring replaces discovery and acts as an allowlist |
| `backends.<name>.concurrency` | `backendDefaults` | jobs at once on this backend |
| `backends.<name>.firstByteMs` / `.idleMs` | `backendDefaults` | per-backend deadlines. A sidecar that renders a clip before it answers at all needs a longer one than a chat server |
| `backends.<name>.activity` | none | `{ path, running, queued? }` — where a backend reports its OWN busy state, so one hearth forwards to but does not schedule still lights while it works. See below |
| `backends.<name>.resources` | none | hardware this backend uses. Backends on one exclusive card take turns. See [Backends that share a card](backends.md#backends-that-share-a-card) |
| `backends.<name>.hold` | none | `{ lanes, idleMs, seat? }`: while this backend's app has work (read off `activity`), keep these lanes off its hardware until it has been idle this long. See [Keeping background work off the card](backends.md#keeping-background-work-off-the-card-while-the-app-is-in-use) |
| `backends.<name>.resident` | `false` | stays loaded beside the card's swapping model and is asked to yield when it needs the memory. See [Something small that lives on a card](backends.md#something-small-that-lives-on-a-card) |
| `backends.<name>.key` | none | sent to this backend as `Authorization: Bearer` on every call, in place of anything the client sent. `env:NAME` keeps it out of the file |
| `backends.<name>.format` | `openai` | the API it speaks: `openai` (chat completions) or `anthropic` (Messages). See [Anthropic's API](providers.md#anthropics-api) |
| `backends.<name>.promptCache` | `true` | with `format: anthropic`: mark each request's system prompt, tools and conversation so far for the provider's prompt cache |
| `backends.<name>.cloud` | `false` | a provider's server on the internet: no hardware here, no warm state, and only the models under `serves`. See [A provider's models](providers.md#a-providers-models) |
| `backends.<name>.routes` | none | paths this backend answers besides chat, each with its lane and model. See [Backends that don't speak the OpenAI API](backends.md#backends-that-dont-speak-the-openai-api) |
| `resources.<name>.kind` | `gpu` | `gpu`, `cpu` or `other`. Picks the icon; `gpu` and `other` are exclusive unless shared |
| `servers.<name>.host` | — | a machine on your network that backends run on: an IP or hostname, no scheme or port |
| `resources.<name>.shared` | `false` | many backends at once, never arbitrated: CPUs, mostly. See [Hardware that is not a card](backends.md#hardware-that-is-not-a-card) |
| `backendDefaults.concurrency` | `1` | jobs at once per backend, unless it sets its own |
| `backendDefaults.firstByteMs` | `900000` | how long a backend may take to start answering. Catches one that accepts the connection and then never answers, which would otherwise hold its slot — and its card — until a restart. `0` waits forever |
| `backendDefaults.restMs` | `30000` | after three failures in a row (no answer, a 5xx, a 429, its key refused), how long a backend is passed over. Only a request whose flow has another line that fits is moved; one with nowhere else to go still tries it. The first request after the rest tries it again, and one more failure rests it again. `0` never passes one over. Chat only |
| `backendDefaults.idleMs` | `600000` | how long a backend may go silent once its answer has started. Catches a generation that hangs mid-stream. `0` waits forever |
| `scheduler.lanes` | `chat`, `batch` | named lanes and their base priority |
| `scheduler.lanes.<lane>.priority` | `0` | base priority. Lower goes first |
| `scheduler.lanes.<lane>.concurrency` | unset | the most slots of one backend this lane may hold at once. Unset is no ceiling. See Lanes |
| `scheduler.lanes.<lane>.maxWaitMs` | unset | fail a queued job in this lane with a 503 once nothing on its backend has started for this long. A guard against a wedged backend, not a deadline: a slow queue that keeps moving never trips it, nor does a job kept waiting by a neighbour's `hold` |
| `scheduler.agePerSecond` | `1` | priority earned per second waited, which is also the starvation bound |
| `scheduler.warmBonus` | `40` | priority discount for a model already loaded |
| `scheduler.maxPerLane` | `100` | how long one lane's queue may get before new work is refused. Off-box jobs are bounded separately, on their own count |
| `scheduler.maxPerCaller` | `0`, or `2` with apiKeys | queued-or-running jobs per caller per lane. Off without apiKeys, where every local caller is one identity |
| `models.<id>` | — | per-model settings. Where a model's requests go is a flow; see [Flows](routing.md#flows) |
| `models.<id>.lane` | the client's | lane this model's requests queue in, over the one the client asked for |
| `models.<id>.as` | unset | the id this one goes out as: an alias for another model. See [Advertising a nicer id](models.md#advertising-a-nicer-id-than-the-backend-uses) |
| `models.<id>.params` | unset | request fields stamped on every call (`temperature`, `reasoning_effort`, …). See [One resident model, several ids](models.md#one-resident-model-several-ids-different-defaults) |
| `flows.<name>.inputs` | none | the ids whose requests enter this flow. An id enters at most one. See [Flows](routing.md#flows) |
| `flows.<name>.steps` | — | where those requests go: tried in order, first match wins, the last always applies |
| `flows.<name>.takes` | chat | request paths this flow answers besides chat, each as a backend declares it under `routes:`. See [Types](routing.md#types) |
| `flows.<name>.sticky` | unset | how long a conversation stays where this flow first sent it, in ms, so later turns keep the same model |
| `flows.<name>.off` | `false` | switched off: requests for its inputs run as themselves |
| `flows.<name>.note` | unset | what the flow is for |
| `actions.<name>.log` | — | an action that writes this line to the log. See [Actions](routing.md#actions) |
| `actions.<name>.call` | — | an action that sends a request to this URL. `env:NAME` keeps it out of the file |
| `actions.<name>.method` | `POST` | `call` only: `POST`, `PUT` or `GET` |
| `actions.<name>.headers` | none | `call` only: headers to send. A value may be `env:NAME` |
| `actions.<name>.body` | every request fact | `call` only: the JSON to send |
| `actions.<name>.on` | `decided` | when it runs: as the step `decided`, once the request has `finished` either way, or only when it `failed` |
| `actions.<name>.slowerThan` | unset | only for a request that took longer than this many ms. It then runs once the request has finished, unless `on` says `failed` |
| `actions.<name>.every` | unset | run at most once in this many ms, however many requests name it |
| `models.<id>.emulate` | unset | `llama-server`: reshape the backend's answers into llama-server's format (`reasoning_content`, `timings`) for clients that expect it |
| `models.<id>.note` | unset | what the model is for. Shown to borrowers and as `description` on `/v1/models`. A note alone routes nothing |
| `canary` | unset | ask named models a question with one right answer, on a schedule, and take one that stops answering it out of rotation. Off unless configured; restart-only. See [Canary](canary.md#canary) |
| `models.<id>.backend` | auto | pin a model to a named backend instead of resolving it from the catalogs |
| `models.<id>.follow` | `false` | go out as whatever the pinned backend has loaded, and as `as` when nothing is (or when `as` is among several loaded). Needs `backend` and `as`. It follows any model, a non-chat one included, so pin it to a backend that serves one kind |
| `models.<id>.concurrency` | backend's | jobs this model may run at once, above OR below its backend's `concurrency`. See [One backend, models with different ceilings](backends.md#one-backend-models-with-different-ceilings) |
| `models.<id>.pool` | unset | token budget shared by this model's running turns: `tokens`, and `output` to cap what each turn reserves. See [One backend, models with different ceilings](backends.md#one-backend-models-with-different-ceilings) |
| `models.<id>.stats` | unset | what the model takes, for one that hasn't loaded or a backend that can't say: `context`, `vision`, `tools`, `thinking`, `effort`, `quant`. See [Knowing what a borrowed model can take](sharing.md#knowing-what-a-borrowed-model-can-take) |
| `models.<id>.shareAfterMs` | unset | a turn joins this model's running turns only once each has run this long, so two turns started together do not both pay for sharing the card. Only matters where `concurrency` is above 1 |
| `models.<id>.price` | unset | `{ in, out, cached? }`: what a million tokens sent to it and answered by it cost, in dollars; `cached` is the price of input the provider read from its prompt cache, where it reports that, and is `in` when unset. Usage is then shown as spend on the Keys page, `/usage` lists the prices, and a key's `limits.dollarsPerDay` counts it. Spend is worked out from the token counts at the price set now |
| `models.<id>.cacheMs` | `0` | keep an answer this long and give it to an identical request without running it. Identical means the same model and every request field the same. Shared by every caller, held in memory, and lost on restart. 0 keeps none. See [Keeping answers](models.md#keeping-answers) |
| `models.<id>.videoTokens` | `49152` | what one video costs this model when checking a request fits its context window. Size it from the seat: frames sampled per clip × tokens per frame |
| `peers.<name>` | — | one entry per friend: `url` and `token` to borrow from them, `accept` to lend to them, or both |
| `peers.<name>.url` | — | the peer's hearth, main port |
| `peers.<name>.token` | — | what you present when borrowing from them |
| `peers.<name>.accept` | — | what they present when borrowing from you. Without it they cannot |
| `peers.<name>.models` | `{}` | `your id: their id` for each model you borrow. Also the allowlist |
| `lending.models` | `[]` | models peers may run here. Empty lends nothing. A model on a `cloud` backend is refused: a peer would be spending that provider's key |
| `lending.lane` | lowest-priority lane | which lane borrowed work enters |
| `lending.maxConcurrent` | `2` | jobs one peer may have in flight |
| `lending.rateLimit` | `600` | peer inference requests per hour. Capacity polling has its own budget |
| `borrowing.firstByteMs` | `180000` | how long to wait for a peer to start answering before falling back. `0` waits forever |
| `borrowing.freshMs` | `4000` | how long a good peer reading is reused before a routing decision asks again |
| `borrowing.downMs` | `30000` | how long a failed probe is remembered, so an outage doesn't make every local request pay the timeout |
| `borrowing.pollMs` / `.staleMs` | `60000` / `60000` | background floor that warms the cache. The real mechanism is on-demand |
| `borrowing.coldPenalty` | `2` | what a model load is worth to `fastest`, in queued-jobs-equivalent |
| `apiKeys` | `[]` | keys allowed on `/v1/*`. Empty means loopback only. Setting it means loopback needs a key too, including any local tool you point at this. An entry may be `{ key, label }` to name a caller, and may carry `models`, `expires` and `limits` — see below |
| `operator` | unset | the console login, `{user, passHash}`. Written by the console's first-run setup or `hearth set-operator`; applies live; see [The console](console.md#the-console) |
| `maxBodyBytes` | `33554432` | largest accepted request body |
| `shutdownGraceMs` | `30000` | how long a shutdown waits for requests already in flight. `0` destroys them |
| `routers.<name>` | none | A rulebook besides `flows:`: `flows` in the same shape, and `strict: true` so a request runs on the model its line names or fails. See [Routers](routing.md#routers). |
| `callers.<who>` | none | Which rulebook a caller goes by: an api key's label, `local`, or `*` for everyone else, each to a name under `routers:` or `default`. |
| `layout.<node>` | none | `{ x, y }`: where the console's topology draws a node you placed. Written by [its editor](console.md#editing-on-the-graph); nodes without one are laid out |
| `modelHeader` | `true` | send `x-hearth-model` on every chat answer: the id the request ran as. See [Flows](routing.md#flows) |
| `historyFile` | unset | a file that keeps the console's day of history, its recent log lines and the month of usage per caller across restarts, written every minute and at shutdown. Unset keeps them in memory. A file written by a later hearth is set aside as `<file>.v<n>` and a fresh one started |
| `stateFile` | unset | a console sidecar from an earlier version. If it exists at startup its contents are written into the config and it is renamed `.migrated` |

Tokens accept `env:NAME`, so the config stays committable.

An `apiKeys` entry can be a bare secret or `{ key, label }`. A keyed caller
otherwise shows up as `key:<hash>` — the first bytes of `sha256(key)`, so no
guessable key material lands in a log — which keeps two callers apart but says
nothing about who they are. A label replaces that with your own word for the
caller, so the log, `/queue` and the console read `key:dsh` instead:

```yaml
apiKeys:
  - env:HEARTH_API_KEY                        # bare: still shows as key:<hash>
  - { key: "H_…dsh", label: dsh }
  - { key: env:NOVA_KEY, label: nova }
```

Two keys cannot share a label, and the same secret cannot appear twice: a
caller id is an identity — `maxPerCaller` counts against it — so two keys under
one name would quietly share a single budget, and a repeated secret makes every
later entry unreachable because the first match wins. Both are refused at
startup.

The label is your word, not a secret, so it is never taken through `env:` and
never hashed — and it appears wherever caller ids do, the console included.
That is the one thing to weigh: name the keys you are content to see named by
whoever can sign in to the console. Leave a key bare and
it stays a hash.

A key can also be **scoped** with `models:`. Every key above is a full local
caller — chat on anything, the passthrough, `/v1/warm`, `/control`. A scoped
key gets `POST /v1/chat/completions` for exactly the ids it names and a
`/v1/models` filtered to them, and every other route answers 403:

```yaml
apiKeys:
  - { key: env:HEARTH_APP_KEY, label: app }              # full
  - { key: env:VOICE_KEY, label: voice, models: [voice] }      # chat on one id, nothing else
  - { key: env:GUEST_KEY, label: guest, models: [chat] }       # a name a flow takes, in any of its variants
```

A scope names models, or names a [flow](routing.md#flows) takes. Held to a
name a flow takes, a key may ask for it and for its variants (`chat`,
`chat:fast`), and goes wherever the flow sends it: the models behind the flow
need not be in its scope, and cannot be asked for by their own names.

A key can **expire** and be **limited**. `expires` is a day, and the key works
through the end of it (UTC); after that it is refused like any unknown key.
`limits` holds it to so many requests a minute, so many tokens a UTC day,
counted in and out, and so many dollars a UTC day (`dollarsPerDay`) on models
that carry a [`price`](#configuration); a request over any is answered `429`.
Leave one out, or set it to 0, for no limit. The token count is the one [`/usage`](endpoints.md#endpoints)
reports, so it is the backend's own where its answer carries one and an
estimate where it does not.

```yaml
apiKeys:
  - { key: env:GUEST_KEY, label: guest, expires: 2030-06-30, limits: { requestsPerMinute: 20, tokensPerDay: 200000 } }
```

For the caller that only has a model picker and runs on the softest box you
own: its key leaking must cost you one model at one priority, not the GPU. The
ids must be routes in `models:` — the lane and params that route carries are
the whole point — so a typo is a startup error rather than a 403 in production.
