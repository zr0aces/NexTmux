# Multi-CLI Monitor Mode Plan: Google Antigravity & Codex Support

> **Date:** 2026-05-25  
> **Status:** Planning  
> **Scope:** Auto-monitor & auto-respond for Claude, Codex, and Google Antigravity CLIs

## Executive Summary

TmuxHub's AI Monitor is currently designed generically to detect wait-states (prompts, rate-limits, confirmations) but needs **CLI-specific knowledge** to:
1. Recognize rate-limit messages & reset times across different CLIs
2. Detect & parse pause/wait-for-approval states unique to each CLI
3. Support CLI-specific auto-response patterns
4. Display CLI-specific metadata (token usage, cost, model info)

This plan adds structured CLI profiles to `config.json`, CLI detection logic in the pattern engine, and a CLI-aware message processor.

---

## CLI Landscape

### Claude CLI
- **Status:** Baseline; most features already work
- **Key behaviors:**
  - Rate-limit: `"You've hit your usage limit"`, `"try again in 2 hours"`
  - Prompt: `[y/N]`, `[continue/stop]`
  - Auto-responses: `y`, `n`, `continue`, `stop`
  - Cost tracking: Shows token usage + billing status
  - Pause states: Asks for approval before continuing on long outputs

### Codex CLI
- **Status:** Similar to Claude; different message formats expected
- **Key behaviors:**
  - Rate-limit: May use HTTP 429 codes or `"rate limit exceeded"`
  - Prompt: Numeric selection `[1] option1 [2] option2`
  - Auto-responses: Numeric keys (`1`, `2`, etc.) or yes/no
  - Cost tracking: May report differently (credits, API quota)
  - Pause states: `"continue with generation?"`, `"accept changes?"`

### Google Antigravity (Agy)
- **Status:** New; needs exploration & testing
- **Key behaviors (estimated):**
  - Rate-limit: May use different format (ISO timestamps, REST error codes)
  - Prompt: May use `⟨enter to continue⟩`, `Press Y/N`, etc.
  - Auto-responses: Enter, `Y`, `N`, numeric selection
  - Cost tracking: Google Cloud Quotas, API budget management
  - Pause states: May ask for approval on sensitive operations (deployments, deletions)

---

## Architecture

### 1. CLI Profile Configuration

**Location:** `config.json`

```json
{
  "cliProfiles": {
    "claude": {
      "label": "Claude",
      "enabled": true,
      "patterns": {
        "rate_limit": [
          "(?:you(?:'re| are) (?:rate.limited|out of (?:free )?uses)|daily limit(?:\\s+(?:hit|reached|exceeded)))",
          "(?:you've hit your|reached.*rate limit)"
        ],
        "reset_time": "(?:try(?:\\s+again)?(?:\\s+in)?|resets?(?:\\s+(?:in|at))?|available(?:\\s+again)?\\s+in|come\\s+back\\s+in|limit\\s+resets?(?:\\s+(?:in|at))?)",
        "usage_exceeded": "usage limit|token limit|quota exceeded",
        "prompt_yes_no": "\\[(?:y|yes)\\s*/\\s*(?:n|no)\\]|[y/n]\\s*\\?",
        "prompt_continue": "continue\\?|proceed\\?|confirm\\?",
        "approval_needed": "do you want to|approve|allow|overwrite|replace"
      },
      "autoResponses": {
        "confirm": "y",
        "continue": "continue",
        "reject": "n",
        "press_enter": "",
        "select": "1"
      },
      "resetTimeFormats": [
        "relative:hours,minutes,days",
        "absolute:HH:MM AM/PM PST|EST|CST|MST|UTC"
      ],
      "metadataExtractors": {
        "tokenUsage": "/tokens? (?:used|consumed): (\\d+)|(\\d+) \/ (\\d+)/",
        "cost": "/cost: \\$(\\d+\\.\\d+)/",
        "model": "/using (model[s]?): ([\\w-]+)/"
      }
    },
    "codex": {
      "label": "Codex",
      "enabled": true,
      "patterns": {
        "rate_limit": [
          "rate limit|quota exceeded|too many requests|http 429",
          "exceeded.*limit|limit.*exceeded"
        ],
        "reset_time": "(?:retry after|try again|available in|resets? at)",
        "usage_exceeded": "usage limit|request limit|token quota",
        "prompt_selection": "\\[\\d+\\].*\\[\\d+\\]|(?:^|\\n)\\d+[.):-]\\s+\\w+",
        "prompt_yes_no": "\\[y\\s*/\\s*n\\]|[y/n]\\s*\\?|yes\\s*/\\s*no",
        "approval_needed": "accept|approve|confirm changes"
      },
      "autoResponses": {
        "confirm": "y",
        "continue": "y",
        "reject": "n",
        "press_enter": "",
        "select": "1"
      },
      "resetTimeFormats": [
        "relative:hours,minutes,seconds",
        "absolute:HH:MM UTC|GMT",
        "http_header:Retry-After"
      ],
      "metadataExtractors": {
        "tokenUsage": "Tokens: (\\d+)(?:\\s*\\/\\s*(\\d+))?",
        "requestsRemaining": "requests? (?:remaining|left): (\\d+)",
        "model": "(?:using|with)\\s+(?:codex[\\s-])?model[s]?:\\s+([\\w-]+)"
      }
    },
    "agy": {
      "label": "Google Antigravity",
      "enabled": true,
      "patterns": {
        "rate_limit": [
          "quota exceeded|rate limit|too many requests",
          "project.*quota|resource.*limit"
        ],
        "reset_time": "(?:reset at|available at|next quota|next billing)",
        "usage_exceeded": "quota|limit exceeded|resource exhausted",
        "prompt_selection": "(?:select|choose).*option|\\d+\\)\\s+\\w+",
        "prompt_yes_no": "[y/n]|yes/no",
        "approval_needed": "proceed|authorize|confirm|deploy"
      },
      "autoResponses": {
        "confirm": "y",
        "continue": "y",
        "reject": "n",
        "press_enter": "",
        "select": "1"
      },
      "resetTimeFormats": [
        "iso8601:YYYY-MM-DDTHH:MM:SSZ",
        "relative:hours,minutes,days",
        "absolute:HH:MM UTC"
      ],
      "metadataExtractors": {
        "quotaUsed": "quota usage: (\\d+)%|used (\\d+) of (\\d+)",
        "region": "region[s]?:\\s+([a-z0-9-]+)",
        "apiEndpoint": "endpoint:\\s+(https?:\\/\\/[^\\s]+)"
      }
    }
  }
}
```

### 2. CLI Detection

**Location:** Server startup & per-spawn

```javascript
// In server.js, when spawning a session:
function spawnSession(cwd, cmd) {
  const sessionId = ++nextWorkerId;
  const worker = {
    id: sessionId,
    cmd,
    cwd,
    sessionName: `term-${sessionId}`,
    cliType: detectCliType(cmd),  // ← NEW
    aiMonitorEnabled: true,
    autoMode: false,
  };
  
  // Load CLI-specific profiles
  if (worker.cliType) {
    const profile = config.cliProfiles?.[worker.cliType];
    worker.cliProfile = profile;
  }
  
  // Use CLI profile for pattern detection
  const patternsForCli = worker.cliProfile?.patterns || DEFAULT_PATTERNS;
  
  return worker;
}

function detectCliType(cmd) {
  const normalized = String(cmd || "").toLowerCase().trim();
  
  if (normalized === "claude" || normalized.includes("claude")) {
    return "claude";
  } else if (normalized === "codex" || normalized.includes("codex")) {
    return "codex";
  } else if (normalized === "agy" || normalized.includes("agy") || normalized.includes("antigravity")) {
    return "agy";
  }
  
  // Detect from full command path
  if (normalized.includes("/claude") || normalized.includes("@claude")) return "claude";
  if (normalized.includes("/codex") || normalized.includes("@codex")) return "codex";
  if (normalized.includes("/agy") || normalized.includes("antigravity")) return "agy";
  
  return null; // Generic handling
}
```

### 3. CLI-Aware Pattern Detection

**Location:** `lib/patternEngine.js` (extended)

```javascript
function createPatternEngine({ cliType = null, patterns = null, linesToInspect = 120 } = {}) {
  // Load CLI-specific patterns if available
  let patternsToUse = patterns;
  if (!patternsToUse && cliType && config.cliProfiles?.[cliType]) {
    const profile = config.cliProfiles[cliType];
    // Convert profile patterns to regex format
    patternsToUse = convertCliProfilePatterns(profile);
  }
  if (!patternsToUse) {
    patternsToUse = DEFAULT_PATTERNS;
  }
  
  const compiled = (Array.isArray(patternsToUse) ? patternsToUse : [])
    .map((item, idx) => toSafePattern(item, idx))
    .filter(Boolean);

  function detect(output) {
    const text = String(output || "");
    const lines = text.split("\n");
    const excerpt = lines.slice(-Math.max(10, linesToInspect)).join("\n");

    for (const item of compiled) {
      const match = excerpt.match(item.regex);
      if (!match) continue;
      
      return {
        matched: true,
        patternName: item.name,
        cliType,  // ← NEW: Track which CLI this pattern matched
        matchedText: match[0] || "",
        excerpt,
        detectedAt: new Date().toISOString(),
      };
    }

    return {
      matched: false,
      patternName: null,
      cliType,
      excerpt,
      detectedAt: null,
    };
  }

  return {
    detect,
    getCompiledCount: () => compiled.length,
  };
}

function convertCliProfilePatterns(profile) {
  // Convert profile.patterns object to array format
  const result = [];
  if (profile.patterns) {
    for (const [name, regex] of Object.entries(profile.patterns)) {
      if (Array.isArray(regex)) {
        // Multiple alternatives for this pattern
        regex.forEach((r, i) => {
          result.push({
            name: `${name}${i > 0 ? `_${i}` : ""}`,
            regex: r,
          });
        });
      } else if (typeof regex === "string") {
        result.push({ name, regex });
      }
    }
  }
  return result;
}
```

### 4. CLI-Aware Auto-Response Selection

**Location:** `lib/messageProcessor.js` (extended)

```javascript
function resolveAutoResponse(detection, cliProfile = null) {
  const excerpt = String(detection?.excerpt || "");
  
  // Use CLI-specific auto-response mapping
  if (cliProfile?.autoResponses) {
    const responses = cliProfile.autoResponses;
    
    if (detection.patternName.includes("continue")) {
      return responses.continue || "continue";
    } else if (detection.patternName.includes("yes_no")) {
      return responses.confirm || "y";
    } else if (detection.patternName.includes("press_enter")) {
      return responses.press_enter || "";
    } else if (detection.patternName.includes("selection")) {
      return responses.select || "1";
    }
  }
  
  // Fallback to generic logic
  const prompt = analyzePrompt(excerpt, detection?.patternName || null);
  
  const looksRateLimited = RATE_LIMIT_PATTERN_NAMES.has(detection?.patternName)
    || /(?:\/rate-limit-options|rate\s*limit|usage\s*limit|token\s*limit)/i.test(excerpt);
  
  if (looksRateLimited) return null;
  if (prompt.hasPressEnterPrompt) return "";
  if (prompt.yesOption) return prompt.yesOption.key;
  if (prompt.hasYesNoPrompt || prompt.hasConfirmationPrompt) return "y";
  
  return null;
}
```

### 5. CLI-Specific Metadata Extraction

**Location:** Server-side in `pollOutput()` & frontend in `workers.js`

```javascript
// In server.js pollOutput():
function extractCliMetadata(output, cliProfile) {
  const metadata = {};
  
  if (!cliProfile?.metadataExtractors) {
    return metadata;
  }
  
  for (const [key, regex] of Object.entries(cliProfile.metadataExtractors)) {
    const re = new RegExp(regex, "i");
    const match = output.match(re);
    if (match) {
      metadata[key] = match[1] || match[0];
    }
  }
  
  return metadata;
}

// Broadcast to frontend:
broadcast({
  type: "cliMetadata",
  id: workerId,
  metadata: {
    cliType: worker.cliType,
    tokenUsage: metadata.tokenUsage,
    cost: metadata.cost,
    quotaUsed: metadata.quotaUsed,
    requestsRemaining: metadata.requestsRemaining,
  },
});
```

**Frontend display in `workers.js`:**

```javascript
function updateCliMetadata(id, metadata) {
  const el = document.getElementById('cli-metadata-' + id);
  if (!el) return;
  
  const parts = [];
  if (metadata.tokenUsage) parts.push(`Tokens: ${metadata.tokenUsage}`);
  if (metadata.cost) parts.push(`Cost: ${metadata.cost}`);
  if (metadata.quotaUsed) parts.push(`Quota: ${metadata.quotaUsed}%`);
  if (metadata.requestsRemaining) parts.push(`Requests: ${metadata.requestsRemaining}`);
  
  el.textContent = parts.join(" · ");
}
```

---

## Implementation Roadmap

### Phase 1: Configuration & Detection (Weeks 1-2)

- [ ] Add `cliProfiles` to `config.example.json`
- [ ] Implement `detectCliType(cmd)` in `server.js`
- [ ] Extend `createPatternEngine()` to accept `cliType` parameter
- [ ] Load & apply CLI-specific patterns when spawning session
- [ ] Test pattern detection for each CLI

### Phase 2: Auto-Response & Reset Time (Weeks 3-4)

- [ ] Update `resolveAutoResponse()` to use CLI-specific response maps
- [ ] Extend `parseResetEpoch()` to handle CLI-specific reset-time formats
  - [ ] Codex: HTTP header `Retry-After: NNN` (seconds)
  - [ ] Agy: ISO 8601 timestamps `2026-05-25T14:30:00Z`
- [ ] Test auto-responses for each CLI
- [ ] Test reset-time parsing across CLIs

### Phase 3: Metadata Extraction (Week 5)

- [ ] Implement `extractCliMetadata()` per CLI
- [ ] Broadcast metadata to frontend
- [ ] Display CLI-specific info in monitor UI
- [ ] Test with real CLI output

### Phase 4: Testing & Documentation (Weeks 6-7)

- [ ] Unit tests for `detectCliType()`, pattern conversion
- [ ] Integration tests: spawn Codex/Agy, trigger patterns, verify responses
- [ ] Manual testing with each CLI
- [ ] Update CLAUDE.md & docs with CLI profiles

### Phase 5: Advanced Features (Future)

- [ ] Cost tracking & alerts (Claude billing, Agy quotas)
- [ ] CLI-specific analytics (success rate, avg response time per CLI)
- [ ] Custom CLI profiles (allow users to define patterns for new CLIs)
- [ ] CLI auto-detection from output (detect CLI even if command was generic)

---

## Detailed Format Specifications

### Claude CLI Reset Time Formats

**Examples:**
```
try again in 2 hours
resets in 3h 15m
available in 45 minutes
resets at 11:00 AM PST
come back in 1 day
```

**Parser:** Relative (`parseResetEpoch`) + Absolute with timezone offset

### Codex CLI Reset Time Formats

**Examples:**
```
Retry-After: 3600
retry after 60 minutes
rate limit reset: 2h
try again at 3:30 PM UTC
next quota: 1 day
```

**Parser:**
- HTTP header `Retry-After` (seconds) → convert to relative
- Relative durations
- Absolute times (likely UTC)

**Implementation:**
```javascript
function parseCodexResetTime(output) {
  // Check for HTTP header first
  const headerMatch = /Retry-After:\s*(\d+)/i.exec(output);
  if (headerMatch) {
    const seconds = parseInt(headerMatch[1], 10);
    return Date.now() + seconds * 1000;
  }
  
  // Fall back to text patterns
  return parseResetEpoch(extractResetTime(output), Date.now());
}
```

### Agy (Google Antigravity) Reset Time Formats

**Examples:**
```
quota reset at 2026-05-25T14:30:00Z
next billing cycle: 2026-06-01T00:00:00Z
rate limit reset in 6 hours
available after: 2026-05-25 14:30 UTC
```

**Parser:** ISO 8601 + Relative + Absolute

**Implementation:**
```javascript
function parseAgyResetTime(text) {
  // ISO 8601 timestamps
  const isoMatch = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z/i.exec(text);
  if (isoMatch) {
    const [, y, mo, d, h, mi, s] = isoMatch;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  }
  
  // Fall back to generic parsing
  return parseResetEpoch(extractResetTime(text), Date.now());
}
```

---

## Pattern Detection Examples

### Claude: Rate Limit Message

**Input (terminal output):**
```
Error: Rate limit exceeded.
You've hit your daily usage limit.
Please try again in 2 hours, or upgrade your plan.
```

**Detection:**
```
patternName: "rate_limited"
cliType: "claude"
matchedText: "You've hit your daily usage limit"
```

**Reset time extraction:**
```
extractResetTime() → "2 hours"
parseResetEpoch() → now + 7200000
resetAtEpochMs: [epoch timestamp]
armed: true
```

### Codex: Numeric Selection Prompt

**Input (terminal output):**
```
Which model would you like to use?
[1] codex-large
[2] codex-small
[3] gpt-3.5-turbo

Enter your choice:
```

**Detection:**
```
patternName: "prompt_selection"
cliType: "codex"
matchedText: "[1] codex-large [2] codex-small"
autoResponse: "1"  (from codex profile)
```

**Auto-response:**
```
sendInput(id, "1")
```

### Agy: Approval Before Deployment

**Input (terminal output):**
```
Ready to deploy to production?
Region: us-central1
Service: my-api v2.0.1

Proceed? [y/n]
```

**Detection:**
```
patternName: "approval_needed"
cliType: "agy"
matchedText: "Proceed?"
autoResponse: "y"  (from agy profile)
```

**Auto-response:**
```
sendInput(id, "y")
```

---

## Frontend Display Updates

### Monitor Card Metadata Section

**Before (generic):**
```
⏱ Reset in: 2 hours
```

**After (CLI-aware):**
```
Claude | Tokens: 4,250/10,000 | Cost: $0.45
⏱ Reset in: 2 hours [armed]
```

**HTML:**
```html
<div class="cli-info" id="cli-metadata-{id}">
  <span class="cli-badge">{cliType}</span>
  <span class="cli-stats">{metadata}</span>
</div>
```

### Tab Label

**Before:**
```
#1 claude · /tmp
```

**After (with CLI indicator):**
```
#1 claude🤖 · /tmp
```

**CSS:**
```css
.tab-cli-badge {
  display: inline-block;
  margin-left: 2px;
  font-size: 12px;
  opacity: 0.7;
}
```

---

## Configuration Examples

### Example 1: Default Claude Only

```json
{
  "defaultCommand": "claude",
  "cliProfiles": {
    "claude": { /* ... */ }
  }
}
```

### Example 2: Multi-CLI Setup

```json
{
  "defaultCommand": "claude",
  "cliProfiles": {
    "claude": { /* ... */ },
    "codex": { /* ... */ },
    "agy": { /* ... */ }
  }
}
```

### Example 3: Custom Pattern Override

```json
{
  "cliProfiles": {
    "claude": {
      /* ... default patterns ... */
      "patterns": {
        "rate_limit": [
          "(?:you(?:'re| are) (?:rate.limited|out of (?:free )?uses)|daily limit)",
          "my_custom_limit_pattern"  // ← user-added
        ]
      }
    }
  }
}
```

---

## Testing Checklist

### Unit Tests

- [ ] `detectCliType()` correctly identifies CLI from command string
- [ ] `convertCliProfilePatterns()` transforms config object to regex array
- [ ] `resolveAutoResponse()` returns CLI-specific response
- [ ] `parseResetEpoch()` handles Codex HTTP headers
- [ ] `parseAgyResetTime()` handles ISO 8601 timestamps

### Integration Tests

- [ ] Spawn Claude → detect rate-limit → auto-recover
- [ ] Spawn Codex → detect selection prompt → auto-respond with `"1"`
- [ ] Spawn Agy → detect approval prompt → auto-respond with `"y"`
- [ ] Switch CLI mid-session → patterns update correctly
- [ ] Server restart → CLI profile hydrated from session state

### Manual Tests

- [ ] Run actual Claude CLI; trigger rate-limit; verify reset-time parsing
- [ ] Run actual Codex CLI; verify numeric selection auto-response
- [ ] Run actual Agy CLI; verify approval auto-response
- [ ] Verify metadata extraction (tokens, cost, quotas) displays in UI
- [ ] Test with custom CLI command (generic fallback patterns)

---

## Known Limitations & Future Work

1. **CLI Detection:** Currently relies on command string matching
   - **Future:** Auto-detect CLI from first output (signature lines)

2. **Reset Time Formats:** Limited to common patterns
   - **Future:** Allow regex patterns in CLI profile for custom formats

3. **Metadata Extraction:** Regex-based, may not work for all output formats
   - **Future:** Support structured output (JSON, YAML) if available

4. **Approval Auto-Response:** Always responds "y" (approve)
   - **Future:** Add configurable risk levels (high-risk ops require manual approval)

5. **Cost Tracking:** Display only, no alerts
   - **Future:** Set budget limits, alert when approaching quota

---

## References

- **Claude CLI Docs:** https://docs.claude.ai/cli
- **Codex API Docs:** https://platform.openai.com/docs/api-reference
- **Google Antigravity Docs:** (Google Cloud AI)
- **TmuxHub CLAUDE.md:** Architecture & existing patterns
- **Related Plan:** 2026-05-25-auto-resume-rate-limit-continue.md
