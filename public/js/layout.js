// ── Layout & Tab Management ──

let layout = localStorage.getItem('layout') || 'tab';
let activeTab = null;

function getEffectiveLayout() {
  if (window.innerWidth <= 768) {
    return 'tab';
  }
  return layout;
}

function syncCardPlacement() {
  const tabContent = document.getElementById('tab-content');
  const splitContent = document.getElementById('split-content');
  const panels = Array.from(document.querySelectorAll('.tab-panel'));
  const effLayout = getEffectiveLayout();
  
  if (effLayout === 'tab') {
    panels.forEach(p => {
      if (p.parentElement !== tabContent) {
        tabContent.appendChild(p);
      }
    });
  } else if (effLayout === 'split') {
    const tabOrder = Array.from(document.querySelectorAll('.tab')).map(t => t.dataset.id);
    tabOrder.forEach(id => {
      const p = panels.find(panel => panel.dataset.id === id);
      if (p && p.parentElement !== splitContent) {
        splitContent.appendChild(p);
      }
    });
  }
}

function setLayout(mode) {
  layout = mode;
  localStorage.setItem('layout', mode);
  
  syncCardPlacement();

  const effLayout = getEffectiveLayout();
  document.getElementById('tab-mode').style.display = effLayout === 'tab' ? 'flex' : 'none';
  document.getElementById('split-mode').style.display = effLayout === 'split' ? 'block' : 'none';
  document.getElementById('split-content').style.display = effLayout === 'split' ? 'grid' : 'none';
  document.getElementById('layout-tab-btn').classList.toggle('layout-active', mode === 'tab');
  document.getElementById('layout-split-btn').classList.toggle('layout-active', mode === 'split');
  updateSplitGrid();
  setTimeout(sendResize, 50);
}

window.addEventListener('resize', () => {
  syncCardPlacement();
  const effLayout = getEffectiveLayout();
  const tabModeEl = document.getElementById('tab-mode');
  const splitModeEl = document.getElementById('split-mode');
  const splitContentEl = document.getElementById('split-content');
  if (tabModeEl) tabModeEl.style.display = effLayout === 'tab' ? 'flex' : 'none';
  if (splitModeEl) splitModeEl.style.display = effLayout === 'split' ? 'block' : 'none';
  if (splitContentEl) splitContentEl.style.display = effLayout === 'split' ? 'grid' : 'none';
  if (typeof scheduleSendResize === 'function') {
    scheduleSendResize();
  }
});

function updateSplitGrid() {
  const sc = document.getElementById('split-content');
  const panels = sc.querySelectorAll('.tab-panel');
  const n = panels.length;
  if (n === 0) return;

  let cols, rows;
  if (n <= 3) {
    cols = n; rows = 1;
  } else {
    cols = Math.ceil(n / 2); rows = 2;
  }

  sc.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  sc.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
}


function selectTab(id) {
  activeTab = id;
  localStorage.setItem('tmuxhub.activeTab.v1', id);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.id === id));
  setTimeout(sendResize, 0);
}

function switchTab(delta) {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  if (!tabs.length) return;
  if (!activeTab) {
    selectTab(tabs[0].dataset.id);
    return;
  }
  const idx = tabs.findIndex(t => t.dataset.id === activeTab);
  const next = idx === -1 ? 0 : (idx + delta + tabs.length) % tabs.length;
  selectTab(tabs[next].dataset.id);
}

function bindTabDrag(tab) {
  tab.draggable = true;
  tab.addEventListener('dragstart', e => {
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.dataset.id);
  });
  tab.addEventListener('dragend', () => {
    tab.classList.remove('dragging');
  });
}

function getDragAfterElement(container, x) {
  const els = [...container.querySelectorAll('.tab:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  els.forEach(el => {
    const box = el.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: el };
    }
  });
  return closest.element;
}

const tabBar = document.getElementById('tab-bar');
if (tabBar) {
  const indicator = document.createElement('div');
  indicator.id = 'tab-drop-indicator';
  tabBar.appendChild(indicator);

  tabBar.addEventListener('dragover', e => {
    e.preventDefault();
    const dragging = document.querySelector('.tab.dragging');
    if (!dragging) return;
    const after = getDragAfterElement(tabBar, e.clientX);
    if (!after) tabBar.appendChild(dragging);
    else tabBar.insertBefore(dragging, after);

    const target = after || tabBar.lastElementChild;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const barRect = tabBar.getBoundingClientRect();
    const x = after ? rect.left - barRect.left : rect.right - barRect.left;
    indicator.style.transform = `translateX(${x}px)`;
    indicator.classList.add('show');
  });

  tabBar.addEventListener('dragleave', e => {
    if (e.relatedTarget && tabBar.contains(e.relatedTarget)) return;
    indicator.classList.remove('show');
  });

  tabBar.addEventListener('drop', () => {
    indicator.classList.remove('show');
    saveTabOrder();
    syncCardPlacement();
  });
}

function saveTabOrder() {
  const order = Array.from(document.querySelectorAll('.tab')).map(t => t.dataset.sessionName || t.dataset.id);
  localStorage.setItem('tmuxhub.tabOrder.v1', JSON.stringify(order));
}

function restoreTabOrder() {
  const raw = localStorage.getItem('tmuxhub.tabOrder.v1');
  if (!raw) return;
  try {
    const order = JSON.parse(raw);
    if (!Array.isArray(order)) return;
    const tabBarEl = document.getElementById('tab-bar');
    if (!tabBarEl) return;
    const tabs = Array.from(document.querySelectorAll('.tab'));
    order.forEach(name => {
      const tab = tabs.find(t => (t.dataset.sessionName || t.dataset.id) === name);
      if (tab) {
        // Since indicator is a child, make sure we append before or handle it cleanly.
        // Actually, just appendChild moves the tab to the end of the tab-bar.
        tabBarEl.appendChild(tab);
      }
    });
    // Ensure indicator stays at the end of tab-bar if it exists
    const indicator = document.getElementById('tab-drop-indicator');
    if (indicator) tabBarEl.appendChild(indicator);
    
    syncCardPlacement();
  } catch (e) {}
}
