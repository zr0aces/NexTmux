function doLogin() {
  const pw = document.getElementById('pw').value;
  apiPost('/api/login', { pw })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        document.getElementById('login').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        loadConfig();
        initWS();
        loadAll();
      } else {
        document.getElementById('login-err').style.display = 'block';
      }
    })
    .catch(() => {
      document.getElementById('login-err').style.display = 'block';
    });
}

function toggleToolbar() {
  const toolbar = document.getElementById('spawn-toolbar');
  const isOpen = toolbar.style.display !== 'none';
  toolbar.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) document.getElementById('cwd-input').focus();
}

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('toggle-toolbar-btn').addEventListener('click', toggleToolbar);
document.getElementById('dir-btn').addEventListener('click', toggleDropdown);
document.getElementById('spawn-btn').addEventListener('click', () => {
  spawnSession();
  document.getElementById('spawn-toolbar').style.display = 'none';
});
document.getElementById('scan-btn').addEventListener('click', scanSessions);
document.getElementById('add-fav-btn').addEventListener('click', addFavorite);

document.getElementById('session-select').addEventListener('change', (e) => selectSession(e.target.value));
document.getElementById('session-add-btn').addEventListener('click', createSession);
document.getElementById('session-rename-btn').addEventListener('click', renameSession);
document.getElementById('session-close-btn').addEventListener('click', closeSession);
document.getElementById('tab-add-btn').addEventListener('click', createTab);
document.getElementById('tab-close-btn').addEventListener('click', () => closeTab());
document.getElementById('pane-split-h-btn').addEventListener('click', () => splitPane('hsplit'));
document.getElementById('pane-split-v-btn').addEventListener('click', () => splitPane('vsplit'));

document.addEventListener('click', e => {
  closeDropdown();
  if (!e.target.closest('.toolkit-wrap')) {
    document.querySelectorAll('.toolkit-popup.open').forEach(p => {
      p.classList.remove('open');
      if (p.previousElementSibling) p.previousElementSibling.classList.remove('open');
    });
  }
});

window.addEventListener('resize', sendResize);

document.addEventListener('keydown', e => {
  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  const ctrlShift = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;

  if (ctrlShift && e.key.toLowerCase() === 't') {
    e.preventDefault();
    createTab();
    return;
  }
  if (ctrlShift && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    closeTab();
    return;
  }
  if (ctrlShift && e.key === '[') {
    e.preventDefault();
    switchTab(-1);
    return;
  }
  if (ctrlShift && e.key === ']') {
    e.preventDefault();
    switchTab(1);
    return;
  }
  if (ctrlShift && e.key === '\\') {
    e.preventDefault();
    splitPane('hsplit');
    return;
  }
  if (ctrlShift && e.key === '-') {
    e.preventDefault();
    splitPane('vsplit');
    return;
  }
  if (ctrlShift && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    createSession();
    return;
  }
  if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    selectTabByIndex(Number(e.key));
    return;
  }

  if (!inInput && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    switchTab(-1);
    return;
  }
  if (!inInput && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    switchTab(1);
    return;
  }

  if (!activePaneId) return;
  const hasSelection = !!(window.getSelection && window.getSelection().toString());

  if (e.key === 'Escape') {
    e.preventDefault();
    sendSpecialKey(activePaneId, 'Escape');
  } else if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    sendSpecialKey(activePaneId, 'BTab');
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    sendSpecialKey(activePaneId, 'Tab');
  } else if (e.key.toLowerCase() === 'c' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    if (hasSelection) return;
    e.preventDefault();
    sendSpecialKey(activePaneId, 'C-c');
  } else if (e.key === 'Enter' && !e.target.closest('.input-row') && !e.target.closest('.toolbar') && !e.target.closest('#login')) {
    e.preventDefault();
    sendSpecialKey(activePaneId, 'Enter');
  } else if (e.key === 'ArrowUp' && !e.target.closest('.input-row')) {
    e.preventDefault();
    sendSpecialKey(activePaneId, 'Up');
  } else if (e.key === 'ArrowDown' && !e.target.closest('.input-row')) {
    e.preventDefault();
    sendSpecialKey(activePaneId, 'Down');
  } else if (!inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'Backspace') {
      e.preventDefault();
      sendSpecialKey(activePaneId, 'BSpace');
    } else if (e.key === ' ') {
      e.preventDefault();
      sendSpecialKey(activePaneId, 'Space');
    } else if (e.key.length === 1) {
      e.preventDefault();
      sendSpecialKey(activePaneId, e.key);
    }
  }
});
