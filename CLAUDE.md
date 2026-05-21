# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TmuxHub is a web dashboard for managing multiple terminal sessions via tmux. Supports any command (default: `claude`). Built with native Node.js HTTP server + vanilla JS frontend — no frameworks.

## Commands

```bash
npm install          # Install dependencies
npm start            # Start server (default port: 8081)
npm run setup        # Guided setup + launchd service registration (macOS)

# Docker alternative
docker compose up -d
```

Config files: `.env` (PORT, DASHBOARD_PASSWORD, TELEGRAM_BOT_TOKEN, etc.), `config.json` (basePath, favorites, defaultCommand, aiMonitor, tunnel) — both gitignored. Copy from `.env.example` and `config.example.json`.

## Architecture

**Server (`server.js`):** Single-file Node.js HTTP + WebSocket server (~1200 lines). In-memory `sessions` and `workers` Maps for state. Calls tmux via `execFileSync` (user-supplied values) or `execSync` (safe static strings). Polls terminal output every 1s and broadcasts via WebSocket.

**Client (`index.html` + `public/`):** Single HTML entry point; all CSS/JS in `public/`. Tab/Split dual layout modes. Real-time updates via WebSocket. localStorage for user preferences.

**JS modules (`public/js/`):**
- `app.js` — Init, login, event binding, keyboard shortcuts
- `workers.js` — Worker card UI, log display, worker actions
- `ws.js` — WebSocket connection, API helpers, terminal resize
- `layout.js` — Layout switching & tab management
- `favorites.js` — Favorites & path management
- `ansi.js` — ANSI escape code renderer for terminal output
- `git-diff.js` — Git diff side-panel (uses diff2html from CDN)

**lib/ modules (server-side):**
- `patternEngine.js` — Compiles regex patterns and scans terminal output for AI wait-states (returns `matched`, `patternName`, `excerpt`)
- `watcherEngine.js` — State machine: `running` → `idle` → `waiting` based on output changes + idle threshold
- `sessionStateManager.js` — Persists per-worker metadata to `state/session-state.json`; handles notification debounce
- `telegramService.js` — Outbound Telegram alerts when a worker enters `waiting` state

**Communication flow:**
- REST API (`/api/*`): login, worker spawn/remove/input/stop, scan, diff, tunnel, config
- WebSocket: server→client broadcast (`spawned`, `status`, `snapshot`, `log`, `cwd`, `tunnel` message types)
- Auth: password login → `crypto.randomBytes(32)` token → HttpOnly cookie; rate-limited per IP

**tmux integration:**
- Session name: `term-{id}` (validated via `sanitizeSessionName` allowlist regex)
- Create: `tmux new-session -d -s {name} -c {cwd} "{cmd}"`
- Capture: `tmux capture-pane -p -S -500 -J` (500 lines, 1s interval)
- Input: `tmuxExec("send-keys", ...)` — always use `tmuxExec` (not `tmux()`) for user-supplied values
- CWD tracking: `tmux display-message -p "#{pane_current_path}"`

**AI monitoring pipeline:**
1. Poll loop captures tmux pane output per worker
2. `watcherEngine.inspect()` determines next state (`running`/`idle`/`waiting`)
3. On `waiting`: `sessionStateManager` checks debounce, then `telegramService` sends alert
4. Patterns are configurable via `config.json → aiMonitor.patterns` (default patterns in `lib/patternEngine.js`)

## Key Conventions

- Minimal dependencies: only `dotenv`, `ws` (npm); `diff2html` loaded from CDN in browser
- Worker IDs: auto-incrementing integers; session names `term-{id}`
- API endpoints: `/api/{resource}`
- DOM element IDs: `{type}-{id}` (e.g. `card-1`, `logs-1`, `inp-1`)
- Static files served from `public/`
- GitHub dark theme colors (`#0d1117`, `#161b22`, `#e6edf3`)
- Config precedence: env var → `config.json` → hardcoded default (see `buildMonitorConfig`)
- `state/session-state.json` is auto-created at runtime; gitignored
