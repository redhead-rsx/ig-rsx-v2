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

