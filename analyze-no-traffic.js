#!/usr/bin/env node
/**
 * Анализ: пользователи, которые купили платную подписку (M1/M3/M6/M12),
 * но у которых в Marzban нет трафика (used_traffic === 0).
 *
 * Идентификация: telegram ID. Подписки в Marzban имеют вид username = "683203214_M1_1323",
 * первая часть — telegram ID.
 *
 * Использование:
 *   node analyze-no-traffic.js        — только анализ, без рассылки
 *   node analyze-no-traffic.js --send — анализ + рассылка сообщения
 * Запускать на сервере (доступен Marzban API и BOT_TOKEN).
 */

require("dotenv").config();
const { Telegraf } = require("telegraf");
const { prisma } = require("./db");
const {
  fetchMarzbanUsers,
  groupMarzbanByTelegramId,
  telegramIdsWithNoTraffic,
} = require("./no-traffic-shared");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DRY_RUN = !process.argv.includes("--send");

const BROADCAST_MESSAGE = `Доброго времени суток! Видим что вы приобрели подписку но не подключились. Возникли технические сложности ? Что то не работает? Мы всегда вам поможем @supmaxgroot`;

async function main() {
  console.log("=== Анализ: купили платную подписку, трафика в Marzban нет ===\n");

  console.log("1. Загрузка пользователей Marzban...");
  const marzbanUsers = await fetchMarzbanUsers();
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
    select: { id: true, telegramId: true, chatId: true, accountName: true, noTrafficReminderSentAt: true },
  });
  console.log(`   Найдено пользователей с платной подпиской: ${paidUsers.length}`);

  const paidByTg = new Map(paidUsers.map((u) => [u.telegramId, u]));

  console.log("\n3. Сопоставление: купили подписку И в Marzban нет трафика...");
  const matched = [];
  for (const [tgId, marzList] of noTraffic) {
    const user = paidByTg.get(tgId);
    if (!user) continue;
    matched.push({
      id: user.id,
      telegramId: user.telegramId,
      chatId: user.chatId,
      accountName: user.accountName || null,
      marzbanUsernames: marzList.map((x) => x.username),
    });
  }
  const alreadySent = matched.filter((r) => paidByTg.get(r.telegramId)?.noTrafficReminderSentAt);
  if (alreadySent.length) {
    console.log(`   Из них уже получили напоминание (триггер/рассылка): ${alreadySent.length}`);
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

  const forSend = DRY_RUN ? matched : matched.filter((r) => !paidByTg.get(r.telegramId)?.noTrafficReminderSentAt);
  console.log("\n--- Итог ---");
  console.log(`Всего в выборке: ${matched.length}. К рассылке (ещё не получали): ${forSend.length}`);

  if (DRY_RUN) {
    console.log("\n🔍 Режим предпросмотра. Для рассылки запустите с флагом --send:");
    console.log("   node analyze-no-traffic.js --send");
    return;
  }

  if (forSend.length === 0) {
    console.log("\nНет получателей для рассылки (всем уже отправлено).");
    return;
  }

  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN не задан. Рассылка невозможна.");
  }

  console.log("\n📝 Текст рассылки:");
  console.log("-".repeat(50));
  console.log(BROADCAST_MESSAGE);
  console.log("-".repeat(50));
  console.log("\n⚠️  Будет отправлено сообщений:", forSend.length);
  console.log("Для отмены нажмите Ctrl+C. Через 5 секунд начнётся отправка...\n");
  await new Promise((r) => setTimeout(r, 5000));

  const bot = new Telegraf(BOT_TOKEN);
  await bot.telegram.getMe();
  console.log("✅ Бот инициализирован\n");

  const results = { total: forSend.length, sent: 0, failed: 0, errors: [] };

  for (let i = 0; i < forSend.length; i++) {
    const r = forSend[i];
    try {
      await bot.telegram.sendMessage(r.chatId, BROADCAST_MESSAGE);
      await prisma.user.update({ where: { id: r.id }, data: { noTrafficReminderSentAt: new Date() } });
      results.sent++;
      console.log(`✅ [${i + 1}/${forSend.length}] ${r.accountName || r.telegramId} (${r.chatId})`);
    } catch (e) {
      results.failed++;
      const code = e.response?.error_code ?? "?";
      results.errors.push({ telegramId: r.telegramId, chatId: r.chatId, error: code, msg: e.message });
      console.log(`❌ [${i + 1}/${forSend.length}] ${r.accountName || r.telegramId}: ${code}`);
    }
    if (i < forSend.length - 1) await new Promise((r) => setTimeout(r, 50));
  }

  console.log("\n--- Итоги рассылки ---");
  console.log(`Всего: ${results.total} | Отправлено: ${results.sent} | Ошибок: ${results.failed}`);
  if (results.errors.length) {
    results.errors.forEach((err) => console.log(`   • ${err.telegramId}: ${err.error} ${err.msg}`));
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
