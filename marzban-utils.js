// marzban-utils.js
// Утилиты для VPN API: Remnawave (новый) и/или Marzban API (основной и резервный сервер)

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const MARZBAN_API_URL = process.env.MARZBAN_API_URL;
// Сервер 2 (rus2) больше не выдаём для новых подписок.
// Старые subscriptionUrl2 в БД остаются и могут отображаться, но новые не формируем.
// Если когда-либо понадобится вернуть — выставить ENABLE_SERVER2=true и заполнить MARZBAN_API_URL_2.
const ENABLE_SERVER2 = String(process.env.ENABLE_SERVER2 || "").toLowerCase() === "true";
const MARZBAN_API_URL_2 = process.env.MARZBAN_API_URL_2 || "";
const MARZBAN_TOKEN = process.env.MARZBAN_TOKEN;
const MARZBAN_TOKEN_2 = process.env.MARZBAN_TOKEN_2 || process.env.MARZBAN_TOKEN;

const REMNAWAVE_API_URL = (process.env.REMNAWAVE_API_URL || "").replace(/\/$/, "");
// В .env бывает два варианта имени ключа (в доке remnawave-api это API_ACCESS_KEY).
const REMNAWAVE_API_KEY = process.env.REMNAWAVE_API_KEY || process.env.API_ACCESS_KEY || "";
const REMNAWAVE_SUBSCRIPTION_TYPE = process.env.REMNAWAVE_SUBSCRIPTION_TYPE || "russia";
const REMNAWAVE_DEVICE_LIMIT_RAW = process.env.REMNAWAVE_DEVICE_LIMIT;

function useRemnawavePrimary() {
  return Boolean(REMNAWAVE_API_URL && REMNAWAVE_API_KEY);
}

function remnawaveHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-key": REMNAWAVE_API_KEY,
  };
}

/** Дней подписки из Unix expire (как в Marzban payload) */
function daysFromExpireUnix(expireUnixSeconds) {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(1, Math.ceil((expireUnixSeconds - now) / 86400));
}

/** Панель Remnawave кладёт поля в user.response (subscriptionUrl, uuid, …) */
function remnawaveUserPayload(userNode) {
  if (!userNode || typeof userNode !== "object") return null;
  return userNode.response && typeof userNode.response === "object" ? userNode.response : userNode;
}

/**
 * Вытащить ссылку подписки из ответа Remnawave (разные форматы user)
 */
function pickUuidFromRemnawaveBody(body) {
  const u = body && typeof body === "object" ? body.user : null;
  const inner = remnawaveUserPayload(u);
  return inner && typeof inner.uuid === "string" ? inner.uuid : null;
}

function pickSubscriptionUrlFromRemnawaveBody(body) {
  const u = body && typeof body === "object" ? body.user : null;
  const inner = remnawaveUserPayload(u);
  if (!inner) return null;
  const direct =
    inner.subscription_url ||
    inner.subscriptionUrl ||
    inner.shortUrl ||
    inner.subscribeUrl ||
    inner.link ||
    inner.url ||
    null;
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (Array.isArray(inner.links)) {
    for (const l of inner.links) {
      if (typeof l === "string" && /^https?:\/\//i.test(l)) return l;
      if (l && typeof l === "object") {
        const s = l.url || l.href || l.link;
        if (typeof s === "string" && /^https?:\/\//i.test(s)) return s;
      }
    }
  }
  return findUrlWithSubPath(inner, 0);
}

/** Fallback: GET по username (на части деплоев lookup может не работать) */
async function remnawaveResolveUuidByUsername(username) {
  const u = String(username || "").trim();
  if (!u) return null;
  const url = `${REMNAWAVE_API_URL}/v1/users/${encodeURIComponent(u)}`;
  let lastText = "";
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await fetch(url, { headers: { "x-api-key": REMNAWAVE_API_KEY } });
    lastText = await r.text();
    let json;
    try {
      json = lastText ? JSON.parse(lastText) : {};
    } catch {
      json = {};
    }
    if (r.ok && json.user) return pickUuidFromRemnawaveBody(json);

    const maybeSyncDelay = r.status === 404 && lastText.includes("Not found") && attempt < maxAttempts;
    if (maybeSyncDelay) {
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    return null;
  }
  return null;
}

function findUrlWithSubPath(obj, depth) {
  if (!obj || depth > 6) return null;
  if (typeof obj === "string" && /^https?:\/\//i.test(obj) && obj.includes("/sub/")) return obj;
  if (typeof obj !== "object") return null;
  for (const v of Object.values(obj)) {
    const x = findUrlWithSubPath(v, depth + 1);
    if (x) return x;
  }
  return null;
}

function remnawaveDeviceLimit() {
  if (REMNAWAVE_DEVICE_LIMIT_RAW === undefined || REMNAWAVE_DEVICE_LIMIT_RAW === "") return undefined;
  const n = Number(REMNAWAVE_DEVICE_LIMIT_RAW);
  if (Number.isNaN(n)) return undefined;
  return n;
}

/**
 * Создать пользователя через Remnawave HTTP API (POST /v1/users)
 * @returns {Promise<{ subscriptionUrl: string | null, uuid: string | null }>}
 */
async function createUserOnRemnawave(userData) {
  const empty = { subscriptionUrl: null, uuid: null };
  try {
    const days = daysFromExpireUnix(userData.expire);
    const payload = {
      username: userData.username,
      days,
      gb: 0,
      subscriptionType: REMNAWAVE_SUBSCRIPTION_TYPE,
    };
    const dl = remnawaveDeviceLimit();
    if (dl !== undefined) payload.deviceLimit = dl;

    console.log(`[Remnawave] Creating user ${userData.username} (${days} d) at ${REMNAWAVE_API_URL}/v1/users`);

    const response = await fetch(`${REMNAWAVE_API_URL}/v1/users`, {
      method: "POST",
      headers: remnawaveHeaders(),
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }

    if (!response.ok) {
      console.error(`[Remnawave] Failed to create user:`, response.status, text);
      return empty;
    }

    const subscriptionUrl = pickSubscriptionUrlFromRemnawaveBody(json);
    const uuid = pickUuidFromRemnawaveBody(json);
    if (!subscriptionUrl) {
      console.warn("[Remnawave] User created but subscription URL not found in response:", text.slice(0, 500));
    } else {
      console.log(`[Remnawave] User created, subscription URL OK`);
    }
    if (!uuid) {
      console.warn("[Remnawave] User created but uuid not in response — продление может не сработать");
    }
    return { subscriptionUrl: subscriptionUrl || null, uuid: uuid || null };
  } catch (error) {
    console.error(`[Remnawave] Error creating user:`, error);
    return empty;
  }
}

/**
 * Продлить через Remnawave (PATCH /v1/users/:uuid/extend)
 * @param {object} [opts]
 * @param {string|null} [opts.remnawaveUuid] — из БД после создания (предпочтительно)
 */
async function extendRemnawaveUser(username, days, opts = {}) {
  try {
    let uuid = opts.remnawaveUuid || null;
    if (!uuid) {
      uuid = await remnawaveResolveUuidByUsername(username);
    }
    if (!uuid) {
      console.error(`[Remnawave] Cannot resolve uuid for username ${username} (передайте remnawaveUuid из Subscription)`);
      return false;
    }
    const url = `${REMNAWAVE_API_URL}/v1/users/${encodeURIComponent(uuid)}/extend`;
    const body = JSON.stringify({ days: Number(days) });
    let lastText = "";
    const maxAttempts = 18;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await fetch(url, {
        method: "PATCH",
        headers: remnawaveHeaders(),
        body,
      });
      lastText = await response.text();
      if (response.ok) {
        console.log(`[Remnawave] User ${username} extended by ${days} days`);
        return true;
      }
      const maybeSyncDelay =
        response.status === 404 && lastText.includes("User not found") && attempt < maxAttempts;
      if (maybeSyncDelay) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      console.error(`[Remnawave] Failed to extend user ${username} (${uuid}):`, response.status, lastText);
      return false;
    }
    console.error(`[Remnawave] Failed to extend user ${username} (${uuid}) after retries:`, lastText);
    return false;
  } catch (error) {
    console.error(`[Remnawave] Error extending user ${username}:`, error);
    return false;
  }
}

async function remnawaveGetUser(idOrUsername) {
  const id = String(idOrUsername || "").trim();
  if (!id) return null;
  if (!useRemnawavePrimary()) throw new Error("Remnawave not configured");
  const url = `${REMNAWAVE_API_URL}/v1/users/${encodeURIComponent(id)}`;

  let lastText = "";
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await fetch(url, { headers: { "x-api-key": REMNAWAVE_API_KEY } });
    lastText = await r.text();
    let json;
    try {
      json = lastText ? JSON.parse(lastText) : {};
    } catch {
      json = {};
    }
    if (r.ok && json.user) {
      const inner = remnawaveUserPayload(json.user);
      return {
        uuid: pickUuidFromRemnawaveBody(json),
        username: typeof inner?.username === "string" ? inner.username : null,
        subscriptionUrl: pickSubscriptionUrlFromRemnawaveBody(json),
        expireAt: inner?.expireAt || inner?.expire_at || null,
        raw: json,
      };
    }

    const maybeSyncDelay = r.status === 404 && lastText.includes("Not found") && attempt < maxAttempts;
    if (maybeSyncDelay) {
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Добавить трафик пользователю (PATCH /v1/users/:id/add-traffic)
 * :id может быть uuid или username
 */
async function remnawaveAddTrafficGb(idOrUsername, gb) {
  const id = String(idOrUsername || "").trim();
  if (!id) throw new Error("idOrUsername is required");
  if (!useRemnawavePrimary()) throw new Error("Remnawave not configured");
  const n = Number(gb);
  if (!Number.isFinite(n) || n <= 0) throw new Error("gb must be > 0");

  const url = `${REMNAWAVE_API_URL}/v1/users/${encodeURIComponent(id)}/add-traffic`;
  const body = JSON.stringify({ gb: n });

  let lastText = "";
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { method: "PATCH", headers: remnawaveHeaders(), body });
    lastText = await res.text();
    if (res.ok) return true;

    const maybeSyncDelay = res.status === 404 && lastText.includes("Not found") && attempt < maxAttempts;
    if (maybeSyncDelay) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    throw new Error(`REMNAWAVE_ADD_TRAFFIC_FAILED ${res.status}: ${lastText.slice(0, 300)}`);
  }
  throw new Error(`REMNAWAVE_ADD_TRAFFIC_FAILED 404: ${lastText.slice(0, 300)}`);
}

/**
 * Создать пользователя в Remnawave с заданными days/gb.
 * Возвращает { uuid, subscriptionUrl }.
 */
async function remnawaveCreateUser({ username, days, gb = 0, subscriptionType }) {
  if (!useRemnawavePrimary()) throw new Error("Remnawave not configured");
  const u = String(username || "").trim();
  if (!u) throw new Error("username is required");
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) throw new Error("days must be > 0");
  const g = Number(gb);
  if (!Number.isFinite(g) || g < 0) throw new Error("gb must be >= 0");

  const payload = {
    username: u,
    days: Math.floor(d),
    gb: g,
    subscriptionType: subscriptionType || REMNAWAVE_SUBSCRIPTION_TYPE,
  };
  const dl = remnawaveDeviceLimit();
  if (dl !== undefined) payload.deviceLimit = dl;

  const res = await fetch(`${REMNAWAVE_API_URL}/v1/users`, {
    method: "POST",
    headers: remnawaveHeaders(),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) throw new Error(`REMNAWAVE_CREATE_FAILED ${res.status}: ${text.slice(0, 300)}`);
  return {
    uuid: pickUuidFromRemnawaveBody(json),
    subscriptionUrl: pickSubscriptionUrlFromRemnawaveBody(json),
  };
}

/**
 * Преобразует subscription_url от Marzban API в ссылку для rus2 сервера
 */
function convertToRus2Url(originalUrl) {
  if (!originalUrl) return null;

  const match = originalUrl.match(/\/sub\/(.+)$/);
  if (match) {
    const token = match[1];
    return `https://rus2.grangy.ru:8888/sub/${token}`;
  }

  return null;
}

/**
 * Создает пользователя на одном Marzban API сервере
 */
async function createUserOnMarzbanServer(apiUrl, token, userData) {
  try {
    const base = String(apiUrl || "").replace(/\/$/, "");
    console.log(`[Marzban] Creating user on ${base}`);

    const response = await fetch(`${base}/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(userData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Marzban] Failed to create user on ${base}:`, errorText);
      return null;
    }

    const result = await response.json();
    const subscriptionUrl = result.subscription_url || null;
    console.log(`[Marzban] User created successfully on ${base}`);
    return subscriptionUrl;
  } catch (error) {
    console.error(`[Marzban] Error creating user on ${apiUrl}:`, error);
    return null;
  }
}

/**
 * Создает пользователя: primary = Remnawave (если задан) или Marzban; secondary = Marzban при необходимости
 */
async function createMarzbanUserOnBothServers(userData) {
  const results = { url1: null, url2: null, remnawaveUuid: null };

  const userDataPrimary = { ...userData };
  const userDataSecondary = {
    ...userData,
    inbounds: { vless: ["VLESS TCP REALITY"] },
  };

  if (useRemnawavePrimary()) {
    const rw = await createUserOnRemnawave(userDataPrimary);
    results.url1 = rw.subscriptionUrl;
    results.remnawaveUuid = rw.uuid;
  } else if (!MARZBAN_API_URL || MARZBAN_API_URL === "your_marzban_api_url") {
    console.log("[Marzban] Primary API not configured, skipping");
    results.url1 = `https://fake-vpn.local/subscription/${userData.username}`;
  } else {
    results.url1 = await createUserOnMarzbanServer(MARZBAN_API_URL, MARZBAN_TOKEN, userDataPrimary);
  }

  // Сервер 2 больше не создаём по умолчанию
  if (ENABLE_SERVER2 && MARZBAN_API_URL_2) {
    const url2Raw = await createUserOnMarzbanServer(MARZBAN_API_URL_2, MARZBAN_TOKEN_2, userDataSecondary);
    results.url2 = convertToRus2Url(url2Raw) || url2Raw;
  } else {
    results.url2 = null;
  }

  return results;
}

/**
 * Продлевает подписку: primary = Remnawave или Marzban; secondary = Marzban
 * @param {object} [opts]
 * @param {string|null} [opts.remnawaveUuid] — для Remnawave (из Subscription.remnawaveUuid)
 */
async function extendMarzbanUserOnBothServers(username, days, opts = {}) {
  const results = { success1: false, success2: false };

  if (useRemnawavePrimary()) {
    results.success1 = await extendRemnawaveUser(username, days, opts);
  } else if (MARZBAN_API_URL && MARZBAN_API_URL !== "your_marzban_api_url") {
    try {
      const response = await fetch(`${MARZBAN_API_URL}/users/${encodeURIComponent(username)}/extend?days=${days}`, {
        method: "POST",
        headers: {
          ...(MARZBAN_TOKEN ? { Authorization: `Bearer ${MARZBAN_TOKEN}` } : {}),
        },
      });

      if (response.ok) {
        results.success1 = true;
        console.log(`[Marzban] User ${username} extended successfully on primary server`);
      } else {
        const errorText = await response.text();
        console.error(`[Marzban] Failed to extend user on primary server:`, errorText);
      }
    } catch (error) {
      console.error(`[Marzban] Error extending user on primary server:`, error);
    }
  }

  if (MARZBAN_API_URL_2) {
    try {
      const response = await fetch(
        `${MARZBAN_API_URL_2}/users/${encodeURIComponent(username)}/extend?days=${days}`,
        {
          method: "POST",
          headers: {
            ...(MARZBAN_TOKEN_2 ? { Authorization: `Bearer ${MARZBAN_TOKEN_2}` } : {}),
          },
        }
      );

      if (response.ok) {
        results.success2 = true;
        console.log(`[Marzban] User ${username} extended successfully on secondary server`);
      } else {
        const errorText = await response.text();
        console.error(`[Marzban] Failed to extend user on secondary server:`, errorText);
      }
    } catch (error) {
      console.error(`[Marzban] Error extending user on secondary server:`, error);
    }
  }

  return results;
}

/**
 * Привязать Telegram к Remnawave пользователю
 * PATCH /v1/users/:uuid/telegram
 */
async function setRemnawaveTelegram(remnawaveUuid, telegramId, username) {
  const uuid = String(remnawaveUuid || "").trim();
  if (!uuid) throw new Error("remnawaveUuid is required");
  if (!useRemnawavePrimary()) throw new Error("Remnawave not configured");

  const url = `${REMNAWAVE_API_URL}/v1/users/${encodeURIComponent(uuid)}/telegram`;
  const body = JSON.stringify({
    telegramId: Number(telegramId),
    username: username || null,
  });

  let lastText = "";
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { method: "PATCH", headers: remnawaveHeaders(), body });
    lastText = await res.text();
    if (res.ok) return lastText;

    const maybeSyncDelay = res.status === 404 && lastText.includes("Not found") && attempt < maxAttempts;
    if (maybeSyncDelay) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    throw new Error(`REMNAWAVE_TELEGRAM_FAILED ${res.status}: ${lastText.slice(0, 300)}`);
  }
  throw new Error(`REMNAWAVE_TELEGRAM_FAILED 404: ${lastText.slice(0, 300)}`);
}

/**
 * Начислить бонусный трафик.
 * ВАЖНО: endpoint должен существовать в remnawave-api. Если у вас другое имя/путь — скажи, заменю.
 * PATCH /v1/users/:uuid/traffic-bonus  { gb: number }
 */
async function addRemnawaveTrafficGb(remnawaveUuid, gb) {
  const uuid = String(remnawaveUuid || "").trim();
  if (!uuid) throw new Error("remnawaveUuid is required");
  if (!useRemnawavePrimary()) throw new Error("Remnawave not configured");
  const n = Number(gb);
  if (!Number.isFinite(n) || n <= 0) throw new Error("gb must be > 0");

  const url = `${REMNAWAVE_API_URL}/v1/users/${encodeURIComponent(uuid)}/traffic-bonus`;
  const body = JSON.stringify({ gb: n });

  let lastText = "";
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { method: "PATCH", headers: remnawaveHeaders(), body });
    lastText = await res.text();
    if (res.ok) return lastText;

    const maybeSyncDelay = res.status === 404 && lastText.includes("Not found") && attempt < maxAttempts;
    if (maybeSyncDelay) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    throw new Error(`REMNAWAVE_TRAFFIC_FAILED ${res.status}: ${lastText.slice(0, 300)}`);
  }
  throw new Error(`REMNAWAVE_TRAFFIC_FAILED 404: ${lastText.slice(0, 300)}`);
}

module.exports = {
  createMarzbanUserOnBothServers,
  createUserOnMarzbanServer,
  convertToRus2Url,
  extendMarzbanUserOnBothServers,
  remnawaveResolveUuidByUsername,
  remnawaveGetUser,
  remnawaveAddTrafficGb,
  remnawaveCreateUser,
};
