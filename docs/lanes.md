# Lanes

Lanes are how you say what matters. Each one has a priority, lower dispatches
first, and a job earns priority the longer it waits so nothing starves.

```yaml
scheduler:
  lanes:
    chat:  { priority: 0 }     # a person is watching this
    batch: { priority: 100 }   # a render nobody is waiting on
```

A priority may be negative. Below zero is simply nearer the front than a lane
at zero, so a lane you want ahead of every other is `priority: -10` rather than
a new convention: nothing sorts lanes by name or position, only by the number.

Pick one per request with a `lane` field in the body. It isn't part of the
OpenAI schema, so hearth strips it before the request reaches your backend:

```json
{ "model": "big-model", "lane": "batch", "messages": [...] }
```

Leave it out and the request lands in the first lane you declared.

Peers don't get to choose. Borrowed work is pinned to `lending.lane`, which defaults
to your lowest-priority lane. Lanes express the host's priorities, and a guest
doesn't get a vote in them.

A lane is also the unit the Scheduler page works in: one row per lane, with
what is running, queued and held in it. See [The console](console.md#the-status-page).

## A ceiling for a lane

Priority orders the queue. It does nothing about a slot that is free, and
nothing is ever preempted, so on a seat that batches a low-priority lane takes
every slot nobody is using right now and keeps it until its call ends. Work that
arrives in bulk — a memory service summarising each finished chat, a nightly
re-index — ends up sharing the card with the people it was ranked below.

`concurrency` on a lane is the most of a backend's slots that lane may hold at
once:

```yaml
scheduler:
  lanes:
    chat:   { priority: 0 }
    memory: { priority: 100, concurrency: 2 }   # never more than 2 slots of any backend
```

It is a maximum, not a reservation: sixteen chat turns still take all sixteen
slots, and `memory` waits for one like anybody else. A job held back by its
lane's ceiling is passed over rather than waited on, so it never holds up the
lanes behind it, however long it has aged. Leave it off and the lane has no
ceiling of its own, which is how every lane behaved before. Off-box jobs hold no
local slot and are not counted. The ceiling is per backend: `concurrency: 2` on a
node with two backends lets the lane hold two slots on each.

## Changing lanes

Lanes, their priorities and ceilings, `maxWaitMs`, `agePerSecond`, `warmBonus`,
`maxPerLane` and `maxPerCaller` apply as soon as the file changes, with no
restart. Jobs already waiting are ordered again under the new values. A lowered
ceiling drains: nothing running is stopped, and the lane starts nothing more
until it is back under it. `maxWaitMs`, `maxPerLane` and `maxPerCaller` reach
jobs that arrive after the change; a job already waiting keeps the timer it was
queued with. A job waiting in a lane you removed still runs, from the back of
the queue: it sorts at priority `1000` with no ceiling of its own.

Three lane settings are read once, when the node starts, so they wait for a
restart: a backend's `concurrency`, the lanes a backend's `hold` keeps off its
hardware, and the lane a backend's route runs in. Everything else about a lane
is live, and the Scheduler page marks each setting either `live` or `restart` so
the line is visible where the number is edited.

Lanes move borrowed work with them. `lending.lane` unset means the
lowest-priority lane (the highest number, `warm` aside), worked out on every
load, and a backend route that names no lane is given the same one. Add a lane
with a higher number than the one peers land in and their work moves there at
once, when `lending.lane` is unset; the routes keep the lane they were given
until a restart. Naming `lending.lane` pins borrowed work to that lane, so no
lane moves it after that.

The Scheduler page shows all of this over the live queue, and is where these
settings are edited: [The console](console.md#the-status-page).

