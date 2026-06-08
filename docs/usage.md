# User Guide & Dashboard Usage

This guide walks you through logging in, starting session workers, utilizing tmux mirroring, and navigating the TmuxHub dashboard interface.

---

## 🚀 Quick Start Guide

### Step 1: Log in to the Web UI
1. Ensure the server is active (`npm start` or via background daemon).
2. Open your browser and navigate to: **`http://localhost:8081`**
3. Enter the configured dashboard password (`DASHBOARD_PASSWORD`).
4. (Optional) Check **Remember Password** to bypass this screen automatically on subsequent visits.

> [!NOTE]
> Remember Password uses WebCrypto-backed encrypted browser storage. If WebCrypto is unavailable, credentials are not persisted.

### Step 2: Start Your First Tmux-Backed Session
1. Click the **+** (New Session) button in the navigation header.
2. Enter the **Working Directory** (you can type a custom path or quickly select one from your **Favorites** or **Recent Paths**).
3. Specify your **Command** (defaults to `claude`; supports `bash`, `python`, or any custom CLI tool).
4. Click **+ New**.

This will spawn an isolated tmux session named `term-{id}` (e.g., `term-1`) running under a dedicated TmuxHub worker process.

### Step 3: Manage Active Workflows
- **Terminal Logs & Scroll Lock**: Watch live output streaming directly from the active tmux pane inside the high-density log viewer. If you scroll up to inspect previous output, the log view automatically locks its scroll position so new log lines do not jar or force-scroll your view. Scrolling back to the bottom automatically unlocks and resumes auto-scroll.
- **Command Input**: Type commands inside the lower prompt input field and press **Send** (or Enter) to feed them straight into the tmux stdin.
- **Mechanical Toolkit (Keyboard Icon)**: Click the **⌨** keyboard button to reveal standard key shortcuts (`esc`, `↑`, `↓`, `↵`, `tab`, `⇧tab`, `⌃c`) plus quick command buttons (`proceed`, `continue`, `yes`) for fast manual interaction.
- **Git Diff Inspector**: Click the **Diff** action pill on any session card to review real-time git state and inspect local changes in that worker's active directory.
- **Tab & Split Views**: Toggle between **Tab** view (for clean, focused, single-pane work) and **Split** view (to monitor multiple concurrent terminal tasks side-by-side).
- **Persistent Tab Selection**: The active session tab is saved to `localStorage`. After a page refresh or server restart, the dashboard restores the previously selected session automatically — recovery does not hijack your current view.
- **tmux Attached Indicator**: A green ring appears on the tab dot and AI state badge whenever a native tmux client is actively attached to that session (e.g. after running `tmux attach -t term-1`). The indicator updates within 3 seconds of attach or detach.

---

## 🔄 Two-Way Terminal Mirroring

Because TmuxHub is backed directly by native `tmux` sessions, you can attach, view, and interact with active session workers from both the Web UI and your local machine simultaneously.

### Finding Running Sessions

You can list all active terminal sessions created by TmuxHub using the CLI:

```bash
tmux ls
```

### Attaching via Local Terminal

To attach your local terminal client directly to an active TmuxHub card (e.g., `term-1`):

```bash
tmux attach -t term-1
```

> [!TIP]
> To exit/disconnect from the local terminal view without shutting down the dashboard's worker process, type the standard tmux escape sequence:
> `Ctrl+b` followed by `d` (or run `tmux detach-client`).

---

## 🔍 Attaching Already-Running Sessions

Have some terminal workflows that were started outside of TmuxHub? You can sync them with the dashboard in two simple steps:

1. Click the **🔍 Scan** button in the header bar.
2. Confirm the auto-discovered running tmux sessions.
3. They will immediately appear as active worker cards on your web dashboard, ready to be controlled!

---

## 🛑 Session Lifecycle Management

Each session card in your workspace supports several operations:
- **Stop**: Safely terminates the running worker session and sends SIGINT/SIGKILL to running subprocesses.
- **Reconnect**: Re-attaches to the tmux backend if a socket disconnect occurs or if a stopped worker needs to be brought back online.
- **Remove**: Deletes a completed or stopped session card from your active dashboard layout (does not delete files on disk).
