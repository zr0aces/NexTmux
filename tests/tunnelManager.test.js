/**
 * tests/tunnelManager.test.js
 *
 * Unit tests for lib/tunnelManager.js.
 * Run with: node --test tests/tunnelManager.test.js
 */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
// Mock dependencies of child_process
const mockChildProcess = {
  spawn: (cmd, args) => {
    mockChildProcess.spawnCalls.push({ cmd, args });
    
    // Return a fake child process (EventEmitter)
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {
      proc.killed = true;
      proc.emit("close", 0);
    };
    proc.killed = false;
    proc.exitCode = null;

    mockChildProcess.lastProc = proc;
    return proc;
  },
  execSync: (cmd, opts) => {
    mockChildProcess.execSyncCalls.push({ cmd, opts });
    if (cmd === "which cloudflared") {
      if (mockChildProcess.cloudflaredExists) return "/usr/local/bin/cloudflared";
      throw new Error("not found");
    }
    return "";
  },
  spawnCalls: [],
  execSyncCalls: [],
  cloudflaredExists: true,
  lastProc: null,
  reset() {
    this.spawnCalls = [];
    this.execSyncCalls = [];
    this.cloudflaredExists = true;
    this.lastProc = null;
  }
};

// Require child_process and inject mock exports
const cp = require("child_process");
Object.assign(cp, mockChildProcess);

// Clear require cache for tunnelManager so it destructures mocked functions
delete require.cache[require.resolve("../lib/tunnelManager")];
const TunnelManager = require("../lib/tunnelManager");

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeFakes() {
  const urls = [];
  const alerts = [];
  const logs = [];

  const onUrlChange = (url) => urls.push(url);
  const onAlert = (alert) => alerts.push(alert);
  const logger = {
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => logs.push("[ERROR] " + args.join(" ")),
  };

  return { onUrlChange, onAlert, logger, urls, alerts, logs };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TunnelManager", () => {

  test("does not start if tunnelEnabled is false", () => {
    mockChildProcess.reset();
    const fakes = makeFakes();
    const tm = new TunnelManager({
      port: 8081,
      tunnelEnabled: false,
      onUrlChange: fakes.onUrlChange,
      onAlert: fakes.onAlert,
      logger: fakes.logger,
    });

    tm.start();
    assert.equal(mockChildProcess.spawnCalls.length, 0);
    assert.ok(fakes.logs.some(l => l.includes("Tunnel disabled")));
  });

  test("skips starting and sends alert if cloudflared is missing", () => {
    mockChildProcess.reset();
    mockChildProcess.cloudflaredExists = false;

    const fakes = makeFakes();
    const tm = new TunnelManager({
      port: 8081,
      tunnelEnabled: true,
      onUrlChange: fakes.onUrlChange,
      onAlert: fakes.onAlert,
      logger: fakes.logger,
    });

    tm.start();
    assert.equal(mockChildProcess.spawnCalls.length, 0);
    assert.ok(fakes.alerts.some(a => a.key === "tunnel-cloudflared-missing"));
  });

  test("starts cloudflared process and parses output URL", () => {
    mockChildProcess.reset();
    const fakes = makeFakes();
    const tm = new TunnelManager({
      port: 8081,
      tunnelEnabled: true,
      onUrlChange: fakes.onUrlChange,
      onAlert: fakes.onAlert,
      logger: fakes.logger,
    });

    tm.start();
    assert.equal(mockChildProcess.spawnCalls.length, 1);
    assert.equal(mockChildProcess.spawnCalls[0].cmd, "cloudflared");

    // Simulate stdout containing tunnel url
    const url = "https://some-uuid.trycloudflare.com";
    mockChildProcess.lastProc.stderr.emit("data", Buffer.from(`INF URL: ${url}\n`));

    assert.equal(tm.tunnelUrl, url);
    assert.deepEqual(fakes.urls, [url]);
  });

  test("reconnects on tunnel exit", (t, done) => {
    mockChildProcess.reset();
    const fakes = makeFakes();
    const tm = new TunnelManager({
      port: 8081,
      tunnelEnabled: true,
      onUrlChange: fakes.onUrlChange,
      onAlert: fakes.onAlert,
      logger: fakes.logger,
    });

    tm.start();
    const proc1 = mockChildProcess.lastProc;

    // Trigger exit
    proc1.emit("close", 1);
    assert.ok(fakes.alerts.some(a => a.key === "tunnel-exit-1"));

    // Check that it schedules restart
    assert.ok(tm.reconnectTimeout);

    // Speed up restart trigger by clearing reconnectTimeout and running manually
    clearTimeout(tm.reconnectTimeout);
    tm._startTunnelProcess();

    // Verify it spawned a new process
    assert.equal(mockChildProcess.spawnCalls.length, 2);
    tm.stop();
    done();
  });

  test("stop() terminates process and clears intervals", () => {
    mockChildProcess.reset();
    const fakes = makeFakes();
    const tm = new TunnelManager({
      port: 8081,
      tunnelEnabled: true,
      healthcheckEnabled: true,
      onUrlChange: fakes.onUrlChange,
      onAlert: fakes.onAlert,
      logger: fakes.logger,
    });

    tm.start();
    assert.ok(tm.healthInterval);

    tm.stop();
    assert.equal(tm.healthInterval, null);
    assert.equal(tm.tunnelProcess, null);
  });
});
