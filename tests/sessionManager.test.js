/**
 * tests/sessionManager.test.js
 *
 * Unit tests for lib/sessionManager.js.
 * Run with: node --test tests/sessionManager.test.js
 */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
// Mock dependencies of tmuxService
const mockTmux = {
  sanitizeSessionName: (s) => s,
  tmuxExec: (cmd, ...args) => {
    mockTmux.calls.push({ cmd, args });
    if (cmd === "ls") {
      return mockTmux.lsOutput || "";
    }
    return "";
  },
  tmuxExecAsync: async (cmd, ...args) => {
    mockTmux.asyncCalls.push({ cmd, args });
    if (cmd === "capture-pane") {
      return "pane-snapshot-content";
    }
    if (cmd === "list-panes") {
      return mockTmux.listPanesOutput || "";
    }
    return "";
  },
  isAlive: (target) => {
    return mockTmux.aliveTargets.has(target);
  },
  resolveSessionId: (name) => {
    return mockTmux.sessionIds[name] || null;
  },
  calls: [],
  asyncCalls: [],
  lsOutput: "",
  listPanesOutput: "",
  aliveTargets: new Set(),
  sessionIds: {},
  reset() {
    this.calls = [];
    this.asyncCalls = [];
    this.lsOutput = "";
    this.listPanesOutput = "";
    this.aliveTargets = new Set();
    this.sessionIds = {};
  }
};

// Require sessionManager and inject mock dependencies using Node's module system
// or by overwriting require cache / overriding imported modules.
// Since SessionManager imports './tmuxService' directly, we can override the module exports:
const tmuxService = require("../lib/tmuxService");
Object.assign(tmuxService, mockTmux);

// Clear require cache for sessionManager and worker so they reload tmuxService and destructure mock functions
delete require.cache[require.resolve("../lib/sessionManager")];
delete require.cache[require.resolve("../lib/worker")];
const SessionManager = require("../lib/sessionManager");

const paneInfoParser = require("../lib/paneInfoParser");
paneInfoParser.parseGlobalPaneInfo = (raw) => {
  const map = new Map();
  if (!raw) return map;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("|");
    const sessionId = parts[0];
    const sessionName = parts[1];
    const cwd = parts[2];
    const paneCmd = parts[3];
    const sessionAttached = parts[4];
    map.set(sessionId, { sessionId, sessionName, cwd, paneCmd, sessionAttached });
  }
  return map;
};

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeFakes() {
  const watcherEngine = {
    inspect: () => ({ changed: false, nextState: "running", detection: null })
  };

  const sessionStateManager = {
    hydrateWorker:   () => {},
    getApiMeta:      () => ({ aiMonitorEnabled: true, autoMode: false, waitingState: "running" }),
    setWaitingState: () => {},
    updateActivity:  () => {},
    updateMatch:     () => {},
    setResetEpoch:   () => {},
    clearResetEpoch: () => {},
    markNotification:() => {},
    shouldNotify:    () => ({ shouldSend: false }),
    removeSession:   () => {},
    toggleAiMonitor: (s) => { s.aiMonitorEnabled = !s.aiMonitorEnabled; return { enabled: s.aiMonitorEnabled, events: [] }; },
    toggleAutoMode:  (s) => { s.autoMode = !s.autoMode; return { enabled: s.autoMode, events: [] }; },
    setMonitorMode:  (s, m) => { return { mode: m, events: [] }; },
  };

  const telegramService = {
    sendWaitingNotification: async () => ({ ok: true })
  };

  const eventsList = [];
  const onEvent = (e) => {
    eventsList.push(e);
  };

  return { watcherEngine, sessionStateManager, telegramService, onEvent, eventsList };
}

function makeManager(fakes = makeFakes()) {
  return new SessionManager({
    monitorConfig: { enabled: true, pollIntervalMs: 5000 },
    appConfig: { defaultCommand: "claude" },
    watcherEngine: fakes.watcherEngine,
    sessionStateManager: fakes.sessionStateManager,
    telegramService: fakes.telegramService,
    onEvent: fakes.onEvent,
    extractResetTime: () => null,
    parseResetEpoch: () => null,
    cleanRateLimitLine: (s) => s,
    getNewLinesCount: () => 0,
    RATE_LIMIT_PATTERNS: new Set(),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SessionManager", () => {

  test("spawnWorker sets up worker, starts polling, and fires event", () => {
    mockTmux.reset();
    mockTmux.sessionIds["term-1"] = "$1";
    mockTmux.aliveTargets.add("$1");

    const fakes = makeFakes();
    const mgr = makeManager(fakes);

    const id = mgr.spawnWorker("/tmp", "claude");
    assert.equal(id, "1");
    assert.ok(mgr.has("1"));
    const worker = mgr.get("1");
    assert.equal(worker.sessionName, "term-1");
    assert.equal(worker.tmuxSessionId, "$1");
    assert.equal(worker.cwd, "/tmp");

    // Spawn event triggered
    const spawnEvent = fakes.eventsList.find(e => e.type === "spawned");
    assert.ok(spawnEvent);
    assert.equal(spawnEvent.id, "1");
    assert.equal(spawnEvent.cwd, "/tmp");
  });

  test("attachWorker attaches to existing or creates new", () => {
    mockTmux.reset();
    mockTmux.sessionIds["term-5"] = "$5";
    mockTmux.aliveTargets.add("$5");

    const fakes = makeFakes();
    const mgr = makeManager(fakes);

    const id1 = mgr.attachWorker("term-5", "/tmp");
    assert.equal(id1, "1");

    // Second attach with same sessionName returns existing worker id
    const id2 = mgr.attachWorker("term-5", "/tmp");
    assert.equal(id2, "1");
  });

  test("recoverSessions discovers term- sessions from tmux ls", () => {
    mockTmux.reset();
    mockTmux.lsOutput = "term-2|/home/user/workspace|bash|$2\nterm-abc|/tmp|bash|$3";
    mockTmux.sessionIds["term-2"] = "$2";
    mockTmux.aliveTargets.add("$2");

    const fakes = makeFakes();
    const mgr = makeManager(fakes);

    mgr.recoverSessions();

    // term-2 recovered (abc ignored because abc is not numeric)
    assert.ok(mgr.has("2"));
    assert.ok(!mgr.has("abc"));
    assert.equal(mgr.get("2").tmuxSessionId, "$2");

    // Next ID adjusted to prevent collision
    assert.equal(mgr.nextId, 3);

    // Spawn event broadcasted
    assert.ok(fakes.eventsList.some(e => e.type === "spawned" && e.id === "2" && e.fromRecovery));
  });

  test("reconnectWorker stops old polling and reconnects if alive", () => {
    mockTmux.reset();
    mockTmux.sessionIds["term-1"] = "$1";
    mockTmux.aliveTargets.add("$1");

    const fakes = makeFakes();
    const mgr = makeManager(fakes);

    mgr.spawnWorker("/tmp", "claude");
    
    // Attempt reconnect
    const ok = mgr.reconnectWorker("1");
    assert.equal(ok, true);

    // If target not alive, reconnect fails
    mockTmux.aliveTargets.delete("$1");
    const ok2 = mgr.reconnectWorker("1");
    assert.equal(ok2, false);
  });

  test("killWorker terminates session and updates state", () => {
    mockTmux.reset();
    mockTmux.sessionIds["term-1"] = "$1";
    mockTmux.aliveTargets.add("$1");

    const fakes = makeFakes();
    const mgr = makeManager(fakes);

    mgr.spawnWorker("/tmp", "claude");
    const ok = mgr.killWorker("1", "User stop");
    assert.equal(ok, true);

    // Check kill-session was called
    assert.ok(mockTmux.calls.some(c => c.cmd === "kill-session" && c.args.includes("$1")));
  });

  test("removeWorker destroys worker instance and deletes from registry", () => {
    mockTmux.reset();
    mockTmux.sessionIds["term-1"] = "$1";
    mockTmux.aliveTargets.add("$1");

    const fakes = makeFakes();
    const mgr = makeManager(fakes);

    mgr.spawnWorker("/tmp", "claude");
    assert.ok(mgr.has("1"));

    mgr.removeWorker("1");
    assert.ok(!mgr.has("1"));
  });

  test("getWorkersList applies live check override", () => {
    mockTmux.reset();
    mockTmux.sessionIds["term-1"] = "$1";
    mockTmux.aliveTargets.add("$1");

    const fakes = makeFakes();
    const mgr = makeManager(fakes);

    mgr.spawnWorker("/tmp", "claude");

    const worker = mgr.get("1");
    const list1 = mgr.getWorkersList();
    assert.equal(list1[0].status, "running");

    // Remove from aliveTargets to simulate crash/external exit
    mockTmux.aliveTargets.delete("$1");
    const list2 = mgr.getWorkersList();
    assert.equal(list2[0].status, "stopped");
  });
});
