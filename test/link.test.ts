/**
 * The console's addresses: a link names a page and what is selected on it, and reads back the same.
 *
 *     npx tsx test/link.test.ts
 */
import assert from "node:assert/strict";

import { linkOf, parseLink, PAGE_IDS } from "../src/console/link.js";

// Every page round-trips bare and with a selection, names with `/`, `:`, spaces and `%` included.
for (const page of PAGE_IDS) {
  assert.deepEqual(parseLink(linkOf(page)), { page, rest: [] });
  for (const rest of [["backend:gpu0 box"], ["a/b"], ["my router", "rule:to: the/cloud 100%"], ["self"]]) {
    assert.deepEqual(parseLink(linkOf(page, ...rest)), { page, rest });
  }
}

// The kind stays readable and a name's own `/` cannot split it.
assert.equal(linkOf("topology", "backend:my model"), "#topology/backend:my%20model");
assert.equal(linkOf("plugins", "a/b"), "#plugins/a%2Fb");

// Old bare hashes and `#queue` still land where they did; anything unknown is the topology, with nothing selected.
assert.deepEqual(parseLink("#keys"), { page: "keys", rest: [] });
assert.deepEqual(parseLink("#queue"), { page: "scheduler", rest: [] });
assert.deepEqual(parseLink("#queue/lane:chat"), { page: "scheduler", rest: ["lane:chat"] });
assert.deepEqual(parseLink(""), { page: "topology", rest: [] });
assert.deepEqual(parseLink("#"), { page: "topology", rest: [] });
assert.deepEqual(parseLink("#nowhere/backend:x"), { page: "topology", rest: [] });

// A trailing or doubled slash adds nothing, and a malformed escape is kept as written rather than thrown.
assert.deepEqual(parseLink("#plugins/x/"), { page: "plugins", rest: ["x"] });
assert.deepEqual(parseLink("#routing//default"), { page: "routing", rest: ["default"] });
assert.deepEqual(parseLink("#keys/50%"), { page: "keys", rest: ["50%"] });

console.log("link: ok");
