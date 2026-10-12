# The demo node

A hearth node with one of everything, and nothing real behind it. It is for
looking at the console, and for trying a rule or a setting, without a GPU or an
inference server.

```bash
npm install
npm run demo
```

Then open <http://127.0.0.1:4300/ui>. The console asks for a key before it
lets you change anything: `demo-app`.

| file | what it is |
|---|---|
| `hearth.yaml` | the node's config: three cards, a second machine, a CPU, an image app, two cloud providers, a peer, types with variants, a router of its own for guests, keys with limits and prices, actions and a canary |
| `friend.yaml` | the peer: a second node that lends one model and borrows one |
| `backends.mjs` | stand-ins for every server the two nodes front. They answer in the right shapes, slowly enough to queue, and run no model |
| `traffic.mjs` | a handful of callers sending the kinds of request the rules tell apart |
| `run.mjs` | starts all of the above; `--quiet` leaves the callers out |

Things to try:

```bash
# A type, and a variant of it.
curl -s http://127.0.0.1:4300/v1/chat/completions -H "Authorization: Bearer demo-app" \
  -H "Content-Type: application/json" -d '{"model":"chat:fast","messages":[{"role":"user","content":"hi"}]}'

# The same variant goes to a provider, unless the request says to stay home.
curl -s ... -d '{"model":"chat:best", ...}'
curl -s ... -H "x-stay: local" -d '{"model":"chat:best", ...}'

# What each key has used, and what it cost.
curl -s http://127.0.0.1:4300/usage -H "Authorization: Bearer demo-app"
```

Every key, token and price in these files is made up, and every address is
this machine's.
