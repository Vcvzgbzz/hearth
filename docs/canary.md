# Canary

Every other check asks whether a backend is reachable. None asks whether the
model on it still answers. A backend can hold its model, return `200 OK` to
every request and fill each answer with one repeated character: it reads as
healthy everywhere, and everything downstream gets nothing it can use.

A canary asks each model you name a question with one right answer, on a
schedule, and takes a model that stops answering it out of rotation. It is off
unless you configure it, because a heartbeat that talks to a model on its own
schedule is not something to switch on for someone:

```yaml
canary:
  prompt: "What is the capital of France? Reply with the city name only."
  expect: "Paris"            # a regex, case-insensitive
  maxTokens: 512             # a reasoning model's trace shares this budget
  timeoutMs: 30000
  intervalMs: 30000          # between probes of one model
  failureThreshold: 2        # consecutive failed probes before `degraded`
  recoverAfter: 1            # consecutive clean probes before back in rotation
  passive: false             # true: a degenerate real answer brings the next probe forward

  # Which models to ask. Naming one is the opt-in; an entry may override any
  # of the fields above for that model.
  models:
    chat: {}
    reasoner:
      maxTokens: 1024
    # anything:              # a `follow` id: whatever the card holds answers under it
    #   onlyAs: chat         # watched only while that is `chat`

  # Or every model a backend serves.
  # backends:
  #   main: {}

  # notify:
  #   url: "https://example.com/hooks/hearth"
  #   headers:
  #     Authorization: "env:HOOK_TOKEN"   # env:NAME keeps a secret out of the file
  #   timeoutMs: 5000

  # recovery:
  #   unload: true
  #   cooldownMs: 600000
```

Everything but `models` (or `backends`) has the default shown. The question and
the pattern are yours to change: anything with one short, checkable answer works.

A probe is a real chat completion, queued on the model's backend at the lowest
priority, so it yields to everything real. It is skipped, never queued behind
work and never retried in a loop, when the backend is busy or the model is not
loaded. **A probe never loads a model and never evicts one**: a cold model is
not asked, and the probe takes no hardware claim.

## What a verdict means

| reason | what it means | counts? |
|---|---|---|
| `ok` | matched `expect`, and reads like language | no |
| `empty` | nothing came back in the content channel | yes |
| `degenerate` | one character or one token repeated, near-zero distinct characters, or the token cap reached without answering | yes |
| `missing` | a real answer that does not answer the question | yes |
| `transport` / `timeout` | the request failed or ran past `timeoutMs` | yes |
| `thinking` | the budget went to the reasoning channel and `content` is empty: the probe asked for too little | **no** |
| `skipped` | the probe could not take a lane | **no** |

The last two are inconclusive rather than failures. A reasoning model given too
few tokens returns an empty `content` with `finish_reason: length` while being
healthy, and a full queue says nothing about the model. Neither degrades one;
raise `maxTokens` for a model that keeps reading `thinking`.

`passive: true` also reads completions **as they are relayed** to clients. A
degenerate one is a suspicion, not a count: it brings the next probe forward to
the next tick (about a second) instead of the next interval, and the probe
decides. Real traffic alone never takes a model out of rotation, because a
client's own prompt can legitimately draw a wall of one character. Nothing is
filtered, buffered or delayed: the bytes reach the client as they were.

## When a model is degraded

After `failureThreshold` consecutive failed probes, new requests for that model
get a `503` with the facts attached, on `/v1/chat/completions` and on any
passthrough path that names the model:

```json
{"error":{
  "message":"model \"chat\" is degraded on main: the answer repeats itself (200 of the same character in a row) (since 2026-01-01T12:00:00.000Z). hearth refuses new requests rather than serving broken output; it returns to rotation after a clean canary probe.",
  "type":"server_error",
  "code":"model_degraded",
  "model":"chat","backend":"main",
  "reason":"degenerate",
  "detail":"the answer repeats itself (200 of the same character in a row)",
  "sample":"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "since":"2026-01-01T12:00:00.000Z",
  "failures":2}}
```

`/v1/models` reports it as `status: {value: "degraded"}` rather than `loaded`,
with the reason in `description`. `/healthz` counts it. The console names it in
a strip under the header on every page. Peers are refused too. Probes continue
while a model is degraded, and `recoverAfter` consecutive clean ones put it back.

## notify

`notify` POSTs a JSON body to `url` on each state change, with `headers` sent
as written. The body is the event and nothing else:

```json
{"event":"degraded","node":"box","model":"chat","backend":"main",
 "reason":"degenerate","detail":"the answer repeats itself (200 of the same character in a row)",
 "sample":"!!!!!!!!!!!!!!!!","since":"2026-01-01T12:00:00.000Z","failures":2}
```

```json
{"event":"recovered","node":"box","model":"chat","backend":"main",
 "since":"2026-01-01T12:00:00.000Z","downMs":184000,"probes":7}
```

hearth does not phrase a title or a message, so a receiver that wants one (a
chat webhook, a notification API with its own field names) builds it from these
fields, in whatever sits at `url`. The hook is fire-and-forget: one that is
slow, wrong or down gets a line in the log and changes nothing else.

## A followed id: `onlyAs`

A `follow` id goes out as whatever its card holds, so a probe of it asks whichever model is
loaded. Where the question, the token budget or the cost of a wrong verdict only fit one of
them, name it: `canary.models.<id>.onlyAs: <backend id>`. While the id goes out as anything
else it is not probed, real traffic under it is not judged, a verdict it earned as the named
model is not held against the one answering now, and recovery leaves that model alone. The
moment the named model is back under the id, so is the canary, with the state it had.

A recovery reload also treats a card that an app is keeping with `hold:` as occupied: it
waits for the app to let go rather than swapping it out.

## recovery

`recovery:` is its own opt-in and does one thing: for a backend that can drop a
single model, ask it to, so the next request reloads it. On llama-swap this is
`POST /api/models/unload/<model_id>`, never `/api/models/unload`, which clears
every model the backend holds.

It is attempted at most once per `cooldownMs`, only while the model is loaded,
and never on a busy backend: no running job, nothing queued. The probe that
follows is the one probe allowed to load the model back. It claims the hardware
the way a request does, and waits while anything else is loaded there, so the
reload cannot evict a neighbour.

A backend that cannot drop one model (`kind: ollama`, `single`, `none`) makes
recovery inert, and the log says so. Restarting a backend that is wedged as a
whole is the operator's call.

## What it costs

One small completion per watched model per `intervalMs`, only while that model
is loaded and its backend is idle. Nothing is sent when no canary is configured.
