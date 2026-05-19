const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { createSessionStateManager } = require("../lib/sessionStateManager");

function tmpPath() {
  return path.join(os.tmpdir(), `ssm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("setResetEpoch sets resetAtEpochMs on worker", () => {
  const mgr = createSessionStateManager({ stateFilePath: tmpPath() });
  const w = { sessionName: "term-1" };
  mgr.setResetEpoch(w, 9999999);
  assert.equal(w.resetAtEpochMs, 9999999);
});

test("clearResetEpoch nulls resetAtEpochMs on worker", () => {
  const mgr = createSessionStateManager({ stateFilePath: tmpPath() });
  const w = { sessionName: "term-1", resetAtEpochMs: 9999999 };
  mgr.clearResetEpoch(w);
  assert.equal(w.resetAtEpochMs, null);
});

test("getApiMeta includes resetAtEpochMs when set", () => {
  const mgr = createSessionStateManager({ stateFilePath: tmpPath() });
  const w = { sessionName: "term-1", resetAtEpochMs: 12345 };
  assert.equal(mgr.getApiMeta(w).resetAtEpochMs, 12345);
});

test("getApiMeta returns null for resetAtEpochMs when not set", () => {
  const mgr = createSessionStateManager({ stateFilePath: tmpPath() });
  const w = { sessionName: "term-1" };
  assert.equal(mgr.getApiMeta(w).resetAtEpochMs, null);
});

test("hydrateWorker restores resetAtEpochMs from persisted snapshot", async () => {
  const filePath = tmpPath();
  const mgr1 = createSessionStateManager({ stateFilePath: filePath });
  const w1 = { sessionName: "term-1" };
  mgr1.setResetEpoch(w1, 42000);
  await new Promise(r => setTimeout(r, 600)); // wait for the 500 ms flush timer

  const mgr2 = createSessionStateManager({ stateFilePath: filePath });
  const w2 = { sessionName: "term-1" };
  mgr2.hydrateWorker(w2);
  assert.equal(w2.resetAtEpochMs, 42000);
  try { fs.unlinkSync(filePath); } catch {}
});
