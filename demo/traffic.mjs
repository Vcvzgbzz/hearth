// A handful of callers using the demo node the way real ones would, so its console has something to show.
const url = process.env.DEMO_URL ?? "http://127.0.0.1:4300";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");

async function post(key, path, body, headers = {}) {
  try {
    const r = await fetch(url + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    await r.arrayBuffer();
  } catch {
    // The node is restarting, or was stopped: the next one will say.
  }
}
const chat = (key, model, text, more = {}, headers = {}) => post(key, "/v1/chat/completions", { model, stream: true, messages: [{ role: "user", content: text }], ...more }, headers);
const turns = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: words(40) }));

// What each caller does, and how often relative to the others.
const WORK = [
  [6, () => chat("demo-app", "chat", words(30))],
  [3, () => chat("demo-app", "chat:fast", words(12))],
  [2, () => chat("demo-app", "chat", "what is in this picture", { messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] })],
  [2, () => post("demo-app", "/v1/chat/completions", { model: "chat:best", stream: true, messages: turns(7) })],
  [1, () => chat("demo-app", "chat:best", words(20), {}, { "x-stay": "local" })],
  [1, () => chat("demo-app", "chat", words(32000))],
  [3, () => chat("demo-laptop", "chat:code", words(60))],
  [1, () => chat("demo-laptop", "chat:best", words(25))],
  [4, () => chat("demo-agent", "summaries", words(400), { lane: "agent" })],
  [3, () => post("demo-agent", "/v1/embeddings", { model: "embed", input: words(50) })],
  [1, () => post("demo-agent", "/sdapi/v1/txt2img", { model: "image", prompt: "a hearth" })],
  [2, () => chat("demo-guest", "chat", words(15))],
  [4, () => post("demo-sensor", "/v1/chat/completions", { model: "classify", messages: [{ role: "user", content: `is this reading normal: ${pick([20, 21, 22])}` }] })],
];
const bag = WORK.flatMap(([weight, run]) => Array.from({ length: weight }, () => run));

console.log(`sending demo traffic to ${url} (ctrl-c stops it)`);
for (;;) {
  void pick(bag)();
  await wait(250 + Math.random() * 900);
}
