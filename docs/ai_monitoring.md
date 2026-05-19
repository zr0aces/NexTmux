# AI State Monitoring & Telegram Alerts

TmuxHub features a real-time supervision engine designed to detect when interactive AI CLIs (such as Claude Code, Codex, aider, or custom shell wrappers) are waiting for user authorization or input.

---

## 🧠 Wait-State Detection Engine

The supervisor actively monitors active tmux panes by capturing and scanning standard outputs. It matches the terminal history against custom regular expressions, enabling the dashboard to dynamically transition worker states:

- 🔵 **Working**: The AI agent is executing tasks, generating code, or compiling logs.
- 🟢 **Idle**: No output has been registered in the terminal for a defined duration.
- 🟡 **Waiting (Action Required)**: The AI has halted and is awaiting keyboard input or tool execution permission.

---

## 🎛️ Monitor Mode Selector

Each worker now uses a single mode selector with three states:

- **Off** — AI supervision is disabled.
- **Monitor Only** — Detects wait states and sends Telegram alerts, but never sends terminal input.
- **Auto Mode** — Includes monitoring + alerts, auto-responds with **`y`** (or **`1`** when prompts show `1. yes`), and auto-selects rate-limit option **`1. Stop and wait for limit to reset`** when available.

### Mode Behavior Notes

- Monitoring mode is now unified in one control (`Off`, `Monitor Only`, `Auto Mode`).
- `proceed`/`continue` are no longer auto-response behaviors; use Virtual Keyboard quick commands for those manual actions.
- Auto Mode sends yes-style responses (`y` or `1` for `1. yes` list prompts), and for `/rate-limit-options` it picks `1` to wait for reset.
- When a rate limit reset time is detected (for example: `resets 10:20am (Asia/Bangkok)`), the tooltip and Telegram notification include that reset time.
- Auto Mode deduplicates repeated prompt detections to avoid sending the same answer repeatedly on noisy waiting screens.

---

## ✈️ Outbound Telegram Alerts

To keep you updated on long-running tasks while you are away from your desk, TmuxHub dispatches Telegram notifications when workers enter the **Waiting** state.

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
