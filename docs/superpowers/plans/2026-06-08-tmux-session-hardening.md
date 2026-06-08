# TmuxHub Session Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 session bugs — unconditional tab hijacking, globalPaneInfo multi-pane data loss, missing tmux `$session_id` on workers, and absent `session_attached` tracking.

**Architecture:** Seven independent tasks. Server tasks (1–5) add stable session identity and fix data collection. Frontend tasks (6–7) fix tab selection and add the attached indicator. All pure logic is extracted into testable lib modules. The existing `node:test` suite is extended; no new test framework is needed.

**Tech Stack:** Node.js, node:test (built-in), tmux, vanilla JS

**Test command:** `node --test tests/*.test.js`

**Spec:** `docs/superpowers/specs/2026-06-08-tmux-session-hardening-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/tmuxService.js` | Modify | Add `parseSessionIdFromList` (pure, testable) + `resolveSessionId` (calls tmux) |
| `lib/paneInfoParser.js` | **Create** | Pure `parseGlobalPaneInfo(raw)` extracted from server.js for testability |
| `lib/sessionStateManager.js` | Modify | Add `getKey(worker)` helper; update `persistWorker`, `hydrateWorker`, `removeSession` |
| `server.js` | Modify | Import new modules; store `tmuxSessionId` at spawn/attach/recovery; fix `updateGlobalPaneInfo`; broadcast `sessionAttached`; update `removeSession` callers; add `fromRecovery` flag |
| `public/js/workers.js` | Modify | Conditional `selectTab` in `ensureCard`; new `updateSessionAttached` function |
| `public/js/ws.js` | Modify | `handleMsg` spawned case; `loadAll` restores saved tab; handle `sessionAttached` message |
| `public/js/layout.js` | Modify | `selectTab` persists to localStorage |
| `public/index.html` | Modify | CSS for `.tmux-attached` |
| `tests/tmuxService.test.js` | **Create** | Tests for `parseSessionIdFromList` |
| `tests/sessionStateManager.test.js` | Modify | Add tests for stable-key behaviour and new `removeSession(worker)` signature |
| `tests/paneInfoParser.test.js` | **Create** | Tests for `parseGlobalPaneInfo` |

---

## Task 1: Add `resolveSessionId` to `lib/tmuxService.js`

**Files:**
- Modify: `lib/tmuxService.js`
- Create: `tests/tmuxService.test.js`

**Why:** `resolveSessionId(sessionName)` converts a mutable session name (`"term-1"`) into the stable tmux session ID (`"$1"`). The parsing logic is split into `parseSessionIdFromList` so it can be unit-tested without spawning tmux.

- [ ] **Step 1: Write the failing test**

Create `tests/tmuxService.test.js`:

```js
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
```

- [ ] **Step 2: Run — verify it fails**

```bash
node --test tests/tmuxService.test.js
```

Expected: `TypeError: parseSessionIdFromList is not a function`

- [ ] **Step 3: Implement in `lib/tmuxService.js`**

Add both functions before `module.exports`. Replace the current `module.exports` line with:

```js
function parseSessionIdFromList(raw, sessionName) {
  if (!raw || !sessionName) return null;
  for (const line of String(raw).split("\n")) {
    if (!line.trim()) continue;
    const pipe = line.indexOf("|");
    if (pipe === -1) continue;
    const name = line.slice(0, pipe);
    const id = line.slice(pipe + 1).trim();
    if (name === sessionName && id) return id;
  }
  return null;
}

function resolveSessionId(sessionName) {
  try {
    const raw = tmuxExec("list-sessions", "-F", "#{session_name}|#{session_id}");
    return parseSessionIdFromList(raw, sessionName);
  } catch {
    return null;
  }
}

module.exports = { sanitizeSessionName, tmuxExec, tmuxExecAsync, isAlive, resolveSessionId, parseSessionIdFromList };
```

- [ ] **Step 4: Run — verify all 5 pass**

```bash
node --test tests/tmuxService.test.js
```

Expected: `✔ parseSessionIdFromList returns session_id for matching name` × 5

- [ ] **Step 5: Commit**

```bash
git add lib/tmuxService.js tests/tmuxService.test.js
git commit -m "feat: add resolveSessionId and parseSessionIdFromList to tmuxService"
```

---

## Task 2: Stable key in `sessionStateManager` + update `removeSession` signature

**Files:**
- Modify: `lib/sessionStateManager.js`
- Modify: `tests/sessionStateManager.test.js`

**Why:** State is currently keyed by `sessionName` (mutable). Adding `getKey(worker)` to prefer `tmuxSessionId` makes state survive session renames. `removeSession` changes from `(sessionName)` to `(worker)` so it can clear the right key.

- [ ] **Step 1: Write failing tests — append to `tests/sessionStateManager.test.js`**

Add these tests at the bottom of the existing file:

```js
test("hydrateWorker uses tmuxSessionId key when available", async () => {
  const filePath = path.join(os.tmpdir(), `ssm-stable-${Date.now()}.json`);
  const mgr1 = createSessionStateManager({ stateFilePath: filePath });
  const w1 = { sessionName: "term-1", tmuxSessionId: "$1" };
  mgr1.setWaitingState(w1, "waiting");
  await new Promise(r => setTimeout(r, 600));

  const mgr2 = createSessionStateManager({ stateFilePath: filePath });
  // Same tmuxSessionId but different sessionName (simulates rename)
  const w2 = { sessionName: "term-1-renamed", tmuxSessionId: "$1" };
  mgr2.hydrateWorker(w2);
  assert.equal(w2.waitingState, "waiting");
  try { fs.unlinkSync(filePath); } catch {}
});

test("hydrateWorker falls back to sessionName when tmuxSessionId is null", async () => {
  const filePath = path.join(os.tmpdir(), `ssm-fallback-${Date.now()}.json`);
  const mgr1 = createSessionStateManager({ stateFilePath: filePath });
  const w1 = { sessionName: "term-2", tmuxSessionId: null };
  mgr1.setWaitingState(w1, "idle");
  await new Promise(r => setTimeout(r, 600));

  const mgr2 = createSessionStateManager({ stateFilePath: filePath });
  const w2 = { sessionName: "term-2", tmuxSessionId: null };
  mgr2.hydrateWorker(w2);
  assert.equal(w2.waitingState, "idle");
  try { fs.unlinkSync(filePath); } catch {}
});

test("removeSession(worker) clears entry by tmuxSessionId key", () => {
  const mgr = createSessionStateManager({ stateFilePath: path.join(os.tmpdir(), `ssm-rm-${Date.now()}.json`) });
  const w = { sessionName: "term-3", tmuxSessionId: "$3" };
  mgr.setWaitingState(w, "waiting");
  mgr.removeSession(w);
  const w2 = { sessionName: "term-3", tmuxSessionId: "$3" };
  mgr.hydrateWorker(w2);
  // After removal, hydrateWorker finds nothing → default "running"
  assert.equal(w2.waitingState, "running");
});
```

Note: the existing tests use `path`, `os`, `fs` from `node:*` — those are already imported at the top of the file; the new tests reuse them.

- [ ] **Step 2: Run — verify the 3 new tests fail**

```bash
node --test tests/sessionStateManager.test.js
```

Expected: first two new tests fail (hydration still uses `sessionName` key), third fails (wrong signature).

- [ ] **Step 3: Implement `getKey` in `lib/sessionStateManager.js`**

Inside `createSessionStateManager`, add `getKey` after the existing `ensureNotificationSet` helper:

```js
function getKey(worker) {
  return (worker && worker.tmuxSessionId) ? worker.tmuxSessionId : (worker && worker.sessionName) || null;
}
```

- [ ] **Step 4: Update `persistWorker`**

Find:
```js
function persistWorker(worker) {
  if (!worker || !worker.sessionName) return;
  snapshot.set(worker.sessionName, toMeta(worker));
  flushSnapshotSoon();
}
```

Replace with:
```js
function persistWorker(worker) {
  if (!worker || !getKey(worker)) return;
  snapshot.set(getKey(worker), toMeta(worker));
  flushSnapshotSoon();
}
```

- [ ] **Step 5: Update `hydrateWorker` to try stable key first**

Find the first line of `hydrateWorker` body:
```js
const fromDisk = snapshot.get(worker.sessionName) || {};
```

Replace with:
```js
const fromDisk = snapshot.get(getKey(worker)) || snapshot.get(worker.sessionName) || {};
```

- [ ] **Step 6: Update `removeSession` to accept worker object**

Find:
```js
function removeSession(sessionName) {
  if (!sessionName) return;
  snapshot.delete(sessionName);
  lastNotifyBySession.delete(String(sessionName));
  flushSnapshotSoon();
}
```

Replace with:
```js
function removeSession(worker) {
  if (!worker) return;
  const key = getKey(worker);
  if (key) snapshot.delete(key);
  // Also clear old sessionName key (backward-compat: removes entries written before this change)
  if (worker.sessionName && worker.sessionName !== key) snapshot.delete(worker.sessionName);
  lastNotifyBySession.delete(String(worker.sessionName || "unknown"));
  flushSnapshotSoon();
}
```

- [ ] **Step 7: Run — verify all tests pass**

```bash
node --test tests/sessionStateManager.test.js
```

Expected: all previous tests + 3 new tests pass (10 total)

- [ ] **Step 8: Update `removeSession` callers in `server.js`**

There are exactly 2 callers. Find and replace each:

Caller 1 — `/api/remove` handler:
```js
// Before:
sessionStateManager.removeSession(w.sessionName);
// After:
sessionStateManager.removeSession(w);
```

Caller 2 — `/api/reset` handler:
```js
// Before:
sessionStateManager.removeSession(w.sessionName);
// After:
sessionStateManager.removeSession(w);
```

- [ ] **Step 9: Run full test suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 10: Commit**

```bash
git add lib/sessionStateManager.js tests/sessionStateManager.test.js server.js
git commit -m "feat: key sessionStateManager by tmuxSessionId with sessionName fallback"
```

---

## Task 3: Store `tmuxSessionId` at spawn, attach, and recovery

**Files:**
- Modify: `server.js`

**Why:** Workers need `tmuxSessionId` populated immediately so Tasks 1–2 take effect. Three entry points create workers: new spawn, scan/attach, and server-restart recovery.

- [ ] **Step 1: Add `resolveSessionId` to the import from `lib/tmuxService`**

Find:
```js
const { sanitizeSessionName, tmuxExec, tmuxExecAsync, isAlive } = require("./lib/tmuxService");
```

Replace with:
```js
const { sanitizeSessionName, tmuxExec, tmuxExecAsync, isAlive, resolveSessionId } = require("./lib/tmuxService");
```

- [ ] **Step 2: Update `spawnWorker` — add `tmuxSessionId` and `sessionAttached`**

Inside `spawnWorker`, after the two `tmuxExec` calls (`new-session` and `send-keys`), add the resolve call. Then add the two new fields to `workers.set`:

```js
const tmuxSessionId = resolveSessionId(sessionName);
workers.set(id, {
  sessionName,
  cwd,
  cmd,
  cliType,
  logs,
  status: "running",
  expectedCmd: getBaseCommand(cmd),
  seenExpectedCmd: false,
  exitReason: null,
  lastPaneCommand: null,
  lastAction: null,
  tmuxSessionId,
  sessionAttached: 0,
});
```

- [ ] **Step 3: Update `/api/attach` handler — add `tmuxSessionId` and `sessionAttached`**

Inside the `/api/attach` handler, after `sanitizeSessionName` succeeds and the duplicate-worker guard passes, add the resolve call. Then add the two new fields to `workers.set`:

```js
const tmuxSessionId = resolveSessionId(sessionName);
workers.set(id, {
  sessionName,
  cwd,
  logs: [],
  status: "running",
  exitReason: null,
  expectedCmd: "",
  seenExpectedCmd: false,
  lastPaneCommand: null,
  lastAction: null,
  tmuxSessionId,
  sessionAttached: 0,
});
```

- [ ] **Step 4: Update `recoverSessions` — extend format string and parse `session_id`**

Find the `tmuxExec("ls", ...)` call inside `recoverSessions`:
```js
const raw = tmuxExec("ls", "-F", "#{session_name}|#{pane_current_path}|#{pane_current_command}");
```

Replace with:
```js
const raw = tmuxExec("ls", "-F", "#{session_name}|#{pane_current_path}|#{pane_current_command}|#{session_id}");
```

In the parsing loop, find where `parts` is split. After the existing `parts` extraction, add `tmuxSessionId`:

```js
const sessionName = parts[0];
const cwd = parts[1] || "unknown";
const cmd = parts[2] || "unknown";
const tmuxSessionId = parts[3] ? parts[3].trim() : null;
```

Add `tmuxSessionId` and `sessionAttached` to the recovered worker object inside `workers.set`:

```js
workers.set(id, {
  sessionName,
  cwd,
  cmd,
  logs: [],
  status: "running",
  expectedCmd: getBaseCommand(cmd),
  seenExpectedCmd: false,
  exitReason: null,
  lastPaneCommand: null,
  lastAction: null,
  tmuxSessionId,
  sessionAttached: 0,
});
```

- [ ] **Step 5: Add `fromRecovery: true` to recovery broadcasts**

Find the `broadcast` call inside the `recovered.forEach` loop at the bottom of `recoverSessions`:

```js
broadcast({ type: "spawned", id, cwd: w.cwd, cmd: w.cmd, status: "running", sessionName: w.sessionName, ...getMonitorMeta(w) });
```

Replace with:

```js
broadcast({ type: "spawned", id, fromRecovery: true, cwd: w.cwd, cmd: w.cmd, status: "running", sessionName: w.sessionName, ...getMonitorMeta(w) });
```

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all tests pass (no test covers tmux subprocess calls — that is expected)

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: store tmuxSessionId at spawn/attach/recovery; flag recovery broadcasts"
```

---

## Task 4: Extract `parseGlobalPaneInfo` and fix multi-pane tracking

**Files:**
- Create: `lib/paneInfoParser.js`
- Create: `tests/paneInfoParser.test.js`
- Modify: `server.js`

**Why:** `updateGlobalPaneInfo` calls `list-panes -a` and stores the last pane seen per session. Sessions with multiple windows or panes get the wrong `paneCmd`, breaking AI exit detection. Extracting the parse logic makes it testable. The fix: only store the entry where `window_active == 1` AND `pane_active == 1`.

- [ ] **Step 1: Write the failing test**

Create `tests/paneInfoParser.test.js`:

```js
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
  assert.equal(result.get("term-1").paneCmd, "node");
});

test("ignores panes in inactive windows", () => {
  const raw = [
    "term-1|||$1|||~/projects|||vim|||0|||1|||0",    // active pane but inactive window
    "term-1|||$1|||~/projects|||bash|||1|||1|||0",   // active window, active pane ← keep
  ].join("\n");
  const result = parseGlobalPaneInfo(raw);
  assert.equal(result.get("term-1").paneCmd, "bash");
});

test("captures session_attached flag", () => {
  const raw = "term-1|||$1|||~/projects|||bash|||1|||1|||1\n";
  const result = parseGlobalPaneInfo(raw);
  assert.equal(result.get("term-1").sessionAttached, "1");
  assert.equal(result.get("term-1").sessionId, "$1");
});

test("handles multiple sessions independently", () => {
  const raw = [
    "term-1|||$1|||~/a|||claude|||1|||1|||0",
    "term-2|||$2|||~/b|||codex|||1|||1|||1",
  ].join("\n");
  const result = parseGlobalPaneInfo(raw);
  assert.equal(result.get("term-1").paneCmd, "claude");
  assert.equal(result.get("term-2").paneCmd, "codex");
  assert.equal(result.get("term-2").sessionAttached, "1");
});

test("returns empty map for empty or null input", () => {
  assert.equal(parseGlobalPaneInfo("").size, 0);
  assert.equal(parseGlobalPaneInfo(null).size, 0);
});

test("skips lines with fewer than 7 fields", () => {
  const raw = "term-1|||$1|||~/projects|||bash|||1\n";  // only 5 fields
  assert.equal(parseGlobalPaneInfo(raw).size, 0);
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
node --test tests/paneInfoParser.test.js
```

Expected: `Error: Cannot find module '../lib/paneInfoParser'`

- [ ] **Step 3: Create `lib/paneInfoParser.js`**

```js
"use strict";

function parseGlobalPaneInfo(raw) {
  const nextInfo = new Map();
  if (!raw) return nextInfo;
  for (const line of String(raw).trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("|||");
    if (parts.length < 7) continue;
    const sessionName  = parts[0];
    const sessionId    = parts[1];
    const cwd          = parts[2] || "";
    const paneCmd      = parts[3] || "";
    const windowActive = parts[4];
    const paneActive   = parts[5];
    const sessionAttached = parts[6];
    if (windowActive !== "1" || paneActive !== "1") continue;
    nextInfo.set(sessionName, { cwd, paneCmd, sessionId, sessionAttached });
  }
  return nextInfo;
}

module.exports = { parseGlobalPaneInfo };
```

- [ ] **Step 4: Run — verify all 6 pass**

```bash
node --test tests/paneInfoParser.test.js
```

Expected: 6 passing tests

- [ ] **Step 5: Update `server.js` — import `parseGlobalPaneInfo` and fix `updateGlobalPaneInfo`**

Add import near the top of `server.js` with the other `lib/` requires:

```js
const { parseGlobalPaneInfo } = require("./lib/paneInfoParser");
```

Find the `updateGlobalPaneInfo` function. Replace its entire body with:

```js
async function updateGlobalPaneInfo() {
  const now = Date.now();
  if (now - lastGlobalPaneFetch < GLOBAL_PANE_FETCH_INTERVAL) return;
  lastGlobalPaneFetch = now;
  try {
    const raw = await tmuxExecAsync(
      "list-panes", "-a", "-F",
      "#{session_name}|||#{session_id}|||#{pane_current_path}|||#{pane_current_command}|||#{window_active}|||#{pane_active}|||#{session_attached}"
    );
    globalPaneInfo = parseGlobalPaneInfo(raw);
  } catch (e) {
    // Silent fail, will retry next interval
  }
}
```

Also update the `globalPaneInfo` variable declaration comment at the top of the file:

```js
let globalPaneInfo = new Map(); // sessionName -> { cwd, paneCmd, sessionId, sessionAttached }
```

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add lib/paneInfoParser.js tests/paneInfoParser.test.js server.js
git commit -m "feat: extract parseGlobalPaneInfo; fix multi-pane tracking to active pane only"
```

---

## Task 5: Broadcast `sessionAttached` changes from `pollOutput`

**Files:**
- Modify: `server.js`

**Why:** The `sessionAttached` field collected in Task 4 needs to reach the client. `pollOutput` detects changes per worker and broadcasts a `sessionAttached` message. `/api/workers` includes the initial value so page load reflects current state without waiting for the first poll cycle.

- [ ] **Step 1: Add `sessionAttached` change detection inside `pollOutput`**

Inside `pollOutput(id)`, find the block that reads `cachedInfo` and updates `currentCwd`/`currentPaneCmd`. It ends after the `if (currentPaneCmd) { ... }` block. Immediately after that block, add:

```js
// Detect and broadcast sessionAttached state changes
const nowAttached = cachedInfo?.sessionAttached === "1" ? 1 : 0;
if (nowAttached !== (w.sessionAttached || 0)) {
  w.sessionAttached = nowAttached;
  broadcast({ type: "sessionAttached", id, attached: nowAttached === 1 });
}
```

- [ ] **Step 2: Add `sessionAttached` to `/api/workers` response**

Find the `.map()` inside the `/api/workers` GET handler. Add `sessionAttached` field:

```js
const list = [...workers.entries()].map(([id, w]) => ({
  id,
  cwd: w.cwd,
  cmd: w.cmd || "claude",
  status: (w.status === "completed" || w.status === "stopped") ? w.status : (isAlive(w.sessionName) ? "running" : (w.status || "stopped")),
  sessionName: w.sessionName,
  logs: w.logs,
  aiState: w.aiState || null,
  exitReason: w.exitReason || null,
  sessionAttached: w.sessionAttached || 0,
  ...getMonitorMeta(w),
}));
```

- [ ] **Step 3: Smoke-test the server**

```bash
npm start &
SERVER_PID=$!
sleep 2
# Login to get cookie
curl -s -c /tmp/th-cookies.txt \
  -X POST http://localhost:8081/api/login \
  -H 'Content-Type: application/json' \
  -d '{"pw":"changeme"}' | grep '"ok":true'
# Check workers response includes sessionAttached
curl -s -b /tmp/th-cookies.txt http://localhost:8081/api/workers
kill $SERVER_PID
```

Expected: login returns `{"ok":true}`, workers array entries have `"sessionAttached":0`

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: broadcast sessionAttached changes from pollOutput; include in /api/workers"
```

---

## Task 6: Frontend — fix tab selection hijack + add `updateSessionAttached`

**Files:**
- Modify: `public/js/workers.js`
- Modify: `public/js/ws.js`
- Modify: `public/js/layout.js`

**Why:** `ensureCard` calls `selectTab(id)` unconditionally — every new/recovered card hijacks the active tab. The fix: only auto-select the very first card. User-initiated spawns still switch; recovery spawns do not. The previously active tab is restored from localStorage after load.

`updateSessionAttached` is added here (not Task 7) because `loadAll` calls it at the end of this task.

- [ ] **Step 1: Add `updateSessionAttached` to `public/js/workers.js`**

Add this function after the `updateAIState` function:

```js
function updateSessionAttached(id, attached) {
  const dot = document.getElementById('tab-dot-' + id);
  if (dot) dot.classList.toggle('tmux-attached', Boolean(attached));
  const badge = document.getElementById('badge-' + id);
  if (badge) badge.classList.toggle('tmux-attached', Boolean(attached));
}
```

- [ ] **Step 2: Fix `ensureCard` in `public/js/workers.js`**

Find the unconditional `selectTab(id);` call near the bottom of `ensureCard` (immediately before the `if (status === 'stopped' || status === 'completed')` block). Replace:

```js
selectTab(id);
```

With:

```js
if (activeTab === null) selectTab(id);
```

- [ ] **Step 3: Update `handleMsg` spawned case in `public/js/ws.js`**

Find:
```js
if (d.type === 'spawned') ensureCard(d.id, d.cwd, d.status, [], d.cmd, d.reason || null, d);
```

Replace with:
```js
if (d.type === 'spawned') {
  ensureCard(d.id, d.cwd, d.status, [], d.cmd, d.reason || null, d);
  if (!d.fromRecovery) selectTab(d.id);
}
```

- [ ] **Step 4: Persist active tab in `selectTab` inside `public/js/layout.js`**

Find the `selectTab` function. After `activeTab = id;`, add the localStorage write:

```js
function selectTab(id) {
  activeTab = id;
  localStorage.setItem('tmuxhub.activeTab.v1', id);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.id === id));
  setTimeout(sendResize, 0);
}
```

- [ ] **Step 5: Restore saved tab + call `updateSessionAttached` in `loadAll` inside `public/js/ws.js`**

Find the `loadAll` function. Replace it entirely with:

```js
function loadAll() {
  apiGet('/api/workers')
    .then(list => {
      list.forEach(w => {
        ensureCard(w.id, w.cwd, w.status, w.logs, w.cmd, w.exitReason || null, w);
        if (w.aiState) updateAIState(w.id, w.aiState);
        updateMonitorMeta(w.id, w);
        updateSessionAttached(w.id, w.sessionAttached === 1);
      });
      if (typeof restoreTabOrder === 'function') {
        restoreTabOrder();
      }
      const savedTab = localStorage.getItem('tmuxhub.activeTab.v1');
      if (savedTab && document.querySelector('.tab[data-id="' + savedTab + '"]')) {
        selectTab(savedTab);
      }
    });
}
```

- [ ] **Step 6: Manual verification**

Start the server with at least 2 TmuxHub sessions (`term-1`, `term-2`). Then:

1. Open the dashboard. First session tab should be selected (not last).
2. Click session 2 tab. Refresh the page. Session 2 tab should still be selected.
3. Kill the server process and restart it. Reload the page. Session 2 tab still selected.
4. Spawn a new session from the dashboard toolbar. The new session tab should be auto-selected.

- [ ] **Step 7: Commit**

```bash
git add public/js/workers.js public/js/ws.js public/js/layout.js
git commit -m "feat: fix tab selection hijack; restore saved active tab; add updateSessionAttached"
```

---

## Task 7: Frontend — `sessionAttached` WS handler and CSS

**Files:**
- Modify: `public/js/ws.js`
- Modify: `public/index.html`

**Why:** The server now broadcasts `sessionAttached` messages when a tmux client attaches or detaches. The client needs a handler for this message and CSS to display the green ring indicator on the tab dot and badge.

- [ ] **Step 1: Handle `sessionAttached` message in `public/js/ws.js`**

Inside `handleMsg`, after the `if (d.type === 'aiState')` line, add:

```js
if (d.type === 'sessionAttached') updateSessionAttached(d.id, d.attached);
```

- [ ] **Step 2: Add `.tmux-attached` CSS in `public/index.html`**

Find the `<style>` block. Locate the `.tab-dot` rule group. Add these rules immediately after:

```css
.tab-dot.tmux-attached {
  outline: 2px solid #3fb950;
  outline-offset: 1px;
}
.badge.tmux-attached {
  box-shadow: 0 0 0 1px #3fb950;
}
```

- [ ] **Step 3: Manual verification**

With the server running and at least one TmuxHub session active:

1. Open the dashboard. Tab dots should have no green ring (no tmux client attached).
2. In a separate terminal: `tmux attach -t term-1`.
3. Within 3 seconds, session 1's tab dot should show a green ring.
4. Detach: `Ctrl-b d`.
5. Within 3 seconds, the green ring should disappear.

- [ ] **Step 4: Commit**

```bash
git add public/js/ws.js public/index.html
git commit -m "feat: handle sessionAttached WS message; add green ring indicator for attached sessions"
```

---

## Task 8: Full test suite + final checklist

**Files:** None changed

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected output shows all test files passing:
- `tests/cli-detection.test.js` ✔
- `tests/integration.test.js` ✔
- `tests/messageProcessor.test.js` ✔
- `tests/patternEngine.test.js` ✔
- `tests/paneInfoParser.test.js` ✔ (new)
- `tests/sessionStateManager.test.js` ✔ (extended)
- `tests/tmuxService.test.js` ✔ (new)
- `tests/watcherEngine.test.js` ✔

- [ ] **Step 2: Verify the spec checklist**

Run through each scenario manually:

| Scenario | How to verify |
|----------|---------------|
| Page load with 3 workers | First worker tab selected, not last |
| Server restart + page reload | Previously selected tab restored |
| New spawn from toolbar | New session tab auto-selected |
| Recovery broadcast (server crash + restart) | Active tab preserved; no hijack |
| Multi-pane tmux session | `paneCmd` in `globalPaneInfo` matches the active pane |
| tmux client attaches | Green ring on tab dot within 3s |
| tmux client detaches | Green ring removed within 3s |
| AI state badge independence | Badge on card 1 updates to session 1's state only |
| Session rename in tmux | `sessionStateManager` state survives (keyed by `$session_id`) |
