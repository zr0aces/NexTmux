"use strict";
// ── store.js ──
// Client-side Worker state store.
// Decouples WebSocket transport and REST API queries from DOM rendering.
// ws.js updates this store, and workers.js listens to change events.

class WorkerStore {
  constructor() {
    this.workers = new Map();
    this.listeners = new Map(); // eventType -> Set of callbacks
  }

  on(event, cb) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(cb);
  }

  emit(event, ...args) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try {
          cb(...args);
        } catch (e) {
          console.error(`Error in WorkerStore listener for event ${event}:`, e);
        }
      });
    }
  }

  get(id) {
    return this.workers.get(String(id));
  }

  getAll() {
    return [...this.workers.values()];
  }

  update(d) {
    if (!d || !d.id) return;
    const id = String(d.id);

    // 1. Handle spawned / full state update
    if (d.type === 'spawned') {
      const state = {
        id,
        cwd: d.cwd || '',
        status: d.status || 'running',
        cmd: d.cmd || '',
        exitReason: d.exitReason || d.reason || null,
        sessionName: d.sessionName || ('worker-' + id),
        cliType: d.cliType || null,
        logs: d.logs || [],
        aiState: d.aiState || null,
        sessionAttached: d.sessionAttached || 0,
        aiMonitorEnabled: d.aiMonitorEnabled !== false,
        autoMode: d.autoMode || false,
        waitingState: d.waitingState || 'running',
        tokenResetAt: d.tokenResetAt || null,
        resetAtEpochMs: d.resetAtEpochMs || null,
        lastActivityAt: d.lastActivityAt || null,
        lastMatchedPattern: d.lastMatchedPattern || null,
        lastPromptExcerpt: d.lastPromptExcerpt || null,
      };
      this.workers.set(id, state);
      this.emit('spawned', id, state, d.fromRecovery);
      return;
    }

    // 2. Fetch existing state or create a skeleton
    let w = this.workers.get(id);
    if (!w) {
      w = {
        id,
        cwd: '',
        status: 'running',
        cmd: '',
        exitReason: null,
        sessionName: 'worker-' + id,
        cliType: null,
        logs: [],
        aiState: null,
        sessionAttached: 0,
        aiMonitorEnabled: false,
        autoMode: false,
        waitingState: 'running',
        tokenResetAt: null,
        resetAtEpochMs: null,
        lastActivityAt: null,
        lastMatchedPattern: null,
        lastPromptExcerpt: null,
      };
      this.workers.set(id, w);
    }

    // 3. Process discrete events and update state + emit specific events
    if (d.type === 'log') {
      w.logs.push({ src: d.src, text: d.text, ts: d.ts || Date.now() });
      if (w.logs.length > 200) w.logs.shift();
      this.emit('log', id, d.src, d.text);
    }
    else if (d.type === 'status') {
      w.status = d.status;
      w.exitReason = d.reason || d.exitReason || null;
      this.emit('status', id, d.status, w.exitReason);
    }
    else if (d.type === 'cwd') {
      w.cwd = d.cwd;
      this.emit('cwd', id, d.cwd);
    }
    else if (d.type === 'aiState') {
      w.aiState = d.state;
      this.emit('aiState', id, d.state);
    }
    else if (d.type === 'sessionAttached') {
      w.sessionAttached = d.attached ? 1 : 0;
      this.emit('sessionAttached', id, d.attached);
    }
    else if (d.type === 'sessionName') {
      w.sessionName = d.sessionName;
      this.emit('sessionName', id, d.sessionName);
    }
    else if (d.type === 'snapshot') {
      w.logs = d.lines.map(text => ({ src: 'stdout', text, ts: Date.now() }));
      this.emit('snapshot', id, d.lines);
    }
    else if (d.type === 'monitorMeta') {
      w.aiMonitorEnabled = d.aiMonitorEnabled;
      w.autoMode = d.autoMode;
      w.waitingState = d.waitingState;
      w.tokenResetAt = d.tokenResetAt;
      w.resetAtEpochMs = d.resetAtEpochMs;
      w.lastActivityAt = d.lastActivityAt;
      w.lastMatchedPattern = d.lastMatchedPattern;
      w.lastPromptExcerpt = d.lastPromptExcerpt;
      this.emit('monitorMeta', id, w);
    }
  }

  prune(serverIds) {
    for (const id of this.workers.keys()) {
      if (!serverIds.has(id)) {
        this.workers.delete(id);
        this.emit('pruned', id);
      }
    }
  }
}

window.workerStore = new WorkerStore();
