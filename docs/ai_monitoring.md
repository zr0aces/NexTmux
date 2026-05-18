# AI State Monitoring & Telegram Alerts

TmuxHub features a real-time supervision engine designed to detect when interactive AI CLIs (such as Claude Code, Codex, aider, or custom shell wrappers) are waiting for user authorization or input.

---

## 🧠 Wait-State Detection Engine

The supervisor actively monitors active tmux panes by capturing and scanning standard outputs. It matches the terminal history against custom regular expressions, enabling the dashboard to dynamically transition worker states:

- 🔵 **Working**: The AI agent is executing tasks, generating code, or compiling logs.
- 🟢 **Idle**: No output has been registered in the terminal for a defined duration.
- 🟡 **Waiting (Action Required)**: The AI has halted and is awaiting keyboard input or tool execution permission.

---

## ⚡ Auto Mode

Auto Mode enables TmuxHub to automatically respond with **"y"** (yes) whenever a worker transitions into the **Waiting** state. This allows long-running AI agents to continue without manual intervention.

### Enabling Auto Mode from the Web UI

Each worker card has an **⚡ Auto** button next to the 👀 AI Monitor toggle in the card header actions bar:

- **⚡ Auto** (amber/yellow) — Auto Mode is **enabled**: the server will automatically send `y` when a prompt is detected.
- **⚡ Manual** (dimmed) — Auto Mode is **disabled**: prompts require manual user input.

Click the button to toggle Auto Mode on or off per worker at any time.

> [!NOTE]
> Auto Mode operates independently of the AI Monitor toggle. The AI Monitor must be enabled for wait-state detection to trigger automatic responses.

> [!WARNING]
> Auto Mode unconditionally sends `y` for all detected wait states, including confirmation and approval prompts. Use with care in workflows where selective approval is important.

---

## ✈️ Outbound Telegram Alerts

To keep you updated on long-running tasks while you are away from your desk, TmuxHub can dispatch instant, debounced Telegram notifications whenever a worker enters the **Waiting** state.

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
    "linesToScan": 120,
    "notifyCooldownMs": 120000,
    "patterns": [
      "(?:Press|Type|Hit)\\s+(?:Enter|any key)\\s+to\\s+continue",
      "Confirm\\s+action|Allow\\s+tool\\s+execution",
      "\\?\\s+Allow\\s+(?:read|write|execute|network|shell)"
    ]
  }
}
```
