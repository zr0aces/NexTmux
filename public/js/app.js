// ── Init & Event Binding ──

const REMEMBER_PW_KEY = 'tmuxhub.rememberedPw.v1';
const REMEMBER_PW_DB = 'tmuxhub-secure-login';
const REMEMBER_PW_STORE = 'keys';
const REMEMBER_PW_KEY_ID = 'remember-password-key';

function toB64(bytes) {
  let out = '';
  bytes.forEach(b => { out += String.fromCharCode(b); });
  return btoa(out);
}

function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function openRememberDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('indexedDB_unavailable'));
    const req = indexedDB.open(REMEMBER_PW_DB, 1);
    req.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(REMEMBER_PW_STORE)) db.createObjectStore(REMEMBER_PW_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB_open_failed'));
  });
}

let getRememberKeyPromise = null;

async function getRememberKey(createIfMissing = true) {
  if (getRememberKeyPromise) return getRememberKeyPromise;

  getRememberKeyPromise = (async () => {
    if (!window.crypto || !window.crypto.subtle) return null;
    let db;
    try {
      db = await openRememberDb();
    } catch {
      return null;
    }
    try {
      const existing = await new Promise((resolve, reject) => {
        const tx = db.transaction(REMEMBER_PW_STORE, 'readonly');
        const store = tx.objectStore(REMEMBER_PW_STORE);
        const getReq = store.get(REMEMBER_PW_KEY_ID);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => reject(getReq.error || new Error('indexedDB_get_failed'));
      });

      if (existing || !createIfMissing) return existing;

      const nextKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );

      await new Promise((resolve, reject) => {
        const tx = db.transaction(REMEMBER_PW_STORE, 'readwrite');
        const store = tx.objectStore(REMEMBER_PW_STORE);
        const putReq = store.put(nextKey, REMEMBER_PW_KEY_ID);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error || new Error('indexedDB_put_failed'));
      });

      return nextKey;
    } finally {
      db.close();
    }
  })();

  try {
    return await getRememberKeyPromise;
  } finally {
    getRememberKeyPromise = null;
  }
}

async function clearRememberedPassword(clearInput = false) {
  localStorage.removeItem(REMEMBER_PW_KEY);
  const pwInput = document.getElementById('pw');
  const remember = document.getElementById('remember-pw');
  const clearBtn = document.getElementById('clear-saved-pw-btn');
  if (pwInput && clearInput) pwInput.value = '';
  if (remember) remember.checked = false;
  if (clearBtn) clearBtn.style.display = 'none';
}

async function saveRememberedPassword(plainPassword) {
  if (!plainPassword) return clearRememberedPassword(false);
  const clearBtn = document.getElementById('clear-saved-pw-btn');
  if (clearBtn) clearBtn.style.display = '';

  // Only store remembered passwords when WebCrypto is available.
  if (!window.crypto || !window.crypto.subtle) {
    clearRememberedPassword(false);
    return;
  }

  try {
    const key = await getRememberKey(true);
    if (!key) throw new Error('no_key');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plainPassword);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    localStorage.setItem(REMEMBER_PW_KEY, JSON.stringify({
      iv: toB64(iv),
      data: toB64(new Uint8Array(cipher)),
    }));
  } catch {
    clearRememberedPassword(false);
  }
}

async function loadRememberedPassword() {
  const payload = localStorage.getItem(REMEMBER_PW_KEY);
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload);
    if (!parsed) return null;

    if (!parsed.iv || !parsed.data) return null;
    
    // If browser environment doesn't support subtle crypto, can't decrypt original AES-GCM
    if (!window.crypto || !window.crypto.subtle) return null;

    const key = await getRememberKey(false);
    if (!key) return null;

    const iv = fromB64(parsed.iv);
    const cipher = fromB64(parsed.data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    localStorage.removeItem(REMEMBER_PW_KEY);
    return null;
  }
}

async function initRememberedPassword() {
  const pwInput = document.getElementById('pw');
  const remember = document.getElementById('remember-pw');
  const clearBtn = document.getElementById('clear-saved-pw-btn');
  if (!pwInput || !remember || !clearBtn) return;

  if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
    remember.disabled = true;
    remember.parentElement.style.opacity = '0.5';
    remember.parentElement.title = 'Remember Password requires HTTPS or localhost (Secure Context).';
    const errEl = document.getElementById('login-err');
    if (errEl) {
      const warn = document.createElement('div');
      warn.id = 'secure-context-warn';
      warn.style.cssText = 'color:#d29922;font-size:11px;margin-top:8px;text-align:center';
      warn.textContent = '⚠️ Remember Password disabled: Insecure Context (requires HTTPS/localhost)';
      errEl.parentNode.insertBefore(warn, errEl);
    }
  }

  const saved = await loadRememberedPassword();
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
