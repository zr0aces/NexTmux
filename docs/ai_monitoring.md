# AI State Monitoring & Telegram Alerts

NexTmux features a real-time supervision engine designed to detect when interactive AI CLIs (such as Claude Code, Codex, aider, or custom shell wrappers) are waiting for user authorization or input.

---

## 🧠 Wait-State Detection Engine

The supervisor actively monitors active tmux panes by capturing and scanning standard outputs. It matches the terminal history against custom regular expressions, enabling the dashboard to dynamically transition worker states:

- 🔵 **Working**: The AI agent is executing tasks, generating code, or compiling logs.
- 🟢 **Idle**: No output has been registered in the terminal for a defined duration.
- 🟡 **Waiting (Action Required)**: The AI has halted and is awaiting keyboard input or tool execution permission.

### Advanced Prompt & Option Analysis
In addition to the regex pattern matching, the engine runs standard terminal outputs through a dedicated **Message Processor** (`lib/messageProcessor.js`) to parse structural cues and interactive options. This includes:
- **Yes/No prompts**: Matches `[y/N]` or `yes/no` questions.
- **Selectable Lists**: Parses standard lists (e.g., `[1] Option`, `1. Option`, `1) Option`) to extract choices.
- **Press Enter prompts**: Recognizes "press/hit enter to continue" style requests.
- **Confirmation dialogs**: Detects explicit confirmation requests (`continue?`, `proceed?`, `approve?`, `confirm?`).

---

## 🎛️ Monitor Mode Selector

Each worker uses a single mode selector with three states:

- **Off** — AI supervision is disabled.
- **Monitor Only** — Detects wait states and sends Telegram alerts, but never sends terminal input.
- **Auto Mode** — Includes monitoring + alerts, auto-responds with **`y`** (or **`1`** when prompts show `1. yes`), and auto-selects rate-limit option **`1. Stop and wait for limit to reset`** when available.

### Mode Behavior Notes

- Monitoring mode is unified in one control (`Off`, `Monitor Only`, `Auto Mode`).
- `proceed`/`continue` are no longer auto-response behaviors; use Virtual Keyboard quick commands for those manual actions.
- Auto Mode sends yes-style responses (`y` or `1` for `1. yes` list prompts), and for `/rate-limit-options` it picks `1` to wait for reset.
- When a rate limit reset time is detected (for example: `resets 10:20am (Asia/Bangkok)`), the tooltip and Telegram notification include that reset time.
- Auto Mode deduplicates repeated prompt detections to avoid sending the same answer repeatedly on noisy waiting screens.

---

## ♻️ Rate-Limit Auto-Recovery

When the monitoring engine detects a rate limit wait-state (such as `"usage limit reached"` or `"token limit reached"`), it extracts the expected reset time and schedules an automatic recovery.

### 1) Reset Time Parsing & Timezones
The server parses relative durations and absolute timestamps into a concrete UTC epoch millisecond timestamp (`resetAtEpochMs`) using `lib/patternEngine.js`:
- **Relative Durations**: Parse combinations like `2 hours`, `3h 15m`, `45 minutes`, `1 day`, or `90s`.
- **Absolute Times**: Parse standard time formats (e.g., `11:00 AM`, `15:30`) with timezones.
- **Timezone Support**: Supports standard abbreviations (`UTC`, `GMT`, `EST`, `PST`, `PDT`, etc.), UTC offsets (`UTC+5`, `UTC-8`), and full IANA timezones (such as `Asia/Bangkok`, e.g., `12:20am (Asia/Bangkok)`).

### 2) State & Persistence
- **State File**: The recovery epoch is persisted across server restarts inside `state/session-state.json`.
- **Startup Recovery**: If the server restarts and the reset time has already passed, the recovery guard triggers on the first poll loop.

### 3) UI Indicators (`[armed]`)
- On the dashboard, workers waiting for a rate limit reset will show a blue-grey indicator badge: `⏱ Reset in: <time> [armed]` (using color `#58a6ff`).
- If the reset time cannot be parsed automatically, the indicator stays amber `⏱ Reset in: <time>` (without `[armed]`) to indicate display-only status.

### 4) Automatic Resumption
Once the epoch is reached:
- The worker's state transitions from `waiting` back to `running`.
- If the worker is in **Auto Mode**, NexTmux automatically inputs `"continue"` into the tmux session, prompting the AI agent (e.g., Claude Code) to resume execution.

---

## ✈️ Outbound Telegram Alerts

To keep you updated on long-running tasks while you are away from your desk, NexTmux dispatches Telegram notifications when workers enter the **Waiting** state.

Duplicate wait-state messages are deduplicated and only sent once per unique message content.

### Enabling Telegram Notifications

Add the following environment variables to your local `.env` configuration file:

```env
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_CHAT_ID=your-telegram-chat-id
```

> [!NOTE]
> If these variables are omitted, wait-state detection will still display active visual cues on the web UI dashboard, but outbound notifications will be safely bypassed.

---

## ⚙️ Tuning the Monitor

You can tune the sensitivity, polling frequencies, and alert cooldowns of the monitoring system using `.env` variables or by nesting an `aiMonitor` object in your `config.json`.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AI_MONITOR_ENABLED` | `1` | Set to `0` to completely disable terminal supervision |
| `AI_MONITOR_POLL_INTERVAL_MS` | `1000` | Frequency of active tmux pane screen captures (ms) |
| `AI_MONITOR_IDLE_THRESHOLD_MS` | `5000` | Inactivity duration before marking a working pane as idle (ms) |
| `AI_MONITOR_LINES_TO_SCAN` | `120` | Maximum vertical line scope scanned for regex matches |
| `AI_MONITOR_NOTIFY_COOLDOWN_MS` | `120000` | Alert cooldown duration to avoid spamming alerts (ms) |

### JSON Configuration Example (`config.json`)

To override defaults via configuration file, add an `"aiMonitor"` block:

```json
{
  "aiMonitor": {
    "enabled": true,
    "pollIntervalMs": 1000,
    "idleThresholdMs": 5000,
    "linesToInspect": 120,
    "notifyCooldownMs": 120000,
    "patterns": [
      { "name": "continue", "regex": "continue\\?" },
      { "name": "confirmation", "regex": "\\[y/N\\]" },
      { "name": "token_limit", "regex": "token limit reached" }
    ]
  }
}
```
