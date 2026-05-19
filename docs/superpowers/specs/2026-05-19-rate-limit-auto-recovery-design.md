# Rate Limit Auto-Recovery Design

**Date:** 2026-05-19
**Status:** Approved

## Problem

When the AI monitor detects a rate-limit wait state, it stores the reset time as a raw display string (`tokenResetAt`) but never parses it into a trackable deadline. There is no mechanism to automatically exit the `waiting` state or resume Claude Code once the limit expires. Auto Mode workers sit idle indefinitely until the user manually intervenes.

## Goal

- Parse rate-limit reset times into concrete epoch timestamps at the moment of detection
- Persist the epoch across server restarts
- Auto-recover: exit `waiting` state and (in Auto Mode) send `"continue"` to Claude when the epoch passes
- Show an armed-recovery indicator in the UI without a live ticker

## Approach

Poll-loop epoch check. The existing 1 s per-worker `pollOutput()` tick already inspects state; adding a recovery guard clause there requires no new timers, no timer lifecycle management, and automatically handles server restarts because the epoch is persisted via `sessionStateManager`.

---

## Section 1 — Reset Time Parsing (`lib/patternEngine.js`)

### New export: `parseResetEpoch(text, now)`

Converts the raw extracted reset-time string into a Unix epoch (ms). Called at detection time in `server.js` immediately after `extractResetTime`.

**Relative durations** (`"2 hours"`, `"3h 15m"`, `"45 minutes"`, `"1 day"`, `"90s"`):
- Parse numeric components with suffixes `d/h/m/s`
- Return `now + totalMs`

**Absolute times** (`"11:00 AM PST"`, `"15:30 UTC"`):
- Parse hour/minute + optional AM/PM + optional timezone offset
- If the resulting time today is already past, add 24 hours (assume "tomorrow")
- Return UTC epoch ms

**Returns `null`** if the string cannot be parsed into a valid future-ish time. No fallback timer is scheduled in this case.

`extractResetTime` is unchanged — it continues to return the raw display string for the UI.

---

## Section 2 — Worker State & Persistence (`lib/sessionStateManager.js`)

### New worker fields

| Field | Type | Meaning |
|---|---|---|
| `resetAtEpochMs` | `number \| null` | UTC ms when rate limit expires; `null` when not in a rate-limit wait |

`resetArmed` is derived on the fly (`resetAtEpochMs != null && aiState === "waiting"`) — not stored.

### Changes to `sessionStateManager`

- `toMeta()` — includes `resetAtEpochMs` in the serialised snapshot
- `hydrateWorker()` — restores `resetAtEpochMs` from disk
- `getApiMeta()` — exposes `resetAtEpochMs` to the frontend via the monitor meta broadcast
- **New** `setResetEpoch(worker, epochMs)` — sets `worker.resetAtEpochMs` and calls `persistWorker()`
- **New** `clearResetEpoch(worker)` — nulls `worker.resetAtEpochMs` and calls `persistWorker()`

### Server restart behaviour

If a worker was in `waiting` state with a `resetAtEpochMs` that is already in the past at startup, the recovery guard in `pollOutput()` fires on the very first tick — correct behaviour (limit has already reset).

---

## Section 3 — Recovery Logic (`server.js`)

### At detection time

In `pollOutput()`, after the existing rate-limit context check that calls `extractResetTime`:

```js
const resetText = extractResetTime(inspect.detection.excerpt);
if (resetText) {
  w.tokenResetAt = resetText;                          // existing display string
  const epoch = parseResetEpoch(resetText, now);
  if (epoch) sessionStateManager.setResetEpoch(w, epoch);
}
```

### Recovery guard clause (new, near top of `pollOutput()`)

Placed after the alive-check and before the watcher inspection:

```js
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
```

- State resets for all workers in `waiting` with an expired epoch (regardless of mode)
- `"continue"` is only sent when `w.autoMode` is `true`
- `resolveAutoModeResponse` is unchanged — continues to return `null` for rate-limited detections, preventing spurious responses while the countdown runs

---

## Section 4 — Frontend (`public/js/workers.js`)

### Armed indicator in `updateMonitorMeta()`

The existing `#meta-reset-{id}` element is already shown/hidden based on `meta.tokenResetAt`. Add a second condition: when `meta.resetAtEpochMs` is set, append an `[armed]` badge and switch colour to `#58a6ff` (blue-grey) to signal scheduled auto-recovery:

```
⏱ Reset in: 2 hours  [armed]      ← blue-grey, auto-recovery scheduled
⏱ Reset in: 2 hours               ← amber, display only (no parseable epoch)
```

When `meta.resetAtEpochMs` is `null`, the element reverts to its current hide-when-empty behaviour. No countdown ticker; no changes to `ws.js` or `app.js`.

---

## Data Flow Summary

```
pollOutput()
  └─ watcher detects rate-limit pattern
       └─ extractResetTime() → raw string (display)
       └─ parseResetEpoch()  → epochMs → setResetEpoch() → persisted
       └─ broadcastMonitorMeta() → frontend shows [armed]

pollOutput() [next ticks, ~1s each]
  └─ recovery guard: now >= resetAtEpochMs?
       └─ yes → clearResetEpoch(), aiState="running", if autoMode → sendInput("continue")
       └─ no  → normal watcher inspection continues
```

---

## Files Changed

| File | Change |
|---|---|
| `lib/patternEngine.js` | Add `parseResetEpoch(text, now)` export |
| `lib/sessionStateManager.js` | Add `resetAtEpochMs` field, `setResetEpoch`, `clearResetEpoch` methods |
| `server.js` | Call `parseResetEpoch` at detection; add recovery guard in `pollOutput()` |
| `public/js/workers.js` | Armed indicator in `updateMonitorMeta()` |

No new dependencies. No schema migrations. No config changes.
