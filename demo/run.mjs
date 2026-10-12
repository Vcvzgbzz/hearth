// `npm run demo`: the stand-in backends, a friend's node, the demo node and some callers, until ctrl-c.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("demo/.state", { recursive: true });
const kids = [];
const start = (args, env = {}) => { const k = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, ...env } }); kids.push(k); return k; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = () => { for (const k of kids) k.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

start(["demo/backends.mjs"]);
await wait(500);
start(["dist/cli.js", "serve", "--config", "demo/friend.yaml", "--log", "warn"]);
// The providers' keys reach the node the way real ones would: from its environment.
start(["dist/cli.js", "serve", "--config", "demo/hearth.yaml", "--log", "warn"], { DEMO_KEY_A: "demo-key-a", DEMO_KEY_B: "demo-key-b" }).on("exit", stop);
await wait(2500);
if (!process.argv.includes("--quiet")) start(["demo/traffic.mjs"]);
console.log("the demo node is at http://127.0.0.1:4300/ui (ctrl-c stops everything)");
console.log("it asks for a key before it lets you change anything: demo-app");
