/**
 * Example adapter: carries a SearXNG JSON search over to degoog's /api/search and
 * brings the answer back as SearXNG's JSON.
 *
 * It is the `code:` of an adapter, and a flow line names it with `adapt:`. Two lines
 * are all a fallback between two APIs needs:
 *
 *   adapters:
 *     searxng-to-degoog:
 *       timeoutMs: 2000
 *       code: |
 *         <this file>
 *
 *   plugins:
 *     search: { serves: http://searxng:8080, trust: http }   # the SearXNG callers reach
 *     degoog: { serves: http://degoog:4444, trust: http }    # speaks degoog's API
 *
 *   flows:
 *     search:
 *       inputs: ["*"]
 *       steps:
 *         - to: { plugin: search }
 *         - to: { plugin: degoog, adapt: searxng-to-degoog }
 *
 * The first line that can answer wins: when SearXNG cannot, the second line sends the
 * same request to degoog through the adapter, which reshapes it on the way in and the
 * answer on the way out. Hearth runs `request` and `response` in its own interpreter:
 * they only see one request, or one answer, and return another. There is no regex and
 * no `replace` in that language, because neither can be stopped once it starts.
 */

// SearXNG's `categories` that degoog has a search type for; any other searches the web.
const DEGOOG_TYPES = { general: "web", images: "images", news: "news", videos: "videos" };

/**
 * The request as degoog should get it, or null when this line has no counterpart for
 * it (an API call that is not a JSON search), which sends the request on to the next
 * line. Fields left out keep the value the caller sent.
 */
export function request(req) {
  if (req.method !== "GET" || (req.path !== "/search" && req.path !== "/") || req.query.format !== "json") return null;
  const q = (req.query.q ?? "").trim();
  if (q === "") return null;
  const query = { q };
  const page = req.query.pageno;
  if (page !== undefined && page !== "1") {
    // No regex: step through the page number and keep it only if every character is a digit.
    let digits = true;
    for (const ch of page) {
      if (ch < "0" || ch > "9") {
        digits = false;
        break;
      }
    }
    if (digits) query.page = page;
  }
  const type = DEGOOG_TYPES[(req.query.categories ?? "general").split(",")[0].trim()] ?? "web";
  if (type !== "web") query.type = type;
  return { path: "/api/search", query };
}

/**
 * degoog's answer as SearXNG's JSON. Throws on an answer it cannot read, which the
 * caller is told as a 502 naming the adapter; `req` is the request the caller sent.
 */
export function response(res, req) {
  const d = JSON.parse(res.body);
  if (d === null || typeof d !== "object" || !Array.isArray(d.results)) throw new Error("degoog answered without a results list");
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
  return {
    contentType: "application/json",
    body: JSON.stringify({
      query: req.query.q ?? d.query ?? "",
      number_of_results: results.length,
      results,
      answers: [],
      corrections: [],
      infoboxes: [],
      suggestions: Array.isArray(d.relatedSearches) ? d.relatedSearches.filter((s) => typeof s === "string") : [],
      unresponsive_engines: (d.engineTimings ?? []).filter((e) => e?.status && e.status !== "ok").map((e) => [e.name ?? "", e.status]),
    }),
  };
}
