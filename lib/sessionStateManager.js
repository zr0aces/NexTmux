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
  const lastNotifyByKey = new Map();
  const snapshot = new Map();
  const filePath = stateFilePath || path.join(process.cwd(), "state", "session-state.json");
  let flushTimer = null;

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
      lastNotificationAt: worker.lastNotificationAt || null,
      notificationStatus: worker.notificationStatus || null,
      tokenResetAt: worker.tokenResetAt || null,
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
    worker.lastNotificationAt = worker.lastNotificationAt || fromDisk.lastNotificationAt || null;
    worker.notificationStatus = worker.notificationStatus || fromDisk.notificationStatus || null;
    worker.tokenResetAt = worker.tokenResetAt || fromDisk.tokenResetAt || null;
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
    persistWorker(worker);
  }

  function shouldNotify({ sessionName, patternName, excerpt, now = Date.now() }) {
    const key = `${sessionName}::${patternName || "unknown"}::${hashText(excerpt || "")}`;
    const last = lastNotifyByKey.get(key) || 0;
    if (now - last < cooldown) {
      return { shouldSend: false, key };
    }
    lastNotifyByKey.set(key, now);
    return { shouldSend: true, key };
  }

  function markNotification(worker, status, now = Date.now()) {
    if (!worker) return;
    worker.lastNotificationAt = new Date(now).toISOString();
    worker.notificationStatus = status;
    persistWorker(worker);
  }

  function getApiMeta(worker) {
    return toMeta(worker || {});
  }

  function removeSession(sessionName) {
    if (!sessionName) return;
    snapshot.delete(sessionName);
    flushSnapshotSoon();
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
  };
}

module.exports = { createSessionStateManager };
