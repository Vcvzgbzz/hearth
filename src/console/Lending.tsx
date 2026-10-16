/** The Lending page: what peers may take, each one's own limits, and what was lent and borrowed. */
import { ChevronRight, Plus, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Menu } from "./editor.js";
import { choose } from "./editStore.js";
import { short } from "./pages.js";
import { control, refresh, request, toast, useStore } from "./store.js";
import type { LendTerms, UiData, Used } from "./types.js";
import { Button, Card, cx, Dialog, mono, Pill, Switch } from "./ui.js";

type Row = NonNullable<UiData["ledger"]>[number];
type Path = (string | number)[];
/** One peer as `GET /lending` gives it: the row, with its use by model and by day. */
type Detail = Row & { byModel: { lent: Record<string, Used>; borrowed: Record<string, Used> }; byDay: { lent: Record<string, number>; borrowed: Record<string, number> } };

const tokens = (u: Used): number => u.in + u.out;

/** Write one setting into hearth.yaml, or with no value take it out; it applies at once. */
async function save(path: Path, value: unknown, done: string): Promise<void> {
  try {
    await request("PATCH", "/config", { ops: [value === undefined ? { path, delete: true } : { path, value }] });
    toast("ok", done);
    await refresh();
  } catch (e) {
    toast("bad", e instanceof Error ? e.message : String(e));
  }
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

/** Takes one of a peer's own limits out of the file, so the node's holds it again. */
function Back({ peer, what, path }: { peer: string; what: string; path: Path }) {
  return (
    <button type="button" aria-label={`${peer}: ${what} back to the limit for every peer`} title="back to the limit for every peer"
            onClick={() => void save(path, undefined, `${peer}: ${what} as for every peer`)}
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

/** One peer's use by model each way, and by day. */
function PeerDetail({ peer }: { peer: string }) {
  const [got, setGot] = useState<{ days: number; row: Detail } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const shown = got?.row.peer;
  // It opens under the table, which can be below what is on screen.
  useEffect(() => { if (shown) box.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [shown]);
  // Asked again as the totals move, so the breakdown never trails the row above it.
  const moved = useStore((s) => { const r = (s.data!.ledger ?? []).find((l) => l.peer === peer); return r ? r.lent.month.requests + r.borrowed.month.requests : 0; });
  useEffect(() => {
    let live = true;
    void fetch("/ui/lending", { cache: "no-store" }).then((r) => r.json()).then((d: { days: number; peers: Detail[] }) => {
      const row = d.peers.find((p) => p.peer === peer);
      if (live && row) setGot({ days: d.days, row });
    }).catch(() => {});
    return () => { live = false; };
  }, [peer, moved]);
  if (!got) return null;
  const { row, days } = got;
  const lines = [
    ...Object.entries(row.byModel.lent).map(([model, u]) => ({ model, way: "lent", u })),
    ...Object.entries(row.byModel.borrowed).map(([model, u]) => ({ model, way: "borrowed", u })),
  ];
  return (
    <div ref={box} className="pb-2"><Card className="mt-4 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-base font-semibold">{peer}</h2>
        <span className="text-dim">ran {short(tokens(row.lent.month))} tokens here in {days} days; you ran {short(tokens(row.borrowed.month))} there</span>
      </div>
      <div className="mt-4 flex flex-wrap gap-8">
        <div className="min-w-0 flex-[1_1_340px]">
          <div className="text-[11px] font-medium uppercase tracking-wide text-dim">by model</div>
          {lines.length === 0 ? <p className="mt-2 text-dim">Nothing lent or borrowed yet.</p> : (
            <table className="mt-1 w-full text-left">
              <thead className="text-[11px] text-dim">
                <tr><th className="py-1.5 font-medium">model</th><th className="px-2 py-1.5 font-medium">direction</th><th className="px-2 py-1.5 text-right font-medium">requests</th><th className="py-1.5 text-right font-medium">tokens</th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={`${l.way}:${l.model}`} className="border-t border-line/60">
                    <td className={cx("py-2", mono)}>{l.model}</td>
                    <td className="px-2 py-2 text-dim">{l.way}</td>
                    <td className="tabular px-2 py-2 text-right">{l.u.requests.toLocaleString()}{l.u.failed > 0 && <span className="text-bad"> · {l.u.failed} failed</span>}</td>
                    <td className="tabular py-2 text-right">{short(tokens(l.u))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="min-w-0 flex-[1_1_380px]">
          <div className="flex items-center gap-4 text-[11px] text-dim">
            <span className="font-medium uppercase tracking-wide">each day</span>
            <span className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm bg-accent" />lent</span>
            <span className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm bg-info" />borrowed</span>
          </div>
          <div className="mt-2"><Days lent={row.byDay.lent} borrowed={row.byDay.borrowed} days={days} /></div>
        </div>
      </div>
      {row.terms !== undefined && <Machine peer={peer} />}
    </Card></div>
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
  // A provider's model spends its key, and a name a flow takes is a rule a peer's work never goes through: neither is offered.
  const self = d.net.nodes.find((n) => n.self)!;
  const hosted = new Set((self.backends ?? []).filter((b) => b.cloud).flatMap((b) => b.serves ?? []));
  const types = new Set(Object.values(d.flows ?? {}).flatMap((f) => f.inputs));
  const lendable = d.catalog.filter((m) => !hosted.has(m) && !types.has(m));
  const total = (pick: (r: Row) => Used) => short(rows.reduce((n, r) => n + tokens(pick(r)), 0));
  const head = "px-2 py-2 font-medium";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-4">
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
        <div className="mt-3 flex flex-wrap items-end gap-6">
          <div><div className="mb-1 text-[12px] text-dim">may run</div>
            <Models all={lendable} lent={d.configuredShare} who="every peer" onToggle={(m, on) => void flip({ share: { [m]: on } }, on ? `lending ${m}` : `holding ${m}`)} /></div>
          <div><div className="mb-1 text-[12px] text-dim">tokens a day</div>
            <Num label="tokens a day, for every peer" min={0} none="no limit" value={defaults.tokensPerDay} className="w-32" onSave={(n) => void save(["lending", "tokensPerDay"], n, "saved")} /></div>
          <div><div className="mb-1 text-[12px] text-dim">jobs at once</div>
            <Num label="jobs at once, for every peer" min={1} value={defaults.maxConcurrent} className="w-16" onSave={(n) => void save(["lending", "maxConcurrent"], n, "saved")} /></div>
          <div><div className="mb-1 text-[12px] text-dim">requests an hour</div>
            <Num label="requests an hour, for every peer" min={1} value={defaults.rateLimit} className="w-20" onSave={(n) => void save(["lending", "rateLimit"], n, "saved")} /></div>
        </div>
      </Card>

      {rows.length > 0 && (
        <Card className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left">
            <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
              <tr>
                <th className="px-4 py-2 font-medium">peer</th>
                <th className={head}>lending to it</th>
                <th className={head}>may run</th>
                <th className={head}>tokens a day</th>
                <th className={head}>jobs</th>
                <th className={head}>req / hour</th>
                <th className={head}>used today</th>
                <th className={cx(head, "text-right")}>lent</th>
                <th className="px-4 py-2 text-right font-medium">borrowed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t: LendTerms | undefined = r.terms;
                const at = (key: string): Path => ["peers", r.peer, "lend", key];
                const used = tokens(r.lent.today);
                // A limit the peer does not restate is the node's: drawn dim, and one of its own can be put back to it.
                const own = (key: string) => (r.own ?? []).includes(key);
                const num = (key: string) => ({ className: own(key) ? undefined : "text-dim", title: own(key) ? undefined : "the limit for every peer" });
                const spent = t !== undefined && t.tokensPerDay > 0 && used >= t.tokensPerDay;
                return (
                  <tr key={r.peer} className={cx("border-b border-line/60 align-top last:border-0", open === r.peer && "bg-accent/5")}>
                    <td className="px-4 py-3">
                      <button type="button" aria-expanded={open === r.peer} title="what it used, by model and by day" onClick={() => setOpen(open === r.peer ? null : r.peer)}
                              className="inline-flex items-center gap-1 font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-accent">
                        <ChevronRight size={14} className={cx("text-dim transition-transform", open === r.peer && "rotate-90")} />{r.peer}
                      </button>
                    </td>
                    {t === undefined ? <td colSpan={6} className="px-2 py-3 text-dim">cannot borrow: it has no <span className={mono}>accept</span> token</td> : (
                      <>
                        <td className="px-2 py-3">
                          <div className="flex items-center gap-2">
                            <Switch label={`lend to ${r.peer}`} on={!t.off} onChange={(on) => void save(at("off"), !on, on ? `lending to ${r.peer}` : `stopped lending to ${r.peer}`)} />
                            {r.closed == null ? <Pill tone="ok">open</Pill> : <Pill tone={t.off ? "dim" : "warn"}>{t.off ? "turned off" : "closed"}</Pill>}
                          </div>
                          {r.closed != null && !t.off && <div className="mt-1 text-[12px] text-warn">{r.closed}</div>}
                        </td>
                        <td className="px-2 py-3">
                          <div className={cx("flex items-start gap-1", !own("models") && "text-dim")} title={own("models") ? undefined : "what every peer may run"}>
                            <Models all={lendable} lent={t.models} who={r.peer} disabled={t.off}
                                    onToggle={(m, on) => void save(at("models"), on ? [...t.models, m] : t.models.filter((x) => x !== m), on ? `lending ${m} to ${r.peer}` : `holding ${m} from ${r.peer}`)} />
                            {own("models") && <Back peer={r.peer} what="models" path={at("models")} />}
                          </div>
                        </td>
                        <td className="px-2 py-3"><div className="flex items-center gap-1">
                          <Num label={`${r.peer}: tokens a day`} min={0} none="no limit" disabled={t.off} value={t.tokensPerDay} {...num("tokensPerDay")} className={cx("w-28", num("tokensPerDay").className)} onSave={(n) => void save(at("tokensPerDay"), n, "saved")} />
                          {own("tokensPerDay") && <Back peer={r.peer} what="tokens a day" path={at("tokensPerDay")} />}
                        </div></td>
                        <td className="px-2 py-3"><div className="flex items-center gap-1">
                          <Num label={`${r.peer}: jobs at once`} min={1} disabled={t.off} value={t.maxConcurrent} {...num("maxConcurrent")} className={cx("w-14", num("maxConcurrent").className)} onSave={(n) => void save(at("maxConcurrent"), n, "saved")} />
                          {own("maxConcurrent") && <Back peer={r.peer} what="jobs at once" path={at("maxConcurrent")} />}
                        </div></td>
                        <td className="px-2 py-3"><div className="flex items-center gap-1">
                          <Num label={`${r.peer}: requests an hour`} min={1} disabled={t.off} value={t.rateLimit} {...num("rateLimit")} className={cx("w-18", num("rateLimit").className)} onSave={(n) => void save(at("rateLimit"), n, "saved")} />
                          {own("rateLimit") && <Back peer={r.peer} what="requests an hour" path={at("rateLimit")} />}
                        </div></td>
                        <td className="tabular px-2 py-3">
                          {short(used)} <span className="text-dim">{t.tokensPerDay > 0 ? `of ${short(t.tokensPerDay)}` : "· no limit"}</span>
                          {t.tokensPerDay > 0 && (
                            <div aria-hidden className="mt-1.5 h-1 w-28 rounded-full bg-muted">
                              <div className={cx("h-1 rounded-full", spent ? "bg-warn" : "bg-accent")} style={{ width: `${Math.min(100, (used / t.tokensPerDay) * 100)}%` }} />
                            </div>
                          )}
                        </td>
                      </>
                    )}
                    <td className="tabular px-2 py-3 text-right" title={`${r.lent.month.requests} requests`}>{short(tokens(r.lent.month))}</td>
                    <td className="tabular px-4 py-3 text-right" title={`${r.borrowed.month.requests} requests`}>{short(tokens(r.borrowed.month))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {open !== null && <PeerDetail peer={open} />}
      {pairing === "invite" && <Invite onClose={() => setPairing(null)} />}
      {pairing === "join" && <Join onClose={() => setPairing(null)} />}
      <Menu />
    </div>
  );
}
