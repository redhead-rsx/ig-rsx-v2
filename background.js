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
(function attachLikerHandler(){
  if (attachLikerHandler._bound) return; // idempotente

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type !== "LIKE_FIRST_MEDIA" && msg?.type !== "LIKE_REQUEST") {
          return sendResponse({ ok:false, passthrough:true });
        }

        // Normaliza entrada
        let profileUrl = msg?.profileUrl || null;
        if (!profileUrl && msg?.type === "LIKE_REQUEST" && msg.username) {
          profileUrl = `https://www.instagram.com/${msg.username}/`;
        }
        if (!profileUrl) {
          // tentar deduzir da aba ativa
          const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
          if (!tab?.url) return sendResponse({ ok:false, error:"NO_ACTIVE_TAB" });
          const u = new URL(tab.url);
          const p = u.pathname.split("/").filter(Boolean);
          if (!p[0] || p[0]==="p" || p[0]==="reel")
            return sendResponse({ ok:false, error:"NOT_ON_PROFILE" });
          profileUrl = `https://www.instagram.com/${p[0]}/`;
        }

        // Abrir/ativar aba e focar janela
        const tab = await new Promise(res => chrome.tabs.create({ url: profileUrl, active: true }, res));
        if (!tab?.id) return sendResponse({ ok:false, error:"TAB_CREATE_FAILED" });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });

        // Esperar carregar COMPLETO
        await new Promise(resolve => {
          const onUpdated = (id, info) => {
            if (id === tab.id && info.status === "complete") {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
        });
        await new Promise(r=>setTimeout(r,800)); // hidratação

        // Injetar liker no MAIN
        await chrome.scripting.executeScript({ target:{ tabId: tab.id }, files:['liker.js'], world:'MAIN' });

        // Aguardar resposta do liker
        let done=false;
        const timer = setTimeout(()=>{
          if (!done) {
            chrome.runtime.onMessage.removeListener(onMsg);
            sendResponse({ ok:false, type:"LIKE_SKIP", reason:"timeout" });
          }
        }, 60000);

        function onMsg(m, snd){
          if (snd?.tab?.id !== tab.id) return;
          if (m?.type === "LIKE_DONE") {
            done = true; clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(onMsg);
            return sendResponse({ ok:true, ...m });
          }
          if (m?.type === "LIKE_SKIP") {
            done = true; clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(onMsg);
            return sendResponse({ ok:false, ...m });
          }
        }
        chrome.runtime.onMessage.addListener(onMsg);
      } catch(e){
        console.error("[BG/LIKER] exception:", e);
        sendResponse({ ok:false, type:"LIKE_SKIP", reason:"exception", detail:String(e?.message||e) });
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

