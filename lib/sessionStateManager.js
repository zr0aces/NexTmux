const fs = require("fs");
const path = require("path");

function hashText(input) {
  const txt = String(input || "");
  let h = 0;
  for (let i = 0; i < txt.length; i += 1) {
    h = (h * 31 + txt.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

function createSessionStateManager({ notifyCooldownMs = 120000, stateFilePath } = {}) {
  const cooldown = Math.max(1000, Number(notifyCooldownMs) || 120000);
  const lastNotifyBySession = new Map();
  const snapshot = new Map();
  const filePath = stateFilePath || path.join(process.cwd(), "state", "session-state.json");
  let flushTimer = null;

  function getMonitorMode(worker) {
    if (!worker || worker.aiMonitorEnabled === false) return "off";
    return worker.autoMode === true ? "auto" : "monitor";
  }

  function ensureNotificationSet(worker) {
    if (!worker) return new Set();
    if (worker.sentNotificationKeys instanceof Set) return worker.sentNotificationKeys;
    const arr = Array.isArray(worker.notifiedMessageHashes) ? worker.notifiedMessageHashes : [];
    worker.sentNotificationKeys = new Set(arr.map(String));
    return worker.sentNotificationKeys;
  }

  function loadSnapshot() {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      Object.entries(raw || {}).forEach(([sessionName, meta]) => {
        snapshot.set(sessionName, meta || {});
      });
    } catch (err) {
      console.warn("sessionStateManager: failed to load snapshot:", err.message);
    }
  }

  function flushSnapshotSoon() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const out = {};
        snapshot.forEach((value, key) => {
          out[key] = value;
        });
        fs.writeFileSync(filePath, JSON.stringify(out, null, 2), "utf8");
      } catch (err) {
        console.warn("sessionStateManager: failed to flush snapshot:", err.message);
      }
    }, 500);
  }

  function toMeta(worker) {
    return {
      lastActivityAt: worker.lastActivityAt || null,
      waitingState: worker.waitingState || "running",
      lastMatchedPattern: worker.lastMatchedPattern || null,
      lastPromptExcerpt: worker.lastPromptExcerpt || null,
      lastMatchedLine: worker.lastMatchedLine || null,
      lastNotificationAt: worker.lastNotificationAt || null,
      notificationStatus: worker.notificationStatus || null,
      tokenResetAt: worker.tokenResetAt || null,
      resetAtEpochMs: worker.resetAtEpochMs != null ? worker.resetAtEpochMs : null,
      aiMonitorEnabled: worker.aiMonitorEnabled !== false,
      autoMode: worker.autoMode === true,
      monitorMode: getMonitorMode(worker),
      notifiedMessageHashes: Array.from(ensureNotificationSet(worker)).slice(-300),
    };
  }

  function persistWorker(worker) {
    if (!worker || !worker.sessionName) return;
    snapshot.set(worker.sessionName, toMeta(worker));
    flushSnapshotSoon();
  }

  function hydrateWorker(worker) {
    if (!worker) return;
    const fromDisk = snapshot.get(worker.sessionName) || {};
    worker.lastActivityAt = worker.lastActivityAt || fromDisk.lastActivityAt || null;
    worker.waitingState = worker.waitingState || fromDisk.waitingState || "running";
    worker.lastMatchedPattern = worker.lastMatchedPattern || fromDisk.lastMatchedPattern || null;
    worker.lastPromptExcerpt = worker.lastPromptExcerpt || fromDisk.lastPromptExcerpt || null;
    worker.lastMatchedLine = worker.lastMatchedLine || fromDisk.lastMatchedLine || null;
    worker.lastNotificationAt = worker.lastNotificationAt || fromDisk.lastNotificationAt || null;
    worker.notificationStatus = worker.notificationStatus || fromDisk.notificationStatus || null;
    worker.tokenResetAt = worker.tokenResetAt || fromDisk.tokenResetAt || null;
    worker.resetAtEpochMs = worker.resetAtEpochMs != null ? worker.resetAtEpochMs : (fromDisk.resetAtEpochMs ?? null);
    worker.aiMonitorEnabled = worker.aiMonitorEnabled !== undefined ? worker.aiMonitorEnabled : (fromDisk.aiMonitorEnabled !== false);
    worker.autoMode = worker.autoMode !== undefined ? worker.autoMode : (fromDisk.autoMode === true);
    if (fromDisk.monitorMode === "off") {
      worker.aiMonitorEnabled = false;
      worker.autoMode = false;
    } else if (fromDisk.monitorMode === "auto") {
      worker.aiMonitorEnabled = true;
      worker.autoMode = true;
    } else if (fromDisk.monitorMode === "monitor") {
      worker.aiMonitorEnabled = true;
      worker.autoMode = false;
    } else {
      // Backward compatibility for snapshots written before monitorMode existed.
      if (Object.prototype.hasOwnProperty.call(fromDisk, "aiMonitorEnabled")) {
        worker.aiMonitorEnabled = fromDisk.aiMonitorEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(fromDisk, "autoMode")) {
        worker.autoMode = fromDisk.autoMode === true;
      }
    }
    if (worker.autoMode && worker.aiMonitorEnabled === false) worker.aiMonitorEnabled = true;
    worker.notifiedMessageHashes = Array.isArray(fromDisk.notifiedMessageHashes)
      ? fromDisk.notifiedMessageHashes.slice(-300).map(String)
      : [];
    worker.sentNotificationKeys = new Set(worker.notifiedMessageHashes);
  }

  function setWaitingState(worker, state) {
    if (!worker) return;
    worker.waitingState = state;
    persistWorker(worker);
  }

  function updateActivity(worker, now = Date.now()) {
    if (!worker) return;
    worker.lastActivityAt = new Date(now).toISOString();
    persistWorker(worker);
  }

  function updateMatch(worker, detection) {
    if (!worker || !detection || !detection.matched) return;
    worker.lastMatchedPattern = detection.patternName || null;
    worker.lastPromptExcerpt = detection.excerpt || null;
    worker.lastMatchedLine = detection.matchedLine || null;
    persistWorker(worker);
  }

  function shouldNotify({ worker, patternName, matchedText, excerpt, now = Date.now() }) {
    const key = `${worker?.sessionName || "unknown"}::${patternName || "unknown"}::${hashText((matchedText || "") + "\n" + (excerpt || ""))}`;
    if (ensureNotificationSet(worker).has(key)) {
      return { shouldSend: false, key, reason: "duplicate" };
    }
    const sessionKey = String(worker?.sessionName || "unknown");
    const lastNotify = lastNotifyBySession.get(sessionKey) || 0;
    if (now - lastNotify < cooldown) {
      return { shouldSend: false, key, reason: "cooldown" };
    }
    return { shouldSend: true, key };
  }

  function markNotification(worker, status, now = Date.now(), key = null) {
    if (!worker) return;
    if (status === "sent" && key) {
      const set = ensureNotificationSet(worker);
      set.add(String(key));
      if (set.size > 300) {
        const entries = Array.from(set);
        worker.sentNotificationKeys = new Set(entries.slice(-300));
      }
      lastNotifyBySession.set(String(worker.sessionName || "unknown"), now);
    }
    worker.lastNotificationAt = new Date(now).toISOString();
    worker.notificationStatus = status;
    persistWorker(worker);
  }

  function getApiMeta(worker) {
    const meta = toMeta(worker || {});
    delete meta.notifiedMessageHashes;
    return meta;
  }

  function removeSession(sessionName) {
    if (!sessionName) return;
    snapshot.delete(sessionName);
    lastNotifyBySession.delete(String(sessionName));
    flushSnapshotSoon();
  }

  function toggleAiMonitor(worker) {
    if (!worker) return null;
    worker.aiMonitorEnabled = worker.aiMonitorEnabled === false ? true : false;
    if (worker.aiMonitorEnabled === false) worker.autoMode = false;
    persistWorker(worker);
    return worker.aiMonitorEnabled;
  }

  function toggleAutoMode(worker) {
    if (!worker) return null;
    worker.autoMode = worker.autoMode !== true;
    if (worker.autoMode) worker.aiMonitorEnabled = true;
    persistWorker(worker);
    return worker.autoMode;
  }

  function setMonitorMode(worker, mode) {
    if (!worker) return null;
    if (mode !== "off" && mode !== "monitor" && mode !== "auto") return null;
    if (mode === "off") {
      worker.aiMonitorEnabled = false;
      worker.autoMode = false;
    } else if (mode === "auto") {
      worker.aiMonitorEnabled = true;
      worker.autoMode = true;
    } else {
      worker.aiMonitorEnabled = true;
      worker.autoMode = false;
    }
    persistWorker(worker);
    return getMonitorMode(worker);
  }

  function setResetEpoch(worker, epochMs) {
    if (!worker) return;
    if (typeof epochMs !== "number" || !isFinite(epochMs) || epochMs <= 0) return;
    worker.resetAtEpochMs = epochMs;
    persistWorker(worker);
  }

  function clearResetEpoch(worker) {
    if (!worker) return;
    worker.resetAtEpochMs = null;
    persistWorker(worker);
  }

  loadSnapshot();

  return {
    hydrateWorker,
    setWaitingState,
    updateActivity,
    updateMatch,
    shouldNotify,
    markNotification,
    getApiMeta,
    removeSession,
    toggleAiMonitor,
    toggleAutoMode,
    setMonitorMode,
    getMonitorMode,
    setResetEpoch,
    clearResetEpoch,
  };
}

module.exports = { createSessionStateManager };
