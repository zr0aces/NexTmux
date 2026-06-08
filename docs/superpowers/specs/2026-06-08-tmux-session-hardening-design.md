# TmuxHub: Tmux Session Hardening Design

**Date:** 2026-06-08  
**Scope:** Fix + harden existing worker-centric model  
**Approach:** Approach B — Moderate hardening + bug fix

---

## Problem Summary

Four independent bugs degrade session accuracy:

| # | Bug | Impact |
|---|-----|--------|
| 1 | `ensureCard` calls `selectTab` unconditionally | Last-loaded card always hijacks the active tab; reconnect recovery steals user's selection |
| 2 | `globalPaneInfo` keeps last pane seen per session | Wrong `paneCmd` for sessions with multiple windows or panes; incorrect exit detection |
| 3 | No tmux `$session_id` stored on workers | Session identity breaks on rename; persistence keyed by mutable session name |
| 4 | No `session_attached` tracking | No factual basis for showing which session has a real tmux client attached |

---

## Architecture

### Core Principle

Workers are the TmuxHub abstraction over tmux sessions. Worker TmuxHub IDs (1, 2, 3…) remain the DOM and API keys — no DOM element ID changes, no API contract changes.

The tmux `$session_id` is added as a secondary stable identifier stored on each worker, used only for:
- Persistence keying in `sessionStateManager`
- Identity verification when session names could change (attached external sessions)

---

## Section 1: Worker Data Model

Two new fields on every worker object:

```js
{
  // — new fields —
  tmuxSessionId: "$3",   // stable tmux session ID; never changes, survives renames
  sessionAttached: 0,    // 1 if a tmux client is currently attached to this session
}
```

`tmuxSessionId` is resolved via a new helper `resolveSessionId(sessionName)` in `lib/tmuxService.js`:

```js
// Runs: tmux list-sessions -F "#{session_name}|#{session_id}"
// Returns: "$3" string for matching session_name
// Returns: null on any error (tmux not running, session gone, parse failure)
// Never throws; callers treat null as "unknown ID" and fall back to sessionName key
function resolveSessionId(sessionName) { ... }
```

Called at three points: `spawnWorker`, `/api/attach`, `recoverSessions`.

---

## Section 2: sessionStateManager — Stable Key

`sessionStateManager` gains a private `getKey(worker)` helper:

```js
function getKey(worker) {
  return worker.tmuxSessionId || worker.sessionName;
}
```

`persistWorker` and `hydrateWorker` both call `getKey`. `hydrateWorker` tries `tmuxSessionId` key first, then falls back to `sessionName` key for backward-compat migration of existing snapshots.

`removeSession` signature changes from `removeSession(sessionName)` to `removeSession(worker)` so it can call `getKey(worker)`. It also deletes the old `sessionName` key for backward-compat cleanup. All three callers in `server.js` (`/api/remove`, `/api/reset`, session recovery cleanup) updated to pass the worker object instead of `w.sessionName`.

---

## Section 3: Server — `updateGlobalPaneInfo`

### Format String Change

Old:
```
#{session_name}|||#{pane_current_path}|||#{pane_current_command}
```

New:
```
#{session_name}|||#{session_id}|||#{pane_current_path}|||#{pane_current_command}|||#{window_active}|||#{pane_active}|||#{session_attached}
```

### Parse Logic Change

**Only store an entry when `window_active == 1` AND `pane_active == 1`.** This ensures `globalPaneInfo` tracks exactly one entry per session: the active pane in the active window. Previously all panes were iterated and each `Map.set()` overwrote the previous, leaving only the last pane in output order.

### `sessionAttached` Change Detection in `pollOutput`

After reading `cachedInfo`:

```js
const nowAttached = cachedInfo?.sessionAttached === "1" ? 1 : 0;
if (nowAttached !== (w.sessionAttached || 0)) {
  w.sessionAttached = nowAttached;
  broadcast({ type: "sessionAttached", id, attached: nowAttached === 1 });
}
```

Also include `sessionAttached` in `/api/workers` response so initial page load reflects current state.

---

## Section 4: Server — Session ID at Spawn/Attach/Recovery

### `spawnWorker`

After `tmuxExec("new-session", ...)`:
```js
const tmuxSessionId = resolveSessionId(sessionName);  // "$N" or null
workers.set(id, { ..., tmuxSessionId, sessionAttached: 0 });
```

### `/api/attach`

After validating `sessionName`:
```js
const tmuxSessionId = resolveSessionId(sessionName);
workers.set(id, { ..., tmuxSessionId, sessionAttached: 0 });
```

### `recoverSessions`

Format string gains `#{session_id}`:
```
#{session_name}|#{pane_current_path}|#{pane_current_command}|#{session_id}
```
Parse `parts[3]` as `tmuxSessionId`.

### `recoverSessions` — Recovery Broadcast Flag

Recovery broadcasts add `fromRecovery: true` so the client can suppress tab-switching:
```js
broadcast({ type: "spawned", id, fromRecovery: true, cwd: w.cwd, cmd: w.cmd,
            status: "running", sessionName: w.sessionName, ...getMonitorMeta(w) });
```

---

## Section 5: Frontend — Tab Selection Fix

### `ensureCard` (workers.js)

Replace unconditional `selectTab(id)` with conditional:

```js
// Before (bug):
selectTab(id);

// After:
if (activeTab === null) selectTab(id);
```

Only the very first card gets auto-selected. Subsequent cards added during load or reconnect do not hijack focus.

### `handleMsg` (ws.js) — Spawned Event

```js
if (d.type === 'spawned') {
  ensureCard(d.id, d.cwd, d.status, [], d.cmd, d.reason || null, d);
  if (!d.fromRecovery) selectTab(d.id);
}
```

User-initiated spawns (no `fromRecovery` flag) switch to the new tab. Recovery spawns do not.

### `selectTab` (layout.js) — Persist Selection

```js
function selectTab(id) {
  activeTab = id;
  localStorage.setItem('tmuxhub.activeTab.v1', id);
  // ... existing DOM update logic unchanged ...
}
```

### `loadAll` (ws.js) — Restore Saved Tab

After all cards are created and tab order restored:

```js
const savedTab = localStorage.getItem('tmuxhub.activeTab.v1');
if (savedTab && document.querySelector('.tab[data-id="' + savedTab + '"]')) {
  selectTab(savedTab);
}
```

---

## Section 6: Frontend — `sessionAttached` Indicator

### New WS Message Type

`handleMsg` in `ws.js`:
```js
if (d.type === 'sessionAttached') updateSessionAttached(d.id, d.attached);
```

### New Function in `workers.js`

```js
function updateSessionAttached(id, attached) {
  const dot = document.getElementById('tab-dot-' + id);
  if (dot) dot.classList.toggle('tmux-attached', Boolean(attached));
  const badge = document.getElementById('badge-' + id);
  if (badge) badge.classList.toggle('tmux-attached', Boolean(attached));
}
```

### Initial Load

`loadAll` calls `updateSessionAttached(w.id, w.sessionAttached === 1)` for each worker after `ensureCard`.

### CSS

`.tmux-attached` on tab dot: adds a 2px `outline` in `#3fb950` (GitHub green) to indicate a real tmux client is connected. Distinct from the AI state colors (idle=yellow dot, waiting=orange dot). Badge gets a faint `box-shadow: 0 0 0 1px #3fb950` glow. Both effects are additive — they stack with existing running/idle/waiting styles.

---

## Files Changed

| File | Change |
|------|--------|
| `lib/tmuxService.js` | Add `resolveSessionId(sessionName)` export |
| `lib/sessionStateManager.js` | Add `getKey(worker)`; update `persistWorker`, `hydrateWorker`, `removeSession` |
| `server.js` | `updateGlobalPaneInfo` format string + filter; `spawnWorker`, attach, recover add `tmuxSessionId`; `pollOutput` broadcasts `sessionAttached`; recovery broadcasts `fromRecovery: true`; `/api/workers` includes `sessionAttached` |
| `public/js/workers.js` | `ensureCard` conditional `selectTab`; new `updateSessionAttached` function |
| `public/js/ws.js` | `handleMsg` spawned case; `loadAll` restore saved tab; handle `sessionAttached` message |
| `public/js/layout.js` | `selectTab` persists to localStorage |
| `public/index.html` (CSS) | `.tmux-attached` style for tab dot and badge |

---

## What Is Not Changed

- Worker TmuxHub IDs (1, 2, 3…) remain DOM and API keys
- All existing API endpoints and response shapes (only additions)
- `watcherEngine`, `patternEngine`, `messageProcessor` — already stateless, no changes needed
- `telegramService` — no changes needed
- Window/pane hierarchy UI — out of scope for this fix

---

## Testing Checklist

| Scenario | Expected |
|----------|----------|
| Page load with 3 workers | First worker selected; no subsequent hijack |
| Server restart + client reconnect | Previously active tab restored from localStorage |
| New spawn via UI | New session tab selected |
| Recovery after server crash | Active tab preserved; recovery spawns don't steal focus |
| Session with multiple panes in one window | `globalPaneInfo` tracks active pane only; correct `paneCmd` |
| Session with multiple windows | Active window's active pane tracked; other windows ignored |
| tmux client attaches to session | `tmux-attached` class appears on tab dot within 3s |
| tmux client detaches | `tmux-attached` class removed within 3s |
| Session rename in tmux (external sessions) | Worker still alive via `$session_id`-keyed persistence |
| AI state transitions (running→idle→waiting) | Badge updates on correct card only |
