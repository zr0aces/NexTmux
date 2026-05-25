# TmuxHub AI Monitor: Planning Summary & Implementation Guide

> **Date:** 2026-05-25  
> **Overview:** Two complementary enhancement plans for auto-recovery and multi-CLI support

---

## Quick Navigation

| Plan | Focus | Status | Owner |
|---|---|---|---|
| **2026-05-25-auto-resume-rate-limit-continue.md** | Rate-limit auto-recovery + "continue" resumption | Partial (core done, needs testing) | TBD |
| **2026-05-25-multi-cli-monitor-mode.md** | Claude, Codex, Agy CLI support in monitor mode | Planning phase | TBD |

---

## Plan 1: Auto-Resume on Rate-Limit Reset

**Objective:** When the AI monitor detects a rate-limit with a parseable reset time, automatically resume the worker by sending "continue" when the countdown expires.

### What's Already Done ✅

- `parseResetEpoch(text, now)` function in `lib/patternEngine.js`
  - Parses relative durations (`"2 hours"`, `"3h 15m"`)
  - Parses absolute times (`"11:00 AM PST"`, `"15:30 UTC"`)
  - Supports timezone offsets (EST, PST, UTC, GMT±HH:MM)

- Recovery guard clause in `server.js` (lines 401–410)
  - Checks `now >= resetAtEpochMs` on every poll tick
  - Transitions from `waiting` → `running`
  - Sends `"continue"` if `autoMode` is enabled

- State persistence via `sessionStateManager`
  - `resetAtEpochMs` persisted in `state/session-state.json`
  - Survives server restarts

### What Needs Verification & Testing

1. **End-to-end flow:**
   - [ ] Rate-limit detected with Claude CLI
   - [ ] Reset time correctly parsed into epoch
   - [ ] Armed badge displays in UI
   - [ ] Recovery guard fires at the right time
   - [ ] "continue" is sent correctly

2. **Server restart scenario:**
   - [ ] Kill server mid-countdown
   - [ ] Restart server
   - [ ] Recovery fires on first/next poll tick
   - [ ] Worker resumes correctly

3. **Different CLI formats:**
   - [ ] Claude: `"try again in 2 hours"`
   - [ ] Codex: `"Retry-After: 3600"` (HTTP header)
   - [ ] Agy: `"reset at 2026-05-25T14:30:00Z"` (ISO 8601)

4. **Edge cases:**
   - [ ] `resetAtEpochMs` already in the past (should trigger immediately)
   - [ ] Unparseable reset time (should not arm recovery)
   - [ ] User sends manual input while recovery is armed (no conflicts)
   - [ ] Clock skew / NTP drift (graceful handling within ~1s tolerance)

### Next Steps

1. **Quick win:** Run tests in `tests/patternEngine.test.js`
   ```bash
   node --test tests/patternEngine.test.js
   ```

2. **Manual testing:**
   - Trigger rate-limit with Claude CLI
   - Observe `[armed]` badge in UI
   - Wait for reset or manually advance time
   - Verify recovery happens

3. **Then:** Focus on Plan 2 (CLI support) for better reset-time parsing across different CLI formats

---

## Plan 2: Multi-CLI Monitor Mode Support

**Objective:** Extend AI Monitor to handle Claude, Codex, and Google Antigravity CLIs with CLI-specific pattern detection, auto-responses, and metadata extraction.

### Key Components

| Component | Purpose | Status |
|---|---|---|
| **CLI Detection** | Identify which CLI the worker is running | Not started |
| **Pattern Profiles** | CLI-specific regex patterns for rate-limits, prompts, approvals | Not started |
| **Reset-Time Parsers** | CLI-specific logic for parsing reset times (Codex HTTP headers, Agy ISO 8601) | Not started |
| **Auto-Response Maps** | CLI-specific preferred responses (Codex: `"1"`, Agy: `"y"`) | Not started |
| **Metadata Extractors** | Extract token usage, cost, quotas per CLI | Not started |

### Implementation Path

1. **Configuration-driven approach:**
   - Add `cliProfiles` section to `config.json`
   - Each CLI has: patterns, auto-responses, reset-time formats, metadata extractors

2. **Detection & matching:**
   - `detectCliType(cmd)` in `server.js` → identifies CLI from command
   - Load appropriate profile when spawning session
   - Pass `cliType` to pattern engine

3. **Smart parsing:**
   - Codex: Check for `Retry-After` HTTP header (seconds) → convert to epoch
   - Agy: Check for ISO 8601 timestamps → parse directly
   - Claude: Use existing relative/absolute parser

4. **Metadata display:**
   - Extract tokens, cost, quotas from output
   - Broadcast to frontend
   - Display in monitor UI

### Implementation Phases

| Phase | Timeline | Deliverable |
|---|---|---|
| **1. Config & Detection** | Week 1-2 | `detectCliType()`, CLI profile loading |
| **2. Auto-Response** | Week 3-4 | CLI-specific response maps, extended reset-time parsers |
| **3. Metadata** | Week 5 | Extraction & frontend display |
| **4. Testing** | Week 6-7 | Unit tests, integration tests, manual testing |
| **5. Advanced** | Future | Cost alerts, analytics, custom profiles |

---

## Integration Points

### How Plan 1 & Plan 2 Work Together

```
Worker spawned with cmd="codex"
  ↓
[Plan 2] detectCliType() → "codex"
[Plan 2] Load codex profile (patterns, responses, metadata extractors)
  ↓
Poll loop detects output
  ↓
[Plan 2] Pattern engine matches against codex patterns
  → Detects "Rate limit exceeded" (codex-specific format)
  ↓
[Plan 2] extractResetTime() → "Retry-After: 3600"
  ↓
[Plan 1] parseResetEpoch() → converts to relative format → parses → epoch
  ↓
[Plan 1] sessionStateManager.setResetEpoch(worker, epochMs)
  ↓
Poll loop (next ticks)
  ↓
[Plan 1] Recovery guard: now >= resetAtEpochMs?
  → Yes! Exit waiting, send "continue" if autoMode
  → No, wait next tick
```

---

## File Changes Summary

### Plan 1: Auto-Resume Rate-Limit (Mostly Done)

| File | Change | Status |
|---|---|---|
| `lib/patternEngine.js` | Add `parseResetEpoch(text, now)` export | ✅ |
| `lib/sessionStateManager.js` | Add `resetAtEpochMs` field, `setResetEpoch()`, `clearResetEpoch()` | ✅ |
| `server.js` | Recovery guard clause in `pollOutput()` | ✅ |
| `public/js/workers.js` | Armed indicator in `updateMonitorMeta()` | 🔶 Needs CSS tweaks |
| `tests/patternEngine.test.js` | Unit tests for `parseResetEpoch()` | 🔶 Needs running |
| `tests/sessionStateManager.test.js` | Unit tests for persistence | 🔶 Needs running |

### Plan 2: Multi-CLI Support (To Be Done)

| File | Change | Timeline |
|---|---|---|
| `config.example.json` | Add `cliProfiles` section | Week 1 |
| `server.js` | Add `detectCliType(cmd)` function | Week 1 |
| `lib/patternEngine.js` | Extend to accept `cliType`, load profiles | Week 1 |
| `lib/messageProcessor.js` | CLI-aware `resolveAutoResponse()` | Week 2-3 |
| `server.js` (pollOutput) | Call `extractCliMetadata()` | Week 3 |
| `public/js/workers.js` | Display CLI metadata in UI | Week 3-4 |
| Tests | Unit + integration tests | Week 4-5 |

---

## Configuration Example (After Both Plans)

```json
{
  "basePath": "/tmp",
  "defaultCommand": "claude",
  "tunnel": { "enabled": true },
  
  "aiMonitor": {
    "enabled": true,
    "pollIntervalMs": 1000,
    "idleThresholdMs": 5000,
    "linesToInspect": 120,
    "notifyCooldownMs": 120000,
    "autoRecoveryEnabled": true,
    "patterns": []  // ← Will be overridden by CLI profiles
  },

  "cliProfiles": {
    "claude": {
      "label": "Claude",
      "enabled": true,
      "patterns": {
        "rate_limit": "(?:you(?:'re| are) (?:rate.limited|out of (?:free )?uses)|daily limit)",
        "reset_time": "(?:try(?:\\s+again)?(?:\\s+in)?|resets?(?:\\s+(?:in|at))?)",
        "prompt_continue": "continue\\?"
      },
      "autoResponses": {
        "confirm": "y",
        "continue": "continue"
      },
      "resetTimeFormats": [
        "relative:hours,minutes,days",
        "absolute:HH:MM AM/PM PST|EST|CST|MST|UTC"
      ],
      "metadataExtractors": {
        "tokenUsage": "tokens? (?:used|consumed): (\\d+)",
        "cost": "cost: \\$(\\d+\\.\\d+)"
      }
    },

    "codex": {
      "label": "Codex",
      "enabled": true,
      "patterns": {
        "rate_limit": "rate limit|quota exceeded|http 429",
        "reset_time": "(?:retry after|try again)",
        "prompt_selection": "\\[\\d+\\].*\\[\\d+\\]"
      },
      "autoResponses": {
        "confirm": "y",
        "select": "1"
      },
      "resetTimeFormats": [
        "relative:hours,minutes,seconds",
        "http_header:Retry-After"
      ],
      "metadataExtractors": {
        "tokenUsage": "Tokens: (\\d+)",
        "requestsRemaining": "requests? (?:remaining|left): (\\d+)"
      }
    },

    "agy": {
      "label": "Google Antigravity",
      "enabled": true,
      "patterns": {
        "rate_limit": "quota exceeded|rate limit",
        "reset_time": "(?:reset at|available at)",
        "approval_needed": "proceed|authorize|confirm"
      },
      "autoResponses": {
        "confirm": "y"
      },
      "resetTimeFormats": [
        "iso8601:YYYY-MM-DDTHH:MM:SSZ",
        "relative:hours,minutes,days"
      ],
      "metadataExtractors": {
        "quotaUsed": "quota usage: (\\d+)%"
      }
    }
  }
}
```

---

## Testing Strategy

### Phase 1: Unit Tests (Both Plans)

```bash
# Existing tests
npm test

# Or manually
node --test tests/patternEngine.test.js
node --test tests/sessionStateManager.test.js
node --test tests/messageProcessor.test.js
node --test tests/watcherEngine.test.js
```

### Phase 2: Integration Tests

1. **Spawn worker with each CLI:**
   ```bash
   # Terminal 1: Start TmuxHub
   npm start
   
   # Terminal 2: Simulate worker
   tmux new-session -d -s term-1 -c /tmp "claude"
   ```

2. **Trigger rate-limit in worker**
3. **Observe:**
   - Pattern detection in server logs
   - Reset time parsing & armed badge in UI
   - Recovery firing at deadline
   - "continue" sent in Auto Mode

### Phase 3: Manual Testing with Real CLIs

**Prerequisites:**
- Claude CLI installed & authenticated
- Codex CLI installed & authenticated
- Agy CLI installed & authenticated

**Test cases:**
- Trigger rate-limit naturally → observe reset-time detection
- Verify auto-responses match CLI expectations
- Verify metadata extraction (tokens, cost, quotas)
- Test server restart mid-recovery
- Test Auto Mode vs Monitor-Only mode

---

## Risk Assessment

### Plan 1: Low Risk ✅

- Core logic already implemented
- Relies on existing tmux send-keys functionality
- Graceful fallbacks (no auto-recovery if epoch unparseable)
- Minimal new dependencies (just node:test for unit tests)

### Plan 2: Medium Risk 🔶

- Depends on accurate CLI detection
- Assumes predictable output formats (may vary by CLI version)
- Metadata extraction via regex (fragile, may need updates)
- Requires testing with multiple CLI versions

### Mitigation

- Start with Plan 1 (already done, just needs testing)
- For Plan 2, make patterns configurable in `config.json`
- Log warnings if CLI detection fails or patterns don't match
- Graceful fallback to generic patterns if CLI-specific ones fail

---

## Success Criteria

### Plan 1 Complete ✅

- [ ] All unit tests pass
- [ ] Server restart test passes
- [ ] Manual testing with Claude CLI shows recovery firing
- [ ] No spurious "continue" sends
- [ ] Armed badge visible & accurate

### Plan 2 Complete ✅

- [ ] All unit tests pass
- [ ] `detectCliType()` correctly identifies CLI
- [ ] CLI-specific patterns detected correctly
- [ ] Auto-responses match CLI expectations
- [ ] Metadata extracted & displayed
- [ ] Manual testing with Codex & Agy CLIs passes

---

## Related Documentation

- [CLAUDE.md](../../CLAUDE.md) — Project architecture & conventions
- [ai_monitoring.md](../ai_monitoring.md) — Monitor mode overview
- [technical_spec.md](../technical_spec.md) — Full system spec
- [2026-05-19-rate-limit-auto-recovery-design.md](./specs/2026-05-19-rate-limit-auto-recovery-design.md) — Earlier design doc

---

## Questions for Discussion

1. **Priority:** Start with Plan 1 testing, or jump to Plan 2 implementation?
   - **Recommendation:** Plan 1 first (already 80% done, just needs testing)

2. **CLI detection:** Hardcode CLI names, or support regex patterns in config?
   - **Recommendation:** Start simple (hardcoded), add regex in Phase 2

3. **Metadata display:** Show all available metadata, or curate per-CLI?
   - **Recommendation:** Curate per-CLI (don't overwhelm UI)

4. **Cost alerts:** Add budget limits / spending alerts?
   - **Recommendation:** Future phase (not in v1)

5. **Custom CLIs:** Allow users to define patterns for new CLIs?
   - **Recommendation:** Support in v2 (phase 5)

---

## Next Actions

1. **Immediate (today):**
   - [ ] Review & approve both plan documents
   - [ ] Assign ownership to team members

2. **Short-term (this week):**
   - [ ] Run Plan 1 tests
   - [ ] Fix any failing tests
   - [ ] Create GitHub issues for Plan 1 tasks

3. **Medium-term (next 2-3 weeks):**
   - [ ] Create GitHub issues for Plan 2 tasks
   - [ ] Assign phases to sprints
   - [ ] Begin Phase 1 (config & detection)

4. **Long-term (ongoing):**
   - [ ] Execute phases sequentially
   - [ ] Gather feedback from users
   - [ ] Iterate on patterns & metadata extraction
