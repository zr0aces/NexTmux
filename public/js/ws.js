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
  if (d && d.type === 'tunnel') {
    // Tunnel URL broadcast handling (if tunnel URL starts, just store it)
    window._tunnelUrl = d.url;
    return;
  }
  if (window.workerStore) {
    window.workerStore.update(d);
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
      const box = entry.target;
      const w = Math.floor(entry.contentRect.width);
      const h = Math.floor(entry.contentRect.height);
      if (w > 0 && h > 0) {
        const lastW = parseInt(box.dataset.lastWidth, 10);
        const lastH = parseInt(box.dataset.lastHeight, 10);
        if (w !== lastW || h !== lastH) {
          box.dataset.lastWidth = w;
          box.dataset.lastHeight = h;
          shouldResize = true;
        }
      } else {
        delete box.dataset.lastWidth;
        delete box.dataset.lastHeight;
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
      const serverIds = new Set(list.map(w => String(w.id)));

      if (window.workerStore) {
        list.forEach(w => {
          window.workerStore.update({ type: 'spawned', ...w });
        });
        window.workerStore.prune(serverIds);
        window.workerStore.emit('loadComplete', serverIds);
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
