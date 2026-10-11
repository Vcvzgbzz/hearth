/**
 * Where things run: peers, this node, and the machines and hardware its backends sit on, with a
 * dot for each request in flight. Watched, not edited; where requests go is Routing.tsx.
 */
import {
  applyNodeChanges, Background, BaseEdge, Controls, getBezierPath, Handle, Position, ReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";
import { CircuitBoard, Cpu, Flame, Globe, Server, Split } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Backend, Node as NetNode, Resource, UiData } from "./types.js";
import { control, go, select, useStore } from "./store.js";
import { cx, Dot, type Tone } from "./ui.js";

/** `tags`: hardware a backend uses besides the group it sits in. `tip`: what the status dot is saying. */
type Card = { title: string; sub: string; tone: Tone; icon: ReactNode; meter?: [number, number]; busy?: boolean; selected?: boolean; tags?: string[]; tip?: string };

const CardNode = memo(function CardNode({ data }: NodeProps<Node<Card>>) {
  return (
    <div className={cx(
      "w-[200px] rounded-xl border bg-panel px-3 py-2 shadow-sm transition-colors",
      data.selected ? "border-accent ring-2 ring-accent/25" : "border-line hover:border-dim/40",
    )}>
      <Handle type="target" position={Position.Left} />
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
      <Handle type="source" position={Position.Right} />
      {/* This node stands over the router and feeds down into it. */}
      <Handle type="source" id="down" position={Position.Bottom} />
      <Handle type="target" id="up" position={Position.Top} />
    </div>
  );
});

/** A card or CPU: the frame its backends sit in, so "runs on" needs no line. */
type Chip = { name: string; tone: Tone; busy: boolean; sub: string };
type Group = { title: string; sub: string; icon: ReactNode; hot: boolean; selected?: boolean; tip?: string; chips?: Chip[]; picked?: string };

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
                    onClick={(e) => { e.stopPropagation(); select({ kind: "backend", id: c.name }); }}
                    className={cx("flex h-8 items-center gap-1.5 rounded-lg border bg-panel px-2 text-left text-[11px] transition-colors",
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
type Machine = { title: string; sub: string };

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

const nodeTypes = { card: CardNode, hardware: GroupNode, machine: MachineNode, ghost: GhostNode };

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
const GAP = 12;
/** A hardware group: the padding around its backends and the height of its title. */
const PAD = 14;
const HEAD = 34;
/** A machine's frame: its padding, its header, and the space between the hardware inside. */
const FRAME = { pad: 14, head: 40, gap: 14 };
function backendTone(b: Backend): Tone {
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
function layout(d: UiData, sel: { kind: string; id: string } | null, router: boolean) {
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
  // With the router drawn it takes this node's place between peers and hardware, and this node stands over it:
  // one decision sends a request to a peer or to a backend here, so both sides hang off the one router.
  const hub = router ? "router" : "self";

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Backends sit in the hardware they use, and hardware in the machine it is on, this one first.
  const resources = d.net.resources ?? [];
  const framed = (self.backends ?? []).some((b) => b.server);
  const machines = [...new Set(["", ...(self.backends ?? []).map((b) => b.server ?? "")])];
  // The first exclusive card a backend names, else its first resource; one that names none sits in the machine itself.
  const homeOf = (b: Backend) => (b.resources ?? []).find((r) => resources.some((x) => x.name === r && !x.shared)) ?? (b.resources ?? [])[0] ?? "";
  const order = [...resources.filter((r) => !r.shared), ...resources.filter((r) => r.shared)].map((r) => r.name);
  let y = 0;
  for (const machine of machines) {
    const members = (self.backends ?? []).filter((b) => (b.server ?? "") === machine);
    if (members.length === 0 && (machine === "" || !framed)) continue;
    const frame = framed ? `machine:${machine}` : undefined;
    const left = frame ? FRAME.pad : X.group;
    let top = frame ? FRAME.head : y;
    const inside: Node[] = [];
    let wide = W + PAD * 2;
    const keys = [...new Set(members.map(homeOf))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
    for (const key of keys) {
      const group = key === "" ? undefined : `resource:${frame ? `${machine}/` : ""}${key}`;
      const r: Resource | undefined = resources.find((x) => x.name === key);
      const cards: Node[] = [];
      const mine = members.filter((m) => homeOf(m) === key);
      // Many small backends read as chips behind one line; a few big ones keep a card and a line each.
      const chips = group !== undefined && mine.length > 3;
      const width = chips ? 2 * 150 + 6 + 24 : W + PAD * 2;
      const height = chips ? HEAD + 4 + Math.ceil(mine.length / 2) * 38 + 6 : (group ? HEAD + PAD : 0) + mine.length * H + (mine.length - 1) * GAP;
      wide = Math.max(wide, width);
      if (!chips) mine.forEach((b, n) => {
        const run = runningIds.get(b.name) ?? [];
        cards.push({
          id: `backend:${b.name}`, type: "card", ...(group ?? frame ? { parentId: group ?? frame, extent: "parent" as const } : {}),
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
        const all = mine.flatMap((b) => runningIds.get(b.name) ?? []);
        if (chips) edges.push({ id: `e:${group}`, source: hub, target: group, type: "flow", data: { jobs: all, pulses: pulsesFor(`e:${group}`, all) } });
        inside.push({
          id: group, type: "hardware", ...(frame ? { parentId: frame, extent: "parent" as const } : {}), position: { x: left, y: top }, style: { width, height },
          data: {
            title: key, hot: all.length > 0, selected: is("resource", key),
            icon: r?.kind === "cpu" ? <Cpu size={13} /> : <CircuitBoard size={13} />,
            sub: r?.shared ? "shared" : r?.holder ? `· in use by ${r.holder}` : r ? "· not in use" : "",
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
      nodes.push({
        id: frame, type: "machine", position: { x: X.group - FRAME.pad, y }, style: { width: wide + FRAME.pad * 2, height },
        data: { title: machine || self.name, sub: machine ? (members.length ? "" : "nothing on it yet") : "this machine" } satisfies Machine,
      });
    }
    nodes.push(...inside);
    y += height + 24;
  }
  const mid = Math.max(y - 24, H) / 2;
  if (router) {
    // What stands between this node and its hardware: routing decides which backend a request runs on.
    const local = d.q.jobs.filter((j) => j.state === "running").map((j) => j.id);
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
  nodes.unshift({
    id: "self", type: "card", position: { x: X.self, y: mid - H / 2 - (router ? H + 56 : 0) },
    data: {
      title: self.name, icon: <Flame size={14} className="text-accent" />, tone: "accent", selected: is("self", self.name),
      sub: `${d.q.jobs.filter((j) => j.state === "running").length} running · ${d.q.jobs.filter((j) => j.state === "queued").length} queued`,
    } satisfies Card,
  });

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

/** The freshly laid-out nodes, with the one being dragged left where the pointer has it: everything else is redrawn as it now is. */
export const held = (fresh: Node[], now: Node[], dragging: string | null): Node[] =>
  (dragging === null ? fresh : fresh.map((n) => (n.id === dragging ? { ...n, position: now.find((x) => x.id === n.id)?.position ?? n.position } : n)));

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

const ROUTER = "hearth.router";

export function Topology() {
  const data = useStore((s) => s.data)!;
  const sel = useStore((s) => s.sel);
  const dark = document.documentElement.classList.contains("dark");
  // The router is drawn unless this browser was told not to.
  const [router, setRouter] = useState(() => { try { return localStorage.getItem(ROUTER) !== "off"; } catch { return true; } });
  const flip = () => setRouter((on) => { try { localStorage.setItem(ROUTER, on ? "off" : "on"); } catch { /* per-browser nicety only */ } return !on; });
  const laid = useMemo(() => layout(data, sel, router), [data.net, data.q.jobs, data.flows, sel, router]);
  // A drag moves the node until it is let go; what the node reports meanwhile must not put it back.
  const [nodes, setNodes] = useState(laid.nodes);
  const dragging = useRef<string | null>(null);
  useEffect(() => setNodes((now) => held(laid.nodes, now, dragging.current)), [laid]);

  return (
    <ReactFlow
      nodes={nodes} edges={laid.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnDoubleClick={false}
      minZoom={0.3} maxZoom={1.5} onInit={(rf) => arrive(rf)}
      colorMode={dark ? "dark" : "light"} proOptions={{ hideAttribution: true }}
      onNodesChange={(changes) => setNodes((ns) => applyNodeChanges(changes, ns))}
      onNodeDragStart={(_, n) => { dragging.current = n.id; }}
      onNodeDragStop={() => { dragging.current = null; }}
      onNodeClick={(_, n) => {
        const [kind, ...rest] = n.id.split(":");
        const id = kind === "self" ? data.net.nodes.find((x) => x.self)!.name : rest.join(":");
        if (kind === "router") go("routing");
        else if (kind === "self" || kind === "peer" || kind === "backend") select({ kind, id });
        else if (kind === "resource") select({ kind, id: id.split("/").pop()! });
      }}
      onPaneClick={() => select(null)}
    >
      <Background gap={20} size={1} color="var(--border)" />
      <Controls showInteractive={false} position="bottom-left" />
      <label className="absolute right-3 top-3 z-10 flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-panel/95 px-2 py-1 text-[11px] text-dim">
        <input type="checkbox" checked={router} onChange={flip} />show the router
      </label>
    </ReactFlow>
  );
}
