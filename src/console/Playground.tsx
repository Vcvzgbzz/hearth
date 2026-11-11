/**
 * The Playground: talk to any name the node serves, or two side by side, and see where each answer
 * ran and how fast. Conversations live in this tab's memory only: a walk to another page keeps them,
 * a reload clears them, and the node stores nothing of them beyond its usual request record.
 */
import { ChevronDown, Copy, Square } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";

import { chatNames, factsLine, segments, StreamParser, totalMs } from "./chat.js";
import { chooseAt, type Choice } from "./editStore.js";
import { Menu } from "./editor.js";
import { authed, toast, useStore } from "./store.js";
import { Button, Card, cx, mono, Pill, Switch } from "./ui.js";
import type { RequestTrace } from "../observe/uidata.js";

interface Msg {
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  error?: string;
  facts?: string;
  id?: string;
  /** Start to end, for the "faster" pill. */
  ms?: number;
  busy?: boolean;
}
interface Pane { model: string | null; msgs: Msg[] }
interface Play {
  /** Always two; the second shows while comparing. */
  panes: Pane[];
  compare: boolean;
  system: string;
  maxTokens: number;
  temperature: string;
  stop: AbortController | null;
}

const usePlay = create<Play>(() => ({
  panes: [{ model: null, msgs: [] }, { model: null, msgs: [] }],
  compare: false,
  system: "",
  maxTokens: 1024,
  temperature: "",
  stop: null,
}));

/** Change the last message of pane `i`. */
const patch = (i: number, m: Partial<Msg>) => usePlay.setState((s) => {
  const panes = [...s.panes];
  const msgs = panes[i]!.msgs;
  panes[i] = { ...panes[i]!, msgs: [...msgs.slice(0, -1), { ...msgs.at(-1)!, ...m }] };
  return { panes };
});

/** The node's own record of a request; it is written as the request ends, so a miss is asked once more. */
async function traceOf(id: string): Promise<RequestTrace | null> {
  for (let n = 0; n < 2; n++) {
    try {
      const r = await fetch(`/ui/requests/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (r.ok) return (await r.json()) as RequestTrace;
    } catch { /* the headers and the page's own clock stand in */ }
    await new Promise((res) => setTimeout(res, 400));
  }
  return null;
}

async function ask(i: number, model: string, history: Msg[], signal: AbortSignal): Promise<void> {
  const s = usePlay.getState();
  const messages = [
    ...(s.system.trim() ? [{ role: "system", content: s.system }] : []),
    ...history.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.text })),
  ];
  const temp = s.temperature.trim() === "" ? NaN : Number(s.temperature);
  const body = { model, stream: true, max_tokens: s.maxTokens, messages, ...(Number.isFinite(temp) ? { temperature: temp } : {}) };
  const t0 = performance.now();
  let first: number | undefined;
  let id: string | null = null;
  let named: string | null = null;
  const p = new StreamParser();
  let error: string | undefined;
  try {
    const r = await authed("POST", "/v1/chat/completions", body, signal);
    id = r.headers.get("x-request-id");
    named = r.headers.get("x-hearth-model");
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { error?: { message?: string } | string };
      throw new Error(typeof d.error === "string" ? d.error : d.error?.message ?? `failed (${r.status})`);
    }
    const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      p.push(value);
      if (first === undefined && (p.reply.text || p.reply.reasoning)) first = performance.now() - t0;
      patch(i, { text: p.reply.text, reasoning: p.reply.reasoning });
    }
    error = p.end().error;
  } catch (e) {
    error = signal.aborted ? undefined : e instanceof Error ? e.message : String(e);
  }
  const ms = Math.round(performance.now() - t0);
  const { text, reasoning } = p.reply;
  patch(i, { text, reasoning, error, id: id ?? undefined, busy: false, ...(signal.aborted ? { facts: "stopped" } : {}) });
  if (id === null) return;
  const t = await traceOf(id);
  const facts = t ? factsLine(t) : factsLine({ model: named ?? p.reply.model, runMs: ms, firstByteMs: first, tokensOut: p.reply.tokens });
  patch(i, {
    facts: signal.aborted ? `stopped · ${facts}` : facts,
    ms: t ? totalMs(t) : ms,
    ...(!error && !text && t && !t.ok ? { error: t.error ?? "the request failed" } : {}),
  });
}

/** Send one user message to every pane showing, each to the name it has picked. */
function send(text: string, names: string[]): void {
  const s = usePlay.getState();
  const stop = new AbortController();
  const shown = s.compare ? [0, 1] : [0];
  const panes = [...s.panes];
  const jobs: [number, string, Msg[]][] = [];
  for (const i of shown) {
    const p = panes[i]!;
    const model = p.model !== null && names.includes(p.model) ? p.model : names[0]!;
    const history = [...p.msgs, { role: "user" as const, text }];
    panes[i] = { model, msgs: [...history, { role: "assistant", text: "", busy: true }] };
    jobs.push([i, model, history]);
  }
  usePlay.setState({ panes, stop });
  void Promise.all(jobs.map(([i, m, h]) => ask(i, m, h, stop.signal))).then(() => {
    if (usePlay.getState().stop === stop) usePlay.setState({ stop: null });
  });
}

function Code({ text }: { text: string }) {
  return (
    <div className="relative my-1.5 rounded-lg border border-line bg-bg">
      <button type="button" aria-label="copy" title="copy" className="absolute right-1.5 top-1.5 text-dim hover:text-fg"
              onClick={() => void navigator.clipboard.writeText(text).then(() => toast("ok", "copied"), () => {})}><Copy size={13} /></button>
      <pre className={cx("overflow-x-auto p-3 pr-8", mono)}>{text}</pre>
    </div>
  );
}

function Message({ m, faster }: { m: Msg; faster: boolean }) {
  if (m.role === "user") return <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2">{m.text}</div>;
  return (
    <div className="min-w-0">
      {m.reasoning && (
        <details className="mb-1 text-dim">
          <summary className="cursor-pointer text-[12px]">reasoning</summary>
          <div className="whitespace-pre-wrap text-[12px]">{m.reasoning}</div>
        </details>
      )}
      {segments(m.text).map((s, k) => s.code ? <Code key={k} text={s.text} /> : <div key={k} className="whitespace-pre-wrap">{s.text}</div>)}
      {m.error && <div className="text-bad">{m.error}</div>}
      {m.busy && !m.text && !m.reasoning && <div className="text-dim">…</div>}
      {!m.busy && !m.error && !m.text && !m.facts && <div className="text-dim">(no text)</div>}
      {(m.facts || faster) && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-dim">
          {faster && <Pill tone="ok">faster</Pill>}
          {m.facts && <span>{m.facts}</span>}
          {m.id && <a className="underline hover:text-fg" href={`#requests/${encodeURIComponent(m.id)}`}>trace</a>}
        </div>
      )}
    </div>
  );
}

function PaneView({ i, types, models, faster }: { i: number; types: string[]; models: string[]; faster: boolean }) {
  const p = usePlay((s) => s.panes[i]!);
  const names = [...types, ...models];
  const cur = p.model !== null && names.includes(p.model) ? p.model : names[0];
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => { if (atBottom.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [p.msgs]);
  const pick = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const item = (m: string): Choice => ({ label: m, value: m, mono: true, on: m === cur });
    const items: Choice[] = types.length && models.length
      ? [{ label: "types", head: true }, ...types.map(item), { label: "models, by their own name", head: true }, ...models.map(item)]
      : names.map(item);
    chooseAt(r.left, r.bottom + 4, items, (model) => usePlay.setState((s) => {
      const panes = [...s.panes];
      panes[i] = { ...panes[i]!, model };
      return { panes };
    }), true);
  };
  return (
    <Card className="flex min-h-[260px] min-w-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-dim">asking for</span>
        <button type="button" aria-label="the name asked for" disabled={!cur} onClick={pick}
                className={cx("flex h-8 items-center gap-1.5 rounded-lg border border-line bg-bg px-2.5 hover:bg-muted", mono)}>
          {cur ?? "nothing to ask for"}<ChevronDown size={12} className="text-dim" />
        </button>
      </div>
      <div ref={box} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3"
           onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {p.msgs.length === 0 && <div className="m-auto text-dim">Ask something below.</div>}
        {p.msgs.map((m, k) => <Message key={k} m={m} faster={faster && k === p.msgs.length - 1} />)}
      </div>
    </Card>
  );
}

/** The pane whose last answer finished sooner, once both have finished well. */
function fasterOf(panes: Play["panes"]): number | null {
  const [a, b] = panes.map((p) => p.msgs.at(-1));
  const ok = (m: Msg | undefined) => m?.role === "assistant" && !m.busy && !m.error && m.ms !== undefined;
  if (!ok(a) || !ok(b) || a!.ms === b!.ms) return null;
  return a!.ms! < b!.ms! ? 0 : 1;
}

export function Playground() {
  const data = useStore((s) => s.data)!;
  const { compare, system, maxTokens, temperature, stop, panes } = usePlay();
  const [showSystem, setShowSystem] = useState(false);
  const [draft, setDraft] = useState("");
  const { types, models } = chatNames(Object.values(data.flows ?? {}), data.catalog);
  const names = [...types, ...models];
  const busy = stop !== null;
  const fast = compare ? fasterOf(panes) : null;
  const go = () => {
    if (busy || draft.trim() === "" || names.length === 0) return;
    send(draft, names);
    setDraft("");
  };
  const field = "h-8 rounded-lg border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2"><Switch on={compare} label="compare" onChange={(on) => usePlay.setState({ compare: on })} />compare</label>
        <button type="button" aria-expanded={showSystem} className="flex items-center gap-1 text-dim hover:text-fg" onClick={() => setShowSystem((v) => !v)}>
          system prompt{system.trim() ? " (set)" : ""}<ChevronDown size={12} className={cx("transition-transform", showSystem && "rotate-180")} />
        </button>
        <label className="flex items-center gap-1.5 text-dim">max tokens
          <input type="number" min={1} value={maxTokens} className={cx(field, "w-20")}
                 onChange={(e) => usePlay.setState({ maxTokens: Math.max(1, Math.round(Number(e.target.value)) || 1) })} />
        </label>
        <label className="flex items-center gap-1.5 text-dim">temperature
          <input type="number" min={0} step={0.1} value={temperature} placeholder="default" className={cx(field, "w-20")}
                 onChange={(e) => usePlay.setState({ temperature: e.target.value })} />
        </label>
        <Button disabled={busy} onClick={() => usePlay.setState((s) => ({ panes: s.panes.map((p) => ({ ...p, msgs: [] })) }))}>Clear</Button>
        <span className="text-[11px] text-dim">Prompts and replies stay in this browser tab; the node does not store them.</span>
      </div>
      {showSystem && (
        <textarea aria-label="system prompt" rows={3} value={system} placeholder="a system prompt sent first to every pane"
                  onChange={(e) => usePlay.setState({ system: e.target.value })}
                  className="rounded-lg border border-line bg-bg p-2 text-[13px] focus:border-accent focus:outline-none" />
      )}
      <div className={cx("grid min-h-0 flex-1 gap-3 overflow-auto", compare && "lg:grid-cols-2")}>
        <PaneView i={0} types={types} models={models} faster={fast === 0} />
        {compare && <PaneView i={1} types={types} models={models} faster={fast === 1} />}
      </div>
      <div className="flex items-end gap-2">
        <textarea aria-label="message" rows={2} value={draft} placeholder={names.length ? "Message — Enter sends, Shift+Enter is a new line" : "This node serves nothing to chat with."}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } }}
                  className="min-w-0 flex-1 resize-y rounded-lg border border-line bg-bg p-2 text-[13px] focus:border-accent focus:outline-none" />
        {busy
          ? <Button onClick={() => stop.abort()}><Square size={12} />stop</Button>
          : <Button tone="primary" disabled={draft.trim() === "" || names.length === 0} onClick={go}>send</Button>}
      </div>
      <Menu />
    </div>
  );
}
