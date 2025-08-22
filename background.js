const AUTH = {
  SALT: "dias-ig-salt-v1",
  PEPPER: "pepperFixoNoCodigoV1",
  MAX_FAILS: 5,
  LOCK_MS: 10 * 60 * 1000,
  DEFAULT_EXP_MS: 7 * 24 * 60 * 60 * 1000,
  USERS: [
    {
      username: "dias",
      hash: "24fc4f96f03f7148e570b560903f75ed30a433b91e7ce098289fb0c18093c539",
    },
    {
      username: "milton",
      hash: "0c0bf1c79bc8b2a2d53f6e9d584103c2003032bc8986e0159de3dd802eff4096",
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

        if (msg?.type === "LIKE_FIRST_MEDIA") {
          const { auth, auth_lockUntil = 0, af_state = {} } = await chrome.storage.local.get([
            "auth",
            "auth_lockUntil",
            "af_state",
          ]);
          const authorized = isAuthorized(auth, auth_lockUntil, now);
          const paused = af_state.pausedUntil && af_state.pausedUntil > now;
          const finished = af_state.stage >= 2;
          if (!authorized || paused || finished) {
            return sendResponse({ ok: false, error: "UNAUTHORIZED" });
          }

          const profileUrl = msg.profileUrl;
          if (!profileUrl) return sendResponse({ type: "LIKE_SKIP", reason: "open_failed" });
          console.log("[BG/LIKER] requesting like for", profileUrl);

          let tab;
          try {
            tab = await new Promise((resolve) =>
              chrome.tabs.create({ url: profileUrl, active: true }, resolve)
            );
          } catch (e) {
            console.error("[BG/LIKER] create tab fail", e);
            return sendResponse({ type: "LIKE_SKIP", reason: "open_failed" });
          }

          try {
            await chrome.windows.update(tab.windowId, { focused: true });
            await chrome.tabs.update(tab.id, { active: true });

            const completed = new Promise((resolve) => {
              const listener = (tid, info) => {
                if (tid === tab.id && info.status === "complete") {
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
            });
            await Promise.race([
              completed,
              new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 60000)),
            ]);
            await new Promise((r) => setTimeout(r, 700 + Math.random() * 300));
            const [inj] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["liker.js"],
              world: "MAIN",
            });
            const result = inj && inj.result ? inj.result : { type: "LIKE_SKIP", reason: "open_failed" };
            console.log("[BG/LIKER] result", result);
            if (result?.reason === "rate_limited") {
              console.log("[BG/LIKER] rate limited");
              const data = await chrome.storage.local.get(["af_state"]);
              const st = data.af_state || {};
              const now2 = Date.now();
              if (st.stage === 0) {
                const pausedUntil = now2 + 20 * 60 * 1000;
                await chrome.storage.local.set({
                  af_state: { ...st, pausedUntil, stage: 1, consecutiveFails: 0 },
                });
                chrome.alarms.create("autoFollowResume", { when: pausedUntil });
              } else if (st.stage === 1) {
                const pausedUntil = now2 + 30 * 60 * 1000;
                await chrome.storage.local.set({
                  af_state: { ...st, pausedUntil, stage: 2, consecutiveFails: 0 },
                });
                chrome.alarms.create("autoFollowResume", { when: pausedUntil });
              } else {
                await chrome.storage.local.set({
                  af_state: { running: false, pausedUntil: 0, consecutiveFails: 0, stage: st.stage || 2 },
                });
                chrome.alarms.clear("autoFollowResume");
              }
            }
            return sendResponse(result);
          } catch (e) {
            console.error("[BG/LIKER] error", e);
            return sendResponse({ type: "LIKE_SKIP", reason: "open_failed" });
          } finally {
            if (tab?.id) chrome.tabs.remove(tab.id);
          }
        } else if (
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

