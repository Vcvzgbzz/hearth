/**
 * Example adapter: carries a SearXNG JSON search over to degoog's /api/search and
 * brings the answer back as SearXNG's JSON.
 *
 * Wire it in hearth.yaml as a trust: code plugin:
 *
 *   plugins:
 *     search:
 *       serves: http://searxng:8080       # the SearXNG instance callers reach
 *       trust: http
 *       fallback: { plugin: degoog, adapt: searxng-to-degoog }
 *     degoog:
 *       serves: http://degoog:4444        # the fallback, speaks degoog's API
 *       trust: http
 *     searxng-to-degoog:
 *       use: file:./examples/adapters/searxng-to-degoog.mjs
 *       trust: code
 *
 * This module is an example of what an adapter plugin looks like. It hooks nothing;
 * it only provides the `adapt` object that hearth calls to translate between the
 * two APIs when the primary plugin cannot answer.
 */
export default {
  apiVersion: 1,
  kinds: {},
  setup() {
    // SearXNG's `categories` that degoog has a search type for; any other searches the web.
    const DEGOOG_TYPES = { general: "web", images: "images", news: "news", videos: "videos" };
    return {
      adapt: {
        request(method, path, query) {
          if (method !== "GET" || (path !== "/search" && path !== "/") || query.get("format") !== "json") return null;
          const q = query.get("q");
          if (q === null || q.trim() === "") return null;
          const out = new URLSearchParams({ q });
          const page = query.get("pageno");
          if (page !== null && /^\d+$/.test(page) && page !== "1") out.set("page", page);
          const type = DEGOOG_TYPES[(query.get("categories") ?? "general").split(",")[0].trim()] ?? "web";
          if (type !== "web") out.set("type", type);
          return { path: "/api/search", query: out };
        },
        response(body) {
          const d = JSON.parse(body.toString("utf8"));
          if (d === null || typeof d !== "object" || !Array.isArray(d.results)) {
            throw new Error("degoog answered without a results list");
          }
          const results = d.results
            .filter((r) => typeof r?.url === "string" && r.url !== "")
            .map((r) => ({
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
            unresponsive_engines: (d.engineTimings ?? []).filter((e) => e?.status && e.status !== "ok").map((e) => [e.name ?? "", e.status]),
          }));
        },
      },
    };
  },
};