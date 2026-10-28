/**
 * Where requests go: the names this node answers to that are routed somewhere, the rules some of
 * them pass through, what a rule's lines end at and what they set off. Only what is routed is
 * drawn. The nodes are flowNodes.tsx's; what a drawn line changes is draft.ts's.
 */
import { applyNodeChanges, Background, Controls, MiniMap, ReactFlow, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ANY, beside as besideLines, directTo, draftView, factsOf, groupRows, list, nodeOf, ordered, orderOf, placedOn, refusal, restOf, spread, toOf, unchecked, type End, type Facts, type To } from "./draft.js";
import { connect, editSelect, pick, place, useEdit, type EditSel, type Tried, selectMany } from "./editStore.js";
import { contextMenu } from "./editor.js";
import { HUE, takesWork, VIEWS, type ActionBox, type Dest, type FastestBox, type Hub, type OrderBox, type RefuseBox, type SwitchBox } from "./flowNodes.js";
import { arrive, edgeTypes, held, type Line } from "./Topology.js";
import type { UiData } from "./types.js";
import { useStore } from "./store.js";

/** What the draft adds to the picture: what a rule may name, the request being tried, and what is known about each model. */
type Editing = { /** The router whose rules these are; null for the default one. */ router: string | null; /** What becomes of a name no rule takes. */ rest: Hub["rest"]; models: string[]; lanes: string[]; tried: Tried | null; asked: string | null; pending: string[]; facts: Facts; /** Rules the draft has changed: what was counted on their lines no longer lines up. */ changed: (rule: string) => boolean };

/** Widths and heights the layout steps by. A node drawn beside a rule is `SIDE` tall, plus a row per place for a fastest-of. */
const RULE = { width: 640, head: 36, row: 32 };
const SIDE = { refuse: 66, fastest: 70, place: 28, action: 70 };
const GAP = 24;

/** What each kind of box is on the small map in the corner: the same theme colours the box itself wears. */
const MINI: Record<string, string> = { hub: "var(--dim)", flow: "var(--info)", fastest: "var(--pick)", order: "var(--pick)", refuse: "var(--bad)", action: "var(--warn)" };

/** How tall the node a line's target is drawn as beside its rule; 0 for a model, a peer or another rule, which are not drawn there. */
const sideOf = (to: To, order?: End[]): number => (to.kind === "refuse" ? SIDE.refuse : to.kind === "fastest" ? SIDE.fastest + to.of.length * SIDE.place
  : order ? SIDE.fastest + (order.length + 1) * SIDE.place : 0);

/**
 * Names | rules, a column per step of hand-on | what the lines end at. Deterministic, so nothing
 * moves per tick; a node placed by hand stays where it was put.
 */
function layout(d: UiData, sel: EditSel, edit?: Editing) {
  const self = d.net.nodes.find((n) => n.self)!;
  const peers = d.net.nodes.filter((n) => !n.self);
  const is = (kind: string, id: string) => sel?.kind === kind && sel.id === id;
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Where a tried request went: the line that decided in each rule, and the model or peer it reached.
  const tried = edit?.tried && !edit.tried.error ? edit.tried : null;
  const decided = new Map((tried?.path ?? []).map((p) => [p.flow, p.step]));
  const reaches = (e: End) => tried !== null && (e.kind === "peer" ? tried.target === "peer" && tried.peer === e.peer : tried.target === "local" && tried.model === e.model);

  // A flow that only says "this name runs there" is a line from the name; the rest are rules, drawn as nodes.
  const direct = new Map<string, End>();
  // The flow for every other name, while it only says "run it" or "refuse it", is a line on the router and not a rule of its own.
  const plainRest = ([, f]: [string, { inputs: string[]; steps: { when?: unknown; to?: unknown; do?: unknown; plugins?: unknown }[] }]) =>
    f.inputs.includes(ANY) && f.steps.length === 1 && ["asked", "refuse"].includes(toOf(f.steps[0]!.to).kind) && list(f.steps[0]!.do).length === 0 && placedOn(f.steps[0]!).length === 0;
  // A flow that is only an order to try places in is a node of its own and not a rule: beside the first line that hands to it.
  const orders = new Map<string, End[]>();
  for (const [name, f] of Object.entries(d.flows ?? {})) { const ends = orderOf(f); if (ends) orders.set(name, ends); }
  const seat = new Map<string, string>();
  for (const [name, f] of Object.entries(d.flows ?? {})) if (!orders.has(name)) f.steps.forEach((s, i) => { const to = toOf(s.to); if (to.kind === "flow" && orders.has(to.flow) && !seat.has(to.flow)) seat.set(to.flow, `${name}:${i}`); });
  /** The order drawn beside line `i` of a rule, where that line is the first to hand to it. */
  const seated = (rule: string, i: number, to: To) => (to.kind === "flow" && seat.get(to.flow) === `${rule}:${i}` ? orders.get(to.flow) : undefined);
  const flows = Object.entries(d.flows ?? {}).filter((entry) => {
    const [name, f] = entry;
    if (plainRest(entry) || orders.has(name)) return false;
    const to = directTo(name, f);
    if (to) direct.set(name, to);
    return to === null;
  });
  const handsTo = (name: string) => flows.filter(([n, f]) => n !== name && f.steps.some((s) => { const to = toOf(s.to); return to.kind === "flow" && to.flow === name; }));
  // A rule sits one column past the deepest rule that hands work to it.
  const depth = new Map<string, number>();
  const deep = (name: string, seen: string[] = []): number => {
    if (depth.has(name)) return depth.get(name)!;
    const from = handsTo(name).filter(([n]) => !seen.includes(n));
    const at = from.length ? 1 + Math.max(...from.map(([n]) => deep(n, [...seen, name]))) : 0;
    depth.set(name, at);
    return at;
  };
  const columns = flows.length ? 1 + Math.max(...flows.map(([n]) => deep(n))) : 0;
  // An action is drawn beside the first rule with a line that runs it; one nothing runs waits under the names.
  const actions = Object.entries(d.actions ?? {});
  const home = new Map<string, string>();
  for (const [name, f] of flows) for (const s of f.steps) for (const a of list(s.do)) if (!home.has(a) && d.actions?.[a]) home.set(a, name);
  const homed = (rule: string) => actions.filter(([a]) => home.get(a) === rule);
  // A column is as wide as its rules, plus room for what is drawn beside them.
  const beside = (col: number) => flows.some(([n, f]) => depth.get(n) === col && (homed(n).length > 0 || f.steps.some((s, i) => sideOf(toOf(s.to), seated(n, i, toOf(s.to))) > 0)));
  const colX: number[] = [];
  let x = 330;
  for (let col = 0; col < columns; col++) { colX.push(x); x += RULE.width + (beside(col) ? 280 : 0) + 70; }
  const endX = columns ? x : 420;

  // Only what a line ends at is drawn: the models and peers the rules and the redirected names use.
  let y = 0;
  const used: End[] = [...direct.values(), ...[...orders.values()].flat(), ...flows.flatMap(([, f]) => f.steps.flatMap((s) => { const t = toOf(s.to); return t.kind === "fastest" ? t.of : t.kind === "model" || t.kind === "peer" ? [t] : []; }))];
  /** The models drawn that run on a provider's server: a line to one wears that colour. */
  const away = new Set<string>();
  const kindOf = (e: { kind: string; model?: string | null }): string => (e.kind === "model" && away.has(e.model ?? "") ? "cloud" : e.kind);
  for (const model of new Set(used.flatMap((e) => (e.kind === "model" ? [e.model] : [])))) {
    const on = d.routing?.[model]?.backend ?? (self.backends ?? []).find((b) => (b.serves ?? []).includes(model) || (b.routes ?? []).some((r) => r.model === model))?.name;
    const where = (self.backends ?? []).find((b) => b.name === on);
    if (where?.cloud) away.add(model);
    const fb = (where?.routes ?? []).find((r) => r.fallback && (r.model === model || r.path.includes("{model}")))?.fallback;
    nodes.push({
      id: `model:${model}`, type: "dest", position: { x: endX, y },
      data: {
        hardware: (where?.resources ?? []).map((name) => ({ name, cpu: (d.net.resources ?? []).find((r) => r.name === name)?.kind === "cpu" })),
        title: model, kind: "model", ...(where?.cloud ? { cloud: true } : {}), on: tried?.target === "local" && tried.model === model, ...(edit && edit.facts.kind(model) === "paths" ? { shut: true } : {}),
        sub: on === undefined ? "no backend lists this yet" : `on ${on}${where?.server ? ` · ${where.server}` : ""}`,
        ...(fb && { fallback: `${fb.model} on ${fb.backend}` }),
      } satisfies Dest,
    });
    y += 56;
  }
  for (const name of new Set(used.flatMap((e) => (e.kind === "peer" ? [e.peer] : [])))) {
    const p = peers.find((n) => n.name === name);
    nodes.push({
      id: `peer:${name}`, type: "dest", position: { x: endX, y },
      data: { title: name, kind: "peer", on: tried?.target === "peer" && tried.peer === name, down: !p?.up, sub: p?.up ? `a peer · lends you ${Object.keys(p.map ?? {}).length}` : "a peer · cannot be reached" } satisfies Dest,
    });
    y += 56;
  }
  // Everything hangs from the top: adding a line or a rule grows the picture downward and moves nothing that was there.

  // Only names that are routed somewhere are drawn. The rest go to their own model, which needs no picture.
  const all = [...new Set([
    ...(self.backends ?? []).flatMap((b) => b.serves ?? []),
    ...Object.entries(d.routing ?? {}).filter(([, r]) => r.backend !== undefined).map(([id]) => id),
  ])];
  const names = ordered(d.layout, [...new Set([...flows.flatMap(([, f]) => f.inputs), ...direct.keys(), ...(edit?.pending ?? [])])]);
  const ruleOf = (name: string) => flows.find(([, f]) => f.inputs.includes(name))?.[0];
  /** The variants a rule's lines test, its own and those of the rules it hands on to. */
  const variantsIn = (rule: string | undefined, seen: string[] = []): string[] => {
    const f = rule === undefined || seen.includes(rule) ? undefined : d.flows?.[rule];
    if (!f) return [];
    return [...new Set(f.steps.flatMap((s) => { const t = toOf(s.to); return [...list((s.when as Record<string, unknown> | null | undefined)?.variant), ...(t.kind === "flow" ? variantsIn(t.flow, [...seen, rule!]) : [])]; }))];
  };
  const hubHeight = 56 + (names.length ? 22 + names.length * 22 : 0) + 26 + (edit ? 36 : 0);
  nodes.unshift({
    id: "self", type: "hub", position: { x: 0, y: 0 },
    data: {
      // The same router the topology draws between this node and what runs its requests.
      title: edit?.router ? `Router · ${edit.router}` : "Router", editable: Boolean(edit),
      sub: `${self.name} · ${d.q.jobs.filter((j) => j.state === "running").length} running · ${d.q.jobs.filter((j) => j.state === "queued").length} queued`,
      rows: names.map((id) => ({
        id, on: edit?.asked === id && tried !== null, loose: (edit?.pending ?? []).includes(id) && !ruleOf(id) && !direct.has(id),
        to: ruleOf(id) !== undefined ? "flow" : direct.get(id)?.kind ?? "unset",
        variants: variantsIn(ruleOf(id)),
      })),
      others: all.filter((id) => !names.includes(id)),
      rest: edit?.rest ?? (Object.entries(d.flows ?? {}).some(plainRest) ? (Object.entries(d.flows ?? {}).some((e) => plainRest(e) && toOf(e[1].steps[0]!.to).kind === "asked") ? "asked" : "refuse") : flows.some(([, f]) => f.inputs.includes(ANY)) ? "rule" : "none"),
    } satisfies Hub,
  });

  /** A line, in the colour of the kind of thing it goes to. */
  const wire = (id: string, lit: boolean, kind: string, look: Partial<Line> = {}) => ({ id, type: "flow", selectable: false, ...(lit ? { zIndex: 1001 } : {}), data: { jobs: [], pulses: [], wire: true, lit, color: (HUE[kind] ?? HUE.unset!).stroke, ...look } satisfies Line });
  /** A line from an outlet to the model or the peer it ends at. */
  const to = (line: ReturnType<typeof wire>, source: string, handle: string, end: End): void => {
    edges.push({ ...line, source, sourceHandle: handle, target: end.kind === "peer" ? `peer:${end.peer}` : `model:${end.model}` });
  };
  /** An order and the lines from it to each of its places. */
  const order = (name: string, at: { x: number; y: number }, lit: boolean, unused = false): Node => {
    const id = `inorder:${name}`;
    const ends = orders.get(name)!;
    const won = lit ? decided.get(name) ?? -1 : -1;
    ends.forEach((e, k) => to(wire(`e:${id}:${k}`, won === k, kindOf(e)), id, `end-${k}`, e));
    return { id, type: "order", position: at, zIndex: 1000, data: { flow: name, ends, editable: Boolean(edit), selected: is("flow", name), on: lit, ...(won >= 0 ? { lit: won } : {}), unused, takes: d.flows?.[name]?.takes, cloud: [...away] } satisfies OrderBox };
  };
  const action = (name: string, at: { x: number; y: number }, unused = false): Node => ({
    id: `action:${name}`, type: "action", position: at, zIndex: 1000,
    data: { name, kind: d.actions![name]!.kind, says: d.actions![name]!.says, editable: Boolean(edit), selected: is("action", name), on: tried?.actions?.includes(name) ?? false, unused } satisfies ActionBox,
  });

  // Each name's line: into the rule that takes it, else to wherever it was sent. A name that is not chat has none.
  for (const name of names) {
    const rule = ruleOf(name);
    const off = rule !== undefined && d.flows?.[rule]?.off === true;
    // A rule that is off takes nothing: the line to it is drawn faint, and a tried request does not light it.
    const line = wire(`e:ask:${name}`, edit?.asked === name && tried !== null && !off, rule !== undefined ? "flow" : direct.get(name)?.kind ?? "unset", off ? { faint: true } : {});
    if (rule !== undefined) edges.push({ ...line, source: "self", sourceHandle: `ask-${name}`, target: `flow:${rule}` });
    else if (direct.has(name)) to(line, "self", `ask-${name}`, direct.get(name)!);
  }
  /** The nodes drawn beside each rule, which move with it. */
  const rides = new Map<string, string[]>();
  let lowest = hubHeight + GAP;
  for (let col = 0; col < columns; col++) {
    // Rules stand in the order of the names that enter them, so the lines into them do not cross.
    const first = (inputs: string[]) => Math.min(Infinity, ...inputs.map((i) => names.indexOf(i)).filter((i) => i >= 0));
    const here = flows.filter(([n]) => depth.get(n) === col).sort((a, b) => first(a[1].inputs) - first(b[1].inputs) || 0);
    // What is drawn beside a rule, top to bottom: each line's own node, level with the line where there is room, then the rule's actions.
    const sides = ([name, f]: (typeof here)[number]) => {
      let at = 0;
      const tops = f.steps.map((s, i) => {
        const h = sideOf(toOf(s.to), seated(name, i, toOf(s.to)));
        if (h === 0) return 0;
        const top = Math.max(at, RULE.head + i * RULE.row + groupRows(f.steps, i) - 16);
        at = top + h;
        return top;
      });
      // Actions sit below the rule's last line, clear of the lines that leave it for where requests go.
      const actions = Math.max(at, RULE.head + f.steps.length * RULE.row + groupRows(f.steps) + 12);
      return { tops, actions, bottom: homed(name).length ? actions + homed(name).length * SIDE.action : at };
    };
    const tall = (entry: (typeof here)[number]) => Math.max(RULE.head + entry[1].steps.length * RULE.row + groupRows(entry[1].steps) + (edit ? RULE.row : 0), sides(entry).bottom);
    let fy = 0;
    for (const entry of here) {
      const [name, f] = entry;
      const id = `flow:${name}`;
      const editable = Boolean(edit);
      const step = decided.get(name);
      const sideX = colX[col]! + RULE.width + 40;
      const mine: string[] = [];
      nodes.push({
        // Above the lines that pass behind it on their way to what they end at.
        id, type: "flow", position: { x: colX[col]!, y: fy }, zIndex: 1000,
        data: {
          name, inputs: f.inputs, steps: f.steps as SwitchBox["steps"], selected: is("flow", name), editable, lit: step, orders: Object.fromEntries(orders),
          cloud: [...away], models: edit?.models ?? [], lanes: edit?.lanes ?? [], actions: actions.map(([a]) => a), off: f.off, note: f.note, sticky: f.sticky !== undefined, takes: f.takes,
          ...(d.flowHits && !edit?.changed(name) ? { hits: f.steps.map((_, i) => d.flowHits![name]?.[i] ?? 0) } : {}),
          ...(edit ? { marks: f.steps.map((s) => { const t = toOf(s.to); const no = refusal(s.when, t, edit.facts, (f.takes ?? []).length > 0); return no ? { bad: no } : unchecked(s.when, t, edit.facts) ? { unsure: true as const } : null; }) } : {}),
          orphan: f.inputs.length === 0 && handsTo(name).length === 0,
        } satisfies SwitchBox,
      });
      const beside = sides(entry);
      f.steps.forEach((s, i) => {
        const t = toOf(s.to);
        const lit = step === i;
        const line = wire(`e:${id}:${i}`, lit, t.kind === "flow" && orders.has(t.flow) ? "fastest" : kindOf(t));
        if (t.kind === "flow" && orders.has(t.flow)) {
          // The first line that hands to an order has it beside it; any other line is drawn across to it.
          const end = `inorder:${t.flow}`;
          if (seated(name, i, t)) {
            nodes.push(order(t.flow, { x: sideX, y: fy + beside.tops[i]! }, decided.has(t.flow)));
            mine.push(end);
          }
          edges.push({ ...line, source: id, sourceHandle: `step-${i}`, target: end });
        } else if (t.kind === "flow") edges.push({ ...line, source: id, sourceHandle: `step-${i}`, target: `flow:${t.flow}` });
        else if (t.kind === "model" || t.kind === "peer") to(line, id, `step-${i}`, t);
        else if (t.kind === "fastest" || t.kind === "refuse") {
          // A line that ends in a choice or a refusal gets that as a node beside it.
          const end = `${t.kind}:${name}:${i}`;
          const ty = fy + beside.tops[i]!;
          if (t.kind === "refuse") nodes.push({ id: end, type: "refuse", position: { x: sideX, y: ty }, zIndex: 1000, data: { flow: name, step: i, why: t.why, editable, on: lit } satisfies RefuseBox });
          else {
            const won = lit ? t.of.findIndex(reaches) : -1;
            nodes.push({ id: end, type: "fastest", position: { x: sideX, y: ty }, zIndex: 1000, data: { flow: name, step: i, ends: t.of, editable, on: lit, ...(won >= 0 ? { lit: won } : {}) } satisfies FastestBox });
            t.of.forEach((e, k) => to(wire(`e:${end}:${k}`, won === k, kindOf(e)), end, `end-${k}`, e));
          }
          edges.push({ ...line, source: id, sourceHandle: `step-${i}`, target: end });
          mine.push(end);
        }
        // What a line sets off is a dashed line of its own: it is beside where the request goes, not instead of it.
        for (const a of list(s.do)) if (d.actions?.[a]) edges.push({ ...wire(`e:${id}:${i}:do:${a}`, lit && tried !== null, "action", { ghost: true }), source: id, sourceHandle: `step-${i}`, target: `action:${a}` });
      });
      homed(name).forEach(([a], k) => {
        nodes.push(action(a, { x: sideX, y: fy + beside.actions + k * SIDE.action }));
        mine.push(`action:${a}`);
      });
      rides.set(id, mine);
      fy += tall(entry) + GAP;
    }
    lowest = Math.max(lowest, fy);
  }
  // An action no line runs yet waits under the rules, clear of the map's own buttons in the corner.
  actions.filter(([a]) => !home.has(a)).forEach(([a], k) => nodes.push(action(a, { x: colX[0] ?? 330, y: lowest + k * SIDE.action }, true)));
  // So does an order no line hands to yet: a copy just pasted, say.
  let waiting = lowest;
  for (const name of orders.keys()) if (!seat.has(name)) { nodes.push(order(name, { x: (colX[0] ?? 330) + 260, y: waiting }, false, true)); waiting += SIDE.fastest + (orders.get(name)!.length + 1) * SIDE.place + GAP; }

  // What was placed by hand stays there, and a rule carries the nodes beside it unless one of those was placed on its own.
  const placed = (id: string) => d.layout?.[`routing/${id}`];
  for (const n of nodes) {
    if (edit) n.draggable = true;
    const at = placed(n.id);
    if (!at) continue;
    const [dx, dy] = [at.x - n.position.x, at.y - n.position.y];
    n.position = { x: at.x, y: at.y };
    for (const g of nodes) if (rides.get(n.id)?.includes(g.id) && !placed(g.id)) g.position = { x: g.position.x + dx, y: g.position.y + dy };
  }
  // A model or a peer nobody placed sits level with the lines that reach it. Where a line leaves its node:
  const at = new Map(nodes.map((n) => [n.id, n.position]));
  const leaves = (e: Edge): number => {
    const top = at.get(e.source)?.y ?? 0;
    const n = Number(/-(\d+)$/.exec(e.sourceHandle ?? "")?.[1] ?? 0);
    if (e.source === "self") return top + 78 + Math.max(0, names.indexOf((e.sourceHandle ?? "").slice(4))) * 22 + 11;
    return e.source.startsWith("flow:") ? top + RULE.head + n * RULE.row + RULE.row / 2 : top + 50 + n * SIDE.place + SIDE.place / 2;
  };
  const free = nodes.filter((n) => n.type === "dest" && !placed(n.id));
  const level = besideLines(free.map((n) => n.id), (id) => edges.filter((e) => e.target === id).map(leaves), 60);
  for (const n of free) n.position = { x: n.position.x, y: level.get(n.id) ?? n.position.y };
  return { nodes, edges, rides };
}

/** The routing map: drawn from the draft while there is a file to edit, else from what is in force. */
export function Routing() {
  const data = useStore((s) => s.data)!;
  const edit = useEdit();
  const editing = edit.draft !== null;
  const dark = document.documentElement.classList.contains("dark");
  const laid = useMemo(() => {
    if (!edit.draft) return layout(data, null);
    const view = draftView(edit.draft, data);
    const self = view.net.nodes.find((n) => n.self);
    const models = [...new Set([...(view.catalog ?? []), ...(self?.backends ?? []).flatMap((b) => b.serves ?? []), ...Object.keys((edit.draft.models ?? {}) as object)])].sort();
    const lanes = Object.keys(((edit.draft.scheduler as { lanes?: object } | undefined)?.lanes ?? {}) as object);
    return layout(view, edit.sel, { router: edit.router, rest: restOf(edit.draft).mode, models, lanes, tried: edit.tried, asked: edit.trial?.model ?? null, pending: edit.pending, facts: factsOf(edit.draft, data),
      // What was counted is the default router's: on another router's map no line shows a count.
      changed: (rule) => edit.router !== null || JSON.stringify((edit.draft!.flows as Record<string, unknown> | undefined)?.[rule]) !== JSON.stringify((edit.file?.doc?.flows as Record<string, unknown> | undefined)?.[rule]) });
  }, [edit.draft, edit.file, edit.router, edit.sel, edit.tried, edit.pending, data.net, data.q.jobs, data.routing, data.layout, data.flows, data.actions, data.flowHits]);
  // A drag moves the node until it is let go; what the node reports meanwhile must not put it back.
  const [nodes, setNodes] = useState(laid.nodes);
  const dragging = useRef<string | null>(null);
  // No box lies on another: with each one's size as drawn, one that would overlap moves down past what is above it.
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const fitted = useMemo(() => {
    const ys = spread(laid.nodes.flatMap((n) => (sizes[n.id] ? [{ id: n.id, ...n.position, ...sizes[n.id]! }] : [])), laid.rides);
    return laid.nodes.map((n) => (ys.has(n.id) && ys.get(n.id) !== n.position.y ? { ...n, position: { x: n.position.x, y: ys.get(n.id)! } } : n));
  }, [laid, sizes]);
  // Nodes picked out together stay picked out through a redraw, and where a drag has them while it lasts.
  const many = useEdit((s) => s.many);
  useEffect(() => setNodes((now) => {
    const was = new Map(now.map((n) => [n.id, n]));
    const picked = new Set(useEdit.getState().many.map((m) => m.node));
    return held(fitted, now, dragging.current).map((n) => (picked.has(n.id) ? { ...n, selected: true, ...(dragging.current && was.get(n.id) ? { position: was.get(n.id)!.position } : {}) } : n));
  }), [fitted, many]);
  // The line under the pointer is drawn as strongly as one a tried request takes, so it can be followed through a
  // crossing. Only the lines are redrawn for it: touching the nodes would cut off a drag that is just starting.
  const edges = useMemo(() => (edit.hover === null ? laid.edges : laid.edges.map((e) => (e.id === edit.hover ? { ...e, zIndex: 1001, data: { ...e.data, lit: true } } : e))), [laid.edges, edit.hover]);

  // A node asked for by the search or a menu is brought into view; `*` is the whole map.
  const flow = useRef<ReactFlowInstance | null>(null);
  useEffect(() => {
    const rf = flow.current;
    if (!rf || !edit.focus) return;
    // A rule that is drawn as an order is found under that node's id.
    const asked = edit.focus.node;
    const node = asked.startsWith("flow:") && !laid.nodes.some((n) => n.id === asked) && laid.nodes.some((n) => n.id === `inorder:${asked.slice(5)}`) ? `inorder:${asked.slice(5)}` : asked;
    // After the layout has caught up with whatever was just added.
    const t = setTimeout(() => void rf.fitView(node === "*" ? { padding: 0.08, duration: 300 } : { nodes: [{ id: node }], maxZoom: 1, minZoom: 0.7, padding: 0.6, duration: 300 }), 60);
    return () => clearTimeout(t);
  }, [edit.focus]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={VIEWS} edgeTypes={edgeTypes}
      nodesDraggable={false} nodesConnectable={editing} elementsSelectable={editing} zoomOnDoubleClick={false}
      // Ctrl and a drag draws a box round nodes to pick them out together; ctrl and a click adds one. They then move as one.
      selectionKeyCode={["Control", "Meta"]} multiSelectionKeyCode={["Control", "Meta"]} deleteKeyCode={null}
      onSelectionChange={({ nodes: picked }) => selectMany(picked.map((n) => ({ node: n.id, x: n.position.x, y: n.position.y })))}
      // The strip over the map is two rows tall when it has something to say.
      minZoom={0.3} maxZoom={1.5} onInit={(rf) => { flow.current = rf; arrive(rf, 0); }}
      colorMode={dark ? "dark" : "light"} proOptions={{ hideAttribution: true }}
      snapToGrid snapGrid={[20, 20]}
      onNodesChange={(changes) => {
        setNodes((ns) => applyNodeChanges(changes, ns));
        const sized = changes.flatMap((c) => (c.type === "dimensions" && c.dimensions ? [[c.id, { w: c.dimensions.width, h: c.dimensions.height }] as const] : []));
        if (sized.length) setSizes((was) => (sized.every(([id, s]) => was[id]?.w === s.w && was[id]?.h === s.h) ? was : { ...was, ...Object.fromEntries(sized) }));
      }}
      onNodeDragStart={(_, n) => { dragging.current = n.id; }}
      // A box stays where it was let go; its place is kept apart from anything of the same name on the topology.
      onNodeDragStop={(_, n, moved) => { dragging.current = null; if (editing) for (const m of moved.length ? moved : [n]) place(`routing/${m.id}`, m.position); }}
      // A line let go over a node goes to it, anywhere on it; let go over nothing, it asks where to.
      onConnectEnd={(e, c) => {
        if (!c.fromNode || !editing) return;
        const at = "changedTouches" in e ? e.changedTouches[0]! : e;
        const node = document.elementFromPoint(at.clientX, at.clientY)?.closest(".react-flow__node")?.getAttribute("data-id");
        const from = { node: c.fromNode.id, handle: c.fromHandle?.id ?? null };
        if (node && node !== from.node) connect(from, node);
        else if (!node && takesWork(from.node)) pick({ x: at.clientX, y: at.clientY, from });
      }}
      onNodeClick={(_, n) => {
        const at = nodeOf(n.id);
        const open = at.kind.opens?.(at.id);
        if (open && editing) editSelect(open);
      }}
      onPaneClick={() => editSelect(null)}
      // A right-click opens the map's own menu, on empty map or on a node.
      onPaneContextMenu={(e) => { e.preventDefault(); if (editing) contextMenu(e, null); }}
      onNodeContextMenu={(e, n) => { e.preventDefault(); if (editing) contextMenu(e, n.id); }}
    >
      <Background gap={20} size={1} color="var(--border)" />
      <MiniMap
        pannable zoomable
        maskColor={dark ? "rgba(0,0,0,0.6)" : "rgba(90,100,120,0.25)"}
        nodeColor={(n) => MINI[n.type ?? ""] ?? ((n.data as { kind?: string }).kind === "peer" ? "var(--peer)" : "var(--ok)")}
        style={{ width: 160, height: 110, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8 }}
      />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
