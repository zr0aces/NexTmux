"use strict";
// ── worker.js ──
// Encapsulates all state and behaviour for one managed tmux session (a "worker").
//
// Design decisions:
//   - I/O-free: does not touch tmux, the filesystem, or the network directly.
//     The poll loop (server.js) provides snapshots; Worker returns Event[].
//   - Every mutating method returns Event[].
//     Broadcast events (type without leading _) go straight to WebSocket clients.
//     Directive events (type starts with _) tell the poll loop to perform a
//     side-effecting tmux or control operation.
//   - Dependencies (watcherEngine, sessionStateManager, telegramService) are
//     injected at construction so tests can pass fakes.
//   - sessionStateManager mutates the internal state object (s) directly,
//     matching its existing interface.

const ACTION_WINDOW_MS = 7000;
const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish"]);

function detectCliType(cmd) {
  const normalized = String(cmd || "").toLowerCase().trim();
  const baseCmd = normalized.split(/\s+|\//)[0];
  if (baseCmd === "claude" || normalized.includes("claude")) return "claude";
  if (baseCmd === "codex" || normalized.includes("codex")) return "codex";
  if (baseCmd === "agy" || normalized.includes("agy") || normalized.includes("antigravity")) return "agy";
  return null;
}

function getBaseCommand(cmd) {
  if (!cmd) return "";
  return String(cmd).trim().split(/\s+/)[0] || "";
}

/**
 * Create a Worker instance.
 *
 * @param {object} opts
 * @param {string}  opts.id                  - Worker ID (string)
 * @param {string}  opts.sessionName         - tmux session name (e.g. "term-1")
 * @param {string}  opts.cwd                 - Working directory at spawn time
 * @param {string}  opts.cmd                 - Command string (e.g. "claude")
 * @param {string|null} opts.tmuxSessionId   - tmux $session_id (e.g. "$3"), may be null initially
 * @param {string}  [opts.status]            - Initial status ("running")
 * @param {Array}   [opts.logs]              - Pre-populated log lines (recovery)
 * @param {string}  [opts.expectedCmd]       - Base command to track exit from
 * @param {boolean} [opts.seenExpectedCmd]   - Whether the expected command was observed
 * @param {object}  opts.watcherEngine       - { inspect(opts) → { changed, nextState, detection } }
 * @param {object}  opts.sessionStateManager - Persists/hydrates AI monitor state
 * @param {object}  opts.telegramService     - { sendWaitingNotification(...) → Promise }
 * @param {object}  opts.monitorConfig       - { enabled, idleThresholdMs, ... }
 * @param {Function} opts.extractResetTime   - Extracts human-readable reset time from text
 * @param {Function} opts.parseResetEpoch    - Parses reset epoch ms from reset time string
 * @param {Set}     opts.RATE_LIMIT_PATTERNS - Pattern names that signal rate limits
 * @param {Function} opts.cleanRateLimitLine - Removes rate-limit noise from output
 * @param {Function} opts.getNewLinesCount   - Counts new lines vs previous output
 * @param {Function} [opts.onAsyncEvent]     - Called with Event when async ops (Telegram)
 *                                            complete and produce a follow-up broadcast.
 *                                            Only used for async notification callbacks.
 */
function createWorker({
  id,
  sessionName,
  cwd,
  cmd,
  tmuxSessionId = null,
  status = "running",
  logs = [],
  expectedCmd,
  seenExpectedCmd = false,
  watcherEngine,
  sessionStateManager,
  telegramService,
  monitorConfig = {},
  extractResetTime,
  parseResetEpoch,
  RATE_LIMIT_PATTERNS,
  cleanRateLimitLine,
  getNewLinesCount,
  onAsyncEvent = null,
} = {}) {

  // ── Internal mutable state object.
  //    sessionStateManager reads/writes fields on this object directly
  //    (hydrateWorker, setWaitingState, markNotification, etc.), matching
  //    its existing interface without requiring a rewrite.
  const s = {
    // identity cluster
    sessionName,
    cwd,
    cmd,
    cliType: detectCliType(cmd),
    tmuxSessionId,
    status,
    exitReason: null,
    expectedCmd: expectedCmd !== undefined ? expectedCmd : getBaseCommand(cmd),
    seenExpectedCmd,
    lastPaneCommand: null,
    lastAction: null,

    // AI monitoring cluster (also written by sessionStateManager)
    aiMonitorEnabled: monitorConfig.enabled !== false,
    autoMode: false,
    aiState: null,
    waitingState: "running",
    lastActivityAt: null,
    lastMatchedPattern: null,
    lastPromptExcerpt: null,
    lastMatchedLine: null,
    lastNotificationAt: null,
    notificationStatus: null,
    tokenResetAt: null,
    resetAtEpochMs: null,
    lastRateLimitAbsLine: undefined,
    lastAutoResponseKey: null,
    lastChangeTime: null,
    totalLinesCount: 0,
    pollErrorCount: 0,
    sentNotificationKeys: new Set(),
    notifiedMessageHashes: [],

    // display/resize cluster
    logs: Array.isArray(logs) ? logs : [],
    cols: null,
    rows: null,
    _lastCols: undefined,
    _lastRows: undefined,
    sessionAttached: 0,
  };

  // ── Poll state (managed externally but stored here for locality)
  let _polling = false;
  let pollTimer = null;

  // ── Last captured tmux output (for change detection)
  let lastCapture = null;

  // ── Dedup key for monitorMeta broadcasts (avoids redundant WS messages)
  let lastMetaBroadcastKey = null;

  // Hydrate AI monitor state from persisted snapshot
  sessionStateManager.hydrateWorker(s);
  if (s.autoMode && s.aiMonitorEnabled === false) s.aiMonitorEnabled = true;
  s.aiState = s.waitingState;

  // ── Private helpers ────────────────────────────────────────────────────────

  function _tmuxTarget() {
    return s.tmuxSessionId || s.sessionName;
  }

  function _rememberAction(type, detail) {
    s.lastAction = { type, detail, ts: Date.now() };
  }

  function _recentAction() {
    if (!s.lastAction) return null;
    if (Date.now() - s.lastAction.ts > ACTION_WINDOW_MS) return null;
    return s.lastAction;
  }

  function _inferExitReason(fallback) {
    const action = _recentAction();
    if (action?.type === "stop_button") return "Stopped from dashboard (Stop button).";
    if (action?.type === "special_key" && action.detail === "C-c") return "Interrupted by Ctrl+C sent from dashboard.";
    if (action?.type === "special_key") return `Exited after key input from dashboard (${action.detail}).`;
    if (s.status === "completed" && s.lastPaneCommand && s.expectedCmd && s.lastPaneCommand !== s.expectedCmd) {
      return `Command '${s.expectedCmd}' is no longer active (pane now '${s.lastPaneCommand}').`;
    }
    return fallback || "Session exited (reason unknown).";
  }

  /** Build a monitorMeta event, or null if nothing has changed since last broadcast. */
  function _monitorMetaEvent() {
    const meta = sessionStateManager.getApiMeta(s);
    const key = JSON.stringify(meta);
    if (lastMetaBroadcastKey === key) return null;
    lastMetaBroadcastKey = key;
    return { type: "monitorMeta", id, ...meta };
  }

  /** Force the next _monitorMetaEvent() to always emit (e.g. after toggle calls). */
  function _invalidateMetaKey() {
    lastMetaBroadcastKey = null;
  }

  /**
   * Fire a Telegram waiting notification asynchronously.
   * After it resolves, call onAsyncEvent with the updated monitorMeta so the
   * client sees the notification status update without waiting for the next tick.
   */
  function _sendWaitingAlert(detection, now) {
    const decision = sessionStateManager.shouldNotify({
      worker: s,
      patternName: detection?.patternName || "waiting",
      matchedText: detection?.matchedText || "",
      excerpt: detection?.excerpt || "",
      now,
    });

    if (!decision.shouldSend) {
      const status = decision.reason === "duplicate" ? "skipped_duplicate" : "skipped_debounce";
      sessionStateManager.markNotification(s, status, now);
      return;
    }

    telegramService.sendWaitingNotification({
      sessionName: s.sessionName,
      patternName: detection?.patternName,
      matchedText: detection?.matchedText,
      excerpt: detection?.excerpt || s.lastPromptExcerpt || "",
      resetTime: extractResetTime(detection?.excerpt || "") || s.tokenResetAt || null,
      timestamp: new Date(now).toISOString(),
    }).then((result) => {
      if (result.ok) {
        sessionStateManager.markNotification(s, "sent", now, decision.key);
      } else if (result.skipped) {
        sessionStateManager.markNotification(s, "skipped", now);
      } else {
        sessionStateManager.markNotification(s, "failed", now);
        console.warn("Telegram waiting alert failed", String(s.sessionName), String(result.error || "unknown_error"));
      }
      // Async follow-up broadcast: update the client's notification status indicator
      if (typeof onAsyncEvent === "function") {
        _invalidateMetaKey();
        const meta = _monitorMetaEvent();
        if (meta) onAsyncEvent(meta);
      }
    }).catch((err) => {
      sessionStateManager.markNotification(s, "failed", now);
      console.warn("Telegram waiting alert exception", String(s.sessionName), String(err?.message || err));
      if (typeof onAsyncEvent === "function") {
        _invalidateMetaKey();
        const meta = _monitorMetaEvent();
        if (meta) onAsyncEvent(meta);
      }
    });
  }

  // ── Public interface ───────────────────────────────────────────────────────

  /**
   * Mark this worker as dead (tmux session no longer exists).
   * Called by the poll loop after isAlive() returns false.
   * Returns Event[].
   */
  function markDead() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    s.status = "completed";
    s.aiState = null;
    sessionStateManager.setWaitingState(s, "disconnected");
    s.exitReason = s.exitReason || _inferExitReason("tmux session ended or was killed externally.");
    const events = [
      { type: "status", id, status: "completed", reason: s.exitReason },
    ];
    const meta = _monitorMetaEvent();
    if (meta) events.push(meta);
    return events;
  }

  /**
   * Process one poll tick.
   *
   * @param {object} opts
   * @param {string}      opts.snapshot  - Raw tmux capture-pane output
   * @param {object|null} opts.paneInfo  - { cwd, paneCmd, sessionId, sessionName, sessionAttached }
   * @param {number}      [opts.now]     - Timestamp (ms); defaults to Date.now()
   * @returns {Event[]}
   */
  function tick({ snapshot, paneInfo, now = Date.now() }) {
    const events = [];

    try {
      // ── 1. Update from pane info (cwd, sessionAttached, pane command) ──────
      if (paneInfo) {
        // sessionAttached change detection
        const nowAttached = paneInfo.sessionAttached === "1" ? 1 : 0;
        if (nowAttached !== s.sessionAttached) {
          const prevAttached = s.sessionAttached;
          s.sessionAttached = nowAttached;
          events.push({ type: "sessionAttached", id, attached: nowAttached === 1 });
          if (nowAttached === 1) {
            // Signal poll loop to call tmux resize-window -A (let the terminal take over sizing)
            events.push({ type: "_tmux_resize_auto", target: _tmuxTarget() });
            s._lastCols = undefined;
            s._lastRows = undefined;
          } else if (prevAttached === 1) {
            s._lastCols = undefined;
            s._lastRows = undefined;
          }
        }

        // Latch tmuxSessionId if we didn't have it yet
        if (!s.tmuxSessionId && paneInfo.sessionId) {
          s.tmuxSessionId = paneInfo.sessionId;
        }

        // Session name rename (e.g. user renamed the tmux session)
        if (paneInfo.sessionName && paneInfo.sessionName !== s.sessionName) {
          s.sessionName = paneInfo.sessionName;
          events.push({ type: "sessionName", id, sessionName: s.sessionName });
        }

        // CWD change
        if (paneInfo.cwd && paneInfo.cwd !== s.cwd) {
          s.cwd = paneInfo.cwd;
          events.push({ type: "cwd", id, cwd: s.cwd });
        }

        // Pane command tracking — detect when the managed CLI exits to a shell
        if (paneInfo.paneCmd) {
          s.lastPaneCommand = paneInfo.paneCmd;
          if (s.expectedCmd && paneInfo.paneCmd === s.expectedCmd) s.seenExpectedCmd = true;
          const switchedToShell = s.seenExpectedCmd
            && paneInfo.paneCmd !== s.expectedCmd
            && SHELL_COMMANDS.has(paneInfo.paneCmd);
          if (switchedToShell && s.status !== "completed") {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            s.status = "completed";
            s.aiState = null;
            sessionStateManager.setWaitingState(s, "disconnected");
            s.exitReason = _inferExitReason(
              `Command '${s.expectedCmd}' exited and returned to shell '${paneInfo.paneCmd}'.`
            );
            events.push({ type: "status", id, status: "completed", reason: s.exitReason });
            const meta = _monitorMetaEvent();
            if (meta) events.push(meta);
            return events;
          }
        }
      }

      // ── 2. Resize directive (if dims changed and no terminal client attached) ──
      const cols = s.cols || 80;
      const rows = s.rows || 50;
      if (s.sessionAttached !== 1 && (cols !== s._lastCols || rows !== s._lastRows)) {
        events.push({ type: "_tmux_resize", target: _tmuxTarget(), cols, rows });
        s._lastCols = cols;
        s._lastRows = rows;
      }

      // ── 3. Rate-limit epoch reset ────────────────────────────────────────────
      if (s.aiState === "waiting" && s.resetAtEpochMs && now >= s.resetAtEpochMs) {
        sessionStateManager.clearResetEpoch(s);
        s.tokenResetAt = null;

        // Record the absolute line index of the rate-limit message so future ticks
        // can scrub it from the inspected output (avoids re-triggering the pattern).
        const lines = snapshot.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          if (/(?:rate[-_\s]*limit|usage[-_\s]*limit|token[-_\s]*limit|daily[-_\s]*limit|you(?:'|'|re| are|\s)+(?:rate[-_\s]*limited|out of.*uses))/i.test(lines[i])) {
            s.lastRateLimitAbsLine = (s.totalLinesCount || 0) - (lines.length - i);
            break;
          }
        }

        if (s.autoMode) {
          s.aiState = "running";
          sessionStateManager.setWaitingState(s, "running");
          events.push({ type: "aiState", id, state: "running" });
          // Directive: poll loop calls worker.sendInput() which handles logging + tmux send-keys
          events.push({ type: "_sendInput", id, text: "continue" });
        }
        const meta = _monitorMetaEvent();
        if (meta) events.push(meta);
        return events;
      }

      // ── 4. Output inspection ─────────────────────────────────────────────────
      const newLinesCount = getNewLinesCount(snapshot, lastCapture);
      s.totalLinesCount = (s.totalLinesCount || 0) + newLinesCount;

      const inspectOutput = cleanRateLimitLine(snapshot, s.totalLinesCount, s.lastRateLimitAbsLine);
      const previousInspectOutput = cleanRateLimitLine(
        lastCapture,
        (s.totalLinesCount || 0) - newLinesCount,
        s.lastRateLimitAbsLine
      );

      const inspect = (s.aiMonitorEnabled && monitorConfig.enabled)
        ? watcherEngine.inspect({
            output: inspectOutput,
            previousOutput: previousInspectOutput,
            currentState: s.aiState || "running",
            lastChangeTime: s.lastChangeTime,
            now,
          })
        : { changed: false, nextState: null, detection: null };

      if (inspect.changed) {
        lastCapture = snapshot;
        s.lastChangeTime = now;
        sessionStateManager.updateActivity(s, now);
        const lines = snapshot.split("\n");
        s.logs = lines.slice(-200).map(text => ({ src: "stdout", text, ts: now }));
        events.push({ type: "snapshot", id, lines });
      }

      // ── 5. Detection: rate-limit epoch tracking ─────────────────────────────
      if (inspect.detection?.matched) {
        sessionStateManager.updateMatch(s, inspect.detection);
        const detectionExcerpt = String(inspect.detection.excerpt || "");
        const maybeRateLimit = RATE_LIMIT_PATTERNS.has(inspect.detection.patternName)
          || /(?:rate\s*limit|usage\s*limit|token\s*limit|you(?:'|')ve hit your limit|resets?\s)/i.test(detectionExcerpt);
        if (maybeRateLimit) {
          const resetTime = extractResetTime(inspect.detection.excerpt);
          if (resetTime) {
            s.tokenResetAt = resetTime;
            const epoch = parseResetEpoch(resetTime, now);
            if (epoch) {
              sessionStateManager.setResetEpoch(s, epoch);
              s.lastRateLimitAbsLine = undefined;
            }
          }
        }
      }

      // ── 6. State machine transition ──────────────────────────────────────────
      const nextState = inspect.nextState || "running";
      const stateChanged = nextState !== s.aiState;
      if (stateChanged) {
        s.aiState = nextState;
        events.push({ type: "aiState", id, state: nextState });
      }

      if (nextState !== "waiting") s.lastAutoResponseKey = null;

      if (nextState === "waiting" || nextState === "idle" || nextState === "running") {
        sessionStateManager.setWaitingState(s, nextState);
      }

      // ── 7. Waiting: notification + autoMode response ────────────────────────
      if (inspect.detection?.matched && nextState === "waiting" && (stateChanged || inspect.changed)) {
        _sendWaitingAlert(inspect.detection, now); // async, non-blocking
      }

      if (nextState === "waiting" && s.autoMode && inspect.detection?.matched && (stateChanged || inspect.changed)) {
        const responseKey = [
          inspect.detection.patternName || "",
          inspect.detection.matchedText || "",
        ].join("::");
        if (!stateChanged && responseKey && s.lastAutoResponseKey === responseKey) {
          const meta = _monitorMetaEvent();
          if (meta) events.push(meta);
          return events;
        }
        const autoResponse = inspect.detection?.autoResponse;
        if (autoResponse !== null) {
          s.lastAutoResponseKey = responseKey || String(now);
          // Directive: poll loop calls worker.sendInput() to handle logging + tmux call
          events.push({ type: "_sendInput", id, text: autoResponse });
        }
      }

      // ── 8. monitorMeta broadcast (deduplicated) ──────────────────────────────
      const meta = _monitorMetaEvent();
      if (meta) events.push(meta);

    } catch (e) {
      s.pollErrorCount = (s.pollErrorCount || 0) + 1;
      if (s.pollErrorCount <= 3 || s.pollErrorCount % 30 === 0) {
        console.warn(
          `worker.tick failed for ${s.sessionName} (#${id}) [${s.pollErrorCount}]`,
          e?.message || e
        );
      }
    }

    return events;
  }

  /**
   * Apply a snapshot captured during a resize operation.
   * Unlike tick(), this does not run the AI monitor — it just refreshes the display.
   * Returns Event[].
   */
  function applySnapshot(output) {
    lastCapture = output;
    const lines = output.split("\n");
    s.logs = lines.slice(-200).map(text => ({ src: "stdout", text, ts: Date.now() }));
    return [{ type: "snapshot", id, lines }];
  }

  /**
   * Update desired terminal dimensions.
   * Returns a _tmux_resize directive if the size changed and the session is not attached.
   */
  function resize(cols, rows) {
    s.cols = cols;
    s.rows = rows;
    const events = [];
    const c = cols || 80;
    const r = rows || 50;
    if (s.sessionAttached !== 1 && (c !== s._lastCols || r !== s._lastRows)) {
      events.push({ type: "_tmux_resize", target: _tmuxTarget(), cols: c, rows: r });
      s._lastCols = c;
      s._lastRows = r;
    }
    return events;
  }

  /**
   * Send text input to the tmux session.
   * Handles the "completed → running" resurrection case.
   * Returns Event[].
   */
  function sendInput(text) {
    const events = [];
    if (typeof text !== "string") return events;
    if (s.status === "completed") {
      s.status = "running";
      s.aiState = null;
      s.exitReason = null;
      sessionStateManager.setWaitingState(s, "running");
      events.push({ type: "status", id, status: "running", reason: null });
      // Signal the poll loop to restart the interval timer
      events.push({ type: "_start_polling", id });
      _invalidateMetaKey();
      const meta = _monitorMetaEvent();
      if (meta) events.push(meta);
    }
    _rememberAction("input", "text");
    // Multi-line input: split on newlines and send each line with Enter
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      events.push({ type: "_tmux_send_keys", target: _tmuxTarget(), text: line });
    }
    events.push({ type: "log", id, src: "stdin", text, ts: Date.now() });
    return events;
  }

  /**
   * Send a special key (e.g. "C-c", "Escape") to the tmux session.
   * Returns Event[].
   */
  function sendKey(key) {
    const events = [];
    if (s.status === "completed") {
      s.status = "running";
      s.aiState = null;
      s.exitReason = null;
      sessionStateManager.setWaitingState(s, "running");
      events.push({ type: "status", id, status: "running", reason: null });
      events.push({ type: "_start_polling", id });
      _invalidateMetaKey();
      const meta = _monitorMetaEvent();
      if (meta) events.push(meta);
    }
    _rememberAction("special_key", key);
    events.push({ type: "_tmux_send_key", target: _tmuxTarget(), key: String(key) });
    return events;
  }

  /**
   * Kill (stop) the tmux session from the dashboard.
   * Returns Event[].
   */
  function kill(reason) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    _rememberAction("stop_button", "kill-session");
    s.status = "stopped";
    s.aiState = null;
    sessionStateManager.setWaitingState(s, "disconnected");
    s.exitReason = reason || "Stopped from dashboard.";
    const events = [
      { type: "_tmux_kill_session", target: _tmuxTarget() },
      { type: "status", id, status: "stopped", reason: s.exitReason },
    ];
    _invalidateMetaKey();
    const meta = _monitorMetaEvent();
    if (meta) events.push(meta);
    return events;
  }

  /**
   * Reconnect monitoring to an already-running tmux session.
   * Caller should verify isAlive() before calling this.
   * Returns Event[].
   */
  function reconnect() {
    s.status = "running";
    s.aiState = null;
    s.exitReason = null;
    s.seenExpectedCmd = false;
    sessionStateManager.setWaitingState(s, "running");
    const events = [
      { type: "status", id, status: "running", reason: null },
      { type: "_start_polling", id },
    ];
    _invalidateMetaKey();
    const meta = _monitorMetaEvent();
    if (meta) events.push(meta);
    return events;
  }

  /**
   * Full state reset: clears all AI monitor state and notification history.
   * Returns Event[].
   */
  function reset() {
    sessionStateManager.removeSession(s);

    s.status = "running";
    s.aiState = null;
    s.exitReason = null;
    s.seenExpectedCmd = false;
    s.lastPaneCommand = null;
    s.lastAction = null;
    s.tokenResetAt = null;
    s.resetAtEpochMs = null;
    s.lastRateLimitAbsLine = undefined;
    s.lastAutoResponseKey = null;
    s.notifiedMessageHashes = [];
    s.sentNotificationKeys = new Set();
    s.logs = [];
    s._lastCols = undefined;
    s._lastRows = undefined;

    lastCapture = null;
    _invalidateMetaKey();

    sessionStateManager.setWaitingState(s, "running");
    sessionStateManager.clearResetEpoch(s);

    const events = [
      { type: "status", id, status: "running", reason: null },
      { type: "aiState", id, state: "running" },
      { type: "snapshot", id, lines: [] },
      { type: "_start_polling", id },
    ];
    const meta = _monitorMetaEvent();
    if (meta) events.push(meta);
    return events;
  }

  /**
   * Set AI monitor mode: "off" | "monitor" | "auto".
   * Returns { ok, mode, events } or null if mode is invalid.
   */
  function setMonitorMode(mode) {
    const nextMode = sessionStateManager.setMonitorMode(s, mode);
    if (!nextMode) return null;
    _invalidateMetaKey();
    return {
      ok: true,
      mode: nextMode,
      events: [{ type: "monitorMeta", id, ...sessionStateManager.getApiMeta(s) }],
    };
  }

  /**
   * Toggle AI monitor on/off.
   * Returns { enabled, events }.
   */
  function toggleAiMonitor() {
    const enabled = sessionStateManager.toggleAiMonitor(s);
    _invalidateMetaKey();
    return {
      enabled,
      events: [{ type: "monitorMeta", id, ...sessionStateManager.getApiMeta(s) }],
    };
  }

  /**
   * Toggle autoMode on/off.
   * Returns { enabled, events }.
   */
  function toggleAutoMode() {
    const enabled = sessionStateManager.toggleAutoMode(s);
    _invalidateMetaKey();
    return {
      enabled,
      events: [{ type: "monitorMeta", id, ...sessionStateManager.getApiMeta(s) }],
    };
  }

  /**
   * Remove this worker's persisted session state from disk.
   * Called before deleting the worker from the workers Map.
   */
  function remove() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    sessionStateManager.removeSession(s);
  }

  /**
   * Serialise to the shape expected by GET /api/workers.
   * The caller should override `status` if a live isAlive() check is needed.
   */
  function toApiShape() {
    return {
      id,
      cwd: s.cwd,
      cmd: s.cmd || "claude",
      status: s.status,
      sessionName: s.sessionName,
      cliType: s.cliType,
      logs: s.logs,
      aiState: s.aiState || null,
      exitReason: s.exitReason || null,
      sessionAttached: s.sessionAttached || 0,
      ...sessionStateManager.getApiMeta(s),
    };
  }

  /**
   * Start the poll interval timer.
   * @param {Function} pollFn   - Async function called on each interval tick.
   * @param {number}   intervalMs
   */
  function startPolling(pollFn, intervalMs) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollFn, intervalMs);
  }

  /**
   * Stop the poll interval timer.
   */
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ── Exported interface ─────────────────────────────────────────────────────
  return {
    // Read-only identity (used by poll loop and route handlers)
    get id()            { return id; },
    get tmuxTarget()    { return _tmuxTarget(); },
    get sessionName()   { return s.sessionName; },
    get tmuxSessionId() { return s.tmuxSessionId; },
    get status()        { return s.status; },
    get cwd()           { return s.cwd; },
    get cliType()       { return s.cliType; },
    get logs()          { return s.logs; },
    // Poll-loop control
    get _polling()      { return _polling; },
    set _polling(v)     { _polling = v; },
    get pollTimer()     { return pollTimer; },
    startPolling,
    stopPolling,
    // Mutating methods — all return Event[]
    markDead,
    tick,
    applySnapshot,
    resize,
    sendInput,
    sendKey,
    kill,
    reconnect,
    reset,
    remove,
    // Toggle methods — return { enabled/mode, events }
    setMonitorMode,
    toggleAiMonitor,
    toggleAutoMode,
    // Read-only shape
    toApiShape,
  };
}

module.exports = { createWorker, detectCliType, getBaseCommand };
