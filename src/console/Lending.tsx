/** The Lending page: what peers may take, each one's own limits, and what was lent and borrowed. */
import { ChevronRight, Pencil, Plus, Trash2, Undo2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Menu } from "./editor.js";
import { choose } from "./editStore.js";
import { short } from "./pages.js";
import { control, refresh, request, toast, useStore } from "./store.js";
import type { LendTerms, ModelLimits, UiData, Used } from "./types.js";
import { Button, Card, cx, Dialog, mono, Pill, Switch } from "./ui.js";

type Row = NonNullable<UiData["ledger"]>[number];
type Path = (string | number)[];
/** One peer as `GET /lending` gives it: the row, with its use by model and by day. */
type Detail = Row & { byModel: { lent: Record<string, Used>; borrowed: Record<string, Used> }; byDay: { lent: Record<string, number>; borrowed: Record<string, number> } };

const tokens = (u: Used): number => u.in + u.out;

/** Apply edits to hearth.yaml at once; true when they were written. */
async function edit(ops: Record<string, unknown>[], done: string): Promise<boolean> {
  try {
    await request("PATCH", "/config", { ops });
    toast("ok", done);
    await refresh();
    return true;
  } catch (e) {
    toast("bad", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Write one setting into hearth.yaml, or with no value take it out; it applies at once. */
async function save(path: Path, value: unknown, done: string): Promise<void> {
  await edit([value === undefined ? { path, delete: true } : { path, value }], done);
}

/** A /control change, shown at once. */
async function flip(body: Record<string, unknown>, done: string): Promise<void> {
  if (await control(body, done)) await refresh();
}

/**
 * A whole number that saves when it is left or Enter is pressed, and goes back to what is saved on
 * anything else. With `none`, 0 is that word and an empty field: the setting's way of saying no limit.
 */
function Num({ value, label, min, onSave, className, none, disabled, title }: { value: number; label: string; min: number; onSave: (n: number) => void; className?: string; none?: string; disabled?: boolean; title?: string }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const n = none !== undefined && text.trim() === "" ? 0 : Number(text.replace(/[,_\s]/g, ""));
    setText(null);
    if (!Number.isInteger(n) || n < min) return toast("bad", `${label} must be a whole number of ${min} or more`);
    if (n !== value) onSave(n);
  };
  return (
    <input
      aria-label={label} title={title} inputMode="numeric" disabled={disabled} placeholder={none}
      value={text ?? (none !== undefined && value === 0 ? "" : value.toLocaleString("en-US"))}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setText(null); }}
      className={cx("h-8 rounded-md border border-line bg-panel px-2 tabular placeholder:text-dim focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50", mono, className)}
    />
  );
}

/** The models that are lent, each one taken back with its ×, and a menu of the rest to lend. */
function Models({ all, lent, who, onToggle, disabled }: { all: string[]; lent: readonly string[]; who: string; onToggle: (model: string, on: boolean) => void; disabled?: boolean }) {
  const rest = all.filter((m) => !lent.includes(m));
  return (
    <div className={cx("flex max-w-[300px] flex-wrap items-center gap-1", disabled && "opacity-50")}>
      {lent.length === 0 && <span className="text-dim">nothing</span>}
      {lent.map((m) => (
        <span key={m} className={cx("inline-flex items-center gap-1 rounded-md border border-line bg-muted py-0.5 pl-2 pr-1", mono)}>
          {m}
          <button type="button" disabled={disabled} aria-label={`${who}: stop lending ${m}`} onClick={() => onToggle(m, false)}
                  className="rounded text-dim hover:text-bad focus-visible:outline-2 focus-visible:outline-accent"><X size={12} /></button>
        </span>
      ))}
      {rest.length > 0 && (
        <button type="button" disabled={disabled} aria-label={`${who}: lend another model`}
                onClick={(e) => choose(e, rest.map((m) => ({ label: m, value: m, mono: true })), (m) => onToggle(m, true))}
                className="inline-flex size-6 items-center justify-center rounded-md border border-dashed border-line text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"><Plus size={13} /></button>
      )}
    </div>
  );
}

/** Takes one of a peer's own limits out of the file, so the one it lies over holds again. */
function Back({ peer, what, path, to = "the limit for every peer" }: { peer: string; what: string; path: Path; to?: string }) {
  return (
    <button type="button" aria-label={`${peer}: ${what} back to ${to}`} title={`back to ${to}`}
            onClick={() => void save(path, undefined, `${peer}: ${what} back to ${to}`)}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"><Undo2 size={13} /></button>
  );
}

/** Tokens lent above the line and borrowed below it, for each day that is kept. */
function Days({ lent, borrowed, days }: { lent: Record<string, number>; borrowed: Record<string, number>; days: number }) {
  const keys = Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  const top = Math.max(1, ...keys.map((k) => Math.max(lent[k] ?? 0, borrowed[k] ?? 0)));
  const W = 620;
  const H = 160;
  const bw = W / days;
  const tall = (n: number) => (n / top) * (H / 2 - 2);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-40 w-full" role="img" aria-label={`tokens lent above the line and borrowed below it, for each of the last ${days} days`}>
        {keys.map((k, i) => (
          <g key={k}>
            {(lent[k] ?? 0) > 0 && <rect x={i * bw + 1} y={H / 2 - tall(lent[k]!)} width={bw - 2} height={tall(lent[k]!)} rx={1} fill="var(--accent)"><title>{`${k}: ${short(lent[k]!)} lent`}</title></rect>}
            {(borrowed[k] ?? 0) > 0 && <rect x={i * bw + 1} y={H / 2 + 1} width={bw - 2} height={tall(borrowed[k]!)} rx={1} fill="var(--info)"><title>{`${k}: ${short(borrowed[k]!)} borrowed`}</title></rect>}
          </g>
        ))}
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--border)" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-dim"><span>{days} days ago</span><span>today (UTC)</span></div>
    </div>
  );
}

type Seen = { ip: string; at: string; node: { id: string; name: string; login: string } | null; error?: string };

/** Which tailnet machine a peer may borrow from, offered from the machine it last called from. */
function Machine({ peer }: { peer: string }) {
  const [got, setGot] = useState<{ bound: string | null; seen: Seen | null } | null>(null);
  const load = () => void request<{ bound: string | null; seen: Seen | null }>("GET", `/peers/machine?peer=${encodeURIComponent(peer)}`).then(setGot, () => setGot(null));
  useEffect(load, [peer]);
  if (!got) return null;
  const { bound, seen } = got;
  const bind = async (id: string | undefined, done: string) => { await save(["peers", peer, "tailnet"], id, done); load(); };
  const node = seen?.node ?? null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line/60 pt-3 text-[12px]">
      <span className="text-[11px] font-medium uppercase tracking-wide text-dim">machine</span>
      {bound !== null ? (
        <>
          <span>its token works only from tailnet machine <span className={mono}>{bound}</span>{node && node.id === bound ? <> ({node.name})</> : null}</span>
          {node && node.id !== bound && <span className="text-warn">its last call came from {node.name}, another machine, and was refused</span>}
          <Button onClick={() => void bind(undefined, `${peer}: token works from any machine`)}>unbind</Button>
        </>
      ) : node ? (
        <>
          <span className="text-dim">its token works from any machine; its last call came from <span className="text-fg">{node.name}</span> ({seen!.ip}{node.login ? `, ${node.login}` : ""})</span>
          <Button onClick={() => void bind(node.id, `${peer}: token works only from ${node.name}`)}>bind to {node.name}</Button>
        </>
      ) : (
        <span className="text-dim">
          its token works from any machine.{" "}
          {seen === null ? "It has not called since this node started; it can be bound to its machine once it does."
            : seen.error ? `tailscaled could not be asked who it is (${seen.error}).`
            : `Its last call came from ${seen.ip}, which is not on the tailnet, so there is no machine to bind it to.`}
        </span>
      )}
    </div>
  );
}

/** A model's limits under a peer's terms: the peer's three, with that model's own laid over them. */
const limitsOf = (t: LendTerms, model: string): ModelLimits => ({ tokensPerDay: t.tokensPerDay, maxConcurrent: t.maxConcurrent, rateLimit: t.rateLimit, ...t.limits?.[model] });

/** Tokens used today against a day's limit, with a bar when there is one. */
function Today({ used, limit }: { used: number; limit: number }) {
  return (
    <div className="tabular">
      <span className={used > 0 ? "text-fg" : "text-dim"}>{short(used)}</span>
      <span className="text-dim"> {limit > 0 ? `of ${short(limit)}` : "· no limit"}</span>
      {limit > 0 && (
        <div aria-hidden className="mt-1.5 h-1 w-full max-w-28 rounded-full bg-muted">
          <div className={cx("h-1 rounded-full", used >= limit ? "bg-warn" : "bg-accent")} style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/** Tokens over the days kept, or a dash for a model not run. */
function Month({ u }: { u: Used | undefined }) {
  if (!u) return <span className="text-dim">—</span>;
  return <span title={`${u.requests} requests`}>{short(tokens(u))}{u.failed > 0 && <span className="text-bad"> · {u.failed} failed</span>}</span>;
}

/** One side of a peer, lent or received: its colour, name, count and what it says, with an action at the right. */
function Side({ tone, name, count, note, action, children }: { tone: "accent" | "info"; name: string; count: number; note: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line/60 pt-4 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span aria-hidden className={cx("size-2.5 rounded-sm", tone === "accent" ? "bg-accent" : "bg-info")} />
        <h3 className="text-[11px] font-semibold uppercase tracking-wide">{name}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular text-dim">{count} {count === 1 ? "model" : "models"}</span>
        <span className="text-[12px] text-dim">{note}</span>
        {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** The same columns on both sides, so lent and received line up one above the other. */
function Cols({ action }: { action?: boolean }) {
  return (
    <colgroup>
      <col />
      <col className="w-[120px]" /><col className="w-[88px]" /><col className="w-[96px]" />
      <col className="w-[128px]" /><col className="w-[64px]" />
      {action && <col className="w-[36px]" />}
    </colgroup>
  );
}

function Head({ days, action }: { days: number; action?: boolean }) {
  const th = "px-2 py-2 font-medium";
  return (
    <thead className="text-[11px] text-dim">
      <tr className="border-b border-line/60">
        <th className="py-2 pr-2 font-medium">model</th>
        <th className={th}>tokens a day</th><th className={th}>jobs at once</th><th className={th}>req / hour</th>
        <th className={th}>used today</th><th className={cx(th, "text-right")}>{days} days</th>
        {action && <th />}
      </tr>
    </thead>
  );
}

/** What this node lends a peer, model by model, each with its own limits. */
function Lent({ peer, t, own, today, month, days, lendable }: { peer: string; t: LendTerms; own: string[]; today: Record<string, number>; month: Record<string, Used>; days: number; lendable: string[] }) {
  const at = (...k: string[]): Path => ["peers", peer, "lend", ...k];
  const rest = lendable.filter((m) => !t.models.includes(m));
  // Taking a model back takes its own limits with it, so none are left over for a model not lent.
  const stop = (m: string) => void edit([
    { path: at("models"), value: t.models.filter((x) => x !== m) },
    ...(t.limits?.[m] ? [{ path: Object.keys(t.limits).length > 1 ? at("limits", m) : at("limits"), delete: true }] : []),
  ], `holding ${m} from ${peer}`);
  const cell = (m: string, key: keyof ModelLimits, label: string, min: number) => {
    const mine = t.limits?.[m]?.[key] !== undefined;
    // The last of a model's own limits takes its entry with it, and the last entry the whole map, so none is left empty.
    const back = Object.keys(t.limits?.[m] ?? {}).length > 1 ? at("limits", m, key) : Object.keys(t.limits ?? {}).length > 1 ? at("limits", m) : at("limits");
    return (
      <td className="px-2 py-1.5"><div className="relative">
        <Num label={`${peer}, ${m}: ${label}`} min={min} none={key === "tokensPerDay" ? "no limit" : undefined} disabled={t.off} value={limitsOf(t, m)[key]}
             title={mine ? `${m}'s own limit` : "this peer's limit: type to give this model its own"}
             className={cx("h-7 w-full", mine ? "pr-7 font-medium text-fg" : "border-dashed text-dim hover:border-solid")}
             onSave={(n) => void save(at("limits", m, key), n, `${m}: ${label} saved`)} />
        {mine && (
          <div className="absolute inset-y-0 right-0.5 flex items-center">
            <Back peer={peer} what={`${m} ${label}`} path={back} to="this peer's limit" />
          </div>
        )}
      </div></td>
    );
  };
  const listNote = own.includes("models")
    ? <span className="inline-flex items-center gap-1">its own list <Back peer={peer} what="models" path={at("models")} /></span>
    : "the list for every peer";
  return (
    <Side tone="accent" name="lent" count={t.models.length}
          note={<>{listNote} · <span className="border-b border-dashed border-dim">dashed</span> limits are this peer's, solid ones the model's own</>}
          action={rest.length > 0 && (
            <button type="button" disabled={t.off} aria-label={`${peer}: lend another model`}
                    onClick={(e) => choose(e, rest.map((m) => ({ label: m, value: m, mono: true })), (m) => void save(at("models"), [...t.models, m], `lending ${m} to ${peer}`))}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[12px] text-dim hover:border-accent hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"><Plus size={13} />lend a model</button>
          )}>
      {t.models.length === 0 ? <p className="text-dim">Nothing is lent to {peer}.</p> : (
        <div className="overflow-x-auto"><table className={cx("w-full min-w-[720px] max-w-[1000px] table-fixed text-left", t.off && "opacity-60")}>
          <Cols action /><Head days={days} action />
          <tbody>
            {t.models.map((m) => (
              <tr key={m} className="group border-b border-line/40 last:border-0 hover:bg-muted/40">
                <td className={cx("truncate py-1.5 pr-2", mono)} title={m}>{m}</td>
                {cell(m, "tokensPerDay", "tokens a day", 0)}
                {cell(m, "maxConcurrent", "jobs at once", 1)}
                {cell(m, "rateLimit", "requests an hour", 1)}
                <td className="px-2 py-1.5"><Today used={today[m] ?? 0} limit={limitsOf(t, m).tokensPerDay} /></td>
                <td className="tabular px-2 py-1.5 text-right"><Month u={month[m]} /></td>
                <td className="py-1.5 text-right">
                  <button type="button" disabled={t.off} aria-label={`${peer}: stop lending ${m}`} title="stop lending it" onClick={() => stop(m)}
                          className="inline-flex size-7 items-center justify-center rounded-md text-dim opacity-60 group-hover:opacity-100 hover:bg-bad/10 hover:text-bad focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30"><X size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Side>
  );
}

/** What this node borrows from a peer, model by model, with the limits that peer holds it to. */
function Received({ peer, received, month, days }: { peer: string; received: NonNullable<Row["received"]>; month: Record<string, Used>; days: number }) {
  const models = Object.entries(received);
  const stated = models.filter(([, r]) => r.terms).length;
  const n = (v: number, none?: string) => (v === 0 && none ? <span className="text-dim">{none}</span> : v.toLocaleString("en-US"));
  const dash = <span className="text-dim" title={`${peer} did not state it`}>—</span>;
  return (
    <Side tone="info" name="received" count={models.length}
          note={models.length === 0 ? null : stated === 0
            ? <>{peer} does not state its limits: it runs a hearth from before they were shared, or has not been reached</>
            : <>the limits {peer} holds this node to, as of its last reading</>}>
      {models.length === 0 ? <p className="text-dim">Nothing is borrowed from {peer}: map a model under its <span className={mono}>models</span> in Config.</p> : (
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] max-w-[1000px] table-fixed text-left">
          <Cols action /><Head days={days} action />
          <tbody>
            {models.map(([m, { theirs, terms }]) => (
              <tr key={m} className="border-b border-line/40 last:border-0 hover:bg-muted/40">
                <td className={cx("truncate py-2 pr-2", mono)} title={theirs !== m ? `${m}, which they call ${theirs}` : m}>{m}{theirs !== m && <span className="text-dim"> → {theirs}</span>}</td>
                <td className="tabular px-2 py-2">{terms ? n(terms.tokensPerDay, "no limit") : dash}</td>
                <td className="tabular px-2 py-2">{terms ? n(terms.maxConcurrent) : dash}</td>
                <td className="tabular px-2 py-2">{terms ? n(terms.rateLimit) : dash}</td>
                <td className="px-2 py-2">{terms ? <Today used={terms.usedToday} limit={terms.tokensPerDay} /> : dash}</td>
                <td className="tabular px-2 py-2 text-right"><Month u={month[m]} /></td>
                <td />
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Side>
  );
}

/** One peer, opened: each model lent and received with its limits, and its use by day when there is any. */
function PeerDetail({ peer, lendable }: { peer: string; lendable: string[] }) {
  const [got, setGot] = useState<{ days: number; row: Detail } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const shown = got?.row.peer;
  // It opens under the table, which can be below what is on screen.
  useEffect(() => { if (shown) box.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [shown]);
  // The limits come from the page's own stream, so an edit shows at once; the history is asked again as the totals move.
  const live = useStore((s) => (s.data!.ledger ?? []).find((l) => l.peer === peer));
  const moved = live ? live.lent.month.requests + live.borrowed.month.requests : 0;
  useEffect(() => {
    let on = true;
    void fetch("/ui/lending", { cache: "no-store" }).then((r) => r.json()).then((d: { days: number; peers: Detail[] }) => {
      const row = d.peers.find((p) => p.peer === peer);
      if (on && row) setGot({ days: d.days, row });
    }).catch(() => {});
    return () => { on = false; };
  }, [peer, moved]);
  if (!got || !live) return null;
  const { row, days } = got;
  const anyDay = (d: Record<string, number>) => Object.values(d).some((v) => v > 0);
  const lentDays = anyDay(row.byDay.lent);
  const borrowedDays = anyDay(row.byDay.borrowed);
  const stat = (tone: string, label: string, n: number) => (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px]">
      <span aria-hidden className={cx("size-2 rounded-sm", tone)} />
      <span className="tabular font-medium">{short(n)}</span><span className="text-dim">{label}</span>
    </span>
  );
  return (
    <div ref={box} className="pb-2"><Card className="mt-4 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">{peer}</h2>
        {stat("bg-accent", "it ran here", tokens(row.lent.month))}
        {stat("bg-info", "you ran there", tokens(row.borrowed.month))}
        <span className="text-[12px] text-dim">tokens, last {days} days</span>
      </div>
      <div className="mt-5 flex flex-col gap-5">
        {live.terms !== undefined
          ? <Lent peer={peer} t={live.terms} own={live.own ?? []} today={live.lentToday ?? {}} month={row.byModel.lent} days={days} lendable={lendable} />
          : <Side tone="accent" name="lent" count={0} note={<>it has no <span className={mono}>accept</span> token, so it cannot borrow here</>}>{null}</Side>}
        {live.received !== undefined
          ? <Received peer={peer} received={live.received} month={row.byModel.borrowed} days={days} />
          : <Side tone="info" name="received" count={0} note={<>it has no <span className={mono}>url</span>, so this node cannot borrow from it</>}>{null}</Side>}
        {/* Drawn only once there is a day to draw, and keyed only for what it shows. */}
        {(lentDays || borrowedDays) && (
          <section className="border-t border-line/60 pt-4">
            <div className="flex items-center gap-4 text-[11px] text-dim">
              <span className="font-semibold uppercase tracking-wide text-fg">each day</span>
              {lentDays && <span className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm bg-accent" />lent</span>}
              {borrowedDays && <span className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm bg-info" />borrowed</span>}
            </div>
            <div className="mt-2"><Days lent={row.byDay.lent} borrowed={row.byDay.borrowed} days={days} /></div>
          </section>
        )}
      </div>
      {live.terms !== undefined && <Machine peer={peer} />}
    </Card></div>
  );
}

/** A new name for a peer. Only this node uses it; the peer is told nothing. */
function Rename({ peer, taken, onClose, onDone }: { peer: string; taken: string[]; onClose: () => void; onDone: (to: string) => void }) {
  const [to, setTo] = useState(peer);
  const [busy, setBusy] = useState(false);
  const name = to.trim();
  const problem = name === "" ? "needs a name" : name !== peer && taken.includes(name) ? `a peer named ${name} already exists` : null;
  const go = async () => {
    if (problem) return;
    if (name === peer) return onClose();
    setBusy(true);
    const ok = await edit([{ path: ["peers", peer], rename: name }], `${peer} is now ${name}`);
    setBusy(false);
    if (ok) onDone(name);
  };
  return (
    <Dialog title={`Rename ${peer}`} size="sm" onClose={onClose}>
      <form className="flex flex-col gap-2 p-4" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <input autoFocus aria-label="new name" value={to} onChange={(e) => setTo(e.target.value)} onFocus={(e) => e.currentTarget.select()}
               className={cx("h-8 rounded-md border bg-bg px-2 focus-visible:outline-2 focus-visible:outline-accent", mono, problem ? "border-bad" : "border-line")} />
        <p className="text-[12px] text-dim">The name is this node's own; the peer is not told. A rule that names it has to be changed with it, or the rename is refused.</p>
        {problem && <p className="text-[12px] text-bad">{problem}</p>}
      </form>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
        <Button onClick={onClose}>cancel</Button>
        <Button tone="primary" disabled={busy || problem !== null} onClick={() => void go()}>rename</Button>
      </div>
    </Dialog>
  );
}

/** Take a peer out of hearth.yaml, with its address, tokens and limits. */
function Remove({ peer, onClose, onDone }: { peer: string; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const ok = await edit([{ path: ["peers", peer], delete: true }], `removed ${peer}`);
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <Dialog title={`Remove ${peer}?`} size="sm" onClose={onClose}>
      <p className="p-4 text-[12px] text-dim">
        Its entry leaves hearth.yaml: its address, both tokens and its limits. It can no longer borrow here and you can no longer borrow there.
        A rule that names it has to go first, or the removal is refused. Adding it back takes a new invite or its tokens again.
      </p>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
        <Button onClick={onClose}>cancel</Button>
        <Button tone="primary" disabled={busy} onClick={() => void go()}>remove</Button>
      </div>
    </Dialog>
  );
}

const ADDRESS_KEY = "hearth.inviteUrl";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Where a friend reaches this node: the last one given here, else the page's own address unless it is loopback. */
function knownAddress(): string {
  try {
    const kept = localStorage.getItem(ADDRESS_KEY);
    if (kept) return kept;
  } catch { /* storage can be off; the field starts empty then */ }
  return LOOPBACK.has(location.hostname) ? "" : location.origin;
}

/** Mint an invite code for the address a friend reaches this node at, and show it to copy. */
function Invite({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState(knownAddress);
  const [made, setMade] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const mint = async () => {
    try {
      const d = await request<{ code: string; expiresAt: string }>("POST", "/peers/invite", { url: url.trim() });
      try { localStorage.setItem(ADDRESS_KEY, url.trim()); } catch { /* remembered only where storage allows */ }
      setMade(d);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  };
  return (
    <Dialog title="Invite a peer" onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        {made === null ? (
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void mint(); }}>
            <label htmlFor="invite-url" className="text-[12px] text-dim">The address your friend reaches this node at, such as its tailnet address and port.</label>
            <input id="invite-url" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://100.x.y.z:4141"
                   className={cx("h-8 rounded-md border border-line bg-bg px-2 focus-visible:outline-2 focus-visible:outline-accent", mono)} />
          </form>
        ) : (
          <>
            <p className="text-[12px] text-dim">
              Send this to your friend. They paste it under <span className="font-medium text-fg">join with a code</span> on their Lending page, or run <span className={mono}>hearth join</span> with it.
              It works once, until {new Date(made.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, and anyone holding it can join, so send it like a short-lived password.
            </p>
            <code className={cx("select-all break-all rounded-md border border-line bg-bg px-3 py-2", mono)}>{made.code}</code>
          </>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
        {made === null ? <Button tone="primary" disabled={url.trim() === ""} onClick={() => void mint()}>make a code</Button> : (
          <>
            {/* A page served over plain http off this machine has no clipboard; the text is selectable either way. */}
            {navigator.clipboard && <Button onClick={() => void navigator.clipboard.writeText(made.code).then(() => setCopied(true), () => {})}>{copied ? "copied" : "copy"}</Button>}
            <Button tone="primary" onClick={onClose}>done</Button>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Redeem a friend's invite code: this node joins theirs as a peer and can borrow from it at once. */
function Join({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState("");
  const [as, setAs] = useState("");
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true);
    try {
      const d = await request<{ peer: string }>("POST", "/peers/join", { code: code.trim(), ...(as.trim() ? { as: as.trim() } : {}) });
      toast("ok", `joined ${d.peer}: you can borrow from it now`);
      await refresh();
      onClose();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Join with a code" onClose={onClose}>
      <form className="flex flex-col gap-3 p-4" onSubmit={(e) => { e.preventDefault(); void join(); }}>
        <label className="flex flex-col gap-1 text-[12px] text-dim">
          The code your friend sent
          <textarea autoFocus rows={3} value={code} onChange={(e) => setCode(e.target.value)} placeholder="hearth-invite:…"
                    className={cx("rounded-md border border-line bg-bg px-2 py-1.5 text-fg focus-visible:outline-2 focus-visible:outline-accent", mono)} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-dim">
          Name for them here (optional: their node's own name otherwise)
          <input value={as} onChange={(e) => setAs(e.target.value)}
                 className={cx("h-8 rounded-md border border-line bg-bg px-2 text-fg focus-visible:outline-2 focus-visible:outline-accent", mono)} />
        </label>
      </form>
      <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
        <Button onClick={onClose}>cancel</Button>
        <Button tone="primary" disabled={busy || !code.trim().startsWith("hearth-invite:")} onClick={() => void join()}>{busy ? "joining…" : "join"}</Button>
      </div>
    </Dialog>
  );
}

export function Lending() {
  const d = useStore((s) => s.data)!;
  const rows = d.ledger ?? [];
  const defaults = d.lendDefaults ?? { tokensPerDay: 0, maxConcurrent: 2, rateLimit: 600 };
  const [open, setOpen] = useState<string | null>(null);
  const [pairing, setPairing] = useState<"invite" | "join" | null>(null);
  const [changing, setChanging] = useState<{ peer: string; how: "rename" | "remove" } | null>(null);
  // A provider's model spends its key, and a name a flow takes is a rule a peer's work never goes through: neither is offered.
  const self = d.net.nodes.find((n) => n.self)!;
  const hosted = new Set((self.backends ?? []).filter((b) => b.cloud).flatMap((b) => b.serves ?? []));
  const types = new Set(Object.values(d.flows ?? {}).flatMap((f) => f.inputs));
  const lendable = d.catalog.filter((m) => !hosted.has(m) && !types.has(m));
  const total = (pick: (r: Row) => Used) => short(rows.reduce((n, r) => n + tokens(pick(r)), 0));
  const head = "px-2 py-2 font-medium";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <p className="flex-[1_1_320px] text-dim">
          {rows.length === 0 ? "No peers yet. Invite a friend's node, join theirs with a code they sent, or add one in Config, under peers."
            : `${rows.length} ${rows.length === 1 ? "peer" : "peers"}. Over the days kept they ran ${total((r) => r.lent.month)} tokens here and you ran ${total((r) => r.borrowed.month)} on theirs.`}
        </p>
        <Button onClick={() => setPairing("invite")}>invite a peer</Button>
        <Button onClick={() => setPairing("join")}>join with a code</Button>
        <label className="flex items-center gap-2">lending <Switch label="lending" on={d.controls.lending} onChange={(on) => void flip({ lending: on }, on ? "lending resumed" : "lending paused")} /></label>
        <label className="flex items-center gap-2">borrowing <Switch label="borrowing" on={d.controls.borrowing} onChange={(on) => void flip({ borrowing: on }, on ? "borrowing resumed" : "borrowing paused")} /></label>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-dim">limits for a new peer</h2>
          <span className="text-[12px] text-dim">what a peer is held to until it is given its own below</span>
        </div>
        <div className="mt-3 flex flex-wrap items-start gap-6">
          <div><div className="mb-1 text-[12px] text-dim">may run</div><div className="flex min-h-8 items-center">
            <Models all={lendable} lent={d.configuredShare} who="every peer" onToggle={(m, on) => void flip({ share: { [m]: on } }, on ? `lending ${m}` : `holding ${m}`)} /></div></div>
          <div><div className="mb-1 text-[12px] text-dim">tokens a day, each model</div>
            <Num label="tokens a day of each model, for every peer" min={0} none="no limit" value={defaults.tokensPerDay} className="w-32" onSave={(n) => void save(["lending", "tokensPerDay"], n, "saved")} /></div>
          <div><div className="mb-1 text-[12px] text-dim">jobs at once, all models</div>
            <Num label="jobs at once, for every peer" min={1} value={defaults.maxConcurrent} className="w-16" onSave={(n) => void save(["lending", "maxConcurrent"], n, "saved")} /></div>
          <div><div className="mb-1 text-[12px] text-dim">requests an hour, each model</div>
            <Num label="requests an hour, for every peer" min={1} value={defaults.rateLimit} className="w-20" onSave={(n) => void save(["lending", "rateLimit"], n, "saved")} /></div>
        </div>
      </Card>

      {rows.length > 0 && (
        <Card className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left">
            <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
              <tr>
                <th className="px-4 py-2 font-medium">peer</th>
                <th className={head}>lending to it</th>
                <th className={head}>models</th>
                <th className={head}>used today</th>
                <th className={cx(head, "text-right")}>lent</th>
                <th className="px-4 py-2 text-right font-medium">borrowed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t: LendTerms | undefined = r.terms;
                const at = (key: string): Path => ["peers", r.peer, "lend", key];
                const lent = t ? t.models.length : 0;
                const got = Object.keys(r.received ?? {}).length;
                return (
                  <tr key={r.peer} className={cx("border-b border-line/60 align-top last:border-0", open === r.peer && "bg-accent/5")}>
                    <td className="px-4 py-3">
                      <button type="button" aria-expanded={open === r.peer} title="the models lent and received, with their limits" onClick={() => setOpen(open === r.peer ? null : r.peer)}
                              className="inline-flex items-center gap-1 font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-accent">
                        <ChevronRight size={14} className={cx("text-dim transition-transform", open === r.peer && "rotate-90")} />{r.peer}
                      </button>
                      <span className="ml-2 inline-flex items-center gap-1 align-middle">
                        <button type="button" aria-label={`rename ${r.peer}`} title="rename this peer" onClick={() => setChanging({ peer: r.peer, how: "rename" })}
                                className="inline-flex size-6 items-center justify-center rounded-md text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"><Pencil size={13} /></button>
                        <button type="button" aria-label={`remove ${r.peer}`} title="remove this peer" onClick={() => setChanging({ peer: r.peer, how: "remove" })}
                                className="inline-flex size-6 items-center justify-center rounded-md text-dim hover:text-bad focus-visible:outline-2 focus-visible:outline-accent"><Trash2 size={13} /></button>
                      </span>
                    </td>
                    {t === undefined ? <td className="px-2 py-3 text-dim">cannot borrow: it has no <span className={mono}>accept</span> token</td> : (
                      <td className="px-2 py-3">
                        <div className="flex items-center gap-2">
                          <Switch label={`lend to ${r.peer}`} on={!t.off} onChange={(on) => void save(at("off"), !on, on ? `lending to ${r.peer}` : `stopped lending to ${r.peer}`)} />
                          {r.closed == null ? <Pill tone="ok">open</Pill> : <Pill tone={t.off ? "dim" : "warn"}>{t.off ? "turned off" : "closed"}</Pill>}
                        </div>
                        {r.closed != null && !t.off && <div className="mt-1 text-[12px] text-warn">{r.closed}</div>}
                      </td>
                    )}
                    <td className="px-2 py-3">
                      <button type="button" onClick={() => setOpen(open === r.peer ? null : r.peer)} title="open to see and change each model's limits"
                              className="text-left text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
                        {t !== undefined && <span>{lent} lent</span>}{t !== undefined && r.received !== undefined && " · "}{r.received !== undefined && <span>{got} received</span>}
                      </button>
                    </td>
                    <td className="tabular px-2 py-3">{t === undefined ? <span className="text-dim">—</span> : short(tokens(r.lent.today))}</td>
                    <td className="tabular px-2 py-3 text-right" title={`${r.lent.month.requests} requests`}>{short(tokens(r.lent.month))}</td>
                    <td className="tabular px-4 py-3 text-right" title={`${r.borrowed.month.requests} requests`}>{short(tokens(r.borrowed.month))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {open !== null && <PeerDetail peer={open} lendable={lendable} />}
      {pairing === "invite" && <Invite onClose={() => setPairing(null)} />}
      {pairing === "join" && <Join onClose={() => setPairing(null)} />}
      {changing?.how === "rename" && (
        <Rename peer={changing.peer} taken={rows.map((r) => r.peer)} onClose={() => setChanging(null)}
                onDone={(to) => { if (open === changing.peer) setOpen(to); setChanging(null); }} />
      )}
      {changing?.how === "remove" && (
        <Remove peer={changing.peer} onClose={() => setChanging(null)}
                onDone={() => { if (open === changing.peer) setOpen(null); setChanging(null); }} />
      )}
      <Menu />
    </div>
  );
}
