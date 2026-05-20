function normalizeLayout(tab) {
  const layout = tab?.layout || 'single';
  if (!['single', 'hsplit', 'vsplit', 'quad'].includes(layout)) return 'single';
  return layout;
}

function applyPaneLayout() {
  const root = document.getElementById('tab-content');
  const tab = getActiveTab();
  if (!root || !tab) return;
  const count = root.querySelectorAll('.pane-card').length;
  const layout = normalizeLayout(tab);
  root.classList.remove('layout-single', 'layout-hsplit', 'layout-vsplit', 'layout-quad');
  root.classList.add('layout-' + layout);
  root.dataset.count = String(count);
}

function setLayout(mode) {
  const mapped = mode === 'split' ? 'vsplit' : 'single';
  setActiveTabLayout(mapped);
}

function updateSplitGrid() {
  applyPaneLayout();
}
