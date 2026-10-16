# Running it on a server

From the registry, `npm i -g @vcvzgbzz/hearth` on the box is the whole install.

Deploying a build of your own checkout has one gotcha, and it will bite you the
first time. `npm ci --omit=dev` **fails** in a checkout of this repo:

```
npm error command sh -c tsc
```

`prepare` is a `tsc` run, npm runs `prepare` after any local install, and
`--omit=dev` has just skipped installing typescript. That `prepare` is not
removable: it is the thing that makes `npm i -g github:Vcvzgbzz/hearth` work at
all, by building from source at install time. (Installing from the registry
never runs it, so this only shows up on a server.)

So on a box, skip the scripts and ship a build you made elsewhere:

```bash
npm ci --omit=dev --ignore-scripts
```

The package is `dist/`, `package.json` and `package-lock.json`, plus a
`node_modules` with one runtime dependency in it. Nothing else needs to be on
the machine. Build on your workstation, copy those three, install with the flags
above, restart.

Be careful with `rsync -a --delete` here. A trailing slash on `dist/` copies the
*contents*, so everything lands in the parent and `--delete` then removes the
real `dist/` and `node_modules` on its way past. The service keeps running,
because the process still holds the deleted files open, and dies at the next
restart with no clue why. Stage into a new directory and `mv` it into place
instead.

A unit that fails a bad config at deploy time rather than at 3am:

```ini
[Service]
WorkingDirectory=/opt/hearth
EnvironmentFile=/etc/hearth.env
ReadWritePaths=/etc/hearth.yaml
ExecStartPre=/usr/bin/node /opt/hearth/dist/cli.js serve --config /etc/hearth.yaml --check
ExecStart=/usr/bin/node /opt/hearth/dist/cli.js serve --config /etc/hearth.yaml
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
```

`ReadWritePaths=` is what lets console edits write your config.
`ProtectSystem=strict` leaves nothing outside `WorkingDirectory` writable, so
without it every edit is refused with a message saying the file is not writable.
Leave it out if you would rather the config were only ever edited by hand.

`--check` validates and exits, so a typo in a peer's model map stops the deploy
with a readable line. Put the peer tokens in `/etc/hearth.env` and reference
them from the config as `env:NAME`, which is also what keeps the config
committable. Note that `--check` will fail outside systemd unless you source
that env file first, since a missing token is deliberately fatal.

`Restart=on-failure` is also what brings the node back after the console's
**restart** button, which exits with status `75` for exactly that.

`TimeoutStopSec` is there because a stop is not instant any more. On SIGTERM
hearth stops accepting connections, drops the idle ones, and gives whatever is
already in flight up to `shutdownGraceMs` to finish — a chat turn mid-stream, a
render several GPU-minutes in. Anything still running when that runs out is
destroyed, and the drain says so in the log:

```
{"level":"info","msg":"drain.start","inFlight":3,"graceMs":30000}
{"level":"warn","msg":"drain.cut","abandoned":1,"ms":30001}
```

Keep the unit's stop timeout comfortably above the grace, or systemd SIGKILLs
mid-drain and the wait bought nothing. A second SIGTERM (or a second ^C) skips
the rest of the wait and exits, for when you would rather not sit through it.

A request still QUEUED is in flight too — its caller is holding the connection,
so it gets its turn if the grace allows. The queue itself is memory only and
nothing is written down, so whatever the grace does not cover is simply gone.
Pair `Restart=on-failure` with `StartLimitBurst` in `[Unit]` so a crash loop
cannot quietly eat a job every five seconds.

## Reporting a bug

```bash
hearth report --config /etc/hearth.yaml
```

writes `hearth-report-<date>.md` in the current directory: the hearth, Node and
OS versions, the config with its secrets replaced and whether it loads, and,
from the running node, `/healthz`, `/network` and the last 300 log lines.
Every secret the config resolves to, `env:` ones included, is replaced
wherever it appears, log lines too. Hostnames, addresses and model names are
left in, so read the file before attaching it. As with `--check`, source the
env file first, or the config will not load and the node's half is left out.
The node is asked over loopback; `/network` uses one of the config's unscoped
keys when it has any. The console's Logs page has a **bug report** button that
downloads the same file from the running node.
