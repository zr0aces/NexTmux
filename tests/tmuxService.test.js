const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSessionIdFromList } = require("../lib/tmuxService");

test("parseSessionIdFromList returns session_id for matching name", () => {
  const raw = "development|$1\nproduction|$2\nterm-3|$3\n";
  assert.equal(parseSessionIdFromList(raw, "term-3"), "$3");
});

test("parseSessionIdFromList returns null when name not found", () => {
  const raw = "development|$1\nproduction|$2\n";
  assert.equal(parseSessionIdFromList(raw, "term-3"), null);
});

test("parseSessionIdFromList returns null on empty input", () => {
  assert.equal(parseSessionIdFromList("", "term-1"), null);
  assert.equal(parseSessionIdFromList(null, "term-1"), null);
});

test("parseSessionIdFromList handles single session without trailing newline", () => {
  assert.equal(parseSessionIdFromList("term-1|$1", "term-1"), "$1");
});

test("parseSessionIdFromList returns null when session_id part missing", () => {
  assert.equal(parseSessionIdFromList("term-1|\n", "term-1"), null);
});
