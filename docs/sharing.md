# Sharing capacity

Both ends run hearth. Yours:

```yaml
peers:
  friend:
    url: http://100.x.y.z:4141
    token: env:HEARTH_TOKEN_FRIEND   # you present this to them
    models:
      # my id: their id. Also the allowlist: a model that isn't mapped can
      # never be sent to them, whatever a flow says.
      big-model: their-big-model

flows:
  big-model:
    inputs: [big-model]
    steps:
      - to: { peer: friend }   # try them first
      - to: big-model          # else run it here
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

A model no flow takes never leaves. The common shapes of one that does, each a
few steps of a [flow](routing.md#flows):

| to get | steps |
|---|---|
| a peer first, home as the fallback | `- to: { peer: friend }` then `- to: big-model` |
| home until the queue is deep, then a peer | `- when: { queuedUnder: 2 }` with `to: big-model`, then the peer, then `big-model` |
| whichever would start it soonest | `- to: { fastest: [big-model, { peer: friend }] }`. Ties stay home |
| a peer or nothing | `- to: { peer: friend }` then `- to: { refuse: "not run here" }` |

## Knowing what a borrowed model can take

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

## When nothing can be asked

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
