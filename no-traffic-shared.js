/**
 * Общая логика для анализа «куплено, но нет трафика»: Marzban API + разбор username.
 * Используется analyze-no-traffic.js и no-traffic-reminder.js.
 */

const MARZBAN_API_URL = process.env.MARZBAN_API_URL;
const MARZBAN_TOKEN = process.env.MARZBAN_TOKEN;

function parseTelegramIdFromUsername(username) {
  if (!username || typeof username !== "string") return null;
  const m = username.match(/^(\d+)_(?:M1|M3|M6|M12)_\d+$/);
  return m ? m[1] : null;
}

function groupMarzbanByTelegramId(users) {
  const byTg = new Map();
  for (const u of users) {
    const tgId = parseTelegramIdFromUsername(u.username);
    if (!tgId) continue;
    const used = typeof u.used_traffic === "number" ? u.used_traffic : 0;
    if (!byTg.has(tgId)) byTg.set(tgId, []);
    byTg.get(tgId).push({ username: u.username, used_traffic: used });
  }
  return byTg;
}

function telegramIdsWithNoTraffic(byTg) {
  const out = new Map();
  for (const [tgId, list] of byTg) {
    if (list.every((x) => x.used_traffic === 0)) out.set(tgId, list);
  }
  return out;
}

/**
 * Загружает всех пользователей Marzban (пагинация). Пробует /api/users и /users.
 * @returns {Promise<Array<{ username: string, used_traffic: number }>>}
 */
async function fetchMarzbanUsers() {
  const fetch = (await import("node-fetch")).default;
  const base = MARZBAN_API_URL?.replace(/\/$/, "");
  if (!base || base === "your_marzban_api_url") {
    throw new Error("MARZBAN_API_URL не задан или заглушка");
  }
  const headers = MARZBAN_TOKEN ? { Authorization: `Bearer ${MARZBAN_TOKEN}` } : {};
  const candidates = [`${base}/api/users`, `${base}/users`];
  let url = null;
  for (const u of candidates) {
    try {
      const r = await fetch(`${u}?offset=0&limit=1`, { headers });
      if (r.ok) {
        url = u;
        break;
      }
    } catch (_) {}
  }
  if (!url) {
    throw new Error("Marzban API: ни /api/users, ни /users не доступны. Проверьте MARZBAN_API_URL и MARZBAN_TOKEN.");
  }

  const all = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const res = await fetch(`${url}?offset=${offset}&limit=${limit}`, { headers });
    if (!res.ok) throw new Error(`Marzban API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const users = data.users || [];
    const total = data.total ?? users.length;
    all.push(...users);
    if (users.length < limit || all.length >= total) break;
    offset += limit;
  }
  return all;
}

module.exports = {
  parseTelegramIdFromUsername,
  groupMarzbanByTelegramId,
  telegramIdsWithNoTraffic,
  fetchMarzbanUsers,
};
