# A provider's models

A backend can be a provider's OpenAI-compatible API instead of a server of
yours. Mark it `cloud` and give it the key the provider issued:

```yaml
backends:
  provider:
    url: https://api.example.com/v1
    cloud: true
    key: env:PROVIDER_KEY
    serves: [their-large-model]

models:
  big: { backend: provider, as: their-large-model }

flows:
  chat:
    inputs: [chat]
    steps:
      - { when: { tokensOver: 60000 }, to: { model: big } }
      - { to: { model: my-model } }
```

- `key` goes out as `Authorization: Bearer` on every call to that backend: chat,
  any path under its `routes`, and the read of its model list. A key the client
  sent for this node is never passed on. `key` works on any backend, cloud or
  not, for a server of your own that wants one.
- `headers` is for an API that asks for more than the key: each `name: value`
  under it goes out on the same calls, and a value may be `env:NAME`. The
  console is shown none of them, as with the key.
- `cloud` says it is not yours: it takes no `resources` and no `server`, its
  `kind` is `none`, and `serves` is required, so the node offers the models you
  name and not the provider's whole list.
- The [canary](canary.md) does not probe its models, and naming one under
  `canary:` is refused: the provider answers for them, and every probe would be
  billed.
- Its models cannot be lent to a peer: a peer's requests would be paid for
  with your key.
- It is queued like any backend. `concurrency` is how many requests you let it
  have at once, and per-key usage and limits count what goes there.
- `url` is the address every call's `/v1/...` path is added to. One copied with
  `/v1` on the end is read as the same server.
- If the provider refuses the key, the caller gets a `502` saying so, not the
  provider's `401`, which would read as this node refusing the caller. A flow
  with another line that fits moves on to it.
- The console draws these backends in a Cloud group on the topology, each with
  what is wrong when its model list cannot be read (key refused, rate limited,
  not reachable), and gives a rule line that sends to one a colour of its own.
  **+ provider** there asks for the url and key, tries them, and lets you pick
  the models to offer from what the provider lists.

**A request sent to a cloud backend leaves this machine and this network**, with
the whole prompt. Nothing sends one there unless a flow or a model's `backend`
says so. A flow line can keep some requests home the same way it keeps them
off a peer, by a header, a caller or a lane.

- A streamed answer's token count comes from the provider: the node asks for
  it (`stream_options.include_usage`) on every streamed chat it sends to a cloud
  backend, and keeps the extra event from a caller who did not ask for it. A
  provider that reports the count on its last event of text instead sends no
  extra event, and the caller is sent that one as it came. Per-key usage and
  `tokensPerDay` then count what the provider billed, not an estimate.

The API has to be OpenAI-shaped, or Anthropic's (below). One with another
format of its own is not reached this way. Where a provider offers an OpenAI-compatible layer beside a native
API, the layer is what this talks to, and it usually leaves things out: prompt
caching, strict tool schemas and reasoning text are common ones, and a field it
does not know is often dropped without an error. Check the provider's notes on
its compatibility layer before relying on one of those.

## Anthropic's API

`format: anthropic` on a backend makes the node speak the Messages API to it.
Callers still send and receive chat completions; the request and the answer
are rewritten on the way through, streams included.

```yaml
backends:
  provider:
    url: https://api.anthropic.com
    cloud: true
    format: anthropic
    key: env:PROVIDER_KEY
    serves: [their-model-id]
```

- The key goes out as `x-api-key` with the API's version header.
- A key that belongs to the whole organisation is refused unless the request
  says which workspace it is for. `headers` on the backend sends that with
  every call:

  ```yaml
      headers:
        anthropic-workspace-id: env:PROVIDER_WORKSPACE
  ```
- **Prompt caching is on.** Each request's system prompt, its tools and the
  conversation so far are marked as cached prefixes, so the next turn of the
  same conversation pays for them as a cache read. A cache write costs more
  than plain input, so for one-off requests with long prompts that are never
  repeated, set `promptCache: false`.
- A prefix is kept for five minutes after its last use. Where the requests of
  one conversation come further apart than that (a person who thinks before
  answering, a tool that runs for a while), `promptCacheTtl: 1h` keeps it for
  an hour, at a higher price for each write.
- Only the system messages that open a conversation become the system prompt.
  One sent later stays where it stands, as text in a user turn: moved to the
  front it would change the start of the cached prefix, and every turn after
  it would be paid for in full again.
- `usage.prompt_tokens` counts all input, cached or not, and
  `usage.prompt_tokens_details.cached_tokens` says how much was read from the
  cache. Per-key usage counts the same totals.
- A cache write is counted, and priced, as plain input. The provider charges
  more for one, and more again with `promptCacheTtl: 1h`, so the spend shown
  for a model with a `price`, and what `limits.dollarsPerDay` counts, is
  somewhat below the provider's bill.
- What is carried across: system and developer messages, text and images,
  tools, tool calls and their results, `tool_choice`, `max_tokens`
  (4096 when the request names none: this API requires one), `temperature`,
  `top_p`, `stop`, and streaming. Reasoning text comes back as
  `reasoning_content`. Other request fields are not sent.
