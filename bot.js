const DEFAULT_STATE = {
  running: false,
  pausedUntil: 0,
  consecutiveFails: 0,
  stage: 0,
  totalFails: 0,
};

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ af_state: DEFAULT_STATE }, (data) => {
      resolve(data.af_state || DEFAULT_STATE);
    });
  });
}

function setState(update) {
  return getState().then((st) => {
    const newState = { ...st, ...update };
    return new Promise((resolve) => {
      chrome.storage.local.set({ af_state: newState }, () => resolve(newState));
    });
  });
}

async function detectRateLimitOrFail(btn) {
  const failTexts = [
    'action blocked',
    'try again later',
    'tente novamente mais tarde',
    'ação bloqueada',
  ];
  const timeout = 6000;
  const interval = 200;
  const start = Date.now();
  const startText = (btn.innerText || '').toLowerCase();

  function hasFailToast() {
    const els = Array.from(document.querySelectorAll('div'));
    return els.some((el) => {
      const txt = (el.innerText || '').toLowerCase();
      return failTexts.some((f) => txt.includes(f));
    });
  }

  while (Date.now() - start < timeout) {
    if (hasFailToast()) return { ok: false, reason: 'toast' };
    const txt = (btn.innerText || '').toLowerCase();
    if (txt.includes('seguindo') || txt.includes('following')) return { ok: true };
    await new Promise((r) => setTimeout(r, interval));
  }
  const endTxt = (btn.innerText || '').toLowerCase();
  if (endTxt.includes('seguindo') || endTxt.includes('following')) return { ok: true };
  if (endTxt === startText) return { ok: false, reason: 'nochange' };
  return { ok: false, reason: 'timeout' };
}

class Bot {
  constructor() {
    this.rodando = false;
    this.perfisSeguidos = 0;
    this.limite = 10;
    this.overlay = null;
    this.logOverlay = null;
    this.countdownInterval = null;
    this.minDelay = 120000;
    this.maxDelay = 180000;
  }

  criarOverlays() {
    if (!document.getElementById('autoFollowStyles')) {
      const style = document.createElement('style');
      style.id = 'autoFollowStyles';
      style.textContent = `
        #autoFollowOverlay {
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: rgba(0,0,0,0.8);
          color: #fff;
          padding: 10px 12px;
          border-radius: 6px;
          z-index: 2147483647;
          font: 12px/1.4 Arial, sans-serif;
          white-space: pre-line;
          box-shadow: 0 4px 12px rgba(0,0,0,0.35);
          pointer-events: none;
        }
        #autoFollowLog {
          position: fixed;
          top: 20px;
          left: 20px;
          background: rgba(0,0,0,0.8);
          color: #fff;
          padding: 10px 12px;
          border-radius: 6px;
          z-index: 2147483647;
          font: 12px/1.4 Arial, sans-serif;
          max-height: 60vh;
          overflow-y: auto;
          white-space: pre-line;
          box-shadow: 0 4px 12px rgba(0,0,0,0.35);
          pointer-events: none;
        }
      `;
      document.head.appendChild(style);
    }
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.id = 'autoFollowOverlay';
      this.overlay.textContent = 'Pronto.';
      document.body.appendChild(this.overlay);
    }
    if (!this.logOverlay) {
      this.logOverlay = document.createElement('div');
      this.logOverlay.id = 'autoFollowLog';
      this.logOverlay.textContent = 'Perfis seguidos:\n';
      document.body.appendChild(this.logOverlay);
    }
  }

  atualizarOverlay(texto) {
    if (this.overlay) this.overlay.textContent = texto;
  }

  addLog(username, badge = '') {
    if (!this.logOverlay) return;
    const line = badge ? `@${username} ${badge}\n` : `@${username}\n`;
    this.logOverlay.textContent += line;
    this.logOverlay.scrollTop = this.logOverlay.scrollHeight;
  }

  getRandomDelay() {
    return this.minDelay + Math.random() * (this.maxDelay - this.minDelay);
  }

  startCountdown(seconds) {
    clearInterval(this.countdownInterval);
    let remaining = seconds;
    this.countdownInterval = setInterval(() => {
      if (!this.rodando) {
        clearInterval(this.countdownInterval);
        return;
      }
      this.atualizarOverlay(`Aguardando ${remaining}s... (${this.perfisSeguidos}/${this.limite})`);
      if (remaining <= 0) {
        clearInterval(this.countdownInterval);
        this.seguirProximoUsuario();
      }
      remaining--;
    }, 1000);
  }

  encontrarModalInterno(modal) {
    const divs = modal.querySelectorAll('div');
    for (let div of divs) {
      if (div.scrollHeight > div.clientHeight) {
        return div;
      }
    }
    return null;
  }

  async extractUsernameFromFollowButton(btn) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bad = new Set(['p','reel','reels','explore','accounts','stories','direct','challenge','tv']);
    const notInsideBtn = (el) => !btn.contains(el);

    let current = btn;
    for (let i = 0; i < 8 && current; i++) {
      const anchors = Array.from(current.querySelectorAll('a[href^="/"][href$="/"]')).filter(notInsideBtn);
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/([^\/?#]+)\/$/);
        if (!m) continue;
        const seg = (m[1] || '').toLowerCase();
        if (!bad.has(seg)) return m[1];
      }
      const spanCandidate = Array.from(current.querySelectorAll('span[dir="auto"], div[dir="auto"]'))
        .filter(notInsideBtn)
        .map((s) => (s.innerText || '').trim())
        .find((t) => t && !t.includes(' ') && !/^@?seguir$|^@?following$|^@?follow$/i.test(t));
      if (spanCandidate) return spanCandidate.replace(/^@/, '');
      current = current.parentElement;
      await sleep(10);
    }
    return 'desconhecido';
  }

  async seguirProximoUsuario() {
    if (!this.rodando) return;
    const gate = await new Promise((r) => chrome.runtime.sendMessage({ type: 'CAN_RUN' }, r));
    if (!gate?.ok) {
      this.atualizarOverlay('Faça login no popup');
      this.rodando = false;
      return;
    }
    const state = await getState();
    if (!state.running) { this.stop(); return; }
    if (state.pausedUntil > Date.now()) {
      const retoma = new Date(state.pausedUntil).toLocaleTimeString();
      this.atualizarOverlay(`Pausado até ${retoma}`);
      return;
    }

    const modal = document.querySelector('div[role="dialog"]');
    if (!modal) {
      this.atualizarOverlay('Abra o modal de seguidores');
      setTimeout(() => this.seguirProximoUsuario(), 1000);
      return;
    }

    const modalInterno = this.encontrarModalInterno(modal);
    if (!modalInterno) {
      this.atualizarOverlay('Não encontrou a div interna scrollável');
      setTimeout(() => this.seguirProximoUsuario(), 1000);
      return;
    }

    const btn = Array.from(modalInterno.querySelectorAll('button')).find((b) => {
      const t = (b.innerText || '').trim().toLowerCase();
      return t === 'seguir' || t === 'follow';
    });

    if (btn) {
      const txt = (btn.innerText || '').trim().toLowerCase();
      if (txt === 'seguindo' || txt === 'following') {
        modalInterno.scrollTop += 70;
        setTimeout(() => this.seguirProximoUsuario(), 1000);
        return;
      }
      const username = await this.extractUsernameFromFollowButton(btn);
      btn.click();
      const result = await detectRateLimitOrFail(btn);
      if (result.ok) {
        this.perfisSeguidos++;
        this.addLog(username, '✔');
        this.atualizarOverlay(`Seguido @${username} (${this.perfisSeguidos}/${this.limite})`);
        await setState({ consecutiveFails: 0 });
      } else {
        this.addLog(username, '✖');
        const st = await getState();
        const newFails = st.consecutiveFails + 1;
        let updates = { consecutiveFails: newFails, totalFails: (st.totalFails || 0) + 1 };
        if (newFails >= 3) {
          if (st.stage === 0) {
            const pauseMs = 20 * 60 * 1000;
            const pausedUntil = Date.now() + pauseMs;
            updates = { consecutiveFails: 0, pausedUntil, stage: st.stage + 1, totalFails: updates.totalFails };
            this.atualizarOverlay(`Limite detectado. Pausado por 20 min (retoma às ${new Date(pausedUntil).toLocaleTimeString()})`);
            chrome.runtime.sendMessage({ type: 'AF_SET_ALARM', pausedUntil });
            clearInterval(this.countdownInterval);
            await setState(updates);
            return;
          } else if (st.stage === 1) {
            const pauseMs = 30 * 60 * 1000;
            const pausedUntil = Date.now() + pauseMs;
            updates = { consecutiveFails: 0, pausedUntil, stage: st.stage + 1, totalFails: updates.totalFails };
            this.atualizarOverlay(`Limite detectado. Pausado por 30 min (retoma às ${new Date(pausedUntil).toLocaleTimeString()})`);
            chrome.runtime.sendMessage({ type: 'AF_SET_ALARM', pausedUntil });
            clearInterval(this.countdownInterval);
            await setState(updates);
            return;
          } else {
            await setState({ running: false, pausedUntil: 0, consecutiveFails: 0, stage: st.stage, totalFails: updates.totalFails });
            chrome.runtime.sendMessage({ type: 'AF_CLEAR_ALARM' });
            this.rodando = false;
            clearInterval(this.countdownInterval);
            this.atualizarOverlay('Finalizado por limite do Instagram.');
            return;
          }
        }
        await setState(updates);
      }
      modalInterno.scrollTop += 70;
    } else {
      this.atualizarOverlay('Rolando modal...');
      const prevScroll = modalInterno.scrollTop;
      modalInterno.scrollTop += 60;
      setTimeout(() => {
        if (modalInterno.scrollTop === prevScroll) {
          this.atualizarOverlay(`Fim do modal ou todos os perfis carregados (${this.perfisSeguidos}/${this.limite})`);
          this.rodando = false;
          clearInterval(this.countdownInterval);
          return;
        }
        this.seguirProximoUsuario();
      }, 1500);
      return;
    }

    if (this.perfisSeguidos >= this.limite) {
      this.rodando = false;
      this.atualizarOverlay(`Limite atingido (${this.limite})`);
      clearInterval(this.countdownInterval);
      return;
    }

    const delaySegundos = Math.floor(this.getRandomDelay() / 1000);
    this.startCountdown(delaySegundos);
  }

  onResume() {
    this.atualizarOverlay('Retomando após pausa...');
    this.seguirProximoUsuario();
  }

  async start(limiteParam, minDelayParam, maxDelayParam) {
    if (this.rodando) return;
    this.rodando = true;
    this.perfisSeguidos = 0;
    this.limite = limiteParam || 10;
    const min = Number(minDelayParam || 120);
    const max = Number(maxDelayParam || 180);
    this.minDelay = Math.min(min, max) * 1000;
    this.maxDelay = Math.max(min, max) * 1000;
    await setState({ running: true, pausedUntil: 0, consecutiveFails: 0 });
    chrome.runtime.sendMessage({ type: 'AF_CLEAR_ALARM' });
    this.criarOverlays();
    this.seguirProximoUsuario();
  }

  async stop() {
    this.rodando = false;
    this.atualizarOverlay('Automação parada');
    clearInterval(this.countdownInterval);
    await setState({ running: false, pausedUntil: 0, consecutiveFails: 0, stage: 0 });
    chrome.runtime.sendMessage({ type: 'AF_CLEAR_ALARM' });
  }
}

const bot = new Bot();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AF_RESUME') {
    bot.onResume();
  }
});

window.__igBot = bot;
