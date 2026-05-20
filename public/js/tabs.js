// Flatten all panes across every backend session → tab → pane.
// Result is the flat list that drives the browser tab bar.
function getAllPanesFlat() {
  const panes = [];
  for (const s of getSessions()) {
    for (const t of (s.tabs || [])) {
      for (const p of (t.panes || [])) {
        panes.push(p);
      }
    }
  }
  return panes;
}

// Return the backend tab that owns the currently active pane.
function getActiveTab() {
  const pid = (typeof activePaneId !== 'undefined') ? String(activePaneId || '') : '';
  if (pid) {
    for (const s of getSessions()) {
      for (const t of (s.tabs || [])) {
        if ((t.paneIds || []).some(id => String(id) === pid)) return t;
      }
    }
  }
  const session = getActiveSession();
  if (!session || !Array.isArray(session.tabs) || !session.tabs.length) return null;
  return session.tabs.find(t => String(t.id) === String(session.activeTabId)) || session.tabs[0] || null;
}

// Render one browser tab per pane/worker. Each tab shows a status dot, the
// command name, the last path segment, and a close button.
function renderTabs() {
  const bar = document.getElementById('tab-bar');
  if (!bar) return;
  bar.textContent = '';

  const panes = getAllPanesFlat();
  const pid = (typeof activePaneId !== 'undefined') ? String(activePaneId || '') : '';

  panes.forEach(pane => {
    const isActive = pid && String(pane.id) === pid;
    const el = document.createElement('div');
    el.className = 'session-tab' + (isActive ? ' active' : '');
    el.dataset.id = pane.id;

    const state = (typeof paneStateLabel === 'function') ? paneStateLabel(pane) : 'running';
    const cmd = escapeHtml(pane.cmd || 'session');
    const cwdParts = (pane.cwd || '').split('/').filter(Boolean);
    const folder = escapeHtml(cwdParts.pop() || pane.cwd || '~');

    el.innerHTML =
      '<span class="session-tab-dot session-dot-' + state + '"></span>' +
      '<span class="session-tab-label">' + cmd + ' · ' + folder + '</span>' +
      '<button class="session-tab-close" title="Close session">✕</button>';

    el.addEventListener('click', e => {
      if (!e.target.matches('.session-tab-close') && typeof focusPane === 'function') {
        focusPane(pane.id);
      }
    });
    el.querySelector('.session-tab-close').addEventListener('click', e => {
      e.stopPropagation();
      if (typeof closePane === 'function') closePane(pane.id);
    });

    bar.appendChild(el);
  });

  // "+" button opens the spawn toolbar
  const addBtn = document.createElement('button');
  addBtn.className = 'session-tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'New session';
  addBtn.addEventListener('click', () => {
    const toolbar = document.getElementById('spawn-toolbar');
    if (toolbar) toolbar.style.display = toolbar.style.display === 'none' ? 'flex' : 'none';
  });
  bar.appendChild(addBtn);
}

// ── Backwards-compat stubs used by pane.js / app.js ──────────────────────────

function selectTab() { /* no-op: tabs are panes now, use focusPane() */ }
function createTab()  { /* no-op: use spawnSession() */ }
function renameTab()  { /* no-op */ }
function closeTab()   { if (typeof closePane === 'function' && typeof activePaneId !== 'undefined') closePane(activePaneId); }

function setActiveTabLayout(layout) {
  if (typeof setLayoutMode === 'function') setLayoutMode(layout);
}

// Cycle through all panes instead of backend tabs.
function switchTab(delta) {
  const panes = getAllPanesFlat();
  if (!panes.length) return;
  const pid = (typeof activePaneId !== 'undefined') ? String(activePaneId || '') : '';
  const idx = Math.max(0, panes.findIndex(p => String(p.id) === pid));
  const next = (idx + delta + panes.length) % panes.length;
  if (typeof focusPane === 'function') focusPane(panes[next].id);
}

function selectTabByIndex(idx1) {
  const panes = getAllPanesFlat();
  const pane = panes[idx1 - 1];
  if (pane && typeof focusPane === 'function') focusPane(pane.id);
}
