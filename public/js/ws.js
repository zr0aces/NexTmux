let ws;

function initWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);
  ws.onopen = () => {
    document.getElementById('status-dot').classList.remove('off');
    sendResize();
  };
  ws.onclose = () => {
    document.getElementById('status-dot').classList.add('off');
    setTimeout(initWS, 2000);
  };
  ws.onmessage = e => {
    try { handleMsg(JSON.parse(e.data)); } catch (_) {}
  };
}

function handleMsg(d) {
  if (d.type === 'spawned' || d.type === 'session_updated' || d.type === 'tab_updated') {
    loadSessions();
    return;
  }
  if (d.type === 'log') appendLog(d.id, d.src, d.text);
  if (d.type === 'status') updateStatus(d.id, d.status, d.reason || null);
  if (d.type === 'cwd') updateCwd(d.id, d.cwd);
  if (d.type === 'aiState') updateAIState(d.id, d.state);
  if (d.type === 'monitorMeta') updateMonitorMeta(d.id, d);
  if (d.type === 'process') updateProcessName(d.id, d.processName);
  if (d.type === 'preview_detected') ensurePreview(d.workerId, d.port);
  if (d.type === 'preview_prompt') showPreviewPrompt(d.workerId, d.port, d.contentType);
  if (d.type === 'preview_tunnel') updatePreviewTunnel(d.port, d.url);
  if (d.type === 'snapshot') {
    const box = document.getElementById('logs-' + d.id);
    if (!box) return;
    const wasAtBottom = isNearBottom(box);
    box.innerHTML = '';
    d.lines.forEach(text => {
      const line = document.createElement('div');
      line.className = 'log-line stdout';
      line.innerHTML = (typeof ansiToHtml === 'function') ? ansiToHtml(text) : escapeHtml(text);
      box.appendChild(line);
    });
    if (wasAtBottom) box.scrollTop = box.scrollHeight;
  }
}

function measureChar(box) {
  const span = document.createElement('span');
  span.className = 'log-line';
  span.style.visibility = 'hidden';
  span.style.position = 'absolute';
  span.textContent = 'X';
  box.appendChild(span);
  const rect = span.getBoundingClientRect();
  box.removeChild(span);
  return { w: rect.width, h: rect.height };
}

function sendResize() {
  if (!ws || ws.readyState !== 1) return;
  const box = Array.from(document.querySelectorAll('.logs'))
    .find(el => el.clientWidth > 0 && el.clientHeight > 0 && el.getClientRects().length > 0);
  if (!box || !box.clientWidth) return;
  const ch = measureChar(box);
  if (!ch.w || !ch.h) return;
  const style = getComputedStyle(box);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const innerW = Math.max(0, box.clientWidth - padX);
  const innerH = Math.max(0, box.clientHeight - padY);
  const cols = Math.max(8, Math.floor(innerW / ch.w));
  const rows = Math.max(4, Math.floor(innerH / ch.h));
  // Resize all currently visible panes.
  const ids = (typeof getVisiblePaneIds === 'function')
    ? getVisiblePaneIds()
    : (getActiveTab()?.paneIds || []);
  if (!ids.length) return;
  ids.forEach(id => {
    ws.send(JSON.stringify({ type: 'resize', id, cols, rows }));
  });
}

function apiPost(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include'
  });
}

function apiGet(url) {
  return fetch(url, { credentials: 'include' }).then(r => r.json());
}

function loadSessions() {
  return apiGet('/api/sessions').then(setWorkspaceState);
}

function loadAll() {
  return loadSessions();
}

function loadConfig() {
  apiGet('/api/config')
    .then(cfg => {
      if (cfg.basePath) window._basePath = cfg.basePath;
      if (cfg.favorites && !localStorage.getItem('fav')) {
        favorites = cfg.favorites;
        saveFavs();
      }
      renderDropdown();
    })
    .catch(() => {});
}
