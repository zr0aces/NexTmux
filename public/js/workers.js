// ── Worker Card UI ──

let customTitles = {};
try {
  customTitles = JSON.parse(localStorage.getItem('tabTitles') || '{}');
} catch (e) {
  customTitles = {};
}

function saveCustomTitles() {
  localStorage.setItem('tabTitles', JSON.stringify(customTitles));
}

function getTitleBase(id, cmd) {
  return customTitles[id] || cmd || 'claude';
}

function trimTitle(text) {
  const max = 24;
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTitle(id, cwd, cmd) {
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  const tabCwd = cwd || (tab && tab.dataset.cwd) || '';
  const tabCmd = cmd || (tab && tab.dataset.cmd) || 'claude';
  const folder = tabCwd.replace(/\/$/, '').split('/').pop() || tabCwd;
  let text = '';
  if (customTitles[id]) {
    text = '#' + id + ' ' + customTitles[id];
  } else {
    text = '#' + id + ' ' + tabCmd + ' · ' + folder;
  }
  const elLabel = document.getElementById('tab-label-' + id);
  if (elLabel) elLabel.textContent = text;
  const elTitle = document.getElementById('card-title-' + id);
  if (elTitle) elTitle.textContent = text;
}

function killBtnHtml(id, status) {
  if (status === 'stopped' || status === 'completed') {
    return '<button class="kill-btn" id="kill-' + id + '" style="border-color:#f85149;color:#f85149">Remove</button>';
  }
  return '<button class="kill-btn" id="kill-' + id + '">Stop</button>';
}

function ensureCard(id, cwd, status, logs, cmd, reason, monitorMeta) {
  if (document.getElementById('card-' + id)) return;

  const cmdLabel = cmd || 'claude';
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'card-' + id;
  card.innerHTML =
    '<div class="card-header">' +
      '<div class="card-title-wrap">' +
        '<span class="card-title" id="card-title-' + id + '">#' + id + ' ' + escapeHtml(cmdLabel) + '</span>' +
        '<span class="card-cwd" id="card-cwd-' + id + '" title="' + escapeHtml(cwd) + '">' + escapeHtml(displayPath(cwd)) + '</span>' +
      '</div>' +
        '<div class="card-actions">' +
          '<span class="badge' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '') + '" id="badge-' + id + '">' + status + '</span>' +
          '<div class="ai-monitor-wrap">' +
          '<select class="monitor-mode-selector" id="monitor-mode-' + id + '" title="AI Monitor: Off" aria-label="AI Monitor Mode">' +
            '<option value="off">○</option>' +
            '<option value="monitor">👁</option>' +
            '<option value="auto">⚡</option>' +
          '</select>' +
          '<div class="ai-telemetry-tooltip" id="tooltip-' + id + '">' +
            '<div class="tooltip-title">🧠 AI Supervision</div>' +
            '<div class="tooltip-line" id="meta-activity-' + id + '">Activity: -</div>' +
            '<div class="tooltip-line" id="meta-pattern-' + id + '">Prompt: -</div>' +
            '<div class="tooltip-line" id="meta-notify-' + id + '">Notify: -</div>' +
            '<div class="tooltip-line" id="meta-mode-' + id + '">Mode: Off</div>' +
            '<div class="tooltip-line" id="meta-reset-' + id + '" style="display:none">Reset: -</div>' +
          '</div>' +
        '</div>' +
        '<button class="diff-btn" id="diff-' + id + '" title="Git Diff">Diff</button>' +
        killBtnHtml(id, status) +
      '</div>' +
    '</div>' +
    '<div class="exit-reason" id="exit-reason-' + id + '"></div>' +
    '<div class="logs" id="logs-' + id + '"></div>' +
    '<div class="input-row" id="input-row-' + id + '"' + (status === 'stopped' || status === 'completed' ? ' style="display:none"' : '') + '>' +
      '<textarea id="inp-' + id + '" placeholder="Enter command..." rows="1"></textarea>' +
      '<button id="send-' + id + '">Send</button>' +
      '<div class="toolkit-wrap">' +
        '<button class="toolkit-toggle" id="tk-btn-' + id + '">⌨</button>' +
        '<div class="toolkit-popup" id="tk-popup-' + id + '">' +
          '<div class="tk-label">Keys</div>' +
          '<div class="key-grid">' +
            '<button class="key-btn" id="key-esc-' + id + '">esc</button>' +
            '<button class="key-btn" id="key-up-' + id + '">↑</button>' +
            '<button class="key-btn" id="key-down-' + id + '">↓</button>' +
            '<button class="key-btn key-enter" id="key-enter-' + id + '">↵</button>' +
            '<button class="key-btn" id="key-tab-' + id + '">tab</button>' +
            '<button class="key-btn" id="key-stab-' + id + '">⇧tab</button>' +
            '<button class="key-btn" id="key-ctrlc-' + id + '">⌃c</button>' +
            '<button class="key-btn quick-cmd-btn" id="quick-proceed-' + id + '">proceed</button>' +
            '<button class="key-btn quick-cmd-btn" id="quick-continue-' + id + '">continue</button>' +
            '<button class="key-btn quick-cmd-btn" id="quick-yes-' + id + '">yes</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.dataset.id = id;
  panel.appendChild(card);

  panel.addEventListener('mousedown', () => {
    if (layout === 'split' && activeTab !== id) {
      selectTab(id);
    }
  });

  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = id;
  tab.dataset.cwd = cwd;
  tab.dataset.cmd = cmdLabel;
  var folder = cwd.replace(/\/$/, '').split('/').pop() || cwd;
  tab.innerHTML = '<span class="tab-dot' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '') + '" id="tab-dot-' + id + '"></span><span class="tab-label" id="tab-label-' + id + '">#' + id + ' ' + escapeHtml(cmd || 'claude') + ' · ' + escapeHtml(folder) + '</span>';
  tab.addEventListener('click', () => selectTab(id));
  tab.addEventListener('dblclick', e => {
    e.stopPropagation();
    const current = customTitles[id] || cmdLabel;
    const next = prompt('Tab title', current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      delete customTitles[id];
    } else {
      customTitles[id] = trimTitle(trimmed);
    }
    saveCustomTitles();
    renderTitle(id);
  });
  bindTabDrag(tab);
  document.getElementById('tab-bar').appendChild(tab);

  bindCard(id, panel);

  if (layout === 'tab') {
    document.getElementById('tab-content').appendChild(panel);
  } else {
    document.getElementById('split-content').appendChild(panel);
  }
  updateSplitGrid();

  selectTab(id);

  if (status === 'stopped') {
    const btn = document.getElementById('kill-' + id);
    if (btn) btn.onclick = () => removeWorker(id);
    const el = document.getElementById('input-row-' + id);
    if (el) el.style.display = 'none';
  }

  renderTitle(id, cwd, cmdLabel);
  const logsBox = document.getElementById('logs-' + id);
  if (logsBox) {
    initLogScrollLock(logsBox);
  }
  if (logs) logs.forEach(l => appendLog(id, l.src, l.text));
  if (reason) updateExitReason(id, reason);
  if (status === 'running') updateExitReason(id, null);
  if (monitorMeta) updateMonitorMeta(id, monitorMeta);
  setTimeout(sendResize, 100);
}

function bindCard(id, root) {
  const q = sel => root.querySelector ? root.querySelector(sel) : document.getElementById(sel.slice(1));

  const killBtn = q('#kill-' + id);
  const sendBtn = q('#send-' + id);
  const inp = q('#inp-' + id);
  const monitorModeSelector = q('#monitor-mode-' + id);

  const diffBtn = q('#diff-' + id);
  if (diffBtn) diffBtn.addEventListener('click', () => openGitDiff(id));

  if (killBtn) killBtn.addEventListener('click', () => killWorker(id));
  if (sendBtn) sendBtn.addEventListener('click', () => sendInput(id));
  if (monitorModeSelector) monitorModeSelector.addEventListener('change', (e) => setMonitorMode(id, e.target.value));
  if (inp) {
    let pendingEnter = false;
    inp.addEventListener('compositionend', () => {
      if (pendingEnter) {
        pendingEnter = false;
        if (inp.value.trim()) { sendInput(id); } else { sendSpecialKey(id, 'Enter'); }
      }
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) {
          pendingEnter = true;
          return;
        }
        e.preventDefault();
        if (inp.value.trim()) { sendInput(id); } else { sendSpecialKey(id, 'Enter'); }
      }
    });
    inp.addEventListener('input', () => {
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
    });
  }

  const tkBtn = q('#tk-btn-' + id);
  const tkPopup = q('#tk-popup-' + id);
  if (tkBtn && tkPopup) {
    tkBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = tkPopup.classList.toggle('open');
      tkBtn.classList.toggle('open', isOpen);
      document.querySelectorAll('.toolkit-popup.open').forEach(p => {
        if (p !== tkPopup) {
          p.classList.remove('open');
          p.previousElementSibling.classList.remove('open');
        }
      });
    });
  }

  const keyMap = {
    up: 'Up', down: 'Down', enter: 'Enter', esc: 'Escape',
    tab: 'Tab', stab: 'BTab', ctrlc: 'C-c'
  };
  Object.entries(keyMap).forEach(([btnId, tmuxKey]) => {
    const btn = q('#key-' + btnId + '-' + id);
    if (btn) btn.addEventListener('click', () => sendSpecialKey(id, tmuxKey));
  });

  const quickMap = {
    proceed: 'proceed',
    continue: 'continue',
    yes: 'yes'
  };
  Object.entries(quickMap).forEach(([btnId, value]) => {
    const btn = q('#quick-' + btnId + '-' + id);
    if (btn) btn.addEventListener('click', () => sendQuickCommand(id, value));
  });
}

// ── Logs ──

function isNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 50;
}

function initLogScrollLock(box) {
  if (!box || box.dataset.scrollLockBound === '1') return;
  box.dataset.scrollLockBound = '1';
  box.dataset.scrollLock = '0';
  box.addEventListener('scroll', () => {
    box.dataset.scrollLock = isNearBottom(box) ? '0' : '1';
  }, { passive: true });
  box.dataset.scrollLock = isNearBottom(box) ? '0' : '1';
}

function isAutoScrollEnabled(box) {
  if (!box) return false;
  return box.dataset.scrollLock !== '1';
}

function appendLog(id, src, text) {
  const box = document.getElementById('logs-' + id);
  if (box) {
    initLogScrollLock(box);
    var shouldAutoScroll = isAutoScrollEnabled(box);
    const line = document.createElement('div');
    line.className = 'log-line ' + src;
    line.innerHTML = (typeof ansiToHtml === 'function') ? ansiToHtml(text) : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    box.appendChild(line);
    if (shouldAutoScroll) box.scrollTop = box.scrollHeight;
  }
}

function updateExitReason(id, reason) {
  const el = document.getElementById('exit-reason-' + id);
  if (el) {
    if (reason) {
      el.textContent = 'Exit reason: ' + reason;
      el.style.display = 'block';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }
}

function updateStatus(id, status, reason) {
  var isStopped = status === 'stopped' || status === 'completed';
  const elBadge = document.getElementById('badge-' + id);
  if (elBadge) {
    elBadge.textContent = status;
    elBadge.className = 'badge' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '');
  }
  const elTabDot = document.getElementById('tab-dot-' + id);
  if (elTabDot) {
    elTabDot.className = 'tab-dot' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '');
  }
  if (isStopped) {
    updateExitReason(id, reason || 'Unknown');
    const btn = document.getElementById('kill-' + id);
    if (btn) {
      btn.textContent = 'Remove';
      btn.style.background = '#21262d';
      btn.style.borderColor = '#f85149';
      btn.style.color = '#f85149';
      btn.onclick = () => removeWorker(id);
      if (!btn.parentElement.querySelector('.reconnect-btn')) {
        var reconBtn = document.createElement('button');
        reconBtn.className = 'reconnect-btn';
        reconBtn.textContent = 'Reconnect';
        reconBtn.style.cssText = 'background:#21262d;border:1px solid #3fb950;border-radius:5px;color:#3fb950;font-size:11px;padding:2px 8px;cursor:pointer';
        reconBtn.onclick = function() { reconnectWorker(id); };
        btn.parentElement.insertBefore(reconBtn, btn);
      }
    }
    const elInputRow = document.getElementById('input-row-' + id);
    if (elInputRow) elInputRow.style.display = 'none';
  }
  if (status === 'running') {
    updateExitReason(id, null);
    const btn = document.getElementById('kill-' + id);
    if (btn) {
      btn.textContent = 'Stop';
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '#f85149';
      btn.onclick = () => killWorker(id);
      var reconBtn = btn.parentElement.querySelector('.reconnect-btn');
      if (reconBtn) reconBtn.remove();
    }
    const elInputRow = document.getElementById('input-row-' + id);
    if (elInputRow) elInputRow.style.display = '';
  }
}

function updateAIState(id, state) {
  var badge = document.getElementById('badge-' + id);
  if (badge && (badge.classList.contains('stopped') || badge.classList.contains('completed'))) return;

  const elTabDot = document.getElementById('tab-dot-' + id);
  if (elTabDot) {
    elTabDot.classList.remove('ai-idle', 'ai-waiting');
    if (state === 'idle') elTabDot.classList.add('ai-idle');
    else if (state === 'waiting') elTabDot.classList.add('ai-waiting');
  }

  if (badge) {
    badge.classList.remove('ai-idle', 'ai-waiting');
    if (state === 'idle') {
      badge.classList.add('ai-idle');
      badge.textContent = 'idle';
    } else if (state === 'waiting') {
      badge.classList.add('ai-waiting');
      badge.textContent = 'waiting';
    } else {
      badge.textContent = 'running';
    }
  }
}

function formatMetaTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString();
}

function trimPrompt(prompt) {
  if (!prompt) return '-';
  const oneLine = String(prompt).replace(/\s+/g, ' ').trim();
  if (!oneLine) return '-';
  return oneLine.length > 52 ? oneLine.slice(0, 51) + '…' : oneLine;
}

function updateMonitorMeta(id, meta) {
  const activity = formatMetaTime(meta.lastActivityAt);
  const prompt = trimPrompt(meta.lastMatchedLine || meta.lastPromptExcerpt || meta.matchedText);
  const status = meta.notificationStatus || '-';
  const notifyAt = formatMetaTime(meta.lastNotificationAt);

  const elActivity = document.getElementById('meta-activity-' + id);
  if (elActivity) elActivity.textContent = 'Activity: ' + activity;
  
  const elPattern = document.getElementById('meta-pattern-' + id);
  if (elPattern) {
    const pattern = meta.lastMatchedPattern ? '[' + meta.lastMatchedPattern + '] ' : '';
    elPattern.textContent = 'Prompt: ' + pattern + prompt;
    elPattern.title = meta.lastPromptExcerpt || '';
  }
  
  const elNotify = document.getElementById('meta-notify-' + id);
  if (elNotify) elNotify.textContent = 'Notify: ' + status + (notifyAt !== '-' ? ' @ ' + notifyAt : '');
  
  const elReset = document.getElementById('meta-reset-' + id);
  if (elReset) {
    if (meta.tokenResetAt) {
      const armed = meta.resetAtEpochMs != null;
      elReset.textContent = '⏱ Reset in: ' + meta.tokenResetAt + (armed ? '  [armed]' : '');
      elReset.style.display = '';
      elReset.style.color = armed ? '#58a6ff' : '#d29922';
    } else {
      elReset.style.display = 'none';
    }
  }
  
  const mode = meta.monitorMode || (meta.aiMonitorEnabled === false ? 'off' : (meta.autoMode === true ? 'auto' : 'monitor'));
  const elMonitorMode = document.getElementById('monitor-mode-' + id);
  if (elMonitorMode) {
    elMonitorMode.value = mode;
    elMonitorMode.className = 'monitor-mode-selector ' +
      (mode === 'auto' ? 'mode-auto' : (mode === 'monitor' ? 'mode-monitor' : 'mode-off'));
    elMonitorMode.title = mode === 'auto'
      ? 'AI Monitor: Auto Mode'
      : (mode === 'monitor' ? 'AI Monitor: Monitor Only' : 'AI Monitor: Off');
  }
  
  const elMetaMode = document.getElementById('meta-mode-' + id);
  if (elMetaMode) {
    const label = mode === 'auto'
      ? '⚡ Auto'
      : (mode === 'monitor' ? '👁 Monitor' : '○ Off');
    elMetaMode.textContent = 'Mode: ' + label;
  }
}

function removeWorker(id) {
  apiPost('/api/remove', { id });
  removePreviewTabs(id);
  if (typeof closeGitDiff === 'function') closeGitDiff(id);

  const panel = document.querySelector('.tab-panel[data-id="' + id + '"]');
  if (panel) panel.remove();
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (tab) {
    const wasActive = tab.classList.contains('active');
    tab.remove();
    if (wasActive) {
      const first = document.querySelector('.tab');
      if (first) selectTab(first.dataset.id);
      else activeTab = null;
    }
  }
  const card = document.getElementById('card-' + id);
  if (card) card.remove();
  updateSplitGrid();
}

function updateCwd(id, cwd) {
  const el = document.getElementById('card-cwd-' + id);
  if (el) {
    el.textContent = displayPath(cwd);
    el.title = cwd;
  }
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (tab) tab.dataset.cwd = cwd;
  renderTitle(id, cwd);
}

function reconnectWorker(id) {
  apiPost('/api/reconnect', { id })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) alert('Session is no longer alive.');
    });
}

function sendSpecialKey(id, key) {
  notifyActive();
  apiPost('/api/key', { id, key });
}

function sendInput(id) {
  const inp = document.getElementById('inp-' + id);
  if (!inp) return;
  let text = inp.value.trim();
  if (!text) return;
  text = text.split('\n').filter(l => l.trim() !== '').join('\n');
  if (!text) return;
  inp.value = '';
  inp.style.height = 'auto';
  notifyActive();
  apiPost('/api/input', { id, text });
}

function sendQuickCommand(id, text) {
  notifyActive();
  apiPost('/api/input', { id, text });
}

function killWorker(id) {
  if (!confirm('Stop Worker #' + id + '?')) return;
  apiPost('/api/kill', { id });
}

function setMonitorMode(id, mode) {
  apiPost('/api/set-monitor-mode', { id, mode })
    .then(r => r.json().catch(() => ({})).then(d => ({ ok: r.ok, d })))
    .then(({ ok }) => {
      if (!ok) console.error('Failed to set monitor mode');
    })
    .catch(e => console.error('Error setting monitor mode:', e));
}

function spawnSession() {
  var raw = document.getElementById('cwd-input').value.trim();
  var base = window._basePath || '/tmp';
  var cwd = raw ? (raw.startsWith('/') ? raw : base + '/' + raw) : base;
  const cmd = document.getElementById('cmd-input').value.trim();
  apiPost('/api/spawn', { cwd, cmd })
    .then(r => r.json().catch(() => ({})).then(d => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || d.ok === false) {
        alert(d.error || 'Invalid path. Worker not created.');
        return;
      }
      addRecent(cwd);
    })
    .catch(() => { alert('Failed to create worker.'); });
}

function scanSessions() {
  const btn = document.getElementById('scan-btn');
  btn.textContent = '⏳';
  apiGet('/api/scan')
    .then(found => {
      btn.textContent = '🔍';
      if (!found.length) { alert('No new tmux sessions found.'); return; }
      const names = found.map(f => '• ' + f.sessionName + ' (' + displayPath(f.cwd) + ')').join('\n');
      if (!confirm('Add these sessions to dashboard?\n\n' + names)) return;
      // Sequential attach: wait for each response before sending the next to
      // prevent race-condition duplicates when attaches land before spawned
      // WebSocket events reach the client.
      found.reduce(
        (chain, f) => chain.then(() => apiPost('/api/attach', { sessionName: f.sessionName, cwd: f.cwd })),
        Promise.resolve()
      );
    })
    .catch(() => { btn.textContent = '🔍'; });
}
