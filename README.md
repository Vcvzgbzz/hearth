# hearth

A queue in front of your local inference server, and optionally a way to lend
the spare capacity to someone you trust.

One GPU fits one model at a time. The moment two things want different models
from it they thrash, each evicting the other's weights and paying the load tax
over again. hearth is the admission point that stops that. It speaks the OpenAI
API, so nothing you already use has to change.

```bash
npm i -g github:Vcvzgbzz/hearth   # not on npm yet
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
  concurrency: 1
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

Peers don't get to choose. Borrowed work is pinned to `peerLane`, which defaults
to your lowest-priority lane. Lanes express the host's priorities, and a guest
doesn't get a vote in them.

## Configuration

Every key with its default. Only `backend.url` is required.

| key | default | what it does |
|---|---|---|
| `name` | hostname | how this node identifies itself to peers |
| `listen.host` / `.port` | `127.0.0.1` / `4141` | widening the host is deliberate, see Security |
| `backend.url` | — | the OpenAI-compatible server you front. Shorthand for a `backends:` list of one |
| `backend.llamaSwapExtras` | `true` | old spelling of `kind`: `true` is `llama-swap`, `false` is `none` |
| `backends` | — | several local backends, each with its own queue. See below |
| `backends[].serves` | discover | model ids this backend serves. Declaring replaces discovery and acts as an allowlist |
| `backends[].kind` | `llama-swap` | where warm state comes from: `llama-swap`, `ollama`, `single`, `none` |
| `scheduler.concurrency` | `1` | default jobs-at-once per backend; a backend can override it |
| `scheduler.lanes` | `chat`, `batch` | named lanes and their base priority |
| `scheduler.agePerSecond` | `1` | priority earned per second waited, which is also the starvation bound |
| `scheduler.warmBonus` | `40` | priority discount for a model already loaded |
| `scheduler.maxPerLane` | `100` | how long one lane's queue may get before new work is refused. Off-box jobs are bounded separately, on their own count |
| `scheduler.maxPerCaller` | `0`, or `2` with apiKeys | queued-or-running jobs per caller per lane. Off without apiKeys, where every local caller is one identity |
| `apiKeys` | `[]` | keys allowed on `/v1/*`. Empty means loopback only. Setting it means loopback needs a key too, including any local tool you point at this |
| `uiListen` | unset | give the status page its own `{host, port}`. Unset keeps it on the main port, loopback-only |
| `maxBodyBytes` | `33554432` | largest accepted request body |
| `share` | `[]` | models you'll run for a peer. Empty lends nothing |
| `peerTokens` | `{}` | `name: token` a peer presents to you |
| `peerLane` | lowest-priority lane | which lane borrowed work enters |
| `peerMaxConcurrent` | `2` | jobs one peer may have in flight |
| `peerRateLimit` | `600` | peer inference requests per hour. Capacity polling has its own budget |
| `peerFreshMs` | `4000` | how long a good peer reading is reused before a routing decision asks again |
| `peerDownMs` | `30000` | how long a failed probe is remembered, so an outage doesn't make every local request pay the timeout |
| `peerPollMs` / `peerStaleMs` | `60000` / `60000` | background floor that warms the cache. The real mechanism is on-demand |
| `peerFirstByteMs` | `180000` | how long to wait for a peer to start answering before falling back. `0` waits forever |
| `coldPenalty` | `2` | what a model load is worth to `fastest`, in queued-jobs-equivalent |
| `peers` | `[]` | nodes you can send work to |
| `models.<id>.backend` | auto | pin a model to a named backend instead of resolving it from the catalogs |
| `stateFile` | `null` | fallback for Save when the config file itself cannot be written. Null unless you need it |
| `models.<id>.concurrency` | backend's | jobs this model may run at once, above OR below its backend's `concurrency`. `batch` is the older name for it. See below |
| `models` | `{}` | routing policy per model. Anything unlisted stays local |

Tokens accept `env:NAME`, so the config stays committable.

## Endpoints

Beyond `/v1/chat/completions` and `/v1/models`:

| path | who | what |
|---|---|---|
| `/ui` | loopback | the status page: queue history, which model was loaded when, what you are lending, and what each peer offers |
| `/control` | local | read or change what leaves this node: lending, borrowing, per-model sharing, peer model maps |
| `/network` | local | every node, what each one serves, and what's **loaded right now**. Also lists peer models you haven't mapped, which is usually the config mistake people actually make |
| `/queue` | local | jobs in flight, with lane, caller and position |
| `/healthz` | anyone | liveness. The one unauthenticated endpoint |
| `/peer/hello`, `/peer/state` | peers | identity and capacity, per model |

Anything else gets proxied to your backend untouched, so a client already using
`/unload` or llama-swap's `/upstream/<model>/…` keeps working. Those passthrough
paths **are not queued**, see below.

## The status page

`http://127.0.0.1:4141/ui`, once `hearth serve` is running. Plain HTML with no
build step, no framework and no dependency, served from a string.

It shows four things the JSON endpoints make you assemble yourself:

- **Queue depth over the last ten minutes**, which is how you tell whether the
  queue is doing anything or you have added a hop for nothing.
- **Which model was loaded, when.** One lane per model, filled where it was
  resident. A GPU flipping between two models draws a staircase, and the caption
  counts the swaps. That thrash is the thing hearth exists to prevent, and you
  cannot see it in an instantaneous reading.
- **Every model, on one row each**: which nodes hold it, whether it is loaded
  anywhere, and whether you are lending it. `/network` is always one node's
  view, and a model that appears on four of them appeared four times before
  this.
- **What each peer offers**, including the models it offers that you have no
  mapping for — usually the first sign a friend has added something.

### Changing things from the page

Three of those are clickable on the main listener, and every one of them is a
**runtime override that a restart discards**:

- **lending** and **borrowing**, the two directions of federation, as separate
  switches. Pausing lending empties your share list, so peers see a healthy node
  offering nothing and stop choosing you, rather than a wall of 403s that looks
  like a revoked token. Pausing borrowing removes peers as routing candidates,
  so a model with `fallbackLocal: false` refuses cleanly.
- **lent / held per model**, on top of the `share:` list. You can hold back one
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

A **runtime changes** block appears under the node list whenever anything
differs from the file, listing what changed and handing you the YAML to paste.
By default that is the only way to keep a change: nothing is written to disk,
`hearth.yaml` stays the whole story, and a restart is a reset.

### Keeping a change

Press **Save** and the change is written into your config file — the same one
you edited to set the node up, comments and layout intact. One exception, and
it is the honest one: **deleting** a route or a mapping takes its comments with
it, because they belong to the thing being deleted. If a comment there is
reasoning you want to keep, move it before you unlink. The runtime-changes
block then disappears, because there is nothing left to report: the file says
what the node is doing, which is the only arrangement where those two never
drift apart.

Not everything should be saved, and that is what the button is for. Holding a
model back for an hour while a friend rebuilds is not a config change; leave it
unsaved and a restart puts it back. Only what you press Save on becomes
permanent.

Unlinking a peer's last model is fine, and so is a peer that maps nothing —
that is simply the state between deciding to trust someone and deciding what to
borrow. Their url, token and your notes stay where they are, and the console
still lists everything they serve, so borrowing again is a click.

The write refuses rather than damages, in three cases:

- the file has changed on disk since hearth started, so somebody edited it in
  another window and saving would overwrite them
- the result fails validation — checked against the edited document before the
  file is touched, so a bad edit is a message now rather than a node that will
  not come back at the next restart
- the file is not writable

Under `ProtectSystem=strict` that last one is the default, so the unit needs to
say the config is writable — and must not also say the opposite, which is easy
to miss because both lines look like hardening:

```ini
ReadWritePaths=/etc/hearth.yaml
ReadOnlyPaths=/opt/hearth /etc/hearth.env   # NOT the config as well
```

`ReadOnlyPaths` wins for a path named in both, silently. Only the file needs to
be writable, not `/etc` — hearth writes in place when it cannot stage a temp
file beside the config, which is exactly what that pairing produces.

If it genuinely cannot be written — a read-only bind mount in a container is the
usual reason — set `stateFile` and Save falls back to a sidecar of deltas
applied over the config at startup. It is a worse arrangement and it is meant to
be a fallback: two files describing one node, and a page that has to keep
explaining which is which. An entry there says "lend this", "do not lend this"
or "this maps to that", and anything absent is left to the config — storing the
whole picture is how an edit to the YAML silently stops working months later. A
corrupt sidecar logs a warning and starts from the config, because losing a
preference should not be an outage.

The ui-only listener serves the page **without** these controls unless you set
`uiListen.control: key`. It still states every fact, including the ones you
cannot change there, and says where the control does live — a status page whose
job is to state the state has to do that even when the state is boring.

The history is a fixed ring of 120 samples taken every 5s, held in memory. It
dies with the process, exactly like the queue does. Keeping it across restarts
would mean choosing a storage engine, which is a much larger decision than
"draw me a line".

**The page is loopback-only, and `apiKeys` does not open it.** A browser loading
a page cannot present a bearer token, and the alternatives are worse: a key in
the query string ends up in logs and history, and one baked into the HTML is a
live credential in a response body.

The simplest way to see it from elsewhere is a tunnel, which still arrives as
loopback:

```bash
ssh -N -L 4141:127.0.0.1:4141 you@your-box
```

On a headless box or in a container, where there is no browser on loopback to
tunnel to, give the page its own socket instead:

```yaml
uiListen:
  host: 100.64.0.5   # a tailnet address, not a LAN one
  port: 4142
```

That is a second listener which serves `/ui` and `/ui/data` **and answers 404 to
everything else** — no `/v1`, no passthrough to your backend, no peer protocol,
no `/healthz`. Widening it cannot widen anything but the page, which is the
whole reason it is a separate socket rather than a looser check on the main one.

It still takes no credential, because it cannot. Anyone who can reach that port
can read your queue, your caller ids and your model inventory. Put it behind a
tailnet ACL and never on a LAN.

## More than one local backend

A box often runs more than one provider: a swapping chat model on the GPU, plus
something small and always resident on another port, like an embedder, a
classifier, or a CPU-only model. Give hearth a list and it fronts them all on one
port, under one federation identity:

```yaml
backends:
  - { name: gpu,  url: "http://127.0.0.1:8080",  llamaSwapExtras: true, concurrency: 1 }
  - { name: side, url: "http://127.0.0.1:11434", llamaSwapExtras: false, concurrency: 4 }
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
  - { name: swap,       url: "http://127.0.0.1:9292", resources: [gpu0] }
  - { name: swap-image, url: "http://127.0.0.1:9293", resources: [gpu1] }
  - { name: deep,       url: "http://127.0.0.1:9294", resources: [gpu0, gpu1] }
```

`swap` and `swap-image` never wait for each other. `deep` waits for both, and
both wait for `deep`. The names are yours and mean nothing outside this file.

This is still not placement. Routing is untouched: a model resolves to exactly
one backend by the same rules as before, and nothing decides a job would be
better off elsewhere. What it adds is that a backend can *wait* for another —
the one thing "each is its own admission domain" gets wrong when two domains
are one card.

A backend holds its resources while it has any job running, not per job — its
`concurrency` already says how much work it may run at once. Before the first
job goes, hearth unloads any llama-swap backend that overlaps, because winning
the arbitration only means nobody else is *running* there: a neighbour that
finished a minute ago still has weights resident, and on a card sized for one
model that is the same as occupied. Eviction is expensive, so it is logged
(`pool.evict`) and only happens on the idle-to-busy edge.

Omit `resources` and nothing changes, which is every config that predates it.

### Backends that don't speak the OpenAI API

An A1111 `/sdapi/v1/txt2img`, a whisper server's `/asr`, a TTS or rerank or
upscale sidecar, your own FastAPI in front of diffusers. These fit hearth
exactly — request-scoped, GPU-bound, one job at a time — and are excluded only
because their URL isn't `/v1/*`. The catch-all passthrough forwards them but
deliberately doesn't queue: scheduling work it can't identify is guesswork.

Naming the path is what identifies it:

```yaml
backends:
  - { name: llm, url: "http://127.0.0.1:11434", resources: [gpu0] }
  - name: sd
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
route with `lane:` and `model:`. The body is never inspected — a declared path
is forwarded byte for byte like everything else on that route.

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
sequences in roughly the time it answers one. On an Arc Pro B70, Qwen3-0.6B
measured 87 tok/s at one request and 2741 tok/s at 32, with the wall clock for a
200-token completion unchanged at 2.3s. Queued one behind the other, all of that
is thrown away.

llama-swap will happily run a vLLM entry — it execs whatever `cmd` says and
proxies `${PORT}` — so one backend fronts both kinds of model at once. The
ceiling therefore belongs to the model, not the port:

```yaml
backends:
  - name: seat
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

Do **not** reach for a second `backends:` entry pointing at the same llama-swap
with a higher concurrency. Nothing schedules across backends, so the two queues
would dispatch to one GPU simultaneously and thrash it.

Worth knowing before you wire this up: vLLM takes 78-88s to come up under
llama-swap, warm or cold, against 18s for llama-swap to load a 24 GB GGUF and
answer. Batching has to be winning you something for that to pay.

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
`nomic-embed-text-v2-moe:latest`. This is the same rewrite `peers[].models`
already does for a peer, applied to a local backend — so `as:` is refused on a
model with a peer policy, where the peer's own mapping already owns the id.

The rewrite applies to **both** dispatch paths, which is the part that matters:
chat completions go through the router, while `/v1/embeddings` and the other
passthrough routes do not. An alias honoured on only one of them would appear
to work until you used the other endpoint. It is the single deliberate exception
to the passthrough's otherwise byte-for-byte forwarding.

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
  Qwen3.8-Fable-735:                         # the seat itself, still usable as-is
    backend: swap
  Qwen3.8-Fable-735-low:
    backend: swap
    as: Qwen3.8-Fable-735                    # same model on the wire, no second process
    params: { reasoning_effort: low }
  Qwen3.8-Fable-735-off:
    backend: swap
    as: Qwen3.8-Fable-735
    params: { reasoning_effort: none }
```

A request for `Qwen3.8-Fable-735-low` reaches the backend as `Qwen3.8-Fable-735`
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
  what `as:` is for, and the others belong to the request, not the route.
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

`llamaSwapExtras: true` is still accepted and means `kind: llama-swap`; `false`
means `kind: none`. Setting both is an error. Note that `false` no longer polls
`/running`: it used to, which was contradictory, and if you want warm state from
llama-swap you should say `kind: llama-swap`.

If a backend names its models badly, name them yourself:

```yaml
backends:
  - { name: swap,  url: "http://127.0.0.1:8080" }
  - { name: guard, url: "http://127.0.0.1:18081", llamaSwapExtras: false, serves: [guard] }
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

It is also gated by `share` — the same opt-in as chat, so a warm cannot reach a
model you did not lend — and counts against `peerRateLimit`. A peer's warm is
never routed onward: two nodes that each preferred the other would otherwise
bounce one between them.

## Sharing capacity

Both ends run hearth. Yours:

```yaml
peers:
  - name: friend
    url: http://100.x.y.z:4141
    token: env:HEARTH_TOKEN_FRIEND
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
peerTokens:
  you: env:HEARTH_PEER_YOU
share: [their-big-model]   # empty by default, since lending is opt-in per model
```

Both blocks can also be edited from `/ui` or `curl` while it runs, which is
usually how they get written in the first place — try the link, watch a request
land on their box, then paste the YAML the page gives you. Changes are live
immediately and gone on restart:

```bash
# hold one model back without pausing the rest; null hands it back to the config
curl -X POST localhost:4141/control -H 'content-type: application/json' \
  -d '{"share": {"big-model": false}}'

# map one of their ids to one of yours, and route it there
curl -X POST localhost:4141/control -H 'content-type: application/json' \
  -d '{"link": {"peer": "friend", "mine": "coder", "theirs": "qwen3-coder-30b"}}'

# and take it back
curl -X POST localhost:4141/control -H 'content-type: application/json' \
  -d '{"unlink": {"peer": "friend", "mine": "coder"}}'
```

`GET /control` reports the current state, what differs from the file, and that
same paste-ready YAML. New **peers** are still config-only: a token and a URL
are a trust decision, and the map is only what you do with one you already have.

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

## Running it on a server

One gotcha, and it will bite you the first time. `npm ci --omit=dev` **fails**
in a checkout of this repo:

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
```

`ReadWritePaths=` is what lets the console's Save button write your config.
`ProtectSystem=strict` leaves nothing outside `WorkingDirectory` writable, so
without it Save refuses with a message naming this line. Leave it out if you
would rather the config were only ever edited by hand — the page still shows
what changed and still hands you the YAML. (If you use `stateFile` instead, it
wants `StateDirectory=hearth` for the same reason.)

`--check` validates and exits, so a typo in a peer's model map stops the deploy
with a readable line. Put the peer tokens in `/etc/hearth.env` and reference
them from the config as `env:NAME`, which is also what keeps the config
committable. Note that `--check` will fail outside systemd unless you source
that env file first, since a missing token is deliberately fatal.

The queue is in memory, so a restart drops whatever was waiting. Pair
`Restart=on-failure` with `StartLimitBurst` in `[Unit]` so a crash loop cannot
quietly eat a job every five seconds.

## What it won't do

Better to know this before you deploy it than after.

- The queue lives in memory, and a restart cuts running work off with it.
  SIGTERM closes connections rather than draining them, so a generation in
  flight dies along with the queue behind it. Whatever supervises the process is
  responsible for not restarting it constantly.
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
- Only chat completions are queued. `/v1/embeddings`, `/v1/completions` and
  everything else pass through unscheduled. If you embed and generate against
  one GPU, hearth currently serialises half of that. Known gap, not a design
  position.

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
the damage is the request. Tunnelling the page to your laptop, which is the
advice above, puts hearth on the loopback of the machine you browse the web on.

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
| **no token, `/ui`** | **200** |

A peer holding a valid token is still gated correctly — the token is checked
before the address, so `share` holds. The hole is the unauthenticated case: it
needs no credential, and it reaches `/v1`, `/queue`, `/network`, the passthrough
and the status page.

If you front hearth with Tailscale, use **kernel mode with userspace networking
disabled, and `serve` off**, so the real peer address survives. If you need a
proxy anyway, set `apiKeys` — that removes loopback's free pass, since a key is
then required from everyone.

There's no TLS here and no defence against a determined attacker. Don't put this
on the public internet. If you must, terminate TLS in front of it, set `apiKeys`,
and lower `peerRateLimit`.

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
from costing more than it saves: a good reading is reused for `peerFreshMs`,
concurrent requests coalesce onto one probe, and a failure is remembered for
`peerDownMs` so a broken peer can't make your local requests slower. An idle
node makes no peer traffic at all.

Unknown always means local. A probe that doesn't answer in time is unknown.

## Development

```bash
npm test          # assert-based, each file runs standalone
npm run build
```

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
on `/ui` from this machine's own LAN address, with a valid api key, to prove the
loopback gate holds anyway. It skips itself on a host with no routable
interface rather than pretending to have checked.

The page lives in [`src/ui.ts`](src/ui.ts) as a template literal, so backticks
and `${` inside it are escaped. Get that wrong and the build fails loudly
rather than shipping something broken.

MIT.
