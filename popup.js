document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(['minDelay', 'maxDelay', 'limite', 'likeFirstMedia'], (data) => {
    const quantidade = document.getElementById('quantidade');
    const minDelay = document.getElementById('minDelay');
    const maxDelay = document.getElementById('maxDelay');
    const likeFirst = document.getElementById('likeFirstMedia');
    if (quantidade) quantidade.value = data.limite || 10;
    if (minDelay) minDelay.value = data.minDelay || 120;
    if (maxDelay) maxDelay.value = data.maxDelay || 180;
    if (likeFirst) likeFirst.checked = data.likeFirstMedia || false;
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
    const likeFirst = document.getElementById('likeFirstMedia')?.checked || false;

    chrome.storage.sync.set({ minDelay, maxDelay, limite, likeFirstMedia: likeFirst });

    chrome.storage.local.get('af_state', (data) => {
      const st = data.af_state || {};
      chrome.storage.local.set(
        { af_state: { ...st, running: true, pausedUntil: 0, consecutiveFails: 0 } },
        () => {
          chrome.runtime.sendMessage({ type: 'AF_CLEAR_ALARM' });
          sendMessageToActiveTab({ action: 'start', limite, minDelay, maxDelay, likeFirstMedia: likeFirst });
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

  refreshStatus();
});

