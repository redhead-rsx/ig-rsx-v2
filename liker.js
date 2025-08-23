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
  let mode = undefined;
  const send = (type, reason) => {
    const payload = { type, mode, tookMs: Date.now() - t0 };
    if (reason) payload.reason = reason;
    chrome.runtime.sendMessage(payload);
  };

  async function waitProfileGrid() {
    return !!(await until(() => {
      const article = document.querySelector('article');
      if (!article) return null;
      const tile = article.querySelector('a[href*="/p/"], a[href*="/reel/"], [role="link"]');
      return tile ? article : null;
    }, { timeout: 15000, step: 300 }));
  }

  async function findFirstMediaAnchor() {
    const attempts = 3;
    for (let i = 0; i < attempts; i++) {
      let anchors = [...document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"]')].filter(isVisible);
      if (anchors.length) return anchors[0];

      anchors = [...document.querySelectorAll('article [role="link"]')].filter(el => {
        if (!isVisible(el)) return false;
        return !!el.querySelector('img,canvas,video,svg[aria-label*="Reels" i]');
      });
      if (anchors.length) return anchors[0];

      window.scrollBy(0, 800);
      await sleep(300);
    }
    return null;
  }

  try {
    // Fechar intersticiais
    (() => {
      const texts = [
        'Fechar', 'Close', 'Agora não', 'Not now', 'Aceitar', 'Accept', 'Allow',
        'Abrir app', 'Open app', 'Ver foto', 'See photo', 'Talvez depois', 'Maybe later'
      ];
      [...document.querySelectorAll('button,[role="button"]')].forEach(b => {
        const t = (b.ariaLabel || b.innerText || '').trim().toLowerCase();
        if (texts.some(x => t.includes(x.toLowerCase()))) {
          try { b.click(); } catch {}
        }
      });
    })();

    const gridReady = await waitProfileGrid();
    if (!gridReady) {
      log('no media');
      return send('LIKE_SKIP', 'no_media');
    }

    window.scrollTo(0, 0);
    await sleep(200);

    const anchor = await findFirstMediaAnchor();
    if (!anchor) {
      log('no media');
      return send('LIKE_SKIP', 'no_media');
    }

    safeClick(anchor);

    mode = 'modal';
    const modal = await until(() => document.querySelector('[role="dialog"] article'), { timeout: 10000, step: 200 });
    if (!modal) {
      mode = 'route';
      const opened = await until(() => /^(\/p\/|\/reel\/)/.test(location.pathname), { timeout: 10000, step: 200 });
      if (!opened) {
        log('open_failed');
        return send('LIKE_SKIP', 'open_failed');
      }
    }
    const ctx = mode === 'modal' ? document.querySelector('[role="dialog"]') : document;

    function findLikeBtn() {
      const article = ctx.querySelector('article') || ctx;
      const pressed = article.querySelector('button[aria-pressed="true"]');
      const unpressed = article.querySelector('button[aria-pressed="false"]');
      const likeLbl = article.querySelector('button[aria-label*="Curtir" i],button[aria-label*="Like" i]');
      const unlikeLbl = article.querySelector('button[aria-label*="Descurtir" i],button[aria-label*="Unlike" i]');
      return { article, pressed, unpressed, likeLbl, unlikeLbl };
    }
    const alreadyLiked = (s) => !!(s.pressed || s.unlikeLbl);

    let state = findLikeBtn();
    if (!(state.pressed || state.unpressed || state.likeLbl || state.unlikeLbl)) {
      log('like_button_not_found');
      return send('LIKE_SKIP', 'like_button_not_found');
    }
    if (alreadyLiked(state)) {
      if (mode === 'modal') ctx.querySelector('[aria-label*="Fechar" i],[aria-label*="Close" i]')?.click();
      return send('LIKE_DONE');
    }

    async function clickAndConfirm() {
      let f = findLikeBtn();
      const btn = f.unpressed || f.likeLbl || f.pressed || f.unlikeLbl;
      if (!btn) return false;
      safeClick(btn);
      await sleep(300);
      const ok = await until(() => {
        const g = findLikeBtn();
        return alreadyLiked(g);
      }, { timeout: 8000, step: 150 });
      return !!ok;
    }

    let ok = await clickAndConfirm();
    if (!ok) {
      log('retrying...');
      await sleep(500);
      ok = await clickAndConfirm();
    }
    if (!ok) {
      log('state_not_changed');
      return send('LIKE_SKIP', 'state_not_changed');
    }

    if (mode === 'modal') ctx.querySelector('[aria-label*="Fechar" i],[aria-label*="Close" i]')?.click();
    log('LIKE_DONE');
    return send('LIKE_DONE');
  } catch (e) {
    console.error('[LIKER] exception', e);
    return send('LIKE_SKIP', 'exception');
  }
})();

