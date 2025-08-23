(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (pred, { timeout = 8000, step = 120 } = {}) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = await pred();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };
  const isVisible = (el) =>
    el && el.isConnected && el.offsetWidth > 0 && el.offsetHeight > 0 &&
    getComputedStyle(el).visibility !== 'hidden';
  const log = (...a) => { try { console.log('[LIKER]', ...a); } catch {} };

  function safeClick(el) {
    if (!isVisible(el)) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const o = { bubbles: true, cancelable: true, composed: true, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerover', o)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mouseover', o)); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch {}
    try { el.click(); } catch {}
    return true;
  }

  const t0 = Date.now();
  let mode;
  const send = (type, reason) => {
    const payload = { type, mode, tookMs: Date.now() - t0 };
    if (reason) payload.reason = reason;
    chrome.runtime.sendMessage(payload);
  };

  function openedMode() {
    if (document.querySelector('[role="dialog"] article')) return 'modal';
    if (/^\/(p|reel)\//.test(location.pathname)) return 'route';
    return null;
  }
  const waitOpened = (ms) => until(() => openedMode(), { timeout: ms, step: 150 });

  try {
    // Fechar intersticiais
    (() => {
      const texts = [
        'Fechar', 'Close', 'Agora não', 'Not now', 'Aceitar', 'Accept', 'Allow',
        'Abrir app', 'Open app', 'Talvez depois', 'Maybe later', 'Ver foto', 'See photo'
      ];
      [...document.querySelectorAll('button,[role="button"]')].forEach(b => {
        const t = (b.ariaLabel || b.innerText || '').trim().toLowerCase();
        if (texts.some(x => t.includes(x.toLowerCase()))) {
          try { b.click(); } catch {}
        }
      });
    })();

    const gridReady = await until(() => {
      const article = document.querySelector('article');
      if (!article) return false;
      const tile =
        [...article.querySelectorAll('a[href*="/p/"],a[href*="/reel/"]')].find(isVisible) ||
        [...article.querySelectorAll('[role="link"]')].find((a) =>
          isVisible(a) && a.querySelector('img,canvas,video,svg[aria-label*="Reels" i]')
        );
      return tile || false;
    }, { timeout: 15000, step: 300 });
    if (!gridReady) {
      log('reason', 'no_media');
      return send('LIKE_SKIP', 'no_media');
    }

    const anchor =
      [...document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"]')].find(isVisible) ||
      [...document.querySelectorAll('article [role="link"]')].find((a) =>
        isVisible(a) && a.querySelector('img,canvas,video,svg[aria-label*="Reels" i]')
      );
    if (!anchor) {
      log('reason', 'no_media');
      return send('LIKE_SKIP', 'no_media');
    }
    log('foundTile', true);

    safeClick(anchor);
    mode = await waitOpened(1500);
    if (!mode) {
      location.assign(anchor.href);
      mode = await waitOpened(10000);
    }
    if (!mode) {
      anchor.focus();
      const o = { bubbles: true, cancelable: true, view: window, key: 'Enter', keyCode: 13, which: 13, code: 'Enter' };
      ['keydown', 'keypress', 'keyup'].forEach(evt => {
        try { anchor.dispatchEvent(new KeyboardEvent(evt, o)); } catch {}
      });
      mode = await waitOpened(10000);
    }
    if (!mode) {
      log('reason', 'open_failed');
      return send('LIKE_SKIP', 'open_failed');
    }
    log('openMode', mode);

    const ctx = mode === 'modal' ? document.querySelector('[role="dialog"]') : document;

    function getLikeState() {
      const scope = ctx.querySelector('article') || ctx;
      const pressed = scope.querySelector('button[aria-pressed="true"]');
      const unpressed = scope.querySelector('button[aria-pressed="false"]');
      const likeLbl = scope.querySelector('button[aria-label*="Curtir" i],button[aria-label*="Like" i]');
      const unlikeLbl = scope.querySelector('button[aria-label*="Descurtir" i],button[aria-label*="Unlike" i]');
      const btn = pressed || unpressed || likeLbl || unlikeLbl;
      return { btn, liked: !!(pressed || unlikeLbl) };
    }

    let state = getLikeState();
    log('likeStateBefore', state);
    if (!state.btn) {
      log('reason', 'like_button_not_found');
      return send('LIKE_SKIP', 'like_button_not_found');
    }
    if (state.liked) {
      if (mode === 'modal') ctx.querySelector('[aria-label*="Fechar" i],[aria-label*="Close" i]')?.click();
      return send('LIKE_DONE');
    }

    async function clickAndConfirm() {
      for (let attempt = 0; attempt < 2; attempt++) {
        state = getLikeState();
        if (!state.btn) return false;
        safeClick(state.btn);
        await sleep(300);
        const ok = await until(() => getLikeState().liked, { timeout: 8000, step: 150 });
        if (ok) return true;
        await sleep(500);
      }
      return false;
    }

    const liked = await clickAndConfirm();
    state = getLikeState();
    log('likeStateAfter', state);
    if (!liked) {
      log('reason', 'state_not_changed');
      return send('LIKE_SKIP', 'state_not_changed');
    }

    if (mode === 'modal') ctx.querySelector('[aria-label*="Fechar" i],[aria-label*="Close" i]')?.click();
    return send('LIKE_DONE');
  } catch (e) {
    console.error('[LIKER] exception', e);
    return send('LIKE_SKIP', 'exception');
  }
})();

