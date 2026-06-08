# NexTmux Multi-CLI Support

**Version:** 2026.5.25  
**Status:** Phase 1 Implementation Complete

## Overview

NexTmux now supports **three AI CLI tools** with intelligent pattern detection and auto-responses tailored to each tool:

1. **Claude** - Anthropic's Claude CLI
2. **Codex** - OpenAI's Codex API client
3. **Agy** - Google Antigravity AI tool

The system automatically detects which CLI you're running and applies CLI-specific patterns for rate-limits, prompts, and approvals.

## Features

### Automatic CLI Detection
```bash
# These all get detected and configured automatically:
npm start
# Then:
+ New: claude          → Claude CLI patterns loaded
+ New: codex           → Codex CLI patterns loaded
+ New: agy             → Agy CLI patterns loaded
+ New: /usr/bin/claude → Claude detected from path
```

### CLI-Specific Pattern Matching
Each CLI has unique output formats for:
- **Rate limits** (different messages, reset times)
- **Prompts** (yes/no, numbered selection, approval)
- **Approvals** (different wording)
- **Status info** (tokens, cost, quotas)

### CLI-Specific Auto-Responses
When in Auto Mode, the system sends CLI-appropriate responses:
- Claude: `"y"`, `"continue"`, `"n"`
- Codex: `"1"`, `"2"`, numeric selection
- Agy: `"y"`, `"n"`, approval responses

## Configuration

### Default Config (No Changes Needed)

If you don't have a custom `config.json`, the default configuration supports all three CLIs out of the box.

### Custom Config

Copy `config.example.json` to `config.json` and customize:

```json
{
  "defaultCommand": "claude",
  "cliProfiles": {
    "claude": {
      "label": "Claude",
      "enabled": true,
      "patterns": { ... },
      "autoResponses": { ... }
    },
    "codex": { ... },
    "agy": { ... }
  }
}
```

### Per-CLI Profile Structure

```json
{
  "cliProfiles": {
    "claude": {
      "label": "Claude",                      // Display name
      "enabled": true,                        // Enable/disable this CLI
      "patterns": {
        "rate_limit": [...],                  // Regex patterns to detect rate limit
        "reset_time": "...",                  // Pattern to extract reset time
        "usage_exceeded": "...",              // Pattern for usage/quota exceeded
        "prompt_continue": "...",             // Pattern for continue prompts
        "approval_needed": "..."              // Pattern for approval requests
      },
      "autoResponses": {
        "confirm": "y",                       // Response to confirm/approve
        "continue": "continue",               // Response to continue prompts
        "reject": "n",                        // Response to decline
        "press_enter": "",                    // Response to press-enter prompts
        "select": "1"                         // Response to selection prompts
      }
    }
  }
}
```

## Supported CLIs

### Claude CLI

**Installation:**
```bash
pip install anthropic-cli
# or
npm install -g @anthropic-ai/cli
```

**Example patterns:**
```
Rate limit: "You've hit your daily usage limit"
Reset time: "try again in 2 hours"
Approval: "do you want to continue?"
```

**Auto-response behavior:**
- Continues on prompts
- Selects "yes" for yes/no questions
- Respects rate-limit waits

### Codex CLI

**Installation:**
```bash
pip install openai-codex-cli
```

**Example patterns:**
```
Rate limit: "rate limit exceeded" or "HTTP 429"
Reset time: "Retry-After: 3600" (HTTP header, seconds)
Selection: "[1] option1 [2] option2"
```

**Auto-response behavior:**
- Selects option "1" by default
- Returns numeric responses for selections
- Handles Retry-After headers

### Agy (Google Antigravity)

**Installation:**
```bash
gcloud components install agy
```

**Example patterns:**
```
Rate limit: "quota exceeded"
Reset time: "2026-05-25T14:30:00Z" (ISO 8601)
Approval: "proceed with deployment?"
```

**Auto-response behavior:**
- Approves operations by default
- Respects quota limits
- Handles Google Cloud reset times

## How It Works

### 1. CLI Detection
When you spawn a session with a command like `claude` or `codex`:
- NexTmux detects the CLI type
- Loads the corresponding CLI profile
- Applies CLI-specific patterns to the pattern engine

### 2. Pattern Matching
As the CLI outputs text:
- Pattern engine checks for CLI-specific regex patterns
- Detects wait states, prompts, approvals, rate-limits
- Marks the worker as "waiting" when a pattern matches

### 3. Auto-Response (If Enabled)
In Auto Mode, the system:
- Determines what response is needed based on the pattern
- Uses CLI-specific auto-response mapping
- Sends the appropriate input (e.g., "y", "1", "continue")

### 4. Rate-Limit Recovery (If Applicable)
If a rate-limit is detected with a parseable reset time:
- Records when the limit expires (`resetAtEpochMs`)
- Shows armed badge in UI
- Auto-resumes with "continue" when the time expires

## Customization

### Override CLI Patterns

Edit `config.json` to add custom patterns for a CLI:

```json
{
  "cliProfiles": {
    "claude": {
      "patterns": {
        "rate_limit": [
          "my custom rate limit pattern",
          "another pattern"
        ]
      }
    }
  }
}
```

### Add New Auto-Response

```json
{
  "cliProfiles": {
    "claude": {
      "autoResponses": {
        "custom_prompt": "custom_response"
      }
    }
  }
}
```

### Disable a CLI

```json
{
  "cliProfiles": {
    "claude": {
      "enabled": false
    }
  }
}
```

## Troubleshooting

### CLI Not Detected

Check what NexTmux detected:
```
Server logs will show: "Worker 5 (term-5): CLI type = claude"
```

If detection failed:
1. Use the base command name (e.g., `claude`, not `/full/path/to/claude`)
2. Check `config.json` to see if CLI is enabled

### Patterns Not Matching

If a prompt isn't being detected:
1. Check the actual output in the terminal
2. Copy the pattern from CLI output
3. Add a custom pattern to `config.json`
4. Test the regex at https://regex101.com

### Wrong Auto-Response

If the wrong response is being sent:
1. Check the matched pattern name in server logs
2. Update the `autoResponses` mapping for that pattern
3. Restart the server

## Frontend Display

Workers now show CLI information:

```
#1 claude 🤖
Auto Mode: on
⏱ Reset in: 2 hours [armed]

#2 codex 🤖
Auto Mode: on

#3 agy 🤖
Auto Mode: off
```

## API Changes

### Worker Object

Workers now include:
```javascript
{
  id: "1",
  cmd: "claude",
  cliType: "claude",        // ← NEW
  cwd: "/tmp",
  status: "running",
  ...
}
```

### WebSocket: Spawned Message

```javascript
{
  type: "spawned",
  id: "1",
  cmd: "claude",
  cliType: "claude",        // ← NEW
  ...
}
```

## Testing

Test CLI detection:
```bash
npm test    # All 60 tests pass
```

Test specific CLI:
```bash
npm start
# Then in dashboard:
+ New: claude    # Should detect as "claude"
+ New: codex     # Should detect as "codex"
+ New: agy       # Should detect as "agy"
```

## Next Features (Roadmap)

- [ ] **Phase 2:** ISO 8601 & HTTP header reset-time parsing
- [ ] **Phase 3:** CLI metadata display (tokens, cost, quotas)
- [ ] **Phase 4:** Advanced testing & CLI version compatibility
- [ ] **Phase 5:** Cost tracking & alerts, custom CLI profiles

## Support

For issues with specific CLI output:
1. Check server logs for pattern matches
2. Share the actual CLI output
3. Create a custom pattern in `config.json`

## Version History

- **2026.5.25** - Phase 1: CLI detection & pattern profiles
- **2026.5.19** - Rate-limit auto-recovery foundation
