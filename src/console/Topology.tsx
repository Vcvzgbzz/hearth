/**
 * Where things run: peers, this node, and the machines and hardware its backends sit on, with a
 * dot for each request in flight. Watched, not edited, but for one thing: which router a
 * caller's requests go by, set by drawing a line from the caller to it. Where requests go
 * after that is Routing.tsx.
 */
import {
  applyNodeChanges, Background, BaseEdge, Controls, getBezierPath, Handle, Position, ReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";
import { CircuitBoard, Cloud, Cpu, Flame, Globe, KeyRound, Monitor, Plus, Redo2, RotateCcw, Save, Server, Split, Undo2, Users, Waypoints } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Backend, Node as NetNode, Resource, UiData } from "./types.js";
import { NEW, NewDialog, Refs, refsOf, Review } from "./config.js";
import { callersIn, draftView, EVERYONE, list, obj, put, routerFor, usersOf, withCaller } from "./draft.js";
import { change, chooseAt, dirty, edits, follow, loadDraft, redo, revert, review, showRouter, undo, useEdit } from "./editStore.js";
import { Menu, VersionsButton } from "./editor.js";
import { control, go, request, restartNode, select, toast, useStore } from "./store.js";
import { Button, cx, Dialog, Dot, type Tone } from "./ui.js";

/** `tags`: hardware a backend uses besides the group it sits in. `tip`: what the status dot is saying. */
type Card = { title: string; sub: string; tone: Tone; icon: ReactNode; meter?: [number, number]; busy?: boolean; selected?: boolean; tags?: string[]; tip?: string };

const CardNode = memo(function CardNode({ data }: NodeProps<Node<Card>>) {
  return (
    <div className={cx(
      "w-[200px] rounded-xl border bg-panel px-3 py-2 shadow-sm transition-colors",
      data.selected ? "border-accent ring-2 ring-accent/25" : "border-line hover:border-dim/40",
    )}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex items-center gap-2">
        <span className="text-dim">{data.icon}</span>
        <span className="truncate font-medium">{data.title}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {(data.tags ?? []).map((t) => <span key={t} className="rounded border border-dashed border-line px-1 text-[10px] uppercase text-dim">{t}</span>)}
          <span title={data.tip}><Dot tone={data.tone} pulse={data.busy} /></span>
        </span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-dim" title={data.sub}>{data.sub}</div>
      {data.meter && data.meter[1] > 1 && (
        <div className="mt-1.5 flex gap-0.5" title={`${data.meter[0]} of ${data.meter[1]} slots busy`}>
          {Array.from({ length: Math.min(data.meter[1], 16) }, (_, i) => (
            <span key={i} className={cx("h-1 flex-1 rounded-full", i < data.meter![0] ? "bg-accent" : "bg-line")} />
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {/* This node stands over the router and feeds down into it. */}
      <Handle type="source" id="down" position={Position.Bottom} isConnectable={false} />
      <Handle type="target" id="up" position={Position.Top} isConnectable={false} />
    </div>
  );
});

/** Someone whose requests arrive here: an api key by its label, or this machine with no key. */
type Caller = { name: string; router: string | null; /** It only goes where everyone else does. */ follows: boolean; busy: boolean; editable: boolean };

/** A caller, as a chip among the others that go by the same router. */
const CallerNode = memo(function CallerNode({ data }: NodeProps<Node<Caller>>) {
  return (
    <div className="flex h-[30px] w-[150px] items-center gap-1.5 rounded-lg border border-line bg-panel px-2 shadow-sm" title={`${data.name === EVERYONE ? "Any caller not listed here" : data.name === "local" ? "Requests from this machine, with no api key" : "Requests with the api key of this label"}.${data.follows ? " It goes wherever everyone else does." : ""}${data.editable ? " Drag it onto a router, or onto the callers of one, to say which rules its requests go by; or click it to choose." : ""}`}>
      <span className="shrink-0 text-dim">{data.name === EVERYONE ? <Users size={12} /> : data.name === "local" ? <Monitor size={12} /> : <KeyRound size={12} />}</span>
      <span className={cx("truncate text-[12px]", data.name !== EVERYONE && "font-mono", data.follows && "text-dim")}>{data.name === EVERYONE ? "everyone else" : data.name}</span>
      <span className="ml-auto shrink-0"><Dot tone={data.busy ? "accent" : "info"} pulse={data.busy} /></span>
      {/* The whole chip starts the line, so it can be dragged from anywhere on it. */}
      {data.editable && <Handle type="source" id="body" position={Position.Left} className="body !rounded-lg !border-0" style={{ top: 0, left: 0, width: "100%", height: "100%", transform: "none" }} />}
    </div>
  );
});

/** The callers that go by one router, with the one line that takes them all to it. */
type Bay = { label: string; own: boolean };

const BayNode = memo(function BayNode({ data }: NodeProps<Node<Bay>>) {
  return (
    <div className={cx("h-full w-full rounded-2xl border border-dashed", data.own ? "border-accent/50" : "border-info/50")}>
      <div className="truncate px-2.5 pt-1.5 text-[10px] uppercase tracking-wide text-dim">{data.label}</div>
      <Handle type="source" id="down" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

// The chip that was just dragged, so the click that ends the drag does not also open it.
let dragged: string | null = null;

/** Where a backend let go over each frame is put, by the frame's id; filled as the picture is laid out. */
const drops = new Map<string, { resource?: string; server: string }>();

/** A backend given the hardware or the machine it was let go on. Hardware replaces what it sat in; anything else it uses stays. */
function moved(doc: Record<string, unknown>, backend: string, to: { resource?: string; server: string }): Record<string, unknown> {
  const { server: _, ...b } = obj(obj(doc.backends)[backend]);
  const shared = (r: string) => obj(obj(doc.resources)[r]).shared === true;
  const had = list(b.resources);
  // The card it sat in is the first exclusive one it names, else the first; that is the one a move replaces.
  const home = had.find((r) => !shared(r)) ?? had[0];
  const resources = to.resource === undefined ? had : [to.resource, ...had.filter((r) => r !== home && r !== to.resource)];
  return put(doc, "backends", backend, { ...b, ...(resources.length ? { resources } : {}), ...(to.server ? { server: to.server } : {}) });
}

/** Put a backend on whatever hardware or machine is under a point of the page, in the draft. */
function dropBackend(backend: string, x: number, y: number): void {
  const under = document.elementsFromPoint(x, y).map((el) => el.closest(".react-flow__node")?.getAttribute("data-id") ?? "").find((id) => drops.has(id));
  const to = under ? drops.get(under) : undefined;
  if (to && useEdit.getState().draft) change((d) => moved(d, backend, to));
}

const FIELD = "h-8 w-full rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none";

/**
 * "+ provider": a provider's url and key are tried against it before anything is added, and the models to
 * offer are picked from what it lists. It joins the draft as one cloud backend.
 */
function ProviderDialog({ taken, onClose, onCreate }: { taken: string[]; onClose: () => void; onCreate: (id: string, backend: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [key, setKey] = useState("");
  // The API it speaks is guessed from its address until it is chosen by hand.
  const [chosen, setChosen] = useState<"openai" | "anthropic" | null>(null);
  const format = chosen ?? (/anthropic/i.test(url) ? "anthropic" : "openai");
  const [found, setFound] = useState<{ url: string; models: string[] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  // What was listed is only true of the url and key it was listed with.
  const typed = (set: (v: string) => void) => (v: string) => { set(v); setFound(null); setPicked([]); setProblem(null); };
  const check = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const got = await request<{ ok: boolean; url: string; models?: string[]; problem?: string }>("POST", "/backends/probe", { url, key, format });
      if (got.ok && (got.models ?? []).length > 0) setFound({ url: got.url, models: got.models! });
      else setProblem(got.ok ? "it answered, but listed no models" : got.problem ?? "it did not answer");
    } catch (e) {
      setProblem((e as Error).message);
    }
    setBusy(false);
  };
  const id = name.trim();
  const clash = taken.includes(id) ? `a backend named ${id} already exists` : null;
  const shown = (found?.models ?? []).filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase()));
  const ready = id !== "" && !clash && found !== null && picked.length > 0;
  return (
    <Dialog title="New provider" onClose={onClose}>
      <form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); if (ready) onCreate(id, { url: found!.url, cloud: true, ...(format === "anthropic" ? { format } : {}), ...(key.trim() ? { key: key.trim() } : {}), serves: picked }); else if (!found) void check(); }}>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4">
          <div className="text-[12px] text-dim">A provider's API, used as a backend. <span className="text-cloud">A request sent to it leaves this machine and this network.</span></div>
          <label className="block text-[12px] font-medium">Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="what you call it here" className={cx(FIELD, "mt-1 font-mono font-normal", clash && "border-bad")} />
          </label>
          <label className="block text-[12px] font-medium">Its url
            <input value={url} onChange={(e) => typed(setUrl)(e.target.value)} spellCheck={false} placeholder="https://api.example.com/v1" className={cx(FIELD, "mt-1 font-mono font-normal")} />
          </label>
          <label className="block text-[12px] font-medium">It speaks
            <select value={format} onChange={(e) => typed((v) => setChosen(v as "openai" | "anthropic"))(e.target.value)} className={cx(FIELD, "mt-1 font-normal")}>
              <option value="openai">the OpenAI API (chat completions)</option>
              <option value="anthropic">Anthropic's API (Messages), with prompt caching</option>
            </select>
          </label>
          <label className="block text-[12px] font-medium">The key it gave you
            <input value={key} onChange={(e) => typed(setKey)(e.target.value)} spellCheck={false} autoComplete="off" placeholder="env:PROVIDER_KEY" className={cx(FIELD, "mt-1 font-mono font-normal")} />
            <span className="mt-1 block font-normal text-dim"><span className="font-mono">env:NAME</span> reads it from this node's environment and keeps it out of the file. Typed here in full, it is written to hearth.yaml.</span>
          </label>
          <div className="flex items-center gap-2">
            <Button onClick={() => void check()} disabled={busy || !/^https?:\/\/[^\s/]+/.test(url.trim())}>{busy ? "asking…" : found ? "ask again" : "check it and list its models"}</Button>
            {found && <span className="text-[12px] text-ok">it answered: {found.models.length} models</span>}
            {problem && <span className="text-[12px] text-bad">{problem}</span>}
          </div>
          {found && (
            <div>
              <div className="mb-1 flex items-center gap-2 text-[12px] font-medium">Offer these from it
                <span className="font-normal text-dim">{picked.length} chosen</span>
                {found.models.length > 8 && <input aria-label="filter the models" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter" className={cx(FIELD, "ml-auto !h-7 !w-40 font-normal")} />}
              </div>
              <div className="max-h-52 overflow-auto rounded-md border border-line">
                {shown.map((m) => (
                  <label key={m} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px] hover:bg-muted">
                    <input type="checkbox" checked={picked.includes(m)} onChange={(e) => setPicked(e.target.checked ? [...picked, m] : picked.filter((x) => x !== m))} />
                    <span className="truncate font-mono">{m}</span>
                  </label>
                ))}
                {shown.length === 0 && <div className="px-2 py-1 text-[12px] text-dim">none match</div>}
              </div>
              <div className="mt-1 text-[11px] text-dim">Only the ones you choose can be asked for here. A rule can then send requests to them.</div>
            </div>
          )}
          {clash && <div className="text-[12px] text-bad">{clash}</div>}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">
          <Button onClick={onClose}>cancel</Button>
          <Button tone="primary" type="submit" disabled={!ready}><Plus size={13} />add provider</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A card or CPU: the frame its backends sit in, so "runs on" needs no line. */
type Chip = { name: string; tone: Tone; busy: boolean; sub: string };
type Group = { /** What a backend let go here is given: this hardware, on this machine. */ drop?: { resource: string; server: string }; title: string; sub: string; icon: ReactNode; hot: boolean; selected?: boolean; tip?: string; chips?: Chip[]; picked?: string };

const GroupNode = memo(function GroupNode({ data }: NodeProps<Node<Group>>) {
  return (
    <div className={cx(
      "h-full w-full rounded-2xl border border-dashed transition-colors",
      data.hot ? "border-ok/60 bg-ok/[0.04]" : "border-line bg-muted/30",
      data.selected && "ring-2 ring-accent/25",
    )}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2 px-3 pt-2 text-[11px]">
        <span className={data.hot ? "text-ok" : "text-dim"}>{data.icon}</span>
        <span className="font-semibold uppercase tracking-wide">{data.title}</span>
        <span className="truncate text-dim" title={data.tip}>{data.sub}</span>
      </div>
      {data.chips && (
        <div className="grid grid-cols-2 gap-1.5 px-3 pt-2">
          {data.chips.map((c) => (
            <button key={c.name} title={c.sub}
                    // A chip is dragged like a card: let go over other hardware or another machine, it is put there. A press that does not move is a click.
                    onPointerDown={(e) => {
                      if (data.drop === undefined) return;
                      const [x0, y0] = [e.clientX, e.clientY];
                      const drop = (ev: PointerEvent) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) { dragged = c.name; dropBackend(c.name, ev.clientX, ev.clientY); } };
                      document.addEventListener("pointerup", drop, { once: true });
                    }}
                    onClick={(e) => { e.stopPropagation(); if (dragged === c.name) { dragged = null; return; } select({ kind: "backend", id: c.name }); }}
                    className={cx("nodrag nopan flex h-8 items-center gap-1.5 rounded-lg border bg-panel px-2 text-left text-[11px] transition-colors", data.drop !== undefined && "cursor-grab",
                      data.picked === c.name ? "border-accent" : c.busy ? "border-accent/50" : "border-line hover:border-dim/40")}>
              <Dot tone={c.tone} pulse={c.busy} />
              <span className="truncate font-medium">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

/** One machine: the frame around the backends on it. Drawn only once a config names another machine. */
type Machine = { title: string; sub: string; /** The machine a backend let go here is put on. */ drop?: { server: string } };

const MachineNode = memo(function MachineNode({ data }: NodeProps<Node<Machine>>) {
  return (
    <div className="h-full w-full rounded-3xl border border-line bg-panel/40">
      <div className="flex items-center gap-2 px-4 pt-2.5 text-[12px]">
        <Server size={13} className="text-dim" />
        <span className="font-semibold">{data.title}</span>
        <span className="truncate text-dim">{data.sub}</span>
      </div>
    </div>
  );
});

/** A model a peer lends: solid when linked, a ghost when only on offer, red when the link no longer resolves. */
type Ghost = { label: string; state: "linked" | "offered" | "dead"; warm: boolean; busy: boolean; hint: string; onClick: () => void };

const GhostNode = memo(function GhostNode({ data }: NodeProps<Node<Ghost>>) {
  return (
    <button title={data.hint} onClick={(e) => { e.stopPropagation(); data.onClick(); }}
            className={cx(
              "flex h-[30px] w-[190px] items-center gap-1.5 rounded-lg border px-2 text-left text-[11px] transition-colors",
              data.state === "linked" && "border-line bg-panel shadow-sm",
              data.state === "offered" && "border-dashed border-line/80 bg-transparent text-dim opacity-60 hover:opacity-100 hover:border-info",
              data.state === "dead" && "border-bad/60 bg-bad/5 text-bad",
              data.busy && "border-info",
            )}>
      <Dot tone={data.state === "dead" ? "bad" : data.busy ? "info" : data.warm ? "ok" : "dim"} pulse={data.busy} />
      <span className="truncate font-mono">{data.label}</span>
      {data.state === "offered" && <span className="ml-auto shrink-0 text-[10px] text-info">+ link</span>}
      {data.state === "dead" && <span className="ml-auto shrink-0 text-[10px]">gone</span>}
      <Handle type="source" position={Position.Right} />
    </button>
  );
});

/** This node as the frame its callers stand in: requests arrive here from them, and go on to a router. */
type Home = { title: string; sub: string; selected?: boolean };

const HomeNode = memo(function HomeNode({ data }: NodeProps<Node<Home>>) {
  return (
    <div className={cx("h-full w-full rounded-3xl border bg-panel/40", data.selected ? "border-accent ring-2 ring-accent/25" : "border-line")}>
      <div className="px-4 pt-2.5 text-[12px]">
        <div className="flex items-center gap-2"><Flame size={13} className="shrink-0 text-accent" /><span className="truncate font-semibold">{data.title}</span></div>
        <div className="truncate text-[11px] text-dim">{data.sub} · requests from</div>
      </div>
      <Handle type="source" id="down" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { card: CardNode, hardware: GroupNode, machine: MachineNode, ghost: GhostNode, caller: CallerNode, bay: BayNode, home: HomeNode };

type Pulse = { key: string; back: boolean; t: number };
/** `wire`: a route, drawn to be followed. `lit`: the way a tried request takes, or the line under the pointer. */
export type Line = { jobs: string[]; pulses: Pulse[]; color?: string; reverse?: boolean; dashed?: boolean; ghost?: boolean; wire?: boolean; lit?: boolean; faint?: boolean };

const TRIP_MS = 900;

/**
 * Pulses per edge, kept outside the edge components because React Flow remounts those on every
 * update: one out when a request appears, one back when it ends, each with the time it set off.
 */
const tracked = new Map<string, { seen: Set<string>; pulses: Pulse[] }>();
function pulsesFor(edge: string, jobs: string[]): Pulse[] {
  const now = Date.now();
  const cur = tracked.get(edge);
  const ids = new Set(jobs);
  if (!cur) {
    // The first reading is the state we found, not traffic we watched start.
    tracked.set(edge, { seen: ids, pulses: [] });
    return [];
  }
  // Several in one reading leave one after another, so a burst reads as a stream rather than one dot.
  let n = 0;
  for (const j of jobs) if (!cur.seen.has(j)) cur.pulses.push({ key: `o:${j}`, back: false, t: now + 90 * n++ });
  for (const j of cur.seen) if (!ids.has(j)) cur.pulses.push({ key: `b:${j}`, back: true, t: now + 90 * n++ });
  cur.seen = ids;
  cur.pulses = cur.pulses.filter((p) => now - p.t < TRIP_MS).slice(-12);
  return [...cur.pulses];
}

/** One trip along the path, eased, placed by its start time so a remounted edge resumes it mid-flight. */
function PulseDot({ path, color, reverse, t }: { path: string; color: string; reverse: boolean; t: number }) {
  const dot = useRef<SVGCircleElement>(null);
  const track = useRef<SVGPathElement>(null);
  useLayoutEffect(() => {
    let raf = 0;
    const step = () => {
      const c = dot.current;
      const p = track.current;
      if (!c || !p) return;
      const k = (Date.now() - t) / TRIP_MS;
      if (k < 0) {
        raf = requestAnimationFrame(step);
        return;
      }
      if (k >= 1) {
        c.setAttribute("opacity", "0");
        return;
      }
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const at = p.getPointAtLength((reverse ? 1 - e : e) * p.getTotalLength());
      c.setAttribute("cx", String(at.x));
      c.setAttribute("cy", String(at.y));
      c.setAttribute("opacity", String(Math.min(1, k / 0.08, (1 - k) / 0.12)));
      raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [path, t, reverse]);
  return (
    <g>
      <path ref={track} d={path} fill="none" stroke="none" />
      <circle ref={dot} r={3.5} fill={color} opacity={0} className="flow-dot" />
    </g>
  );
}

/** Requests as pulses that always finish their trip; the line stays lit while anything runs on it. */
const FlowEdge = memo(function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<Line>>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const color = data?.color ?? "var(--accent)";
  const hot = (data?.jobs ?? []).length > 0;
  return (
    <>
      <BaseEdge id={id} path={path} style={{
        stroke: data?.lit ? "var(--accent)" : hot ? color : data?.dashed ? "var(--bad)" : data?.wire ? (data.color ?? "var(--dim)") : "var(--border)",
        strokeWidth: data?.lit ? 2.5 : hot ? 2 : data?.wire ? 1.5 : 1, strokeDasharray: data?.dashed || data?.ghost ? "4 4" : undefined,
        opacity: data?.lit ? 1 : hot ? 0.45 : data?.ghost ? 0.5 : data?.faint ? 0.28 : data?.wire ? 0.75 : 0.8,
      }} />
      {(data?.pulses ?? []).map((p) => (
        // Out runs source to target unless the edge is drawn the other way round; back is the opposite.
        <PulseDot key={p.key} t={p.t} path={path} color={p.back ? "var(--ok)" : color} reverse={p.back !== Boolean(data?.reverse)} />
      ))}
    </>
  );
});

export const edgeTypes = { flow: FlowEdge };

const W = 200;
const H = 64;
/** A caller's chip, the box of them that go by one router, and the head of the frame those boxes stand in. */
const CALLER = { w: 150, h: 30, gap: 6, cols: 2 };
const BAY = { head: 24, pad: 10 };
const HOME = 56;
const GAP = 12;
/** A hardware group: the padding around its backends and the height of its title. */
const PAD = 14;
const HEAD = 34;
/** A machine's frame: its padding, its header, and the space between the hardware inside. */
const FRAME = { pad: 14, head: 40, gap: 14 };
function backendTone(b: Backend): Tone {
  if (b.restingMs) return "warn";
  if (b.answering === false) return "bad";
  if ((b.loaded ?? []).length > 0) return "ok";
  if ((b.loading ?? []).length > 0) return "warn";
  return b.knowsWarm === false ? "dim" : "info";
}

/** What a backend's status dot is saying. */
function backendTip(b: Backend, run: number): string {
  if (run > 0) return "working on a request";
  if (b.answering === false) return "not answering";
  if ((b.loaded ?? []).length) return "a model is loaded and ready";
  if ((b.loading ?? []).length) return "loading a model";
  return b.knowsWarm === false ? "up; it does not report what is loaded" : "up, with nothing loaded";
}

function backendSub(b: Backend, run: number): string {
  if (b.restingMs) return `resting ${Math.ceil(b.restingMs / 1000)}s after failing`;
  if (b.answering === false) return "not answering";
  if (run > 0 || (b.queued ?? 0) > 0) return `${run} running · ${b.queued ?? 0} queued`;
  if ((b.loading ?? []).length) return `loading ${b.loading![0]}`;
  if ((b.loaded ?? []).length) return b.loaded!.join(", ");
  return b.knowsWarm === false ? "idle" : "nothing loaded";
}

/**
 * Peers | this node | machines, each a stack of its backends in the hardware they use.
 * Deterministic, so nothing moves per tick.
 */
/** Who calls and which router each goes by, as the draft has it; null where there is no draft to read them from. */
type Who = { /** Machines the draft names, with or without anything on them yet. */ servers: string[]; callers: { name: string; router: string | null; follows: boolean }[]; routers: Record<string, { users: string[]; strict: boolean }> } | null;

function layout(d: UiData, sel: { kind: string; id: string } | null, who: Who = null) {
  drops.clear();
  const self = d.net.nodes.find((n) => n.self)!;
  const peers = d.net.nodes.filter((n) => !n.self);
  const is = (kind: string, id: string) => sel?.kind === kind && sel.id === id;

  const runningIds = new Map<string, string[]>();
  const peerIds = new Map<string, string[]>();
  const peerModelIds = new Map<string, string[]>();
  for (const j of d.q.jobs) {
    if (j.state !== "running") continue;
    if (j.offbox && j.peer) {
      peerIds.set(j.peer, [...(peerIds.get(j.peer) ?? []), j.id]);
      const k = `${j.peer}\u0000${j.model}`;
      peerModelIds.set(k, [...(peerModelIds.get(k) ?? []), j.id]);
    }
    else if (j.backend) runningIds.set(j.backend, [...(runningIds.get(j.backend) ?? []), j.id]);
  }
  const X = { peer: 0, self: 290, group: 620 };
  // What stands between this node and where requests run: one decision sends a request to a peer or to a backend here,
  // so both sides hang off it. With several routers drawn it is the point their requests come together at.
  const hub = who ? "join" : "router";

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Backends sit in the hardware they use, and hardware in the machine it is on, this one first.
  const resources = d.net.resources ?? [];
  const framed = (self.backends ?? []).some((b) => b.server) || (who?.servers.length ?? 0) > 0;
  const machines = [...new Set(["", ...(self.backends ?? []).map((b) => b.server ?? ""), ...(who?.servers ?? [])])];
  // The first exclusive card a backend names, else its first resource; one that names none sits in the machine itself.
  const homeOf = (b: Backend) => (b.resources ?? []).find((r) => resources.some((x) => x.name === r && !x.shared)) ?? (b.resources ?? [])[0] ?? "";
  const order = [...resources.filter((r) => !r.shared), ...resources.filter((r) => r.shared)].map((r) => r.name);
  let y = 0;
  // Hardware nothing uses yet is drawn on this machine while there is a draft, so a backend can be dragged onto it.
  const loose = who ? order.filter((r) => !(self.backends ?? []).some((b) => homeOf(b) === r)) : [];
  for (const machine of machines) {
    const members = (self.backends ?? []).filter((b) => !b.cloud && (b.server ?? "") === machine);
    const spare = machine === "" ? loose : [];
    if (members.length === 0 && spare.length === 0 && (machine === "" || !framed)) continue;
    const frame = framed ? `machine:${machine}` : undefined;
    const left = frame ? FRAME.pad : X.group;
    let top = frame ? FRAME.head : y;
    const inside: Node[] = [];
    let wide = W + PAD * 2;
    const keys = [...new Set([...members.map(homeOf), ...spare])].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
    for (const key of keys) {
      const group = key === "" ? undefined : `resource:${frame ? `${machine}/` : ""}${key}`;
      const r: Resource | undefined = resources.find((x) => x.name === key);
      const cards: Node[] = [];
      const mine = members.filter((m) => homeOf(m) === key);
      // Many small backends read as chips behind one line; a few big ones keep a card and a line each.
      const chips = group !== undefined && mine.length > 3;
      const width = chips ? 2 * 150 + 6 + 24 : W + PAD * 2;
      const height = chips ? HEAD + 4 + Math.ceil(mine.length / 2) * 38 + 6 : mine.length === 0 ? HEAD + 34 : (group ? HEAD + PAD : 0) + mine.length * H + (mine.length - 1) * GAP;
      wide = Math.max(wide, width);
      if (!chips) mine.forEach((b, n) => {
        const run = runningIds.get(b.name) ?? [];
        cards.push({
          // With a draft it can be dragged out of its frame, onto other hardware or another machine.
          id: `backend:${b.name}`, type: "card", ...(group ?? frame ? { parentId: group ?? frame, ...(who ? {} : { extent: "parent" as const }) } : {}), ...(who ? { draggable: true, zIndex: 5 } : {}),
          position: group ? { x: PAD, y: HEAD + n * (H + GAP) } : { x: left + PAD, y: top + n * (H + GAP) },
          data: {
            title: b.name, icon: <Server size={14} />, tone: run.length > 0 ? "accent" : backendTone(b), tip: backendTip(b, run.length),
            sub: backendSub(b, run.length), meter: [run.length, b.slots ?? 0], busy: run.length > 0, selected: is("backend", b.name),
            // The group says the hardware it sits in; a tag is for anything else it uses.
            tags: (b.resources ?? []).filter((x) => x !== key),
          } satisfies Card,
        });
        edges.push({ id: `e:backend:${b.name}`, source: hub, target: `backend:${b.name}`, type: "flow", data: { jobs: run, pulses: pulsesFor(`e:backend:${b.name}`, run) } });
      });
      if (group) {
        if (who) drops.set(group, { resource: key, server: machine });
        const all = mine.flatMap((b) => runningIds.get(b.name) ?? []);
        if (chips) edges.push({ id: `e:${group}`, source: hub, target: group, type: "flow", data: { jobs: all, pulses: pulsesFor(`e:${group}`, all) } });
        inside.push({
          id: group, type: "hardware", ...(frame ? { parentId: frame, extent: "parent" as const } : {}), position: { x: left, y: top }, style: { width, height },
          data: {
            drop: { resource: key, server: machine },
            title: key, hot: all.length > 0, selected: is("resource", key),
            icon: r?.kind === "cpu" ? <Cpu size={13} /> : <CircuitBoard size={13} />,
            sub: mine.length === 0 ? "· empty: drag a backend here" : r?.shared ? "shared" : r?.holder ? `· in use by ${r.holder}` : r ? "· not in use" : "",
            tip: r?.shared ? "Several backends use this at once; hearth does not make them take turns." : "One backend uses this at a time; the others on it wait their turn.",
            ...(chips ? {
              picked: sel?.kind === "backend" ? sel.id : undefined,
              chips: mine.map((b) => {
                const n = (runningIds.get(b.name) ?? []).length;
                return { name: b.name, busy: n > 0, tone: n > 0 ? "accent" as Tone : backendTone(b), sub: `${backendSub(b, n)} · ${backendTip(b, n)}` };
              }),
            } : {}),
          } satisfies Group,
        });
      }
      inside.push(...cards);
      top += height + FRAME.gap;
    }
    const height = frame ? Math.max(top - FRAME.gap, FRAME.head + H) + FRAME.pad : top - FRAME.gap - y;
    if (frame) {
      if (who) drops.set(frame, { server: machine });
      nodes.push({
        id: frame, type: "machine", position: { x: X.group - FRAME.pad, y }, style: { width: wide + FRAME.pad * 2, height },
        data: { drop: { server: machine }, title: machine || self.name, sub: machine ? (members.length ? "" : "empty: drag a backend here") : "this machine" } satisfies Machine,
      });
    }
    nodes.push(...inside);
    y += height + 24;
  }
  // A provider's servers are no machine and no hardware of ours: they stand together below what is, and are not moved between frames.
  const away = (self.backends ?? []).filter((b) => b.cloud);
  if (away.length > 0) {
    const all = away.flatMap((b) => runningIds.get(b.name) ?? []);
    nodes.push({
      id: "cloud", type: "hardware", position: { x: X.group, y }, style: { width: W + PAD * 2, height: HEAD + PAD + away.length * H + (away.length - 1) * GAP },
      data: { title: "Cloud", icon: <Cloud size={13} />, hot: all.length > 0, sub: "· leaves this network", tip: "Providers' servers on the internet. A request sent to one leaves this machine and this network." } satisfies Group,
    });
    away.forEach((b, n) => {
      const run = runningIds.get(b.name) ?? [];
      nodes.push({
        id: `backend:${b.name}`, type: "card", parentId: "cloud", extent: "parent", position: { x: PAD, y: HEAD + n * (H + GAP) },
        data: { title: b.name, icon: <Cloud size={14} />, tone: run.length > 0 ? "accent" : b.restingMs ? "warn" : b.trouble ? "bad" : "ok", tip: b.trouble ? `Its model list could not be read: ${b.trouble}. Requests sent to it are likely to fail the same way.` : backendTip(b, run.length),
          // Nothing is loaded or unloaded there: what is wrong with it, else what it offers, says more than "idle".
          sub: run.length > 0 || b.restingMs ? backendSub(b, run.length) : b.trouble ?? ((b.serves ?? []).length ? b.serves!.join(", ") : backendSub(b, 0)), meter: [run.length, b.slots ?? 0], busy: run.length > 0, selected: is("backend", b.name) } satisfies Card,
      });
      edges.push({ id: `e:backend:${b.name}`, source: hub, target: `backend:${b.name}`, type: "flow", data: { jobs: run, pulses: pulsesFor(`e:backend:${b.name}`, run) } });
    });
    y += HEAD + PAD + away.length * H + (away.length - 1) * GAP + 24;
  }
  const mid = Math.max(y - 24, H) / 2;
  const local = d.q.jobs.filter((j) => j.state === "running").map((j) => j.id);
  if (who) {
    // Drawn only: nothing in the file is it.
    nodes.push({
      id: "join", type: "card", position: { x: X.self, y: mid - H / 2 },
      data: {
        title: "Dispatch", icon: <Waypoints size={14} />, tone: local.length ? "accent" : "info", busy: local.length > 0,
        sub: local.length ? `${local.length} on ${local.length === 1 ? "its" : "their"} way` : "to a peer or a backend here",
        tip: "Whichever router decides, the request goes on from here: to a peer, or to a backend on this machine.",
      } satisfies Card,
    });
  } else {
    // The one router there is: routing decides which backend a request runs on.
    const rules = Object.values(d.flows ?? {}).filter((f) => !f.off).length;
    nodes.push({
      id: "router", type: "card", position: { x: X.self, y: mid - H / 2 },
      data: {
        title: "Router", icon: <Split size={14} />, tone: local.length ? "accent" : "info", busy: local.length > 0,
        sub: rules ? `${rules} routing ${rules === 1 ? "rule" : "rules"}` : "each name to its own model",
        tip: "Decides where each request runs. Click to open the Routing page.",
      } satisfies Card,
    });
    edges.push({ id: "e:router", source: "self", sourceHandle: "down", target: "router", targetHandle: "up", type: "flow", data: { jobs: local, pulses: pulsesFor("e:router", local) } });
  }
  const load = `${d.q.jobs.filter((j) => j.state === "running").length} running · ${d.q.jobs.filter((j) => j.state === "queued").length} queued`;
  // Each peer gets a block tall enough for its offer: linked models first, then what is only on offer.
  const offerOf = (p: NetNode) => {
    const served = new Set(p.serves ?? []);
    const linked = Object.entries(p.map ?? {}).map(([mine, theirs]) => ({ mine, theirs, dead: p.up && !served.has(mine) }));
    return { linked, offered: p.up ? (p.unmapped ?? []) : [] };
  };
  const CHIP = 38;
  const blocks = peers.map((p) => {
    const o = offerOf(p);
    return Math.max(H, (o.linked.length + o.offered.length) * CHIP - 8);
  });
  let py = mid - (blocks.reduce((a, b) => a + b, 0) + GAP * (peers.length - 1)) / 2;
  // With its callers known, this node is the frame they stand in, boxed by the router they go by: one line a router, however many callers.
  // Those with a router of their own stand to the left; whoever goes by the default one stands over where they all meet.
  const ranks = Object.keys(who?.routers ?? {});
  const bays = (who ? [...ranks.slice().reverse(), null] : []).flatMap((name) => {
    const callers = who!.callers.filter((c) => c.router === name);
    if (callers.length === 0) return [];
    const cols = Math.min(CALLER.cols, callers.length);
    const w = Math.max(cols * (CALLER.w + CALLER.gap) - CALLER.gap + BAY.pad * 2, 150);
    return [{ name, callers, w, h: BAY.head + Math.ceil(callers.length / cols) * (CALLER.h + CALLER.gap) - CALLER.gap + BAY.pad, x: 0 }];
  });
  let wide = PAD;
  for (const b of bays) { b.x = wide; wide += b.w + GAP; }
  wide += PAD - GAP;
  const tall = HOME + Math.max(0, ...bays.map((b) => b.h)) + PAD;
  const main = bays.find((b) => b.name === null);
  const left = main ? X.self + W / 2 - main.x - main.w / 2 : X.self - GAP - wide;
  // Each router stands right under the callers that use it, in a row between the frame and everything else.
  const under = Math.min(mid - H / 2, 0, py) - 56 - H;
  nodes.unshift(bays.length ? {
    id: "self", type: "home", position: { x: left, y: under - 28 - tall }, style: { width: wide, height: tall },
    data: { title: self.name, sub: load, selected: is("self", self.name) } satisfies Home,
  } : {
    id: "self", type: "card", position: { x: X.self, y: mid - H / 2 - H - 56 },
    data: { title: self.name, icon: <Flame size={14} className="text-accent" />, tone: "accent", selected: is("self", self.name), sub: load } satisfies Card,
  });
  if (who) {
    // A request from someone not drawn (a key with no label) is one of everyone else's.
    const named = who.callers.map((c) => c.name);
    const mine = (c: string) => d.q.jobs.filter((j) => j.state === "running" && !j.offbox
      && (c === EVERYONE ? !named.includes(j.caller) && !named.includes(j.caller.replace(/^key:/, "")) : j.caller === c || j.caller === `key:${c}`)).map((j) => j.id);
    // One nobody uses yet waits to the left of the frame.
    let spare = 0;
    for (const name of [null, ...ranks]) {
      const bay = bays.find((b) => b.name === name);
      const users = name === null ? who.callers.filter((c) => c.router === null).map((c) => c.name) : who.routers[name]!.users;
      const id = name === null ? "router" : `router:${name}`;
      const jobs = (bay?.callers ?? []).flatMap((c) => mine(c.name));
      nodes.push({
        id, type: "card", position: { x: bay ? left + bay.x + bay.w / 2 - W / 2 : left - ++spare * (W + GAP), y: under },
        data: {
          title: name ?? "default router", icon: <Split size={14} />, tone: jobs.length ? "accent" : users.length ? "info" : "warn", busy: jobs.length > 0,
          sub: `${users.length ? `for ${users.map((u) => (u === EVERYONE ? "everyone else" : u)).join(", ")}` : "nobody uses it yet"}${name !== null && who.routers[name]!.strict ? " · never falls back" : ""}`,
          tip: name === null ? "The rules everyone goes by unless wired to a router of their own. Click to open the Routing page." : "A rulebook of its own for the callers wired to it. Click to open it on the Routing page.",
        } satisfies Card,
      });
      // Every router's requests come together at the one point they are sent on from.
      edges.push({ id: `e:${id}`, source: id, sourceHandle: "down", target: "join", targetHandle: "up", type: "flow", data: { jobs, pulses: pulsesFor(`e:${id}`, jobs), wire: true, color: "var(--dim)" } });
      if (!bay) continue;
      const box = `bay:${name ?? ""}`;
      nodes.push({ id: box, type: "bay", parentId: "self", extent: "parent" as const, position: { x: bay.x, y: HOME }, style: { width: bay.w, height: bay.h }, data: { label: name === null ? "by the default router" : `by ${name}`, own: name !== null } satisfies Bay });
      bay.callers.forEach((c, i) => {
        nodes.push({ id: `caller:${c.name}`, type: "caller", parentId: box, extent: "parent" as const, position: { x: BAY.pad + (i % CALLER.cols) * (CALLER.w + CALLER.gap), y: BAY.head + Math.floor(i / CALLER.cols) * (CALLER.h + CALLER.gap) }, data: { ...c, busy: mine(c.name).length > 0, editable: true } satisfies Caller });
      });
      edges.push({
        id: `e:${box}`, source: box, sourceHandle: "down", target: id, targetHandle: "up", type: "flow",
        data: { jobs, pulses: pulsesFor(`e:${box}`, jobs), wire: true, color: name === null ? "var(--info)" : "var(--accent)" },
      });
    }
  }
  peers.forEach((p: NetNode, i) => {
    const block = blocks[i]!;
    nodes.push({
      id: `peer:${p.name}`, type: "card", position: { x: X.peer, y: py + (block - H) / 2 },
      data: {
        title: p.name, icon: <Globe size={14} />, tone: p.up ? "ok" : "bad",
        sub: p.up ? `lends you ${Object.keys(p.map ?? {}).length} · ${p.free ?? 0} of ${p.slots ?? 0} slots free` : "cannot be reached",
        tip: p.up ? "another hearth that can run some requests for you" : "not answering right now",
        busy: (peerIds.get(p.name) ?? []).length > 0, selected: is("peer", p.name),
      } satisfies Card,
    });
    // Work we send them flows out from this node, so the dots run right to left.
    edges.push({
      id: `e:peer:${p.name}`, source: `peer:${p.name}`, target: hub, type: "flow",
      data: { jobs: peerIds.get(p.name) ?? [], pulses: pulsesFor(`e:peer:${p.name}`, peerIds.get(p.name) ?? []), color: "var(--info)", reverse: true, dashed: !p.up },
    });

    // What they lend, as chips to their left; our requests carry on through the peer into the model they asked for.
    const o = offerOf(p);
    const chips = [
      ...o.linked.map((l) => ({ key: l.mine, label: l.mine === l.theirs ? l.mine : `${l.mine} → ${l.theirs}`, state: (l.dead ? "dead" : "linked") as Ghost["state"], mine: l.mine, theirs: l.theirs })),
      ...o.offered.map((m) => ({ key: m, label: m, state: "offered" as const, mine: m, theirs: m })),
    ];
    chips.forEach((c, k) => {
      const id = `ghost:${p.name}:${c.key}`;
      const jobs = c.state === "offered" ? [] : peerModelIds.get(`${p.name}\u0000${c.mine}`) ?? [];
      const ctx = p.stats?.[c.mine]?.context;
      nodes.push({
        id, type: "ghost", position: { x: X.peer - 230, y: py + k * CHIP },
        data: {
          label: c.label, state: c.state, warm: (p.loaded ?? []).includes(c.mine), busy: jobs.length > 0,
          hint: c.state === "dead" ? `${p.name} no longer offers ${c.theirs} — this link routes nowhere`
            : c.state === "offered" ? `${p.name} offers ${c.theirs} — click to borrow it`
            : `linked${ctx ? ` · ${Math.round(ctx / 1024)}k context` : ""}${(p.loaded ?? []).includes(c.mine) ? " · warm" : ""}`,
          onClick: c.state === "offered"
            ? () => void control({ link: { peer: p.name, mine: c.theirs, theirs: c.theirs } }, `linked ${c.theirs} from ${p.name}`)
            : () => select({ kind: "peer", id: p.name }),
        } satisfies Ghost,
      });
      edges.push({
        id: `e:${id}`, source: id, target: `peer:${p.name}`, type: "flow",
        data: { jobs, pulses: pulsesFor(`e:${id}`, jobs), color: "var(--info)", reverse: true, dashed: c.state === "dead", ghost: c.state === "offered" },
      });
    });
    py += block + GAP;
  });
  return { nodes, edges };
}

/**
 * The freshly laid-out nodes, with the one being dragged left where the pointer has it and each one's
 * measured size carried over. A node handed back unmeasured is hidden until it is measured again,
 * which takes the keys away from anything being typed into inside it.
 */
export const held = (fresh: Node[], now: Node[], dragging: string | null): Node[] => {
  const was = new Map(now.map((n) => [n.id, n]));
  return fresh.map((n) => {
    const old = was.get(n.id);
    if (!old) return n;
    return { ...n, ...(old.measured ? { measured: old.measured } : {}), ...(n.id === dragging ? { position: old.position } : {}) };
  });
};

/** Arrive fitted, and never drawn too small to read: a big picture is panned across, not squinted at. `top` is what a strip over the picture covers. */
export function arrive(rf: ReactFlowInstance, top = 84): void {
  setTimeout(() => {
    void rf.fitView({ padding: 0.06, minZoom: 0.7, maxZoom: 1 });
    // A picture too big to fit starts from its top left, clear of the strip above it, not from its middle.
    const box = rf.getNodesBounds(rf.getNodes());
    const v = rf.getViewport();
    const [left, up] = [box.x * v.zoom + v.x, box.y * v.zoom + v.y];
    if (left < 16 || up < top) void rf.setViewport({ x: left < 16 ? 16 - box.x * v.zoom : v.x, y: up < top ? top - box.y * v.zoom : v.y, zoom: v.zoom });
  }, 250);
}


export function Topology() {
  const live = useStore((s) => s.data)!;
  const sel = useStore((s) => s.sel);
  const dark = document.documentElement.classList.contains("dark");
  // Who calls, and by which router, is read from the routing draft: wiring a caller here is a change to that draft.
  const draft = useEdit((s) => s.draft);
  const plan = useEdit((s) => s.plan);
  const past = useEdit((s) => s.past);
  const isDirty = useEdit(dirty);
  const future = useEdit((s) => s.future);
  const changes = useEdit(edits);
  const [adding, setAdding] = useState<string | null>(null);
  const [providing, setProviding] = useState(false);
  const flow = useRef<ReactFlowInstance | null>(null);
  const waiting = live.config.restartPending;
  // Escape closes the panel beside the picture.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement | null)?.closest("input, textarea, select, dialog")) select(null); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  // What is drawn is the draft where there is one: something added or moved shows before it is published.
  const data = useMemo(() => (draft ? draftView(draft, live) : live), [draft, live]);
  const hash = live.config.hash;
  useEffect(() => { if (!useEdit.getState().file) void loadDraft(); }, [hash]);
  const who = useMemo<Who>(() => (draft ? {
    servers: Object.keys(obj(draft.servers)),
    callers: callersIn(draft).map((name) => { const at = routerFor(draft, name); return { name, router: at.router, follows: !at.own }; }),
    routers: Object.fromEntries(Object.entries(obj(draft.routers)).map(([name, r]) => [name, { users: usersOf(draft, name), strict: obj(r).strict === true }])),
  } : null), [draft?.routers, draft?.callers, draft?.apiKeys, draft?.servers]);
  const laid = useMemo(() => layout(data, sel, who), [data.net, data.q.jobs, data.flows, sel, who]);
  // The picture is fitted again once, when the draft's part of it (callers, routers, empty frames) first arrives.
  const drafted = who !== null;
  useEffect(() => { if (drafted && flow.current) arrive(flow.current, 0); }, [drafted]);
  // A drag moves the node until it is let go; what the node reports meanwhile must not put it back.
  const [nodes, setNodes] = useState(laid.nodes);
  const dragging = useRef<string | null>(null);
  useEffect(() => setNodes((now) => held(laid.nodes, now, dragging.current)), [laid]);

  const strip = draft && (
    <div className="relative z-10 mx-3 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-2 py-1.5 shadow-sm">
      {(["backends", "resources", "servers"] as const).map((k) => (
        <button key={k} type="button" className="flex h-7 items-center gap-1 rounded-lg border border-line bg-panel px-2 text-[12px] hover:bg-muted" onClick={() => setAdding(k)}>
          <Plus size={12} />{NEW[k]!.noun}
        </button>
      ))}
      <button type="button" className="flex h-7 items-center gap-1 rounded-lg border border-line bg-panel px-2 text-[12px] hover:bg-muted" title="a provider's API on the internet, as a backend" onClick={() => setProviding(true)}>
        <Plus size={12} />provider
      </button>
      <VersionsButton />
      {/* The hint gives way to whatever the strip has to say, so it stays one row. */}
      {!isDirty && waiting.length === 0 && <span className="truncate text-[11px] text-dim max-xl:hidden">Click anything for its settings. Drag a backend onto hardware, or a caller onto a router.</span>}
      <div className="ml-auto flex items-center gap-2">
        {/* What is published but not running yet stays said until the restart that applies it. */}
        {waiting.length > 0 && !isDirty && (
          <span className="flex items-center gap-2 text-[12px] text-warn">published, not running yet: restart to apply {waiting.join(", ")}
            <Button onClick={() => { if (confirm("Restart hearth? Running requests finish first, everyone is signed out, and it only comes back if systemd (or similar) restarts it.")) void restartNode(); }}>restart</Button>
          </span>
        )}
        {isDirty && (
          <>
            <span className="flex items-center gap-1.5 text-[12px] text-accent"><span className="size-1.5 rounded-full bg-accent" />draft · {changes} {changes === 1 ? "change" : "changes"}</span>
            <Button disabled={past.length === 0} onClick={undo}><Undo2 size={13} />undo</Button>
            {future.length > 0 && <Button onClick={redo}><Redo2 size={13} />redo</Button>}
            <Button onClick={revert}><RotateCcw size={13} />discard draft</Button>
            <Button tone="primary" onClick={() => void review()}><Save size={13} />review &amp; publish</Button>
          </>
        )}
      </div>
    </div>
  );
  return (
    <div className="flex h-full flex-col">
    {strip}
    <div className="relative min-h-0 flex-1">
    <ReactFlow
      nodes={nodes} edges={laid.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      nodesDraggable={false} nodesConnectable={who !== null} elementsSelectable={false} zoomOnDoubleClick={false}
      minZoom={0.3} maxZoom={1.5} onInit={(rf) => { flow.current = rf; arrive(rf, 0); }}
      // A caller's line let go over a router sends its requests by that router; over the default one, by the rules everyone goes by.
      onConnectEnd={(e, c) => {
        const from = c.fromNode?.id ?? "";
        if (!from.startsWith("caller:")) return;
        const at = "changedTouches" in e ? e.changedTouches[0]! : e;
        const to = document.elementFromPoint(at.clientX, at.clientY)?.closest(".react-flow__node")?.getAttribute("data-id") ?? "";
        // Let go over a router, or over the callers that already go by one.
        const over = to.startsWith("caller:") ? `bay:${who?.callers.find((x) => x.name === to.slice(7))?.router ?? ""}` : to;
        if (over !== "router" && !over.startsWith("router:") && !over.startsWith("bay:")) return;
        const [caller, name] = [from.slice(7), over === "router" ? null : over.slice(over.indexOf(":") + 1) || null];
        const now = who?.callers.find((x) => x.name === caller);
        if (now && !now.follows && now.router === name) return;
        change((d) => withCaller(d, caller, name));
        toast("ok", `${caller === EVERYONE ? "everyone else" : caller} goes by ${name === null ? "the default router" : `router ${name}`} in the draft — publish it on the Routing page`);
      }}
      colorMode={dark ? "dark" : "light"} proOptions={{ hideAttribution: true }}
      onNodesChange={(changes) => setNodes((ns) => applyNodeChanges(changes, ns))}
      onNodeDragStart={(_, n) => { dragging.current = n.id; }}
      // A backend let go over hardware or a machine is put there in the draft; let go anywhere else, it goes back.
      onNodeDragStop={(e, n) => {
        dragging.current = null;
        const at = "changedTouches" in e ? (e as unknown as TouchEvent).changedTouches[0]! : e;
        if (n.id.startsWith("backend:")) dropBackend(n.id.slice(8), at.clientX, at.clientY);
        setNodes((now) => held(laid.nodes, now, null));
      }}
      onNodeClick={(_, n) => {
        const [kind, ...rest] = n.id.split(":");
        const id = kind === "self" ? data.net.nodes.find((x) => x.self)!.name : rest.join(":");
        if (kind === "caller" && draft) {
          const at = routerFor(draft, id);
          const box = document.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`)?.getBoundingClientRect();
          chooseAt(box?.right ?? 0, box?.top ?? 0, [
            { label: `requests from ${id === EVERYONE ? "everyone else" : id} go by`, head: true },
            { label: "The default router", value: "to:", on: at.own && at.router === null },
            ...Object.keys(obj(draft.routers)).map((r) => ({ label: r, value: `to:${r}`, mono: true, on: at.own && at.router === r })),
            ...(id === EVERYONE ? [] : [{ label: "Wherever everyone else goes", value: "follow", on: !at.own, hint: "moves with them" }]),
          ], (v) => (v === "follow" ? follow(id) : change((d) => withCaller(d, id, v.slice(3) || null))));
        } else if (kind === "router") { if (useEdit.getState().draft) showRouter(rest.length ? rest.join(":") : null); go("routing"); }
        else if (kind === "self" || kind === "peer" || kind === "backend") select({ kind, id });
        else if (kind === "resource") select({ kind, id: id.split("/").pop()! });
        else if (kind === "machine" && id) select({ kind, id });
      }}
      onPaneClick={() => select(null)}
    >
      <Background gap={20} size={1} color="var(--border)" />
      <Controls showInteractive={false} position="bottom-left" />
      {draft && providing && (
        <ProviderDialog taken={Object.keys(obj(draft.backends))} onClose={() => setProviding(false)}
                        onCreate={(id, backend) => { change((d) => put(d, "backends", id, backend)); setProviding(false); select({ kind: "backend", id }); }} />
      )}
      {draft && adding && (
        <Refs.Provider value={refsOf(draft, live.catalog ?? [])}>
          <NewDialog spec={NEW[adding]!} taken={Object.keys(obj(draft[adding]))} onClose={() => setAdding(null)}
                     note={adding === "backends" ? "It joins the draft. Drag it onto the hardware it uses, or click it for the rest of its settings." : "It joins the draft and is drawn at once, empty: drag a backend onto it."}
                     onCreate={(id, vals) => {
                       change((d) => put(d, adding, id, vals));
                       select({ kind: adding === "backends" ? "backend" : adding === "resources" ? "resource" : "machine", id });
                       setAdding(null);
                       // Once it is drawn and its panel is open, the whole picture is fitted again so it is in view.
                       setTimeout(() => void flow.current?.fitView({ padding: 0.08, duration: 300, maxZoom: 1 }), 150);
                     }} />
        </Refs.Provider>
      )}
      {plan && <Review plan={plan} onClose={() => useEdit.setState({ plan: null })} />}
    </ReactFlow>
    <Menu />
    </div>
    </div>
  );
}
