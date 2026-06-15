// ── WebSocket & API Communication ──

let ws;
let reconnectInterval = 1000;
const MAX_RECONNECT_INTERVAL = 30000;

function initWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);
  ws.onopen = () => {
    document.getElementById('status-dot').classList.remove('off');
    reconnectInterval = 1000; // reset on success
    sendResize();
    loadAll();
  };
  ws.onclose = () => {
    document.getElementById('status-dot').classList.add('off');
    setTimeout(initWS, reconnectInterval);
    reconnectInterval = Math.min(reconnectInterval * 2, MAX_RECONNECT_INTERVAL);
  };
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
}

function handleMsg(d) {
  if (d.type === 'spawned') {
    ensureCard(d.id, d.cwd, d.status, [], d.cmd, d.reason || null, d);
    if (!d.fromRecovery) selectTab(d.id);
  }
  if (d.type === 'log') appendLog(d.id, d.src, d.text);
  if (d.type === 'status') updateStatus(d.id, d.status, d.reason || null);
  if (d.type === 'cwd') updateCwd(d.id, d.cwd);
  if (d.type === 'aiState') updateAIState(d.id, d.state);
  if (d.type === 'monitorMeta') updateMonitorMeta(d.id, d);
  if (d.type === 'sessionAttached') updateSessionAttached(d.id, d.attached);
  if (d.type === 'sessionName') {
    const tab = document.querySelector('.tab[data-id="' + d.id + '"]');
    if (tab) {
      tab.dataset.sessionName = d.sessionName;
      if (typeof renderTitle === 'function') renderTitle(d.id);
    }
  }
  if (d.type === 'snapshot') {
    const box = document.getElementById('logs-' + d.id);
    if (box) {
      if (typeof initLogScrollLock === 'function') initLogScrollLock(box);
      var shouldAutoScroll = typeof isAutoScrollEnabled === 'function'
        ? isAutoScrollEnabled(box)
        : isNearBottom(box);
      
      var html = '';
      var linesLen = d.lines.length;
      for (var i = 0; i < linesLen; i++) {
        var text = d.lines[i];
        var content = (typeof ansiToHtml === 'function') ? ansiToHtml(text) : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html += '<div class="log-line stdout">' + content + '</div>';
      }
      box.innerHTML = html;

      if (shouldAutoScroll) box.scrollTop = box.scrollHeight;
    }
  }
}

function notifyActive() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'active' }));
}

// ── Terminal Resize ──

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
  const MIN_COLS = 8;
  const MIN_ROWS = 4;
  const measureBox = Array.from(document.querySelectorAll('.logs'))
    .find(el => el.clientWidth > 0 && el.clientHeight > 0 && el.getClientRects().length > 0);
  if (!measureBox) return;
  const ch = measureChar(measureBox);
  if (!ch.w || !ch.h) return;
  const style = getComputedStyle(measureBox);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);

  document.querySelectorAll('.tab').forEach(t => {
    const id = t.dataset.id;
    const box = document.getElementById('logs-' + id);
    if (box && box.clientWidth > 0 && box.clientHeight > 0) {
      const innerW = Math.max(0, box.clientWidth - padX);
      const innerH = Math.max(0, box.clientHeight - padY);
      const cols = Math.max(MIN_COLS, Math.floor(innerW / ch.w));
      const rows = Math.max(MIN_ROWS, Math.floor(innerH / ch.h));
      ws.send(JSON.stringify({ type: 'resize', id, cols, rows }));
    }
  });
}

// Debounced resize — prevents flooding the WebSocket at 60 fps during a window drag.
let _resizeTimer;
function scheduleSendResize() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(sendResize, 120);
}

if (typeof ResizeObserver !== 'undefined') {
  window.resizeObserver = new ResizeObserver(entries => {
    let shouldResize = false;
    for (const entry of entries) {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        shouldResize = true;
        break;
      }
    }
    if (shouldResize) {
      scheduleSendResize();
    }
  });
}

// ── API Calls ──

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

function loadAll() {
  apiGet('/api/workers')
    .then(list => {
      const serverIds = new Set();
      const listLen = list.length;
      for (let i = 0; i < listLen; i++) {
        serverIds.add(String(list[i].id));
      }

      // Prune client DOM tabs/panels whose worker IDs are no longer in the server list
      document.querySelectorAll('.tab').forEach(tab => {
        const id = tab.dataset.id;
        if (id && !serverIds.has(id)) {
          tab.remove();
          const panel = document.querySelector('.tab-panel[data-id="' + id + '"]');
          if (panel) panel.remove();
          const logsBox = document.getElementById('logs-' + id);
          if (logsBox && window.resizeObserver) {
            window.resizeObserver.unobserve(logsBox);
          }
        }
      });

      // Prune closedTabs of any IDs that are no longer active on the server
      if (typeof closedTabs !== 'undefined') {
        let changed = false;
        closedTabs.forEach(id => {
          if (!serverIds.has(id)) {
            closedTabs.delete(id);
            changed = true;
          }
        });
        if (changed && typeof saveClosedTabs === 'function') {
          saveClosedTabs();
        }
      }

      list.forEach(w => {
        const cardExists = !!document.getElementById('card-' + w.id);
        ensureCard(w.id, w.cwd, w.status, w.logs, w.cmd, w.exitReason || null, w);
        if (cardExists) {
          // Sync dataset properties that could have changed
          const tab = document.querySelector('.tab[data-id="' + w.id + '"]');
          if (tab) {
            tab.dataset.cwd = w.cwd;
            tab.dataset.cmd = w.cmd || '';
            if (w.sessionName) tab.dataset.sessionName = w.sessionName;
          }
          if (typeof renderTitle === 'function') {
            renderTitle(w.id, w.cwd, w.cmd);
          }
          if (typeof updateStatus === 'function') {
            updateStatus(w.id, w.status, w.exitReason || null);
          }
          const logsBox = document.getElementById('logs-' + w.id);
          if (logsBox && w.logs) {
            logsBox.innerHTML = '';
            w.logs.forEach(l => appendLog(w.id, l.src, l.text));
          }
        }
        if (w.aiState) updateAIState(w.id, w.aiState);
        updateMonitorMeta(w.id, w);
        updateSessionAttached(w.id, w.sessionAttached === 1);
      });
      if (typeof restoreTabOrder === 'function') {
        restoreTabOrder();
      }
      const savedTab = localStorage.getItem('nextmux.activeTab.v1');
      if (savedTab && !closedTabs.has(savedTab) && document.querySelector('.tab[data-id="' + savedTab + '"]:not(.closed)')) {
        selectTab(savedTab);
      } else {
        const visibleTabs = Array.from(document.querySelectorAll('.tab:not(.closed)'));
        if (visibleTabs.length > 0) {
          selectTab(visibleTabs[0].dataset.id);
        }
      }
      
      // Sync placeholders after loading everything
      if (typeof syncUIPlaceholders === 'function') {
        syncUIPlaceholders();
      }
    });
}

function loadConfig() {
  apiGet('/api/config')
    .then(cfg => {
      if (cfg.basePath) window._basePath = cfg.basePath;
      if (cfg.favorites) {
        cfg.favorites.forEach(f => {
          if (!favorites.includes(f)) {
            favorites.push(f);
          }
        });
        saveFavs();
      }
      renderDropdown();
    })
    .catch(() => {});
}
