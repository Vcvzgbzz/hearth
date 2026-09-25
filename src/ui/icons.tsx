/**
 * One mark per kind of node, drawn in currentColor so the node's status tints it. Hugeicons
 * (MIT), bundled because the page is often opened with no internet route.
 */
import {
  ArrowDataTransferHorizontalIcon,
  ChipIcon,
  CpuIcon,
  GpuIcon,
  PinLocation01Icon,
  RamMemoryIcon,
  Route01Icon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export type IconKind = "self" | "peer" | "swap" | "single" | "path" | "card" | "cpu" | "chip" | "ram";

const GLYPH = {
  /** Host memory: where a model's weights go when they do not fit on a card.
   *  A memory module rather than a chip, because the point is WHERE the weights
   *  are sitting, not what is computing them. */
  ram: RamMemoryIcon,
  /** This node — the machine the page is served from. */
  self: ServerStack01Icon,
  /** A peer runs this same software, so it shares self's mark; colour tells them apart. */
  peer: ServerStack01Icon,
  /** A backend that swaps: one model in, the last one out. */
  swap: ArrowDataTransferHorizontalIcon,
  /** One model, pinned there, never swapped out. */
  single: PinLocation01Icon,
  /** Not an OpenAI server: a declared path we forward, and never look inside. */
  path: Route01Icon,
  /** A card — the thing backends take turns on. */
  card: GpuIcon,
  /** A CPU, which they do not take turns on: several run there at once. */
  cpu: CpuIcon,
  /** Hardware that is neither, for a use nobody anticipated. */
  chip: ChipIcon,
} as const;

/** No `title`: HugeiconsIcon drops children. The mark is aria-hidden and the node names itself in text. */
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

/** Which mark a piece of hardware gets, from what it was declared to be. */
export const resourceIcon = (kind: string | undefined): IconKind =>
  kind === "cpu" ? "cpu" : kind === "other" ? "chip" : "card";

/** Which mark a backend gets, from what it is rather than what it is called. */
export const backendIcon = (kind: string | undefined, hasRoutes: boolean): IconKind =>
  kind === "llama-swap" ? "swap"
    // `none` means it is not OpenAI-shaped, which is exactly what `path` says.
    // A backend with routes and no declared kind is the same story.
    : kind === "none" || (hasRoutes && kind !== "single") ? "path"
      : "single";
