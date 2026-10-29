# Routing

What can be asked for, and where each request goes.

## Flows

A flow decides where a request goes. It names the ids it takes and a list of
steps; each request for one of those ids goes to the first step that holds.

```yaml
flows:
  pick:
    inputs: [auto, chat-model]
    steps:
      - when: { images: true }
        to: vision-model
      - when: { tokensOver: 32000 }
        to: { flow: heavy }
        lane: batch
      - when: { queuedUnder: 3 }
        to: chat-model
        params: { temperature: 0.2 }
      - to: small-model

  heavy:
    steps:
      - to: { peer: friend, model: big-model }
      - to: big-model
```

**Inputs** are ids clients ask for. One may be a model a backend serves
(`chat-model`: its requests now pass through the flow first) or a name nothing
serves (`auto`: it exists only as a way in, and is listed on `/v1/models`).
Only what a client asked for enters a flow. A step that names a model runs it
as named, so `to: chat-model` inside the flow that takes `chat-model` means
"let it through".

**A step's `to`** is one of:

| `to` | the request |
|---|---|
| `some-model` | runs here as that id, on the backend that serves it |
| `{ peer: name }` | runs on that peer, as the id that was asked for; add `model:` for another of your ids. The peer must map the id under `peers.<name>.models` |
| `{ flow: name }` | carries on in another flow. A flow that leads back to itself is refused at startup |
| `{ fastest: [a, { peer: b }, …] }` | runs wherever it would start soonest, by queue depth and whether the model is loaded. A tie stays with the one listed first |
| `{ refuse: "why" }` | is answered 503 with that reason |
| `{ asked: true }` | runs here as the id that was asked for. See [Types](#types) |
| `{ plugin: name }` | for a request to a plugin's own API, goes to that plugin. A model request passes this step over. See [Plugins on the router](#plugins-on-the-router) |

**A step's `when`** holds when every condition in it does:

| condition | holds when |
|---|---|
| `images: true` / `tools: true` | the request carries images / tool definitions (`false` for the opposite) |
| `tokensOver: n` / `tokensUnder: n` | the estimated prompt plus reserved output is over / under `n` |
| `variant: [name]` | the name was asked for in one of these variants: `LLM:fast` is the type `LLM` in its `fast` variant. See [Types](#types) |
| `path: [path]` | the request arrived on one of these paths, each as a backend declares it under `routes:`. A chat request matches none. Lets one type run a different model on each path it takes |
| `header: { name: [value] }` | the request carries that header with one of these values; with no values, with any value. The name is matched in lower case and the value trimmed. A request without the header matches none. Use it for anything your callers can tell you that hearth has no word for: an account setting, a tier, a team |
| `headerNot: { name: [value] }` | the opposite: the header is not one of these values, or with no values is not sent. A request without the header matches |
| `asked: [id]` | the client asked for one of these ids |
| `caller: [name]` | the request came with the api key labelled `name`, or `local` for loopback without a key |
| `lane: [name]` | the request is in one of these lanes |
| `askedNot`, `callerNot`, `laneNot` | the opposite of those three: none of the names listed |
| `time: { from: "22:00", to: "06:00" }` | the node's own clock is between the two, `from` included and `to` not. A `from` later than `to` runs through midnight |
| `held: [id]` | a neighbour's `hold` is keeping the request's lane off that model's hardware |
| `down: [peer]` | none of these peers can take it: down, not lending the id, or too small for the request |
| `idle: { model: id, ms: n }` | nobody has used that model here for at least `n` ms: nothing queued or running for it, and nothing finished more recently. Every name for one model counts as that model. Work a flow sent to it does not count, so a rule that borrows an idle model does not end its own idleness. Leave `model` out to read the step's own target. After a restart every model counts as idle since startup, unless `historyFile` is set, which keeps when each was last used |
| `warm: true` | the step's own target has the model loaded |
| `ready: true` | running it on the step's own target needs no swap: the model is loaded there, or nothing else is loaded on its backend or on any backend sharing its exclusive hardware. For a peer this is the same as `warm` |
| `free: true` | the step's own target has a free slot |
| `queuedUnder: n` | fewer than `n` jobs are queued at the step's own target |

So "use the big model only while nobody else has touched it for ten minutes"
is one step:

```yaml
- when: { idle: { model: big-model, ms: 600000 } }
  to: big-model
- to: small-model
```

A step is also passed over when its target cannot take the request: a peer
that is down or whose model is too small. So a step that only names a peer
needs no `when`, and "try my friend, else run it here" is two lines. A step
that only names a model here needs none either: the lines after it are where
the request goes when that model fails before it answers, as described next,
so "run it on the card, else on the CPU" is two lines too. The last
step has no `when` and somewhere that can always answer (a model, a flow or
`refuse`), so every request gets a decision. If a peer fails before sending
anything back, the flow is asked again without peers, and the request runs
where that lands or the peer's error is returned. A backend here is treated
the same way: when it cannot be reached or answers 5xx before anything has
gone to the client, and the flow has another line that ends at a model here,
the request runs there instead. With nowhere else to send it, the backend's
own answer is relayed as it always was. A request already streaming its queue
position stays where it is.

A flow that `takes` a path survives the same way: its next line that ends at a
model the path can run takes the request, and after the last of those the
route's own `fallback`. A line may name a model on another backend when that
backend declares the same path, or declares none. On a path with the model in
it (`/upstream/{model}/...`) the next line runs at that path with its own model
in the segment.

`sticky: 1800000` on a flow keeps a conversation where its first turn went: a
later turn (one that carries an assistant message) goes to the same model or
peer for that long, whatever the steps would say now, as long as that place
can still take it. A conversation is the caller, the id asked for and
everything up to its first user message. Without it each turn is decided
afresh, which suits one-shot calls and can move a chat between models midway.

`off: true` parks a flow: requests for its inputs run as themselves, and
another flow can still hand work to it.

A step may set `max`, the most requests it takes at once: past that it is
passed over and the request goes on down the list, so "borrow the big model,
two at a time" is `max: 2`. A limit is reason enough for a step to have no
`when`. The count is of requests whose response is still open.

Every chat answer carries `x-hearth-model`, the id the request ran as, since
one name may run as several. `modelHeader: false` leaves it off, for a node
whose callers should not see what is behind a name.

A step may set the `lane` the request queues in, which wins over the target's
own and the client's, and `params` to stamp on the request; the target model's
own `params` still apply over those.

Work a peer borrows is served as asked and never enters a flow, so two nodes
cannot bounce a request between them. Paths other than chat completions are
not routed this way.

### Types

Only a name some flow takes can be asked for. Those names are this node's
**types**: `LLM`, `Voice`, `ImageGen`, or a model's own name where you want
it offered as itself. An app asks for a type and never needs to know which
model answers, and `/v1/models` lists the types, not the models.

```yaml
flows:
  LLM:
    inputs: [LLM]
    steps:
      - when: { images: true }
        to: vision-model
      - to: chat-model

  ImageGen:
    takes: "/upstream/{model}/generate"   # not chat: a path a backend declares under routes:
    inputs: [ImageGen]
    steps:
      - to: image-model

  anything-else:
    inputs: ["*"]                         # every name no other flow takes
    steps:
      - to: { refuse: "ask for LLM or ImageGen" }
```

**Every file has one flow with `inputs: ["*"]`**, which says what becomes of a
name no other flow takes. `to: { refuse: "…" }` turns it away in your words,
a name nothing here serves included, so only your types can be asked for.
`to: { asked: true }` runs it here as the id that was asked for, which keeps
every model callable by its own name, and a name nothing serves gets a `404`; `asked` works in
any flow, and is how one that takes several names sends each to its own model.
It may have conditions like any flow. A file without one does not load:
`hearth migrate` adds one that runs names as themselves, which is how a node
behaved before types.

**A type comes in variants.** `Name:variant` asks for the type in that variant,
and a step tests which with `variant:`:

```yaml
  ImageGen:
    takes: "/upstream/{model}/generate"
    inputs: [ImageGen]
    steps:
      - when: { variant: [realism] }
        to: photo-model
      - to: image-model
```

`ImageGen` runs as `image-model` and `ImageGen:realism` as `photo-model`. The
variant rides where the name does, in a chat body, a path or any other body,
and `/v1/models` lists each beside its type. A variant no step tests is not
offered, so a mistyped one is refused with the ones that exist and never
quietly answered as the plain type. A name a flow takes as written is itself,
colon and all.

**A caller can tell a flow something of its own.** A step tests any header
the request carries, by a name and values you choose, so an app in front of
hearth can pass along what it knows about who is asking:

```yaml
flows:
  chat:
    inputs: [chat]
    steps:
      # Accounts that asked for their work to stay here never reach the peer.
      - when: { headerNot: { x-stay: [local] } }
        to: { peer: friend }
      - to: my-model
```

A header is whatever the caller sends, so one that only narrows where work may
go is safe from anyone, and one that widens it (`x-tier: paid`) belongs beside
`caller:` for a key you trust.

**A type can span several paths.** `takes:` may list more than one, and a step
tests which the request arrived on with `path:`:

```yaml
flows:
  Utility:
    takes: ["/v1/embeddings", "/v1/rerank"]
    inputs: [Utility]
    steps:
      - when: { path: ["/v1/embeddings"] }
        to: my-embedder
      - when: { path: ["/v1/rerank"] }
        to: my-reranker
      - to: { refuse: "nothing answers that here" }
```

A model a flow picks has to be one the path can run: one its backend serves, or
its route's `fallback` backend does. Otherwise the request is refused with a
503 naming both, and nothing runs in its place.

**A different operation is a different type.** Editing an image arrives on
another path than generating one, so it is `ImageEdit` with its own `takes`. A
type is offered only on the paths it takes, and one with `takes` is not offered
as chat.

**Work that is not chat** arrives on a backend's own path and queues under
hearth as before. The name it carries is looked up the same way: the `{model}`
segment of a path (`/upstream/ImageGen/generate`), or the `model` in its body.
The flow says which model runs it, and the request goes on under that model's
id. A path with no name in it (`/generate`) is asked for by the flow whose
`takes` lists it. A flow with `takes` can test the caller, the lane, the time
and the state of its targets, but not what only a chat request has (images,
tools, size), and cannot send to a peer. One model per path is all a type has
to choose from unless two models answer the same path.

Requests a peer borrows are served as the model it was lent and do not pass
through types. Maintenance calls that hearth forwards without queueing (a
model swapper's own endpoints) are not affected.

### Routers

`flows:` is the default rulebook. A router is another one, and `callers:` says
who goes by which: an api key by its label, `local` for this machine with no
key, and `*` for everyone not named. A value is a name under `routers:`, or
`default` for `flows:`. With no `callers:`, everyone goes by `flows:`.

```yaml
routers:
  direct:
    strict: true
    flows:
      chat: { inputs: [chat], steps: [{ to: my-model }] }
      anything-else: { inputs: ["*"], steps: [{ to: { refuse: "not offered here" } }] }
callers:
  local: direct        # requests from this machine go by routers.direct
  # "*": direct        # ...or everyone does, with `app: default` to send one key back to flows:
```

Here a request from this machine for `chat` runs on `my-model` whatever the
rules in `flows:` would have done with it, and nothing else is offered to it.
A caller is listed its own router's names on `/v1/models`. Each router needs its
own flow for `*`, as `flows:` does, and none may be called `default`.

`strict: true` switches off every way a request can end up somewhere else for
a router's callers: a flow's next line after a failure, on chat and on paths,
and a backend route's `fallback`. A request runs on the model its line names or
fails. That is the
setting for testing a model without wondering whether something else answered.

A step's `max`, a flow's `sticky` and the line counts are kept by flow name, so
two routers with a flow of the same name share them; only `flows:` is counted.

The Topology page draws this node as a frame with its callers inside:
**everyone else**, `local`, and every labelled api key, each with a line to the
router its requests go by, and each router under the default one. Drag a
caller onto a router to send it there, or click it to choose from a list, which
also offers "wherever everyone else goes". A caller drawn faint only follows
everyone else; one you have sent somewhere stays there when they move.
The change joins the routing draft and is published from the Routing page.
Clicking a router opens its rules there.

The rest of the Topology page is edited where it stands too, into the same
draft: **+ backend**, **+ hardware** and **+ machine** add one; clicking a
backend, a card or a machine opens its settings beside the picture; and a
backend's card is dragged onto other hardware or another machine to say where
it runs. Hardware is dragged by its title onto another machine the same way:
every backend there that uses it goes with it, and so does any other card those
backends use, since one card is in one machine. Shared hardware takes only the
backends that sit in it. Hardware and machines with nothing on them yet are
drawn empty, to be dragged onto, and the small chips of a crowded card drag the
same way. Let go in the hardware it is already in, a backend takes that place
among the others there; the order joins the draft and is kept with the layout.
**review & publish** there lists what changes in plain words above the diff
and says what needs a restart before anything is written; **versions** is
beside it. What is published but not running yet stays said on the strip, with
the restart button, and in the panel of anything it concerns.

On the Routing page the first button says which rulebook is on the map. Its
menu switches between them and starts a new one, from the rules shown or from
one that refuses everything. With a router shown, the buttons beside it say
whose requests go by it, set **never fall back**, and delete it.

### Plugins on a line

A step can run plugins on the requests it sends to a model: each gets the
request and passes it on changed, in the order listed, and the last one's goes
to the model. On the Routing map they are blocks on the line, added from the
line's ⋯ menu. See [Plugins](plugins.md#where-a-plugin-runs).

```yaml
flows:
  chat:
    inputs: [chat]
    steps:
      - to: { model: my-model }
        plugins: [memory]
```

### Plugins on the router

A request to the API a plugin serves (`/plugins/<name>/*`) is asked of the caller's router the way a model
is: as `MCP:<name>` for a plugin that speaks MCP and `API:<name>` for any other, so `MCP` and `API` are
types and the plugin is the variant. The steps decide whether it goes on, and where:

```yaml
routers:
  partners:
    flows:
      tools:
        inputs: [MCP, API]
        steps:
          - when: { variant: [search] }
            to: { asked: true }              # the plugin it names
          - when: { variant: [web-search] }
            to: { plugin: search }           # a name of the router's own: /plugins/web-search/ goes to search
          - to: { refuse: "only search is open to partners" }
      rest: { inputs: ["*"], steps: [{ to: { asked: true } }] }
```

- A name that is no plugin's own is asked as `API:<name>`, then `MCP:<name>`, so a router can give its callers
  names of its own and decide which plugin answers each; a request by a plugin's own name is then the router's
  to refuse, like any other.
- `{ asked: true }` lets it through to the plugin it names, and `{ plugin: name }` sends it to another;
  `refuse` turns it away (403, with the step's words). A step that sends to a model or a peer is passed over.
- A model request passes over a step that names a plugin, so such a step cannot be a flow's last.
- Every condition a step can test applies: the caller, a header, the time of day.
- With no flow for `MCP` or `API`, a router's flow for every other name decides, as it does for a name no
  rule takes: one that runs it as itself lets every plugin through, and one that refuses refuses every plugin
  until a flow for `MCP` or `API` is added.

### Actions

An action is something a step sets off beside routing: a line in the log, or a
request to a URL. It is named once under `actions:` and a step lists the ones
it runs under `do:`.

```yaml
actions:
  note:
    log: "{asked} ran as {model} for {caller}"
  tell:
    call: env:HOOK_URL
    headers: { authorization: env:HOOK_TOKEN }
    body: { text: "{asked} went to {model} ({reason})" }

flows:
  borrow:
    inputs: [small-model]
    steps:
      - when: { idle: { model: big-model, ms: 600000 } }
        to: big-model
        do: [note, tell]
      - to: small-model
```

An action runs when its step decides, a refusal included, and once per request.
`on: finished` holds it until the request has ended, and `on: failed` runs it
only when that went wrong; both add `{outcome}` (`ok` or `failed`), `{ms}` and
`{error}` to what it is told, with `{queuedMs}` and `{ranMs}` splitting the
time into waiting and running, and `{backend}` and `{model}` as they ended up.
`slowerThan: 30000` keeps it for requests that took longer than that, and
is itself a reason to wait for the end. `every: 60000` runs it at most once a minute.
It never changes where the request goes and nothing waits on it: a URL that is
slow, wrong or down gets a `flow.action_failed` line in the log and is given
up on after five seconds.

Text in `log`, and every string inside `body`, may use what the flow knew about
the request: `{asked}` and `{model}` (the id the client named and the id it
runs as), `{target}` (`local`, `peer` or `unavailable`), `{peer}`, `{lane}`,
`{caller}`, `{tokens}`, `{images}`, `{tools}`, `{flow}` and `{line}` (the step
that named the action), `{reason}`, `{node}`, `{action}`, `{backend}` and
`{id}` (the request's id, when it has one). A `call` with no
`body` sends all of those as one JSON object. A `log` line is written at info
as `flow.action`, with the same facts as fields, so it shows on the Logs page.

A model used to carry its own routing as `models.<id>.policy`, `peers`,
`spilloverAt`, `fallbackLocal` and `whenHeld`. Those are refused now, with one
line pointing at `hearth migrate`, which rewrites each as the flow it described
under the model's id, keeps the comments, and leaves the file as it was beside
it. Check a file with `hearth serve --check` afterwards.
