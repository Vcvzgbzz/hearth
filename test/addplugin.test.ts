/**
 * The Add plugin dialog: an MCP server's address, as its docs give it, split into what the entry holds.
 */
import assert from "node:assert/strict";

import { splitMcp } from "../src/console/draft.js";

assert.deepEqual(splitMcp("https://example.com/api/mcp"), { serves: "https://example.com/api", path: "/mcp" }, "the last segment is the MCP path");
assert.deepEqual(splitMcp("http://10.0.0.5:3100/mcp"), { serves: "http://10.0.0.5:3100", path: "/mcp" });
assert.deepEqual(splitMcp(" https://example.com/v2/sse/ "), { serves: "https://example.com/v2", path: "/sse" }, "spaces and a trailing slash are let go");
assert.deepEqual(splitMcp("https://example.com"), { serves: "https://example.com", path: "/" }, "an endpoint at the root");
assert.equal(splitMcp("not a url"), null);
console.log("addplugin.test.ts ok");
