// ── Init & Event Binding ──

const REMEMBER_PW_KEY = 'nextmux.rememberedPw.v1';

function clearRememberedPassword(clearInput = false) {
  localStorage.removeItem(REMEMBER_PW_KEY);
  const pwInput = document.getElementById('pw');
  const remember = document.getElementById('remember-pw');
  const clearBtn = document.getElementById('clear-saved-pw-btn');
  if (pwInput && clearInput) pwInput.value = '';
  if (remember) remember.checked = false;
  if (clearBtn) clearBtn.style.display = 'none';
}

function saveRememberedPassword(plainPassword) {
  if (!plainPassword) return clearRememberedPassword(false);
  const clearBtn = document.getElementById('clear-saved-pw-btn');
  if (clearBtn) clearBtn.style.display = '';

  try {
    const obfuscated = btoa(unescape(encodeURIComponent(plainPassword)));
    localStorage.setItem(REMEMBER_PW_KEY, obfuscated);
  } catch (e) {
    clearRememberedPassword(false);
  }
}

function loadRememberedPassword() {
  const payload = localStorage.getItem(REMEMBER_PW_KEY);
  if (!payload) return null;

  try {
    if (payload.startsWith('{')) {
      localStorage.removeItem(REMEMBER_PW_KEY);
      return null;
    }
    return decodeURIComponent(escape(atob(payload)));
  } catch {
    localStorage.removeItem(REMEMBER_PW_KEY);
    return null;
  }
}

function initRememberedPassword() {
  const pwInput = document.getElementById('pw');
  const remember = document.getElementById('remember-pw');
  const clearBtn = document.getElementById('clear-saved-pw-btn');
  if (!pwInput || !remember || !clearBtn) return;

  const saved = loadRememberedPassword();
  if (saved) {
    pwInput.value = saved;
    remember.checked = true;
    clearBtn.style.display = '';
    
    // Seamless auto-login on initial page load if saved password exists
    doLogin();
  } else {
    remember.checked = false;
    clearBtn.style.display = 'none';
  }
}

function doLogin() {
  const pw = document.getElementById('pw').value;
  const rememberPw = document.getElementById('remember-pw').checked;
  apiPost('/api/login', { pw })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        const persist = rememberPw ? saveRememberedPassword(pw) : clearRememberedPassword();
        Promise.resolve(persist).catch(() => {});
        document.getElementById('login').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        loadConfig();
        initWS();
        loadAll();
        setLayout(layout);
      } else {
        document.getElementById('login-err').style.display = 'block';
        clearRememberedPassword(false); // Clear stale password if authentication fails
      }
    });
}

// ── Toolbar Toggle ──

function toggleToolbar() {
  const toolbar = document.getElementById('spawn-toolbar');
  const isOpen = toolbar.style.display !== 'none';
  toolbar.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) document.getElementById('cwd-input').focus();
}

// ── Event Binding ──

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('remember-pw').addEventListener('change', e => {
  if (!e.target.checked) clearRememberedPassword(false);
});
document.getElementById('clear-saved-pw-btn').addEventListener('click', () => clearRememberedPassword(true));
document.getElementById('toggle-toolbar-btn').addEventListener('click', toggleToolbar);
document.getElementById('dir-btn').addEventListener('click', toggleDropdown);
document.getElementById('spawn-btn').addEventListener('click', () => {
  spawnSession();
  document.getElementById('spawn-toolbar').style.display = 'none';
});
document.querySelectorAll('#session-starters .starter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#session-starters .starter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const cmdInput = document.getElementById('cmd-input');
    if (btn.dataset.cmd === '') {
      cmdInput.style.display = '';
      cmdInput.value = '';
      cmdInput.focus();
    } else {
      cmdInput.style.display = 'none';
    }
  });
});
document.getElementById('scan-btn').addEventListener('click', scanSessions);
document.getElementById('add-fav-btn').addEventListener('click', addFavorite);
document.getElementById('layout-tab-btn').addEventListener('click', () => setLayout('tab'));
document.getElementById('layout-split-btn').addEventListener('click', () => setLayout('split'));

document.addEventListener('click', e => {
  closeDropdown();
  if (!e.target.closest('.toolkit-wrap')) {
    document.querySelectorAll('.toolkit-popup.open').forEach(p => {
      p.classList.remove('open');
      p.previousElementSibling.classList.remove('open');
    });
  }
});

window.addEventListener('resize', scheduleSendResize);
initRememberedPassword();

// ── Keyboard Shortcuts ──

document.addEventListener('keydown', e => {
  if (!activeTab) return;

  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  const hasSelection = !!(window.getSelection && window.getSelection().toString());
  if (!inInput && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    switchTab(-1);
    return;
  } else if (!inInput && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    switchTab(1);
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Escape');
  } else if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    sendSpecialKey(activeTab, 'BTab');
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Tab');
  } else if (e.key.toLowerCase() === 'c' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    if (hasSelection) return;
    e.preventDefault();
    sendSpecialKey(activeTab, 'C-c');
  } else if (e.key === 'Enter' && !e.target.closest('.input-row') && !e.target.closest('.toolbar') && !e.target.closest('#login')) {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Enter');
  } else if (e.key === 'ArrowUp') {
    if (e.target.closest('.input-row')) return;
    e.preventDefault();
    sendSpecialKey(activeTab, 'Up');
  } else if (e.key === 'ArrowDown') {
    if (e.target.closest('.input-row')) return;
    e.preventDefault();
    sendSpecialKey(activeTab, 'Down');
  } else if (!inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // Forward regular key presses typed outside any input field directly to the active terminal
    if (e.key === 'Backspace') {
      e.preventDefault();
      sendSpecialKey(activeTab, 'BSpace');
    } else if (e.key === ' ') {
      e.preventDefault();
      sendSpecialKey(activeTab, 'Space');
    } else if (e.key.length === 1) {
      e.preventDefault();
      sendSpecialKey(activeTab, e.key);
    }
  }
});
