# TmuxHub

[한국어](README.ko.md)

A web dashboard for managing multiple terminal sessions via tmux. Run any command — Claude CLI, bash, python, or anything else — and monitor them all from one place.

If you find it useful, feel free to give it a star on GitHub!

---

## 🌟 Features

- **Run Any Command** — Spawn isolated worker cards for any CLI tool (defaults to `claude`).
- **Interactive Multi-Pane Dashboard** — View and manage multiple sessions concurrently.
- **Two-Way Terminal Mirroring** — Real-time bidirectional session attachments between the Web UI and local terminals.
- **Automated AI State Detection** — Watches shell output to detect AI CLI status:
  - 🔵 Working → 🟢 Idle → 🟡 Waiting (Action Needed)
- **Telegram & Discord Alerts** — Outbound webhook alerts when an AI CLI halts and requires human permission.
- **Quick Controls** — Split/Tab layout toggles, favorites directory access, and an integrated virtual developer keyboard.

---

## 📋 Prerequisites

- **[Node.js](https://nodejs.org) 22+**
- **[tmux](https://github.com/tmux/tmux)**

---

## 🚀 Quick Start (Minimal Setup)

### 1. Clone & Install
```bash
git clone https://github.com/zr0aces/TmuxHub.git
cd TmuxHub
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
cp config.example.json config.json
```
Ensure your `.env` contains a secure entry password:
```env
PORT=8081
DASHBOARD_PASSWORD=your-secret-password-here
```

### 3. Launch Server
```bash
npm start
```
Open your browser at **`http://localhost:8081`** to log in!

---

## 📚 Detailed Documentation

Detailed deployment guides and configurations have been moved to the [docs/](file:///home/san/workspace/TmuxHub/docs) directory:

* **[Installation & Deployment Guide](docs/installation.md)** — Step-by-step setup guides for macOS daemon (`launchd`), Ubuntu/Debian services, Docker Compose setups, and Cloudflare Secure Tunnels.
* **[User Guide & Dashboard Usage](docs/usage.md)** — Learn how to log in, scan/attach existing sessions, leverage bidirectional mirroring, and interact with the virtual mechanical keyboard.
* **[AI State Monitoring & Alerts Setup](docs/ai_monitoring.md)** — Setup guide for configuring Telegram outbound alerts, tuning idle thresholds, and modifying regex patterns.

---

## 📂 File Structure

```text
tmuxhub/
├── docs/                  # Detailed documentation guides
│   ├── installation.md    # Environments, systemd/launchd, tunnels
│   ├── usage.md           # Dashboard user guide & tmux commands
│   └── ai_monitoring.md   # Supervision engine & Telegram setup
├── server.js              # Node.js server (tmux management, WebSocket)
├── index.html             # Web UI entry point
├── setup.sh               # One-step macOS setup script
├── lib/
│   ├── patternEngine.js   # Regex wait-state detection
│   ├── watcherEngine.js   # Poll loop + state transitions
│   ├── telegramService.js # Outbound Telegram notifications
│   └── sessionStateManager.js # Metadata persistence & debouncing
├── public/
│   ├── style.css          # Styles
│   └── js/
│       ├── layout.js      # Layout & tab management
│       ├── favorites.js   # Favorites & path management
│       ├── ws.js          # WebSocket communication
│       ├── workers.js     # Worker card UI rendering
│       └── app.js         # Init & event binding
├── config.example.json    # User config template
└── .env.example           # Environment variables template
```

---

## 🤝 Thanks

Special thanks to the original creator [sunmerrr/TermHub](https://github.com/sunmerrr/TermHub) for the inspiration and foundation of this project.

---

## 📄 License

MIT
