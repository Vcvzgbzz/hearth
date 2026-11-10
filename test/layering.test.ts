/**
 * config/ sits at the bottom: every other layer reads the config, so the config reads none of them.
 * Its files import each other, `errors.ts`, the `Logger` type, and `routing/actions.ts` (whose only
 * import is `config/read.ts`), and nothing else.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ALLOWED = new Set(["src/errors.ts", "src/observe/log.ts", "src/routing/actions.ts"]);

for (const name of readdirSync("src/config").filter((f) => f.endsWith(".ts"))) {
  const file = join("src/config", name);
  for (const [, spec] of readFileSync(file, "utf8").matchAll(/from "(\.[^"]+)"/g)) {
    const target = normalize(join(dirname(file), spec!)).replace(/\.js$/, ".ts");
    if (target.startsWith("src/config/")) continue;
    assert.ok(ALLOWED.has(target), `${file} imports ${target}: config/ must not depend on the layers that read it`);
  }
}

for (const [, spec] of readFileSync("src/routing/actions.ts", "utf8").matchAll(/^import (?!type )[^;]* from "(\.[^"]+)"/gm)) {
  assert.equal(normalize(join("src/routing", spec!)).replace(/\.js$/, ".ts"), "src/config/read.ts", "actions.ts may import config/read.ts only, or config would import its own reader");
}

assert.ok(!/^import (?!type )/m.test(readFileSync("src/errors.ts", "utf8")), "errors.ts imports nothing, so every layer can use it");

console.log("layering.test.ts ok");
