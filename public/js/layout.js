function normalizeLayout(mode) {
  return ['single', 'hsplit', 'vsplit', 'quad'].includes(mode) ? mode : 'single';
}

function applyPaneLayout() {
  const root = document.getElementById('tab-content');
  if (!root) return;
  const count = root.querySelectorAll('.pane-card').length;
  const mode = (typeof layoutMode !== 'undefined') ? layoutMode : 'single';
  root.classList.remove('layout-single', 'layout-hsplit', 'layout-vsplit', 'layout-quad');
  root.classList.add('layout-' + normalizeLayout(mode));
  root.dataset.count = String(count);
}

// setLayout is called by keyboard shortcuts and was previously backend-coupled.
// Now it simply delegates to the client-side layout mode.
function setLayout(mode) {
  if (typeof setLayoutMode === 'function') setLayoutMode(normalizeLayout(mode));
}

function updateSplitGrid() {
  applyPaneLayout();
}
