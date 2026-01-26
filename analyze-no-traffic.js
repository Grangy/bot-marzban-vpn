#!/usr/bin/env node
/**
 * Анализ: пользователи, которые купили платную подписку (M1/M3/M6/M12),
 * но у которых в Marzban нет трафика (used_traffic === 0).
 *
 * Идентификация: telegram ID. Подписки в Marzban имеют вид username = "683203214_M1_1323",
 * первая часть — telegram ID.
 *
 * Использование: node analyze-no-traffic.js
 * Запускать на сервере (где доступен Marzban API). Пока только анализ и подсчёт, без рассылки.
 */

require("dotenv").config();
const { prisma } = require("./db");

const MARZBAN_API_URL = process.env.MARZBAN_API_URL;
const MARZBAN_TOKEN = process.env.MARZBAN_TOKEN;

/** Извлекает telegram ID из username Marzban (формат: 683203214_M1_1323). */
function parseTelegramIdFromUsername(username) {
  if (!username || typeof username !== "string") return null;
  const m = username.match(/^(\d+)_(?:M1|M3|M6|M12)_\d+$/);
  return m ? m[1] : null;
}

/** Загружает всех пользователей Marzban (с пагинацией). */
async function fetchMarzbanUsers(fetch) {
  const base = MARZBAN_API_URL?.replace(/\/$/, "");
  if (!base || base === "your_marzban_api_url") {
    throw new Error("MARZBAN_API_URL не задан или задан заглушкой");
  }

  const headers = MARZBAN_TOKEN ? { Authorization: `Bearer ${MARZBAN_TOKEN}` } : {};
  const candidates = [`${base}/api/users`, `${base}/users`];
  let url = null;
  for (const u of candidates) {
    const r = await fetch(`${u}?offset=0&limit=1`, { headers });
    if (r.ok) {
      url = u;
      break;
    }
  }
  if (!url) {
    throw new Error("Marzban API: ни /api/users, ни /users не вернули 200. Проверьте MARZBAN_API_URL и MARZBAN_TOKEN.");
  }

  const all = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const res = await fetch(`${url}?offset=${offset}&limit=${limit}`, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Marzban API ${res.status}: ${text}`);
    }
    const data = await res.json();
    const users = data.users || [];
    const total = data.total ?? users.length;
    all.push(...users);
    if (users.length < limit || all.length >= total) break;
    offset += limit;
  }

  return all;
}

/**
 * Группирует пользователей Marzban по telegram ID.
 * Возвращает Map<telegramId, [{ username, used_traffic }]>.
 * Только пользователи с форматом username = telegramId_M1|M3|M6|M12_subId.
 */
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

/** Telegram ID считаем "без трафика", если у всех его Marzban-пользователей used_traffic === 0. */
function telegramIdsWithNoTraffic(byTg) {
  const out = new Map(); // telegramId -> [ { username, used_traffic } ]

  for (const [tgId, list] of byTg) {
    const allZero = list.every((x) => x.used_traffic === 0);
    if (allZero) out.set(tgId, list);
  }

  return out;
}

async function main() {
  const fetch = (await import("node-fetch")).default;

  console.log("=== Анализ: купили платную подписку, трафика в Marzban нет ===\n");

  console.log("1. Загрузка пользователей Marzban...");
  const marzbanUsers = await fetchMarzbanUsers(fetch);
  console.log(`   Загружено пользователей Marzban: ${marzbanUsers.length}`);

  const byTg = groupMarzbanByTelegramId(marzbanUsers);
  const noTraffic = telegramIdsWithNoTraffic(byTg);
  console.log(`   Из них с форматом telegramId_M*_*: ${byTg.size} уникальных telegram ID`);
  console.log(`   Из них без трафика (все подписки 0): ${noTraffic.size}`);

  console.log("\n2. Пользователи из БД с платной подпиской (M1, M3, M6, M12)...");
  const paidUsers = await prisma.user.findMany({
    where: {
      subscriptions: {
        some: { type: { in: ["M1", "M3", "M6", "M12"] } },
      },
    },
    select: { id: true, telegramId: true, chatId: true, accountName: true },
  });
  console.log(`   Найдено пользователей с платной подпиской: ${paidUsers.length}`);

  const paidByTg = new Map(paidUsers.map((u) => [u.telegramId, u]));

  console.log("\n3. Сопоставление: купили подписку И в Marzban нет трафика...");
  const matched = [];
  for (const [tgId, marzList] of noTraffic) {
    const user = paidByTg.get(tgId);
    if (!user) continue;
    matched.push({
      telegramId: user.telegramId,
      chatId: user.chatId,
      accountName: user.accountName || null,
      marzbanUsernames: marzList.map((x) => x.username),
    });
  }

  console.log(`   Таких пользователей: ${matched.length}`);

  if (matched.length === 0) {
    console.log("\nСписок пуст.");
    return;
  }

  console.log("\n--- Список (telegram ID | chatId | accountName | Marzban usernames) ---\n");
  for (const r of matched) {
    const names = r.marzbanUsernames.join(", ");
    console.log(`  ${r.telegramId} | ${r.chatId} | ${r.accountName || "-"} | ${names}`);
  }

  console.log("\n--- Итог ---");
  console.log(`Всего пользователей для возможной рассылки: ${matched.length}`);
  console.log("Рассылка в скрипте не выполняется.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
