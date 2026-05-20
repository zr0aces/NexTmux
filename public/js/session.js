let workspaceState = {
  activeSessionId: null,
  sessions: [],
};

function getSessions() {
  return Array.isArray(workspaceState.sessions) ? workspaceState.sessions : [];
}

function getActiveSession() {
  const sessions = getSessions();
  if (!sessions.length) return null;
  return sessions.find(s => String(s.id) === String(workspaceState.activeSessionId)) || sessions[0] || null;
}

function setWorkspaceState(next) {
  workspaceState = {
    activeSessionId: next?.activeSessionId || null,
    sessions: Array.isArray(next?.sessions) ? next.sessions : [],
  };
  renderSessionSelector();
  renderTabs();
  renderPanes();
  updateWorkspaceStatus();
}

function renderSessionSelector() {
  const sel = document.getElementById('session-select');
  if (!sel) return;
  const sessions = getSessions();
  const active = getActiveSession();
  sel.textContent = '';
  sessions.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
  if (active) {
    sel.value = active.id;
    workspaceState.activeSessionId = active.id;
  }
}

function selectSession(sessionId) {
  return apiPost('/api/session/select', { sessionId })
    .then(() => loadSessions());
}

function createSession() {
  const name = prompt('Session name', 'Main');
  if (name === null) return;
  apiPost('/api/session/create', { name: String(name).trim() })
    .then(r => r.json())
    .then(() => loadSessions());
}

function renameSession() {
  const s = getActiveSession();
  if (!s) return;
  const name = prompt('Rename session', s.name || '');
  if (name === null) return;
  apiPost('/api/session/rename', { sessionId: s.id, name: String(name).trim() })
    .then(() => loadSessions());
}

function closeSession() {
  const s = getActiveSession();
  if (!s) return;
  if (!confirm('Close session "' + s.name + '" and all tabs/panes?')) return;
  apiPost('/api/session/close', { sessionId: s.id })
    .then(() => loadSessions());
}
