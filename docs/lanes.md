# Lanes

Lanes are how you say what matters. Each one has a priority, lower dispatches
first, and a job earns priority the longer it waits so nothing starves.

```yaml
scheduler:
  lanes:
    chat:  { priority: 0 }     # a person is watching this
    batch: { priority: 100 }   # a render nobody is waiting on
```

Pick one per request with a `lane` field in the body. It isn't part of the
OpenAI schema, so hearth strips it before the request reaches your backend:

```json
{ "model": "big-model", "lane": "batch", "messages": [...] }
```

Leave it out and the request lands in the first lane you declared.

Peers don't get to choose. Borrowed work is pinned to `lending.lane`, which defaults
to your lowest-priority lane. Lanes express the host's priorities, and a guest
doesn't get a vote in them.

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
