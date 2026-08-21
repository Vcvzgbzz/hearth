/**
 * The status page, as a string.
 *
 * A string and not a file on disk, because `files` in package.json ships `dist`
 * and nothing else — serving an .html would mean a copy step in the build, and
 * the whole point of this page is that it costs no build step, no framework and
 * no dependency. It is plain HTML with inline CSS and about 200 lines of DOM
 * code, and it fetches one endpoint.
 *
 * Backticks and ${'${'} are escaped in here: the page's own JavaScript uses template
 * literals, and without escaping they would be interpolated when THIS file is
 * compiled rather than when the browser runs it.
 */
export const UI_HTML = `<title>Hearth Console</title>
<!-- Without this a phone lays the page out at a 980px virtual viewport and
     zooms out, so the max-width:760px rule below never fires — the responsive
     breakpoint was dead code. Caught by measuring the layout viewport on a
     375px device, not by reading the CSS. -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* Palette borrowed verbatim from VechysRoom (src/theme.ts), including its
     rule that colour is instrument semantics rather than decoration:

       phosphor green  resident · live · ready
       signal amber    working · hot
       fault red       broken

     That rule changed what this page paints. Amber used to mean "loaded",
     which in this language means WORKING — so a warm model is now phosphor and
     amber is left for a node under load, where it says something.

     Taken: the five swatches and the two type faces. NOT taken: the 10-16px
     radii or the wide-tracked uppercase overline. Those belong to a panelled
     control surface; this page is a dense table and was deliberately built the
     other way. Same colours, different furniture. */
  :root {
    --bg:#201f2c; --raise:#4B4A67; --line:#5b597a; --hair:#302f42;
    --ink:#DDD1C7; --dim:#a7abae; --faint:#6f7573;
    --live:#8DB580; --live-soft:rgba(141,181,128,.16);
    --work:#f59e0b; --fault:#f87171;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    --mono:ui-monospace,"SF Mono",SFMono-Regular,"Cascadia Mono","Roboto Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg:#DDD1C7; --raise:#f2ece5; --line:#cfc6ba; --hair:#eae2d8;
      --ink:#4B4A67; --dim:#7E8987; --faint:#a8a6b0;
      --live:#8DB580; --live-soft:rgba(141,181,128,.20);
      --work:#b45309; --fault:#dc2626;
    }
  }
  :root[data-theme="light"] {
    --bg:#DDD1C7; --raise:#f2ece5; --line:#cfc6ba; --hair:#eae2d8;
    --ink:#4B4A67; --dim:#7E8987; --faint:#a8a6b0;
    --live:#8DB580; --live-soft:rgba(141,181,128,.20);
    --work:#b45309; --fault:#dc2626;
  }

  * { box-sizing:border-box; }
  body {
    background:var(--bg); color:var(--ink);
    font-family:var(--sans); font-size:14px; line-height:1.5;
    margin:0; padding:28px 24px 64px; -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:940px; margin:0 auto; }
  /* Mono is for DATA — model ids, counts, times. Not for prose. */
  .m { font-family:var(--mono); font-size:12.5px; }

  /* ---- masthead: identity and the vitals, on one line ---- */
  .masthead { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap;
              padding-bottom:10px; border-bottom:1px solid var(--line); }
  .wordmark { font-size:15px; font-weight:650; letter-spacing:-.01em; }
  .wordmark .spark { color:var(--live); }
  .masthead .who { color:var(--dim); }
  .masthead .who b { color:var(--ink); font-weight:600; font-family:var(--mono); font-size:13px; }
  .vitals { margin-left:auto; display:flex; gap:18px; align-items:baseline;
            font-family:var(--mono); font-size:12.5px; color:var(--dim); }
  .vitals b { color:var(--ink); font-weight:600; }
  .vitals .live { color:var(--faint); }
  .vitals .live::before { content:"●"; color:var(--live); margin-right:5px; font-size:9px;
                          position:relative; top:-1px; }

  /* ---- sections: a rule and a quiet label, not a floating caps chip ---- */
  section { margin-top:30px; }
  h2 { font-size:13px; font-weight:600; color:var(--ink); margin:0 0 12px;
       display:flex; align-items:baseline; gap:12px; }
  h2 .note { font-weight:400; color:var(--faint); font-size:12px; }

  /* ---- tables carry most of the information ---- */
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-weight:500; font-size:11.5px; color:var(--dim);
       padding:0 12px 6px 0; border-bottom:1px solid var(--line); }
  td { padding:7px 12px 7px 0; border-bottom:1px solid var(--hair); vertical-align:baseline; }
  tr:last-child td { border-bottom:none; }
  th.num, td.num { text-align:right; padding-right:0; font-variant-numeric:tabular-nums; }
  td.model { font-family:var(--mono); font-size:12.5px; }
  td.sub, .sub { color:var(--dim); }
  .empty { color:var(--faint); padding:14px 0; }

  /* State reads as a WORD, not a pill. Pills everywhere is the look we are
     getting away from; colour and weight carry it. */
  .state { font-family:var(--mono); font-size:12px; color:var(--dim); }
  .state.warm { color:var(--live); font-weight:600; }
  .state.down { color:var(--fault); }
  .dotm { font-size:8px; position:relative; top:-2px; margin-right:5px; }

  /* Each node that serves a model. Warm ones carry the accent, so redundancy
     and readiness read together instead of needing two columns. */
  .nodes .holder { color:var(--dim); }
  .nodes .holder.hot { color:var(--live); font-weight:600; }

  /* ---- nodes ---- */
  .node-row { display:flex; align-items:baseline; gap:10px; padding:9px 0;
              border-bottom:1px solid var(--hair); flex-wrap:wrap; }
  .node-row:last-child { border-bottom:none; }
  .node-name { font-family:var(--mono); font-size:13px; font-weight:600; }
  .self-tag { font-size:10.5px; color:var(--faint); border:1px solid var(--line);
              padding:0 5px; border-radius:2px; }
  .node-nums { margin-left:auto; display:flex; gap:16px; font-family:var(--mono);
               font-size:12px; color:var(--dim); }
  .node-nums b { color:var(--ink); font-weight:600; }
  .backends { flex-basis:100%; display:flex; gap:14px; flex-wrap:wrap;
              font-family:var(--mono); font-size:11.5px; color:var(--faint); padding-left:2px; }

  /* ---- models a peer offers that we cannot reach ---- */
  .unmapped { flex-basis:100%; font-family:var(--mono); font-size:11.5px; padding-left:2px; }
  .unmapped > summary { color:var(--work); cursor:pointer; list-style:none; }
  .unmapped > summary::-webkit-details-marker { display:none; }
  .unmapped > summary::before { content:"+ "; }
  .unmapped[open] > summary::before { content:"- "; }
  .unmapped pre, .pendyaml pre { margin:7px 0 4px; padding:8px 10px; background:var(--bg);
                  border:1px solid var(--hair); border-radius:2px; overflow-x:auto;
                  color:var(--dim); font-size:11.5px; line-height:1.5;
                  user-select:all; white-space:pre; }
  .unmapped .why, .pendyaml .why, .maps .why { color:var(--faint); margin-top:5px; }

  /* ---- sharing and mapping ---- */
  .maps { flex-basis:100%; padding-left:2px; margin-top:4px; }
  .maps table { margin:6px 0 2px; }
  .maps td, .maps th { padding:4px 10px 4px 0; font-size:11.5px; border-bottom:1px solid var(--hair); }
  .maps .arrow { color:var(--faint); }
  .maps input { font:inherit; font-family:var(--mono); font-size:11.5px; width:15ch;
                background:var(--bg); color:var(--ink); border:1px solid var(--line);
                border-radius:2px; padding:1px 5px; }
  .maps input:focus-visible { outline:2px solid var(--live); outline-offset:1px; }
  .shared { font-family:var(--mono); font-size:11.5px; color:var(--faint); }
  /* The value and its override mark are one fact; a narrow column was wrapping
     the mark onto its own line, where it reads as an unexplained asterisk. */
  td:has(> .drift) { white-space:nowrap; }
  .shared.on { color:var(--live); }
  /* An override is a fact about the config, not a state of the system, so it is
     a mark next to the value rather than another colour competing with the
     palette's three. */
  .drift { color:var(--work); cursor:help; margin-left:4px; }

  /* ---- runtime changes not yet in the file ---- */
  .pending { margin-top:14px; font-family:var(--mono); font-size:11.5px; }
  /* The state and the button that acts on it, always visible. Only the config
     to paste is behind the disclosure below it. */
  .pendhead { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .pendtext { color:var(--work); }
  /* Beside the control that failed, wrapping like text. It is a sentence, so it
     is set as one rather than stretched across a button. */
  .wfail { color:var(--fault); font-size:11.5px; font-family:var(--mono); }
  .pendyaml { margin-top:8px; }
  .pendyaml > summary { color:var(--dim); cursor:pointer; list-style:none; }
  .pendyaml > summary::-webkit-details-marker { display:none; }
  .pendyaml > summary::before { content:"+ "; }
  .pendyaml[open] > summary::before { content:"- "; }

  /* ---- the load action ---- */
  button.load { font:inherit; font-family:var(--mono); font-size:11.5px; background:none;
                border:1px solid var(--line); color:var(--dim); border-radius:2px;
                padding:1px 7px; cursor:pointer; }
  button.load:hover:not(:disabled) { color:var(--live); border-color:var(--live); }
  button.load:focus-visible { outline:2px solid var(--live); outline-offset:1px; }
  button.load:disabled { cursor:default; color:var(--faint); }
  button.load.failed { color:var(--fault); border-color:var(--fault); }

  /* ---- federation switches ---- */
  .fedbar { margin-left:auto; display:inline-flex; gap:14px; align-items:baseline; }
  button.fed { font:inherit; font-family:var(--mono); font-size:12px; background:none;
               border:none; padding:0; cursor:pointer; color:var(--dim);
               border-bottom:1px dashed var(--line); }
  button.fed:hover { color:var(--ink); border-bottom-color:var(--dim); }
  button.fed:focus-visible { outline:2px solid var(--live); outline-offset:2px; }
  button.fed.off { color:var(--fault); border-bottom-color:var(--fault); font-weight:600; }
  button.fed:disabled { cursor:default; opacity:.55; }
  span.fed { font-family:var(--mono); font-size:12px; color:var(--dim); cursor:default; }
  span.fed.off { color:var(--fault); font-weight:600; }
  .fed .dot { font-size:8px; position:relative; top:-2px; margin:0 4px; color:var(--live); }
  .fed.off .dot { color:var(--fault); }

  /* ---- charts: a rule and a line, no frame ---- */
  .chartblock { margin-bottom:22px; }
  .chartlab { display:flex; align-items:baseline; gap:10px; margin-bottom:6px; }
  .chartlab .t { font-size:12.5px; color:var(--ink); }
  .chartlab .r { margin-left:auto; font-size:11.5px; color:var(--faint);
                 font-family:var(--mono); }
  svg.chart { display:block; width:100%; height:auto; overflow:visible; }
  .peaklabel, .lanelabel { font-size:10.5px; fill:var(--dim); font-family:var(--mono); }
  .axlabel { font-size:10px; fill:var(--faint); font-family:var(--mono); }
  .lanelabel.on { fill:var(--live); }
  .lanelabel.off { fill:var(--faint); }
  .crosshair { stroke:var(--dim); stroke-width:1; stroke-dasharray:2 3; pointer-events:none; }

  details.tableview summary { font-size:12px; color:var(--faint); cursor:pointer;
                              list-style:none; }
  details.tableview summary::-webkit-details-marker { display:none; }
  details.tableview summary::before { content:"+ "; }
  details[open].tableview summary::before { content:"− "; }
  details.tableview table { margin-top:10px; }

  .tip {
    position:fixed; z-index:20; pointer-events:none; opacity:0; transition:opacity .1s;
    background:var(--raise); border:1px solid var(--line); border-radius:3px;
    padding:6px 9px; font-size:12px; color:var(--ink); white-space:nowrap;
    font-family:var(--mono); box-shadow:0 6px 20px rgba(0,0,0,.35);
  }

  footer { margin-top:44px; padding-top:14px; border-top:1px solid var(--line);
           color:var(--faint); font-size:12px; }
  footer code { font-family:var(--mono); font-size:11.5px; }

  .tablewrap { overflow-x:auto; }
  @media (max-width:640px) {
    body { padding:20px 16px 48px; }
    .vitals { margin-left:0; flex-basis:100%; gap:14px; }
    .node-nums { margin-left:0; flex-basis:100%; }
  }
</style>

<div class="wrap">

  <div class="masthead">
    <span class="wordmark">hea<span class="spark">r</span>th</span>
    <span class="who">node <b id="selfname">—</b></span>
    <span class="vitals" id="vitals"></span>
  </div>

  <section>
    <h2>Models <span class="note" id="modelnote"></span></h2>
    <div class="tablewrap">
      <table>
        <thead><tr>
          <th>Model</th><th>Node</th><th>State</th><th>Shared</th><th class="num"></th>
        </tr></thead>
        <tbody id="models"></tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Nodes <span class="fedbar" id="fedbar"></span></h2>
    <div id="nodes"></div>
    <div id="pending"></div>
  </section>

  <section>
    <h2>Queue <span class="note" id="queuenote"></span></h2>
    <div class="tablewrap">
      <table>
        <thead><tr>
          <th>Lane</th><th>Model</th><th>Backend</th><th>Caller</th><th>State</th>
          <th class="num">Pos</th><th class="num">Waited</th>
        </tr></thead>
        <tbody id="jobs"></tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Last 10 minutes</h2>
    <div class="chartblock">
      <div class="chartlab">
        <span class="t">Jobs waiting for the local backend</span>
        <span class="r" id="histrange"></span>
      </div>
      <svg class="chart" id="depth" viewBox="0 0 900 96" preserveAspectRatio="none"
           role="img" aria-labelledby="depthdesc"></svg>
      <p id="depthdesc" hidden></p>
    </div>

    <div class="chartblock">
      <div class="chartlab">
        <span class="t">Which model was loaded</span>
        <span class="r" id="thrashnote"></span>
      </div>
      <svg class="chart" id="lanes" viewBox="0 0 900 120" role="img" aria-labelledby="lanesdesc"></svg>
      <p id="lanesdesc" hidden></p>
    </div>

    <details class="tableview">
      <summary>Show the numbers</summary>
      <div class="tablewrap"><table id="histtable"></table></div>
    </details>
  </section>

  <footer>
    Reads <code>/network</code> and <code>/queue</code>. Forward the port over SSH
    rather than widening the bind.
  </footer>
</div>

<div class="tip" id="tip" role="status"></div>

<script>
// ---------------------------------------------------------------------------
// DRAFT: mock data in the shapes /network and /queue already return, plus a
// /history shape that does not exist yet (see the notes alongside this file).
// One endpoint, one round trip. /network and /queue keep their own auth gate;
// this is loopback-only and needs no key, so the page carries no credential.
async function load() {
  const r = await fetch("/ui/data", { cache: "no-store" });
  if (!r.ok) throw new Error("/ui/data returned " + r.status);
  return r.json();
}

// --- tiny helpers ----------------------------------------------------------
const NS = "http://www.w3.org/2000/svg";
const el = (t, cls, txt) => { const n = document.createElement(t);
  if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const svg = (t, attrs = {}) => { const n = document.createElementNS(NS, t);
  for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
const since = ms => { const s = Math.max(0, Math.round(ms/1000));
  return s < 60 ? s+"s" : Math.floor(s/60)+"m "+String(s%60).padStart(2,"0")+"s"; };
const clock = t => new Date(t).toTimeString().slice(0,5);

/**
 * Escape a value on its way into the one place this page uses innerHTML.
 *
 * The tooltip takes markup — it wants \`<b>\` and a coloured span — so it cannot
 * simply become textContent without losing the thing it is for. Everything
 * interpolated into it is escaped instead.
 *
 * The values are model ids, and today they come from the LOCAL backend rather
 * than from a peer, so this is not a live hole. It is one rename away from
 * being one, and this page is a privilege boundary: it is served on loopback,
 * and a browser on loopback is what /control trusts. Script running here can
 * change what this node lends and write the config file.
 */
const esc = (v) => String(v).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const tip = document.getElementById("tip");
function showTip(evt, html) {
  tip.innerHTML = html;
  tip.style.opacity = "1";
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY - h - 8;
  if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
  if (y < 8) y = evt.clientY + pad;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => { tip.style.opacity = "0"; };

// Whether the write routes are reachable from wherever this page is being
// served. False on a read-only status listener. It gates /control and
// /v1/warm alike — same socket, same answer.
let canWarm = false;

// "open" (no credential needed) or "key" (send a bearer apiKey). Told to us by
// the server per socket, never guessed: the page cannot see whether apiKeys is
// configured, and guessing wrong means either a pointless prompt or a 401 the
// user cannot interpret.
let writeMode = "open";

const KEY_STORE = "hearth.apikey";

/**
 * Bearer key for writes, asked for once and kept in localStorage.
 *
 * Returns null if the user dismisses the prompt, and the caller must then
 * abandon the write rather than send an unauthenticated one — a request we
 * already know will 401 is not worth making.
 */
function apiKey() {
  if (writeMode !== "key") return "";
  let k = null;
  try { k = localStorage.getItem(KEY_STORE); } catch (e) { k = null; }
  if (k) return k;
  const entered = window.prompt(
    "This node requires an API key for controls.\\nIt is stored in this browser only.");
  if (!entered) return null;
  try { localStorage.setItem(KEY_STORE, entered.trim()); } catch (e) { /* private mode */ }
  return entered.trim();
}

/** Forget a key the server just rejected, so the next attempt re-prompts
 *  instead of failing forever against a stale value. */
function forgetKey() {
  try { localStorage.removeItem(KEY_STORE); } catch (e) { /* ignore */ }
}

/**
 * POST a write route with whatever credential this socket needs.
 *
 * Resolves to a parsed body, or rejects with a message the caller shows on the
 * control itself. A 401 clears the stored key on the way out.
 */
function postWrite(path, body) {
  const key = apiKey();
  if (key === null) return Promise.reject(new Error("no key"));
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = "Bearer " + key;
  return fetch(path, { method: "POST", headers, body: JSON.stringify(body) })
    .then(r => r.json().catch(() => ({})).then(d => ({ ok: r.ok, status: r.status, d })))
    .then(({ ok, status, d }) => {
      if (status === 401 || status === 403) {
        forgetKey();
        throw new Error("key rejected");
      }
      if (!ok) throw new Error((d.error && d.error.message) || d.note || "failed");
      return d;
    });
}

/**
 * Federation switches with a request in flight.
 *
 * Same lesson the warm buttons cost: the poll rebuilds these every few seconds,
 * so a disabled flag set on click is wiped by the next redraw and the switch comes
 * back live while the POST is still going. Module state keyed by direction
 * survives the redraw; a flag on the element does not.
 */
const flipping = new Set();

/**
 * Writes with a request in flight, keyed by what they touch.
 *
 * Same lesson as \`flipping\` and \`warming\`, learned twice already: the 3s poll
 * rebuilds these controls, so a disabled flag set on the element is wiped by
 * the next redraw and the button comes back live while the POST is still going.
 * Keyed by the THING rather than the node, so the state survives the rebuild.
 */
const busy = new Set();

/** The last failure for a control, by the same key. Survives the redraw so a
 *  message does not vanish mid-sentence, and is cleared by the retry. */
const failed = new Map();

/**
 * A small control that posts to /control and reports its own outcome.
 *
 * The sharing toggles and both mapping actions all needed the identical dance —
 * disable, post, refresh on success, show the error in place on failure — and
 * three copies of it is three places to forget the \`finally\`.
 */
function writeBtn(key, label, title, bodyFn) {
  const frag = document.createDocumentFragment();
  const b = el("button", "load", busy.has(key) ? "…" : label);
  b.type = "button";
  if (title) b.title = title;
  if (busy.has(key)) b.disabled = true;

  // The message goes BESIDE the control, not into it. It used to be assigned to
  // the button's own textContent, which turned a sentence into the label of a
  // bordered box — a paragraph of red spanning the width of the page, where a
  // word had been. Worse for the longest messages, which are the ones you most
  // need to read.
  const say = (msg) => {
    const sp = el("span", "wfail", msg);
    b.insertAdjacentElement("afterend", sp);
  };

  const clear = () => {
    failed.delete(key);
    const sib = b.nextElementSibling;
    if (sib && sib.classList.contains("wfail")) sib.remove();
  };

  b.addEventListener("click", () => {
    if (b.disabled || busy.has(key)) return;
    // Clearing on click matters more than it sounds: a failed write changes
    // nothing on the server, so the poll's signature is identical and NOTHING
    // redraws. Without this the old message sits under the button through the
    // retry that fixed it.
    clear();
    busy.add(key);
    b.disabled = true;
    b.textContent = "…";
    postWrite("/control", bodyFn())
      // Only a SUCCESS redraws immediately. On failure the redraw would replace
      // the message with unchanged state, and a refused write would look exactly
      // like a click that did nothing.
      .then(() => refresh(true))
      .catch(e => {
        const msg = String((e && e.message) || e);
        failed.set(key, msg);
        b.classList.add("failed");
        b.textContent = label;
        say(msg);
      })
      // finally, not then: a failed write must not leave the control stuck for
      // the rest of the session.
      .finally(() => { busy.delete(key); b.disabled = false; });
  });

  frag.appendChild(b);
  // Re-attached after a redraw rebuilt the control, the same way \`busy\` keeps a
  // request in flight visible across one.
  if (failed.has(key)) {
    b.classList.add("failed");
    frag.appendChild(el("span", "wfail", failed.get(key)));
  }
  return frag;
}

/** Copy a <pre> to the clipboard, falling back to selecting it. Used by both
 *  config snippets on the page. */
function copyBtn(pre) {
  const copy = el("button", "load", "copy");
  copy.style.marginTop = "6px";
  copy.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      // Only available in a secure context, which loopback is and a plain-http
      // tailnet address is not, so the selection below is the real fallback.
      await navigator.clipboard.writeText(pre.textContent);
      copy.textContent = "copied";
    } catch {
      const r = document.createRange();
      r.selectNodeContents(pre);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      copy.textContent = "selected — press copy";
    }
    setTimeout(() => { copy.textContent = "copy"; }, 2500);
  });
  return copy;
}

/** "lending ● on" — one shape, used by both the button and the read-only span. */
function setFedLabel(node, labelText, on) {
  node.replaceChildren();
  node.appendChild(document.createTextNode(labelText));
  node.appendChild(el("span", "dot", "●"));
  node.appendChild(document.createTextNode(on ? "on" : "PAUSED"));
}

/** One federation switch. The second argument is the state RIGHT NOW; clicking
 *  sends its opposite. */
function fedSwitch(dir, on, labelText) {
  if (!canWarm) {
    // Read-only surface: show the state, never a control that would 404 here.
    //
    // This used to return null for a direction that was ON, which was wrong in
    // the case that matters most — the healthy one. An operator whose only
    // dashboard is the standalone uiListen port saw NOTHING, before or after
    // this feature shipped, and reasonably read that as "the deploy did not
    // land" rather than "the control lives on another socket". Absence of a
    // control is indistinguishable from absence of the feature.
    //
    // A status page's job is to state the state, including when the state is
    // boring. The switch is simply not clickable here.
    //
    // Rendered as "lending ● on" rather than as a pill, and carrying a title
    // that names WHERE the control does live. Saying "you cannot do it here"
    // without saying "do it there" just moves the dead end.
    const s = el("span", "fed" + (on ? "" : " off"));
    setFedLabel(s, labelText, on);
    // SINGLE-quoted on purpose. A backslash-escaped double quote here does not
    // survive: this whole page is a TS template literal, so \\" collapses to a
    // bare " on the way out and terminates the emitted string early — the
    // script then fails to PARSE and the entire page renders blank. Same family
    // as the backtick trap in this file's header. Single quotes need no escape.
    s.title =
      'read-only here — this port serves the status page only. '
      + 'Change it on the main listener: POST /control {"' + dir + '": ' + (on ? 'false' : 'true') + '}';
    return s;
  }
  const b = document.createElement("button");
  b.className = "fed" + (on ? "" : " off");
  b.type = "button";
  // Same shape as the read-only variant, so the two sockets do not render the
  // same fact two different ways.
  setFedLabel(b, labelText, on);
  b.title = on
    ? "pause " + labelText + " — takes effect immediately, and resets to the config on restart"
    : "resume " + labelText;
  if (flipping.has(dir)) {
    b.disabled = true;
    b.textContent = labelText + " …";
  }

  b.addEventListener("click", () => {
    if (b.disabled || flipping.has(dir)) return;
    flipping.add(dir);
    b.disabled = true;
    b.textContent = labelText + " …";
    const body = {};
    body[dir] = !on;
    postWrite("/control", body)
      .then(() => {
        // Only a SUCCESSFUL flip redraws immediately. On failure the redraw
        // would replace the error with the unchanged state, and a rejected key
        // would look exactly like a click that did nothing — the poll takes it
        // away soon enough on its own, which leaves the message up long enough
        // to read.
        refresh(true);
      })
      .catch(e => {
        b.classList.add("off");
        b.textContent = labelText + ": " + String(e.message || e);
      })
      .finally(() => {
        // Released in finally, not then, so a failed flip does not leave the
        // switch stuck for the rest of the session.
        flipping.delete(dir);
      });
  });
  return b;
}

/**
 * Models with a load in flight, and WHY this is module state rather than a
 * flag on the button.
 *
 * The button disabled itself on click, which looked right and was not: the
 * 3s poll calls replaceChildren on this list and builds a FRESH button, so the
 * disable lasted until the next tick and then the control came back enabled
 * and unlabelled while the load was still running. You could click it again,
 * and nothing on screen said the first click was still working.
 *
 * Keyed by model so the state belongs to the thing being loaded rather than to
 * a DOM node that gets thrown away.
 */
const warming = new Set();

/** name, then the node it lives on, then a status — each in its own span so
 *  the node stays legible when the status is long. */
/**
 * Which node serves a model, or null when we do serve it ourselves.
 *
 * Our own node wins even if a peer also has it: a model we can load here is not
 * "on" someone else's machine, and labelling it with their name would send the
 * reader looking in the wrong place.
 */
function nodeOf(net, model) {
  const self = net.nodes.find(n => n.self);
  if (self && (self.serves || []).includes(model)) return null;
  const p = net.nodes.find(n => !n.self && (
    (n.serves || []).includes(model) || (n.configured || []).includes(model)));
  return p ? p.name : null;
}

/**
 * The load action, as a table cell rather than a chip.
 *
 * The model name is already in the row, so the button only has to say what it
 * does. It reports its own outcome in place — "loading…", then whatever came
 * back — because a decline and an already-warm both return 200 and are worth
 * reading rather than flattening into a silent success.
 */
function loadBtn(model, peer) {
  const b = document.createElement("button");
  b.className = "load";
  b.type = "button";
  b.textContent = "load";
  b.title = peer
    ? "ask " + peer + " to load " + model + " — they may decline if busy"
    : "load " + model + " here now, evicting whatever is resident";
  // Rebuilt every poll, so in-flight state is read back rather than assumed.
  // Without this a load in progress looks like an idle button and invites a
  // second click.
  if (warming.has(model)) {
    b.disabled = true;
    b.textContent = "loading…";
  }
  b.addEventListener("click", () => {
    if (b.disabled || warming.has(model)) return;
    warming.add(model);
    b.disabled = true;
    b.textContent = "loading…";
    postWrite("/v1/warm", { model })
      .then(d => { b.textContent = d.warmed ? "loaded" : (d.note ? "no change" : "no change");
                   if (d.note) b.title = d.note; })
      .catch(e => { b.classList.add("failed"); b.textContent = String(e.message || e); })
      .finally(() => {
        // Cleared here and NOT in .then, so a failure releases the model too —
        // otherwise one error would leave it un-loadable until a reload.
        warming.delete(model);
        setTimeout(() => refresh(true), 1200);
      });
  });
  return b;
}

function emptyChart(s, msg) {
  s.setAttribute("viewBox", "0 0 900 60");
  const t = svg("text", { x:12, y:34, class:"axlabel" });
  t.textContent = msg;
  s.appendChild(t);
}

// --- 1. queue depth over time ---------------------------------------------
// One series, so no legend: the title names it. Area + emphasised endpoint,
// recessive grid, crosshair on hover.
function drawDepth(hist) {
  const s = document.getElementById("depth");
  hideTip();
  s.replaceChildren();
  // History.start() takes a sample immediately "so the graph has a point
  // immediately, not in 5s" — but one sample makes hist.length-1 zero, every
  // x() divides by it, and the browser silently drops a path full of NaN. The
  // intent in history.ts was defeated by the arithmetic here: a blank chart
  // under a header claiming "1 samples".
  if (!hist || hist.length < 2) { emptyChart(s, "warming up"); return; }
  // H MUST match the svg viewBox height in the markup above. They drifted once
  // (viewBox 130 against H 150) and the chart was silently squashed.
  const W = 900, H = 96, L = 34, R = 8, T = 10, B = 18;
  const peak = Math.max(1, ...hist.map(d => d.queued));
  const x = i => L + (i / (hist.length - 1)) * (W - L - R);
  const y = v => T + (1 - v / peak) * (H - T - B);

  // grid + y labels at 0 and the peak only; anything more is noise here
  for (const v of [0, peak]) {
    s.appendChild(svg("line", { x1:L, x2:W-R, y1:y(v), y2:y(v),
      stroke:"var(--hair)", "stroke-width":1 }));
    const lab = svg("text", { x:L-7, y:y(v)+3.5, "text-anchor":"end", class:"axlabel" });
    lab.textContent = v; s.appendChild(lab);
  }

  const pts = hist.map((d,i) => [x(i), y(d.queued)]);
  const line = pts.map(([a,b],i) => (i?"L":"M")+a.toFixed(1)+" "+b.toFixed(1)).join(" ");
  s.appendChild(svg("path", { d:\`\${line} L \${x(hist.length-1)} \${y(0)} L \${x(0)} \${y(0)} Z\`,
    fill:"var(--live-soft)", stroke:"none" }));
  s.appendChild(svg("path", { d:line, fill:"none", stroke:"var(--live)",
    "stroke-width":2, "stroke-linejoin":"round", "stroke-linecap":"round" }));

  // emphasised endpoint
  const last = pts[pts.length-1];
  s.appendChild(svg("circle", { cx:last[0], cy:last[1], r:4,
    fill:"var(--live)", stroke:"var(--bg)", "stroke-width":2 }));

  for (const [i, anchor] of [[0,"start"],[hist.length-1,"end"]]) {
    const t = svg("text", { x:x(i), y:H-4, "text-anchor":anchor, class:"axlabel" });
    t.textContent = i ? "now" : clock(hist[0].t); s.appendChild(t);
  }

  // hover: crosshair + tooltip
  const cross = svg("line", { class:"crosshair", y1:T, y2:H-B, opacity:0 });
  s.appendChild(cross);
  const hit = svg("rect", { x:L, y:0, width:W-L-R, height:H, fill:"transparent" });
  s.appendChild(hit);
  hit.addEventListener("mousemove", e => {
    const bb = s.getBoundingClientRect();
    const rel = (e.clientX - bb.left) / bb.width * W;
    const i = Math.max(0, Math.min(hist.length-1,
      Math.round((rel - L) / (W - L - R) * (hist.length - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    cross.setAttribute("opacity", 1);
    const d = hist[i];
    showTip(e, \`<b>\${esc(d.queued)}</b> queued &middot; \${esc(clock(d.t))}\` +
      ((d.residents && d.residents.length)
        ? \`<br><span style="color:var(--dim)">warm: \${esc(d.residents.join(", "))}</span>\` : ""));
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("opacity",0); hideTip(); });

  document.getElementById("histrange").textContent =
    \`peak \${peak} · \${hist.length} samples · 5s apart\`;
  document.getElementById("depthdesc").textContent =
    \`Queue depth over the last 10 minutes, peaking at \${peak} jobs.\`;
}

// --- 2. which model was loaded --------------------------------------------
// Identity by POSITION, not hue. One lane per model; a swap is a step between
// rows, so A-B-A-B thrash is visible as a staircase. Everything stays ember,
// which keeps colour meaning exactly one thing on this page: warm.
function drawLanes(hist, thrashy) {
  const s = document.getElementById("lanes");
  hideTip();
  s.replaceChildren();
  if (!hist || hist.length < 2) { emptyChart(s, "warming up"); return; }
  const W = 900, L = 150, R = 8, T = 8;
  // Several backends means several models warm at once, so this flattens a
  // list per sample rather than reading one name.
  // Models on an EVICTING backend first. A backend that keeps everything
  // resident produces an unbroken bar edge to edge, which is structurally
  // incapable of showing the thrash this chart exists to show — four such rows
  // above the one that moves buried the signal. Sorted up and drawn bright;
  // the rest stay for context, dimmed.
  const canThrash = m => !thrashy || thrashy.has(m);
  const models = [...new Set(hist.flatMap(d => d.residents || []))]
    .sort((a, b) => (canThrash(b) ? 1 : 0) - (canThrash(a) ? 1 : 0));
  const rowH = 22, gap = 6;
  const H = T + models.length * (rowH + gap);
  s.setAttribute("viewBox", \`0 0 \${W} \${H + 18}\`);
  const x = i => L + (i / (hist.length - 1)) * (W - L - R);
  const nowWarm = new Set(hist[hist.length - 1].residents || []);

  models.forEach((m, r) => {
    const yTop = T + r * (rowH + gap);
    s.appendChild(svg("rect", { x:L, y:yTop, width:W-L-R, height:rowH,
      fill:"var(--hair)", rx:2 }));
    const lab = svg("text", { x:L-10, y:yTop+rowH/2+3.5, "text-anchor":"end",
      class:"lanelabel" + (!canThrash(m) ? " off" : nowWarm.has(m) ? " on" : "") });
    lab.textContent = m; s.appendChild(lab);

    // contiguous runs become one bar, with a 2px surface gap between them
    const has = (k) => (hist[k].residents || []).includes(m);
    let i = 0;
    while (i < hist.length) {
      if (!has(i)) { i++; continue; }
      // i0/j0 are per-bar CONSTANTS. The tooltip handler below closes over the
      // enclosing loop variable i, which advances to hist.length — so by
      // the time anyone hovered, hist[i] was undefined and the handler threw
      // "Cannot read properties of undefined (reading 't')" on every pass. The
      // lanes tooltip has never worked. Capture the values, not the cursor.
      let j = i; while (j + 1 < hist.length && has(j+1)) j++;
      const i0 = i, j0 = Math.min(j + 1, hist.length - 1);
      const x0 = x(i0), x1 = x(j0);
      const bar = svg("rect", { x:x0+1, y:yTop, width:Math.max(2, x1-x0-2), height:rowH,
        rx:2, fill: !canThrash(m) ? "var(--line)"
                  : nowWarm.has(m) ? "var(--live)" : "var(--dim)" });
      bar.addEventListener("mousemove", e => showTip(e,
        \`<b>\${esc(m)}</b><br><span style="color:var(--dim)">loaded \${esc(clock(hist[i0].t))}–\${esc(clock(hist[j0].t))}</span>\`));
      bar.addEventListener("mouseleave", hideTip);
      s.appendChild(bar);
      i = j + 1;
    }
  });

  // A swap is any change in the warm set, which on a multi-backend node means
  // "one of the backends swapped", not necessarily the GPU.
  const swaps = hist.filter((d,i) =>
    i && (d.residents || []).join("\\u0000") !== (hist[i-1].residents || []).join("\\u0000")).length;
  const t = svg("text", { x:L, y:H+12, class:"axlabel" });
  t.textContent = \`\${swaps} swap\${swaps===1?"":"s"} in this window\`;
  s.appendChild(t);
  const t2 = svg("text", { x:W-R, y:H+12, "text-anchor":"end", class:"axlabel" });
  t2.textContent = "now"; s.appendChild(t2);
  document.getElementById("lanesdesc").textContent =
    \`Resident models over time across \${models.length} models, with \${swaps} swaps.\`;
}

// --- accessible table view -------------------------------------------------
function drawHistTable(hist) {
  const t = document.getElementById("histtable");
  const every = Math.ceil(hist.length / 12);
  const rows = hist.filter((_, i) => i % every === 0);
  const head = el("tr");
  ["Time","Queued","Loaded"].forEach(h => { const th = el("th", null, h); head.appendChild(th); });
  const thead = document.createElement("thead"); thead.appendChild(head);
  const tbody = document.createElement("tbody");
  rows.forEach(d => {
    const tr = el("tr");
    tr.appendChild(el("td", null, clock(d.t)));
    tr.appendChild(el("td", null, String(d.queued)));
    tr.appendChild(el("td", null, (d.residents || []).join(", ") || "—"));
    tbody.appendChild(tr);
  });
  t.replaceChildren(thead, tbody);
}

// --- 3. the network, as a graph -------------------------------------------
// Self at the centre, because that is literally the data model: every node
// sees the network from where it stands. /network is one node's view.
/**
 * The models table — one row per model this network can serve.
 *
 * It replaces three overlapping displays: a node graph, a "serves" chip list on
 * the selected node, and a warm/cold chip stack. Between them one model appeared
 * four times on a page that could not say, in one place, where a model runs and
 * whether it is loaded. A table can, in one row.
 */
/**
 * Whether we are lending this model, and the control to change it.
 *
 * Three facts get flattened into one cell, and keeping them apart is the whole
 * difficulty:
 *
 *   intent     what we mean to lend — the config list, or the runtime override
 *              on top of it
 *   effective  what is ACTUALLY going out, which is nothing at all while the
 *              master lending switch is paused
 *   drift      whether intent differs from the file, so a change nobody
 *              remembers making is visible rather than mysterious
 *
 * Showing only \`effective\` would make every row read "no" during a pause and
 * lose the per-model settings you had. Showing only \`intent\` would claim we are
 * lending things while lending is off. So it renders intent and says when that
 * is not what is happening.
 */
function shareCell(model, d) {
  const td = el("td");
  // Not ours to lend. A model that only exists on a peer is in this table
  // because it is reachable, not because we serve it.
  if (!(d.catalog || []).includes(model)) {
    td.appendChild(el("span", "shared", "—"));
    return td;
  }
  const ovr = (d.controls && d.controls.models) || {};
  const inFile = (d.configuredShare || []).includes(model);
  const intent = Object.prototype.hasOwnProperty.call(ovr, model) ? ovr[model] : inFile;
  const effective = (d.share || []).includes(model);
  const drift = intent !== inFile;

  const label = intent ? "lent" : "held";
  let why = intent
    ? "peers may use this model"
    : "peers cannot use this model";
  if (intent && !effective) why = "lending is paused, so this is not going out despite being on the list";

  if (canWarm) {
    // Toggling back to whatever the config says CLEARS the override rather than
    // pinning the same value by hand. Otherwise the pending-changes block would
    // keep reporting a difference after you had put everything back.
    const next = !intent;
    td.appendChild(writeBtn("share:" + model, label, why + " — click to " + (next ? "lend" : "hold"),
      () => ({ share: { [model]: next === inFile ? null : next } })));
  } else {
    const sp = el("span", "shared" + (intent ? " on" : ""), label);
    sp.title = why;
    td.appendChild(sp);
  }
  if (drift) {
    const m = el("span", "drift", "*");
    m.title = "not what hearth.yaml says — reverts on restart";
    td.appendChild(m);
  }
  return td;
}

function drawModels(net, d) {
  const unknown = net.unknownWarm || [];
  // Every node that can serve this model, not just the first one found. At two
  // nodes "the first" was harmless; at seven it hides most of the fleet's
  // redundancy, which is the main thing this page is consulted for. A peer's
  // configured list counts too — a peer we have mapped but that is down still tells you where a
  // model lives.
  const holders = m => net.nodes.filter(n =>
    (n.serves || []).includes(m) || (n.configured || []).includes(m));

  const rows = (net.available || []).map(m => {
    const on = holders(m);
    return {
      model: m,
      on,
      warmOn: on.filter(n => (n.loaded || []).includes(m)),
      warm: net.readyNow.includes(m),
      unknown: !net.readyNow.includes(m) && unknown.includes(m),
    };
  });
  // Warm first — it is the perishable fact. Alphabetical within a group so rows
  // do not shuffle between polls for no reason.
  rows.sort((x, y) => (Number(y.warm) - Number(x.warm)) || x.model.localeCompare(y.model));

  const body = document.getElementById("models");
  if (!rows.length) {
    const tr = el("tr"); const td = el("td", "empty", "no models reachable");
    td.colSpan = 5; tr.appendChild(td); body.replaceChildren(tr); return;
  }
  body.replaceChildren(...rows.map(r => {
    const tr = el("tr");
    tr.appendChild(el("td", "model", r.model));

    // Every holder, warm ones emphasised, so "who has this and who has it
    // ready" is one glance rather than a deduction.
    const nodes = el("td", "sub m nodes");
    if (!r.on.length) nodes.appendChild(el("span", null, "—"));
    r.on.forEach((n, i) => {
      const hot = (n.loaded || []).includes(r.model);
      const tag = el("span", hot ? "holder hot" : "holder", n.name);
      if (hot) tag.title = r.model + " is loaded on " + n.name;
      nodes.appendChild(tag);
      if (i < r.on.length - 1) nodes.appendChild(document.createTextNode(" "));
    });
    tr.appendChild(nodes);

    const st = el("td");
    const sp = el("span", "state" + (r.warm ? " warm" : ""));
    sp.appendChild(el("span", "dotm", "●"));
    sp.appendChild(document.createTextNode(r.warm ? "warm" : r.unknown ? "unknown" : "cold"));
    // Warmth is a UNION across nodes, so "warm" can mean "warm somewhere else".
    // A local request would still pay the load, and that is worth saying rather
    // than leaving the reader to infer it from the node column.
    if (r.warm && r.warmOn.length && !r.warmOn.some(n => n.self)) {
      sp.title = "loaded on " + r.warmOn.map(n => n.name).join(", ") + ", not here";
    }
    if (r.unknown) sp.title = "this backend does not report what it has loaded";
    st.appendChild(sp);
    tr.appendChild(st);

    tr.appendChild(shareCell(r.model, d));

    const act = el("td", "num");
    if (!r.warm && !r.unknown && canWarm) act.appendChild(loadBtn(r.model, nodeOf(net, r.model)));
    tr.appendChild(act);
    return tr;
  }));

  document.getElementById("modelnote").textContent =
    rows.filter(r => r.warm).length + " of " + rows.length + " loaded";
}

/** One row per node: what it is, whether it is up, and what it is doing. */
/**
 * A peer's model map, and the two edits you can make to it.
 *
 * This replaces a read-only disclosure that printed the YAML you would have to
 * paste. That was the right shape while \`peers[].models\` was config-only — it
 * IS the allowlist deciding which of your prompts may leave the machine, and a
 * one-click widening of that deserved a second thought. What it was not was
 * usable: a peer adds a model, you read the snippet, you ssh to the box, you
 * edit the file, you restart, and by then you have lost interest.
 *
 * So the click is here now, and the second thought is kept by other means: the
 * edit is live but temporary, and the pending-changes block hands you the same
 * YAML to make it stick. Try it, then decide.
 *
 * The snippet survives on the read-only listener, where there is nothing to
 * click and pasting is still the only route.
 */

/**
 * Disclosures the operator has opened, by key.
 *
 * \`<details open>\` lives in the DOM and every draw here starts with
 * replaceChildren, so an open panel closes itself on the next poll — which
 * cost a real bug: the save button lived inside one of these, and changing
 * anything collapsed the block and took the button with it. Anything that
 * opens has to remember, not just the ones where it looks untidy.
 */
const opened = new Set();

function keepOpen(d, key) {
  if (opened.has(key)) d.open = true;
  d.addEventListener("toggle", () => {
    if (d.open) opened.add(key); else opened.delete(key);
  });
  return d;
}

/**
 * Quote anything that is not a plain YAML-safe scalar.
 *
 * The same rule the server applies in overrides.ts, needed here for the same
 * reason and one more: these ids come from the PEER, who chooses them. An id
 * containing a newline would otherwise inject whatever structure it liked into
 * a block this page is telling the operator to paste into their config.
 */
const yq = (v) => /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(v) ? v : JSON.stringify(v);

/** The old paste-this snippet, for surfaces that cannot write. */
function mapSnippet(n) {
  const box = el("div");
  // Indented to sit under \`models:\` inside this peer's entry, which is where it
  // has to go. Same id on both sides is the common case; the left is the name
  // you ask for and the right is theirs.
  const map = n.unmapped.map(m => "        " + yq(m) + ": " + yq(m)).join("\\n");
  const routes = n.unmapped.map(m =>
    "  " + yq(m) + ":\\n    policy: peer\\n    peers: [" + yq(n.name) + "]\\n    fallbackLocal: false").join("\\n");

  const pre = el("pre", null,
    "# in peers[name: " + n.name + "], under models:\\n" + map + "\\n\\n" +
    "# and to actually route to it, under the top-level models:\\n" + routes);
  box.appendChild(pre);
  box.appendChild(el("div", "why",
    "fallbackLocal: false because you have no local copy — without it a request " +
    "falls back to a backend that has never heard of this model."));
  box.appendChild(copyBtn(pre));
  return box;
}

function mapBlock(n) {
  const pairs = Object.entries(n.map || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const unmapped = (n.unmapped || []).slice().sort();
  if (!pairs.length && !unmapped.length) return null;

  // Amber only when there is something unclaimed. A fully mapped peer is not a
  // warning, and painting it as one is how a colour stops meaning anything.
  const d = el("details", "unmapped maps" + (unmapped.length ? "" : " clean"));
  // Otherwise typing a name into a row and pausing for three seconds collapses
  // the panel under you.
  keepOpen(d, "peer:" + n.name);

  const many = unmapped.length > 1;
  d.appendChild(el("summary", null, unmapped.length
    ? unmapped.length + " model" + (many ? "s" : "") + " offered here you cannot reach: " + unmapped.join(", ")
    : pairs.length + " model" + (pairs.length > 1 ? "s" : "") + " mapped to " + n.name));

  const tbl = el("table");
  const body = el("tbody");
  const row = (mine, theirs, action) => {
    const tr = el("tr");
    tr.appendChild(mine);
    tr.appendChild(el("td", "arrow", "→"));
    tr.appendChild(el("td", "m", theirs));
    const a = el("td");
    if (action) a.appendChild(action);
    tr.appendChild(a);
    return tr;
  };

  for (const [mine, theirs] of pairs) {
    body.appendChild(row(
      el("td", "m", mine), theirs,
      canWarm
        ? writeBtn("unlink:" + n.name + "/" + mine, "unlink",
            "stop sending " + mine + " to " + n.name,
            () => ({ unlink: { peer: n.name, mine: mine } }))
        : null));
  }

  for (const theirs of unmapped) {
    const cell = el("td");
    // Prefilled with THEIR id, because the ids match in nearly every case and
    // the field exists for the one where they do not. Editable rather than
    // fixed, so a peer's \`qwen3-coder-30b\` can arrive as your \`coder\` without
    // needing a second concept for it.
    const input = el("input");
    input.value = theirs;
    input.setAttribute("aria-label", "local name for " + theirs);
    cell.appendChild(input);
    body.appendChild(row(cell, theirs,
      canWarm
        ? writeBtn("link:" + n.name + "/" + theirs, "link",
            "route requests for this id to " + n.name,
            () => ({ link: { peer: n.name, mine: input.value.trim() || theirs, theirs: theirs } }))
        : null));
  }
  tbl.appendChild(body);
  d.appendChild(tbl);

  if (canWarm) {
    d.appendChild(el("div", "why",
      "Linking maps the id and routes it, which are two halves of one thing: a " +
      "mapping on its own only says a request MAY leave. A model you also serve " +
      "gets policy fastest with a local fallback; one you do not gets policy " +
      "peer and no fallback, since home is a backend that has never heard of it."));
  } else if (unmapped.length) {
    d.appendChild(mapSnippet(n));
  }
  return d;
}

/**
 * Runtime changes that are not in the config file.
 *
 * The counterweight to making all of this clickable. Every edit on this page is
 * live and temporary, which is a fine default and a terrible surprise — six
 * weeks on, a model is being lent that \`share:\` does not list and the only
 * explanation is a click nobody remembers. This block is the answer to "why is
 * it doing that", and its copy button is the answer to "make it stop being a
 * surprise".
 */
function drawPending(ov, drift) {
  const host = document.getElementById("pending");
  if (!ov || !ov.dirty) { host.replaceChildren(); return; }
  const c = ov.changes || { maps: [], routes: [] };
  const n = c.maps.length + c.routes.length + (drift ? 1 : 0);

  // The state and its action sit OUTSIDE the disclosure, and the config to
  // paste sits inside it. They were both inside at first, which put the one
  // button that decides whether your work survives a restart behind a click on
  // a line that reads like a status message. A disclosure is for detail you
  // might want; it is not for the action the block exists to offer.
  const box = el("div", "pending");
  const head = el("div", "pendhead");
  // Three states, and which one you are in depends on where a save would go.
  // A config save leaves nothing behind — the file becomes the record and this
  // block disappears — so "saved" only ever describes the sidecar.
  const toConfig = ov.savesTo === "config";
  const fate = !ov.canSave
    ? " — these revert on restart"
    : ov.unsaved
      ? " — not saved, so a restart discards them"
      : " — saved, and kept across a restart";
  head.appendChild(el("span", "pendtext",
    n + " runtime change" + (n === 1 ? "" : "s") + " not in the config file" + fate));
  if (canWarm && ov.canSave && ov.unsaved) {
    head.appendChild(writeBtn("save", toConfig ? "save to config" : "save",
      toConfig
        ? "write these into " + (ov.savePath || "the config file") + ", comments and all"
        : "keep these across a restart in " + (ov.savePath || "the state file"),
      () => ({ save: true })));
  }
  box.appendChild(head);

  const d = keepOpen(el("details", "pendyaml"), "yaml");
  d.appendChild(el("summary", null, "show the config to paste"));
  const pre = el("pre", null, ov.yaml);
  d.appendChild(pre);
  d.appendChild(el("div", "why", toConfig
    ? "Save writes these into the config file itself, comments intact, and this block goes away — the file becomes the record again. The text is here in case you would rather paste it somewhere else."
    : ov.canSave
      ? "Save keeps these on this box. Pasting puts them where the rest of the config lives — each block replaces the one it names."
      : "Paste into hearth.yaml to keep them. Each block replaces the one it names."));
  d.appendChild(copyBtn(pre));
  box.appendChild(d);

  host.replaceChildren(box);
}

function drawNodes(net, q) {
  const host = document.getElementById("nodes");
  host.replaceChildren(...net.nodes.map(n => {
    const row = el("div", "node-row");
    row.appendChild(el("span", "node-name", n.name));
    if (n.self) row.appendChild(el("span", "self-tag", "this node"));
    const st = el("span", "state" + (n.up ? "" : " down"));
    st.appendChild(el("span", "dotm", "●"));
    st.appendChild(document.createTextNode(n.up ? "up" : "down"));
    row.appendChild(st);
    if (n.lastError) {
      const e = el("span", "sub", String(n.lastError).slice(0, 80));
      e.style.fontSize = "12px";
      row.appendChild(e);
    }

    const nums = el("div", "node-nums");
    const busy = (n.slots || 0) - (n.free || 0);
    // The hot flag paints the number amber — "working", the middle state in the
    // palette's three. It is reserved for pressure that is actually true right
    // now: no free slot, or somebody waiting. Everything idle stays quiet, so a
    // saturated node is findable in a list of seven without reading any of it.
    const add = (label, value, hot) => {
      const w = el("span");
      const b2 = el("b", null, String(value));
      if (hot) b2.style.color = "var(--work)";
      w.appendChild(b2);
      w.appendChild(document.createTextNode(" " + label));
      nums.appendChild(w);
    };
    add("busy", busy + "/" + (n.slots ?? "?"), n.up && n.free === 0 && n.slots > 0);
    add("queued", n.queued ?? 0, (n.queued ?? 0) > 0);
    if (n.self && q.capacity.offbox) add("off-box", q.capacity.offbox);
    if (!n.self && n.sending) add("sending", n.sending);
    row.appendChild(nums);

    // What we may ask this peer for, and what it offers that we have not
    // claimed. /network has always computed the second half; the page dropped it
    // in the redesign, which quietly removed the only thing that tells you a
    // peer has started offering something new.
    if (!n.self) {
      const maps = mapBlock(n);
      if (maps) row.appendChild(maps);
    }

    // Backends only matter for our own node — a peer's internals are its own
    // business and it does not report them.
    if (n.self && n.backends && n.backends.length) {
      const bs = el("div", "backends");
      for (const b of n.backends) {
        const resident = b.loaded && b.loaded.length ? b.loaded.join(" ") : "idle";
        bs.appendChild(el("span", null, b.name + " · " + resident));
      }
      row.appendChild(bs);
    }
    return row;
  }));
}

const sigs = {};
function redrawIf(key, data, fn) {
  const sig = JSON.stringify(data);
  if (sigs[key] === sig) return;
  sigs[key] = sig;
  fn();
}

function render(d) {
  const { net, q, hist, canWarm: cw, controls, control } = d;
  canWarm = cw === true;
  writeMode = control === "key" ? "key" : "open";

  // Federation switches. Rendered before anything else in this section so a
  // paused node says so at the top rather than leaving you to infer it from an
  // empty chip list further down.
  const c = controls || { lending: true, borrowing: true };
  // No filter(Boolean) any more: fedSwitch always returns an element now, on
  // both sockets. It returned null for an ON direction once, which is exactly
  // how the healthy state became invisible on the standalone listener.
  document.getElementById("fedbar").replaceChildren(
    fedSwitch("lending", c.lending !== false, "lending"),
    fedSwitch("borrowing", c.borrowing !== false, "borrowing"));
  const self = net.nodes.find(n => n.self) || { name:"?" };
  document.getElementById("selfname").textContent = self.name;

  const cap = q.capacity;
  const queuedTotal = Object.values(cap.queued).reduce((a,b) => a+b, 0);
  const nodesUp = net.nodes.filter(n => n.up).length;

  // The vitals, on one line. This was four KPI tiles, each with a big number and
  // a sentence underneath explaining it — which is a lot of page for four
  // numbers, and the sentences said things the numbers already said.
  const vit = document.getElementById("vitals");
  const stat = (value, label) => {
    const w = el("span");
    w.appendChild(el("b", null, value));
    w.appendChild(document.createTextNode(" " + label));
    return w;
  };
  vit.replaceChildren(
    stat(cap.free + "/" + cap.slots, "free"),
    stat(String(queuedTotal), "queued"),
    stat(String(net.readyNow.length), "loaded"),
    stat(nodesUp + "/" + net.nodes.length, "nodes"),
    el("span", "live", "live"),
  );

  // Only say "thrash" where something actually evicts. An ollama backend keeps
  // its models resident under keep_alive and serves them together, so flipping
  // between its rows costs nothing and warning about it would be wrong.
  document.getElementById("thrashnote").textContent = net.evicts === false
    ? "these backends hold models resident" : "each change of row is a cold load";

  // Which models sit on a backend that actually evicts. Everything else cannot
  // thrash by construction, so it is drawn as context rather than signal.
  const selfNode = net.nodes.find(x => x.self);
  const thrashy = new Set();
  for (const b of (selfNode && selfNode.backends) || []) {
    if (b.evicts) for (const m of (b.serves || [])) thrashy.add(m);
  }
  drawDepth(hist); drawLanes(hist, thrashy.size ? thrashy : null); drawHistTable(hist);

  // Signature-gated. Every draw here starts with replaceChildren(), and this
  // runs every 3s — so a focused button lost focus to <body> three seconds
  // later. Most polls change nothing, and comparing a small signature is far
  // cheaper than tearing down and rebuilding the subtree.
  redrawIf("models", [net.available, net.readyNow, net.unknownWarm, canWarm,
                      net.nodes.map(n => [n.name, n.serves]),
                      d.share, d.configuredShare, d.catalog, c.models],
    () => drawModels(net, d));
  redrawIf("nodes", [net.nodes.map(n =>
      [n.name, n.up, n.free, n.slots, n.queued, n.sending, n.lastError, n.map, n.unmapped,
       n.backends && n.backends.map(b => [b.name, b.loaded])]), cap.offbox, canWarm],
    () => drawNodes(net, q));
  // Share drift is computed here rather than sent: the server already says
  // whether ANYTHING is pending, and this only decides whether to count the
  // share list as one of the changes in the summary line.
  const shareDrift =
    [...(d.share || [])].sort().join(",") !== [...(d.configuredShare || [])].sort().join(",");
  redrawIf("pending", [d.overrides, shareDrift], () => drawPending(d.overrides, shareDrift));

  const tb = document.getElementById("jobs");
  if (!q.jobs.length) {
    const tr = el("tr"); const td = el("td","empty","nothing in flight");
    td.colSpan = 7; tr.appendChild(td); tb.replaceChildren(tr); return;
  }
  const rank = { running:0, queued:1 };
  const sorted = [...q.jobs].sort((a,b) =>
    (rank[a.state]-rank[b.state]) || (a.position-b.position));
  tb.replaceChildren(...sorted.map(j => {
    const tr = el("tr");
    const lc = el("td");
    lc.appendChild(el("span","lane"+(j.lane==="chat"?" hot":""), j.lane));
    tr.appendChild(lc);
    tr.appendChild(el("td",null,j.model));
    tr.appendChild(el("td","caller", j.offbox ? (j.peer || "peer") : (j.backend || "—")));
    tr.appendChild(el("td","caller",j.caller));
    const sc = el("td");
    sc.appendChild(el("span","st "+(j.offbox?"offbox":j.state), j.offbox?"on a peer":j.state));
    tr.appendChild(sc);
    tr.appendChild(el("td","num", j.state==="queued"?String(j.position):"—"));
    const t = el("td","num", since(Date.now()-j.since));
    t.dataset.since = String(j.since);
    tr.appendChild(t);
    return tr;
  }));
}

// Guarded on both sides. /ui/data calls peers.ensureFresh(), which can exceed
// the 3s interval exactly when a peer is timing out — which is exactly when you
// are watching. Unguarded, requests stack and an older response can land after
// a newer one and render stale state over fresh.
//
// document.hidden stops a forgotten background tab polling a peer-probing
// endpoint forever. The server already worries about this becoming a load
// generator; this is the client half of that.
let polling = false;
function refresh(force) {
  // force=true skips the visibility check but NEVER the in-flight check.
  if (polling || (document.hidden && !force)) return;
  polling = true;
  load().then(render).catch(e => {
    document.getElementById("selfname").textContent = "unreachable";
    console.error(e);
  }).finally(() => { polling = false; });
}
// The FIRST load is forced, deliberately. document.hidden is true more often
// than you would think — a background tab, a prerender, an embedded pane — and
// gating the initial fetch on it left the page permanently blank in those
// contexts, waiting on a visibilitychange that may never come. Only the
// recurring poll is worth suppressing; one fetch on load is not.
refresh(true);
setInterval(() => refresh(false), 3000);
// Catch up immediately on return rather than waiting out the interval.
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(true); });

setInterval(() => {
  document.querySelectorAll("td[data-since]").forEach(td => {
    td.textContent = since(Date.now() - Number(td.dataset.since));
  });
}, 1000);
</script>
`;
