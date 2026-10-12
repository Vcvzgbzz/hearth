# Models

What a model is called, what it is sent, and when it is loaded.

## Advertising a nicer id than the backend uses

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

## One resident model, several ids, different defaults

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

## Keeping answers

`cacheMs` on a model keeps each answer for that long. A request that names the
same model with every field the same gets the kept answer back at once, marked
`X-Hearth-Cache: hit`, and takes no slot and no queue.

```yaml
models:
  classifier: { cacheMs: 600000 }   # ten minutes
```

It suits requests that are asked again word for word: a classifier, an
embedding-like lookup done through chat, a fixed prompt behind a button. It
does not suit a conversation model, where asking again is asking for a
different answer: with this on, "regenerate" returns the same text until the
time is up.

What is kept is what was sent to the client, so a stream is kept and replayed
whole. Only a `200` is kept, and for a stream only one that reached its end.
An answer larger than 1 MB is not kept, and the node keeps 500 at most, the
least recently asked for going first. The answers are shared by every caller
of that model: two callers who send the same request see the same answer, so
leave it off where an answer depends on who asked. A stream opened with
`X-Hearth-Queue: stream` is neither kept nor answered from what is.

## Knowing what is warm

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
