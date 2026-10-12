/**
 * Which lines of a rule the map draws under one shared "if". The failures worth catching:
 *
 *   - lines grouped across one that does not share the condition, which would misstate the order
 *   - the closing line pulled into a group
 *   - a group a request can fall out of drawn without its foot
 */
import assert from "node:assert/strict";

import { GROUP, groupRows, groupsOf } from "../src/console/draft.js";

const stay = { header: { "x-stay": ["local"] } };
const steps = [
  { when: { ...stay, images: true }, to: "vision" },
  { when: { ...stay, tokensOver: 8000 }, to: "big" },
  { when: { ...stay }, to: "small" },
  { when: { images: true }, to: "vision" },
  { to: "big" },
];
assert.deepEqual(groupsOf(steps), [{ key: "header", from: 0, to: 2, foot: false }], "neighbours sharing a condition group; a last line that tests nothing more needs no foot");
assert.deepEqual(groupsOf(steps.slice(0, 2).concat(steps.slice(3))), [{ key: "header", from: 0, to: 1, foot: true }], "a group a request can leave says so");

// The same condition either side of a line without it is two things, not one.
const split = [steps[0]!, steps[3]!, steps[1]!, steps[4]!];
assert.deepEqual(groupsOf(split), [{ key: "images", from: 0, to: 1, foot: false }]);
assert.deepEqual(groupsOf([steps[0]!, { when: { tools: true }}, steps[1]!, steps[4]!]), [], "never across a line that does not share it");

// A different value is a different condition, and the closing line belongs to no group.
assert.deepEqual(groupsOf([{ when: { header: { "x-stay": ["away"] } }, to: "a" }, steps[2]!, steps[4]!]), []);
assert.deepEqual(groupsOf([{ when: {}}, { when: {}}]), []);

// What the layout adds: a heading from the group's first line on, a foot only past its last.
const loose = steps.slice(0, 2).concat(steps.slice(3));
assert.deepEqual([groupRows(loose, 0), groupRows(loose, 1), groupRows(loose, 2), groupRows(loose)], [GROUP.head, GROUP.head, GROUP.head + GROUP.foot, GROUP.head + GROUP.foot]);
console.log("rule-groups.test.ts ok");
