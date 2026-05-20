const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getNewLinesCount, cleanRateLimitLine } = require("../lib/watcherEngine");

test("getNewLinesCount - no previous output returns total count", () => {
  assert.equal(getNewLinesCount("A\nB\nC", null), 3);
  assert.equal(getNewLinesCount("A\nB\nC", undefined), 3);
});

test("getNewLinesCount - identical outputs returns 0", () => {
  assert.equal(getNewLinesCount("A\nB\nC", "A\nB\nC"), 0);
});

test("getNewLinesCount - appended lines with overlap", () => {
  assert.equal(getNewLinesCount("A\nB\nC\nD\nE", "A\nB\nC"), 2);
});

test("getNewLinesCount - appended lines with overlap and scroll out", () => {
  assert.equal(getNewLinesCount("C\nD\nE\nF\nG", "A\nB\nC\nD\nE"), 2); // F and G are new
});

test("getNewLinesCount - completely different outputs", () => {
  assert.equal(getNewLinesCount("X\nY\nZ", "A\nB\nC"), 3);
});

test("cleanRateLimitLine - undefined/null inputs", () => {
  assert.equal(cleanRateLimitLine(null, 10, 5), null);
  assert.equal(cleanRateLimitLine("A\nB", 10, undefined), "A\nB");
});

test("cleanRateLimitLine - clears correct line", () => {
  // L3 is the rate limit line. absolute index = 3. total lines count = 5.
  // current output: L0, L1, L2, L3, L4
  const output = "L0\nL1\nL2\nL3\nL4";
  const expected = "L0\nL1\nL2\n\nL4";
  assert.equal(cleanRateLimitLine(output, 5, 3), expected);
});

test("cleanRateLimitLine - clears correct line after scrolling", () => {
  // L3 is the rate limit line. absolute index = 3. total lines count = 7 (L0..L6).
  // current output: L2, L3, L4, L5, L6
  const output = "L2\nL3\nL4\nL5\nL6";
  const expected = "L2\n\nL4\nL5\nL6";
  assert.equal(cleanRateLimitLine(output, 7, 3), expected);
});

test("cleanRateLimitLine - handles scrolled out line safely", () => {
  // L3 is the rate limit line. absolute index = 3. total lines count = 10 (L0..L9).
  // current output: L5, L6, L7, L8, L9 (L3 is scrolled out)
  const output = "L5\nL6\nL7\nL8\nL9";
  assert.equal(cleanRateLimitLine(output, 10, 3), output);
});
