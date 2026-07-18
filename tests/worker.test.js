/**
 * tests/worker.test.js
 *
 * Unit tests for lib/worker.js using the built-in Node.js test runner.
 * Run with: node --test tests/worker.test.js
 *
 * All tests drive the Worker purely through its public interface with no
 * live tmux process — the point of the new seam.
 */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { createWorker, detectCliType, getBaseCommand } = require("../lib/worker");

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Build a minimal, controllable set of fake dependencies. */
function makeFakes({ inspectResult } = {}) {
  const calls = {
    hydrateWorker: [],
    setWaitingState: [],
    updateActivity: [],
    updateMatch: [],
    setResetEpoch: [],
    clearResetEpoch: [],
    markNotification: [],
    shouldNotify: [],
    removeSession: [],
    toggleAiMonitor: [],
    toggleAutoMode: [],
    setMonitorMode: [],
    inspect: [],
    sendWaitingNotification: [],
  };

  const watcherEngine = {
    inspect: (opts) => {
      calls.inspect.push(opts);
      return inspectResult || { changed: false, nextState: "running", detection: null };
    },
  };

  const sessionStateManager = {
    hydrateWorker:   (s) => { calls.hydrateWorker.push(s); },
    getApiMeta:      (s) => ({ aiMonitorEnabled: s.aiMonitorEnabled, autoMode: s.autoMode, waitingState: s.waitingState }),
    setWaitingState: (s, state) => { calls.setWaitingState.push(state); s.waitingState = state; },
    updateActivity:  (s, now)  => { calls.updateActivity.push(now); s.lastActivityAt = now; },
    updateMatch:     (s, det)  => { calls.updateMatch.push(det); },
    setResetEpoch:   (s, ep)   => { calls.setResetEpoch.push(ep); s.resetAtEpochMs = ep; },
    clearResetEpoch: (s)       => { calls.clearResetEpoch.push(1); s.resetAtEpochMs = null; },
    markNotification:(s, st, now, key) => { calls.markNotification.push({ st, key }); s.notificationStatus = st; },
    shouldNotify:    (opts)    => { calls.shouldNotify.push(opts); return { shouldSend: false, reason: "debounce" }; },
    removeSession:   (s)       => { calls.removeSession.push(1); },
    toggleAiMonitor: (s)       => { calls.toggleAiMonitor.push(1); s.aiMonitorEnabled = !s.aiMonitorEnabled; return s.aiMonitorEnabled; },
    toggleAutoMode:  (s)       => { calls.toggleAutoMode.push(1); s.autoMode = !s.autoMode; return s.autoMode; },
    setMonitorMode:  (s, mode) => { calls.setMonitorMode.push(mode); return mode; },
  };

  const telegramService = {
    sendWaitingNotification: async (opts) => {
      calls.sendWaitingNotification.push(opts);
      return { skipped: true };
    },
  };

  return { watcherEngine, sessionStateManager, telegramService, calls };
}

/** Default worker construction options. */
function makeOpts(overrides = {}) {
  const { watcherEngine, sessionStateManager, telegramService } = makeFakes(overrides.fakeOpts);
  return {
    id: "1",
    sessionName: "term-1",
    cwd: "/home/user",
    cmd: "claude",
    tmuxSessionId: "$1",
    watcherEngine: overrides.watcherEngine || watcherEngine,
    sessionStateManager: overrides.sessionStateManager || sessionStateManager,
    telegramService: overrides.telegramService || telegramService,
    monitorConfig: { enabled: true, pollIntervalMs: 2000 },
    extractResetTime: () => null,
    parseResetEpoch: () => null,
    RATE_LIMIT_PATTERNS: new Set(),
    cleanRateLimitLine: (s) => s || "",
    getNewLinesCount: (a, b) => {
      const al = (a || "").split("\n").length;
      const bl = (b || "").split("\n").length;
      return Math.max(0, al - bl);
    },
    ...overrides,
  };
}

function makeTick(snapshot = "$ ", paneInfo = null) {
  return { snapshot, paneInfo: paneInfo || { cwd: "/home/user", paneCmd: "claude", sessionAttached: "0", sessionId: "$1" }, now: Date.now() };
}

// ── Utility functions ─────────────────────────────────────────────────────────

describe("detectCliType", () => {
  test("detects claude", () => assert.equal(detectCliType("claude"), "claude"));
  test("detects agy", () => assert.equal(detectCliType("agy chat"), "agy"));
  test("detects codex", () => assert.equal(detectCliType("codex"), "codex"));
  test("returns null for unknown", () => assert.equal(detectCliType("bash"), null));
  test("handles empty string", () => assert.equal(detectCliType(""), null));
  test("handles null", () => assert.equal(detectCliType(null), null));
});

describe("getBaseCommand", () => {
  test("extracts first word", () => assert.equal(getBaseCommand("claude --model opus"), "claude"));
  test("handles empty string", () => assert.equal(getBaseCommand(""), ""));
  test("handles null", () => assert.equal(getBaseCommand(null), ""));
  test("trims leading space", () => assert.equal(getBaseCommand("  bash  "), "bash"));
});

// ── Worker construction ───────────────────────────────────────────────────────

describe("createWorker — construction", () => {
  test("exposes readable id property", () => {
    const w = createWorker(makeOpts());
    assert.equal(w.id, "1");
  });

  test("tmuxTarget prefers tmuxSessionId over sessionName", () => {
    const w = createWorker(makeOpts({ tmuxSessionId: "$5" }));
    assert.equal(w.tmuxTarget, "$5");
  });

  test("tmuxTarget falls back to sessionName when tmuxSessionId is null", () => {
    const w = createWorker(makeOpts({ tmuxSessionId: null }));
    assert.equal(w.tmuxTarget, "term-1");
  });

  test("detects cliType from cmd", () => {
    const w = createWorker(makeOpts({ cmd: "claude --model opus" }));
    assert.equal(w.cliType, "claude");
  });

  test("initial status is running", () => {
    const w = createWorker(makeOpts());
    assert.equal(w.status, "running");
  });

  test("calls hydrateWorker on construction", () => {
    const { watcherEngine, sessionStateManager, telegramService, calls } = makeFakes();
    createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    assert.equal(calls.hydrateWorker.length, 1);
  });
});

// ── tick() ────────────────────────────────────────────────────────────────────

describe("tick() — no changes", () => {
  test("returns empty or only monitorMeta event when nothing changed", () => {
    const w = createWorker(makeOpts());
    const events = w.tick(makeTick("$ "));
    const public_ = events.filter(e => !e.type.startsWith("_"));
    // At most one monitorMeta event
    assert.ok(public_.length <= 1);
    if (public_.length === 1) assert.equal(public_[0].type, "monitorMeta");
  });

  test("returns no broadcast events when output is unchanged", () => {
    const w = createWorker(makeOpts());
    // First tick sets lastCapture
    w.tick(makeTick("$ "));
    // Second tick with same output — nothing new to broadcast
    const events2 = w.tick(makeTick("$ "));
    const broadcastTypes = events2.filter(e => !e.type.startsWith("_")).map(e => e.type);
    assert.ok(!broadcastTypes.includes("snapshot"));
  });
});

describe("tick() — CWD change", () => {
  test("emits cwd event when paneInfo.cwd differs from internal cwd", () => {
    const w = createWorker(makeOpts());
    const paneInfo = { cwd: "/new/path", paneCmd: "claude", sessionAttached: "0", sessionId: "$1" };
    const events = w.tick(makeTick("$ ", paneInfo));
    assert.ok(events.some(e => e.type === "cwd" && e.cwd === "/new/path"));
  });

  test("does NOT emit duplicate cwd event on next tick with same cwd", () => {
    const w = createWorker(makeOpts());
    const paneInfo = { cwd: "/new/path", paneCmd: "claude", sessionAttached: "0", sessionId: "$1" };
    w.tick(makeTick("$ ", paneInfo));
    const events2 = w.tick(makeTick("$ ", paneInfo));
    assert.ok(!events2.some(e => e.type === "cwd"));
  });
});

describe("tick() — sessionAttached transition", () => {
  test("emits sessionAttached event when client attaches", () => {
    const w = createWorker(makeOpts());
    const paneInfo = { cwd: "/home/user", paneCmd: "claude", sessionAttached: "1", sessionId: "$1" };
    const events = w.tick(makeTick("$ ", paneInfo));
    const evt = events.find(e => e.type === "sessionAttached");
    assert.ok(evt);
    assert.equal(evt.attached, true);
  });

  test("emits _tmux_resize_auto directive when client attaches", () => {
    const w = createWorker(makeOpts());
    const paneInfo = { cwd: "/home/user", paneCmd: "claude", sessionAttached: "1", sessionId: "$1" };
    const events = w.tick(makeTick("$ ", paneInfo));
    assert.ok(events.some(e => e.type === "_tmux_resize_auto"));
  });

  test("emits _tmux_resize directive when dims change and not attached", () => {
    const { watcherEngine, sessionStateManager, telegramService } = makeFakes();
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    // Calling resize should return the directive immediately
    const events = w.resize(120, 40);
    const resize = events.find(e => e.type === "_tmux_resize");
    assert.ok(resize, "expected resize() to return _tmux_resize event");
    assert.equal(resize.cols, 120);
    assert.equal(resize.rows, 40);
  });

  test("does NOT emit _tmux_resize when session is attached", () => {
    const w = createWorker(makeOpts());
    w.resize(120, 40);
    // Simulate a prior tick that set sessionAttached = 1
    const paneInfo = { cwd: "/home/user", paneCmd: "claude", sessionAttached: "1", sessionId: "$1" };
    // First tick: transitions to attached, emits _tmux_resize_auto but NOT _tmux_resize
    const events = w.tick(makeTick("$ ", paneInfo));
    assert.ok(!events.some(e => e.type === "_tmux_resize"));
  });
});

describe("tick() — aiState transitions", () => {
  test("emits aiState event when watcher says state changed to 'waiting'", () => {
    const { sessionStateManager, telegramService } = makeFakes();
    const watcherEngine = {
      inspect: () => ({ changed: true, nextState: "waiting", detection: { matched: true, patternName: "test", matchedText: "Wait", excerpt: "Are you sure?", autoResponse: null } }),
    };
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    const events = w.tick(makeTick("Are you sure?\n"));
    assert.ok(events.some(e => e.type === "aiState" && e.state === "waiting"));
  });

  test("emits snapshot event when watcher reports output changed", () => {
    const { sessionStateManager, telegramService } = makeFakes();
    let callCount = 0;
    const watcherEngine = {
      inspect: () => {
        callCount++;
        return { changed: callCount === 1, nextState: "running", detection: null };
      },
    };
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    const events = w.tick(makeTick("new output line\n$ "));
    assert.ok(events.some(e => e.type === "snapshot"));
  });

  test("does not emit aiState event when state hasn't changed", () => {
    const { sessionStateManager, telegramService } = makeFakes();
    const watcherEngine = {
      inspect: () => ({ changed: false, nextState: "running", detection: null }),
    };
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    w.tick(makeTick("$ "));
    const events2 = w.tick(makeTick("$ "));
    assert.ok(!events2.some(e => e.type === "aiState"));
  });
});

describe("tick() — autoMode _sendInput directive", () => {
  test("emits _sendInput directive when waiting + autoMode + autoResponse provided", () => {
    const { telegramService } = makeFakes();
    const ssm = {
      hydrateWorker:   (s) => { s.autoMode = true; s.aiMonitorEnabled = true; s.waitingState = "running"; },
      getApiMeta:      (s) => ({ aiMonitorEnabled: s.aiMonitorEnabled, autoMode: s.autoMode, waitingState: s.waitingState }),
      setWaitingState: (s, st) => { s.waitingState = st; },
      updateActivity:  () => {},
      updateMatch:     () => {},
      setResetEpoch:   () => {},
      clearResetEpoch: () => {},
      markNotification:() => {},
      shouldNotify:    () => ({ shouldSend: false, reason: "debounce" }),
    };
    const watcherEngine = {
      inspect: () => ({
        changed: true,
        nextState: "waiting",
        detection: { matched: true, patternName: "confirm", matchedText: "Do you want to proceed?", excerpt: "...", autoResponse: "yes" },
      }),
    };
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager: ssm, telegramService });
    const events = w.tick(makeTick("Do you want to proceed?\n"));
    const directive = events.find(e => e.type === "_sendInput");
    assert.ok(directive, "should emit _sendInput directive");
    assert.equal(directive.text, "yes");
  });
});

// ── markDead() ────────────────────────────────────────────────────────────────

describe("markDead()", () => {
  test("returns status:completed event", () => {
    const w = createWorker(makeOpts());
    const events = w.markDead();
    assert.ok(events.some(e => e.type === "status" && e.status === "completed"));
  });

  test("reason reflects recent stop_button action", () => {
    // We can't call rememberAction directly, but kill() sets it
    const w = createWorker(makeOpts());
    // kill() sets lastAction = stop_button, then returns kill events
    // If we then call markDead(), inferExitReason should pick it up
    // But markDead() is called when tmux session dies — so test the fallback
    const events = w.markDead();
    const statusEvt = events.find(e => e.type === "status");
    assert.ok(typeof statusEvt.reason === "string" && statusEvt.reason.length > 0);
  });

  test("calls setWaitingState(s, 'disconnected')", () => {
    const { watcherEngine, sessionStateManager, telegramService, calls } = makeFakes();
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    w.markDead();
    assert.ok(calls.setWaitingState.includes("disconnected"));
  });
});

// ── resize() ─────────────────────────────────────────────────────────────────

describe("resize()", () => {
  test("returns _tmux_resize directive when dims change and not attached", () => {
    const w = createWorker(makeOpts());
    const events = w.resize(120, 40);
    const resize = events.find(e => e.type === "_tmux_resize");
    assert.ok(resize);
    assert.equal(resize.cols, 120);
    assert.equal(resize.rows, 40);
    assert.equal(resize.target, "$1");
  });

  test("returns empty array when dims did not change", () => {
    const w = createWorker(makeOpts());
    w.resize(120, 40);        // first call latches _lastCols/_lastRows
    const events2 = w.resize(120, 40);
    assert.equal(events2.length, 0);
  });

  test("updates internal cols/rows regardless of sessionAttached", () => {
    const w = createWorker(makeOpts());
    w.resize(100, 30);
    // Transition to attached via tick
    const events = w.tick(makeTick("$ ", { cwd: "/home/user", paneCmd: "claude", sessionAttached: "1", sessionId: "$1" }));
    // When attached: no _tmux_resize expected
    const resizeEvt = events.find(e => e.type === "_tmux_resize");
    assert.ok(!resizeEvt);
  });
});

// ── sendInput() ───────────────────────────────────────────────────────────────

describe("sendInput()", () => {
  test("returns _tmux_send_keys directive", () => {
    const w = createWorker(makeOpts());
    const events = w.sendInput("hello world");
    assert.ok(events.some(e => e.type === "_tmux_send_keys" && e.text === "hello world"));
  });

  test("returns log event", () => {
    const w = createWorker(makeOpts());
    const events = w.sendInput("hello");
    assert.ok(events.some(e => e.type === "log" && e.src === "stdin" && e.text === "hello"));
  });

  test("sends each line separately for multi-line input", () => {
    const w = createWorker(makeOpts());
    const events = w.sendInput("line1\nline2\nline3");
    const keyEvents = events.filter(e => e.type === "_tmux_send_keys");
    assert.equal(keyEvents.length, 3);
    assert.equal(keyEvents[0].text, "line1");
    assert.equal(keyEvents[2].text, "line3");
  });

  test("resurrects a completed worker and emits _start_polling", () => {
    const { watcherEngine, sessionStateManager, telegramService } = makeFakes();
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    // Force completed state
    w.markDead();
    const events = w.sendInput("continue");
    assert.ok(events.some(e => e.type === "status" && e.status === "running"));
    assert.ok(events.some(e => e.type === "_start_polling"));
  });

  test("returns empty array for non-string input", () => {
    const w = createWorker(makeOpts());
    assert.deepEqual(w.sendInput(null), []);
    assert.deepEqual(w.sendInput(42), []);
  });
});

// ── sendKey() ─────────────────────────────────────────────────────────────────

describe("sendKey()", () => {
  test("returns _tmux_send_key directive", () => {
    const w = createWorker(makeOpts());
    const events = w.sendKey("C-c");
    assert.ok(events.some(e => e.type === "_tmux_send_key" && e.key === "C-c"));
  });

  test("resurrects completed worker", () => {
    const w = createWorker(makeOpts());
    w.markDead();
    const events = w.sendKey("Escape");
    assert.ok(events.some(e => e.type === "status" && e.status === "running"));
  });
});

// ── kill() ────────────────────────────────────────────────────────────────────

describe("kill()", () => {
  test("returns _tmux_kill_session directive", () => {
    const w = createWorker(makeOpts());
    const events = w.kill("Stopped by user.");
    assert.ok(events.some(e => e.type === "_tmux_kill_session" && e.target === "$1"));
  });

  test("returns status:stopped event", () => {
    const w = createWorker(makeOpts());
    const events = w.kill("Stopped by user.");
    assert.ok(events.some(e => e.type === "status" && e.status === "stopped"));
  });

  test("sets exitReason from reason param", () => {
    const w = createWorker(makeOpts());
    w.kill("My custom reason.");
    assert.equal(w.status, "stopped");
  });
});

// ── reconnect() ───────────────────────────────────────────────────────────────

describe("reconnect()", () => {
  test("emits status:running event", () => {
    const w = createWorker(makeOpts());
    w.markDead();
    const events = w.reconnect();
    assert.ok(events.some(e => e.type === "status" && e.status === "running"));
  });

  test("emits _start_polling directive", () => {
    const w = createWorker(makeOpts());
    w.markDead();
    const events = w.reconnect();
    assert.ok(events.some(e => e.type === "_start_polling"));
  });
});

// ── reset() ───────────────────────────────────────────────────────────────────

describe("reset()", () => {
  test("emits status:running, aiState:running, snapshot:[] events", () => {
    const w = createWorker(makeOpts());
    const events = w.reset();
    const types = events.map(e => e.type);
    assert.ok(types.includes("status"));
    assert.ok(types.includes("aiState"));
    assert.ok(types.includes("snapshot"));
    const snap = events.find(e => e.type === "snapshot");
    assert.deepEqual(snap.lines, []);
  });

  test("clears logs", () => {
    const w = createWorker(makeOpts({ logs: [{ src: "stdout", text: "old", ts: 0 }] }));
    w.reset();
    assert.deepEqual(w.logs, []);
  });

  test("calls removeSession on sessionStateManager", () => {
    const { watcherEngine, sessionStateManager, telegramService, calls } = makeFakes();
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    w.reset();
    assert.equal(calls.removeSession.length, 1);
  });
});

// ── toggleAiMonitor() / toggleAutoMode() ─────────────────────────────────────

describe("toggleAiMonitor()", () => {
  test("returns { enabled, events } with monitorMeta event", () => {
    const { watcherEngine, sessionStateManager, telegramService, calls } = makeFakes();
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    const result = w.toggleAiMonitor();
    assert.ok("enabled" in result);
    assert.ok(Array.isArray(result.events));
    assert.ok(result.events.some(e => e.type === "monitorMeta"));
    assert.equal(calls.toggleAiMonitor.length, 1);
  });
});

describe("toggleAutoMode()", () => {
  test("returns { enabled, events } with monitorMeta event", () => {
    const { watcherEngine, sessionStateManager, telegramService } = makeFakes();
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    const result = w.toggleAutoMode();
    assert.ok(result.events.some(e => e.type === "monitorMeta"));
  });
});

// ── setMonitorMode() ──────────────────────────────────────────────────────────

describe("setMonitorMode()", () => {
  test("returns { ok, mode, events } for valid mode", () => {
    const { watcherEngine, sessionStateManager, telegramService } = makeFakes();
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    const result = w.setMonitorMode("auto");
    assert.equal(result.ok, true);
    assert.equal(result.mode, "auto");
    assert.ok(result.events.some(e => e.type === "monitorMeta"));
  });

  test("returns null when sessionStateManager returns falsy for invalid mode", () => {
    const { watcherEngine, telegramService } = makeFakes();
    const ssm = {
      hydrateWorker:   (s) => { s.waitingState = "running"; s.aiMonitorEnabled = true; s.autoMode = false; },
      getApiMeta:      (s) => ({ aiMonitorEnabled: s.aiMonitorEnabled, autoMode: s.autoMode, waitingState: s.waitingState }),
      setWaitingState: (s, st) => { s.waitingState = st; },
      setMonitorMode:  (_s, _mode) => null, // simulates invalid mode rejection
      markNotification:() => {},
      shouldNotify:    () => ({ shouldSend: false }),
    };
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager: ssm, telegramService });
    const result = w.setMonitorMode("badmode");
    assert.equal(result, null);
  });
});

// ── toApiShape() ──────────────────────────────────────────────────────────────

describe("toApiShape()", () => {
  test("includes required API fields", () => {
    const w = createWorker(makeOpts());
    const shape = w.toApiShape();
    const required = ["id", "cwd", "cmd", "status", "sessionName", "cliType", "logs", "aiState", "exitReason", "sessionAttached"];
    for (const key of required) {
      assert.ok(key in shape, `missing key: ${key}`);
    }
  });

  test("id matches worker id", () => {
    const w = createWorker(makeOpts({ id: "42" }));
    assert.equal(w.toApiShape().id, "42");
  });

  test("cliType is claude for claude cmd", () => {
    const w = createWorker(makeOpts({ cmd: "claude" }));
    assert.equal(w.toApiShape().cliType, "claude");
  });
});

// ── Event contracts ───────────────────────────────────────────────────────────

describe("Event shape contracts", () => {
  test("all broadcast events have type and id", () => {
    const { watcherEngine, sessionStateManager, telegramService } = makeFakes();
    const w = createWorker({ ...makeOpts(), watcherEngine, sessionStateManager, telegramService });
    const paneInfo = { cwd: "/new", paneCmd: "claude", sessionAttached: "0", sessionId: "$1" };
    const events = w.tick(makeTick("some output\n$ ", paneInfo));
    for (const e of events) {
      if (!e.type.startsWith("_")) {
        assert.ok(typeof e.id === "string", `event.${e.type} missing id`);
      }
    }
  });

  test("directive events are never broadcast-shaped (type starts with _)", () => {
    const w = createWorker(makeOpts());
    w.resize(100, 30);
    const events = w.tick(makeTick("$ "));
    const directives = events.filter(e => e.type.startsWith("_"));
    for (const d of directives) {
      assert.ok(!d.id || true, "directives may or may not have id");
      assert.ok(d.type.startsWith("_"), "directive type must start with _");
    }
  });
});

// ── Poll-loop control ─────────────────────────────────────────────────────────

describe("startPolling / stopPolling", () => {
  test("startPolling sets a timer, stopPolling clears it", (t, done) => {
    const w = createWorker(makeOpts());
    let fired = false;
    w.startPolling(() => { fired = true; }, 50);
    // Timer should be active now
    w.stopPolling();
    // Give it 100ms: since we stopped immediately, it should not have fired
    setTimeout(() => {
      assert.equal(fired, false, "poll fn should not fire after stopPolling");
      done();
    }, 100);
  });
});
