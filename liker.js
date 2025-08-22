// liker.js - injected in page main world to like first media of a profile
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (pred, { timeout = 8000, step = 120 } = {}) => {
    const t0 = Date.now();
    let v;
    while (Date.now() - t0 < timeout) {
      v = await pred();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };
  const isVisible = (el) =>
    el &&
    el.isConnected &&
    el.offsetWidth > 0 &&
    el.offsetHeight > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  function safeClick(el) {
    if (!isVisible(el)) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    const o = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerover", o));
    el.dispatchEvent(new MouseEvent("mouseover", o));
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    try { el.click(); } catch (e) {}
    return true;
  }

  const FAIL_TEXTS = [
    "action blocked",
    "try again later",
    "tente novamente mais tarde",
    "ação bloqueada",
  ];
  const POST_DELAY = 1500;

  function hasRateLimitToast() {
    const els = Array.from(document.querySelectorAll("div, span"));
    return els.some((el) => {
      const t = (el.innerText || "").toLowerCase();
      return FAIL_TEXTS.some((f) => t.includes(f));
    });
  }

  function pageUnavailable() {
    const txt = (document.body.innerText || "").toLowerCase();
    if (txt.includes("this page isn't available") || txt.includes("página não"))
      return true;
    return false;
  }

  function isPrivateWithoutFollow() {
    const txt = (document.body.innerText || "").toLowerCase();
    return txt.includes("this account is private") || txt.includes("esta conta é privada");
  }

  function detectMediaType(article) {
    if (location.pathname.startsWith("/reel/")) return "reel";
    if (article.querySelector("video")) return "video";
    if (
      article.querySelector("svg[aria-label*='Carrossel']") ||
      article.querySelector("svg[aria-label*='Carousel']") ||
      article.querySelector("button[aria-label*='Slide']")
    )
      return "carousel";
    return "photo";
  }

  async function closePost(ctx) {
    if (ctx === "modal") {
      const btn = document.querySelector("div[role='dialog'] button[aria-label]");
      if (btn) safeClick(btn);
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })
      );
    } else {
      history.back();
    }
    await sleep(300);
  }

  if (pageUnavailable()) {
    return { type: "LIKE_SKIP", reason: "open_failed" };
  }
  if (isPrivateWithoutFollow()) {
    return { type: "LIKE_SKIP", reason: "no_media" };
  }

  const anchor = Array.from(
    document.querySelectorAll("article a[href*='/p/'], article a[href*='/reel/']")
  ).find(isVisible);
  if (!anchor) return { type: "LIKE_SKIP", reason: "no_media" };
  safeClick(anchor);

  const opened = await until(() => {
    const dlg = document.querySelector("div[role='dialog'] article");
    if (dlg) return { article: dlg, ctx: "modal" };
    if (location.pathname.startsWith("/p/") || location.pathname.startsWith("/reel/")) {
      const art = document.querySelector("main article");
      if (art) return { article: art, ctx: "page" };
    }
    return null;
  });
  if (!opened) return { type: "LIKE_SKIP", reason: "open_failed" };

  const { article, ctx } = opened;
  const mediaType = detectMediaType(article);

  const findBtn = () =>
    Array.from(article.querySelectorAll("button[aria-label][aria-pressed]")).find((b) => {
      const l = (b.getAttribute("aria-label") || "").toLowerCase();
      return /curtir|like|descurtir|unlike/.test(l);
    });

  let btn = findBtn();
  if (!btn) {
    await closePost(ctx);
    return { type: "LIKE_SKIP", reason: "like_button_not_found" };
  }
  if (btn.getAttribute("aria-pressed") === "true") {
    await closePost(ctx);
    return { type: "LIKE_DONE", mediaType, already: true };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    safeClick(btn);
    const changed = await until(() => {
      if (hasRateLimitToast()) return "rate_limited";
      return btn.getAttribute("aria-pressed") === "true";
    });
    if (changed === "rate_limited") {
      await closePost(ctx);
      return { type: "LIKE_SKIP", reason: "rate_limited" };
    }
    if (changed) {
      await sleep(POST_DELAY);
      await closePost(ctx);
      return { type: "LIKE_DONE", mediaType };
    }
    btn = findBtn();
    if (!btn) break;
    if (btn.getAttribute("aria-pressed") === "true") {
      await sleep(POST_DELAY);
      await closePost(ctx);
      return { type: "LIKE_DONE", mediaType };
    }
  }
  await closePost(ctx);
  return { type: "LIKE_SKIP", reason: "state_not_changed" };
})();

