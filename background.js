const storeGet = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const storeSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (["START", "FOLLOW_ONE", "STOP"].includes(msg?.type)) {
        return sendResponse({ ok: true });
      }

      if (msg?.type === "AF_SET_ALARM") {
        chrome.alarms.create("autoFollowResume", { when: msg.pausedUntil });
        return sendResponse({ ok: true });
      }

      if (msg?.type === "AF_CLEAR_ALARM") {
        chrome.alarms.clear("autoFollowResume");
        return sendResponse({ ok: true });
      }

      return sendResponse({ ok: false, error: "UNKNOWN_MSG" });
    } catch (e) {
      console.error("[BG] onMessage error:", e);
      return sendResponse({
        ok: false,
        error: "EXCEPTION",
        detail: String((e && e.message) || e),
      });
    }
  })();
  return true;
});

// BEGIN LIKER HANDLER (do not remove this comment)
(function attachLikerHandler() {
  if (attachLikerHandler._bound) return; // idempotente
  attachLikerHandler._bound = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "LIKE_FIRST_MEDIA" && msg?.type !== "LIKE_REQUEST") {
      sendResponse({ ok: false, passthrough: true });
      return false;
    }

    (async () => {
      const t0 = Date.now();
      let likeTab = null;
      const finalize = (resp) => {
        try {
          if (likeTab?.id) chrome.tabs.remove(likeTab.id);
        } catch {}
        resp.tookMs = Date.now() - t0;
        sendResponse(resp);
      };

      try {
        // Normaliza entrada
        let profileUrl = msg?.profileUrl || null;
        if (!profileUrl && msg?.type === "LIKE_REQUEST" && msg.username) {
          profileUrl = `https://www.instagram.com/${msg.username}/`;
        }
        if (!profileUrl) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.url) return finalize({ ok: false, type: "LIKE_SKIP", reason: "NO_ACTIVE_TAB" });
          const u = new URL(tab.url);
          const p = u.pathname.split("/").filter(Boolean);
          if (!p[0] || p[0] === "p" || p[0] === "reel") {
            return finalize({ ok: false, type: "LIKE_SKIP", reason: "NOT_ON_PROFILE" });
          }
          profileUrl = `https://www.instagram.com/${p[0]}/`;
        }

        // Abrir aba de perfil
        likeTab = await chrome.tabs.create({ url: profileUrl, active: true });
        if (!likeTab?.id) return finalize({ ok: false, type: "LIKE_SKIP", reason: "TAB_CREATE_FAILED" });
        if (likeTab.windowId) await chrome.windows.update(likeTab.windowId, { focused: true });

        // Esperar carregamento completo
        await new Promise((resolve) => {
          const onUpdated = (id, info) => {
            if (id === likeTab.id && info.status === "complete") {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
        });
        await new Promise((r) => setTimeout(r, 800));

        // Injetar liker
        await chrome.scripting.executeScript({
          target: { tabId: likeTab.id },
          files: ["liker.js"],
          world: "MAIN",
        });

        const onMsg = (m, snd) => {
          if (snd?.tab?.id !== likeTab.id) return;
          chrome.runtime.onMessage.removeListener(onMsg);
          finalize({ ok: m.type === "LIKE_DONE", type: m.type, mode: m.mode, reason: m.reason });
        };
        chrome.runtime.onMessage.addListener(onMsg);

        setTimeout(() => {
          chrome.runtime.onMessage.removeListener(onMsg);
          finalize({ ok: false, type: "LIKE_SKIP", reason: "timeout" });
        }, 60000);
      } catch (e) {
        finalize({ ok: false, type: "LIKE_SKIP", reason: "exception", detail: String(e?.message || e) });
      }
    })();
    return true; // manter a porta aberta
  });
})();
// END LIKER HANDLER (do not remove this comment)

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "autoFollowResume") {
    const data = await storeGet(["af_state"]);
    const state = data.af_state || {};
    if (state.running) {
      state.pausedUntil = 0;
      await storeSet({ af_state: state });
      chrome.tabs.query({ url: "https://www.instagram.com/*" }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: "AF_RESUME" });
        }
      });
    }
  }
});

