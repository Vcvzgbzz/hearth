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

## Joining with an invite code

Instead of making a token and sending it over chat, the lender can hand out a
code that sets both entries up:

```bash
# on the lender: the address the borrower reaches you at
hearth invite --url http://100.x.y.z:4141

# on the borrower, with the code it printed
hearth join hearth-invite:…
```

The console does the same from the Lending page: **invite a peer** asks for the
address and shows the code to copy, and **join with a code** takes one.

The lender's node adds `peers.<borrower's name>` with a fresh `accept`, the
borrower's adds `peers.<lender's name>` with the lender's `url` and that same
token, and both apply at once. Neither person ever sees the token: the code
carries only a one-time secret, which the join swaps for it.

- An invite lends one way: the borrower may run what the lender's `lending`
  allows, and the lender borrows nothing back. Inviting the other way links the
  reverse.
- The code works once and for 10 minutes, and lives only in the running node, so
  a restart voids it. Anyone holding the code in that window can join with it,
  so send it the way you would send a short-lived password.
- A code names the address your node contacts when you join, the way a peer's
  `url` does. Join only with a code from someone you would add as a peer by hand.
- The borrower's node name must be one the lender has no peer under yet.
  `hearth join --as <name>` picks the name the lender is kept under on the
  borrower's side. A name the borrower already borrows from is refused before
  the code is spent; a peer the borrower only lends to keeps its entry and
  gains the `url` and `token` to borrow back, so the two link both ways.
- Both commands ask the node that is running, on its `listen` port. If it sets
  `apiKeys`, give one as `HEARTH_KEY`.
- The tokens are written into each `hearth.yaml` as they are, the way minted api
  keys are. To keep one in the environment instead, move it to a variable and
  write `env:NAME` in its place.

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
**peer** is an edit to `peers:`, from the console's config editor, `PATCH /config`
or the file itself, and applies without a restart:

- A new peer starts out down and is asked for its state at once.
- A changed `url` or `token` starts that peer over: what was read from the old
  address says nothing about the new one, so it is down until the new one
  answers.
- A removed peer is forgotten. Requests already sent to it finish.
- Only `borrowing.pollMs`, how often every peer is asked in the background,
  still waits for a restart.

## Limits per peer

`lending:` says what every peer may take. A peer's own `lend:` restates any of it
for that peer alone:

```yaml
lending:
  models: [small-model]     # what any peer may run
  tokensPerDay: 500000      # each, in a UTC day; 0 is no limit
  maxConcurrent: 2          # jobs in flight
  rateLimit: 600            # requests an hour

peers:
  friend:
    accept: env:HEARTH_PEER_FRIEND
    lend:
      models: [small-model, big-model]   # this one may run the big one too
      tokensPerDay: 2000000
  acquaintance:
    accept: env:HEARTH_PEER_ACQUAINTANCE   # the node's limits, as they are
```

`lend: { off: true }` lends one peer nothing and leaves its limits in the file
for when it is turned back on.

A peer that has used its tokens for the day, or is turned off, is shown a node that lends it
nothing, on the same poll that reports capacity, so its flows stop choosing you
instead of sending work to be refused. One that asks anyway gets a `429` that
says so. The day's tokens are counted as each answer ends, so a peer can pass
its limit by what it had in flight when it reached it.

A model taken back on the Models page, or with `share` on `/control`, is taken
out of every peer's own list as well. One lent there joins `lending.models`
only: a peer with a list of its own is given it in that list.

Every node also counts, per peer, what that peer ran here and what this node
ran there. `GET /lending` reports both, and the console shows them on each
peer. Tokens are counted as on `/usage`: the backend's own `usage` where the
answer carries one, an estimate where it does not. Only chat is counted, which
is the only work a peer is sent. Without `historyFile` the counts start again
at every restart.

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

## Binding a peer to its machine

A peer's `accept` token is a shared secret: whoever holds a copy can borrow as
that peer. When both nodes are on a tailnet, `tailnet` ties the token to the
peer's machine as well:

```yaml
peers:
  friend:
    accept: env:HEARTH_FROM_FRIEND
    tailnet: nExampleStableID    # their machine, as `tailscale whois <their 100.x address>` prints it
```

On each request with that token, hearth asks this machine's tailscaled which
tailnet node is calling and lets the request in only when it is that one. A copy
of the token used from anywhere else gets a 403, and the log line
`peer.wrong_machine` names the machine that tried.

- Match on the stable node ID (`StableID` in `tailscale whois --json`). It
  survives renames, which the machine name does not. The console offers it
  instead: open the peer on the Lending page and **bind to** the machine it
  last called from.
- The check needs the peer to reach you over the tailnet. A connection to your
  LAN address has no tailnet identity, so it is refused for a bound peer.
- hearth reads tailscaled's local API at `tailscaleSocket`. Tailscale running in
  the same container, or the host's socket mounted into it, both work. If the
  socket cannot be asked, a bound peer is refused rather than let in on its
  token alone.
- A peer without `tailnet` is checked by its token only, as before.
- This does not make a proxy in front of hearth safe. A proxied request arrives
  from loopback, which no tailnet node owns, so a bound peer is refused and an
  anonymous caller is still promoted to local. See
  [Do not put a proxy in front of it](security.md#do-not-put-a-proxy-in-front-of-it).

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
