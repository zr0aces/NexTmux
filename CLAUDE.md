# CLAUDE.md

## Project Overview

NexTmux is a web dashboard for managing multiple terminal sessions via tmux. Supports any command (default: `claude`). Built with native Node.js HTTP server + vanilla JS frontend — no frameworks.

## Commands

```bash
npm install          # Install dependencies
npm start            # Start server (default port: 8081)
npm run setup        # Guided setup + launchd service registration (macOS)
npm test             # node --test over tests/*.test.js

# Docker alternative
docker compose up -d
```

Config files: `.env` (PORT, DASHBOARD_PASSWORD, TELEGRAM_BOT_TOKEN, etc.), `config.json` (basePath, favorites, defaultCommand, aiMonitor, tunnel) — both gitignored. Copy from `.env.example` and `config.example.json`.

## Architecture

**Server (`server.js`):** Node.js HTTP + WebSocket server. Acts strictly as a coordinator and request/event router, delegating all worker operations, timer polling, and tunnels to lib/ services.

**Client (`index.html` + `public/`):** Single HTML entry point; all CSS/JS in `public/`. Tab/Split dual layout modes. Real-time updates via WebSocket. localStorage for user preferences.

**JS modules (`public/js/`):**
- `app.js` — Init, login, event binding, keyboard shortcuts
- `store.js` — Client-side worker state store; implements event emitter to decouple network transport from UI rendering
- `workers.js` — Worker card UI, log display, and card actions; reacts to `workerStore` change events
- `ws.js` — WebSocket connection transport, API helpers, terminal resize trigger
- `layout.js` — Layout switching & tab management
- `favorites.js` — Favorites & path management
- `ansi.js` — ANSI escape code renderer for terminal output
- `git-diff.js` — Git diff side-panel (uses diff2html from CDN)

**lib/ modules (server-side):**
- `authService.js` — Session tokens, cookie building, timing-safe password match, per-IP login rate limiting.
- `messageProcessor.js` — Inspects captured output tail: parses selectable prompt options, classifies prompts, resolves auto-responses per CLI profile.
- `worker.js` — State machine for a single worker (CWD, dims, logs, AI status, reset times). Fully I/O-free and unit-testable.
- `sessionManager.js` — Orchestrates active worker Map, poll loops scheduling, recovery, and executes tmux commands.
- `tunnelManager.js` — Manages cloudflared subprocess, extracts URL, loops health checks, and handles auto-restarts.
- `tmuxService.js` — Helper subprocess wrapper for executing tmux commands safely.
- `paneInfoParser.js` — Parser for bulk list-panes outputs to avoid spawning subprocesses per poll.
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
- Midnight-Orange Glassmorphic theme colors (cyber-orange `#ff6b21`, dark void `#04060a`, translucent cards, fonts: Outfit + JetBrains Mono)
- Config precedence: env var → `config.json` → hardcoded default (see `buildMonitorConfig`)
- `state/session-state.json` is auto-created at runtime; gitignored

## Deeper docs

Read the matching doc before acting on that branch:

| Read when | Doc |
|---|---|
| Writing or reviewing any code | `docs/coding-standards.md` |
| Needing module contracts, API surface, or data flow in full | `docs/technical_spec.md` |
| Touching patterns, watcher states, or Telegram alerts | `docs/ai_monitoring.md` |
| Adding or debugging a non-`claude` CLI profile | `docs/multi-cli-support.md`, then `DEVELOPER-REFERENCE.md` |
| Changing install, `.env`, `config.json`, or Docker | `docs/installation.md` |
| Changing dashboard behavior users see | `docs/usage.md` |
| Setting up the local dev loop | `docs/development.md` |

After any refactor, feature, fix, or repo change: update `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` (kept identical except for the agent-workflow section, which only the non-Claude copies carry), plus every doc above the change invalidates.
