/** Small primitives, styled once: cards, pills, switches, stats. */
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type Tone = "ok" | "warn" | "bad" | "info" | "accent" | "dim";

const DOT: Record<Tone, string> = {
  ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info", accent: "bg-accent", dim: "bg-dim/50",
};
const TEXT: Record<Tone, string> = {
  ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info", accent: "text-accent", dim: "text-dim",
};

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-line bg-panel", className)}>{children}</div>;
}

const DIALOG = { sm: "max-w-sm", md: "max-w-lg", lg: "max-h-[85vh] max-w-3xl", full: "h-[calc(100vh-3rem)] max-w-6xl" };

/**
 * The console's one dialog: a titled panel over the page, closed by Escape, its × or a click outside it,
 * and holding Tab inside it while it is open. `firm` is for what cannot be had again once closed: only
 * the caller's own button closes it.
 * `head` sits beside the title; the body and any row of buttons are the caller's. It is drawn on the page
 * itself, over whatever part of it opened it, and under the menus, so a choice offered from inside one opens over it.
 */
export function Dialog({ title, label, head, size = "md", firm = false, onClose, children }: {
  title: ReactNode; /** Its name to a screen reader, where the title is not plain text. */ label?: string; head?: ReactNode; size?: keyof typeof DIALOG; firm?: boolean; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // A field inside that asked for the keys keeps them.
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    // A menu open over the dialog takes its own Escape.
    const key = (e: KeyboardEvent) => {
      const el = panel.current;
      if (!el || !(e.target === document.body || el.contains(e.target as Node))) return;
      if (e.key === "Escape" && !firm) close.current();
      if (e.key !== "Tab") return;
      // Tab goes round the dialog, not on into the page under it.
      const stops = [...el.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.hasAttribute("disabled") && x.offsetParent !== null);
      const first = stops[0], last = stops[stops.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || !el.contains(at))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); before?.focus(); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-6 max-sm:p-2" onMouseDown={(e) => { if (e.target === e.currentTarget && !firm) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)} tabIndex={-1}
           className={cx("flex max-h-full w-full flex-col rounded-xl border border-line bg-panel text-fg shadow-2xl outline-none", DIALOG[size])}>
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 font-semibold">{title}</div>
          {head}
          {!firm && <button type="button" className="ml-auto shrink-0 text-dim hover:text-fg" aria-label="close" onClick={onClose}><X size={16} /></button>}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && <span className={cx("absolute inset-0 animate-ping rounded-full opacity-60", DOT[tone])} />}
      <span className={cx("relative inline-flex size-2 rounded-full", DOT[tone])} />
    </span>
  );
}

/** A status pill: always a dot and a word, never colour alone. */
export function Pill({ tone, children, pulse }: { tone: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium", TEXT[tone])}>
      <Dot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40",
        on ? "bg-accent" : "bg-line",
      )}
    >
      <span className={cx("inline-block size-4 rounded-full bg-white shadow transition-transform", on ? "translate-x-4.5" : "translate-x-0.5")} />
    </button>
  );
}

export function Button({ children, onClick, tone = "plain", disabled, type = "button" }: {
  children: ReactNode; onClick?: () => void; tone?: "plain" | "primary"; disabled?: boolean; type?: "button" | "submit";
}) {
  return (
    <button
      type={type} onClick={onClick} disabled={disabled}
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
        // A disabled primary is idle, not broken: neutral rather than a faded accent.
        tone === "primary" ? "bg-accent text-white hover:brightness-110 disabled:bg-muted disabled:text-dim disabled:hover:brightness-100"
          : "border border-line bg-panel hover:bg-muted disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-dim">{children}</div>;
}

export const mono = "font-mono text-[12px]";

export const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h`;
};
