// ── Favorites & Path Management ──

function readJsonArray(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let favorites = readJsonArray('fav');
let recents = readJsonArray('recent');

function displayPath(p) {
  const base = window._basePath || '';
  return (base && p.startsWith(base)) ? '📂 ' + p.slice(base.length) : p;
}

function saveFavs() {
  localStorage.setItem('fav', JSON.stringify(favorites));
}

function saveRecents() {
  localStorage.setItem('recent', JSON.stringify(recents));
}

function addRecent(p) {
  recents = [p, ...recents.filter(r => r !== p)].slice(0, 10);
  saveRecents();
  renderDropdown();
}

function addFavorite() {
  const p = document.getElementById('cwd-input').value.trim();
  if (!p || favorites.includes(p)) return;
  favorites.push(p);
  saveFavs();
  renderDropdown();
  closeDropdown();
}

function removeFavorite(p) {
  favorites = favorites.filter(f => f !== p);
  saveFavs();
  renderDropdown();
}

function selectPath(p) {
  document.getElementById('cwd-input').value = p;
  closeDropdown();
}

function toggleDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('dir-dropdown');
  dd.classList.toggle('open');
  if (dd.classList.contains('open')) renderDropdown();
}

function closeDropdown() {
  document.getElementById('dir-dropdown').classList.remove('open');
}

function renderDropdown() {
  const fl = document.getElementById('fav-list');
  const rl = document.getElementById('recent-list');
  if (!fl) return;
  fl.textContent = '';
  rl.textContent = '';

  if (!favorites.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:8px 10px;font-size:12px;color:#8b949e';
    empty.textContent = 'None';
    fl.appendChild(empty);
  } else {
    favorites.forEach(p => {
      const item = document.createElement('div');
      item.className = 'dir-item';

      const icon = document.createElement('span');
      icon.textContent = '⭐';

      const path = document.createElement('span');
      path.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      path.textContent = displayPath(p);
      path.addEventListener('click', () => selectPath(p));

      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '✕';
      del.addEventListener('click', e => {
        e.stopPropagation();
        removeFavorite(p);
      });

      item.appendChild(icon);
      item.appendChild(path);
      item.appendChild(del);
      fl.appendChild(item);
    });
  }

  if (!recents.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:8px 10px;font-size:12px;color:#8b949e';
    empty.textContent = 'None';
    rl.appendChild(empty);
  } else {
    recents.forEach(p => {
      const item = document.createElement('div');
      item.className = 'dir-item';
      item.addEventListener('click', () => selectPath(p));

      const icon = document.createElement('span');
      icon.textContent = '🕐';
      const path = document.createElement('span');
      path.textContent = displayPath(p);

      item.appendChild(icon);
      item.appendChild(path);
      rl.appendChild(item);
    });
  }
}
