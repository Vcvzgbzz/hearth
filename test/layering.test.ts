/**
 * config/ sits at the bottom: every other layer reads the config, so the config reads none of them.
 * Its files import each other, `errors.ts`, the `Logger` type, `routing/actions.ts` (whose only
 * import is `config/read.ts`) and `routing/adapters.ts` (the adapter sandbox, which imports the
 * config only for its types), and nothing else.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ALLOWED = new Set(["src/errors.ts", "src/observe/log.ts", "src/routing/actions.ts", "src/routing/adapters.ts"]);
// Allow config/ to import from anywhere under src/routing/adapter/
const ADAPTER_IMPORT_PREFIX = "src/routing/adapter/";

for (const name of readdirSync("src/config").filter((f) => f.endsWith(".ts"))) {
  const file = join("src/config", name);
  for (const [, spec] of readFileSync(file, "utf8").matchAll(/from "(\.[^"]+)"/g)) {
    const target = normalize(join(dirname(file), spec!)).replace(/\\/g, "/").replace(/\.js$/, ".ts");
    if (target.startsWith("src/config/")) continue;
    const isAllowed = ALLOWED.has(target) || target.startsWith(ADAPTER_IMPORT_PREFIX);
    assert.ok(isAllowed, `${file} imports ${target}: config/ must not depend on the layers that read it`);
  }
}

// What config/ may import may import back only what is named here; the rest are type imports, which
// leave no runtime edge, so `npm run build` is what would catch a wrong one.
const BACK: [string, string[]][] = [
  ["src/routing/actions.ts", ["src/config/read.ts"]],
  ["src/routing/adapters.ts", ["src/routing/adapter/index.ts", "src/routing/adapter/machine.ts"]],
];
for (const [file, allowed] of BACK) {
  for (const [, spec] of readFileSync(file, "utf8").matchAll(/^import (?!type )[^;]* from "(\.[^"]+)"/gm)) {
    const target = normalize(join(dirname(file), spec!)).replace(/\\/g, "/").replace(/\.js$/, ".ts");
    assert.ok(allowed.includes(target), `${file} imports ${target} for a value: config/ must not depend on it at run time`);
  }
}

assert.ok(!/^import (?!type )/m.test(readFileSync("src/errors.ts", "utf8")), "errors.ts imports nothing, so every layer can use it");

console.log("layering.test.ts ok");
