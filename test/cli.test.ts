/**
 * What the command says when asked about itself or given something it cannot use. The failures
 * worth catching: a stack trace where a sentence was wanted, and a version that is not the package's.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

assert.deepEqual(run("--version"), { code: 0, out: `${version}\n`, err: "" });
for (const how of ["--help", "-h", "help"]) {
  const help = run(how);
  assert.equal(help.code, 0);
  for (const word of ["serve", "init", "set-operator", "migrate", "--config"]) assert.ok(help.out.includes(word), `${how} names ${word}`);
}
const typo = run("--nope");
assert.equal(typo.code, 1);
assert.match(typo.err, /^Unknown option '--nope'\n\nusage: hearth/);
assert.ok(!typo.err.includes("    at "), "no stack trace");
const none = run("serve", "--config", "/nonexistent/hearth.yaml");
assert.equal(none.code, 1);
assert.match(none.err, /Run `hearth init`/);
console.log("cli.test.ts ok");
