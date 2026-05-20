function getActiveTab() {
  const session = getActiveSession();
  if (!session || !Array.isArray(session.tabs) || !session.tabs.length) return null;
  return session.tabs.find(t => String(t.id) === String(session.activeTabId)) || session.tabs[0] || null;
}

function renderTabs() {
  const bar = document.getElementById('tab-bar');
  if (!bar) return;
  bar.textContent = '';
  const session = getActiveSession();
  if (!session || !Array.isArray(session.tabs)) return;
  const activeTab = getActiveTab();

  session.tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (activeTab && String(activeTab.id) === String(tab.id) ? ' active' : '');
    el.dataset.id = tab.id;
    el.innerHTML = '<span class="tab-label">' + escapeHtml(tab.name || ('Tab ' + tab.id)) + '</span>';
    el.addEventListener('click', () => selectTab(tab.id));
    el.addEventListener('dblclick', () => renameTab(tab.id));
    bar.appendChild(el);
  });

  const add = document.createElement('button');
  add.className = 'tab-add';
  add.textContent = '+';
  add.title = 'New tab';
  add.addEventListener('click', createTab);
  bar.appendChild(add);
}

function selectTab(tabId) {
  const session = getActiveSession();
  if (!session) return;
  apiPost('/api/tab/select', { sessionId: session.id, tabId })
    .then(() => loadSessions());
}

function createTab() {
  const session = getActiveSession();
  if (!session) return;
  const name = prompt('Tab name', 'Tab');
  if (name === null) return;
  apiPost('/api/tab/create', { sessionId: session.id, name: String(name).trim() })
    .then(() => loadSessions());
}

function renameTab(tabId) {
  const session = getActiveSession();
  if (!session) return;
  const tab = session.tabs.find(t => String(t.id) === String(tabId));
  if (!tab) return;
  const name = prompt('Rename tab', tab.name || '');
  if (name === null) return;
  apiPost('/api/tab/rename', { sessionId: session.id, tabId: tab.id, name: String(name).trim() })
    .then(() => loadSessions());
}

function closeTab(tabId = null) {
  const session = getActiveSession();
  const tab = tabId ? (session?.tabs || []).find(t => String(t.id) === String(tabId)) : getActiveTab();
  if (!session || !tab) return;
  if (!confirm('Close tab "' + (tab.name || tab.id) + '" and all panes?')) return;
  apiPost('/api/tab/close', { sessionId: session.id, tabId: tab.id })
    .then(() => loadSessions());
}

function setActiveTabLayout(layout) {
  const session = getActiveSession();
  const tab = getActiveTab();
  if (!session || !tab) return;
  apiPost('/api/tab/layout', { sessionId: session.id, tabId: tab.id, layout })
    .then(() => loadSessions());
}

function switchTab(delta) {
  const session = getActiveSession();
  if (!session || !Array.isArray(session.tabs) || !session.tabs.length) return;
  const active = getActiveTab();
  const idx = Math.max(0, session.tabs.findIndex(t => String(t.id) === String(active?.id)));
  const next = (idx + delta + session.tabs.length) % session.tabs.length;
  selectTab(session.tabs[next].id);
}

function selectTabByIndex(idx1) {
  const session = getActiveSession();
  if (!session || !Array.isArray(session.tabs)) return;
  const tab = session.tabs[idx1 - 1];
  if (tab) selectTab(tab.id);
}
