document.addEventListener('DOMContentLoaded', () => {
  const loginView = document.getElementById('loginView');
  const appView = document.getElementById('appView');
  const loginMsg = document.getElementById('loginMsg');

  function showLogin(text = "") {
    if (loginView) loginView.style.display = 'block';
    if (appView) appView.style.display = 'none';
    if (loginMsg) loginMsg.textContent = text || "";
  }

  function showApp() {
    if (loginView) loginView.style.display = 'none';
    if (appView) appView.style.display = 'block';
    if (loginMsg) loginMsg.textContent = "";
    refreshStatus();
  }

  chrome.storage.sync.get(['minDelay', 'maxDelay', 'limite'], (data) => {
    const quantidade = document.getElementById('quantidade');
    const minDelay = document.getElementById('minDelay');
    const maxDelay = document.getElementById('maxDelay');
    if (quantidade) quantidade.value = data.limite || 10;
    if (minDelay) minDelay.value = data.minDelay || 120;
    if (maxDelay) maxDelay.value = data.maxDelay || 180;
  });

  function refreshStatus() {
    chrome.storage.local.get('af_state', (data) => {
      const state = data.af_state || {};
      const el = document.getElementById('afStatus');
      if (!el) return;
      let text = 'Parado';
      if (state.running) {
        if (state.pausedUntil && state.pausedUntil > Date.now()) {
          text = 'Pausado até ' + new Date(state.pausedUntil).toLocaleTimeString();
        } else {
          text = 'Rodando';
        }
      } else if (state.stage >= 2) {
        text = 'Finalizado por limite';
      }
      el.textContent = text;
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.af_state) refreshStatus();
  });

  function sendMessageToActiveTab(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, message);
    });
  }

  document.getElementById('startBtn')?.addEventListener('click', () => {
    const limite = parseInt(document.getElementById('quantidade')?.value) || 10;
    const minDelay = parseInt(document.getElementById('minDelay')?.value) || 120;
    const maxDelay = parseInt(document.getElementById('maxDelay')?.value) || 180;

    chrome.storage.sync.set({ minDelay, maxDelay, limite });

    chrome.storage.local.get('af_state', (data) => {
      const st = data.af_state || {};
      chrome.storage.local.set(
        { af_state: { ...st, running: true, pausedUntil: 0, consecutiveFails: 0 } },
        () => {
          chrome.runtime.sendMessage({ type: 'AF_CLEAR_ALARM' });
          sendMessageToActiveTab({ action: 'start', limite, minDelay, maxDelay });
          refreshStatus();
        }
      );
    });
  });

  document.getElementById('stopBtn')?.addEventListener('click', () => {
    chrome.storage.local.set(
      {
        af_state: {
          running: false,
          pausedUntil: 0,
          consecutiveFails: 0,
          stage: 0,
          totalFails: 0,
        },
      },
      () => {
        chrome.runtime.sendMessage({ type: 'AF_CLEAR_ALARM' });
        sendMessageToActiveTab({ action: 'stop' });
        refreshStatus();
      }
    );
  });

  async function refreshUI() {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'AUTH_STATUS' });
    } catch (e) {
      console.warn('[POPUP] AUTH_STATUS failed:', e);
    }
    if (!res) return showLogin('Carregando autenticação...');
    const now = (res && res.now) || Date.now();
    const lockUntil = res?.auth_lockUntil || 0;
    const authed = !!(
      res?.auth &&
      res.auth.state === 'AUTH' &&
      (!res.auth.exp || res.auth.exp > now)
    );

    if (lockUntil > now) {
      const untilStr = new Date(lockUntil).toLocaleTimeString();
      return showLogin(`Bloqueado até ${untilStr}.`);
    }
    if (authed) return showApp();
    return showLogin('');
  }

  const btnLogin = document.getElementById('loginBtn');
  const inpUser = document.getElementById('loginUser');
  const inpPass = document.getElementById('loginPass');
  const btnLogout = document.getElementById('logoutBtn');

  btnLogin?.addEventListener('click', async () => {
    const user = (inpUser?.value || '').trim();
    const pass = (inpPass?.value || '').trim();
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: 'AUTH_LOGIN', user, pass });
    } catch (e) {
      return showLogin('Falha de comunicação.');
    }
    if (r?.ok) return refreshUI();
    if (r?.error === 'LOCKED_UNTIL') {
      const untilStr = new Date(r.lockUntil).toLocaleTimeString();
      return showLogin(`Bloqueado até ${untilStr}.`);
    }
    if (r?.error === 'USER_NOT_FOUND') {
      return showLogin('Usuário não encontrado.');
    }
    if (r?.error === 'INVALID_PASSWORD') {
      return showLogin('Senha incorreta.');
    }
    return showLogin('Usuário ou senha inválidos.');
  });

  btnLogout?.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' });
    } catch (e) {}
    refreshUI();
  });

  refreshUI();
});

