# TermHub

[한국어](README.ko.md)

A web dashboard for managing multiple terminal sessions via tmux. Run any command — Claude CLI, bash, python, or anything else — and monitor them all from one place.

If you find it useful, feel free to give it a star on GitHub.

## Project Status

TermHub is actively developed and may contain bugs or rough edges.
If you hit an issue, please open an issue with steps to reproduce.
Contributions and bug reports are very welcome.

## Features

- **Run any command** — spawn sessions with any CLI tool (default: `claude`)
- **Multiple terminal sessions** — each runs as an independent worker in a tmux session
- **Real-time logs** — captures and displays tmux output in real time
- **AI state detection** — automatically detects AI CLI state from terminal output:
  - 🔵 Working → 🟢 Idle → 🟡 Waiting (permission needed)
- **Telegram wait alerts** — sends outbound notifications when an AI CLI is waiting for human input
- **Two-way mirroring** — view the same session from both the dashboard and your local terminal

### More

- **tmux session scanning** — auto-detect and attach to existing sessions
- **Tab / Split layout** — Tab mode for focus, Split mode for side-by-side
- **Favorites & recent paths** — quick access to frequently used directories
- **Password auth + external tunnels** — Cloudflare (recommended) or ngrok for remote access
- **Adaptive terminal size** — tmux resizes to match your screen
- **Keyboard shortcuts** — Esc, Shift+Tab, Ctrl+C, arrow keys forwarded to active worker

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- [tmux](https://github.com/tmux/tmux)
- Optional for remote access:
  - [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (recommended)
  - [ngrok](https://ngrok.com)

## Deployment & Setup

### 1) Clone and install

```bash
git clone https://github.com/zr0aces/TmuxHub.git
cd TmuxHub
npm install
```

### 2) Create runtime config files

```bash
cp .env.example .env
cp config.example.json config.json
```

Minimum required `.env` values:

```env
PORT=8081
DASHBOARD_PASSWORD=replace-with-a-strong-password
```

> Notes:
> - If `PORT` is not set, the server default is `8081`.
> - The helper setup script currently prompts with `8080`; update `.env` afterward if you want `8081`.

Recommended `config.json` starter:

```json
{
  "basePath": "/absolute/path/for/projects",
  "favorites": [
    "/absolute/path/for/projects/project-a"
  ],
  "defaultCommand": "claude",
  "tunnel": { "enabled": true }
}
```

### 3) Start TermHub

```bash
npm start
```

Open the Web UI at:

```text
http://localhost:8081
```

---

## Environment-specific installation

### macOS (manual)

```bash
brew install node tmux
npm install
cp .env.example .env
cp config.example.json config.json
npm start
```

### macOS (guided setup + launchd service)

```bash
npm run setup
```

The script checks dependencies, creates `.env` + `config.json`, and registers `com.termhub.server` in launchd.

Service management:

```bash
launchctl unload ~/Library/LaunchAgents/com.termhub.server.plist   # Stop
launchctl load ~/Library/LaunchAgents/com.termhub.server.plist     # Start
cat /tmp/termhub.log                                                # Logs
```

### Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y nodejs npm tmux
npm install
cp .env.example .env
cp config.example.json config.json
npm start
```

### Docker Compose (optional)

```bash
cp .env.example .env
cp config.example.json config.json
docker compose up -d
```

By default, Compose publishes `8081:8081` (see `docker-compose.yml`).

---

## Remote access (optional)

### Cloudflare Tunnel (recommended)

Install cloudflared:

```bash
brew install cloudflared
# or see official install docs for Linux packages
```

If `cloudflared` is available in `PATH`, TermHub auto-starts a tunnel unless disabled.

- Disable with `.env`: `ENABLE_TUNNEL=0`
- Or with `config.json`: `"tunnel": { "enabled": false }`

Tunnel URL visibility:
- server log (`☁️ Tunnel URL → https://...`)
- `GET /api/tunnel`
- WebSocket broadcast to connected clients

Optional Discord notification:

```env
DISCORD_WEBHOOK=https://discord.com/api/webhooks/your/webhook-url
```

### ngrok (manual tunnel)

```bash
ngrok config add-authtoken <your-token>
ngrok http 8081
```

Open the generated `https://...ngrok...` URL.

## Usage (new user quick guide)

### Step 1: Log in to the Web UI
1. Start the server (`npm start`)
2. Open `http://localhost:8081`
3. Enter `DASHBOARD_PASSWORD`
4. (Optional) enable **Remember Password**

### Step 2: Start your first tmux-backed session
1. Click **+** in the header
2. Set **Working directory** (type path or choose from favorites/recent)
3. Set **Command** (for example: `claude`, `bash`, `python`)
4. Click **+ New**

This creates a tmux session named `term-{id}` (for example, `term-1`).

### Step 3: Manage active workflows
- Send commands in the input box or keyboard toolkit
- Watch live output in the log pane
- Use **Tab / Split** mode depending on focus vs multi-session monitoring
- Click **Diff** to inspect git changes in the worker directory

### Step 4: Attach already-running tmux sessions
1. Click **🔍 Scan**
2. Confirm discovered sessions
3. Continue managing them from the dashboard

### Step 5: Use tmux directly from terminal when needed

```bash
tmux ls
tmux attach -t term-1
tmux detach-client
```

### Step 6: Stop or clean up sessions
- **Stop**: terminate a running worker session
- **Reconnect**: reattach if the session is still alive
- **Remove**: remove a stopped/completed worker card from UI

## AI wait-state monitoring

TermHub supervises tmux sessions and detects wait prompts from Claude Code, Codex CLI, Gemini CLI, aider, and similar workflows using configurable regex rules.

- Configurable polling interval and scan depth
- Configurable regex patterns (`config.json` → `aiMonitor.patterns`)
- Debounced outbound Telegram notifications (outbound only — no callback buttons)
- Per-worker metadata row in each card:
  - last activity timestamp
  - last matched prompt/pattern
  - last notification status and time

### Telegram notifications

Set these two variables in `.env` to enable outbound alerts:

```env
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_CHAT_ID=<chat-id>
```

If Telegram variables are not set, wait detection still works in the UI — only the notification step is skipped safely.

### Tuning the monitor

All settings are optional. Defaults work out of the box.

| Variable | Default | Description |
|---|---|---|
| `AI_MONITOR_ENABLED` | `1` | Set `0` to disable monitoring entirely |
| `AI_MONITOR_POLL_INTERVAL_MS` | `1000` | tmux pane capture interval (ms) |
| `AI_MONITOR_IDLE_THRESHOLD_MS` | `5000` | No-output duration before marking idle (ms) |
| `AI_MONITOR_LINES_TO_SCAN` | `120` | Recent lines inspected for patterns |
| `AI_MONITOR_NOTIFY_COOLDOWN_MS` | `120000` | Debounce window between repeat alerts (ms) |

You can also override all of these via `config.json` → `aiMonitor` object (see `config.example.json`).

## Docker Compose (optional)

An optional `docker-compose.yml` is included for lightweight deployment:

```bash
docker compose up -d
```

Notes:
- Compose mounts `./state` to persist monitoring metadata snapshots.
- `tmux` must be available in the same runtime namespace where sessions are monitored.
- TermHub must be able to see the tmux socket/session namespace it supervises.

## File Structure

```
termhub/
├── server.js              # Node.js server (tmux management, WebSocket)
├── index.html             # Web UI entry point
├── setup.sh               # One-step setup script
├── lib/
│   ├── patternEngine.js   # Regex wait-state detection
│   ├── watcherEngine.js   # Poll loop + state transitions
│   ├── telegramService.js # Outbound Telegram notifications
│   └── sessionStateManager.js  # Metadata + debounce + persistence
├── public/
│   ├── style.css          # Styles
│   └── js/
│       ├── layout.js      # Layout & tab management
│       ├── favorites.js   # Favorites & path management
│       ├── ws.js          # WebSocket & API communication
│       ├── workers.js     # Worker card UI & actions
│       └── app.js         # Init & event binding
├── state/
│   └── session-state.json # Runtime monitoring metadata snapshot (auto-created)
├── config.json            # User config (gitignored)
├── config.example.json    # Config template
├── .env                   # Environment variables (gitignored)
├── .env.example           # Environment variable template
├── docker-compose.yml     # Optional Docker deployment
├── .gitignore
├── package.json
└── README.md
```

## License

MIT
