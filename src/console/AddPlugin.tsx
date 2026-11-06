/**
 * Adding a plugin from the console: an API, an MCP server on the network (checked by its handshake), or a hook
 * service (checked at its /manifest), each written to hearth.yaml through the same review as every other edit.
 * Code plugins and MCP servers hearth runs are added in the file by hand, so running someone else's code stays
 * a deliberate act; the dialog writes out the entry to add.
 */
import { CircleDashed, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Review, type File, type Plan } from "./config.js";
import { splitMcp } from "./draft.js";
import { modelsOfKind } from "./flowNodes.js";
import { LockedOpen } from "./Plugins.js";
import type { PluginStage } from "./types.js";
import { refresh, request, toast, useStore } from "./store.js";
import { Button, cx, Dialog, mono } from "./ui.js";

type Declared = Partial<Record<string, PluginStage[]>>;
type Needs = Record<string, { kind: string; optional?: boolean }>;

const NO_MODELS: string[] = [];
const STAGE_WORDS: Record<string, string> = {
  request: "before routing", routed: "after routing", parallel: "beside the model", stream: "while streaming",
  response: "on the reply", log: "after the reply", error: "on error",
};
const hookWords = (h: string) => { const [k, s] = h.split(":"); return `${k} · ${STAGE_WORDS[s!] ?? s}`; };

const READS: { id: "messages" | "headers" | "reply"; says: string }[] = [
  { id: "messages", says: "the request body: the conversation and its settings" },
  { id: "headers", says: "the request's headers, without authorization or cookies" },
  { id: "reply", says: "the model's answer, after it is sent" },
];

/** A name from the service's address: its last path segment or its host, made a valid plugin name. */
const nameFrom = (url: string): string => {
  try {
    const u = new URL(url);
    // A host given as an address says nothing about what runs there, so it suggests no name.
    const host = /^[\d.]+$|^\[/.test(u.hostname) ? "" : u.hostname.split(".")[0] ?? "";
    const seg = u.pathname.split("/").filter(Boolean).filter((s) => !/^(hooks?|api|mcp|v\d+)$/i.test(s)).pop() ?? host;
    return seg.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  } catch {
    return "";
  }
};

const input = "h-8 w-full rounded-md border border-line bg-bg px-2 text-[13px] focus:border-accent focus:outline-none";

function Field({ label, hint, bad, children }: { label: string; hint?: string; /** The hint says what is wrong with the value. */ bad?: boolean; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium">{label}</span>
      {children}
      {hint && <span className={cx("text-[11px]", bad ? "text-bad" : "text-dim")}>{hint}</span>}
    </label>
  );
}

const H = "text-[11px] font-semibold uppercase tracking-wide text-dim";

/** A name as it is typed: lowercase, anything but letters, digits and dashes turned into a dash, as in `my.tools` to `my-tools`. */
const asName = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

/** Why a name cannot be a new plugin's, or null. */
const nameWhy = (name: string, taken: Set<string>): string | null =>
  !name ? "give it a name" : !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? "a name starts with a letter or digit, and is lowercase letters, digits and dashes" : name === "probe" ? "probe is the console's own path" : taken.has(name) ? `${name} is already a plugin` : null;

/** A key field: the environment variable hearth reads it from, so the key itself never goes in the file. */
/** An environment variable's name, as opposed to a key pasted in: capitals, digits and underscores. */
const isVarName = (v: string) => /^[A-Z_][A-Z0-9_]*$/.test(v);

/** A key as the entry holds it: `env:NAME` for a variable's name, or the key itself. */
const keyOf = (v: string): string | null => (v.trim() === "" ? null : isVarName(v.trim()) ? `env:${v.trim()}` : v.trim());

/** A key field: the name of the environment variable hearth reads it from, or the key itself, which then goes in the file. */
function KeyField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const v = value.trim();
  const literal = v !== "" && !isVarName(v);
  return (
    <Field label="Key (optional)" hint={v === "" ? "sent to it as a bearer token: the key itself, or the name of an environment variable hearth reads it from"
      : literal ? "the key itself: it is written into hearth.yaml, like the other keys there. A variable's name keeps it out" : `read from the variable ${v} in hearth's environment; the key stays out of the file`}>
      <input className={cx(input, mono, literal && "border-warn")} type={literal ? "password" : "text"} autoComplete="off" spellCheck={false} value={value} placeholder="the key, or MY_SERVICE_KEY" onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/**
 * A plugin that serves: an API, or an MCP server on the network, written through the review; or an MCP server
 * hearth runs, which is code and so is shown as the entry to add by hand.
 */
function Serving({ kind, file, taken, onPlan, onClose }: { kind: "api" | "mcp"; file: File | null; taken: Set<string>; onPlan: (p: Plan | null) => void; onClose: () => void }) {
  const [where, setWhere] = useState<"network" | "program">("network");
  const [url, setUrl] = useState("");
  const [keyVar, setKeyVar] = useState("");
  const [name, setName] = useState("");
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState<{ name: string; from: string }[]>([{ name: "", from: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const nameProblem = nameWhy(name, taken);
  const urlOk = /^https?:\/\/[^/\s]+/.test(url.trim());
  const program = kind === "mcp" && where === "program";

  const check = async () => {
    setChecking(true); setProblem(null); setFound(null);
    try {
      const at = splitMcp(url)!;
      const key = keyOf(keyVar);
      const r = await request<{ ok: boolean; server?: string | null; tools?: number; problem?: string }>("POST", "/plugins/probe", { url: at.serves, mcp: at.path, ...(key ? { key } : {}) });
      if (!r.ok) setProblem(r.problem ?? "it did not answer");
      else setFound(`${r.server ?? "An MCP server"} answers, with ${r.tools ?? 0} tool${r.tools === 1 ? "" : "s"}.`);
      if (!name) setName(nameFrom(url.trim()));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const at = kind === "mcp" ? splitMcp(url) : null;
  const entry = (): Record<string, unknown> => ({
    serves: at ? at.serves : url.trim().replace(/\/$/, ""), trust: "http",
    ...(keyOf(keyVar) ? { key: keyOf(keyVar) } : {}),
    ...(at ? { mcp: at.path === "/mcp" ? true : at.path } : {}),
  });

  const review = async () => {
    if (!file) return;
    setErr(null);
    const body = { baseHash: file.hash, ops: [{ path: ["plugins", name], value: entry() }] };
    try {
      const dry = await request<{ text: string; restartPending: string[] }>("PATCH", "/config", { ...body, dryRun: true });
      onPlan({
        before: file.text, after: dry.text, restartPending: dry.restartPending, verb: "add plugin",
        summary: [
          at ? `adds ${name}, an MCP server at ${at.serves}${at.path}` : `adds ${name}, an API at ${url.trim()}`,
          `callers reach it at /plugins/${name}${at ? at.path : "/"} with their hearth key`,
          !keyVar.trim() ? "it is sent no key of its own" : isVarName(keyVar.trim()) ? `it is sent the key in ${keyVar.trim()}, read from hearth's environment` : "it is sent the key you gave, which is written into hearth.yaml",
        ],
        commit: async () => {
          try {
            await request("PATCH", "/config", body);
            toast("ok", `${name} added — restart hearth to start it`);
            await refresh();
            onClose();
          } catch (e) {
            onPlan(null);
            setErr(e instanceof Error ? e.message : String(e));
          }
        },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const argList = args.split("\n").map((a) => a.trim()).filter(Boolean);
  const envRows = env.filter((r) => r.name.trim());
  const snippet = `plugins:
  ${name || "my-tools"}:
    run:
      command: ${command || "npx"}
      args: [${argList.map((a) => JSON.stringify(a)).join(", ")}]${envRows.length ? `
      env:
${envRows.map((r) => `        ${r.name.trim()}: env:${r.from.trim() || r.name.trim()}`).join("\n")}` : ""}
    trust: code                       # it runs on this machine: the opt-in`;

  return (
    <form className="flex flex-col gap-4 overflow-auto p-4" onSubmit={(e) => { e.preventDefault(); if (!program && !nameProblem && urlOk) void review(); }}>
      {kind === "mcp" && (
        <section className="flex flex-col gap-2">
          <div className={H}>What it is</div>
          <label className="flex items-start gap-2 text-[12px]">
            <input type="radio" name="mcp-where" className="mt-0.5" checked={where === "network"} onChange={() => setWhere("network")} />
            <span><b className="font-medium">On the network</b> <span className="text-dim">— an MCP server with an address of its own; hearth passes callers through to it.</span></span>
          </label>
          <label className="flex items-start gap-2 text-[12px]">
            <input type="radio" name="mcp-where" className="mt-0.5" checked={where === "program"} onChange={() => setWhere("program")} />
            <span><b className="font-medium">A program hearth runs</b> <span className="text-dim">— one that speaks MCP over stdin and stdout, as most published ones do (<code className={mono}>npx …</code>).</span></span>
          </label>
        </section>
      )}

      {program ? (
        <section className="flex flex-col gap-3 text-[12px]">
          <div className="flex gap-2 rounded-md border border-warn/50 px-3 py-2">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" />
            <span>hearth starts this program on its own machine, with hearth's own access, and fetches it first if it is an <code className={mono}>npx</code> package. Like code, it is not added for you: fill it in here, then put the entry below into <code className={mono}>hearth.yaml</code> yourself and restart.</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label="Command"><input className={cx(input, mono)} value={command} onChange={(e) => setCommand(e.target.value)} /></Field>
            <Field label="Arguments" hint="one per line">
              <textarea rows={2} className={cx(input, mono, "h-auto py-1")} value={args} placeholder={"-y\nsome-mcp-server"} onChange={(e) => setArgs(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium">Environment</span>
            <span className="text-[11px] text-dim">What the program needs, such as its API key, each read from a variable in hearth's own environment. It sees these, and of hearth's only PATH, HOME and TMPDIR.</span>
            {env.map((r, i) => (
              <span key={i} className="flex items-center gap-1">
                <input className={cx(input, mono)} value={r.name} placeholder="SOME_API_KEY" onChange={(e) => setEnv(env.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") } : x)))} />
                <span className={cx(mono, "shrink-0 text-dim")}>= env:</span>
                <input className={cx(input, mono)} value={r.from} placeholder={r.name || "THE_SAME_NAME"} onChange={(e) => setEnv(env.map((x, j) => (j === i ? { ...x, from: e.target.value.replace(/[^A-Za-z0-9_]/g, "") } : x)))} />
              </span>
            ))}
            <button type="button" className="self-start text-[12px] text-accent underline" onClick={() => setEnv([...env, { name: "", from: "" }])}>add a variable</button>
          </div>
          <Field label="Name" bad={!!name && nameProblem !== null} hint={nameProblem ?? `callers reach it at /plugins/${name || "<name>"}/mcp`}>
            <input className={cx(input, mono, nameProblem && name && "border-bad")} value={name} onChange={(e) => setName(asName(e.target.value))} />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="flex items-center justify-between"><span className={H}>Add this to hearth.yaml</span>
              <button type="button" className="text-[12px] text-accent underline" onClick={() => void navigator.clipboard.writeText(snippet).then(() => toast("ok", "copied"))}>copy</button>
            </span>
            <pre className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-[12px] leading-5">{snippet}</pre>
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <div className={H}>Where it is</div>
          <div className="grid gap-3 sm:grid-cols-[1fr_16rem]">
            <Field label={kind === "mcp" ? "MCP address" : "Address"} hint={kind === "mcp" ? "the full address of its MCP endpoint, as its docs give it, such as https://example.com/api/mcp" : `callers' /plugins/${name || "<name>"}/<path> goes to <address>/<path>`}>
              <input autoFocus className={cx(input, mono)} value={url} placeholder="http://127.0.0.1:9000" onChange={(e) => { setUrl(e.target.value); setFound(null); setProblem(null); if (!name || name === nameFrom(url.trim())) setName(nameFrom(e.target.value.trim())); }} />
            </Field>
            <KeyField value={keyVar} onChange={(v) => { setKeyVar(v); setFound(null); setProblem(null); }} />
          </div>
          {kind === "mcp" && (
            <div className="flex items-center gap-3">
              <Button onClick={() => void check()} disabled={checking || !urlOk}>{checking ? "checking…" : found ? "check again" : "check it"}</Button>
              {problem && <span className="text-[12px] text-bad">{problem}</span>}
              {found && <span className="text-[12px] text-ok">{found}</span>}
            </div>
          )}
          <Field label="Name" bad={!!name && nameProblem !== null} hint={nameProblem ?? `callers reach it at /plugins/${name || "<name>"}${at ? at.path : "/"} with their hearth key`}>
            <input className={cx(input, mono, nameProblem && name && "border-bad")} value={name} onChange={(e) => setName(asName(e.target.value))} />
          </Field>
          <p className="text-[11px] text-dim">Nothing is written until you review it. hearth reads plugins at startup, so a new one starts after a restart.</p>
        </section>
      )}
      {err && <div className="text-[12px] text-bad">{err}</div>}
      <div className="-mx-4 -mb-4 mt-auto flex justify-end gap-2 border-t border-line px-4 py-3">
        <Button onClick={onClose}>{program ? "close" : "cancel"}</Button>
        {!program && <Button tone="primary" disabled={!urlOk || nameProblem !== null || !file} onClick={() => void review()}>review</Button>}
      </div>
    </form>
  );
}

export function AddPlugin({ onClose }: { onClose: () => void }) {
  const pl = useStore((s) => s.data?.plugins);
  const catalog = useStore((s) => s.data?.catalog) ?? NO_MODELS;
  const [how, setHow] = useState<"api" | "mcp" | "http" | "code">("api");
  const [url, setUrl] = useState("");
  const [keyVar, setKeyVar] = useState("");
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<{ url: string; kinds: Declared; needs: Needs } | null>(null);
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [everyLine, setEveryLine] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [reads, setReads] = useState<Set<string>>(new Set(["messages"]));
  const [hooks, setHooks] = useState<Set<string>>(new Set());
  const [onError, setOnError] = useState<"skip" | "refuse">("skip");
  const [onFail, setOnFail] = useState<"refuse" | "flag">("refuse");
  const [timeoutMs, setTimeoutMs] = useState(300);
  const [locked, setLocked] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void request<File>("GET", "/config").then(setFile, (e: Error) => setErr(e.message)); }, []);

  const taken = new Set([...Object.keys((file?.doc?.plugins as Record<string, unknown> | undefined) ?? {}), ...(pl?.plugins ?? []).map((p) => p.name)]);
  const unwired = found ? Object.entries(found.needs).filter(([slot, n]) => !n.optional && !slots[slot]).map(([slot]) => slot) : [];
  const nameProblem = !name ? "give it a name" : !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? "a name starts with a letter or digit, and is lowercase letters, digits and dashes" : taken.has(name) ? `${name} is already a plugin` : null;
  const all = found ? Object.entries(found.kinds).flatMap(([k, st]) => (st ?? []).map((s) => `${k}:${s}`)) : [];
  const blocking = all.some((h) => h.endsWith(":request") || h.endsWith(":routed") || h.endsWith(":parallel") || h.endsWith(":response"));
  const liveHook = (h: string) => { const [k, s] = h.split(":"); return !!pl?.liveKinds.includes(k!) && !!pl.liveStages.includes(s as PluginStage); };

  const check = async () => {
    setChecking(true);
    setProblem(null);
    setFound(null);
    try {
      const r = await request<{ ok: boolean; url: string; kinds?: Declared; needs?: Needs; problem?: string }>("POST", "/plugins/probe", { url: url.trim(), ...(keyVar.trim() ? { key: `env:${keyVar.trim()}` } : {}) });
      if (!r.ok) { setProblem(r.problem ?? "it did not answer"); return; }
      setFound({ url: r.url, kinds: r.kinds!, needs: r.needs ?? {} });
      // A slot with exactly one model of its kind is wired to it; the operator can change it.
      setSlots(Object.fromEntries(Object.entries(r.needs ?? {}).flatMap(([slot, n]) => { const m = modelsOfKind(pl, catalog, n.kind); return m.length === 1 ? [[slot, m[0]!]] : []; })));
      setHooks(new Set(Object.entries(r.kinds!).flatMap(([k, st]) => (st ?? []).map((s) => `${k}:${s}`))));
      if (!name) setName(nameFrom(r.url));
      if (Object.values(r.kinds!).some((st) => st?.includes("log") || st?.includes("error"))) setReads((x) => new Set([...x, "reply"]));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  /** The entry as hearth.yaml will hold it: only what differs from the defaults, so the file stays short. */
  const entry = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { use: found!.url, trust: "http" };
    if (keyVar.trim()) out.key = `env:${keyVar.trim()}`;
    if (hooks.size < all.length) {
      const k: Record<string, string[]> = {};
      for (const h of hooks) { const [kind, stage] = h.split(":"); (k[kind!] ??= []).push(stage!); }
      out.kinds = k;
    }
    const r = READS.map((x) => x.id).filter((x) => reads.has(x));
    if (!(r.length === 1 && r[0] === "messages")) out.reads = r;
    if (timeoutMs !== 300) out.timeoutMs = timeoutMs;
    if (onError !== "skip") out.onError = onError;
    if (onFail !== "refuse") out.onFail = onFail;
    if (locked) out.locked = true;
    if (everyLine) out.everyLine = true;
    if (Object.keys(slots).length) out.models = { ...slots };
    return out;
  };

  const review = async () => {
    if (!file) return;
    setErr(null);
    const body = { baseHash: file.hash, ops: [{ path: ["plugins", name], value: entry() }] };
    try {
      const dry = await request<{ text: string; restartPending: string[] }>("PATCH", "/config", { ...body, dryRun: true });
      setPlan({
        before: file.text, after: dry.text, restartPending: dry.restartPending, verb: "add plugin",
        summary: [
          `adds ${name}, a service at ${found!.url}`,
          `runs on ${[...hooks].map(hookWords).join(", ")}`,
          `is sent ${[...reads].join(", ") || "only the request's facts"}`,
          ...Object.entries(slots).map(([slot, m]) => `wires ${m} into its ${slot} slot`),
          everyLine ? "runs on every line" : "runs where you put it on the Routing map",
          "settings left at their defaults are not written to the file",
        ],
        commit: async () => {
          try {
            await request("PATCH", "/config", body);
            toast("ok", everyLine ? `${name} added — restart hearth to start it` : `${name} added — restart hearth, then put it on a line on the Routing map`);
            await refresh();
            onClose();
          } catch (e) {
            setPlan(null);
            setErr(e instanceof Error ? e.message : String(e));
          }
        },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (plan) return <Review plan={plan} onClose={() => setPlan(null)} />;

  return (
    <Dialog title="Add a plugin" size="lg" onClose={onClose}>
      <div className="flex gap-1 border-b border-line px-4 pt-2" role="tablist">
        {([["api", "An API"], ["mcp", "MCP server"], ["http", "A hook service"], ["code", "Code inside hearth"]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={how === id} onClick={() => setHow(id)}
                  className={cx("-mb-px border-b-2 px-2 py-2 text-[12px]", how === id ? "border-accent text-fg" : "border-transparent text-dim hover:text-fg")}>{label}</button>
        ))}
      </div>

      {how === "api" || how === "mcp" ? (
        <Serving key={how} kind={how} file={file} taken={taken} onPlan={setPlan} onClose={onClose} />
      ) : how === "code" ? (
        <div className="flex flex-col gap-3 overflow-auto p-4 text-[12px]">
          <div className="flex gap-2 rounded-md border border-warn/50 px-3 py-2">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" />
            <span>A code plugin runs inside hearth with all of hearth's access: its keys, its files, every request. hearth will not add one for you. Read the code, then add it to <code className={mono}>hearth.yaml</code> yourself, pinned to an exact version or file hash, and restart.</span>
          </div>
          <pre className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-[12px] leading-5">{`plugins:
  my-plugin:
    use: npm:my-plugin@1.2.3          # installed beside hearth; or file:./plugins/my-plugin.js
    trust: code                       # the opt-in: it runs inside hearth
    # integrity: sha256-…             # for file:, the hash it must have
    onError: skip`}</pre>
          <p className="text-dim">See docs/plugins.md for what a code plugin exports.</p>
        </div>
      ) : (
        <form className="flex flex-col gap-4 overflow-auto p-4" onSubmit={(e) => { e.preventDefault(); if (!found) void check(); else if (!nameProblem && hooks.size) void review(); }}>
          <section className="flex flex-col gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">Where it is</div>
            <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
              <Field label="Address" hint="hearth reads what it handles from <address>/manifest, and calls the address once per hook.">
                <input autoFocus className={cx(input, mono)} value={url} placeholder="http://127.0.0.1:9000/hook" onChange={(e) => { setUrl(e.target.value); setFound(null); setProblem(null); }} />
              </Field>
              <Field label="Key (optional)" hint="the environment variable hearth reads it from; the key never goes in the file">
                <span className="flex items-center gap-1"><span className={cx(mono, "text-dim")}>env:</span>
                  <input className={cx(input, mono)} value={keyVar} placeholder="MY_PLUGIN_KEY" onChange={(e) => { setKeyVar(e.target.value.replace(/[^A-Za-z0-9_]/g, "")); setFound(null); }} />
                </span>
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={() => void check()} disabled={checking || !url.trim()}>{checking ? "checking…" : found ? "check again" : "check it"}</Button>
              {problem && <span className="text-[12px] text-bad">{problem}</span>}
              {found && <span className="text-[12px] text-ok">It answers, and handles {Object.keys(found.kinds).join(", ") || "nothing"}.</span>}
            </div>
          </section>

          {found && (
            <>
              <section className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">What it runs on</div>
                <p className="text-[12px] text-dim">What it declares. Untick any you do not want; hearth never calls it for anything it does not declare.</p>
                <div className="flex flex-wrap gap-2">
                  {all.map((h) => (
                    <label key={h} className={cx("flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]", liveHook(h) ? "border-line" : "border-dashed border-line text-dim")}>
                      <input type="checkbox" checked={hooks.has(h)} onChange={(e) => setHooks((x) => { const n = new Set(x); if (e.target.checked) n.add(h); else n.delete(h); return n; })} />
                      <span>{hookWords(h)}</span>
                      {!liveHook(h) && <span title="this version of hearth does not run it yet"><CircleDashed size={11} /></span>}
                    </label>
                  ))}
                </div>
                {all.some((h) => !liveHook(h)) && <p className="text-[11px] text-dim">Dashed: declared, but this version of hearth does not run it yet.</p>}
              </section>

              {Object.keys(found.needs).length > 0 && (
                <section className="flex flex-col gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">Models it needs</div>
                  <p className="text-[12px] text-dim">It asks hearth for these, which queues them like any other request. Wired here, a model is its default on every line; a line can wire its own.</p>
                  {Object.entries(found.needs).map(([slot, n]) => {
                    const options = modelsOfKind(pl, catalog, n.kind);
                    return (
                      <label key={slot} className="flex items-center gap-2 text-[12px]">
                        <span className="w-32 shrink-0">{slot} <span className="text-dim">· {n.kind}</span></span>
                        <select className={cx(input, !slots[slot] && !n.optional && "border-warn")} value={slots[slot] ?? ""} onChange={(e) => setSlots((x) => { const { [slot]: _, ...rest } = x; return e.target.value ? { ...rest, [slot]: e.target.value } : rest; })}>
                          <option value="">{n.optional ? "none (optional)" : "pick a model"}</option>
                          {options.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </label>
                    );
                  })}
                  {unwired.length > 0 && <p className="text-[11px] text-warn">Until {unwired.join(" and ")} {unwired.length === 1 ? "has" : "have"} a model, it is skipped on every line. A model's kind is set under Models (<code className={mono}>kind: embeddings</code>).</p>}
                </section>
              )}

              <section className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">Where it runs</div>
                <label className="flex items-start gap-2 text-[12px]">
                  <input type="radio" name="where" className="mt-0.5" checked={!everyLine} onChange={() => setEveryLine(false)} />
                  <span><b className="font-medium">Where I put it</b> <span className="text-dim">— a block on the lines you choose on the Routing map.</span></span>
                </label>
                <label className="flex items-start gap-2 text-[12px]">
                  <input type="radio" name="where" className="mt-0.5" checked={everyLine} onChange={() => setEveryLine(true)} />
                  <span><b className="font-medium">On every line</b> <span className="text-dim">— every request it handles, before routing too. For safety and privacy checks.</span></span>
                </label>
              </section>

              <section className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">What it is sent</div>
                <p className="text-[12px] text-dim">It always gets the request's facts: its id, kind, model, caller and where it runs. Anything else leaves hearth only if ticked.</p>
                {READS.map((r) => (
                  <label key={r.id} className="flex items-start gap-2 text-[12px]">
                    <input type="checkbox" className="mt-0.5" checked={reads.has(r.id)} onChange={(e) => setReads((x) => { const n = new Set(x); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                    <span><b className="font-medium">{r.id}</b> <span className="text-dim">— {r.says}</span></span>
                  </label>
                ))}
              </section>

              <section className="flex flex-col gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">When things go wrong</div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="If it can't answer" hint="down, slow or erroring">
                    <select className={input} value={onError} onChange={(e) => setOnError(e.target.value as "skip" | "refuse")}>
                      <option value="skip">continue without it</option>
                      <option value="refuse">block the request</option>
                    </select>
                  </Field>
                  <Field label="If it says no" hint={blocking ? "it refused the request" : "only hooks that run before the model can say no"}>
                    <select className={input} value={onFail} disabled={!blocking} onChange={(e) => setOnFail(e.target.value as "refuse" | "flag")}>
                      <option value="refuse">block the request</option>
                      <option value="flag">let it through, flagged</option>
                    </select>
                  </Field>
                  <Field label="Timeout" hint="per call, in ms">
                    <input type="number" min={1} className={input} value={timeoutMs} onChange={(e) => setTimeoutMs(Math.max(1, Number(e.target.value) || 1))} />
                  </Field>
                </div>
                <label className="flex items-start gap-2 text-[12px]">
                  <input type="checkbox" className="mt-0.5" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
                  <span><b className="font-medium">Locked</b> <span className="text-dim">— no router can turn it off. For safety and privacy checks.</span></span>
                </label>
                {locked && onError === "skip" && <div className="text-[12px]"><LockedOpen /></div>}
              </section>

              <section className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">Name</div>
                <Field label="Name" bad={!!name && nameProblem !== null} hint={nameProblem ?? "how hearth.yaml, routers and the logs refer to it"}>
                  <input className={cx(input, mono, nameProblem && name && "border-bad")} value={name} onChange={(e) => setName(asName(e.target.value))} />
                </Field>
              </section>
            </>
          )}

          {err && <div className="text-[12px] text-bad">{err}</div>}
          <p className="text-[11px] text-dim">Nothing is written until you review it. hearth reads plugins at startup, so a new one starts after a restart.</p>
        </form>
      )}

      {how !== "api" && how !== "mcp" && (
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button onClick={onClose}>cancel</Button>
          {how === "http" && <Button tone="primary" disabled={!found || nameProblem !== null || hooks.size === 0 || !file} onClick={() => void review()}>review</Button>}
        </div>
      )}
    </Dialog>
  );
}
