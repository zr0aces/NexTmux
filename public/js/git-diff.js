// ── Git Diff Panel Module ──
// Renders git diff output via diff2html in a side-by-side split panel inside a worker tab.

// workerId → { open: boolean, selectedFile: string|null }
const diffPanels = new Map();

function openGitDiff(workerId) {
  workerId = String(workerId);

  const workerPanel = document.querySelector('.tab-panel[data-id="' + workerId + '"]');
  if (!workerPanel) return;

  // If a diff panel is already open for this worker, toggle it closed
  if (workerPanel.querySelector('.split-diff')) {
    closeGitDiff(workerId);
    return;
  }

  // If a preview split is open, close it first (only one side panel at a time)
  const existingPreview = workerPanel.querySelector('.split-preview');
  if (existingPreview) {
    const previewId = existingPreview.dataset.previewId;
    if (previewId) closeSplitPreview(workerId, previewId);
  }

  // Resize handle
  const handle = document.createElement('div');
  handle.className = 'split-resize-handle';

  // Diff panel container
  const container = document.createElement('div');
  container.className = 'split-diff';
  container.dataset.workerId = workerId;

  container.innerHTML =
    '<div class="diff-toolbar">' +
      '<button class="diff-refresh-btn" title="Refresh">↺</button>' +
      '<span class="diff-stat"></span>' +
      '<button class="diff-close-btn" title="Close">✕</button>' +
    '</div>' +
    '<div class="diff-body">' +
      '<div class="diff-file-sidebar">' +
        '<div class="diff-file-list"></div>' +
      '</div>' +
      '<div class="diff-sidebar-toggle">◀</div>' +
      '<div class="diff-content">' +
        '<div class="diff-placeholder">Select a file to view diff</div>' +
      '</div>' +
    '</div>';

  // Button event bindings
  container.querySelector('.diff-close-btn').addEventListener('click', function() {
    closeGitDiff(workerId);
  });

  container.querySelector('.diff-refresh-btn').addEventListener('click', function() {
    refreshGitDiff(workerId);
  });

  // Sidebar toggle
  var sidebar = container.querySelector('.diff-file-sidebar');
  var toggleBtn = container.querySelector('.diff-sidebar-toggle');
  toggleBtn.addEventListener('click', function() {
    var isCollapsed = sidebar.classList.toggle('collapsed');
    toggleBtn.textContent = isCollapsed ? '▶' : '◀';
  });

  workerPanel.classList.add('has-preview');
  workerPanel.appendChild(handle);
  workerPanel.appendChild(container);

  // Drag-to-resize
  if (typeof initSplitResize === 'function') {
    initSplitResize(handle, workerPanel);
  }

  diffPanels.set(workerId, { open: true, selectedFile: null });

  // Auto-load file list
  loadFileList(workerId);

  setTimeout(sendResize, 100);
}

function loadFileList(workerId) {
  workerId = String(workerId);
  var container = document.querySelector('.split-diff[data-worker-id="' + workerId + '"]');
  if (!container) return;

  var fileList = container.querySelector('.diff-file-list');
  var statEl = container.querySelector('.diff-stat');

  fileList.innerHTML = '<div style="padding:8px;font-size:11px;color:#484f58">Loading…</div>';

  fetch('/api/git-diff?id=' + encodeURIComponent(workerId), { credentials: 'include' })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (data.error) {
        fileList.innerHTML = '<div style="padding:8px;font-size:11px;color:#f85149">' + data.error + '</div>';
        return;
      }

      statEl.textContent = data.stat || '';

      if (!data.files || data.files.length === 0) {
        fileList.innerHTML = '<div style="padding:8px;font-size:11px;color:#484f58">No changes</div>';
        return;
      }

      fileList.innerHTML = '';
      data.files.forEach(function(f) {
        var item = document.createElement('div');
        item.className = 'diff-file-item';
        item.dataset.path = f.path;

        var trimmed = f.path.replace(/\/+$/, '');
        var filename = trimmed.split('/').pop() || f.path;
        item.title = f.path;
        item.innerHTML =
          '<span class="diff-file-status ' + f.status + '">' + f.status + '</span> ' +
          filename;

        item.addEventListener('click', function() {
          loadFileDiff(workerId, f.path);
        });

        fileList.appendChild(item);
      });
    })
    .catch(function(err) {
      fileList.innerHTML = '<div style="padding:8px;font-size:11px;color:#f85149">Load failed: ' + err.message + '</div>';
    });
}

function loadFileDiff(workerId, filePath) {
  workerId = String(workerId);
  var container = document.querySelector('.split-diff[data-worker-id="' + workerId + '"]');
  if (!container) return;

  var diffContent = container.querySelector('.diff-content');

  // Highlight selected file
  container.querySelectorAll('.diff-file-item').forEach(function(item) {
    item.classList.toggle('active', item.dataset.path === filePath);
  });

  var state = diffPanels.get(workerId);
  if (state) state.selectedFile = filePath;

  diffContent.innerHTML = '<div class="diff-placeholder">Loading…</div>';

  fetch('/api/git-diff?id=' + encodeURIComponent(workerId) + '&file=' + encodeURIComponent(filePath), { credentials: 'include' })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      diffContent.innerHTML = '';

      if (!data.diff) {
        diffContent.innerHTML = '<div class="diff-placeholder">No changes</div>';
        return;
      }

      if (typeof Diff2HtmlUI === 'undefined') {
        diffContent.innerHTML = '<div class="diff-placeholder" style="color:#f85149">diff2html library failed to load</div>';
        return;
      }
      var ui = new Diff2HtmlUI(diffContent, data.diff, {
        outputFormat: 'line-by-line',
        matching: 'lines',
        highlight: true,
        drawFileList: false,
        synchronisedScroll: true,
      });
      ui.draw();
      ui.highlightCode();
    })
    .catch(function(err) {
      diffContent.innerHTML = '<div class="diff-placeholder" style="color:#f85149">Load failed: ' + err.message + '</div>';
    });
}

function closeGitDiff(workerId) {
  workerId = String(workerId);
  var container = document.querySelector('.split-diff[data-worker-id="' + workerId + '"]');

  if (container) {
    // Also remove the resize handle that precedes the container
    var prev = container.previousElementSibling;
    if (prev && prev.classList.contains('split-resize-handle')) {
      prev.remove();
    }
    container.remove();
  }

  var workerPanel = document.querySelector('.tab-panel[data-id="' + workerId + '"]');
  if (workerPanel) {
    // Only remove the has-preview class if no split-preview is still open
    if (!workerPanel.querySelector('.split-preview')) {
      workerPanel.classList.remove('has-preview');
    }
    var card = workerPanel.querySelector('.card');
    if (card) card.style.width = '';
  }

  diffPanels.delete(workerId);
  setTimeout(sendResize, 100);
}

function refreshGitDiff(workerId) {
  workerId = String(workerId);
  var state = diffPanels.get(workerId);
  if (!state) return;

  var selectedFile = state.selectedFile;
  loadFileList(workerId);
  if (selectedFile) {
    // Reload the selected file diff after the file list refreshes
    setTimeout(function() { loadFileDiff(workerId, selectedFile); }, 300);
  }
}
