# The console

The page at `/ui`: what it shows, and how the config is changed from it.

## The status page

`http://127.0.0.1:4141/ui`, once `hearth serve` is running. React and Tailwind,
compiled to one file at build time and inlined into the page, so it is still a
single response and still adds **nothing** to what `npm install` pulls down —
the browser half is bundled from devDependencies and the package keeps its one
runtime dependency.

Seven pages, and ⌘K (Ctrl+K) jumps between them and to anything on Topology:

- **Topology**: this node, its backends, the hardware they share, and its peers,
  with requests drawn as they flow, over a strip of the last ten minutes. Click
  anything for its details and controls. A **Router** under the node stands
  between it and everything that can run a request, peers on one side and
  hardware on the other; it is the node the Routing page starts from, and a
  click opens that page. With callers wired to routers of their own, the node
  is a frame holding its callers, boxed by the router each goes by, and every
  router's line meets at one point that the peers and hardware hang off.
  **Right-click a caller** to say which router its requests go by, or to make
  a new router for it; that joins the routing draft. For a key the same menu
  rotates or revokes it, and a right-click anywhere in the frame mints a new
  one from a label. Those three are written at once, as on the Keys page, and
  a new key is shown once over the page. **Drag a box of callers** along the
  row to stand it somewhere else among the others; the order joins the draft
  and is kept with the layout.
  A right-click on the empty part of the picture offers what the strip over it
  does, where the pointer is: a new backend, hardware, machine or provider, the
  published versions, and fitting the picture in view.
- **Routing**: every model name, the rules some pass through, and where each
  ends up, as a map you edit. See [Editing on the graph](#editing-on-the-graph).
- **Models**: every model on one row: which nodes hold it, whether it is loaded
  anywhere, and whether you are lending it. `/network` is always one node's
  view; this is all of them at once. A model served here can be warmed or
  evicted from its row.
- **Keys**: every api key by label, what it may run, its limits and expiry,
  what it used today and over 31 days, and when it last spoke to this node. Mint one (shown once), revoke one by its label, or rotate one: a new key for the same label, shown once, with the old one refused from then on.
- **Queue**: jobs in flight, and finished requests per model with how long they
  waited and ran, over the last ten minutes or the last day; a row opens to
  its individual calls. The day view adds
  a chart of requests per 15 minutes, failures in red, with queue depth behind.
- **Logs**: hearth's recent log lines as sentences, newest first, with a level
  filter, a model filter, a search, and the raw fields a click away.
- **Config**: `hearth.yaml` by section, or as text. See below.

The live view is 120 samples taken every 5s. The day view and the Logs page are
held in memory and lost on restart unless `historyFile` names a file to keep
them in:

```yaml
historyFile: /var/lib/hearth/history.json
```

It is written every minute and at shutdown, and read once at startup. Under
systemd, `StateDirectory=hearth` makes `/var/lib/hearth` writable. The full log
is still whatever captures stdout, journald usually; the page shows the tail.

### Changing things from the page

Besides the config editor, the Topology and Models pages change three things
directly:

- **lending** and **borrowing**, the two directions of federation, as separate
  switches. These two are operational: they apply at once and a restart clears
  them. Pausing lending empties what you lend, so peers see a healthy node
  offering nothing and stop choosing you, rather than a wall of 403s that looks
  like a revoked token. Pausing borrowing removes peers as routing candidates,
  so a flow that ends in `refuse` once no peer can take it refuses cleanly.
- **lent / held per model**, written into `lending.models`. You can hold back one
  model without pausing the rest, or lend one the file never listed. A model no
  backend here serves is refused — advertising it would 404 every request, and
  the peer's operator cannot tell that from a broken link.
- **the Lending page**: the limits a new peer starts with, then one row per
  peer with its own [limits](sharing.md#limits-per-peer) to change in place
  (the models it may run, tokens a day, jobs at once, requests an hour), a
  switch that stops lending to it alone, what it used today, and what was lent
  and borrowed over the month kept. A peer's name opens its use by model and
  by day. A limit a peer does not have of its own is drawn dim, and one it
  has can be put back to the node's. Each change is written to `hearth.yaml`
  and applies at once. The same counts are on each peer in Topology, and the
  Models page names the peers a model is lent to by a list of their own.
- **link / unlink** on a peer's model map, which writes both halves at once: the
  mapping and a flow that uses it. Unlinking takes every step that sent the
  model to that peer, and the flow with them once it has nowhere left to send
  anything. A mapping on its own is only an allowlist entry, and a link without
  a flow is a model that looks reachable and quietly runs at home forever. A
  model you also serve starts as "whichever would start it soonest, here or
  there"; one you do not starts as "that peer, else refuse", since home is a
  backend that has never heard of it. A model a flow already takes keeps its
  flow, which gains the peer. Change any of it on the Routing page.

### Editing the config from the page

Each section lists its entries as cards. A setting's description shows while it
is focused. **add setting** searches every setting the entry can take, including
those inside a group (`stats.vision`), and goes to one that is already set.
Click an entry's name to rename it; the rename changes only the key, so its
comments and layout stay. Nothing is written until **review & save** has shown
the diff and said whether it applies live or needs a restart.

When a change is waiting for a restart, the header offers **restart**. hearth
finishes what is in flight, then exits with status `75` so a supervisor that
restarts on failure (systemd's `Restart=on-failure`) brings it straight back,
and the page reconnects. Without such a supervisor it only stops.

### Editing on the graph

The **Routing** page is a map of the routing you have set up, and it is where
you change it. It shows only that: the names you send somewhere other than
their own model, the rules they pass through, and the models and peers those
end at. Every other name goes to its own model, which the node says in one
line; **+ type** brings one onto the map.

- **The Router lists your types**: the names callers may ask for. **+ type**
  adds one of your own (`LLM`, `ImageGen`) or offers a model under its own
  name. The line under them says what becomes of any other name, and a click
  changes it between "refuse it" and "run it as itself".
- **A name's dot** is where its line starts. Drag it onto another model or a
  peer to send requests for that name there, onto a rule to have the rule
  decide, or back onto its own model to undo. **A new type…** under **+ type**
  adds one nothing serves yet, such as `auto`; it exists once it has been sent
  somewhere.
- **+ rule** adds a routing rule: a flow drawn as a box whose lines read as
  sentences, `If … send to …`, ending in `Otherwise …`. Start from a common
  one (borrow an idle model, send images or long prompts somewhere else, stay
  off a busy model, give one caller its own model) or from a blank. A new
  rule is left on the map, picked out and in view; its pencil opens it to be
  edited line by line.
- **A line's conditions are changed where they stand.** Click the sentence a
  line reads as, or **choose a condition** on a new one, and its conditions
  open in the box; the line's first word closes them again. Under a heading
  that several lines share, what opens is the line's own conditions, and the
  shared one stays with the heading. The dialog, from the rule's pencil or
  **Edit this line…** in a line's menu, is for the rest: its lane, the request
  fields it sets, and the rule's own settings.
- **A line that cannot work is not drawn.** Routing decides chat requests, so
  a name whose backend takes its requests on paths of its own (image
  generation and the like) is marked **not chat** and has no dot, and a chat
  line cannot end on such a model. A rule that takes one of those paths (its
  **It takes**) may send to any model here, and never to a peer. A line for
  requests with images, with tools
  or over a size is refused when its target is known not to take them, with the
  reason. What a model takes is what you declare under `models.<id>.stats` or
  what it reports once loaded; a model that has said nothing is not refused,
  and its line carries a **?** until it has.
- **+ action** adds something a line sets off beside sending the request on: a
  log line, or a call to a URL. Drag a line's dot onto the action, or pick it
  under the line's **⋯**, and a dashed line shows what runs it. See
  [Actions](routing.md#actions).
- **Drag a box** to arrange the map; it lands on a grid. Where you put things
  is saved with the rest, under `layout:`; **tidy up** goes back to the
  automatic arrangement. What you have not placed fits itself around what you
  have: a model sits level with the lines that reach it, rules stand in the
  order of the names that enter them, and a box that would lie on another is
  drawn below it. Boxes that only touch are left where you put them.
- **+ type** takes a name typed straight into it. Drawn onto a model that is
  not chat, a new type takes the paths that model answers on.
- **A type's ⋯** on the Router (it shows as you point at the name) renames it,
  moves it up, down, to the top or to the bottom, or removes it; dragging a
  type's name onto another's place moves it there; double-clicking the name
  renames it too. The new name follows into the rule that takes it. The order
  is kept with the layout.
- **Try a request** along the bottom asks the node where a request would go
  under the map as you have it now, saved or not, lights the way it takes and
  names the line that decided. **pretend…** lists the state your rules test
  that cannot be arranged on demand (a model idle or just used, full, loaded,
  needing a swap, its hardware held, a line at its limit, a time of day, a
  caller, a lane) so each line can be tried.
- **A model's box carries the hardware it runs on** as a small tag, and so does
  each model in the list of places to send a line, so two copies of one model
  (one on a card, one on the CPU) are told apart at a glance.
- **Dots and lines are coloured** by what they are plugged into: green for a
  model here, violet for a peer, pink for a provider's model, blue for a rule,
  teal for the fastest of several or several in order, red for a refusal, amber
  for an action, grey for nowhere yet. The "?" beside the buttons shows each
  colour beside what it means.
- **Then try…** in a line's menu gives the line somewhere to go when the place
  it names fails before it answers. The line then ends at an **in order** node:
  the places to try, first to last, each with its own dot. **then try another**
  adds a place, the arrow tries one sooner, and the × takes one out; with one
  place left the node goes and the line names that place again. In the file it
  is a rule no name enters whose lines test nothing, and any such rule is drawn
  this way. It is clicked, copied, pasted and deleted like a rule, a line's dot
  can be let go on it, and several lines can share one. A request that failed
  on a model here is only moved to another model here, so a peer placed after
  one is marked as not reached.
- **find** (or the `/` key) searches the map for a rule, an action, a name or
  a model and brings it into view. **Right-click** the map to add a rule or an
  action there, or a rule or an action to edit it, duplicate it, switch it off
  or delete it.
- **Keys**: with a rule or an action selected, Delete or Backspace removes it,
  Ctrl/⌘+D makes a second one, and Ctrl/⌘+C then Ctrl/⌘+V pastes a copy. A
  copied rule takes no names until you give it some. Ctrl/⌘+Z undoes and
  Ctrl/⌘+Shift+Z redoes, across routers and both pages; Escape closes the panel. A rule
  and an action also carry a bin of their own.
- **Several at once**: hold Ctrl/⌘ and drag across the map to draw a box round
  nodes, or Ctrl/⌘+click to add one or take it out. What is picked out wears a
  ring and moves as one. Delete, Ctrl/⌘+D and copy and paste then act on every
  rule and action among them, as one change, and the copies land beside the
  originals already picked out. A model, a peer or a refusal is moved with the
  rest and otherwise left alone. Escape or a click on the map lets go.
- **?** beside the buttons says what each thing on the map means. A rule or an
  action is renamed by clicking its name, on the map or where it is edited, and the
  name follows everywhere it is used.
- **A number at the end of a line** is how many requests it has decided since
  the rules last changed or the node started.
- **In a rule's panel**: switch it off without deleting it, keep a conversation
  on the model it started with, and leave a note on what it is for.

What you edit is a draft: nothing is written and nothing about routing changes
until you publish it. The strip along the top counts what the draft changes and
says what still needs attention; **undo** steps back, **discard draft** drops
it, and **review & publish** shows the change to the file as a diff, checks
that it loads, and writes it only when you confirm. The node keeps the draft
beside the config file (`<file>.draft.json`), so it is there the next day and
from another browser, and if the file changes underneath it your changes are
carried over.

A publish can be given a name. **versions** lists what has been written through
the node, newest first, with the file as it stood before the first change;
picking one shows what going back would change and writes it on confirm. The
last 50 are kept in `<file>.versions.json`, with the same permissions as the
config file since they are copies of it. A hand edit to the file is not a
version.

The **Topology** page is the other picture: the machines, hardware and
backends, and the requests in flight. The strip over it adds a backend,
hardware, a machine or a provider, as a draft that is reviewed and published
like a routing change; the Config page edits the same settings as forms.

### Where changes go

`hearth.yaml` is the only config state. Every change from the console or the API
is written into that file as it is made — comments and layout intact — and the
running node follows the file. There is no save step and nothing to sync.

Unlinking a peer's last model is fine, and so is a peer that maps nothing —
that is simply the state between deciding to trust someone and deciding what to
borrow. Their url, token and your notes stay where they are, and the console
still lists everything they serve, so borrowing again is a click. **Deleting** a
route or a mapping takes its comments with it, because they belong to the thing
being deleted.

Most of the config applies as soon as it is written: models and routes, sharing,
notes, peers' model maps, api keys and peer tokens, and the deadlines and limits
read per request. The rest — listen addresses, backends, servers, resources, lanes, and
adding or changing a peer — is written immediately but takes effect on the next
restart, and the console lists those keys until then.

Hand edits work the same way. hearth watches the file and loads an edit as soon
as it is saved; an edit that does not load is reported with the reason, and the
node keeps running the last config that did. A change from the console always
builds on the file as it is on disk, so it never overwrites an edit made in an
editor.

A write is refused, and the file left untouched, when:

- the result fails validation — the error names the field
- the file is not writable
- with `PATCH /config`, the part being edited changed on disk since it was read

Under `ProtectSystem=strict` the unit needs to say the config is writable — and
must not also say the opposite, which is easy to miss because both lines look
like hardening:

```ini
ReadWritePaths=/etc/hearth.yaml
ReadOnlyPaths=/opt/hearth /etc/hearth.env   # NOT the config as well
```

`ReadOnlyPaths` wins for a path named in both, silently. Only the file needs to
be writable, not `/etc` — hearth writes in place when it cannot stage a temp
file beside the config, which is exactly what that pairing produces.

### Editing the file over HTTP

`GET /config` returns the file's text, a `hash`, and its status: `restartPending`
and, if the file on disk does not load, `error`. `PATCH /config` edits it:

```bash
# set or delete paths; anything the edit did not touch may have changed meanwhile
curl -X PATCH localhost:4141/config -H 'content-type: application/json' \
  -d '{"baseHash": "<hash>", "ops": [{"path": ["backendDefaults", "idleMs"], "value": 300000}]}'

# replace the whole file; refused with 409 unless baseHash is current
curl -X PATCH localhost:4141/config -H 'content-type: application/json' \
  -d '{"baseHash": "<hash>", "text": "..."}'
```

An op can also rename a map key in place, keeping its value and comments:
`{"path": ["peers", "old-name"], "rename": "new-name"}`. Renaming onto a name
that exists is a 400, and renaming something that is not there is a 409.

Add `"dryRun": true` to see the resulting text without writing it. A refusal is
`{"error": {"message", "path"}}`: 422 for a config that would not load (with the
field), 409 for a conflict.

### The console

`/ui` is open to anyone who can reach the port, but it is only a shell: every
byte of data comes from `/ui/data` and `/ui/events`, and those answer loopback
or a signed-in operator. **An api key does not open them.** A browser cannot
send a bearer token on an `EventSource`, and the alternatives are worse: a key
in the query string ends up in logs and history.

From loopback the console needs nothing, and on a node with no login it offers
to create one. From anywhere else the address alone is enough to reach the page
(`http://<host>:4141` redirects to `/ui`), but creating the first login is taking
the node, so it is done on the machine itself: in the console there, or from the
shell:

```bash
hearth set-operator admin 'a long passphrase'   # writes operator: {user, passHash}
```

Either way the page then asks for it. A changed login applies without a restart and
signs every existing session out. A session is an HttpOnly, SameSite=Lax cookie that
slides for 30 days and lives in memory, so a restart signs everyone out. It is a
full local identity — `/control`, `/config` and the passthrough included — so
treat the password like an unscoped api key. Failed logins are throttled per
user and per address, and an unknown user costs the same scrypt as a known one.

The console is on the main port, so it is reachable wherever that port is. Bind
it to a tailnet address rather than a LAN one, and never put a proxy in front of
hearth: it decides local trust by source address, and a proxy makes every
caller look like loopback.

## The page is pushed, not polled

`/ui/events` is an SSE stream: one `snapshot` frame with the whole payload,
then a `patch` frame whenever something changes.

```
event: snapshot
data: {"net":{...},"q":{...},"hist":[...120 samples...],"histKeep":120,...}

event: patch
data: {"set":{"q":{...},"calls":[...]},"add":{"hist":[{...one sample...}]}}
```

The poll it replaces asked for 95KB every three seconds, and **93% of that was
history the page already had** — 120 samples, of which 119 were unchanged. New
samples now arrive one at a time, and a node with nothing happening sends
nothing at all.

A patch is a diff of the same object `/ui/data` serves, built by the same
function, so the two transports cannot drift: add a field and both carry it.
`operator` is the exception — it describes the connection rather than the
node, so it is stamped on the snapshot and never repeated.

`/ui/data` is unchanged and is still there. EventSource is the one transport an
extension or a proxy can break in a way that looks like silence, so a stream
that has not delivered a snapshot within ten seconds is abandoned and the page
goes back to polling exactly as before. An error *after* the first snapshot is
left to EventSource's own retry — a node restarting is the common case — and
only marks the page stale.

The stream is deliberately not counted as a request in flight, so a page left
open in a tab cannot hold a shutdown open for the whole `shutdownGraceMs`.
Streams are ended first when the node stops, so the browser starts retrying
straight away.
