# Backends

One node in front of several servers, cards and machines.

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

A model id still belongs to one backend. To spread one name over several, give
each backend's copy an id of its own and let a flow choose between them:

```yaml
backends:
  gpu0: { url: "http://127.0.0.1:8080", concurrency: 1, serves: [chat-0] }
  gpu1: { url: "http://127.0.0.1:8081", concurrency: 1, serves: [chat-1] }

models:
  # Each backend knows the weights by the same name; `as:` sends that name.
  chat-0: { backend: gpu0, as: my-model }
  chat-1: { backend: gpu1, as: my-model }

flows:
  chat:
    inputs: [chat]
    steps:
      - to: { fastest: [chat-0, chat-1] }
```

A request for `chat` runs on whichever would start it soonest, by queue depth
and whether the model is loaded; a tie stays with the one listed first. If the
one chosen fails before anything reaches the client, the request is tried on
the next. Each backend keeps its own queue and its own slots, so this spreads
work at the moment a request arrives and never moves one that is already
queued. It compares depth, not predicted duration, and there is no round-robin
or weighting.

### Backends on another machine

A backend does not have to be on the machine hearth runs on. Name the other
machines once under `servers:` and point backends at them:

```yaml
servers:
  render: { host: 10.0.0.5 }

resources:
  gpu0: { kind: gpu }
  gpu1: { kind: gpu }

backends:
  chat: { url: "http://127.0.0.1:8080", resources: [gpu0] }
  image: { server: render, port: 7860, kind: none, resources: [gpu1] }
```

`image` is reached at `http://10.0.0.5:7860`. It is still one of this node's
backends: one queue per backend, one set of lanes, one console, and its hardware
is arbitrated like any other. The status page frames each machine around the
hardware in it. Move the machine and you change one `host`.

A backend that needs `https` or a path keeps its own `url` and names the
`server` only to say where it is. A backend with no `server` is on this machine.
Hardware belongs to one machine, so two backends on different machines naming
the same exclusive resource is refused: give each machine's card its own name.

Use a server for a machine on a network you control, where hearth can call the
backend directly; requests go to it as plain HTTP unless its `url` says
otherwise. Use a [peer](sharing.md#sharing-capacity) for another hearth across the
internet or run by someone else: it has its own queue, tokens and limits. Use a
[cloud backend](providers.md#a-providers-models) for a provider's API.

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

Leave out `resident` and the two take turns on the card instead, like any two backends
that share a resource. On a shared URL each backend counts only its own models as
loaded or loading: the one that declares `serves` sees just those ids, the other sees
everything else. So a turn for `card` evicts `rerank` only while the reranker itself is
on the card, and evicting either one drops only its own models, each with
`POST /api/models/unload/<id>`, never the whole llama-swap. That is why `serves` here must
list the ids llama-swap reports in `/running`: an alias it reports under another name is
never counted as loaded, so its neighbour would load on top of it.

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
`model` renamed to the id that backend serves, in a JSON body or a form's `model` field. A 4xx
is the caller's answer and is relayed. A request that names an id only the fallback serves
goes straight there, and so does one for a name pinned to it with `models.<id>.backend`, which
is how two backends that run the same model each get a name of their own.

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

## Weights that are not on the card

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

## A backend that works without hearth scheduling it

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
the rest of the console; hearth adds no background poll for it, unless the
backend also declares a `hold`.

### Keeping background work off the card while the app is in use

Without more, the first request for a model on that card swaps the app's weights
out from under whoever is using it. `hold:` lets the app keep the card against
the lanes you name, and only those:

```yaml
backends:
  comfy:
    url: http://127.0.0.1:8188
    kind: none
    resources: [gpu0]
    activity: { path: /queue, running: queue_running, queued: queue_pending }
    hold:
      lanes: [batch]        # these lanes wait; every other lane takes the card as before
      idleMs: 3600000       # until the app has had nothing running or queued for an hour
      # seat: image-app     # optional: the id a model swapper loads the app under (see below)
models:
  summaries:
    backend: main
    lane: batch
flows:
  summaries:                    # optional: run as another id meanwhile, instead of waiting
    inputs: [summaries]
    steps:
      - when: { held: [summaries] }
        to: summaries-small
      - to: summaries
```

The hold starts with the first reading that shows work, running or queued, and
is renewed by every such reading. An app that is up and idle holds nothing, so
restarting hearth or the app does not start one. It ends once the app has been
idle for `idleMs`, or has stopped answering for half a minute. A backend with a
`hold` has its path read every two seconds, page or no page.

While it lasts, a job in a held lane on any backend sharing that hardware stays
queued and is passed over, so it never blocks the lanes behind it. The lane's
`maxWaitMs` does not run against a held job: it waits out the hold, and has the
whole of `maxWaitMs` again once the hold ends. A model whose flow has a `held` step does
not wait: its request runs as the id that step names, on that id's backend and
in that id's lane, which is how background work moves to another card with a
ceiling of its own. A flow covers a local caller's chat requests only: a held job that
arrives on a `routes:` path, or from a peer, waits. `/network` lists every hold
under `holds`, with `active` and how long the app has been quiet, for a client
that wants to plan around it. Keep the `activity` path one that does not start
the app: a path through a model swapper would load it on every read.

When the app is itself a seat in a model swapper, it answers nothing until its
seat is up, a whole load after someone asked for it, and in that window a held
lane would take the card back and swap the half-loaded app out. Name the seat's
id with `seat:` (an id some backend declares in `serves`) and the hold starts
the moment that seat begins loading, and ends the moment the swapper drops it.

The app and its swapper entry can be one backend: give it the swapper's `url`,
`serves: [the seat]`, and an `activity` path through the swapper to the app
(`/upstream/<seat>/queue` on llama-swap). hearth reads that path only while the
seat is loaded, so reading it never starts the app.
