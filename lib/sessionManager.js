"use strict";
// ── sessionManager.js ──
// Manages the lifecycle, scheduling, state monitoring, and recovery of all
// tmux-backed workers. Decouples the HTTP router from state machine mutations
// and background poll loops.

const { createWorker, getBaseCommand } = require("./worker");
const { sanitizeSessionName, tmuxExec, tmuxExecAsync, isAlive, resolveSessionId } = require("./tmuxService");
const { parseGlobalPaneInfo } = require("./paneInfoParser");

class SessionManager {
  constructor({
    monitorConfig,
    appConfig,
    watcherEngine,
    sessionStateManager,
    telegramService,
    onEvent = () => {},
    extractResetTime,
    parseResetEpoch,
    cleanRateLimitLine,
    getNewLinesCount,
    RATE_LIMIT_PATTERNS,
  } = {}) {
    this.monitorConfig = monitorConfig;
    this.appConfig = appConfig;
    this.watcherEngine = watcherEngine;
    this.sessionStateManager = sessionStateManager;
    this.telegramService = telegramService;
    this.onEvent = onEvent;

    // Worker dependencies
    this.extractResetTime = extractResetTime;
    this.parseResetEpoch = parseResetEpoch;
    this.cleanRateLimitLine = cleanRateLimitLine;
    this.getNewLinesCount = getNewLinesCount;
    this.RATE_LIMIT_PATTERNS = RATE_LIMIT_PATTERNS;

    this.workers = new Map();
    this.nextId = 1;
    this.globalPaneInfo = new Map();
    this.updatingPaneInfo = false;
  }

  // ── Private / Internal Helpers ─────────────────────────────────────────────

  _makeWorkerDeps() {
    return {
      watcherEngine: this.watcherEngine,
      sessionStateManager: this.sessionStateManager,
      telegramService: this.telegramService,
      monitorConfig: this.monitorConfig,
      extractResetTime: this.extractResetTime,
      parseResetEpoch: this.parseResetEpoch,
      cleanRateLimitLine: this.cleanRateLimitLine,
      getNewLinesCount: this.getNewLinesCount,
      RATE_LIMIT_PATTERNS: this.RATE_LIMIT_PATTERNS,
      onAsyncEvent: (event) => this.onEvent(event),
    };
  }

  /** Start polling for a worker. */
  _startPolling(id) {
    const worker = this.workers.get(String(id));
    if (!worker) return;
    worker.startPolling(() => this._pollOutput(id), this.monitorConfig.pollIntervalMs);
  }

  /** Execute worker events, executing internal directives and forwarding public ones. */
  _dispatchEvents(id, events) {
    for (const e of events) {
      if (!e || !e.type) continue;
      if (e.type === "_tmux_resize") {
        tmuxExec("resize-pane",   "-t", e.target, "-x", String(e.cols), "-y", String(e.rows));
        tmuxExec("resize-window", "-t", e.target, "-x", String(e.cols), "-y", String(e.rows));
      } else if (e.type === "_tmux_resize_auto") {
        try { tmuxExec("resize-window", "-A", "-t", e.target); } catch (_) {}
      } else if (e.type === "_tmux_kill_session") {
        tmuxExec("kill-session", "-t", e.target);
      } else if (e.type === "_tmux_send_keys") {
        tmuxExec("send-keys", "-t", e.target, e.text, "Enter");
      } else if (e.type === "_tmux_send_key") {
        tmuxExec("send-keys", "-t", e.target, String(e.key));
      } else if (e.type === "_sendInput") {
        const worker = this.workers.get(String(e.id));
        if (worker) this._dispatchEvents(e.id, worker.sendInput(e.text));
      } else if (e.type === "_start_polling") {
        this._startPolling(String(e.id));
      } else {
        this.onEvent(e);
      }
    }
  }

  /** Run a single polling cycle for a worker. */
  async _pollOutput(id) {
    const worker = this.workers.get(String(id));
    if (!worker || worker._polling) return;
    worker._polling = true;
    try {
      if (!isAlive(worker.tmuxTarget)) {
        this._dispatchEvents(id, worker.markDead());
        return;
      }

      await this._updateGlobalPaneInfo();
      const paneInfo = worker.tmuxSessionId
        ? this.globalPaneInfo.get(worker.tmuxSessionId)
        : [...this.globalPaneInfo.values()].find(info => info.sessionName === worker.sessionName) || null;

      const snapshot = await tmuxExecAsync(
        "capture-pane", "-t", worker.tmuxTarget, "-p", "-S", "-500", "-J"
      );

      this._dispatchEvents(id, worker.tick({ snapshot, paneInfo: paneInfo || null, now: Date.now() }));
    } finally {
      worker._polling = false;
    }
  }

  async _updateGlobalPaneInfo() {
    if (this.updatingPaneInfo) return;
    this.updatingPaneInfo = true;
    try {
      const raw = await tmuxExecAsync("list-panes", "-a", "-F", "#{session_id}|#{session_name}|#{pane_current_path}|#{pane_current_command}|#{session_attached}");
      this.globalPaneInfo = parseGlobalPaneInfo(raw);
    } catch (e) {
      console.error("updateGlobalPaneInfo failed:", e);
    } finally {
      this.updatingPaneInfo = false;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Initialize the manager and recover any running term- sessions. */
  init() {
    this.recoverSessions();
  }

  /** Get a worker by ID. */
  get(id) {
    return this.workers.get(String(id));
  }

  /** Determine if a worker exists. */
  has(id) {
    return this.workers.has(String(id));
  }

  /** Execute a callback on each active worker. */
  forEach(fn) {
    this.workers.forEach(fn);
  }

  /** List of all worker API shapes. */
  getWorkersList() {
    return [...this.workers.values()].map(worker => {
      const shape = worker.toApiShape();
      if (shape.status !== "completed" && shape.status !== "stopped") {
        shape.status = isAlive(worker.tmuxTarget) ? "running" : "stopped";
      }
      return shape;
    });
  }

  /** Find worker tracking a specific session. */
  findSession(sessionName, tmuxSessionId) {
    return [...this.workers.values()].find(w =>
      (tmuxSessionId && w.tmuxSessionId === tmuxSessionId) || w.sessionName === sessionName
    );
  }

  /** Spawn a new managed worker and launch the configured CLI. */
  spawnWorker(cwd, cmd) {
    const finalCmd = cmd || this.appConfig.defaultCommand || "claude";
    const id = String(this.nextId++);
    const sessionName = "term-" + id;

    tmuxExec("new-session", "-d", "-s", sessionName, "-c", cwd, "-e", "CLAUDECODE=");
    tmuxExec("send-keys", "-t", sessionName, finalCmd, "Enter");

    const tmuxSessionId = resolveSessionId(sessionName);
    const worker = createWorker({ id, sessionName, cwd, cmd: finalCmd, tmuxSessionId, ...this._makeWorkerDeps() });
    this.workers.set(id, worker);
    this._startPolling(id);

    this.onEvent({
      type: "spawned",
      id,
      cwd,
      cmd: finalCmd,
      status: "running",
      sessionName,
      cliType: worker.cliType,
      ...worker.toApiShape(),
    });

    return id;
  }

  /** Attach monitoring to an already-running tmux session. */
  attachWorker(sessionName, cwd) {
    const tmuxSessionId = resolveSessionId(sessionName);
    const existing = this.findSession(sessionName, tmuxSessionId);
    if (existing) return existing.id;

    const id = String(this.nextId++);
    const worker = createWorker({
      id,
      sessionName,
      cwd,
      cmd: "",
      tmuxSessionId,
      expectedCmd: "",
      ...this._makeWorkerDeps(),
    });

    this.workers.set(id, worker);
    this._startPolling(id);

    this.onEvent({
      type: "spawned",
      id,
      cwd,
      status: "running",
      sessionName,
      ...worker.toApiShape(),
    });

    return id;
  }

  /** Resize a worker's target layout parameters. */
  async resizeWorker(id, cols, rows) {
    const worker = this.get(id);
    if (!worker) return;

    const resizeEvents = worker.resize(cols, rows);
    if (!isAlive(worker.tmuxTarget)) return;

    this._dispatchEvents(id, resizeEvents);

    try {
      const output = await tmuxExecAsync("capture-pane", "-t", worker.tmuxTarget, "-p", "-S", "-500", "-J");
      this._dispatchEvents(id, worker.applySnapshot(output));
    } catch (e) {
      console.error("Failed to capture pane after resize:", e);
    }
  }

  /** Send interactive input. */
  sendInput(id, text) {
    const worker = this.get(id);
    if (!worker) return false;
    this._dispatchEvents(id, worker.sendInput(text));
    return true;
  }

  /** Send interactive special key. */
  sendKey(id, key) {
    const worker = this.get(id);
    if (!worker) return false;
    this._dispatchEvents(id, worker.sendKey(key));
    return true;
  }

  /** Terminate a worker. */
  killWorker(id, reason) {
    const worker = this.get(id);
    if (!worker) return false;
    this._dispatchEvents(id, worker.kill(reason));
    return true;
  }

  /** Reconnect monitoring. */
  reconnectWorker(id) {
    const worker = this.get(id);
    if (!worker) return false;
    if (isAlive(worker.tmuxTarget)) {
      worker.stopPolling();
      this._dispatchEvents(id, worker.reconnect());
      return true;
    }
    return false;
  }

  /** Clear all state history. */
  resetWorker(id) {
    const worker = this.get(id);
    if (!worker) return false;
    if (isAlive(worker.tmuxTarget)) {
      worker.stopPolling();
      this._dispatchEvents(id, worker.reset());
      return true;
    }
    return false;
  }

  /** Toggle AI monitoring. */
  toggleAiMonitor(id) {
    const worker = this.get(id);
    if (!worker) return null;
    const { enabled, events } = worker.toggleAiMonitor();
    this._dispatchEvents(id, events);
    return enabled;
  }

  /** Toggle Auto Mode. */
  toggleAutoMode(id) {
    const worker = this.get(id);
    if (!worker) return null;
    const { enabled, events } = worker.toggleAutoMode();
    this._dispatchEvents(id, events);
    return enabled;
  }

  /** Change AI monitor mode. */
  setMonitorMode(id, mode) {
    const worker = this.get(id);
    if (!worker) return null;
    const result = worker.setMonitorMode(mode);
    if (!result) return null;
    this._dispatchEvents(id, result.events);
    return result.mode;
  }

  /** Remove worker tracking registration completely. */
  removeWorker(id) {
    const worker = this.get(id);
    if (worker) {
      worker.remove();
      this.workers.delete(String(id));
    }
  }

  /** Discover and recover existing term- sessions in background. */
  recoverSessions() {
    let raw;
    try {
      raw = tmuxExec("ls", "-F", "#{session_name}|#{pane_current_path}|#{pane_current_command}|#{session_id}");
    } catch (e) {
      // tmux might not be initialized or running
      return;
    }
    if (!raw.trim()) return;

    const recovered = [];
    for (const line of raw.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split("|");
      const sessionName = parts[0];
      const cwd = parts[1] || "unknown";
      const cmd = parts[2] || "unknown";
      const tmuxSessionId = parts[3] ? parts[3].trim() : null;

      if (!sessionName.startsWith("term-")) continue;
      const id = sessionName.replace("term-", "");
      const numId = parseInt(id, 10);
      if (isNaN(numId)) continue;

      try {
        sanitizeSessionName(sessionName);
      } catch (_) {
        continue;
      }

      if (this.workers.has(id)) continue;

      const worker = createWorker({
        id,
        sessionName,
        cwd,
        cmd,
        tmuxSessionId,
        expectedCmd: getBaseCommand(cmd),
        ...this._makeWorkerDeps(),
      });

      this.workers.set(id, worker);
      this._startPolling(id);

      if (numId >= this.nextId) this.nextId = numId + 1;
      recovered.push(id);
    }

    if (recovered.length > 0) {
      console.log(`♻️  Recovered ${recovered.length} session(s)`);
      recovered.forEach(id => {
        const worker = this.workers.get(id);
        if (worker) {
          this.onEvent({
            type: "spawned",
            id,
            fromRecovery: true,
            cwd: worker.cwd,
            cmd: worker.toApiShape().cmd,
            status: "running",
            sessionName: worker.sessionName,
            ...worker.toApiShape(),
          });
        }
      });
    }
  }
}

module.exports = SessionManager;
