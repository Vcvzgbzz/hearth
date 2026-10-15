# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 3.x | Yes |
| 2.x and older | No: upgrade with `hearth migrate` |

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then
**Report a vulnerability**. Please do not open a public issue or pull request
for it.

A useful report says:

- the hearth version (`hearth --version`) and Node version
- the relevant part of `hearth.yaml`, with every key, token and password
  replaced
- what an attacker can do, from where (loopback, the LAN, a peer, the
  internet), and the requests that show it

You will get a reply once the report has been read, normally within a week,
and credit in the release notes for the fix unless you would rather not.

## Scope

hearth trusts callers by socket address and assumes a private network.
[`docs/security.md`](docs/security.md) describes what it defends and what it
leaves to the network around it. Of particular interest:

- a request from off loopback that is treated as local, or reaches the
  console's write routes without a valid key
- an api key, peer token or backend key reaching the console, a client, a
  peer or a log
- a peer using a model it was not lent, or more than its limits
- a request that reaches a backend its key is not scoped to

Running hearth behind a proxy that rewrites the source address is outside
the supported setup, as the docs explain.
