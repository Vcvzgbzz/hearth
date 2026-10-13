# Development

Embedding it instead of running the CLI:

```ts
import { loadConfig, createNode, createLogger } from "@vcvzgbzz/hearth";

const cfg = loadConfig("hearth.yaml");
const node = createNode(cfg, createLogger("info"));
node.start();                       // watch the backend, poll peers
node.server.listen(cfg.listen.port, cfg.listen.host);
// later: await node.close();
```

The package exports `loadConfig`, `parseConfig`, `ConfigError`, `createNode`,
`createLogger` and `silentLogger`, with the types `HearthConfig`, `HearthNode`,
`Logger` and `Level`. Those are kept working across a major version. What a
node carries besides (`node.pool`, `node.peers`, `node.history`) and anything
imported from a file inside the package is its own machinery and can change in
any release.

`start()` isn't optional. Skip it and the node still answers requests, but it
never learns what's loaded and never marks a peer up, so it routes everything
locally. Which looks exactly like working.

[`test/server.test.ts`](../test/server.test.ts) stands up several nodes and fake
backends in one process and asserts the claims a user would actually make: it
ran on their GPU, it streamed back, it didn't queue behind my own work, the
failover was invisible and still went through the queue, and they can't reach or
even enumerate a model I didn't offer.

[`test/backpressure.test.ts`](../test/backpressure.test.ts) covers one specific
way this used to fall over: a client that hangs up while the response is
backpressured. That leaked a scheduler slot, and at `concurrency: 1` it wedged
the whole node until restart without logging a thing.

[`test/ui.test.ts`](../test/ui.test.ts) binds a node to every interface and knocks
on `/ui/data` from this machine's own LAN address, with a valid api key, to prove
the gate holds anyway. It skips itself on a host with no routable
interface rather than pretending to have checked.

The page lives in [`src/console/`](../src/console/) as ordinary `.tsx`.
[`src/ui.ts`](../src/ui.ts) is only the HTML shell, and it reads
`dist/console.js` and `dist/console.css` in at import time. So `npm test`
builds the browser half first (`pretest`), and `npm run typecheck` checks it
against [`tsconfig.ui.json`](../tsconfig.ui.json), which is also the tsconfig
esbuild is pointed at: the JSX setting has to be one fact, or the bundle
compiles against a runtime that is not there and the page renders blank.

## Notes for the curious

Two decisions did most of the work here, and I got both of them wrong first.

**Don't use `fetch`.** Node's undici caps time-to-first-header at 300 seconds,
and an inference server sends nothing until it starts generating. A cold load
past five minutes dies as `TypeError: fetch failed` while your own timeout, the
one you meant, never fires. [`src/upstream.ts`](../src/upstream.ts) uses
`node:http`, where the caller's signal is the only deadline.

**Ask peers, and ask when it matters.** Never infer health from an open socket.
A TCP forwarder keeps listening after the far end dies and just closes each
connection, which looks perfectly healthy to anything that only checks whether
it can connect. hearth asks for capacity and requires an answer.

It asks on demand rather than on a timer, because routing is the only thing that
consumes peer state, and something needed when asked should be fetched when
asked. A timer spends requests whether or not anyone is using the thing, and
still hands the decision a reading a whole interval old. Three guards keep that
from costing more than it saves: a good reading is reused for `borrowing.freshMs`,
concurrent requests coalesce onto one probe, and a failure is remembered for
`borrowing.downMs` so a broken peer can't make your local requests slower. An idle
node makes no peer traffic at all.

Unknown always means local. A probe that doesn't answer in time is unknown.
