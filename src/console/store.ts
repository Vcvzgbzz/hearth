/**
 * Live state: /ui/events pushes a snapshot then top-level patches; /ui/data is polled if the
 * stream never delivers. Components select narrow slices, so one tick re-renders only what moved.
 */
import { create } from "zustand";

import type { UiData } from "./types.js";

const KEY_STORE = "hearth.apikey";
const storedKey = (): string | null => {
  try { return localStorage.getItem(KEY_STORE); } catch { return null; }
};
const rememberKey = (key: string): void => {
  try { localStorage.setItem(KEY_STORE, key.trim()); } catch { /* private mode */ }
};
/** Forget a key only on a 401; a 403 is the cross-origin guard, not a bad key. */
const forgetKey = (): void => {
  try { localStorage.removeItem(KEY_STORE); } catch { /* private mode */ }
};

export type Page = "topology" | "models" | "queue" | "config";
export type Sel = { kind: "self" | "peer" | "backend" | "resource"; id: string } | null;
type Toast = { tone: "ok" | "bad"; text: string; id: number } | null;

interface State {
  data: UiData | null;
  live: boolean;
  dead: boolean;
  /** The data stream refused this address and this browser holds no session: the login card shows. */
  loginRequired: boolean;
  /** No operator exists yet: the login card creates the first one instead. */
  setupRequired: boolean;
  page: Page;
  sel: Sel;
  toast: Toast;
  /** A pending key request from a write, resolved by the key dialog. */
  askKey: ((key: string | null) => void) | null;
}

export const useStore = create<State>(() => ({
  data: null,
  live: false,
  dead: false,
  loginRequired: false,
  setupRequired: false,
  page: (location.hash.slice(1) as Page) || "topology",
  sel: null,
  toast: null,
  askKey: null,
}));

export const go = (page: Page) => {
  location.hash = page;
  useStore.setState({ page, sel: null });
};
export const select = (sel: Sel) => useStore.setState({ sel });

let toastSeq = 0;
export function toast(tone: "ok" | "bad", text: string): void {
  const id = ++toastSeq;
  useStore.setState({ toast: { tone, text, id } });
  setTimeout(() => {
    if (useStore.getState().toast?.id === id) useStore.setState({ toast: null });
  }, tone === "ok" ? 2200 : 6000);
}

/** Open the stream, falling back to polling if no snapshot arrives; reconnects are the browser's. */
let es: EventSource | null = null;
let poll: number | null = null;

function disconnect(): void {
  es?.close();
  es = null;
  if (poll !== null) {
    clearInterval(poll);
    poll = null;
  }
}

export function connect(): void {
  disconnect();
  let gotSnapshot = false;
  const load = async () => {
    try {
      const r = await fetch("/ui/data", { cache: "no-store" });
      // 401/403 is not "dead": the node is up, it simply does not know this browser yet.
      if (r.status === 401 || r.status === 403) {
        const s = (await (await fetch("/setup")).json().catch(() => ({}))) as { needed?: boolean };
        useStore.setState({ loginRequired: true, setupRequired: s.needed === true, dead: false });
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      useStore.setState({ data: (await r.json()) as UiData, dead: false, loginRequired: false });
    } catch {
      useStore.setState({ dead: true });
    }
  };
  // An immediate probe, so a login is offered at once rather than after the 4s fallback.
  void load();
  es = new EventSource("/ui/events");
  es.addEventListener("snapshot", (e) => {
    gotSnapshot = true;
    if (poll !== null) clearInterval(poll);
    poll = null;
    useStore.setState({ data: JSON.parse((e as MessageEvent).data) as UiData, live: true, dead: false });
  });
  es.addEventListener("patch", (e) => {
    const cur = useStore.getState().data;
    if (!cur) return;
    const p = JSON.parse((e as MessageEvent).data) as { set?: Partial<UiData>; add?: { hist: UiData["hist"] } };
    const next = { ...cur, ...p.set } as UiData;
    if (p.add) {
      const keep = (cur as { histKeep?: number }).histKeep ?? 120;
      next.hist = [...cur.hist, ...p.add.hist].slice(-keep);
    }
    useStore.setState({ data: next, live: true });
  });
  es.onerror = () => useStore.setState({ live: false });
  setTimeout(() => {
    if (gotSnapshot || poll !== null) return;
    void load();
    poll = window.setInterval(() => { if (!document.hidden) void load(); }, 3000);
  }, 4000);
}

/** Sign in: the cookie the server sets is then sent with every request by the browser itself. */
export async function login(user: string, pass: string, setup = false): Promise<string | null> {
  let r: Response;
  try {
    r = await fetch(setup ? "/setup" : "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, pass }),
    });
  } catch {
    return "cannot reach this node";
  }
  const d = (await r.json().catch(() => ({}))) as { error?: string };
  // Someone else finished setup first: the card turns back into a login.
  if (r.status === 409 && setup) useStore.setState({ setupRequired: false });
  if (!r.ok) return d.error ?? `login failed (${r.status})`;
  useStore.setState({ loginRequired: false, setupRequired: false, dead: false });
  connect();
  return null;
}

/** Drop this browser's session and come back clean. */
export async function logout(): Promise<void> {
  try {
    await fetch("/logout", { method: "POST" });
  } catch { /* the reload is the point anyway */ }
  location.reload();
}

function askForKey(): Promise<string | null> {
  return new Promise((resolve) => useStore.setState({ askKey: resolve }));
}

/**
 * A request the node may want a key for. Sends first — a live operator session rides the
 * cookie and needs no key at all — and only asks for a key when the node answers 401 and
 * none is stored yet. Errors come back as `{message, path}` so a form can place them.
 */
export async function request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const doFetch = (k: string): Promise<Response> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (k) headers.Authorization = `Bearer ${k}`;
    return fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  };
  let key = storedKey() ?? "";
  let r = await doFetch(key);
  if (r.status === 401 && key === "") {
    const mode = useStore.getState().data?.control;
    if (mode === "key") {
      const entered = await askForKey();
      useStore.setState({ askKey: null });
      if (!entered) throw new RequestError("a key is needed to change anything here", null);
      key = entered.trim();
      rememberKey(key);
      r = await doFetch(key);
    }
  }
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 401) {
    forgetKey();
    throw new RequestError("key rejected — try again to re-enter it", null);
  }
  if (!r.ok) {
    const err = (d.error ?? {}) as { message?: string; path?: string | null };
    throw new RequestError(err.message ?? (typeof d.error === "string" ? d.error : `failed (${r.status})`), err.path ?? null);
  }
  return d as T;
}

/** Ask the node to restart, then reload once it answers again; a restart ends every session. */
export async function restartNode(): Promise<void> {
  try {
    await request("POST", "/restart");
  } catch (e) {
    toast("bad", (e as Error).message);
    return;
  }
  toast("ok", "restarting…");
  disconnect();
  const deadline = Date.now() + 120_000;
  // Wait for it to go down first, so the old process answering is not taken for the new one.
  let wentDown = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const up = await fetch("/healthz", { cache: "no-store" }).then(() => true, () => false);
    if (!up) wentDown = true;
    else if (wentDown) return location.reload();
  }
  toast("bad", "hearth did not come back — check its supervisor");
}

export class RequestError extends Error {
  constructor(message: string, readonly path: string | null) {
    super(message);
  }
}

/** A /control change that saves itself: toast on success, toast with the reason on failure. */
export async function control(body: Record<string, unknown>, done: string): Promise<boolean> {
  try {
    await request("POST", "/control", body);
    toast("ok", done);
    return true;
  } catch (e) {
    toast("bad", e instanceof Error ? e.message : String(e));
    return false;
  }
}
