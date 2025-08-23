const AUTH = {
  SALT: "dias-ig-salt-v1",
  PEPPER: "pepperFixoNoCodigoV1",
  MAX_FAILS: 5,
  LOCK_MS: 10 * 60 * 1000,
  DEFAULT_EXP_MS: 7 * 24 * 60 * 60 * 1000,
  USERS: [
    {
      username: "gabriel",
      hash: "0a2993606661d5cc936002cdb14ce6fe14afc3e7a953d5cf374d4edb6cf9f5c2",
    },
    {
      username: "milton",
      hash: "f113d1aa89e8f25c724832a553a3189057999fa88d28bc7e3c6c148a1ebb805b",
    },
  ],
};

function normalize(s) {
  return String(s || "").trim();
}

async function sha256Hex(s) {
  const e = new TextEncoder();
  const b = await crypto.subtle.digest("SHA-256", e.encode(s));
  return [...new Uint8Array(b)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function checkUserPass(user, pass) {
  const u = normalize(user);
  const p = normalize(pass);
  const combo = AUTH.PEPPER + AUTH.SALT + u + ":" + p;
  const calc = await sha256Hex(combo);
  const found = AUTH.USERS.find((usr) => usr.username === u);
  const { DEBUG_AUTH } = await storeGet("DEBUG_AUTH");
  if (DEBUG_AUTH === true) {
    console.log({
      user: u,
      calc: calc.slice(0, 12),
      expected: found ? found.hash.slice(0, 12) : null,
    });
  }
  return { ok: !!(found && calc === found.hash), found: !!found };
}

const storeGet = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const storeSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

function isAuthorized(auth, lockUntil, now) {
  return (
    auth.state === "AUTH" &&
    (!auth.exp || auth.exp > now) &&
    (!lockUntil || lockUntil <= now)
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      async function getAuthSafe() {
        const {
          auth,
          auth_failCount = 0,
          auth_lockUntil = 0,
        } = await chrome.storage.local.get([
          "auth",
          "auth_failCount",
          "auth_lockUntil",
        ]);
        const safeAuth =
          auth && typeof auth === "object" ? auth : { state: "NONE" };
        return { auth: safeAuth, auth_failCount, auth_lockUntil };
      }

      const now = Date.now();

      if (msg?.type === "AUTH_STATUS") {
        const { auth, auth_failCount, auth_lockUntil } = await getAuthSafe();
        return sendResponse({
          ok: true,
          auth,
          auth_failCount,
          auth_lockUntil,
          now,
        });
      }

      if (msg?.type === "AUTH_LOGIN") {
        const user = normalize(msg.user);
        const pass = normalize(msg.pass);
        const { auth_lockUntil = 0 } = await storeGet("auth_lockUntil");
        if (auth_lockUntil > now) {
          return sendResponse({
            ok: false,
            error: "LOCKED_UNTIL",
            lockUntil: auth_lockUntil,
          });
        }
        const { ok, found } = await checkUserPass(user, pass);
        if (ok) {
          const exp = now + (AUTH.DEFAULT_EXP_MS || 7 * 24 * 60 * 60 * 1000);
          await storeSet({
            auth: { state: "AUTH", user, since: now, exp },
            auth_failCount: 0,
            auth_lockUntil: 0,
          });
          return sendResponse({ ok: true, exp });
        } else {
          const { auth_failCount = 0 } = await storeGet("auth_failCount");
          const next = auth_failCount + 1;
          if (next >= (AUTH.MAX_FAILS || 5)) {
            const lockUntil = now + (AUTH.LOCK_MS || 10 * 60 * 1000);
            await storeSet({
              auth_failCount: 0,
              auth_lockUntil: lockUntil,
            });
            return sendResponse({
              ok: false,
              error: found ? "INVALID_PASSWORD" : "USER_NOT_FOUND",
              failCount: 0,
              lockUntil,
            });
          } else {
            await storeSet({ auth_failCount: next });
            return sendResponse({
              ok: false,
              error: found ? "INVALID_PASSWORD" : "USER_NOT_FOUND",
              failCount: next,
            });
          }
        }
      }

      if (msg?.type === "AUTH_LOGOUT") {
        await chrome.storage.local.set({
          auth: { state: "NONE" },
          auth_failCount: 0,
          auth_lockUntil: 0,
        });
        return sendResponse({ ok: true });
      }

      if (msg?.type === "CAN_RUN") {
          const { auth, auth_lockUntil } = await (async () => {
            const { auth, auth_lockUntil } = await chrome.storage.local.get([
              "auth",
              "auth_lockUntil",
            ]);
            return {
              auth:
                auth && typeof auth === "object" ? auth : { state: "NONE" },
              auth_lockUntil: auth_lockUntil || 0,
            };
          })();
          const authorized =
            (!auth_lockUntil || auth_lockUntil <= now) &&
            auth?.state === "AUTH" &&
            (!auth?.exp || auth.exp > now);
          return sendResponse({ ok: !!authorized });
      }

        if (
          ["START", "FOLLOW_ONE", "STOP", "AF_SET_ALARM", "AF_CLEAR_ALARM"].includes(
            msg?.type
          )
        ) {
        const { auth, auth_lockUntil = 0 } = await chrome.storage.local.get([
          "auth",
          "auth_lockUntil",
        ]);
        const authorized =
          (!auth_lockUntil || auth_lockUntil <= now) &&
          auth?.state === "AUTH" &&
          (!auth?.exp || auth.exp > now);
        if (!authorized)
          return sendResponse({ ok: false, error: "UNAUTHORIZED" });

        if (msg.type === "AF_SET_ALARM") {
          chrome.alarms.create("autoFollowResume", { when: msg.pausedUntil });
          return sendResponse({ ok: true });
        }

        if (msg.type === "AF_CLEAR_ALARM") {
          chrome.alarms.clear("autoFollowResume");
          return sendResponse({ ok: true });
        }

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

        // Gate de autorização — use CAN_RUN se existir
        let authorized = true;
        try {
          const gate = await chrome.runtime.sendMessage({ type:"CAN_RUN" });
          authorized = !!gate?.ok;
        } catch(_){
          const { auth, auth_lockUntil=0 } = await chrome.storage.local.get(["auth","auth_lockUntil"]);
          const now = Date.now();
          authorized = (!auth_lockUntil || auth_lockUntil <= now)
                    && auth?.state === "AUTH"
                    && (!auth?.exp || auth.exp > now);
        }
        if (!authorized) return sendResponse({ ok:false, error:"UNAUTHORIZED" });

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
    const now = Date.now();
    const data = await storeGet(["auth", "auth_lockUntil", "af_state"]);
    const auth = data.auth || { state: "NONE" };
    const lockUntil = data.auth_lockUntil || 0;
    if (!isAuthorized(auth, lockUntil, now)) return;
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

