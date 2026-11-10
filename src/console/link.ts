/**
 * The console's addresses: `#<page>` or `#<page>/<rest>`, each part of the rest URI-encoded, so a
 * link names the page and what is selected on it, and a name holding `/` or spaces survives the trip.
 */
import { pageFor } from "./knobs.js";

export const PAGE_IDS = ["topology", "routing", "playground", "plugins", "models", "lending", "keys", "usage", "scheduler", "logs", "requests", "config"] as const;
export type Page = (typeof PAGE_IDS)[number];

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

/** The page an address names, an old `#queue` link included, and the parts after it; an unknown page is the first one, with nothing after it. */
export function parseLink(hash: string): { page: Page; rest: string[] } {
  const [head = "", ...rest] = hash.replace(/^#/, "").split("/");
  const page = PAGE_IDS.find((p) => p === pageFor(decode(head)));
  return page ? { page, rest: rest.filter((s) => s !== "").map(decode) } : { page: "topology", rest: [] };
}

/** The address of a page and what is selected on it; `:` is left readable, as `backend:<name>`. */
export const linkOf = (page: Page, ...rest: string[]): string =>
  "#" + [page, ...rest].map((s) => encodeURIComponent(s).replace(/%3A/gi, ":")).join("/");
