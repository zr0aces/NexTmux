// ── Preview Tab Module ──
// Manages preview tabs for localhost ports detected in terminal output.

// "preview-{workerId}-{port}" → { workerId, port, url, mode }
// mode: 'tab' (dedicated tab) | 'split' (side-by-side within the worker panel)
const previewTabs = new Map();

function isRemoteAccess() {
  return location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
}

function isWideScreen() {
  return window.innerWidth >= 768;
}

// ── Split Preview ──

function ensureSplitPreview(workerId, port) {
  const tabId = 'preview-' + workerId + '-' + port;
  if (previewTabs.has(tabId)) return;

  const workerPanel = document.querySelector('.tab-panel[data-id="' + workerId + '"]');
  if (!workerPanel) return;

  // If the worker panel already has a split-preview, open the second port as a separate tab
  if (workerPanel.querySelector('.split-preview')) {
    ensurePreviewTab(workerId, port);
    return;
  }

  const iframeSrc = 'http://localhost:' + port;

  const container = document.createElement('div');
  container.className = 'split-preview';
  container.dataset.previewId = tabId;

  container.innerHTML =
    '<div class="preview-toolbar">' +
      '<span class="preview-url" id="preview-url-' + tabId + '">' + iframeSrc + '</span>' +
      '<button class="preview-btn" onclick="refreshPreview(\'' + tabId + '\')">↺</button>' +
      '<a class="preview-btn" id="preview-open-' + tabId + '" href="' + iframeSrc + '" target="_blank">↗</a>' +
      '<button class="split-preview-close" title="Close preview">✕</button>' +
    '</div>' +
    '<iframe' +
      ' id="preview-iframe-' + tabId + '"' +
      ' class="preview-iframe"' +
      ' src="' + iframeSrc + '"' +
      ' sandbox="allow-same-origin allow-scripts allow-popups allow-forms"' +
      ' loading="lazy"' +
    '></iframe>' +
    '<div class="preview-error" id="preview-error-' + tabId + '" style="display:none">' +
      '<p>Failed to load in iframe.</p>' +
      '<a href="' + iframeSrc + '" target="_blank">Open in new tab →</a>' +
    '</div>';

  container.querySelector('.split-preview-close').addEventListener('click', () => {
    closeSplitPreview(workerId, tabId);
  });

  // Resize handle
  const handle = document.createElement('div');
  handle.className = 'split-resize-handle';

  workerPanel.classList.add('has-preview');
  workerPanel.appendChild(handle);
  workerPanel.appendChild(container);

  // Drag-to-resize logic
  initSplitResize(handle, workerPanel);

  previewTabs.set(tabId, { workerId: String(workerId), port, url: null, mode: 'split' });

  // Recalculate terminal cols/rows (layout changed — terminal is now half width)
  setTimeout(sendResize, 100);
}

function closeSplitPreview(workerId, tabId) {
  const container = document.querySelector('.split-preview[data-preview-id="' + tabId + '"]');
  // Also remove the resize handle preceding the container
  if (container && container.previousElementSibling && container.previousElementSibling.classList.contains('split-resize-handle')) {
    container.previousElementSibling.remove();
  }
  if (container) container.remove();

  const workerPanel = document.querySelector('.tab-panel[data-id="' + workerId + '"]');
  if (workerPanel) {
    workerPanel.classList.remove('has-preview');
    // Reset terminal width
    const card = workerPanel.querySelector('.card');
    if (card) card.style.width = '';
  }

  previewTabs.delete(tabId);

  // Terminal is restored to full width — recalculate dimensions
  setTimeout(sendResize, 100);
}

// Check whether a port already has an open preview (regardless of workerId)
function isPortPreviewed(port) {
  for (const [, info] of previewTabs) {
    if (info.port === port) return true;
  }
  return false;
}

// ── Entry-point router ──
// Wide screen (≥768 px) + Tab mode → side-by-side split. Otherwise → separate tab.
function ensurePreview(workerId, port) {
  if (isPortPreviewed(port)) return;
  if (isWideScreen() && typeof layout !== 'undefined' && layout === 'tab') {
    ensureSplitPreview(workerId, port);
  } else {
    ensurePreviewTab(workerId, port);
  }
}

function ensurePreviewTab(workerId, port) {
  const tabId = 'preview-' + workerId + '-' + port;
  if (previewTabs.has(tabId)) return;

  // ── Create tab ──
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = tabId;
  tab.dataset.preview = 'true';
  tab.innerHTML =
    '<span class="tab-dot preview-dot"></span>' +
    '<span class="tab-label">:' + port + '</span>' +
    '<span class="tab-close preview-close">✕</span>';
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('preview-close')) return;
    selectTab(tabId);
  });

  // ── Create panel ──
  const panel = document.createElement('div');
  panel.className = 'tab-panel preview-panel';
  panel.dataset.id = tabId;

  const iframeSrc = 'http://localhost:' + port;

  panel.innerHTML =
    '<div class="preview-toolbar">' +
      '<span class="preview-url" id="preview-url-' + tabId + '">' + iframeSrc + '</span>' +
      '<button class="preview-btn" onclick="refreshPreview(\'' + tabId + '\')">↺ Refresh</button>' +
      '<a class="preview-btn" id="preview-open-' + tabId + '" href="' + iframeSrc + '" target="_blank">↗ New tab</a>' +
    '</div>' +
    '<iframe' +
      ' id="preview-iframe-' + tabId + '"' +
      ' class="preview-iframe"' +
      ' src="' + iframeSrc + '"' +
      ' sandbox="allow-same-origin allow-scripts allow-popups allow-forms"' +
      ' loading="lazy"' +
    '></iframe>' +
    '<div class="preview-error" id="preview-error-' + tabId + '" style="display:none">' +
      '<p>Failed to load in iframe.</p>' +
      '<a href="' + iframeSrc + '" target="_blank">Open in new tab →</a>' +
    '</div>';

  // Close button event
  tab.querySelector('.preview-close').addEventListener('click', () => closePreviewTab(tabId));

  document.getElementById('tab-bar').appendChild(tab);
  document.getElementById('tab-content').appendChild(panel);

  previewTabs.set(tabId, { workerId: String(workerId), port, url: null });

  // Auto-activate the new tab
  selectTab(tabId);
}

function refreshPreview(tabId) {
  const iframe = document.getElementById('preview-iframe-' + tabId);
  if (!iframe) return;
  // contentWindow.location.reload() is more stable than reassigning src
  try {
    iframe.contentWindow.location.reload();
  } catch (e) {
    // Cross-origin restriction: force reload via timestamp query parameter
    iframe.src = iframe.src.split('?')[0] + '?_t=' + Date.now();
  }
}

function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Return a normalized, schema-validated URL string (https only), or null if invalid.
function toSafeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function updatePreviewTunnel(port, url) {
  for (const [tabId, info] of previewTabs) {
    if (info.port !== port) continue;

    info.url = url;

    // Only use tunnel URLs with a trusted HTTPS scheme
    const safeUrl = toSafeUrl(url);
    if (!safeUrl) continue;

    // Both tab and split modes use the same element id pattern
    const iframe   = document.getElementById('preview-iframe-' + tabId);
    const openLink = document.getElementById('preview-open-'   + tabId);
    const urlLabel = document.getElementById('preview-url-'    + tabId);

    // Use the tunnel URL when accessed remotely or when a tunnel URL is provided
    if (isRemoteAccess()) {
      if (iframe)   iframe.src = safeUrl;
      if (openLink) openLink.href = safeUrl;
      if (urlLabel) urlLabel.textContent = safeUrl;
    } else {
      // Local access: update external link only
      if (openLink) openLink.href = safeUrl;
      if (urlLabel) urlLabel.textContent = 'localhost:' + port + ' (' + safeUrl + ')';
    }
  }
}

function closePreviewTab(tabId) {
  const tab   = document.querySelector('.tab[data-id="'       + tabId + '"]');
  const panel = document.querySelector('.tab-panel[data-id="' + tabId + '"]');
  const wasActive = tab && tab.classList.contains('active');

  if (tab)   tab.remove();
  if (panel) panel.remove();
  previewTabs.delete(tabId);

  if (wasActive) {
    const first = document.querySelector('.tab');
    if (first) selectTab(first.dataset.id);
    else if (typeof activeTab !== 'undefined') activeTab = null;
  }
}

function removePreviewTabs(workerId) {
  const toRemove = [];
  for (const [tabId, info] of previewTabs) {
    if (String(info.workerId) === String(workerId)) toRemove.push(tabId);
  }

  for (const tabId of toRemove) {
    const info = previewTabs.get(tabId);

    if (info && info.mode === 'split') {
      // Split mode: remove elements within the worker panel
      closeSplitPreview(workerId, tabId);
    } else {
      // Tab mode: remove the dedicated tab and panel
      const tab   = document.querySelector('.tab[data-id="'       + tabId + '"]');
      const panel = document.querySelector('.tab-panel[data-id="' + tabId + '"]');
      const wasActive = tab && tab.classList.contains('active');

      if (tab)   tab.remove();
      if (panel) panel.remove();

      previewTabs.delete(tabId);

      // If the removed tab was active, switch to the next available tab
      if (wasActive) {
        const first = document.querySelector('.tab');
        if (first) selectTab(first.dataset.id);
        else if (typeof activeTab !== 'undefined') activeTab = null;
      }
    }
  }
}

// ── Split Resize (drag to adjust left/right ratio) ──

function initSplitResize(handle, panel) {
  let startX, startWidth;
  const card = panel.querySelector('.card');

  handle.addEventListener('mousedown', onMouseDown);
  handle.addEventListener('touchstart', onTouchStart, { passive: false });

  function onMouseDown(e) {
    e.preventDefault();
    startDrag(e.clientX);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) { doDrag(e.clientX); }

  function onMouseUp() {
    stopDrag();
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  function onTouchStart(e) {
    e.preventDefault();
    startDrag(e.touches[0].clientX);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
  }

  function onTouchMove(e) {
    e.preventDefault();
    doDrag(e.touches[0].clientX);
  }

  function onTouchEnd() {
    stopDrag();
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
  }

  function startDrag(x) {
    startX = x;
    startWidth = card.getBoundingClientRect().width;
    handle.classList.add('dragging');
    // Prevent iframes from intercepting drag events
    panel.querySelectorAll('iframe').forEach(f => f.style.pointerEvents = 'none');
  }

  function doDrag(x) {
    const delta = x - startX;
    const panelWidth = panel.getBoundingClientRect().width;
    const newWidth = Math.max(100, Math.min(panelWidth - 100, startWidth + delta));
    card.style.width = newWidth + 'px';
  }

  function stopDrag() {
    handle.classList.remove('dragging');
    panel.querySelectorAll('iframe').forEach(f => f.style.pointerEvents = '');
    setTimeout(sendResize, 50);
  }
}

// ── Preview Prompt Toast (shown for non-HTML ports) ──

function showPreviewPrompt(workerId, port, contentType) {
  // Ignore if this port already has a preview open
  if (isPortPreviewed(port)) return;
  var tabId = 'preview-' + workerId + '-' + port;

  // Ignore if a prompt for the same port is already showing
  if (document.getElementById('preview-prompt-' + tabId)) return;

  var toast = document.createElement('div');
  toast.className = 'preview-prompt';
  toast.id = 'preview-prompt-' + tabId;

  toast.innerHTML =
    '<span class="preview-prompt-text">' +
      'Port <b>:' + port + '</b> detected (' + (contentType || 'unknown') + ')' +
    '</span>' +
    '<button class="preview-prompt-btn preview-prompt-open">Preview</button>' +
    '<button class="preview-prompt-btn preview-prompt-dismiss">Dismiss</button>';

  toast.querySelector('.preview-prompt-open').addEventListener('click', function() {
    toast.remove();
    ensurePreview(workerId, port);
  });

  toast.querySelector('.preview-prompt-dismiss').addEventListener('click', function() {
    toast.remove();
  });

  // Auto-dismiss after 30 seconds
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, 30000);

  document.body.appendChild(toast);
}
