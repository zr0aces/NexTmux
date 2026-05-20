let workspaceState = {
  activeSessionId: null,
  sessions: [],
};

function getSessions() {
  return Array.isArray(workspaceState.sessions) ? workspaceState.sessions : [];
}

// Find the session that contains the currently active pane; fall back to the
// server-reported active session or the first session.
function getActiveSession() {
  const sessions = getSessions();
  if (!sessions.length) return null;
  const pid = (typeof activePaneId !== 'undefined') ? String(activePaneId || '') : '';
  if (pid) {
    for (const s of sessions) {
      for (const t of (s.tabs || [])) {
        if ((t.paneIds || []).some(id => String(id) === pid)) return s;
      }
    }
  }
  return sessions.find(s => String(s.id) === String(workspaceState.activeSessionId)) || sessions[0] || null;
}

function setWorkspaceState(next) {
  workspaceState = {
    activeSessionId: next?.activeSessionId || null,
    sessions: Array.isArray(next?.sessions) ? next.sessions : [],
  };
  renderTabs();
  renderPanes();
  updateWorkspaceStatus();
}
