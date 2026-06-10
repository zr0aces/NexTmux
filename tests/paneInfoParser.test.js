const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseGlobalPaneInfo } = require("../lib/paneInfoParser");

// Format: session_name|||session_id|||cwd|||pane_cmd|||window_active|||pane_active|||session_attached

test("keeps only active-window active-pane entry per session", () => {
  const raw = [
    "term-1|||$1|||~/projects|||bash|||1|||0|||0",   // active window, inactive pane
    "term-1|||$1|||~/projects|||node|||1|||1|||0",   // active window, active pane ← keep
  ].join("\n");
  const result = parseGlobalPaneInfo(raw);
  assert.equal(result.get("$1").paneCmd, "node");
});

test("ignores panes in inactive windows", () => {
  const raw = [
    "term-1|||$1|||~/projects|||vim|||0|||1|||0",    // active pane but inactive window
    "term-1|||$1|||~/projects|||bash|||1|||1|||0",   // active window, active pane ← keep
  ].join("\n");
  const result = parseGlobalPaneInfo(raw);
  assert.equal(result.get("$1").paneCmd, "bash");
});

test("captures session_attached flag", () => {
  const raw = "term-1|||$1|||~/projects|||bash|||1|||1|||1\n";
  const result = parseGlobalPaneInfo(raw);
  assert.equal(result.get("$1").sessionAttached, "1");
  assert.equal(result.get("$1").sessionId, "$1");
});

test("handles multiple sessions independently", () => {
  const raw = [
    "term-1|||$1|||~/a|||claude|||1|||1|||0",
    "term-2|||$2|||~/b|||codex|||1|||1|||1",
  ].join("\n");
  const result = parseGlobalPaneInfo(raw);
  assert.equal(result.get("$1").paneCmd, "claude");
  assert.equal(result.get("$2").paneCmd, "codex");
  assert.equal(result.get("$2").sessionAttached, "1");
});

test("returns empty map for empty or null input", () => {
  assert.equal(parseGlobalPaneInfo("").size, 0);
  assert.equal(parseGlobalPaneInfo(null).size, 0);
});

test("skips lines with fewer than 7 fields", () => {
  const raw = "term-1|||$1|||~/projects|||bash|||1\n";  // only 5 fields
  assert.equal(parseGlobalPaneInfo(raw).size, 0);
});
