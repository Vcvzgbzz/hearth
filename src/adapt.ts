/**
 * What a plugin's `fallback` can name as `adapt`, for a fallback that speaks a different API than the plugin it stands
 * in for. An adapter carries a request over to the fallback's API and brings the answer back in the shape the caller
 * asked for; a request it has no counterpart for is not carried over, and the caller gets the plugin's own failure.
 */
export interface Adapter {
  /** What the adapter is for, in a few words, for the console and the docs. */
  desc: string;
  /** The request on the fallback's API, as a path and query, or null when it has no counterpart there. */
  request(method: string, path: string, query: URLSearchParams): { path: string; query: URLSearchParams } | null;
  /** The fallback's answer to that request, rewritten into the shape the caller asked for. Throws on one it cannot read. */
  response(body: Buffer): Buffer;
}

/** SearXNG's `categories` that degoog has a search type for; any other searches the web. */
const DEGOOG_TYPES: Record<string, string> = { general: "web", images: "images", news: "news", videos: "videos" };

type DegoogResult = { title?: string; url?: string; snippet?: string; content?: string; source?: string; sources?: string[]; score?: number; publishedDate?: string; thumbnail?: string };
type DegoogAnswer = { query?: string; results?: DegoogResult[]; relatedSearches?: string[]; engineTimings?: { name?: string; status?: string }[] };

export const ADAPTERS: Record<string, Adapter> = {
  "searxng-to-degoog": {
    desc: "a SearXNG JSON search (/search?q=…&format=json), answered by degoog's /api/search",
    request(method, path, query) {
      if (method !== "GET" || (path !== "/search" && path !== "/") || query.get("format") !== "json") return null;
      const q = query.get("q");
      if (q === null || q.trim() === "") return null;
      const out = new URLSearchParams({ q });
      const page = query.get("pageno");
      if (page !== null && /^\d+$/.test(page) && page !== "1") out.set("page", page);
      const type = DEGOOG_TYPES[(query.get("categories") ?? "general").split(",")[0]!.trim()] ?? "web";
      if (type !== "web") out.set("type", type);
      return { path: "/api/search", query: out };
    },
    response(body) {
      const d = JSON.parse(body.toString("utf8")) as DegoogAnswer;
      if (d === null || typeof d !== "object" || !Array.isArray(d.results)) throw new Error("degoog answered without a results list");
      const results = d.results.filter((r) => typeof r?.url === "string" && r.url !== "").map((r) => ({
        url: r.url,
        title: r.title ?? "",
        content: r.snippet ?? r.content ?? "",
        engine: (r.source ?? "degoog").toLowerCase(),
        engines: (r.sources ?? [r.source ?? "degoog"]).map((s) => String(s).toLowerCase()),
        ...(typeof r.score === "number" ? { score: r.score } : {}),
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
        ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}),
        category: "general",
      }));
      return Buffer.from(JSON.stringify({
        query: d.query ?? "",
        number_of_results: results.length,
        results,
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: Array.isArray(d.relatedSearches) ? d.relatedSearches.filter((s) => typeof s === "string") : [],
        unresponsive_engines: (d.engineTimings ?? []).filter((e) => e?.status && e.status !== "ok").map((e) => [e.name ?? "", e.status!]),
      }));
    },
  },
};
