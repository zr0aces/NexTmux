let activePaneId = null;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPaneById(id) {
  const sid = String(id);
  for (const s of (workspaceState.sessions || [])) {
    for (const t of (s.tabs || [])) {
      for (const p of (t.panes || [])) {
        if (String(p.id) === sid) return { session: s, tab: t, pane: p };
      }
    }
  }
  return null;
}

function isNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 50;
}

function renderPanes() {
  const root = document.getElementById('tab-content');
  if (!root) return;
  root.textContent = '';

  const tab = getActiveTab();
  if (!tab) {
    activePaneId = null;
    updateWorkspaceStatus();
    return;
  }

  const paneIds = Array.isArray(tab.paneIds) ? tab.paneIds.map(String) : [];
  const panes = Array.isArray(tab.panes) ? tab.panes : [];
  const orderedPanes = paneIds.map(id => panes.find(p => String(p.id) === id)).filter(Boolean);
  if (!orderedPanes.length) {
    activePaneId = null;
    updateWorkspaceStatus();
    return;
  }

  if (!activePaneId || !orderedPanes.some(p => String(p.id) === String(activePaneId))) {
    activePaneId = tab.activePaneId || orderedPanes[0].id;
  }

  root.className = 'pane-workspace layout-' + (tab.layout || 'single') + ' pane-count-' + orderedPanes.length;
  orderedPanes.forEach(p => root.appendChild(renderPaneCard(p)));
  updateWorkspaceStatus();
  setTimeout(sendResize, 20);
}

function paneStateLabel(pane) {
  if (!pane) return 'stopped';
  if (pane.status === 'completed' || pane.status === 'stopped') return 'error';
  if (pane.aiState === 'waiting') return 'waiting';
  if (pane.aiState === 'idle') return 'idle';
  return 'running';
}

function renderPaneCard(pane) {
  const id = String(pane.id);
  const wrap = document.createElement('section');
  wrap.className = 'pane-card' + (String(activePaneId) === id ? ' active' : '');
  wrap.dataset.id = id;

  const state = paneStateLabel(pane);
  const process = escapeHtml(pane.processName || pane.cmd || 'unknown');
  const title = escapeHtml(pane.cmd || 'claude');
  const cwd = escapeHtml(displayPath(pane.cwd || ''));

  wrap.innerHTML =
    '<div class="pane-header">' +
      '<button class="pane-title-btn" id="pane-focus-' + id + '">' +
        '<span class="pane-dot pane-' + state + '"></span>' +
        '<span class="pane-title">#' + id + ' ' + title + '</span>' +
        '<span class="pane-process" id="pane-process-' + id + '">' + process + '</span>' +
      '</button>' +
      '<div class="pane-actions">' +
        '<span class="pane-cwd" id="card-cwd-' + id + '" title="' + escapeHtml(pane.cwd || '') + '">' + cwd + '</span>' +
        '<select class="monitor-mode-selector" id="monitor-mode-' + id + '" title="AI Monitor Mode">' +
          '<option value="off">○</option>' +
          '<option value="monitor">👁</option>' +
          '<option value="auto">⚡</option>' +
        '</select>' +
        '<button class="header-btn" id="diff-' + id + '" title="Git Diff">Diff</button>' +
        '<button class="header-btn" id="close-pane-' + id + '" title="Close Pane">✕</button>' +
      '</div>' +
    '</div>' +
    '<div class="logs" id="logs-' + id + '"></div>' +
    '<div class="input-row" id="input-row-' + id + '">' +
      '<textarea id="inp-' + id + '" placeholder="Enter command..." rows="1"></textarea>' +
      '<button id="send-' + id + '">Send</button>' +
    '</div>';

  wrap.addEventListener('mousedown', () => focusPane(id));

  const logsEl = wrap.querySelector('#logs-' + id);
  (pane.logs || []).forEach(l => {
    const line = document.createElement('div');
    line.className = 'log-line ' + (l.src || 'stdout');
    line.innerHTML = (typeof ansiToHtml === 'function') ? ansiToHtml(l.text || '') : escapeHtml(l.text || '');
    logsEl.appendChild(line);
  });
  logsEl.scrollTop = logsEl.scrollHeight;

  const sendBtn = wrap.querySelector('#send-' + id);
  const inp = wrap.querySelector('#inp-' + id);
  sendBtn.addEventListener('click', () => sendInput(id));
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inp.value.trim()) sendInput(id);
      else sendSpecialKey(id, 'Enter');
    }
  });
  inp.addEventListener('input', () => {
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
  });

  const monitorMode = pane.monitorMode || (pane.aiMonitorEnabled === false ? 'off' : (pane.autoMode ? 'auto' : 'monitor'));
  const monitorSel = wrap.querySelector('#monitor-mode-' + id);
  monitorSel.value = monitorMode;
  monitorSel.addEventListener('change', (e) => setMonitorMode(id, e.target.value));

  wrap.querySelector('#pane-focus-' + id).addEventListener('click', () => focusPane(id));
  wrap.querySelector('#close-pane-' + id).addEventListener('click', () => closePane(id));
  wrap.querySelector('#diff-' + id).addEventListener('click', () => openGitDiff(id));

  if (pane.status === 'completed' || pane.status === 'stopped') {
    wrap.querySelector('#input-row-' + id).style.display = 'none';
  }

  return wrap;
}

function focusPane(id) {
  const paneId = String(id);
  activePaneId = paneId;
  const session = getActiveSession();
  const tab = getActiveTab();
  if (session && tab) {
    apiPost('/api/pane/focus', { sessionId: session.id, tabId: tab.id, paneId }).catch(() => {});
  }
  document.querySelectorAll('.pane-card').forEach(el => el.classList.toggle('active', el.dataset.id === paneId));
  updateWorkspaceStatus();
  setTimeout(sendResize, 10);
}

function updateWorkspaceStatus() {
  const bar = document.getElementById('workspace-status');
  if (!bar) return;
  const current = activePaneId ? getPaneById(activePaneId) : null;
  if (!current) {
    bar.textContent = 'No pane selected';
    return;
  }
  const p = current.pane;
  const state = paneStateLabel(p);
  bar.textContent = 'Session: ' + (current.session?.name || '-') +
    '  |  Tab: ' + (current.tab?.name || '-') +
    '  |  Pane #' + p.id +
    '  |  State: ' + state +
    '  |  Process: ' + (p.processName || p.cmd || 'unknown') +
    '  |  ' + (p.cwd || '');
}

function appendLog(id, src, text) {
  const box = document.getElementById('logs-' + id);
  if (!box) return;
  const wasAtBottom = isNearBottom(box);
  const line = document.createElement('div');
  line.className = 'log-line ' + (src || 'stdout');
  line.innerHTML = (typeof ansiToHtml === 'function') ? ansiToHtml(text || '') : escapeHtml(text || '');
  box.appendChild(line);
  if (wasAtBottom) box.scrollTop = box.scrollHeight;
}

function updateStatus(id, status, reason) {
  const found = getPaneById(id);
  if (found) {
    found.pane.status = status;
    if (reason) found.pane.exitReason = reason;
  }
  renderPanes();
}

function updateAIState(id, state) {
  const found = getPaneById(id);
  if (found) found.pane.aiState = state;
  renderPanes();
}

function updateMonitorMeta(id, meta) {
  const found = getPaneById(id);
  if (found) Object.assign(found.pane, meta || {});
  const sel = document.getElementById('monitor-mode-' + id);
  if (sel) {
    const mode = meta?.monitorMode || 'monitor';
    sel.value = mode;
  }
}

function updateCwd(id, cwd) {
  const found = getPaneById(id);
  if (found) found.pane.cwd = cwd;
  const el = document.getElementById('card-cwd-' + id);
  if (el) {
    el.textContent = displayPath(cwd);
    el.title = cwd;
  }
  updateWorkspaceStatus();
}

function updateProcessName(id, processName) {
  const found = getPaneById(id);
  if (found) found.pane.processName = processName;
  const el = document.getElementById('pane-process-' + id);
  if (el) el.textContent = processName || 'unknown';
  updateWorkspaceStatus();
}

function notifyActive() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'active' }));
}

function sendSpecialKey(id, key) {
  focusPane(id);
  notifyActive();
  apiPost('/api/key', { id: String(id), key });
}

function sendInput(id) {
  const inp = document.getElementById('inp-' + id);
  if (!inp) return;
  let text = inp.value.trim();
  if (!text) return;
  text = text.split('\n').filter(Boolean).join('\n');
  if (!text) return;
  inp.value = '';
  inp.style.height = 'auto';
  notifyActive();
  apiPost('/api/input', { id: String(id), text });
}

function closePane(id) {
  if (!confirm('Close pane #' + id + '?')) return;
  apiPost('/api/pane/close', { paneId: String(id) })
    .then(() => loadSessions());
}

function reconnectWorker(id) {
  apiPost('/api/reconnect', { id: String(id) })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) alert('Session is no longer alive.');
      loadSessions();
    });
}

function setMonitorMode(id, mode) {
  apiPost('/api/set-monitor-mode', { id: String(id), mode })
    .then(() => loadSessions())
    .catch(() => {});
}

function spawnSession() {
  const session = getActiveSession();
  const tab = getActiveTab();
  if (!session || !tab) return;
  var raw = document.getElementById('cwd-input').value.trim();
  var base = window._basePath || '/tmp';
  var cwd = raw ? (raw.startsWith('/') ? raw : base + '/' + raw) : base;
  const cmd = document.getElementById('cmd-input').value.trim();
  apiPost('/api/spawn', { cwd, cmd, uiSessionId: session.id, uiTabId: tab.id })
    .then(r => r.json().catch(() => ({})).then(d => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || d.ok === false) {
        alert(d.error || 'Invalid path. Pane not created.');
        return;
      }
      addRecent(cwd);
      loadSessions();
    })
    .catch(() => { alert('Failed to create pane.'); });
}

function splitPane(layout) {
  const session = getActiveSession();
  const tab = getActiveTab();
  if (!session || !tab) return;
  apiPost('/api/pane/split', {
    sessionId: session.id,
    tabId: tab.id,
    sourcePaneId: activePaneId,
    layout,
  }).then(() => loadSessions());
}

function scanSessions() {
  const btn = document.getElementById('scan-btn');
  btn.textContent = '⏳';
  apiGet('/api/scan')
    .then(found => {
      btn.textContent = '🔍';
      if (!found.length) { alert('No new tmux sessions found.'); return; }
      const names = found.map(f => '• ' + f.sessionName + ' (' + displayPath(f.cwd) + ')').join('\n');
      if (!confirm('Add these sessions to workspace?\n\n' + names)) return;
      const session = getActiveSession();
      const tab = getActiveTab();
      found.forEach(f => apiPost('/api/attach', {
        sessionName: f.sessionName,
        cwd: f.cwd,
        uiSessionId: session?.id,
        uiTabId: tab?.id,
      }));
      setTimeout(loadSessions, 300);
    })
    .catch(() => { btn.textContent = '🔍'; });
}

function removeWorker(id) {
  closePane(id);
}

function killWorker(id) {
  if (!confirm('Stop Pane #' + id + '?')) return;
  apiPost('/api/kill', { id: String(id) }).then(() => loadSessions());
}

function ensureCard() {}
function bindTabDrag() {}
function renderTitle() {}
function updateExitReason() {}
function sendQuickCommand(id, text) { apiPost('/api/input', { id: String(id), text }); }
