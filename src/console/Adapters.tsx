/**
 * An adapter's panel and the note on adding one. An adapter is a `trust: code` plugin: the code runs
 * with hearth's own access, so the page reads it and never writes it — the file is edited by the
 * operator, and a restart is what puts a change in force.
 */
import { ArrowRight, ArrowRightLeft, Play, X } from "lucide-react";
import { useEffect, useState } from "react";

import { ADAPTER_NOTE, adapterLines, adaptLine, scoped, type Doc } from "./draft.js";
import { editSelect, useEdit } from "./editStore.js";
import { go, request, useStore } from "./store.js";
import type { AdapterView } from "../observe/uidata.js";
import { Button, Dialog, cx, mono } from "./ui.js";

/** A field of the try-it form: a label over an input, the way the Config page draws one. */
const FIELD = "h-7 w-full rounded-md border border-line bg-bg px-2 text-[12px] focus:border-accent focus:outline-none";
const LABEL = "text-[10px] uppercase tracking-wide text-dim";

/** What a `try it` run answered: what the side returned, or the code's own complaint. */
type Ran = { ok: true; value: unknown; ms?: number } | { ok: false; error: string; ms?: number };

/** `k=v` lines, as the query field holds them. */
const pairs = (typed: string): Record<string, string> =>
  Object.fromEntries(typed.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const cut = line.indexOf("=");
    return cut <= 0 ? [] : [[line.slice(0, cut).trim(), line.slice(cut + 1).trim()] as [string, string]];
  }));

/** What the last call through it did, in the words the panel uses. */
const lastSaid = (last: AdapterView["last"]): string =>
  last === undefined ? "not called since the node started"
    : last.ok ? `last call ok · ${new Date(last.t).toLocaleTimeString()}`
      : `last call failed on ${last.side}() · ${new Date(last.t).toLocaleTimeString()}: ${last.error ?? "unknown"}`;

/** The whole module, or the reason it is not two sides, in monospace that scrolls rather than grows. */
function Whole({ a }: { a: AdapterView }) {
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wide text-dim">the module</div>
      {a.note !== undefined && <div className="mt-0.5 text-[11px] text-warn">{a.note}</div>}
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre rounded-md border border-line bg-bg p-2 font-mono text-[11px] leading-snug">{a.whole || "the file could not be read"}</pre>
    </div>
  );
}

/** What was selected is no longer there (an undo took the line away): the panel closes itself. */
function Gone() {
  useEffect(() => { editSelect(null); }, []);
  return null;
}

/** One adapter's panel: where it comes from, its code as the two sides a line runs, the lines that name
 *  it, and a sample to run one side against. Everything here reads what the node has, and edits only
 *  the routing draft's lines: the code itself is the operator's file. */
export function AdapterPanel({ name, at }: { name: string; at?: { flow: string; step: number } }) {
  const a = useStore((s) => s.data?.adapters?.adapters.find((x) => x.name === name));
  const full = useEdit((s) => (s.router !== null ? (s.rest ?? s.draft) : s.draft));
  const [side, setSide] = useState<"request" | "response">("request");
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("application/json");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("200");
  const [answer, setAnswer] = useState("");
  const [ran, setRan] = useState<Ran | null>(null);
  const [busy, setBusy] = useState(false);

  if (!a) return <Gone />;
  // Every line of every rulebook that hands it a request, read from the draft where there is one, so
  // taking one off is a change to the draft like any drawn line.
  const used = full !== null ? adapterLines(full, name) : a.used;
  const split = a.request !== null && a.response !== null;
  // A line may be in a router's rulebook rather than the one on screen, so the edit is made on the
  // whole draft and the view taken of it again: taking one off must land on that line, not another.
  const apply = (fn: (d: Doc) => Doc): void => {
    const s = useEdit.getState();
    const wholeNow = s.router !== null ? (s.rest ?? s.draft) : s.draft;
    if (!wholeNow) return;
    const next = fn(wholeNow);
    useEdit.setState({ draft: s.router === null ? next : scoped(next, s.router), rest: next, err: null });
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const out = await request<Ran>("POST", "/ui/adapters/try", {
        adapter: name,
        side,
        req: { method, path, query: pairs(query), contentType: type === "" ? null : type, body: body === "" ? null : body },
        ...(side === "response" ? { res: { status: Number(status) || 200, contentType: type === "" ? null : type, body: answer } } : {}),
      });
      setRan(out);
    } catch (e) {
      setRan({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={name} label={`adapter ${name}`} size="lg" onClose={() => editSelect(null)}>
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mb-1 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-dim">adapter · a plugin a line names</div>
          <div className="mt-0.5 truncate text-[11px] text-dim" title={a.use}>{a.use}</div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="text-dim">each side held to <span className={mono}>{a.timeoutMs} ms</span></span>
        {a.state === "running"
          ? <span className="rounded border border-ok/50 px-1 text-[10px] uppercase text-ok">running</span>
          : <span className="rounded border border-bad/60 px-1 text-[10px] uppercase text-bad" title={a.error ?? undefined}>{a.state === "off" ? "off (--no-plugins)" : "did not start"}</span>}
        <span className={cx("ml-auto", a.last !== undefined && !a.last.ok ? "text-bad" : "text-dim")}>{lastSaid(a.last)}</span>
      </div>
      {a.state !== "running" && a.error !== null && (
        <div className="mb-3 whitespace-pre-wrap rounded-md border border-bad/50 bg-bad/5 p-2 text-[11px] text-bad">A line that names it cannot run: {a.error}</div>
      )}

      <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium">
        <ArrowRightLeft size={13} className="text-dim" />code
        <span className="text-[10px] font-normal text-dim">as the file holds it; read-only</span>
      </div>
      {split ? (
        <>
          <div className="mt-1">
            <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-dim">
              <span className="shrink-0 rounded border border-mcp/60 px-1 text-mcp">in</span>
              <span className="truncate normal-case tracking-normal">request()</span>
              <span className="ml-auto shrink-0 text-[8px] normal-case tracking-normal">the request the plugin is sent</span>
            </div>
            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre rounded-md border border-line bg-bg p-2 font-mono text-[10.5px] leading-snug">{a.request}</pre>
          </div>
          <div className="mt-1">
            <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-dim">
              <span className="shrink-0 rounded border border-api/60 px-1 text-api">out</span>
              <span className="truncate normal-case tracking-normal">response()</span>
              <span className="ml-auto shrink-0 text-[8px] normal-case tracking-normal">the answer the caller gets</span>
            </div>
            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre rounded-md border border-line bg-bg p-2 font-mono text-[10.5px] leading-snug">{a.response}</pre>
          </div>
        </>
      ) : <Whole a={a} />}
      <div className="mt-1 text-[11px] text-dim">{ADAPTER_NOTE}. The node reads it once, at startup.</div>

      <div className="mb-1 mt-4 text-[12px] font-medium">used on</div>
      {used.length === 0 ? (
        <div className="text-[12px] text-warn">No line hands a request to it yet: drag a plugin line's dot onto a block, or pick it under a line's "adapt it".</div>
      ) : (
        <ul className="flex flex-col gap-1 text-[12px]">
          {used.map((line) => {
            const here = at !== undefined && at.flow === line.flow && at.step === line.step && line.router === null;
            return (
              <li key={`${line.router ?? ""}:${line.flow}:${line.step}`} className={cx("flex items-center gap-2 rounded px-1", here && "bg-accent/10")}>
                <span className="min-w-0 flex-1 truncate">
                  <span className={mono}>{line.flow}</span> line {line.step + 1}
                  <span className="text-dim"> · {line.router === null ? "the default rules" : `router ${line.router}`}</span>
                </span>
                <button type="button" aria-label={`take ${name} off ${line.flow} line ${line.step + 1}`} title={here ? "take it off this line" : "take it off this line"}
                        className="shrink-0 text-dim hover:text-bad" onClick={() => apply((d) => adaptLine(d, line, null))}><X size={12} /></button>
              </li>
            );
          })}
        </ul>
      )}
      {used.length > 0 && <div className="mt-1 text-[11px] text-dim">Taking it off a line leaves the plugin declared: it is still under <span className={mono}>plugins:</span>, just named by nothing.</div>}

      <div className="mb-1 mt-4 flex items-center gap-2 text-[12px] font-medium">
        try it
        <div className="ml-auto flex items-center gap-1">
          {(["request", "response"] as const).map((s) => (
            <button key={s} type="button" onClick={() => { setSide(s); setRan(null); }}
                    className={cx("h-6 rounded-md border px-2 text-[11px]", side === s ? "border-accent bg-accent/10 text-fg" : "border-line text-dim hover:text-fg")}>
              {s}()
            </button>
          ))}
        </div>
      </div>
      <div className="text-[11px] text-dim">A sample on the other end: only the adapter runs, and hearth sends nothing anywhere for it.</div>
      <div className="mt-2 grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
        <span className={LABEL}>method</span>
        <input aria-label="method" className={cx(FIELD, mono)} value={method} onChange={(e) => { setMethod(e.target.value); setRan(null); }} />
        <span className={LABEL}>path</span>
        <input aria-label="path" className={cx(FIELD, mono)} value={path} onChange={(e) => { setPath(e.target.value); setRan(null); }} />
        <span className={LABEL}>query</span>
        <textarea aria-label="query, one k=v per line" rows={2} placeholder={"q=hello\npage=2"} className={cx(FIELD, mono, "h-auto resize-y py-1")} value={query} onChange={(e) => { setQuery(e.target.value); setRan(null); }} />
        <span className={LABEL}>type</span>
        <input aria-label="content type" placeholder="application/json" className={cx(FIELD, mono)} value={type} onChange={(e) => { setType(e.target.value); setRan(null); }} />
        {side === "request" ? (
          <>
            <span className={LABEL}>body</span>
            <textarea aria-label="body" rows={3} className={cx(FIELD, mono, "h-auto resize-y py-1")} value={body} onChange={(e) => { setBody(e.target.value); setRan(null); }} />
          </>
        ) : (
          <>
            <span className={LABEL}>status</span>
            <input aria-label="answer status" type="number" className={cx(FIELD, "tabular")} value={status} onChange={(e) => { setStatus(e.target.value); setRan(null); }} />
            <span className={LABEL}>answer</span>
            <textarea aria-label="answer body" rows={3} className={cx(FIELD, mono, "h-auto resize-y py-1")} value={answer} onChange={(e) => { setAnswer(e.target.value); setRan(null); }} />
          </>
        )}
      </div>
      <button type="button" disabled={busy || a.state !== "running"} onClick={() => void run()}
              title={a.state !== "running" ? "it did not start, so its code is not loaded" : undefined}
              className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-accent bg-accent/10 px-3 text-[12px] text-fg hover:bg-accent/20 disabled:opacity-50">
        <Play size={12} />{busy ? "running…" : `run ${side}()`}
      </button>
      {ran !== null && (
        <div className="mt-2">
          <div className={cx("text-[11px] font-medium", ran.ok ? "text-ok" : "text-bad")}>{ran.ok ? `${side}() returned` : `${side}() failed`}</div>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg p-2 font-mono text-[11px]">{ran.ok ? JSON.stringify(ran.value, null, 2) : ran.error}</pre>
          {ran.ok && side === "request" && (ran.value === null || ran.value === undefined) && (
            <div className="mt-1 text-[11px] text-warn">null: on a line this means the request has no counterpart on that plugin's API, so the line fails and the next one is tried.</div>
          )}
        </div>
      )}
    </div>
    </Dialog>
  );
}

/** What a new adapter's module starts as: both sides, each passing its value straight through. */
export const ADAPTER_STARTER = `export default {
  apiVersion: 1,
  kinds: {},
  setup() {
    return {
      adapt: {
        // The request the plugin is sent, as only the fields it changes; null when this line has
        // no counterpart for it, which sends the request on to the next line.
        request(req) {
          return req;
        },
        // The plugin's 2xx answer, in the shape the caller asked for.
        response(res, req) {
          return res;
        },
      },
    };
  },
};
`;

/** The name a typed one becomes, or null when nothing usable is left: lowercase letters, digits and dashes. */
export const adapterName = (raw: string): string | null => {
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : null;
};

/** Copy a block of text, saying so. */
function Copy({ what, text: value }: { what: string; text: string }) {
  const [said, setSaid] = useState(false);
  return (
    <button type="button" className="ml-auto shrink-0 text-[10px] text-dim hover:text-fg"
            onClick={() => void navigator.clipboard.writeText(value).then(() => { setSaid(true); setTimeout(() => setSaid(false), 1500); }, () => {})}>
      {said ? "copied" : `copy the ${what}`}
    </button>
  );
}

/** How to add an adapter: it is a plugin, so it is a file and an entry in the file, then a restart. */
export function NewAdapterDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("my-adapter");
  const made = adapterName(name) ?? "my-adapter";
  // A `file:` use is read relative to hearth.yaml, so this is the path the entry below names.
  const rel = `./adapters/${made}.mjs`;
  const entry = `plugins:
  ${made}:
    use: file:${rel}   # relative to hearth.yaml
    trust: code                        # it runs inside hearth, with hearth's own access
    timeoutMs: 1000                    # each of request() and response() is held to this`;
  const line = `      - to: { plugin: searxng, adapt: ${made} }`;
  return (
    <Dialog title="An adapter is a plugin" label="how to add an adapter" size="lg" onClose={onClose}>
      <div className="flex flex-col gap-3 overflow-auto p-4 text-[12px]">
        <p className="text-dim">
          A line reshapes what its plugin is sent with an adapter, and an adapter is a <span className={mono}>trust: code</span> plugin
          whose <span className={mono}>setup</span> returns <span className={mono}>{"{ adapt: { request, response } }"}</span>.
          The console does not write code into that file: it runs with hearth's own access, so it is yours to write,
          and a restart is what reads it.
        </p>
        <label className="flex items-center gap-2">
          <span className={LABEL}>name</span>
          <input aria-label="a name for the adapter" value={name} onChange={(e) => setName(e.target.value)} className={cx(FIELD, "w-56", mono)} />
          {adapterName(name) === null && <span className="text-[11px] text-bad">lowercase letters, digits and dashes</span>}
        </label>
        <div>
          <div className="flex items-center text-[11px] font-medium">1 · the file <Copy what="path" text={rel} /></div>
          <pre className={cx("mt-1 rounded-md border border-line bg-bg p-2 font-mono text-[11px]", "whitespace-pre-wrap break-all")}>{rel}</pre>
          <div className="mt-0.5 text-[11px] text-dim">A file you write, beside hearth.yaml, as the entry in step 3 names it.</div>
        </div>
        <div>
          <div className="flex items-center text-[11px] font-medium">2 · the module <Copy what="module" text={ADAPTER_STARTER} /></div>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre rounded-md border border-line bg-bg p-2 font-mono text-[10.5px] leading-snug">{ADAPTER_STARTER}</pre>
        </div>
        <div>
          <div className="flex items-center text-[11px] font-medium">3 · the entry in hearth.yaml <Copy what="entry" text={entry} /></div>
          <pre className="mt-1 overflow-auto whitespace-pre rounded-md border border-line bg-bg p-2 font-mono text-[10.5px] leading-snug">{entry}</pre>
        </div>
        <div>
          <div className="text-[11px] font-medium">4 · a line that names it</div>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-2 font-mono text-[10.5px] leading-snug">{line}</pre>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => { onClose(); go("plugins"); }}>The Plugins page <ArrowRight size={12} /></Button>
          <span className="text-[11px] text-dim">It shows the same entry, and what runs and what does not.</span>
        </div>
      </div>
    </Dialog>
  );
}
