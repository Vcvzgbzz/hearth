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

Nothing changed for clients: `/v1/chat/completions` and `/v1/models` are as
they were, and every answer now also carries `X-Request-Id`.

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

### Providers

- **Cloud backends.** A provider's OpenAI-compatible API as a backend, with its
  key, so a rule can send some requests out and keep the rest home. See
  [A provider's models](docs/providers.md).
- **Anthropic's Messages API**, with prompt caching on by default. Callers still
  send and receive chat completions.
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

### Also

- **The canary can watch a followed id only while it goes out as one named
  model** (`onlyAs`). See [Canary](docs/canary.md).
- **An app that is not scheduled can hold its card** against named lanes.
- **A model can keep its answers** for identical requests.
- **`hearth --help` and `--version`.**
- **A demo**: `npm run demo` in a clone starts a node with one of everything and
  stand-ins behind it.
- The README is the pitch and an index; the reference is under [`docs/`](docs/).
