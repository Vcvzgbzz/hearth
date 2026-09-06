/**
 * One mark per kind of thing on the stage.
 *
 * Every node used to be the same rounded rectangle, so a GPU, a model server
 * and a peer machine were distinguishable only by reading them. On a stage with
 * a dozen boxes that is a lot of reading to answer "what am I looking at".
 *
 * Hugeicons (MIT), bundled rather than fetched. The page is one self-contained
 * response served on loopback behind an SSH tunnel and is routinely opened with
 * no route to the internet at all — the same reason the theme names system font
 * stacks instead of letting MUI pull Roboto from Google. A CDN icon set would be
 * six invisible squares on the machine this page exists to look after.
 *
 * Both packages are devDependencies, so nothing is added to what
 * `npm install @vcvzgbzz/hearth` pulls down; only the handful of icons named
 * below reach the bundle.
 *
 * The mark carries BOTH what a thing is (its glyph) and how it is doing (its
 * colour, inherited from the node's status tone), which is why these are drawn
 * as strokes in currentColor rather than as anything pre-coloured.
 */
import {
  ArrowDataTransferHorizontalIcon,
  GpuIcon,
  PinLocation01Icon,
  Route01Icon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export type IconKind = "self" | "peer" | "swap" | "single" | "path" | "card";

const GLYPH = {
  /** This node — the machine the page is served from. */
  self: ServerStack01Icon,
  /**
   * A peer: the SAME mark as self, deliberately.
   *
   * A peer is a machine running this same software, which is exactly what the
   * self node is — drawing it as a chain link made the relationship the subject
   * and the thing itself an afterthought, and put two unlike shapes on the one
   * row where the shapes should match. What actually differs is whose it is and
   * whether it answers, and the row already says both: `self` is tagged as such,
   * and the mark takes its colour from the node's state — a healthy peer in
   * the cool peer hue, a down peer in fault red — so the shape matches while
   * the colour keeps the machines apart.
   *
   * Kept as its own kind rather than aliased at the call site, so making them
   * differ again is one line here.
   */
  peer: ServerStack01Icon,
  /** A backend that swaps: one model in, the last one out. */
  swap: ArrowDataTransferHorizontalIcon,
  /** One model, pinned there, never swapped out. */
  single: PinLocation01Icon,
  /** Not an OpenAI server: a declared path we forward, and never look inside. */
  path: Route01Icon,
  /** Silicon — the thing every backend takes turns on. */
  card: GpuIcon,
} as const;

/**
 * No `title` here on purpose: HugeiconsIcon renders no children, so an <svg>
 * <title> passed in is silently dropped — checked in its dist rather than
 * assumed. The mark is aria-hidden and every node states its name and kind in
 * text beside it, with the type spelled out in the node's own tooltip, so
 * nothing is lost by not having one.
 */
export function TypeIcon({ kind, size }: { kind: IconKind; size: number }) {
  return (
    <HugeiconsIcon
      icon={GLYPH[kind]}
      size={size}
      color="currentColor"
      // Scaled with the glyph: a weight that reads as solid at 22px is a
      // hairline at 36, and the mark stops being the first thing the eye lands
      // on — which is the entire job it was given.
      strokeWidth={Math.max(1.5, Math.round((size / 19) * 10) / 10)}
      aria-hidden
      style={{ display: "block", flexShrink: 0 }}
    />
  );
}

/** Which mark a backend gets, from what it is rather than what it is called. */
export const backendIcon = (kind: string | undefined, hasRoutes: boolean): IconKind =>
  kind === "llama-swap" ? "swap"
    // `none` means it is not OpenAI-shaped, which is exactly what `path` says.
    // A backend with routes and no declared kind is the same story.
    : kind === "none" || (hasRoutes && kind !== "single") ? "path"
      : "single";
