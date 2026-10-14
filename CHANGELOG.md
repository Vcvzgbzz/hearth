# Changelog

## 3.0.0

The last release was 1.1.0. This one changes how routing is written, so read
"Upgrading" first.

### Upgrading from 1.x

**Routing moved out of `models:` and into `flows:`.** `policy`, `peers`,
`spilloverAt` and `fallbackLocal` on a model are gone. A file that has them is
refused at startup with a message that says so.

```bash
hearth migrate            # rewrites hearth.yaml in place, and keeps the old one beside it
hearth serve --check      # says whether the result loads
```

`migrate` writes each model's routing as a flow that behaves the same (a
`spillover` model becomes "here while fewer than N are queued, then the peer,
then here"), and adds a flow that runs every other name as itself, which is
what 1.x did. The file as it was is kept as `hearth.yaml.before-migrate-<date>`.

Other things that behave differently:

- **Only a name a flow takes can be asked for.** The flow with `inputs: ["*"]`
  says what becomes of every other name; `migrate` writes one that runs them as
  themselves. Without it the config is refused.
- **The first console login is created on the machine itself**, in the console
  there or with `hearth set-operator`. From another machine it takes an
  unscoped api key; before, anyone who reached the port could create it.
- **On the machine itself, the node answers at `localhost` or an IP address.**
  A request from loopback that asks for it by any other name is refused, which
  includes a name pointed at `127.0.0.1` in a hosts file.
- **Cookies do not cross the passthrough**, to a backend or back from one.
- **The package exports what embedding needs**: `loadConfig`, `parseConfig`,
  `ConfigError`, `createNode`, `createLogger`, `silentLogger` and their types.
  The scheduler, pool, peer registry and the rest are no longer exported.

Nothing changed for clients: `/v1/chat/completions` is as it was, `/v1/models`
gains the `object` and `owned_by` fields the OpenAI API has, and every answer
now also carries `X-Request-Id`.

### Routing

- **Flows.** What can be asked for, and where each request goes, as a short list
  of lines tried top to bottom. A line can test the size of the prompt, images,
  tools, a header, the caller, the lane, the time of day, and what is loaded,
  free, idle or held. See [Routing](docs/routing.md).
- **Types and variants.** A flow can take a name of your own (`chat`) and its
  variants (`chat:fast`), so clients ask for a kind of work and never for a
  model.
- **Routers.** A rulebook of its own for some callers.
- **Fastest of several, and places tried in order.** One name spread over
  several backends, and somewhere to go when a model fails before it answers.
- **Actions.** A log line or a webhook set off by the line that decided.
- **A backend that keeps failing is rested.** After three failures in a row a
  request with another line that fits goes straight there for a while.
- **A flow can take a backend's own path**, not only chat.

### Lending

- **Limits per peer.** `peers.<name>.lend` restates any of `lending.*` for one
  peer: its own `models`, `maxConcurrent`, `rateLimit` and `tokensPerDay`.
- **Tokens a day.** `lending.tokensPerDay`, for every peer or for one. A peer
  that has used them is shown a node that lends it nothing, and a `429` if it
  asks.
- **Lent and borrowed.** Requests and tokens per peer, each way, over the
  month usage is kept: `GET /lending`, and on each peer in the console.
- **A Lending page** in the console: each peer's limits changed in place, a
  switch to stop lending to one peer (`lend: { off: true }`), and its use by
  model and by day.

### Providers

- **Cloud backends.** A provider's OpenAI-compatible API as a backend, with its
  key, so a rule can send some requests out and keep the rest home. See
  [A provider's models](docs/providers.md).
- **Anthropic's Messages API**, with prompt caching on by default and
  `promptCacheTtl: 1h` for conversations whose requests come more than five
  minutes apart. Callers still send and receive chat completions.
- **Prices.** A model can carry a price per million tokens, with one of its own
  for input read from a prompt cache; usage is then shown as spend.

### Keys

- **A Keys page**: mint, rotate and revoke from the console.
- **Usage per key**, per model, per day, kept for 31 days: `GET /usage`.
- **Limits and expiry**: requests a minute, tokens a day, dollars a day, and a
  last day.
- **Scopes can name a type**, so a key can be held to `chat` in any variant.

### Console

- **A Routing page**: the rules as a map that can be edited by hand, with
  search, undo, drafts the node keeps, and named versions to go back to.
- **A Topology page** that can be edited: callers and the routers they go by,
  hardware, machines, peers and providers.
- **Review before anything is written**: what changes in plain words, the diff,
  and what needs a restart.
- **Models, Queue and Logs pages**: warm and evict a model, each call behind a
  model's numbers, and the log filtered by model.

### Security

- **A page elsewhere cannot make itself the node's own origin** by re-pointing
  its name at `127.0.0.1`, and `Origin: null` is refused on writes like any
  other foreign origin.
- **The console is sent with a content security policy** and cannot be framed.
- **A secret's stand-in is honoured only where a secret is kept**, so it cannot
  be typed into another setting to read the secret out. The headers an action
  or the canary sends a webhook are masked like the other secrets.
- **A key held to a type does not reach a separate flow** that happens to share
  its prefix.

See [Security](docs/security.md).

### Also

- **`hearth.yaml` can say its layout**: `version: 3`, written by `hearth init`
  and `hearth migrate`. A file from a later hearth is refused by name instead of
  being half-read.
- **An open console reloads itself** when the node restarts into another build.

- **The canary can watch a followed id only while it goes out as one named
  model** (`onlyAs`). See [Canary](docs/canary.md).
- **An app that is not scheduled can hold its card** against named lanes.
- **A model can keep its answers** for identical requests.
- **`hearth --help` and `--version`.**
- **A demo**: `npm run demo` in a clone starts a node with one of everything and
  stand-ins behind it.
- The README is the pitch and an index; the reference is under [`docs/`](docs/).
