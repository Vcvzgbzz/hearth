# Security

The defaults assume a private network: Tailscale, WireGuard, a LAN you trust.

- Binds to `127.0.0.1`. Widening it is deliberate, and you get a warning at
  startup if you widen it without setting `apiKeys`.
- With no `apiKeys`, loopback is the only thing trusted. A request from anywhere
  else, or one carrying a credential that isn't valid here, gets refused rather
  than waved through as "local".
- Lending is opt-in per model, and peers are rate-limited by request count.
- A `cloud` backend is the one place a prompt leaves your network for a party
  that is not a hearth you chose to trust. It is used only where your config
  names it, and its `key` never reaches the console or a client.
- Peer tokens are separate from api keys, so peer traffic is attributable.

## Writes refuse a cross-origin browser

Loopback is this node's whole notion of local trust, and a browser tab is on
loopback. So any page you happen to be visiting could POST here — no preflight
needed, and the attacker not being able to read the reply does not matter when
the damage is the request. Running hearth on the machine you browse with, or
tunnelling its port to it, puts hearth on that browser's loopback.

So any write carrying an `Origin` that is not this node's is refused. curl, the
peer protocol and a server-side app all send no `Origin` and are unaffected, and
there is no legitimate browser client on another origin to break: without CORS
headers it could never read a reply anyway.

## Do not put a proxy in front of it

This one is worth more than the rest of the section put together, because the
obvious way to expose hearth over Tailscale silently defeats its main gate.

hearth decides whether a caller is trusted from the socket's source address. Put
anything in front that rewrites it — `tailscale serve`, userspace-mode
`tailscaled`, nginx, a container port-forward — and **every request arrives
looking like `127.0.0.1`**. With no `apiKeys` set, loopback is trusted without a
token, so an anonymous stranger is promoted to a trusted local caller.

Measured against a real node in that configuration, with one model shared:

| request | result |
|---|---|
| valid peer token, shared model | 200 |
| valid peer token, **unshared** model | 403 |
| wrong token | 401 |
| **no token at all** | **200, any model in the catalogue** |
| **no token, `/ui/data`** | **200** |

A peer holding a valid token is still gated correctly — the token is checked
before the address, so `lending.models` holds. The hole is the unauthenticated case: it
needs no credential, and it reaches `/v1`, `/queue`, `/network`, the passthrough
and the status page.

If you front hearth with Tailscale, use **kernel mode with userspace networking
disabled, and `serve` off**, so the real peer address survives. If you need a
proxy anyway, set `apiKeys` — that removes loopback's free pass, since a key is
then required from everyone.

There's no TLS here and no defence against a determined attacker. Don't put this
on the public internet. If you must, terminate TLS in front of it, set `apiKeys`,
and lower `lending.rateLimit`.

Prompts sent to a peer leave your machine and land in their logs. The startup
line names every model that can leave and every model you accept, so that fact
sits in your journal instead of being buried in a config file.
