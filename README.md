# hearth

A queue in front of your local inference server, and optionally a way to lend
the spare capacity to someone you trust.

One GPU fits one model at a time. The moment two things want different models
from it they thrash, each evicting the other's weights and paying the load tax
over again. hearth is the admission point that stops that. It speaks the OpenAI
API, so nothing you already use has to change.

```bash
npm i -g @vcvzgbzz/hearth
hearth init          # probes for llama-swap / llama.cpp / ollama, writes hearth.yaml
hearth serve
```

Point any client at `http://127.0.0.1:4141/v1` instead of your backend. That's
the whole migration.

## What it does

Three things, and only the first one is mandatory.

**Queues.** Named lanes with priorities, aging so nothing starves, a per-caller
cap, and a preference for whatever model is already loaded.

**Speaks OpenAI.** `/v1/chat/completions` and `/v1/models`, streaming included.
Bodies pass through byte-for-byte, so tool calls, vision parts and whatever gets
invented next month keep working.

**Federates, if you want it to.** Point a model at a peer and those requests run
on their machine. They never take a local slot, because they never touch the
local GPU.

## Lanes

Lanes are how you say what matters. Each one has a priority, lower dispatches
first, and a job earns priority the longer it waits so nothing starves.

```yaml
scheduler:
  lanes:
    chat:  { priority: 0 }     # a person is watching this
    batch: { priority: 100 }   # a render nobody is waiting on
```

Pick one per request with a `lane` field in the body. It isn't part of the
OpenAI schema, so hearth strips it before the request reaches your backend:

```json
{ "model": "big-model", "lane": "batch", "messages": [...] }
```

Leave it out and the request lands in the first lane you declared.

Peers don't get to choose. Borrowed work is pinned to `lending.lane`, which defaults
to your lowest-priority lane. Lanes express the host's priorities, and a guest
doesn't get a vote in them.

### A ceiling for a lane

Priority orders the queue. It does nothing about a slot that is free, and
nothing is ever preempted, so on a seat that batches a low-priority lane takes
every slot nobody is using right now and keeps it until its call ends. Work that
arrives in bulk — a memory service summarising each finished chat, a nightly
re-index — ends up sharing the card with the people it was ranked below.

`concurrency` on a lane is the most of a backend's slots that lane may hold at
once:

```yaml
scheduler:
  lanes:
    chat:   { priority: 0 }
    memory: { priority: 100, concurrency: 2 }   # never more than 2 slots of any backend
```

It is a maximum, not a reservation: sixteen chat turns still take all sixteen
slots, and `memory` waits for one like anybody else. A job held back by its
lane's ceiling is passed over rather than waited on, so it never holds up the
lanes behind it, however long it has aged. Leave it off and the lane has no
ceiling of its own, which is how every lane behaved before. Off-box jobs hold no
local slot and are not counted. The ceiling is per backend: `concurrency: 2` on a
node with two backends lets the lane hold two slots on each.

## Configuration

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
| `name` | hostname | how this node identifies itself to peers |
| `listen.host` / `.port` | `127.0.0.1` / `4141` | widening the host is deliberate, see Security |
| `backends.<name>` | — | a server hearth fronts, with its own queue. At least one. See below |
| `backends.<name>.url` | — | the OpenAI-compatible server |
| `backends.<name>.kind` | `llama-swap` | where warm state comes from: `llama-swap`, `ollama`, `single`, `none` |
| `backends.<name>.serves` | discover | model ids this backend serves. Declaring replaces discovery and acts as an allowlist |
| `backends.<name>.concurrency` | `backendDefaults` | jobs at once on this backend |
| `backends.<name>.firstByteMs` / `.idleMs` | `backendDefaults` | per-backend deadlines. A sidecar that renders a clip before it answers at all needs a longer one than a chat server |
| `backends.<name>.activity` | none | `{ path, running, queued? }` — where a backend reports its OWN busy state, so one hearth forwards to but does not schedule still lights while it works. See below |
| `backends.<name>.resources` | none | hardware this backend uses. Backends on one exclusive card take turns. See [Backends that share a card](#backends-that-share-a-card) |
| `backends.<name>.resident` | `false` | stays loaded beside the card's swapping model and is asked to yield when it needs the memory. See [Something small that lives on a card](#something-small-that-lives-on-a-card) |
| `backends.<name>.routes` | none | paths this backend answers besides chat, each with its lane and model. See [Backends that don't speak the OpenAI API](#backends-that-dont-speak-the-openai-api) |
| `resources.<name>.kind` | `gpu` | `gpu`, `cpu` or `other`. Picks the icon; `gpu` and `other` are exclusive unless shared |
| `resources.<name>.shared` | `false` | many backends at once, never arbitrated: CPUs, mostly. See [Hardware that is not a card](#hardware-that-is-not-a-card) |
| `backendDefaults.concurrency` | `1` | jobs at once per backend, unless it sets its own |
| `backendDefaults.firstByteMs` | `900000` | how long a backend may take to start answering. Catches one that accepts the connection and then never answers, which would otherwise hold its slot — and its card — until a restart. `0` waits forever |
| `backendDefaults.idleMs` | `600000` | how long a backend may go silent once its answer has started. Catches a generation that hangs mid-stream. `0` waits forever |
| `scheduler.lanes` | `chat`, `batch` | named lanes and their base priority |
| `scheduler.lanes.<lane>.priority` | `0` | base priority. Lower goes first |
| `scheduler.lanes.<lane>.concurrency` | unset | the most slots of one backend this lane may hold at once. Unset is no ceiling. See Lanes |
| `scheduler.lanes.<lane>.maxWaitMs` | unset | fail a queued job in this lane with a 503 once nothing on its backend has started for this long. A guard against a wedged backend, not a deadline: a slow queue that keeps moving never trips it |
| `scheduler.agePerSecond` | `1` | priority earned per second waited, which is also the starvation bound |
| `scheduler.warmBonus` | `40` | priority discount for a model already loaded |
| `scheduler.maxPerLane` | `100` | how long one lane's queue may get before new work is refused. Off-box jobs are bounded separately, on their own count |
| `scheduler.maxPerCaller` | `0`, or `2` with apiKeys | queued-or-running jobs per caller per lane. Off without apiKeys, where every local caller is one identity |
| `models.<id>` | — | routing policy per model. Anything unlisted stays local |
| `models.<id>.policy` | `local` | where requests run: `local`, `peer`, `spillover` or `fastest`. See [Sharing capacity](#sharing-capacity) |
| `models.<id>.peers` | any that maps it | only these peers may run it |
| `models.<id>.spilloverAt` | `1` | `spillover` only: go to a peer once this many jobs are queued here |
| `models.<id>.fallbackLocal` | `true` | run here when no peer can take it |
| `models.<id>.lane` | the client's | lane this model's requests queue in, over the one the client asked for |
| `models.<id>.as` | unset | the id this one goes out as: an alias for another model. See [Advertising a nicer id](#advertising-a-nicer-id-than-the-backend-uses) |
| `models.<id>.params` | unset | request fields stamped on every call (`temperature`, `reasoning_effort`, …). See [One resident model, several ids](#one-resident-model-several-ids-different-defaults) |
| `models.<id>.emulate` | unset | `llama-server`: reshape the backend's answers into llama-server's format (`reasoning_content`, `timings`) for clients that expect it |
| `models.<id>.note` | unset | what the model is for. Shown to borrowers and as `description` on `/v1/models`. A note alone routes nothing |
| `models.<id>.backend` | auto | pin a model to a named backend instead of resolving it from the catalogs |
| `models.<id>.follow` | `false` | go out as whatever the pinned backend has loaded, and as `as` when nothing is (or when `as` is among several loaded). Needs `backend` and `as`. It follows any model, a non-chat one included, so pin it to a backend that serves one kind |
| `models.<id>.concurrency` | backend's | jobs this model may run at once, above OR below its backend's `concurrency`. See below |
| `models.<id>.pool` | unset | token budget shared by this model's running turns: `tokens`, and `output` to cap what each turn reserves. See [One backend, models with different ceilings](#one-backend-models-with-different-ceilings) |
| `models.<id>.stats` | unset | what the model takes, for one that hasn't loaded or a backend that can't say: `context`, `vision`, `tools`, `thinking`, `effort`, `quant`. See [Knowing what a borrowed model can take](#knowing-what-a-borrowed-model-can-take) |
| `models.<id>.shareAfterMs` | unset | a turn joins this model's running turns only once each has run this long, so two turns started together do not both pay for sharing the card. Only matters where `concurrency` is above 1 |
| `models.<id>.videoTokens` | `49152` | what one video costs this model when checking a request fits its context window. Size it from the seat: frames sampled per clip × tokens per frame |
| `peers.<name>` | — | one entry per friend: `url` and `token` to borrow from them, `accept` to lend to them, or both |
| `peers.<name>.url` | — | the peer's hearth, main port |
| `peers.<name>.token` | — | what you present when borrowing from them |
| `peers.<name>.accept` | — | what they present when borrowing from you. Without it they cannot |
| `peers.<name>.models` | `{}` | `your id: their id` for each model you borrow. Also the allowlist |
| `lending.models` | `[]` | models peers may run here. Empty lends nothing |
| `lending.lane` | lowest-priority lane | which lane borrowed work enters |
| `lending.maxConcurrent` | `2` | jobs one peer may have in flight |
| `lending.rateLimit` | `600` | peer inference requests per hour. Capacity polling has its own budget |
| `borrowing.firstByteMs` | `180000` | how long to wait for a peer to start answering before falling back. `0` waits forever |
| `borrowing.freshMs` | `4000` | how long a good peer reading is reused before a routing decision asks again |
| `borrowing.downMs` | `30000` | how long a failed probe is remembered, so an outage doesn't make every local request pay the timeout |
| `borrowing.pollMs` / `.staleMs` | `60000` / `60000` | background floor that warms the cache. The real mechanism is on-demand |
| `borrowing.coldPenalty` | `2` | what a model load is worth to `fastest`, in queued-jobs-equivalent |
| `apiKeys` | `[]` | keys allowed on `/v1/*`. Empty means loopback only. Setting it means loopback needs a key too, including any local tool you point at this. An entry may be `{ key, label }` to name a caller — see below |
| `operator` | unset | the console login, `{user, passHash}`. Written by the console's first-run setup or `hearth set-operator`; applies live; see [The console](#the-console) |
| `maxBodyBytes` | `33554432` | largest accepted request body |
| `shutdownGraceMs` | `30000` | how long a shutdown waits for requests already in flight. `0` destroys them |
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
```

For the caller that only has a model picker and runs on the softest box you
own: its key leaking must cost you one model at one priority, not the GPU. The
ids must be routes in `models:` — the lane and params that route carries are
the whole point — so a typo is a startup error rather than a 403 in production.

## Endpoints

Beyond `/v1/chat/completions` and `/v1/models`:

| path | who | what |
|---|---|---|
| `/ui` | anyone | the console, a static shell; its data takes loopback or a login: topology with live request flow, models and sharing, the queue and recent requests, and the config file by section. ⌘K jumps anywhere |
| `/restart` | local | `POST` drains in-flight work and exits `75`, so a supervisor with `Restart=on-failure` (or `always`) starts the node again; the console offers it while a change waits for a restart. Without a supervisor it only stops. `501` when not run by `hearth serve` |
| `/control` | local | read or change what leaves this node: lending, borrowing, per-model sharing, peer model maps |
| `/queue/events` | local | the caller's own jobs, pushed over SSE: a `snapshot` on connect, then `jobs` whenever the list changes (queued, started, finished, moved in line). One connection serves every job a client has, so it never needs to poll |
| `X-Hearth-Job: <id>` | request header | the client's own id for this request (letters, digits, `._:-`, up to 128). It comes back as the job's `id` on `/queue` and `/queue/events`, so a client can match updates to its own work |
| `X-Hearth-Queue: stream` | request header | on a streamed chat, open the stream while the request waits and send `: hearth-queue {"position":N}` comments (how many are ahead, the running turn included). OpenAI-style parsers skip comments. A failure after that arrives as an SSE `data: {"error": …}` frame, since the 200 is already sent |
| `/config` | local | the config file itself: `GET` its text and status, `PATCH` paths or the whole text |
| `/login`, `/logout` | anyone | `POST {user, pass}` for the operator session cookie; 404 with no `operator` set |
| `/setup` | anyone, once | `GET` says `{needed}`; `POST {user, pass}` writes the first `operator` and signs it in. `409` once one exists |
| `/` | anyone | `GET` redirects to `/ui` |
| `/network` | local | every node, what each one serves, and what's **loaded right now**. Also lists peer models you haven't mapped, which is usually the config mistake people actually make |
| `/queue` | local | jobs in flight, with lane, caller and position |
| `/ui/data`, `/ui/events` | loopback, or a login | the page's data, pushed. A snapshot then diffs |
| `/healthz` | anyone | whether this node can serve. `503` when it can't. The one unauthenticated endpoint |
| `/peer/hello`, `/peer/state` | peers | identity and capacity, per model |

Anything else gets proxied to your backend untouched, so a client already using
`/unload` or llama-swap's `/upstream/<model>/…` keeps working. Those passthrough
paths **are not queued**, see below.

### The page is pushed, not polled

`/ui/events` is an SSE stream: one `snapshot` frame with the whole payload,
then a `patch` frame whenever something changes.

```
event: snapshot
data: {"net":{...},"q":{...},"hist":[...120 samples...],"histKeep":120,...}

event: patch
data: {"set":{"q":{...},"calls":[...]},"add":{"hist":[{...one sample...}]}}
```

The poll it replaces asked for 95KB every three seconds, and **93% of that was
history the page already had** — 120 samples, of which 119 were unchanged. New
samples now arrive one at a time, and a node with nothing happening sends
nothing at all.

A patch is a diff of the same object `/ui/data` serves, built by the same
function, so the two transports cannot drift: add a field and both carry it.
`operator` is the exception — it describes the connection rather than the
node, so it is stamped on the snapshot and never repeated.

`/ui/data` is unchanged and is still there. EventSource is the one transport an
extension or a proxy can break in a way that looks like silence, so a stream
that has not delivered a snapshot within ten seconds is abandoned and the page
goes back to polling exactly as before. An error *after* the first snapshot is
left to EventSource's own retry — a node restarting is the common case — and
only marks the page stale.

The stream is deliberately not counted as a request in flight, so a page left
open in a tab cannot hold a shutdown open for the whole `shutdownGraceMs`.
Streams are ended first when the node stops, so the browser starts retrying
straight away.

### Weights that are not on the card

A model too big for its card can still run: llama.cpp assigns part of it to the
host and computes that part on the CPU. It is the trade that makes a large MoE
fit at all — and it is invisible. The model is loaded, the card is busy, every
number on the page looks normal, and the thing is simply slow, because **every
token** pays for it, not just the first one.

hearth reads it off the launch command and draws it: the backend says
`32 layers on host`, and a `host` node appears in the card row with a steady
violet edge **to the card the model is split with** — because that pair is the
thing that explains the speed. The two halves exchange on every token, and the
chain reads end to end: the backend, its card, and the other half of the model.
Steady, not travelling: this is not traffic passing through, it is where part of
a model lives, and it does not finish.

**"On the host" is as far as this goes, and the limit is deliberate.** Weights
are mmap'd from the model file, so whether they are served out of RAM or faulted
off the disk depends on whether the model fits in RAM; a model larger than RAM
faults pages off the disk on *every* generation. That is a live measurement on the machine running the model — `/proc/<pid>/stat` and
`smaps` — not something a launch command knows, and not something a proxy on
another machine can see. hearth reports the assignment, which it can prove, and
does not guess at the medium, which it cannot.

The command line is the only source. Checked against a live box:

| | reports placement? |
|---|---|
| llama-server `/props` | no — no layer counts, no buffer sizes, nothing |
| llama-swap `/api/events` | no — `{id, state, unlisted}` |
| llama-swap `/running` | **yes** — the full `cmd` |

So it is read once per change in what is resident, and never on a timer: a
running process's argv cannot change under it. Only two flags are trusted,
because only two say something unambiguous on their own — `--n-cpu-moe N`
(N layers of experts on the CPU) and `-ngl 0` (a CPU model, which is a
different statement). A partial `--n-gpu-layers 20` is just as interesting and
is deliberately NOT read: the useful form is "20 of 33", and nothing here
reports a model's layer count, so a bare 20 would be a number with nothing to
compare it to.

None of this is a fault to clear. It is a fact worth knowing about the model
that is paying for it.

### A backend that works without hearth scheduling it

Some backends do their work across two requests, not one. ComfyUI takes a
workflow on `/prompt`, answers in milliseconds with an id, and then renders for
the next minute — the request hearth forwarded is long gone before the GPU even
spins up. `routes:` cannot queue that: a slot held across a poll leaks the
moment a client stops polling. So such a backend runs as a `kind: none` node
hearth forwards to and otherwise cannot see, and it draws idle through the whole
render.

`activity:` fixes the drawing without pretending to schedule the work. The
operator names a path the backend already serves and which field on it carries
the count:

```yaml
backends:
  comfy:
    url: http://127.0.0.1:8188
    kind: none
    resources: [gpu0]
    activity:
      path: /queue              # a path the backend already serves
      running: queue_running    # a field: an array is its length, a number is itself
      queued: queue_pending     # optional; some backends report one queue, some two
```

Prefer the smallest endpoint that carries the count. ComfyUI also answers
`/prompt` with `exec_info.queue_remaining`, a single number; `/queue` above is
richer because it splits running from pending, but it embeds the whole workflow
graph of every item, and a buffered control-plane reply is capped at 1 MiB — a
queue deep enough to pass that reads as unknown rather than as a count, which is
the moment you most wanted one.

hearth reads only those fields and never learns the app — the same bargain
`routes:` strikes. When something is running the node lights **amber**, exactly
like a forwarded request: real work on the card that hearth did not admit, so it
holds no slot and the card draws no holder for it. `running` and `queued` may be
dotted paths (`exec_info.queue_remaining`).

A reading that came back stands for a few seconds after it does, so one dropped
poll does not blank a working node — but only for a few: a backend that stays
unreadable goes to unknown on its own.

Two things it will not do. It never claims the card — with the backend sharing a
GPU, hearth's arbiter genuinely cannot see this work, and drawing it as held
would be the same lie forwarded work exists to correct. And a reading it could
not get — an unreachable backend, a field that was not there — draws as
**unknown**, never as idle: a failed poll is not evidence the thing is quiet.
The path is read only while a page is open, on the same page-driven cadence as
the rest of the console; hearth adds no background poll for it.

### What `/healthz` actually checks

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

## The status page

`http://127.0.0.1:4141/ui`, once `hearth serve` is running. React and Tailwind,
compiled to one file at build time and inlined into the page, so it is still a
single response and still adds **nothing** to what `npm install` pulls down —
the browser half is bundled from devDependencies and the package keeps its one
runtime dependency.

Four pages, and ⌘K jumps to anything on them:

- **Topology**: this node, its backends, the hardware they share, and its peers,
  with requests drawn as they flow. Click anything for its details and controls.
- **Models**: every model on one row: which nodes hold it, whether it is loaded
  anywhere, and whether you are lending it. `/network` is always one node's
  view; this is all of them at once.
- **Queue**: jobs in flight and recent calls, queue depth over the last ten
  minutes, and **which model was in use, when**. One lane per model: a faint
  track where it was resident, and a bright segment for every request that ran
  on it. A GPU flipping between two models draws a staircase, and the caption
  counts the swaps. That thrash is the thing hearth exists to prevent, and you
  cannot see it in an instantaneous reading. Ids that are one seat under
  several names (`as`) fold into one lane.
- **Config**: `hearth.yaml` by section, or as text. See below.

The history is a fixed ring of 120 samples taken every 5s, held in memory. It
dies with the process, exactly like the queue does.

### Changing things from the page

Besides the config editor, the Topology and Models pages change three things
directly:

- **lending** and **borrowing**, the two directions of federation, as separate
  switches. These two are operational: they apply at once and a restart clears
  them. Pausing lending empties what you lend, so peers see a healthy node
  offering nothing and stop choosing you, rather than a wall of 403s that looks
  like a revoked token. Pausing borrowing removes peers as routing candidates,
  so a model with `fallbackLocal: false` refuses cleanly.
- **lent / held per model**, written into `lending.models`. You can hold back one
  model without pausing the rest, or lend one the file never listed. A model no
  backend here serves is refused — advertising it would 404 every request, and
  the peer's operator cannot tell that from a broken link.
- **link / unlink** on a peer's model map, which writes both halves at once: the
  mapping and the route. Unlinking the last peer for a model takes its route
  with it — a `policy: peer` with nothing mapped can never fire again. A mapping on its own is only an allowlist entry, and a
  link without a route is a model that looks reachable and quietly runs at home
  forever. A model you also serve gets `policy: fastest` with a local fallback;
  one you do not gets `policy: peer` and no fallback, since home is a backend
  that has never heard of it.

### Editing the config from the page

Each section lists its entries as cards. A setting's description shows while it
is focused. **add setting** searches every setting the entry can take, including
those inside a group (`stats.vision`), and goes to one that is already set.
Click an entry's name to rename it; the rename changes only the key, so its
comments and layout stay. Nothing is written until **review & save** has shown
the diff and said whether it applies live or needs a restart.

When a change is waiting for a restart, the header offers **restart**. hearth
finishes what is in flight, then exits with status `75` so a supervisor that
restarts on failure (systemd's `Restart=on-failure`) brings it straight back,
and the page reconnects. Without such a supervisor it only stops.

### Where changes go

`hearth.yaml` is the only config state. Every change from the console or the API
is written into that file as it is made — comments and layout intact — and the
running node follows the file. There is no save step and nothing to sync.

Unlinking a peer's last model is fine, and so is a peer that maps nothing —
that is simply the state between deciding to trust someone and deciding what to
borrow. Their url, token and your notes stay where they are, and the console
still lists everything they serve, so borrowing again is a click. **Deleting** a
route or a mapping takes its comments with it, because they belong to the thing
being deleted.

Most of the config applies as soon as it is written: models and routes, sharing,
notes, peers' model maps, api keys and peer tokens, and the deadlines and limits
read per request. The rest — listen addresses, backends, resources, lanes, and
adding or changing a peer — is written immediately but takes effect on the next
restart, and the console lists those keys until then.

Hand edits work the same way. hearth watches the file and loads an edit as soon
as it is saved; an edit that does not load is reported with the reason, and the
node keeps running the last config that did. A change from the console always
builds on the file as it is on disk, so it never overwrites an edit made in an
editor.

A write is refused, and the file left untouched, when:

- the result fails validation — the error names the field
- the file is not writable
- with `PATCH /config`, the part being edited changed on disk since it was read

Under `ProtectSystem=strict` the unit needs to say the config is writable — and
must not also say the opposite, which is easy to miss because both lines look
like hardening:

```ini
ReadWritePaths=/etc/hearth.yaml
ReadOnlyPaths=/opt/hearth /etc/hearth.env   # NOT the config as well
```

`ReadOnlyPaths` wins for a path named in both, silently. Only the file needs to
be writable, not `/etc` — hearth writes in place when it cannot stage a temp
file beside the config, which is exactly what that pairing produces.

### Editing the file over HTTP

`GET /config` returns the file's text, a `hash`, and its status: `restartPending`
and, if the file on disk does not load, `error`. `PATCH /config` edits it:

```bash
# set or delete paths; anything the edit did not touch may have changed meanwhile
curl -X PATCH localhost:4141/config -H 'content-type: application/json' \
  -d '{"baseHash": "<hash>", "ops": [{"path": ["backendDefaults", "idleMs"], "value": 300000}]}'

# replace the whole file; refused with 409 unless baseHash is current
curl -X PATCH localhost:4141/config -H 'content-type: application/json' \
  -d '{"baseHash": "<hash>", "text": "..."}'
```

An op can also rename a map key in place, keeping its value and comments:
`{"path": ["peers", "old-name"], "rename": "new-name"}`. Renaming onto a name
that exists is a 400, and renaming something that is not there is a 409.

Add `"dryRun": true` to see the resulting text without writing it. A refusal is
`{"error": {"message", "path"}}`: 422 for a config that would not load (with the
field), 409 for a conflict.

### The console

`/ui` is open to anyone who can reach the port, but it is only a shell: every
byte of data comes from `/ui/data` and `/ui/events`, and those answer loopback
or a signed-in operator. **An api key does not open them.** A browser cannot
send a bearer token on an `EventSource`, and the alternatives are worse: a key
in the query string ends up in logs and history.

From loopback the console needs nothing. From anywhere else, the first visit
to a node with no login asks you to create one, and the address alone is enough:
`http://<host>:4141` redirects to `/ui`. Until that happens, anyone who can reach
the port can claim it, so create it before binding wide, or from the shell:

```bash
hearth set-operator admin 'a long passphrase'   # writes operator: {user, passHash}
```

Either way the page then asks for it. A changed login applies without a restart and
signs every existing session out. A session is an HttpOnly, SameSite=Lax cookie that
slides for 30 days and lives in memory, so a restart signs everyone out. It is a
full local identity — `/control`, `/config` and the passthrough included — so
treat the password like an unscoped api key. Failed logins are throttled per
user and per address, and an unknown user costs the same scrypt as a known one.

The console is on the main port, so it is reachable wherever that port is. Bind
it to a tailnet address rather than a LAN one, and never put a proxy in front of
hearth: it decides local trust by source address, and a proxy makes every
caller look like loopback.

## More than one local backend

A box often runs more than one provider: a swapping chat model on the GPU, plus
something small and always resident on another port, like an embedder, a
classifier, or a CPU-only model. Give hearth a list and it fronts them all on one
port, under one federation identity:

```yaml
backends:
  gpu: { url: "http://127.0.0.1:8080", concurrency: 1, kind: llama-swap }
  side: { url: "http://127.0.0.1:11434", concurrency: 4, kind: none }
```

**Each backend is its own queue.** Its own concurrency, its own warm state, its
own admission control. A model resolves to exactly one backend and waits only
there, so a 20ms embedding never sits behind a 40s generation. That is the whole
point: sharing one queue would make the second backend worse than useless.

Nothing schedules *across* backends. hearth works out where a job belongs and
queues it there, and that is all. This is not the multi-GPU scheduler, which is
still out of scope — a job never gets placed somewhere other than where its
model lives.

### Backends that share a card

Independent queues are right until two of them are one piece of hardware. Two
llama-swap instances pinned to different GPUs really are independent; a backend
running a model large enough to span both cards is independent of neither, and
neither queue can see it. Both dispatch, both load, and the card is
over-committed — which on some drivers is not a slow request but a wedged GPU.

Say what each backend consumes and the ones that overlap take turns:

```yaml
backends:
  chat: { url: "http://127.0.0.1:9292", resources: [gpu0] }
  image: { url: "http://127.0.0.1:9293", resources: [gpu1] }
  big: { url: "http://127.0.0.1:9294", resources: [gpu0, gpu1] }
```

`chat` and `image` never wait for each other. `big` waits for both, and
both wait for `big`. The names are yours and mean nothing outside this file.

This is still not placement. Routing is untouched: a model resolves to exactly
one backend by the same rules as before, and nothing decides a job would be
better off elsewhere. What it adds is that a backend can *wait* for another —
the one thing "each is its own admission domain" gets wrong when two domains
are one card.

A backend holds its resources while it has work — not per job, and not only
while something is running. Its `concurrency` already says how much may run at
once, and dropping the card in the gaps between its own jobs would mean paying
the handover again for work that was already its.

Before the first job of a turn goes, hearth unloads any llama-swap backend that
overlaps, because winning the arbitration only means nobody else is *running*
there: a neighbour that finished a minute ago still has weights resident, and on
a card sized for one model that is the same as occupied. Every job admitted
during that turn waits for the eviction, not just the one that triggered it.
Eviction is expensive, so it is logged (`pool.evict`), happens once per turn,
and the whole sequence is bounded — a neighbour that will not answer an unload
does not get to hold the card hostage.

A turn ends when the backend runs out of work, or after 30 seconds if another
backend has been waiting. Both halves matter. Handing the card over per job
would be perfectly fair and cost a cold load every time — the load tax the queue
exists to avoid, moved up a level. Never handing it over starves the neighbour:
a backend under sustained load would keep the card indefinitely, because it
releases and re-takes it faster than anyone else can be woken. So a holder keeps
its weights while it is busy, and yields once it has had its turn and somebody
is actually waiting. Nothing is ever taken from a backend nobody is competing
with.

#### Hardware that is not a card

Everything above assumes overlapping means taking turns, which is true of a GPU
and false of a CPU. Six small sidecars share one CPU perfectly happily, and
serializing them would be wrong — badly wrong, given the paragraph above:
taking a resource *unloads* every other backend holding it, so describing a
shared CPU under those rules would thrash the models least able to afford it.

So there was no safe way to say "these run on the CPU", and the only option was
to say nothing — which left the console unable to draw what half a deployment
runs on.

Declare the resource and it can:

```yaml
resources:
  gpu0: { kind: gpu }
  gpu1: { kind: gpu }
  cpu:  { kind: cpu, shared: true }

backends:
  chat: { url: "...", resources: [gpu0] }
  guard: { url: "...", resources: [cpu] }
  judge: { url: "...", resources: [cpu] }
```

`shared: true` means several backends may use it at once, and hearth does not
arbitrate it at all — a shared resource is kept away from the arbiter rather
than the arbiter being taught a second mode, so nothing waits for it and nothing
is evicted off it. `guard` and `judge` now say what they run on, and the status
page draws them on it.

Only a `llama-swap` backend can be told to unload. A `single` or `ollama`
backend reports a model it cannot let go of, so config refuses one on an
exclusive resource another backend takes turns on: that neighbour could never
clear the card. Declare it `resident`, or mark the resource `shared`. A `none`
backend reports nothing, so hearth loads beside it. New kinds are added in
`src/kinds.ts`, and `test/kinds.test.ts` holds each one to the same contract.

`kind` is `gpu`, `cpu` or `other` and is display only — it picks the mark on the
status page and never reaches admission. `other` is there because this mechanism
is just a named mutex with a picture, and it will fit things neither word
describes.

The whole block is optional and additive: a name a backend uses but nobody
declares is an exclusive `gpu`, which is what every config written before this
meant by it. A `kind` that is not one of the three is refused at startup rather
than discovered later as the wrong icon.

Omit `resources` and nothing changes, which is every config that predates it.

#### Something small that lives on a card

A reranker or embedder sidecar is always loaded and answers in milliseconds. As an
ordinary backend it would take the card for every request and evict the big model
on it; on a `shared` resource nobody would ever ask it to move, and a big load would
land on top of it. Mark it resident:

```yaml
backends:
  image: { url: "...", resources: [gpu1] }
  memory:
    url: "http://127.0.0.1:8082"
    kind: none
    resources: [gpu1]
    resident: true          # or {yield: /yield, resume: /resume}
```

Its own requests never wait for the card or evict anything. Before any other
backend's turn on that card, hearth POSTs `yield` with `{"seconds": 3600}` (a
lease, so a hearth that dies mid-turn is not a sidecar gone forever), then `resume`
once the card has been free for 30 seconds, so a burst of turns yields once. Both
are best-effort: a resident that does not answer never holds up a turn. It is drawn
on the card like any other backend.

**A sidecar inside the same llama-swap.** llama-swap can keep one small model loaded in
a `persistent` group while the big seats swap beside it. That is one URL reporting two
loaded models, so name it twice: the sidecar declares what it `serves`, and the swapping
backend stops seeing those ids. Its resident model, its catalogue and any `follow` id are
then about the seat, never the sidecar.

```yaml
backends:
  - { name: card, url: "http://127.0.0.1:8080", kind: llama-swap, resources: [gpu1] }
  - name: rerank
    url: "http://127.0.0.1:8080"      # the same llama-swap
    kind: llama-swap
    serves: [reranker]
    resources: [gpu1]
    resident: { yield: false }      # llama-swap has no yield path, so it is never asked
```

### Backends that don't speak the OpenAI API

An A1111 `/sdapi/v1/txt2img`, a whisper server's `/asr`, a TTS or rerank or
upscale sidecar, your own FastAPI in front of diffusers. These fit hearth
exactly — request-scoped, GPU-bound, one job at a time — and are excluded only
because their URL isn't `/v1/*`. The catch-all passthrough forwards them but
deliberately doesn't queue: scheduling work it can't identify is guesswork.

Naming the path is what identifies it:

```yaml
backends:
  llm: { url: "http://127.0.0.1:11434", resources: [gpu0] }
  sd:
    url: "http://127.0.0.1:7860"
    resources: [gpu0]
    routes:
      - /sdapi/v1/txt2img
      - { path: /sdapi/v1/progress, queue: false }
```

That is the one-GPU case: an LLM server and an image server on the same card,
which today both load and thrash it. Now they take turns.

`queue: false` is for the status endpoint every one of these has. It's what a
client polls *during* the render it's asking about, so queueing it behind that
render would give you a progress bar that updates once the work is finished.

A route defaults to the lowest-priority lane you've configured (`batch` in the
stock config) and reports under the backend's name. Both are overridable per
route with `lane:` and `model:`. A declared path is forwarded byte for byte like
everything else on that route, apart from the one `as:` rename described below.

A queued route can name somewhere else to run when its backend cannot answer:

```yaml
    routes:
      - { path: /v1/rerank, model: reranker, fallback: { backend: cpu, model: reranker-cpu } }
```

Unreachable, or a 5xx before any byte, and the same request is queued on `cpu` with its
`model` renamed to the id that backend serves. A 4xx is the caller's answer and is relayed.
A request that names an id only the fallback serves goes straight there.

**Synchronous endpoints only.** ComfyUI's `POST /prompt` → poll `/history/{id}`
does not fit: holding a slot across two unrelated requests leaks it the moment
a client stops polling. That needs its own mechanism and doesn't have one yet.

**Check what already queues that path.** hearth becoming a second gate in front
of an existing one is safe when they nest — an app slot taken before hearth's
resource, never the reverse — and it buys you the callers the app's own queue
cannot see. It is not safe when the two disagree about placement, and it always
costs the outer slot being held while the inner one waits. Decide which queue
owns the card and make the other one a backstop.

### One backend, models with different ceilings

llama.cpp decodes one request at a time, so one GPU means one job and the queue
is doing its job by serializing everything. vLLM does not: it answers a batch of
sequences in roughly the time it answers one. Queued one behind the other, all
of that is thrown away.

llama-swap will happily run a vLLM entry — it execs whatever `cmd` says and
proxies `${PORT}` — so one backend fronts both kinds of model at once. The
ceiling therefore belongs to the model, not the port:

```yaml
backends:
  seat:
    concurrency: 4       # what a model gets unless it says otherwise
models:
  vllm-qwen:   { concurrency: 32 }   # vLLM's --max-num-seqs, or lower to cap latency
  granite-8b:  { concurrency: 2 }    # llama.cpp --parallel 2: VRAM says two
  granite-3b:  { concurrency: 4 }    # the same seat, twice the slots
```

**The model's number wins in both directions.** A seat that swaps between
llama.cpp entries started with different `--parallel` has no single honest
backend number: dispatch 4 to a server with 2 slots and the extra two queue
*inside* llama.cpp, where this scheduler cannot see them and goes on counting
them as running — a 2x over-commit, told to every peer as free capacity, exactly
when the seat is busiest. Set the backend's `concurrency` to whatever most of
its models do and let the odd ones out declare their own.

**Extra jobs above the backend's number only ever go to the model already
running.** A second model does not join the batch: admitting it would evict the
weights the running jobs are using, and that swap is the thrash the queue exists
to prevent. So a swap stays exactly as serialized as it was, and batching is
free only where it is actually free. A batched model does not jump the queue either — if something still
outranks it after the warm bonus, that something goes next.

**On `kind: ollama` a model's number counts that model's own jobs.** Ollama
keeps a set of models resident and serves them side by side — with
`OLLAMA_MAX_LOADED_MODELS=2` and `OLLAMA_NUM_PARALLEL=1`, two streams in total
and one per model:

```yaml
backends:
  ollama:
    kind: ollama
    concurrency: 2       # two models resident, so two streams
models:
  nomic-embed: { backend: ollama, concurrency: 1 }   # one request per model
  gemma-embed: { backend: ollama, concurrency: 1 }
```

Both embedders run together, a second call to the *same* one waits here — as a
`waitedMs` you can see, rather than inside ollama as a slow call — and it does
not hold the other model up while it waits. Everywhere else the number is read
against the whole backend, because a seat that loads one model at a time has
nothing else running when that model is.

Do **not** reach for a second `backends:` entry pointing at the same llama-swap
with a higher concurrency. Nothing schedules across backends, so the two queues
would dispatch to one GPU simultaneously and thrash it.

**A model whose requests share one context pool can say how big it is.** vLLM
keeps a single KV cache for every running sequence, and llama.cpp does the same
with `--kv-unified`. Slots alone do not protect it: two long agent turns fit the
slot count and still overflow the pool, and vLLM answers by preempting them in
turn until both crawl. `pool:` holds a request back while the ones already
running would leave it too little room:

```yaml
models:
  vllm-qwen:
    concurrency: 4
    pool: { tokens: 150000, output: 8192 }   # vLLM's KV size, less a margin
  granite-8b:
    concurrency: 2
    pool: 65536                              # llama.cpp -c with --kv-unified
```

Each request counts as its estimated prompt plus its `max_tokens`, the same
estimate the context-window check uses. `output` counts `max_tokens` at no more
than that: vLLM preempts rather than fails when requests outgrow their estimate,
so reserving an agent's full 32k cap for every turn would only serialize them.
Leave it off for llama.cpp, where an overflowing unified cache fails requests.
A request alone always runs; whether it fits the window at all is the context
check's call.

Worth knowing before you wire this up: vLLM usually takes a minute or more to
come up under llama-swap, against seconds for a GGUF. Batching has to be winning
you something for that to pay.

### Advertising a nicer id than the backend uses

Backends name models for their own convenience, and that naming leaks into your
API. `as:` renames one on the way out:

```yaml
models:
  nomic-embed:
    backend: ollama
    as: nomic-embed-text-v2-moe:latest   # advertise the left, send the right
```

A request for `nomic-embed` is dispatched to the backend as
`nomic-embed-text-v2-moe:latest`. This is the same rewrite `peers.<name>.models`
already does for a peer, applied to a local backend. The two never meet: `as:`
applies only on the way to a local backend, and a request sent to a peer takes
its id from that peer's own map. So one model can have both, which is what
`fastest` across a local backend and a peer needs.

The rewrite applies to **every** dispatch path, which is the part that matters:
chat completions go through the router, while `/v1/embeddings` and the other
passthrough routes do not, and a path you have named in `routes:` is queued but
still forwarded. An alias honoured on only some of them would appear to work
until you used another endpoint. It is the single deliberate exception to the
passthrough's otherwise byte-for-byte forwarding.

`as:` and `routes:` therefore compose, in both directions. A queued path reaches
the backend under the backend's id, and a `{model}` route matches on the id you
advertise — which for an aliased model is the only id a client has, since the
raw one is hidden from `/v1/models` precisely because it exists to be renamed.

`/v1/models`, the status page, and warm state all report the advertised id. Warm
state is not cosmetic here: it feeds the scheduler's warm bonus, so an untranslated
alias would read as permanently cold and quietly lose its scheduling priority.

Without `as:` the workaround is to duplicate the tag in the backend
(`ollama cp long-name nice-name`), which leaves both names in its catalog and
only works for Ollama.

### One resident model, several ids, different defaults

`params:` is the other half of `as:`. Where `as:` renames a model on the way to
the backend, `params:` stamps request fields on the body — so several advertised
ids can front **one** resident backend model and differ only in the defaults
they carry:

```yaml
models:
  my-model:                         # the seat itself, still usable as-is
    backend: swap
  my-model-low:
    backend: swap
    as: my-model                    # same model on the wire, no second process
    params: { reasoning_effort: low }
  my-model-off:
    backend: swap
    as: my-model
    params: { reasoning_effort: none }
```

A request for `my-model-low` reaches the backend as `my-model`
with `reasoning_effort: low` on it. This is for the client that only has a model
picker: a llama-swap alias carries no parameters, a second llama-swap entry is a
second process (and on a one-GPU box, a seat swap), and a chat template cannot
see the model id. hearth already parses every chat body and already rewrites
the id, so stamping fields here costs nothing on the common path — a route
without `as:` or `params:` forwards the caller's object untouched.

The rules:

- **The route's values win.** The id *is* the user's choice. A client that sends
  `reasoning_effort: high` on every request (some do) must not be able to undo
  the `-low` id it just picked.
- `model`, `messages`, `stream` and `lane` are refused at startup: `model` is
  what `as:` is for, `lane` has its own key (below), and the others belong to
  the request, not the route.
- `lane:` on the route pins the id's queue position the same way, over any
  `lane` the client sent. A voice assistant that can only pick a model id
  gets `lane: batch` and never queues ahead of a person's chat turn:

  ```yaml
  voice:
    backend: swap
    as: my-model
    lane: batch
    params: { reasoning_effort: none }
  ```
- Chat completions only. The passthrough (`/v1/embeddings` and the rest) still
  forwards byte for byte apart from the `as:` rename.
- They travel with the job. A request that spills over to a peer carries its
  params, addressed by the peer's id — the id meant the same thing wherever it
  lands, and a `-low` turn must not come back at full effort because the local
  queue happened to be busy. A peer that is another hearth applies its own route
  on top, same rule one level out: the config nearest the backend wins.
- `/v1/models` advertises **every** id that fronts a seat, and the seat's own id
  too when it is a route of its own. (A raw id that exists only to be renamed
  stays hidden, as before.) Warm state follows the same rule, so none of the
  ids reads as cold while the seat is resident.
- Every model hearth advertises carries its actual context window (`context_length`
  in the `/v1/models` response), learned from the backend's live model settings
  (`n_ctx` on llama.cpp servers, `max_model_len` on vLLM, `num_ctx` or the
  model's `context_length` on ollama). A cold llama-swap model is never probed (its `/props` endpoint loads
  the model to answer), so an unloaded model correctly omits `context_length`
  (not `null`) until it is loaded. Clients can size their own limits from this
  instead of a hand-maintained config value.
- Several ids on one seat are **one seat** to the scheduler: they share the
  warm bonus, they batch together where the model batches, and `concurrency:`
  on the seat covers every id that fronts it. Slots belong to the weights, not
  to the name you reached them by.

### Knowing what is warm

Only llama-swap has `/api/events`, so `kind` says how each backend should be
asked what it has loaded:

| kind | how | notes |
|---|---|---|
| `llama-swap` | `/api/events` over SSE, falling back to `/running` | the default |
| `ollama` | poll `/api/ps` | reports a **set**: several models resident at once under `keep_alive`, all servable together |
| `single` | one always-resident model, so whatever it lists is warm | a bare `llama-server` pinned to one file |
| `none` | it cannot tell us | warmth is reported as **unknown**, not cold |

That last row is the point of having the type at all. "Nothing is warm" and "we
cannot see" are different claims, and only one of them is ours to make. A
backend with `kind: none` has its models rendered as *warmth unknown* rather
than sitting in the cold bucket implying a load tax that may not be real.

`kind: ollama` also changes what the warm bonus means. llama-swap evicts, so
there is one resident model and switching costs a load. Ollama keeps a set
resident and serves them concurrently, so every member of that set is warm and
there is no thrash to avoid. The status page drops its thrash warning entirely
when nothing in the node evicts.

If a backend names its models badly, name them yourself:

```yaml
backends:
  chat: { url: "http://127.0.0.1:8080" }
  guard: { url: "http://127.0.0.1:8081", serves: [guard], kind: none }
```

A bare `llama-server` reports the gguf path it was launched with, so discovery
would put `/root/models/Llama-Guard-3-1B-Q8_0.gguf` in your catalogue and hand
your filesystem layout to anyone who reads `/v1/models`. `serves` replaces
discovery for that backend and doubles as an allowlist: those ids route there,
nothing else does, and only those ids appear in the catalogue. Most such servers
ignore the model field and serve whatever they loaded, so the name is yours to
pick.

A model is resolved by, in order: whatever `models.<id>.backend` pins it to, then
any backend that declares it in `serves`, then whichever backend's catalogue
lists it, then the first backend in the list. That
last step keeps an unknown id behaving exactly as it did with one backend, which
matters because llama-swap will happily load an id that is missing from a stale
catalogue. If two backends offer the same id and you have not pinned it, the
first wins and says so once in the log.

`/v1/models` returns the union, so a client sees everything the node can serve.
The passthrough picks a backend too, from `/upstream/<model>/…` in the path or
`model` in the body, falling back to the first.

A bare `backend:` is exactly a list of one, so nothing changes if you never want
this. Setting both is an error rather than a silent preference.

## Warming a model on purpose

`POST /v1/warm {"model": "chat-large"}` asks a backend to make a model resident
without generating anything. It probes that model's own upstream, which is what
starts its server — cheaper and more honest than a one-token completion.

```bash
curl -X POST localhost:4141/v1/warm -H 'content-type: application/json' \
     -d '{"model":"chat-large"}'
```

**It goes through the scheduler, in its own `warm` lane.** On a llama-swap
backend a warm is an *eviction* of whatever is loaded, so a warm that jumped the
queue would be a button that takes the GPU from a turn already in flight. As a
job it cannot preempt, it waits its turn, and it holds a slot while loading so
nothing dispatches into a half-loaded backend. It also does not earn the warm
bonus — its model is cold by definition — so it sorts behind work for whatever
is already resident. The `warm` lane is added even when you declare `lanes:`
yourself; give it your own priority if you disagree with it yielding to
everything.

The status page turns each cold model into a **load** button — labelled load,
not warm, because on a swapping backend that is what it does: making this model
resident evicts the one that is resident now. It appears only on the main
listener; the ui-only listener serves the page and nothing else, so the page is
told whether the action exists rather than offering a control that always fails.

**Nothing reserves warmth.** The next request for a different model evicts it
again. The response says so rather than implying a guarantee it cannot make,
and reports `waitedMs` and `ranMs` so you can see the queue wait separately from
the load.

A backend that keeps its models resident (`kind: single`) answers
`warmed: false` with a note, because claiming otherwise would report work that
never happened. So does a model that was already loaded.

### Warming across the federation

A model that routes to a peer is warmed on that peer, using their id, and no
local slot is taken — it warms their hardware, not yours. A peer running an
older hearth answers 404/501, which is reported as "peer X does not support
warming" rather than surfacing a bare status from a machine you do not own.
`/peer/hello` advertises `capabilities: ["warm"]` so support is discoverable
without probing for it.

**A peer may ask; it may not make you wait.** The asymmetry is deliberate:

- A **local** warm queues happily. It is your box, and the queue is exactly what
  stops it stealing a slot from work in flight.
- A **peer's** warm is taken only when a slot is free, and declined with
  `503 {declined: true}` otherwise. Queueing it would mean a peer holding a
  connection open across your queue for speculative work, and evicting *your*
  resident model at a moment you did not choose. A peer that must obey is a peer
  who can thrash your GPU from across the tailnet.

It is also gated by `lending.models` — the same opt-in as chat, so a warm cannot
reach a model you did not lend — and counts against `lending.rateLimit`. A peer's warm is
never routed onward: two nodes that each preferred the other would otherwise
bounce one between them.

## Sharing capacity

Both ends run hearth. Yours:

```yaml
peers:
  friend:
    url: http://100.x.y.z:4141
    token: env:HEARTH_TOKEN_FRIEND   # you present this to them
    models:
      # my id: their id. Also the allowlist: a model that isn't mapped can
      # never be sent to them, whatever the policy below says.
      big-model: their-big-model

models:
  big-model:
    policy: peer          # local | peer | spillover | fastest
    peers: [friend]
    fallbackLocal: true
```

Theirs, to accept it:

```yaml
peers:
  you:
    accept: env:HEARTH_PEER_YOU   # what you present, checked here

lending:
  models: [their-big-model]   # empty by default, since lending is opt-in per model

models:
  their-big-model:
    note: "Agent/coding work. 128k context; send reasoning_effort for harder tasks."
```

One entry per friend holds both directions: add `accept` to yours and `url` with
a `token` to theirs, and each of you can borrow from the other.

Both blocks can also be edited from `/ui` or `curl` while it runs, which is
usually how they get written in the first place. Each change is live at once and
written into the config:

```bash
# hold one model back without pausing the rest
curl -X POST localhost:4141/control -H 'content-type: application/json' \
  -d '{"share": {"big-model": false}}'

# map one of their ids to one of yours, and route it there
curl -X POST localhost:4141/control -H 'content-type: application/json' \
  -d '{"link": {"peer": "friend", "mine": "coder", "theirs": "qwen3-coder-30b"}}'

# and take it back
curl -X POST localhost:4141/control -H 'content-type: application/json' \
  -d '{"unlink": {"peer": "friend", "mine": "coder"}}'
```

`GET /control` reports the current state and where edits are saved. Adding a
**peer** is an edit to `peers:` and applies on restart: a token and a URL are a
trust decision, and the map is only what you do with one you already have.

Peers exchange capacity **per model** rather than per node, because a node with
several backends can be flat out on its GPU and completely idle on the queue that
would actually serve you. That is protocol 2. Nodes still send the old node-level
numbers alongside it, so a v1 peer keeps working and simply gets scored the
older, coarser way. No flag day.

Policies:

| policy      | behaviour |
|-------------|-----------|
| `local`     | never leaves. The default for anything you don't list. |
| `peer`      | prefer a peer, fall back home. |
| `spillover` | local until `spilloverAt` jobs are queued, then a peer. |
| `fastest`   | compare queue pressure. Ties stay home. |

### Knowing what a borrowed model can take

A model on your own box is one you chose and can go and look up. A model someone
lends you is a name and nothing else, and the first thing you find out the hard
way is its context window — usually as a 400 from a stranger's llama.cpp,
halfway through an agent loop, after the prompt has already crossed the network.

So peers exchange a few facts about each shared model, alongside the capacity
numbers and on the same poll:

| stat | from | what it changes |
|---|---|---|
| `context` | the window the process was launched with (`-c`) | an oversized request never goes there |
| `vision` | whether it accepts images | an image request never goes there |
| `tools` | whether its chat template can express tool calls | a request carrying `tools` never goes there |
| `thinking` | whether it reasons before it answers | nothing — see below |
| `effort` | whether its chat template takes a `reasoning_effort` | nothing — see below |
| `quant` | e.g. `Q5_K - Medium` | nothing — it is the only quality signal you get about hardware you do not own |

vLLM has no `/props`; its context window is read from `max_model_len` on its own
`/v1/models`, and the rest stays unknown unless declared.

All six come from one `/props` call that already happens the first time a model
is loaded, so this costs no extra traffic. They appear on `/ui` under **takes**,
and the window has been on `/v1/models` as `context_length` all along.

Whether a model takes images is there too, as `input_modalities` (`["text", "image"]` or
`["text"]`), so a client can read what it may send instead of having it set by hand. It
comes from the same record: the running process's `/props` where it has one, a declared
`stats.vision` otherwise. A model nobody has spoken for carries no field, which means
unknown, not text only.

Two rules make it safe to act on:

**A request is measured before it is routed.** Prompt, tool schemas and reserved
output (`max_tokens` comes out of the same window), with images charged flat
rather than by the size of their base64. A peer whose model cannot take *this*
request is not a candidate for it, so the work comes home to a backend with a
bigger window instead of crossing the network to be refused. If nothing can take
it, you get a `400` naming both numbers before anything is queued or evicted —
and a borrower who asks anyway gets the same `400` from the lender, rather than a
swap and a wasted load.

When only the reserved output overflows, the local model shrinks `max_tokens` to
the room the prompt leaves instead of refusing: an agent that always asks for 32k
gets a shorter cap, not a dead turn. A prompt that leaves under 1024 tokens is
still refused, so the client can compact.

`thinking` and `effort` are two facts, and one word used to cover both. A model
can reason on every turn with no dial to turn, so "it thinks" and "you can tell
it how hard" get a chip each. `thinking` is read from any one sign: an effort
dial, a template that carries reasoning through the history, or a template that
handles a think block itself (`<think>`, `enable_thinking`, `reasoning_content`).
No sign is no claim — nothing a server reports can prove a model does *not*
think — so only an operator can declare `thinking: false`.

Both are reported and never enforced, and the difference is the point. A
`reasoning_effort` a template cannot express is dropped by the backend and the
request still answers — refusing it would break work that would have succeeded
in order to protect nobody. The cost is a shallower answer than you asked for,
which is a thing to *see* before you send the request, not a thing to fail
afterwards. Note that this says the lever exists, never where it is set:
llama.cpp does not report its launch-time reasoning budget, so neither do we.

**Silence is never a limit.** Every one of these is optional in both directions.
A model that has never been loaded, a backend that does not answer `/props`, a
peer speaking protocol 1 — all report nothing, and nothing refuses nothing. The
backend remains the authority on its own limits; this only moves the clear
refusals to the near side of the network, where the message can name numbers and
the request can still be sent somewhere else.

### When nothing can be asked

Stats are learned from the running process, which is authoritative and needs no
config at all. Two cases can't be reached that way:

- **A model that has never been loaded.** Asking llama-swap for a cold model's
  props *loads it* to answer, which is the eviction and the sixty-second load
  this whole check exists to avoid. So hearth never asks — and an unknown model
  refuses nothing, which means the first oversized request evicts whatever is
  resident, waits out the load, and only then fails.
- **A backend that isn't OpenAI-shaped** (`kind: none`). It has no `/props` and
  never will. A declaration is reported for these and never enforced: their
  requests arrive on a declared path carrying a body hearth does not read, so
  there is nothing to measure it against. You get the number on the page, which
  is otherwise the one model whose window nothing could ever tell you.

Say it yourself for those:

```yaml
models:
  big:   { stats: { context: 32768 } }
  video: { stats: { context: 8192, vision: true } }
```

`context`, `vision`, `tools`, `thinking`, `effort`, `quant` — all optional, and a typo is
a startup error rather than a field that quietly does nothing. A declaration is
a *prediction of how the process will be launched*, so the moment the real thing
loads, its own answer wins, field by field. The console draws a declared value
dimmer and says in the tooltip that nothing has confirmed it, because "the
operator says 32k" and "the process reports 32k" are different claims.

The estimate is `chars / 3.5`, not a real tokenizer: tokenizing properly means
shipping a vocab per model or asking the backend, which loads it. It reads about
a tenth low on dense text, which is the safe direction — this code only ever
refuses, so reading low errs toward letting a borderline request through to the
thing that can actually count.

## Running it on a server

From the registry, `npm i -g @vcvzgbzz/hearth` on the box is the whole install.

Deploying a build of your own checkout has one gotcha, and it will bite you the
first time. `npm ci --omit=dev` **fails** in a checkout of this repo:

```
npm error command sh -c tsc
```

`prepare` is a `tsc` run, npm runs `prepare` after any local install, and
`--omit=dev` has just skipped installing typescript. That `prepare` is not
removable: it is the thing that makes `npm i -g github:Vcvzgbzz/hearth` work at
all, by building from source at install time. (Installing from the registry
never runs it, so this only shows up on a server.)

So on a box, skip the scripts and ship a build you made elsewhere:

```bash
npm ci --omit=dev --ignore-scripts
```

The package is `dist/`, `package.json` and `package-lock.json`, plus a
`node_modules` with one runtime dependency in it. Nothing else needs to be on
the machine. Build on your workstation, copy those three, install with the flags
above, restart.

Be careful with `rsync -a --delete` here. A trailing slash on `dist/` copies the
*contents*, so everything lands in the parent and `--delete` then removes the
real `dist/` and `node_modules` on its way past. The service keeps running,
because the process still holds the deleted files open, and dies at the next
restart with no clue why. Stage into a new directory and `mv` it into place
instead.

A unit that fails a bad config at deploy time rather than at 3am:

```ini
[Service]
WorkingDirectory=/opt/hearth
EnvironmentFile=/etc/hearth.env
ReadWritePaths=/etc/hearth.yaml
ExecStartPre=/usr/bin/node /opt/hearth/dist/cli.js serve --config /etc/hearth.yaml --check
ExecStart=/usr/bin/node /opt/hearth/dist/cli.js serve --config /etc/hearth.yaml
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
```

`ReadWritePaths=` is what lets console edits write your config.
`ProtectSystem=strict` leaves nothing outside `WorkingDirectory` writable, so
without it every edit is refused with a message saying the file is not writable.
Leave it out if you would rather the config were only ever edited by hand.

`--check` validates and exits, so a typo in a peer's model map stops the deploy
with a readable line. Put the peer tokens in `/etc/hearth.env` and reference
them from the config as `env:NAME`, which is also what keeps the config
committable. Note that `--check` will fail outside systemd unless you source
that env file first, since a missing token is deliberately fatal.

`Restart=on-failure` is also what brings the node back after the console's
**restart** button, which exits with status `75` for exactly that.

`TimeoutStopSec` is there because a stop is not instant any more. On SIGTERM
hearth stops accepting connections, drops the idle ones, and gives whatever is
already in flight up to `shutdownGraceMs` to finish — a chat turn mid-stream, a
render several GPU-minutes in. Anything still running when that runs out is
destroyed, and the drain says so in the log:

```
{"level":"info","msg":"drain.start","inFlight":3,"graceMs":30000}
{"level":"warn","msg":"drain.cut","abandoned":1,"ms":30001}
```

Keep the unit's stop timeout comfortably above the grace, or systemd SIGKILLs
mid-drain and the wait bought nothing. A second SIGTERM (or a second ^C) skips
the rest of the wait and exits, for when you would rather not sit through it.

A request still QUEUED is in flight too — its caller is holding the connection,
so it gets its turn if the grace allows. The queue itself is memory only and
nothing is written down, so whatever the grace does not cover is simply gone.
Pair `Restart=on-failure` with `StartLimitBurst` in `[Unit]` so a crash loop
cannot quietly eat a job every five seconds.

## What it won't do

Better to know this before you deploy it than after.

- The queue lives in memory. SIGTERM drains in-flight requests, queued ones
  included, for up to `shutdownGraceMs` (30 s by default); whatever the grace
  does not cover is lost. Whatever supervises the process is responsible for not
  restarting it constantly.
- Retries only happen before the first byte. If a peer dies mid-stream the
  request fails, because the client already has half an answer and replaying
  would corrupt it. Before any bytes reach the client, failover is invisible.
- Estimates are crude. `fastest` compares queue depth, not predicted duration.
  Depth is a real signal, but a duration model is a research project.
- No scheduling across backends. A node can front several local backends, but
  nothing moves a job between them or balances across them. A model belongs to
  one backend and queues there.
- No end-user auth. `apiKeys` is a coarse gate. Per-account fairness belongs in
  the application, which is the thing that knows who the accounts are.
- Only chat completions and the paths a backend declares under `routes` are
  queued. `/v1/embeddings`, `/v1/completions` and everything else pass through
  unscheduled unless you name them there. See [Backends that don't speak the
  OpenAI API](#backends-that-dont-speak-the-openai-api).

## Security

The defaults assume a private network: Tailscale, WireGuard, a LAN you trust.

- Binds to `127.0.0.1`. Widening it is deliberate, and you get a warning at
  startup if you widen it without setting `apiKeys`.
- With no `apiKeys`, loopback is the only thing trusted. A request from anywhere
  else, or one carrying a credential that isn't valid here, gets refused rather
  than waved through as "local".
- Lending is opt-in per model, and peers are rate-limited by request count.
- Peer tokens are separate from api keys, so peer traffic is attributable.

### Writes refuse a cross-origin browser

Loopback is this node's whole notion of local trust, and a browser tab is on
loopback. So any page you happen to be visiting could POST here — no preflight
needed, and the attacker not being able to read the reply does not matter when
the damage is the request. Running hearth on the machine you browse with, or
tunnelling its port to it, puts hearth on that browser's loopback.

So any write carrying an `Origin` that is not this node's is refused. curl, the
peer protocol and a server-side app all send no `Origin` and are unaffected, and
there is no legitimate browser client on another origin to break: without CORS
headers it could never read a reply anyway.

### Do not put a proxy in front of it

This one is worth more than the rest of the section put together, because the
obvious way to expose hearth over Tailscale silently defeats its main gate.

hearth decides whether a caller is trusted from the socket's source address. Put
anything in front that rewrites it — `tailscale serve`, userspace-mode
`tailscaled`, nginx, a container port-forward — and **every request arrives
looking like `127.0.0.1`**. With no `apiKeys` set, loopback is trusted without a
token, so an anonymous stranger is promoted to a trusted local caller.

Measured against a real node in that configuration, with one model shared:

| request | result |
|---|---|
| valid peer token, shared model | 200 |
| valid peer token, **unshared** model | 403 |
| wrong token | 401 |
| **no token at all** | **200, any model in the catalogue** |
| **no token, `/ui/data`** | **200** |

A peer holding a valid token is still gated correctly — the token is checked
before the address, so `lending.models` holds. The hole is the unauthenticated case: it
needs no credential, and it reaches `/v1`, `/queue`, `/network`, the passthrough
and the status page.

If you front hearth with Tailscale, use **kernel mode with userspace networking
disabled, and `serve` off**, so the real peer address survives. If you need a
proxy anyway, set `apiKeys` — that removes loopback's free pass, since a key is
then required from everyone.

There's no TLS here and no defence against a determined attacker. Don't put this
on the public internet. If you must, terminate TLS in front of it, set `apiKeys`,
and lower `lending.rateLimit`.

Prompts sent to a peer leave your machine and land in their logs. The startup
line names every model that can leave and every model you accept, so that fact
sits in your journal instead of being buried in a config file.

## Notes for the curious

Two decisions did most of the work here, and I got both of them wrong first.

**Don't use `fetch`.** Node's undici caps time-to-first-header at 300 seconds,
and an inference server sends nothing until it starts generating. A cold load
past five minutes dies as `TypeError: fetch failed` while your own timeout, the
one you meant, never fires. [`src/upstream.ts`](src/upstream.ts) uses
`node:http`, where the caller's signal is the only deadline.

**Ask peers, and ask when it matters.** Never infer health from an open socket.
A TCP forwarder keeps listening after the far end dies and just closes each
connection, which looks perfectly healthy to anything that only checks whether
it can connect. hearth asks for capacity and requires an answer.

It asks on demand rather than on a timer, because routing is the only thing that
consumes peer state, and something needed when asked should be fetched when
asked. A timer spends requests whether or not anyone is using the thing, and
still hands the decision a reading a whole interval old. Three guards keep that
from costing more than it saves: a good reading is reused for `borrowing.freshMs`,
concurrent requests coalesce onto one probe, and a failure is remembered for
`borrowing.downMs` so a broken peer can't make your local requests slower. An idle
node makes no peer traffic at all.

Unknown always means local. A probe that doesn't answer in time is unknown.

## Development

```bash
npm run typecheck                  # server, tests and the console
npm test                           # assert-based, each file runs standalone
npx tsx test/<name>.test.ts        # one file; `npm run build:console` first for page tests
npm run build
```

Contributing with an AI agent? [`AGENTS.md`](AGENTS.md) has the rules for
commits, comments and pull requests here.

Embedding it instead of running the CLI:

```ts
import { loadConfig, createNode, createLogger } from "@vcvzgbzz/hearth";

const cfg = loadConfig("hearth.yaml");
const node = createNode(cfg, createLogger("info"));
node.start();                       // watch the backend, poll peers
node.server.listen(cfg.listen.port, cfg.listen.host);
// later: await node.close();
```

`start()` isn't optional. Skip it and the node still answers requests, but it
never learns what's loaded and never marks a peer up, so it routes everything
locally. Which looks exactly like working.

[`test/server.test.ts`](test/server.test.ts) stands up several nodes and fake
backends in one process and asserts the claims a user would actually make: it
ran on their GPU, it streamed back, it didn't queue behind my own work, the
failover was invisible and still went through the queue, and they can't reach or
even enumerate a model I didn't offer.

[`test/backpressure.test.ts`](test/backpressure.test.ts) covers one specific
way this used to fall over: a client that hangs up while the response is
backpressured. That leaked a scheduler slot, and at `concurrency: 1` it wedged
the whole node until restart without logging a thing.

[`test/ui.test.ts`](test/ui.test.ts) binds a node to every interface and knocks
on `/ui/data` from this machine's own LAN address, with a valid api key, to prove
the gate holds anyway. It skips itself on a host with no routable
interface rather than pretending to have checked.

The page lives in [`src/console/`](src/console/) as ordinary `.tsx`.
[`src/ui.ts`](src/ui.ts) is only the HTML shell, and it reads
`dist/console.js` and `dist/console.css` in at import time. So `npm test`
builds the browser half first (`pretest`), and `npm run typecheck` checks it
against [`tsconfig.ui.json`](tsconfig.ui.json), which is also the tsconfig
esbuild is pointed at: the JSX setting has to be one fact, or the bundle
compiles against a runtime that is not there and the page renders blank.

MIT.
