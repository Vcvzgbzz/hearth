/** Small primitives, styled once: cards, pills, switches, stats. */
import type { ReactNode } from "react";

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
