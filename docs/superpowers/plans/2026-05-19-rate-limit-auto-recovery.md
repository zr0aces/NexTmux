# Rate Limit Auto-Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse rate-limit reset times into concrete epoch timestamps, persist them, and automatically exit the `waiting` state (and send `"continue"` in Auto Mode) when the deadline passes.

**Architecture:** A new `parseResetEpoch(text, now)` function in `patternEngine.js` converts extracted reset-time strings to UTC ms. The epoch is stored as `resetAtEpochMs` on the worker and persisted via `sessionStateManager`. Each `pollOutput()` tick already runs every ~1 s per worker — a guard clause added before the watcher inspection checks `now >= w.resetAtEpochMs` and triggers recovery. No new timers. Survives server restarts because the epoch re-hydrates from `state/session-state.json`.

**Tech Stack:** Node.js ≥22 (`node:test` built-in, no extra deps), vanilla JS frontend.

---

## File Map

| File | Change |
|---|---|
| `lib/patternEngine.js` | Add `TIMEZONE_OFFSETS_MIN` constant + `parseResetEpoch(text, now)` function; export it |
| `lib/sessionStateManager.js` | Add `resetAtEpochMs` to `toMeta`/`hydrateWorker`/`getApiMeta`; add `setResetEpoch` and `clearResetEpoch` methods |
| `server.js` | Import `parseResetEpoch`; call it at detection time; add recovery guard in `pollOutput()` |
| `public/js/workers.js` | Update `updateMonitorMeta()` armed indicator |
| `tests/patternEngine.test.js` | **New** — unit tests for `parseResetEpoch` |
| `tests/sessionStateManager.test.js` | **New** — unit tests for new manager methods and persistence |
| `package.json` | Update `test` script to run `node --test` |

---

### Task 1: parseResetEpoch function in patternEngine.js

**Files:**
- Modify: `lib/patternEngine.js`
- Create: `tests/patternEngine.test.js`
- Modify: `package.json`

- [ ] **Step 1: Create `tests/patternEngine.test.js` with failing tests**

```javascript
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
```

- [ ] **Step 2: Run tests — verify they all fail**

```bash
node --test tests/patternEngine.test.js
```

Expected output (all fail): `TypeError: parseResetEpoch is not a function`

- [ ] **Step 3: Add `TIMEZONE_OFFSETS_MIN` and `parseResetEpoch` to `lib/patternEngine.js`**

Add this block immediately before the `module.exports` at the bottom of the file (after `extractResetTime`):

```javascript
const TIMEZONE_OFFSETS_MIN = {
  UTC: 0, GMT: 0,
  EST: -300, EDT: -240,
  CST: -360, CDT: -300,
  MST: -420, MDT: -360,
  PST: -480, PDT: -420,
};

function parseResetEpoch(text, now = Date.now()) {
  if (!text || typeof text !== "string") return null;
  const s = text.trim();

  // Relative: "2 hours", "3h 15m", "45 minutes", "1 day", "90s"
  const unitRe = /(\d+)\s*(d(?:ays?)?|h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi;
  let totalMs = 0;
  let rm;
  while ((rm = unitRe.exec(s)) !== null) {
    const val = parseInt(rm[1], 10);
    const unit = rm[2][0].toLowerCase();
    if (unit === "d") totalMs += val * 86400000;
    else if (unit === "h") totalMs += val * 3600000;
    else if (unit === "m") totalMs += val * 60000;
    else if (unit === "s") totalMs += val * 1000;
  }
  if (totalMs > 0) return now + totalMs;

  // Absolute: "11:00 AM PST", "15:30 UTC", "3:45 PM"
  const absRe = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?(?:\s+(UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|GMT[+-]\d+(?::\d+)?))?/i;
  const absMatch = absRe.exec(s);
  if (absMatch) {
    let h = parseInt(absMatch[1], 10);
    const min = parseInt(absMatch[2], 10);
    const ampm = (absMatch[4] || "").toUpperCase();
    const tzStr = (absMatch[5] || "").toUpperCase();

    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    if (h > 23 || min > 59) return null;

    let tzOffMin = 0;
    if (tzStr in TIMEZONE_OFFSETS_MIN) {
      tzOffMin = TIMEZONE_OFFSETS_MIN[tzStr];
    } else {
      const gmtMatch = /^GMT([+-])(\d+)(?::(\d+))?$/.exec(tzStr);
      if (gmtMatch) {
        tzOffMin = (gmtMatch[1] === "+" ? 1 : -1) *
          (parseInt(gmtMatch[2], 10) * 60 + parseInt(gmtMatch[3] || "0", 10));
      }
    }

    // Convert stated h:m (in tzStr timezone) to UTC:
    // UTC = local_time_treated_as_UTC - tzOffMin (because local = UTC + tzOffMin)
    const d = new Date(now);
    const todayAtHM = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min, 0, 0);
    const targetMs = todayAtHM - tzOffMin * 60000;
    return targetMs <= now ? targetMs + 86400000 : targetMs;
  }

  return null;
}
```

- [ ] **Step 4: Export `parseResetEpoch` from `lib/patternEngine.js`**

Replace the existing `module.exports` block:

```javascript
// Before:
module.exports = {
  DEFAULT_PATTERNS,
  createPatternEngine,
  extractResetTime,
};

// After:
module.exports = {
  DEFAULT_PATTERNS,
  createPatternEngine,
  extractResetTime,
  parseResetEpoch,
};
```

- [ ] **Step 5: Run tests — verify all 11 pass**

```bash
node --test tests/patternEngine.test.js
```

Expected:
```
ok 1 - parseResetEpoch - null/empty returns null
ok 2 - parseResetEpoch - relative hours
ok 3 - parseResetEpoch - relative minutes
ok 4 - parseResetEpoch - relative days
ok 5 - parseResetEpoch - relative seconds
ok 6 - parseResetEpoch - relative compound
ok 7 - parseResetEpoch - relative zero returns null
ok 8 - parseResetEpoch - absolute UTC future
ok 9 - parseResetEpoch - absolute UTC past wraps to next day
ok 10 - parseResetEpoch - absolute AM/PM with PST timezone
ok 11 - parseResetEpoch - unparseable returns null
```

- [ ] **Step 6: Update `package.json` test script**

Replace `"test": "echo \"Error: no test specified\" && exit 1"` with:

```json
"test": "node --test tests/*.test.js"
```

- [ ] **Step 7: Commit**

```bash
git add lib/patternEngine.js tests/patternEngine.test.js package.json
git commit -m "feat: add parseResetEpoch for rate-limit deadline parsing"
```

---

### Task 2: resetAtEpochMs field and methods in sessionStateManager.js

**Files:**
- Modify: `lib/sessionStateManager.js`
- Create: `tests/sessionStateManager.test.js`

- [ ] **Step 1: Create `tests/sessionStateManager.test.js` with failing tests**

```javascript
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
```

- [ ] **Step 2: Run tests — verify they all fail**

```bash
node --test tests/sessionStateManager.test.js
```

Expected: `TypeError: mgr.setResetEpoch is not a function`

- [ ] **Step 3: Add `resetAtEpochMs` to `toMeta()` in `lib/sessionStateManager.js`**

Find the `toMeta` function. After the `tokenResetAt` line, add `resetAtEpochMs`:

```javascript
// Before:
    tokenResetAt: worker.tokenResetAt || null,
    aiMonitorEnabled: worker.aiMonitorEnabled !== false,

// After:
    tokenResetAt: worker.tokenResetAt || null,
    resetAtEpochMs: worker.resetAtEpochMs != null ? worker.resetAtEpochMs : null,
    aiMonitorEnabled: worker.aiMonitorEnabled !== false,
```

- [ ] **Step 4: Add `resetAtEpochMs` restore to `hydrateWorker()` in `lib/sessionStateManager.js`**

Find line 93 (`worker.tokenResetAt = worker.tokenResetAt || fromDisk.tokenResetAt || null;`). Add immediately after it:

```javascript
    worker.tokenResetAt = worker.tokenResetAt || fromDisk.tokenResetAt || null;
    worker.resetAtEpochMs = worker.resetAtEpochMs != null ? worker.resetAtEpochMs : (fromDisk.resetAtEpochMs ?? null);
```

- [ ] **Step 5: Add `setResetEpoch` and `clearResetEpoch` functions inside `createSessionStateManager`**

Add these two functions just before the `loadSnapshot()` call at the bottom of `createSessionStateManager` (but still inside the outer function body):

```javascript
  function setResetEpoch(worker, epochMs) {
    if (!worker) return;
    worker.resetAtEpochMs = epochMs;
    persistWorker(worker);
  }

  function clearResetEpoch(worker) {
    if (!worker) return;
    worker.resetAtEpochMs = null;
    persistWorker(worker);
  }
```

- [ ] **Step 6: Export both new methods from `createSessionStateManager`'s return statement**

```javascript
// Before:
  return {
    hydrateWorker,
    setWaitingState,
    updateActivity,
    updateMatch,
    shouldNotify,
    markNotification,
    getApiMeta,
    removeSession,
    toggleAiMonitor,
    toggleAutoMode,
    setMonitorMode,
    getMonitorMode,
  };

// After:
  return {
    hydrateWorker,
    setWaitingState,
    updateActivity,
    updateMatch,
    shouldNotify,
    markNotification,
    getApiMeta,
    removeSession,
    toggleAiMonitor,
    toggleAutoMode,
    setMonitorMode,
    getMonitorMode,
    setResetEpoch,
    clearResetEpoch,
  };
```

- [ ] **Step 7: Run tests — verify all 5 pass**

```bash
node --test tests/sessionStateManager.test.js
```

Expected:
```
ok 1 - setResetEpoch sets resetAtEpochMs on worker
ok 2 - clearResetEpoch nulls resetAtEpochMs on worker
ok 3 - getApiMeta includes resetAtEpochMs when set
ok 4 - getApiMeta returns null for resetAtEpochMs when not set
ok 5 - hydrateWorker restores resetAtEpochMs from persisted snapshot
```

- [ ] **Step 8: Run full test suite**

```bash
npm test
```

Expected: all 16 tests across both files pass.

- [ ] **Step 9: Commit**

```bash
git add lib/sessionStateManager.js tests/sessionStateManager.test.js
git commit -m "feat: add resetAtEpochMs persistence and setResetEpoch/clearResetEpoch to sessionStateManager"
```

---

### Task 3: Detection wiring and recovery guard in server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add `parseResetEpoch` to the patternEngine import on line 9**

```javascript
// Before:
const { DEFAULT_PATTERNS, createPatternEngine, extractResetTime } = require("./lib/patternEngine");

// After:
const { DEFAULT_PATTERNS, createPatternEngine, extractResetTime, parseResetEpoch } = require("./lib/patternEngine");
```

- [ ] **Step 2: Call `parseResetEpoch` at detection time in `pollOutput()` (around line 539–542)**

```javascript
// Before:
    if (maybeRateLimitContext) {
      const resetTime = extractResetTime(inspect.detection.excerpt);
      if (resetTime) w.tokenResetAt = resetTime;
    }

// After:
    if (maybeRateLimitContext) {
      const resetTime = extractResetTime(inspect.detection.excerpt);
      if (resetTime) {
        w.tokenResetAt = resetTime;
        const epoch = parseResetEpoch(resetTime, now);
        if (epoch) sessionStateManager.setResetEpoch(w, epoch);
      }
    }
```

- [ ] **Step 3: Add recovery guard clause in `pollOutput()` between lines 510 and 511**

Insert the guard between `const now = Date.now();` and `const inspect = ...`:

```javascript
// Before:
  const now = Date.now();
  const inspect = w.aiMonitorEnabled && monitorConfig.enabled

// After:
  const now = Date.now();

  if (w.aiState === "waiting" && w.resetAtEpochMs && now >= w.resetAtEpochMs) {
    sessionStateManager.clearResetEpoch(w);
    w.tokenResetAt = null;
    w.aiState = "running";
    sessionStateManager.setWaitingState(w, "running");
    broadcast({ type: "aiState", id, state: "running" });
    broadcastMonitorMeta(id);
    if (w.autoMode) sendInput(id, "continue");
    return;
  }

  const inspect = w.aiMonitorEnabled && monitorConfig.enabled
```

- [ ] **Step 4: Verify server starts cleanly**

```bash
node server.js &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081
kill %1
```

Expected: `200` (or `401` if password is required — either means the server started).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: wire parseResetEpoch at detection and add recovery guard in pollOutput"
```

---

### Task 4: Armed indicator in workers.js frontend

**Files:**
- Modify: `public/js/workers.js`

- [ ] **Step 1: Update the reset display block in `updateMonitorMeta()`**

```javascript
// Before:
  document.querySelectorAll('#meta-reset-' + id).forEach(el => {
    if (meta.tokenResetAt) {
      el.textContent = '⏱ Reset in: ' + meta.tokenResetAt;
      el.style.display = '';
      el.style.color = '#d29922';
    } else {
      el.style.display = 'none';
    }
  });

// After:
  document.querySelectorAll('#meta-reset-' + id).forEach(el => {
    if (meta.tokenResetAt) {
      const armed = meta.resetAtEpochMs != null;
      el.textContent = '⏱ Reset in: ' + meta.tokenResetAt + (armed ? '  [armed]' : '');
      el.style.display = '';
      el.style.color = armed ? '#58a6ff' : '#d29922';
    } else {
      el.style.display = 'none';
    }
  });
```

- [ ] **Step 2: Commit**

```bash
git add public/js/workers.js
git commit -m "feat: show [armed] badge on reset display when auto-recovery is scheduled"
```

---

## Self-Review

**Spec coverage:**
- Section 1 (`parseResetEpoch`): ✅ Task 1 — relative + absolute parsing, null for unparseable
- Section 2 (`resetAtEpochMs` field): ✅ Task 2 — `toMeta`, `hydrateWorker`, `getApiMeta`, `setResetEpoch`, `clearResetEpoch`
- Section 3 (recovery guard + detection): ✅ Task 3 — epoch set at detection, guard fires recovery, `"continue"` sent only when `autoMode`
- Section 4 (armed indicator): ✅ Task 4 — `[armed]` badge + blue-grey colour
- Server restart behaviour: ✅ `hydrateWorker` restores epoch; guard fires on first tick if epoch is past

**Type consistency:**
- `setResetEpoch(worker, epochMs)` — same signature across Task 2 definition and Task 3 call site ✅
- `clearResetEpoch(worker)` — consistent ✅
- `resetAtEpochMs` — consistent spelling in all files ✅
- `parseResetEpoch(text, now)` — consistent signature ✅
