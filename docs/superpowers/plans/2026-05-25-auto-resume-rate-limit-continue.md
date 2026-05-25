# Auto-Resume Rate-Limit Plan: "continue" Resumption Flow

> **Date:** 2026-05-25  
> **Status:** Planning  
> **Scope:** Complete auto-recovery workflow when rate-limit reset time expires

## Executive Summary

When an AI monitor detects a rate-limit state with a parseable reset time, the system should:
1. **Parse** the reset time string into a UTC epoch timestamp (`resetAtEpochMs`)
2. **Persist** the epoch across server restarts via `sessionStateManager`
3. **Guard** each poll loop to detect when `now >= resetAtEpochMs`
4. **Auto-recover:** Exit `waiting` state, transition to `running`, and (in Auto Mode) send `"continue"` to resume the session
5. **Signal** the recovery event to the frontend and optionally to Telegram

---

## Implementation Status

### ✅ Already Implemented

| Component | Status | Notes |
|---|---|---|
| `parseResetEpoch(text, now)` | ✅ Complete | In `lib/patternEngine.js`; parses relative (`"2 hours"`, `"3h 15m"`) and absolute (`"11:00 AM PST"`, `"15:30 UTC"`) times |
| Recovery guard clause | ✅ Complete | In `server.js` lines 401–410; checks `w.aiState === "waiting" && w.resetAtEpochMs && now >= w.resetAtEpochMs` |
| `sendInput(id, "continue")` | ✅ Complete | Server-side function already sends keystroke input to tmux session |
| Rate-limit detection | ✅ Complete | Pattern engine detects `rate_limited`, `token_limit`, `usage_limit` patterns |
| Frontend armed indicator | ✅ Partial | UI shows `[armed]` badge when recovery is scheduled (CSS needs minor updates for visibility) |

### 🔶 Needs Verification & Testing

1. **End-to-end flow verification**
   - [ ] Confirm `parseResetEpoch` correctly handles all reset-time formats from Claude, Codex, Agy
   - [ ] Test server restart behavior with active rate-limit recovery scheduled
   - [ ] Verify `sendInput(id, "continue")` works reliably across tmux versions
   - [ ] Verify state persistence via `state/session-state.json`

2. **Telegram notifications**
   - [ ] Test Telegram alert when `waiting` state is detected with reset time
   - [ ] Test follow-up notification when auto-recovery triggers (send "continue")
   - [ ] Verify debounce doesn't suppress important recovery notifications

3. **Frontend UX**
   - [ ] Verify armed recovery badge displays correctly and updates in real-time
   - [ ] Test tab title updates reflect `aiState` transitions
   - [ ] Ensure no race conditions when user manually sends input while recovery is armed

4. **Edge cases**
   - [ ] Test with `resetAtEpochMs` already in the past (should trigger on first poll tick)
   - [ ] Test with invalid/unparseable reset-time strings (should not arm recovery)
   - [ ] Test timezone offset handling for various CLIs (Claude PST, Codex UTC, etc.)

---

## Architecture Overview

### Data Flow Diagram

```
poll loop (every ~1s per worker)
  ↓
[1] Check if alive → spawn new session if dead
  ↓
[2] ⭐ RECOVERY GUARD (new)
    if (aiState === "waiting" && resetAtEpochMs && now >= resetAtEpochMs) {
      clearResetEpoch()
      transition to "running"
      if (autoMode) sendInput("continue")
      broadcast update
      return  ← skip watcher inspection this tick
    }
  ↓
[3] Watcher inspection
    detect patterns (rate_limit, continue, etc.)
    update aiState based on detection
  ↓
[4] Optional: send auto-response (if not rate-limited)
    e.g., "y", "n", "", etc.
  ↓
[5] Broadcast updated state to frontend
```

### State Transitions

```
Running
  ↓ [detect "usage limit reached"]
Waiting (reset time extracted & parsed → resetAtEpochMs set)
  ↓ [now >= resetAtEpochMs]
Running (recovery triggered, auto-mode sends "continue")
  ↓
[process continues with "continue" input]
```

### Key Files & Responsibilities

| File | Responsibility |
|---|---|
| `lib/patternEngine.js` | `parseResetEpoch(text, now)` → converts reset-time string to epoch |
| `lib/sessionStateManager.js` | Persist/restore `resetAtEpochMs` per worker; `setResetEpoch()`, `clearResetEpoch()` methods |
| `server.js` | Call `parseResetEpoch` at detection time; guard clause in `pollOutput()` |
| `public/js/workers.js` | Display armed recovery badge in monitor meta UI |

---

## Detailed Specifications

### 1. Reset Time Parsing (`parseResetEpoch`)

**Input:** Raw reset-time string (e.g., `"2 hours"`, `"11:00 AM PST"`)  
**Output:** UTC epoch (ms) or `null` if unparseable

#### Supported Formats

| Format | Example | Parsed To |
|---|---|---|
| Relative hours | `"2 hours"`, `"3h"` | `now + 2×3600000` |
| Relative minutes | `"45 minutes"`, `"45m"` | `now + 45×60000` |
| Relative days | `"1 day"`, `"2d"` | `now + 86400000` |
| Relative seconds | `"90s"`, `"90 seconds"` | `now + 90000` |
| Compound relative | `"3h 15m"`, `"1 day 2 hours"` | Sum of all components |
| Absolute UTC | `"11:30 UTC"`, `"15:45"` | `Date.UTC(yyyy,mm,dd,hh,mm)` if future today; else +24h |
| Absolute with timezone | `"11:00 AM PST"`, `"3:30 PM EDT"` | Convert to UTC; wrap to next day if past |
| GMT offset | `"GMT+5:30"`, `"UTC-8"` | Apply offset; same wrap logic |

#### Algorithm

```javascript
function parseResetEpoch(text, now = Date.now()) {
  // 1. Try relative duration pattern
  //    Regex: /(\d+)\s*(d|h|m|s)/i
  //    Sum all numeric×unit components
  //    If totalMs > 0, return now + totalMs
  
  // 2. Try absolute time pattern
  //    Regex: /(\d{1,2}):(\d{2})(?:am|pm)?(?:UTC|PST|...)?/i
  //    Parse hour:minute + AM/PM + timezone
  //    Convert stated time (in tz) to UTC
  //    If today's time already past now, wrap to next day (add 86400000)
  //    Return epoch
  
  // 3. Return null if no pattern matches
}
```

**Timezone Support:**  
- Standard: `UTC`, `GMT`, `EST`, `EDT`, `CST`, `CDT`, `MST`, `MDT`, `PST`, `PDT`
- Custom: `GMT+5:30`, `UTC-8`, `UTC±HH:MM`

---

### 2. State Persistence (`sessionStateManager`)

#### New Worker Fields

```javascript
worker.resetAtEpochMs = null  // number | null
// Derived field (not persisted):
worker.resetArmed = (worker.resetAtEpochMs != null && worker.aiState === "waiting")
```

#### New Methods

```javascript
// Set reset epoch and persist immediately
sessionStateManager.setResetEpoch(worker, epochMs)
  → worker.resetAtEpochMs = epochMs
  → persistWorker(worker)

// Clear reset epoch and persist immediately
sessionStateManager.clearResetEpoch(worker)
  → worker.resetAtEpochMs = null
  → persistWorker(worker)
```

#### Serialization (JSON)

```json
{
  "workerId": "term-5",
  "cmd": "claude",
  "cwd": "/tmp",
  "aiState": "waiting",
  "waitingReason": "rate_limited",
  "resetAtEpochMs": 1716562800000,
  "tokenResetAt": "11:00 AM PST",
  "createdAt": 1716470000000,
  "sessionName": "my-session"
}
```

#### Hydration on Startup

```javascript
// In server.js startup:
const workers = sessionStateManager.restoreWorkers()
// If a worker has resetAtEpochMs in the past, recovery guard fires on first tick
// If resetAtEpochMs is future, normal poll loop waits until it expires
```

---

### 3. Recovery Guard in Poll Loop (`server.js`)

**Location:** `pollOutput()`, after alive-check, before watcher inspection

```javascript
const now = Date.now();

// ... existing alive-check ...

// ⭐ Recovery guard
if (w.aiState === "waiting" && w.resetAtEpochMs && now >= w.resetAtEpochMs) {
  sessionStateManager.clearResetEpoch(w);
  w.tokenResetAt = null;
  w.aiState = "running";
  sessionStateManager.setWaitingState(w, "running");
  broadcast({ type: "aiState", id, state: "running" });
  broadcastMonitorMeta(id);
  
  // Auto Mode: send "continue"
  if (w.autoMode) {
    sendInput(id, "continue");
  }
  
  // Optional: log recovery event
  console.log(`[Recovery] Worker ${id} auto-resumed after rate limit reset`);
  
  return; // ← Skip watcher inspection this tick
}

// ... existing watcher inspection ...
```

---

### 4. "continue" Input Sending

**Function:** `sendInput(id, "continue")`

```javascript
function sendInput(id, text) {
  const w = sessions.get(id);
  if (!w) return;
  
  try {
    // Send text + Enter to tmux session
    tmuxExec("send-keys", "-t", w.sessionName, text, "Enter");
    console.log(`[Input] Sent to ${id}: "${text}"`);
  } catch (e) {
    console.error(`[Input] Failed for ${id}:`, e);
  }
}
```

**Notes:**
- This is already implemented in `server.js`
- Works for any text input (used for `"y"`, `"n"`, `""` auto-responses)
- Reliable across tmux versions (v2.6+)

---

### 5. Detection Time: Calling `parseResetEpoch`

**Location:** `pollOutput()`, after rate-limit pattern is detected

```javascript
const detection = inspect.detection; // from watcher
const maybeRateLimitContext = RATE_LIMIT_PATTERNS.has(detection.patternName);

if (maybeRateLimitContext && detection.matched && stateChanged) {
  const resetText = extractResetTime(detection.excerpt);
  if (resetText) {
    w.tokenResetAt = resetText;  // Display string (already exists)
    const epoch = parseResetEpoch(resetText, now);
    if (epoch) {
      sessionStateManager.setResetEpoch(w, epoch);  // Persist
      // No need to manually set aiState here; watcher does that next
    }
  }
}
```

**Already implemented in `server.js` lines 455–466.**

---

### 6. Frontend: Armed Recovery Indicator

**Location:** `public/js/workers.js`, function `updateMonitorMeta()`

```javascript
function updateMonitorMeta(id, meta) {
  // ... existing code ...
  
  // Armed recovery badge
  const resetEl = document.getElementById('meta-reset-' + id);
  if (meta.resetAtEpochMs && meta.aiState === "waiting") {
    // Show reset time + armed badge
    resetEl.innerHTML = '⏱ Reset in: ' + formatTime(meta.resetAtEpochMs) + ' <span class="armed-badge">[armed]</span>';
    resetEl.style.color = '#58a6ff';  // Blue-grey for armed state
  } else if (meta.tokenResetAt) {
    // Show reset time only (no parseable epoch)
    resetEl.innerHTML = '⏱ Reset in: ' + meta.tokenResetAt;
    resetEl.style.color = '#f59e0b';  // Amber for unparseable
  } else {
    resetEl.style.display = 'none';
  }
}
```

**CSS for armed badge:**

```css
.armed-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 6px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 3px;
  background: rgba(88, 166, 255, 0.2);
  color: #58a6ff;
  border: 1px solid rgba(88, 166, 255, 0.4);
}
```

---

## Testing Strategy

### Unit Tests

**File:** `tests/patternEngine.test.js`

```bash
node --test tests/patternEngine.test.js
```

Test `parseResetEpoch` for:
- Null/empty input
- Relative durations (hours, minutes, days, seconds, compound)
- Absolute UTC times (future & past wrap)
- AM/PM formatting
- Timezone offsets (PST, EDT, GMT±HH:MM)
- Unparseable input → `null`

### Integration Tests

**File:** `tests/integration.test.js`

Scenarios:
1. **Basic flow:** Rate-limit detected → `resetAtEpochMs` set → server restart → recovery guard fires
2. **Auto Mode:** Recovery guard sends `"continue"` when armed
3. **Server restart:** Worker hydrated with past `resetAtEpochMs` → recovery on first tick
4. **Unparseable reset time:** No epoch set → no auto-recovery, requires manual intervention
5. **Edge case:** User sends manual input while recovery is armed → verify no conflicts

### Manual Testing Checklist

- [ ] Trigger rate-limit with Claude CLI; observe `[armed]` badge
- [ ] Wait for reset time to pass; observe auto-recovery + `"continue"` sent (in Auto Mode)
- [ ] Restart server mid-countdown; observe recovery on next poll
- [ ] Test with Codex/Agy CLIs (different reset-time formats)
- [ ] Verify Telegram notifications (if enabled)
- [ ] Test with Custom command that has custom rate-limit messages

---

## Configuration & Customization

### `config.json` Extensions

```json
{
  "aiMonitor": {
    "enabled": true,
    "pollIntervalMs": 1000,
    "idleThresholdMs": 5000,
    "autoRecoveryEnabled": true,
    "patterns": [
      {
        "name": "rate_limited",
        "regex": "(?:you(?:'re| are) (?:rate.limited|out of (?:free )?uses)|daily limit(?:\\s+(?:hit|reached|exceeded)))"
      },
      {
        "name": "reset_time_custom",
        "regex": "try again in (.+?)(?:\\.|$)"
      }
    ]
  }
}
```

**Note:** Reset time parsing relies on `extractResetTime()` regex in `patternEngine.js`, not individual patterns.

---

## Error Handling & Fallbacks

| Scenario | Behavior |
|---|---|
| Reset time unparseable | `resetAtEpochMs` stays `null`; no auto-recovery; worker stays in `waiting` state until user intervenes |
| `sendInput("continue")` fails | Logged; state remains `running`; user can manually send input if needed |
| Server crash during countdown | `resetAtEpochMs` persisted; recovery fires on restart (within 1 tick of the deadline) |
| Clock skew / NTP drift | Recovery may trigger slightly early/late (within tolerance of poll interval ~1s) |
| Very long reset times (>30 days) | Supported; epoch stored and checked; no special handling needed |

---

## Performance & Resource Usage

- **Memory:** +8 bytes per worker (`resetAtEpochMs` number)
- **Disk I/O:** Single persist call when epoch set/cleared (async, batched)
- **CPU:** Single `now >= resetAtEpochMs` comparison per poll tick (negligible)
- **Network:** Optional Telegram notification (if enabled and debounce allows)

---

## CLI-Specific Considerations

### Claude CLI

**Expected reset-time format:** `"try again in 2 hours"`, `"available in 1 day"`, `"resets at 11:00 AM PST"`

**Example output:**
```
Error: Rate limit exceeded. You've hit your usage limit.
Please try again in 2 hours, or upgrade your plan.
```

**Extraction:** `parseResetEpoch("2 hours")` → `now + 7200000`

### Codex CLI

**Expected reset-time format:** Similar to Claude; may use `"retry after X seconds"`

**Example output:**
```
HTTP 429: Too many requests
Retry-After: 3600
```

**Extraction:** May need custom pattern for `"Retry-After: 3600"` → convert to epoch

### Agy (Google Antigravity)

**Expected reset-time format:** May use ISO 8601 or absolute times

**Example output:**
```
Rate limit: 100 requests per hour
Next reset: 2026-05-25T14:30:00Z
```

**Extraction:** `parseResetEpoch("2026-05-25T14:30:00Z")` → requires ISO parser (not yet implemented)

---

## Roadmap

- [ ] **Phase 1 (Current):** Verify end-to-end flow with Claude CLI
- [ ] **Phase 2:** Test with Codex & Agy CLIs; add CLI-specific reset-time parsers if needed
- [ ] **Phase 3:** Add ISO 8601 timestamp support to `parseResetEpoch`
- [ ] **Phase 4:** UI enhancements (countdown timer, manual override button)
- [ ] **Phase 5:** Analytics (track recovery success rate, average wait times)

---

## Questions & Open Items

1. **Should auto-recovery trigger for non-Auto-Mode workers?**
   - Current: Yes (state transitions to `running`; no `"continue"` sent)
   - Alternative: Only in Auto Mode
   - **Decision needed**

2. **Should we notify user (Telegram, toast) when auto-recovery is triggered?**
   - Current: Telegram notification if debounce allows
   - **Recommendation:** Yes, with low debounce (5s) for recovery events

3. **How to handle ambiguous reset times (e.g., "in a few hours")?**
   - Current: Returns `null`; no auto-recovery
   - **Recommendation:** Allow manual override in config to set fallback duration

4. **Should we support countdown UI (show remaining time)?**
   - Current: Static badge `[armed]`
   - **Recommendation:** Add optional countdown in a follow-up phase
