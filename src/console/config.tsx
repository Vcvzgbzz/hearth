/**
 * hearth.yaml, edited by section or as text. Every save is reviewed first: a dry run returns the
 * file it would write, shown as a diff with what needs a restart, and only then is it written.
 * The form knows each setting from fields.ts: its type, default and what it does.
 */
import { Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { lineDiff, opsBetween, type Op } from "./diff.js";
import { FIELDS, fieldAt, humanMs, scopeOf, seedOf, type Field, type Ref, type Scope } from "../fields.js";
import { request, RequestError, toast, useStore } from "./store.js";
import { Button, Card, cx, mono, Pill, Switch } from "./ui.js";

type File = { text: string; hash: string; doc: Record<string, unknown> | null };
type Plan = { before: string; after: string; restartPending: string[]; commit: () => Promise<void> };
type Err = { message: string; path: string | null };
type Path = (string | number)[];

/** The sections, in the order an operator reaches for them; anything else at the top level is "Node". */
const SECTIONS: { key: string; label: string; hint: string; list?: true }[] = [
  { key: "backends", label: "Backends", hint: "Servers hearth fronts. A backend is its own queue." },
  { key: "resources", label: "Hardware", hint: "Cards and CPUs. Backends on the same exclusive card take turns." },
  { key: "models", label: "Models & routes", hint: "Per-model routing, aliases, slots and parameters." },
  { key: "scheduler", label: "Lanes & queues", hint: "Lane priorities and ceilings, queue limits." },
  { key: "peers", label: "Peers", hint: "One entry per friend: how to reach them, the tokens each side presents, what you borrow." },
  { key: "lending", label: "Lending", hint: "What peers may run here, and how much of it." },
  { key: "node", label: "Node", hint: "Name, listen address, backend defaults, borrowing, keys and limits." },
];
const OWN = new Set(SECTIONS.map((s) => s.key).filter((k) => k !== "node"));

/** Named things made in one step: the name and the settings they cannot do without. */
const NEW: Record<string, { noun: string; scope: Scope; keys: string[]; list?: true }> = {
  backends: { noun: "backend", scope: "backend", keys: ["url", "kind", "resources"] },
  peers: { noun: "peer", scope: "peer", keys: ["url", "token", "accept"] },
  models: { noun: "model", scope: "model", keys: ["policy", "lane"] },
  resources: { noun: "hardware", scope: "resource", keys: ["kind", "shared"] },
  "scheduler.lanes": { noun: "lane", scope: "lane", keys: ["priority"] },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fmt = (path: Path) => path.map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${p}` : p)).join("");
/** The id of the control at a path, so a label, an error and a focus request can all find it. */
const fid = (path: Path | string) => `f-${typeof path === "string" ? path : fmt(path)}`;
const INPUT = "h-8 rounded-md border bg-bg px-2 text-[12px] focus:border-accent focus:outline-none";

/** The names a reference may pick from, read off the config being edited. */
const Refs = createContext<Record<Ref, string[]>>({ models: [], lanes: [], resources: [], backends: [], peers: [] });

function refsOf(doc: Record<string, unknown>, catalog: string[]): Record<Ref, string[]> {
  const sched = isObj(doc.scheduler) ? doc.scheduler : {};
  return {
    models: [...new Set([...Object.keys(isObj(doc.models) ? doc.models : {}), ...catalog])].sort(),
    lanes: isObj(sched.lanes) ? Object.keys(sched.lanes) : ["chat", "batch"],
    resources: Object.keys(isObj(doc.resources) ? doc.resources : {}),
    backends: Object.keys(isObj(doc.backends) ? doc.backends : {}),
    peers: Object.keys(isObj(doc.peers) ? doc.peers : {}),
  };
}

/** Set by whatever adds a control; the control takes focus as it mounts. */
let focusNext: string | null = null;
const takeFocus = (id: string) => (el: HTMLElement | null) => {
  if (el && focusNext === id) { focusNext = null; el.focus(); }
};

/** What a secret reads back as from the server; the hint is what steers a plaintext one to `env:`. */
const STANDIN = /^hearth-secret\d+$/;
function secretHint(name: string, v: unknown): string | null {
  // An apiKeys entry is a bare key or {key, label, models}; the secret sits in the same place either way.
  const vals = Array.isArray(v) ? v.flatMap((x) => (isObj(x) ? [x.key] : [x])) : isObj(v) ? Object.values(v) : [v];
  if (vals.some((x) => typeof x === "string" && STANDIN.test(x))
      && (name === "apiKeys" || name === "peerTokens" || name === "token" || name === "key")) {
    return "stored in the file in plain text — `env:NAME` keeps it out of hearth.yaml";
  }
  return null;
}

const tagOf = (f: Field): string =>
  f.type === "ms" ? "ms" : f.type === "bool" ? "on/off" : f.type === "enum" ? "choice" : f.type === "object" ? "group"
    : f.type === "ref" || f.type === "refs" ? f.ref : f.type;

/** One line under a control: what it does, and what it is when unset. */
function Hint({ f }: { f: Field }) {
  const d = "def" in f ? f.def : undefined;
  const def = d === undefined ? null : f.type === "ms" && typeof d === "number" ? `${d} (${humanMs(d)})` : String(d);
  return <div className="mt-1 text-[11px] leading-4 text-dim">{f.desc}{def !== null && <> Default <span className={mono}>{def}</span>.</>}</div>;
}

/** A list of scalars as one line: edit freely, commit on Enter or blur — so `a, b` is typeable at all. */
function ListInput({ id, v, onChange, bad }: { id: string; v: string[]; onChange: (v: string[]) => void; bad: boolean }) {
  const [raw, setRaw] = useState(() => v.join(", "));
  useEffect(() => { setRaw(v.join(", ")); }, [v]);
  const commit = () => {
    const next = raw.split(",").map((x) => x.trim()).filter(Boolean);
    if (next.length === v.length && next.every((x, i) => x === v[i])) { setRaw(v.join(", ")); return; }
    onChange(next);
  };
  return (
    <input id={id} ref={takeFocus(id)} className={cx(INPUT, mono, "w-full", bad ? "border-bad" : "border-line")} value={raw} placeholder="a, b, c"
           onChange={(e) => setRaw(e.target.value)}
           onKeyDown={(e) => e.key === "Enter" && commit()}
           onBlur={commit} />
  );
}

/** Names picked from what the config already has; one it does not know stays, marked. */
function Chips({ id, v, options, noun, onChange }: { id: string; v: string[]; options: string[]; noun: string; onChange: (v: string[]) => void }) {
  const rest = options.filter((o) => !v.includes(o));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {v.map((x) => (
        <span key={x} title={options.includes(x) ? undefined : `not a ${noun} this config declares`}
              className={cx("inline-flex h-7 items-center gap-1 rounded-md border pl-2 pr-1", mono, options.includes(x) ? "border-line bg-muted" : "border-warn text-warn")}>
          {x}
          <button type="button" aria-label={`remove ${x}`} className="rounded p-0.5 text-dim hover:text-bad" onClick={() => onChange(v.filter((y) => y !== x))}><X size={11} /></button>
        </span>
      ))}
      <select id={id} ref={takeFocus(id)} value="" disabled={rest.length === 0} onChange={(e) => e.target.value && onChange([...v, e.target.value])}
              className={cx("h-7 rounded-md border border-dashed border-line bg-transparent px-1.5 text-[12px] text-dim focus:border-accent focus:outline-none")}>
        <option value="">{rest.length ? `+ ${noun}` : options.length ? `every ${noun} added` : `no ${noun} declared yet`}</option>
        {rest.map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  );
}

/** One value, drawn as its field says when the value is the shape the field expects; otherwise as what it is. */
function Scalar({ id, name, f, v, onChange, bad }: {
  id: string; name: string; f: Field | null; v: unknown; onChange: (v: unknown) => void; bad: boolean;
}) {
  const refs = useContext(Refs);
  const base = cx(INPUT, bad ? "border-bad" : "border-line");
  if (typeof v === "boolean") return <span id={id} ref={takeFocus(id)} tabIndex={-1}><Switch label={name} on={v} onChange={onChange} /></span>;
  if ((f?.type === "number" || f?.type === "ms") && (typeof v === "number" || v === null)) {
    return (
      <div className="flex items-center gap-2">
        <input id={id} ref={takeFocus(id)} type="number" min={f.min} className={cx(base, "tabular w-36")} value={v ?? ""}
               onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
        {f.type === "ms" && <span className="text-[12px] text-dim">ms{typeof v === "number" && ` · ${humanMs(v)}`}</span>}
      </div>
    );
  }
  if (f?.type === "enum" && typeof v === "string") {
    const opts = f.options.includes(v) ? f.options : [v, ...f.options];
    return <select id={id} ref={takeFocus(id)} className={cx(base, "w-48 max-w-full")} value={v} onChange={(e) => onChange(e.target.value)}>{opts.map((o) => <option key={o}>{o}</option>)}</select>;
  }
  if (f?.type === "ref" && (typeof v === "string" || v === null)) {
    const opts = refs[f.ref];
    const known = v === null || v === "" || opts.includes(v);
    return (
      <div>
        <select id={id} ref={takeFocus(id)} className={cx(base, "w-64 max-w-full", !known && "border-warn")} value={v ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}>
          <option value="">—</option>
          {!known && <option value={v!}>{v} (not declared)</option>}
          {opts.map((o) => <option key={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    if (f?.type === "refs" && refs[f.ref].length > 0) {
      return <Chips id={id} v={v} options={refs[f.ref]} noun={f.ref.replace(/s$/, "")} onChange={onChange} />;
    }
    return <ListInput id={id} v={v} onChange={onChange} bad={bad} />;
  }
  if (typeof v === "number" || v === null) {
    return <input id={id} ref={takeFocus(id)} type="number" className={cx(base, "tabular w-36")} value={v ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
  }
  return <input id={id} ref={takeFocus(id)} className={cx(base, mono, "w-full")} placeholder={f?.type === "secret" ? "env:NAME" : undefined}
                value={v === undefined ? "" : String(v)} onChange={(e) => onChange(e.target.value)} />;
}

/** Any value: maps as labelled rows, lists of maps as cards, scalars and scalar lists as controls. */
function Value({ name, v, path, onChange, err }: {
  name: string; v: unknown; path: Path; onChange: (v: unknown) => void; err: Err | null;
}): ReactNode {
  const bad = err?.path === fmt(path);
  const f = fieldAt(path);
  if (isObj(v)) return <Obj v={v} path={path} onChange={onChange} err={err} />;
  if (Array.isArray(v) && (v.some(isObj) || (NEW[fmt(path)]?.list && v.length === 0))) {
    const spec = NEW[fmt(path)];
    return (
      <div className="flex flex-col gap-2">
        {v.map((item, i) => {
          const titled = isObj(item) && typeof item.name === "string";
          return (
            <Card key={i} className={cx("p-3", err?.path?.startsWith(fmt([...path, i])) && "border-bad")}>
              <div className="mb-1 flex items-center gap-2">
                {titled ? (
                  <input aria-label={`${spec?.noun ?? "entry"} name`} id={fid([...path, i, "name"])} ref={takeFocus(fid([...path, i, "name"]))} value={item.name as string}
                         onChange={(e) => onChange(v.map((x, k) => (k === i ? { ...(x as object), name: e.target.value } : x)))}
                         className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 font-medium hover:border-line focus:border-accent focus:outline-none" />
                ) : <span className="font-medium">#{i + 1}</span>}
                <button className="ml-auto text-dim hover:text-bad" aria-label={`remove ${titled ? item.name : `#${i + 1}`}`} onClick={() => onChange(v.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
              </div>
              <Value name={name} v={item} path={[...path, i]} err={err} onChange={(n) => onChange(v.map((x, k) => (k === i ? n : x)))} />
            </Card>
          );
        })}
        {spec && <NewButton spec={spec} taken={v.flatMap((x) => (isObj(x) && typeof x.name === "string" ? [x.name] : []))}
                            onCreate={(id, vals) => { focusNext = fid([...path, v.length, "name"]); onChange([...v, { name: id, ...vals }]); }} />}
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <Scalar id={fid(path)} name={name} f={f} v={v} onChange={onChange} bad={bad} />
      {bad && <div className="mt-1 text-[11px] text-bad">{err!.message}</div>}
      {!bad && secretHint(name, v) && <div className="mt-1 text-[11px] text-warn">{secretHint(name, v)}</div>}
      {f && <Hint f={f} />}
    </div>
  );
}

function Obj({ v, path, onChange, err }: { v: Record<string, unknown>; path: Path; onChange: (v: unknown) => void; err: Err | null }) {
  const scope = scopeOf(path);
  const spec = NEW[fmt(path)];
  // Inside a list card the name is the card's title, so it is not a row as well.
  const hide = typeof path[path.length - 1] === "number" && typeof v.name === "string" ? "name" : null;
  return (
    <div className="flex flex-col">
      {Object.entries(v).filter(([k]) => k !== hide).map(([k, x]) => {
        const at = [...path, k];
        const nested = isObj(x) || (Array.isArray(x) && x.some(isObj));
        return (
          // Only the innermost hovered row shows its remove button; its parents' stay hidden.
          <div key={k} className="obj-row flex items-start gap-3 border-b border-line/50 py-2 last:border-0 max-sm:flex-col max-sm:gap-1 [&:hover:not(:has(.obj-row:hover))>button]:opacity-100">
            <label htmlFor={nested ? undefined : fid(at)} className={cx("w-44 shrink-0 pt-1.5 text-dim max-sm:w-auto max-sm:pt-0", mono)}>{k}</label>
            <div className="min-w-0 flex-1 max-sm:w-full">
              {/* A cleared field becomes null in the draft, which opsBetween turns into a key deletion. */}
              <Value name={k} v={x} path={at} err={err} onChange={(n) => onChange({ ...v, [k]: n })} />
            </div>
            <button className="pt-2 text-dim opacity-0 hover:text-bad focus:opacity-100 max-sm:hidden" aria-label={`remove ${k}`}
                    onClick={() => { const { [k]: _, ...rest } = v; onChange(rest); }}><X size={13} /></button>
          </div>
        );
      })}
      <div className="pt-2">
        {spec ? (
          <NewButton spec={spec} taken={Object.keys(v)} onCreate={(id, vals) => { focusNext = fid([...path, id, spec.keys[0]!]); onChange({ ...v, [id]: vals }); }} />
        ) : scope ? (
          <AddSetting scope={scope} have={v} onAdd={(k) => { focusNext = fid([...path, k]); onChange({ ...v, [k]: seedOf(FIELDS[scope][k]!) }); }} />
        ) : (
          <AddPair path={path} have={v} onAdd={(k, x) => onChange({ ...v, [k]: x })} />
        )}
      </div>
    </div>
  );
}

/** "+ add setting": the settings this scope has that are not set yet, searchable, each with what it does. */
function AddSetting({ scope, have, onAdd }: { scope: Scope; have: Record<string, unknown>; onAdd: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  // raw settings are edited in the hearth.yaml tab, so the menu does not offer them.
  const unset = Object.entries(FIELDS[scope]).filter(([k, f]) => !(k in have) && f.type !== "raw");
  if (unset.length === 0) return null;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = unset.filter(([k, f]) => words.every((w) => `${k} ${f.desc}`.toLowerCase().includes(w)));
  const pick = (k: string) => { setOpen(false); setQ(""); onAdd(k); };
  if (!open) {
    return (
      <button type="button" onClick={() => { setOpen(true); setHl(0); }}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed border-line px-2 text-[12px] text-dim hover:border-accent hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
        <Plus size={12} />add setting <span className="text-dim/70">· {unset.length} more</span>
      </button>
    );
  }
  const listId = `opts-${scope}`;
  return (
    <div className="relative w-full max-w-lg" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <input autoFocus role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={list[hl] ? `${listId}-${list[hl]![0]}` : undefined}
             value={q} placeholder="search settings…" className={cx(INPUT, "w-full border-accent")}
             onChange={(e) => { setQ(e.target.value); setHl(0); }}
             onKeyDown={(e) => {
               if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, list.length - 1)); }
               else if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
               else if (e.key === "Enter" && list[hl]) { e.preventDefault(); pick(list[hl]![0]); }
               else if (e.key === "Escape") setOpen(false);
             }} />
      <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-line bg-panel py-1 shadow-xl">
        {list.map(([k, f], i) => (
          <li key={k} id={`${listId}-${k}`} role="option" aria-selected={i === hl}
              onMouseDown={(e) => { e.preventDefault(); pick(k); }} onMouseEnter={() => setHl(i)}
              className={cx("cursor-pointer px-3 py-1.5", i === hl && "bg-muted")}>
            <div className="flex items-center gap-2"><span className={mono}>{k}</span><span className="rounded bg-line/70 px-1 text-[10px] text-dim">{tagOf(f)}</span></div>
            <div className="text-[11px] leading-4 text-dim">{f.desc}</div>
          </li>
        ))}
        {list.length === 0 && <li className="px-3 py-2 text-dim">no setting matches “{q}”</li>}
        <li className="mt-1 border-t border-line px-3 pt-1.5 text-[11px] text-dim">anything else: the hearth.yaml tab</li>
      </ul>
    </div>
  );
}

/** A free `name: value` map gets both halves on one row: type the name, Tab, the value, Enter. */
function AddPair({ path, have, onAdd }: { path: Path; have: Record<string, unknown>; onAdd: (k: string, v: unknown) => void }) {
  const [k, setK] = useState("");
  const [x, setX] = useState("");
  const keyRef = useRef<HTMLInputElement>(null);
  const last = path[path.length - 1];
  // params are request fields, so 0.7 means a number and true a boolean; everything else here is a string.
  const typed = last === "params";
  const coerce = (s: string): unknown => (!typed ? s : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s === "true" ? true : s === "false" ? false : s);
  const dup = k.trim() in have;
  const add = () => {
    if (!k.trim() || dup) return;
    onAdd(k.trim(), coerce(x.trim()));
    setK(""); setX("");
    keyRef.current?.focus();
  };
  const hint = last === "params" ? ["field", "value"] : last === "notes" ? ["model", "note"] : last === "peerTokens" ? ["peer", "env:NAME"] : last === "models" ? ["your id", "their id"] : ["name", "value"];
  return (
    <div className="flex flex-wrap items-center gap-2" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}>
      <input ref={keyRef} aria-label={`new ${hint[0]}`} value={k} onChange={(e) => setK(e.target.value)} placeholder={hint[0]}
             className={cx(INPUT, mono, "w-40 border-dashed", dup ? "border-bad" : "border-line")} />
      <input aria-label={`its ${hint[1]}`} value={x} onChange={(e) => setX(e.target.value)} placeholder={hint[1]}
             className={cx(INPUT, mono, "w-56 border-dashed border-line")} />
      <Button disabled={!k.trim() || dup} onClick={add}><Plus size={12} />add</Button>
      {dup && <span className="text-[11px] text-bad">{k.trim()} is already set</span>}
    </div>
  );
}

/** "+ add backend" and friends: a short dialog for the name and the few settings it needs. */
function NewButton({ spec, taken, onCreate }: {
  spec: (typeof NEW)[string]; taken: string[]; onCreate: (id: string, vals: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus size={13} />add {spec.noun}</Button>
      {open && <NewDialog spec={spec} taken={taken} onClose={() => setOpen(false)} onCreate={(id, vals) => { setOpen(false); onCreate(id, vals); }} />}
    </>
  );
}

function NewDialog({ spec, taken, onClose, onCreate }: {
  spec: (typeof NEW)[string]; taken: string[]; onClose: () => void; onCreate: (id: string, vals: Record<string, unknown>) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const refs = useContext(Refs);
  const [id, setId] = useState("");
  const [vals, setVals] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const k of spec.keys) {
      const f = FIELDS[spec.scope][k]!;
      out[k] = k === "url" && spec.scope === "backend" ? "http://127.0.0.1:" : f.type === "ref" ? null : seedOf(f);
    }
    return out;
  });
  const first = useRef<HTMLInputElement>(null);
  // After showModal, which otherwise hands focus to the first button: the close ×.
  useEffect(() => { ref.current?.showModal(); first.current?.focus(); }, []);
  const name = id.trim();
  const problem = !name ? null : taken.includes(name) ? `a ${spec.noun} named ${name} already exists`
    : typeof vals.url === "string" && vals.url !== "" && !/^https?:\/\/[^/:]+(:\d+)?$/.test(vals.url.replace(/\/$/, "")) ? "the url needs a host and port, like http://127.0.0.1:8080"
    : spec.scope === "peer" && !vals.url && !vals.accept ? "a peer needs a url (to borrow from it) or accept (to lend to it)"
    : spec.scope === "peer" && vals.url && !vals.token ? "borrowing needs the token you present to them" : null;
  // A model's id is usually one the backends already serve; offer those.
  const suggest = spec.scope === "model" ? refs.models.filter((m) => !taken.includes(m)) : [];
  const create = () => {
    if (!name || problem) return;
    // Unset references, blank text and empty lists stay out of the file rather than going in as blanks.
    onCreate(name, Object.fromEntries(Object.entries(vals).filter(([, x]) => x !== null && x !== "" && !(Array.isArray(x) && x.length === 0))));
  };
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}
            className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/40">
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); create(); }} className="flex flex-col">
        <div className="flex items-center border-b border-line px-4 py-3">
          <span className="font-semibold">New {spec.noun}</span>
          <button type="button" className="ml-auto text-dim hover:text-fg" aria-label="close" onClick={() => ref.current?.close()}><X size={16} /></button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div>
            <label htmlFor="new-name" className="mb-1 block text-[12px] font-medium">{spec.scope === "model" ? "Model id" : "Name"}</label>
            <input id="new-name" ref={first} list={suggest.length ? "new-suggest" : undefined} value={id} onChange={(e) => setId(e.target.value)}
                   className={cx(INPUT, mono, "w-full", problem && name ? "border-bad" : "border-line")} placeholder={spec.scope === "model" ? "as clients ask for it" : spec.noun === "hardware" ? "gpu0" : ""} />
            {suggest.length > 0 && <datalist id="new-suggest">{suggest.map((m) => <option key={m} value={m} />)}</datalist>}
          </div>
          {spec.keys.map((k) => {
            const f = FIELDS[spec.scope][k]!;
            return (
              <div key={k}>
                <label htmlFor={`f-new-${k}`} className="mb-1 block text-[12px] font-medium">{k}</label>
                <Scalar id={`f-new-${k}`} name={k} f={f} v={vals[k]} bad={false} onChange={(x) => setVals({ ...vals, [k]: x })} />
                <Hint f={f} />
              </div>
            );
          })}
          {problem && <div className="text-[12px] text-bad">{problem}</div>}
          <div className="text-[11px] text-dim">Everything else is under “add setting” once it exists. Nothing is written until you review &amp; save.</div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button onClick={() => ref.current?.close()}>cancel</Button>
          <Button tone="primary" type="submit" disabled={!name || problem !== null}><Plus size={13} />add {spec.noun}</Button>
        </div>
      </form>
    </dialog>
  );
}

/* ---------------------------------------------------------------- review */

function Review({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const lines = lineDiff(plan.before, plan.after);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6" onClick={onClose}>
      <Card className="flex max-h-[85vh] w-full max-w-3xl flex-col shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <span className="font-semibold">Review changes to hearth.yaml</span>
          {plan.restartPending.length ? <Pill tone="warn">restart to apply {plan.restartPending.join(", ")}</Pill> : <Pill tone="ok">applies live</Pill>}
          <button className="ml-auto text-dim hover:text-fg" onClick={onClose} aria-label="close"><X size={16} /></button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto px-0 py-2 font-mono text-[12px] leading-5" onClick={(e) => e.stopPropagation()}>
          {lines.map((l, i) => (
            <div key={i} className={cx("px-4", l.kind === "+" && "bg-ok/10 text-ok", l.kind === "-" && "bg-bad/10 text-bad", l.kind === "…" && "text-dim")}>
              {l.kind === "…" ? "  ⋯" : `${l.kind} ${l.text}`}
            </div>
          ))}
        </pre>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <Button onClick={onClose}>keep editing</Button>
          <Button tone="primary" disabled={busy} onClick={() => { setBusy(true); void plan.commit().finally(() => setBusy(false)); }}>
            <Save size={13} />save
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- page */

export function Config() {
  const status = useStore((s) => s.data!.config);
  const [file, setFile] = useState<File | null>(null);
  const [tab, setTab] = useState<string>("backends");
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [text, setText] = useState("");
  const [err, setErr] = useState<Err | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);

  const load = async () => {
    try {
      const f = await request<File>("GET", "/config");
      setFile(f);
      setText(f.text);
      setDrafts({});
      setErr(null);
    } catch (e) {
      setErr({ message: e instanceof Error ? e.message : String(e), path: null });
    }
  };
  useEffect(() => { void load(); }, []);
  const dirty = Object.keys(drafts).length > 0 || (file !== null && text !== file.text);
  // An edit made elsewhere moves the hash; follow it unless there is unsaved work here.
  useEffect(() => { if (file && status.hash !== file.hash && !dirty) void load(); }, [status.hash]);

  const doc = file?.doc ?? {};
  const nodeOf = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => !OWN.has(k)));
  const original = (key: string) => (key === "node" ? nodeOf(doc) : doc[key]);
  const current = (key: string) => (key in drafts ? drafts[key] : original(key));

  /** Dry-run, show the diff, and write only on confirm. */
  const review = async (body: { ops?: Op[]; text?: string }) => {
    if (!file) return;
    try {
      const dry = await request<{ text: string; restartPending: string[] }>("PATCH", "/config", { baseHash: file.hash, ...body, dryRun: true });
      setErr(null);
      setPlan({
        before: file.text, after: dry.text, restartPending: dry.restartPending,
        commit: async () => {
          try {
            const out = await request<{ restartPending: string[] }>("PATCH", "/config", { baseHash: file.hash, ...body });
            toast("ok", out.restartPending.length ? `saved — restart to apply ${out.restartPending.join(", ")}` : "saved and applied");
            setPlan(null);
            await load();
          } catch (e) {
            setPlan(null);
            setErr({ message: e instanceof Error ? e.message : String(e), path: e instanceof RequestError ? e.path : null });
          }
        },
      });
    } catch (e) {
      setErr({ message: e instanceof Error ? e.message : String(e), path: e instanceof RequestError ? e.path : null });
    }
  };
  const saveSection = (key: string) => {
    const ops = key === "node" ? opsBetween(original("node"), drafts.node) : opsBetween(original(key), drafts[key], [key]);
    if (ops.length) void review({ ops });
  };
  const sec = SECTIONS.find((s) => s.key === tab);
  // What the node lends plus every id its own backends report, aliased-away ones included: `as` names those.
  const data = useStore((s) => s.data);
  const self = data?.net.nodes.find((n) => n.self);
  const catalog = [...(data?.catalog ?? []), ...(self?.backends ?? []).flatMap((b) => [...(b.serves ?? []), ...(b.loaded ?? [])])];
  const merged = { ...doc, ...(isObj(drafts.node) ? drafts.node : {}), ...Object.fromEntries(Object.entries(drafts).filter(([k]) => k !== "node")) };
  // A field error is shown at its field; the banner is for errors with nowhere else to go.
  const inline = err?.path ? document.getElementById(fid(err.path)) !== null : false;

  return (
    <div className="flex h-full flex-col gap-3">
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        {status.error ? <Pill tone="bad">does not load</Pill> : status.restartPending.length ? <Pill tone="warn">restart needed</Pill> : <Pill tone="ok">applied</Pill>}
        <span className={cx(mono, "min-w-0 break-all")}>{status.path ?? "in memory — no config file"}</span>
        {status.restartPending.length > 0 && <span className="text-warn">restart hearth to apply: {status.restartPending.join(", ")}</span>}
        {status.error && <span className="w-full text-bad">{status.error} — the node keeps running the last config that loaded.</span>}
      </Card>
      {status.path && file && (
        <div className="flex min-h-0 flex-1 gap-3 max-md:flex-col">
          <nav className="flex w-44 shrink-0 flex-col gap-0.5 max-md:w-full max-md:flex-row max-md:overflow-x-auto">
            {[...SECTIONS.map((s) => ({ key: s.key, label: s.label })), { key: "yaml", label: "hearth.yaml" }].map((s) => (
              <button key={s.key} onClick={() => setTab(s.key)}
                      className={cx("flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-left", tab === s.key ? "bg-muted font-medium" : "text-dim hover:bg-muted/60 hover:text-fg",
                        s.key === "yaml" && "mt-2 font-mono text-[12px] max-md:mt-0")}>
                {s.label}{s.key in drafts && <span className="ml-auto size-1.5 rounded-full bg-accent" />}
              </button>
            ))}
          </nav>
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden max-md:min-h-[60vh]">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
              <div>
                <div className="font-medium">{sec?.label ?? "hearth.yaml"}</div>
                <div className="text-[11px] text-dim">{sec?.hint ?? "The whole file, comments and all. ⌘S reviews and saves."}</div>
              </div>
              <div className="ml-auto flex gap-2">
                {sec ? (
                  <>
                    <Button disabled={!(tab in drafts)} onClick={() => { const { [tab]: _, ...rest } = drafts; setDrafts(rest); setErr(null); }}><RotateCcw size={13} />revert</Button>
                    <Button tone="primary" disabled={!(tab in drafts)} onClick={() => saveSection(tab)}><Save size={13} />review & save</Button>
                  </>
                ) : (
                  <>
                    <Button disabled={text === file.text} onClick={() => setText(file.text)}><RotateCcw size={13} />revert</Button>
                    <Button tone="primary" disabled={text === file.text} onClick={() => void review({ text })}><Save size={13} />review & save</Button>
                  </>
                )}
              </div>
            </div>
            {err && !inline && <div className="border-b border-line bg-bad/10 px-4 py-2 text-bad">{err.message}</div>}
            {sec ? (
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <Refs.Provider value={refsOf(merged, catalog)}>
                  {current(tab) === undefined ? (
                    <Button onClick={() => setDrafts({ ...drafts, [tab]: sec.list ? [] : {} })}><Plus size={13} />add a {sec.label.toLowerCase()} section</Button>
                  ) : (
                    <Value name={tab} v={current(tab)} path={tab === "node" ? [] : [tab]} err={err}
                           onChange={(n) => setDrafts({ ...drafts, [tab]: n })} />
                  )}
                </Refs.Provider>
              </div>
            ) : (
              <textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (text !== file.text) void review({ text }); } }}
                        className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12px] leading-5 outline-none" />
            )}
          </Card>
        </div>
      )}
      {status.path && !file && (
        <Card className="p-6">
          {err ? (
            <div className="text-bad">{err.message}</div>
          ) : (
            <div className="text-dim">loading hearth.yaml…</div>
          )}
        </Card>
      )}
      {plan && <Review plan={plan} onClose={() => setPlan(null)} />}
    </div>
  );
}
