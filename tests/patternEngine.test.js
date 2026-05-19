const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseResetEpoch } = require("../lib/patternEngine");

// Fixed reference: 2025-05-19 18:00:00 UTC (evening, so "15:30 UTC" is already past)
const NOW = Date.UTC(2025, 4, 19, 18, 0, 0, 0);

test("parseResetEpoch - null/empty returns null", () => {
  assert.equal(parseResetEpoch(null, NOW), null);
  assert.equal(parseResetEpoch("", NOW), null);
  assert.equal(parseResetEpoch("   ", NOW), null);
});

test("parseResetEpoch - relative hours", () => {
  assert.equal(parseResetEpoch("2 hours", NOW), NOW + 2 * 3600000);
  assert.equal(parseResetEpoch("2h", NOW), NOW + 2 * 3600000);
  assert.equal(parseResetEpoch("1 hour", NOW), NOW + 3600000);
});

test("parseResetEpoch - relative minutes", () => {
  assert.equal(parseResetEpoch("45 minutes", NOW), NOW + 45 * 60000);
  assert.equal(parseResetEpoch("45m", NOW), NOW + 45 * 60000);
});

test("parseResetEpoch - relative days", () => {
  assert.equal(parseResetEpoch("1 day", NOW), NOW + 86400000);
  assert.equal(parseResetEpoch("2d", NOW), NOW + 2 * 86400000);
});

test("parseResetEpoch - relative seconds", () => {
  assert.equal(parseResetEpoch("90s", NOW), NOW + 90000);
  assert.equal(parseResetEpoch("90 seconds", NOW), NOW + 90000);
});

test("parseResetEpoch - relative compound", () => {
  assert.equal(parseResetEpoch("3h 15m", NOW), NOW + (3 * 3600 + 15 * 60) * 1000);
  assert.equal(parseResetEpoch("1 day 2 hours", NOW), NOW + (86400 + 7200) * 1000);
});

test("parseResetEpoch - relative zero returns null", () => {
  assert.equal(parseResetEpoch("0 hours", NOW), null);
});

test("parseResetEpoch - absolute UTC future (23:30 is after 18:00 NOW)", () => {
  const d = new Date(NOW);
  const expected = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 30, 0, 0);
  assert.equal(parseResetEpoch("23:30 UTC", NOW), expected);
});

test("parseResetEpoch - absolute UTC past wraps to next day (15:30 before 18:00 NOW)", () => {
  const d = new Date(NOW);
  const todayAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 30, 0, 0);
  assert.equal(parseResetEpoch("15:30 UTC", NOW), todayAt + 86400000);
});

test("parseResetEpoch - absolute AM/PM with PST timezone (UTC-8)", () => {
  // "11:00 AM PST" = 19:00 UTC; NOW is 18:00 UTC → same day
  const d = new Date(NOW);
  const todayAt11UTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11, 0, 0, 0);
  const expected = todayAt11UTC - (-480) * 60000; // subtract PST offset (-480 min) → +8 h → 19:00 UTC
  assert.equal(parseResetEpoch("11:00 AM PST", NOW), expected);
});

test("parseResetEpoch - unparseable returns null", () => {
  assert.equal(parseResetEpoch("soon", NOW), null);
  assert.equal(parseResetEpoch("unknown time", NOW), null);
});
