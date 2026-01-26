/**
 * Триггер: через 2 часа после покупки платной подписки, если в Marzban нет трафика,
 * отправляем сообщение «купили, но не подключились» и помечаем пользователя.
 * Запускается автоматически вместе с ботом (setInterval).
 */

const { prisma } = require("./db");
const {
  fetchMarzbanUsers,
  groupMarzbanByTelegramId,
  telegramIdsWithNoTraffic,
} = require("./no-traffic-shared");

const REMINDER_MESSAGE = `Доброго времени суток! Видим что вы приобрели подписку но не подключились. Возникли технические сложности ? Что то не работает? Мы всегда вам поможем @supmaxgroot`;

const CHECK_EVERY_MS = 15 * 60 * 1000; // каждые 15 минут
const HOURS_AFTER_PURCHASE = 2;

function startNoTrafficReminder(bot) {
  const run = async () => {
    try {
      const twoHoursAgo = new Date(Date.now() - HOURS_AFTER_PURCHASE * 60 * 60 * 1000);

      const paidNoReminder = await prisma.user.findMany({
        where: {
          noTrafficReminderSentAt: null,
          subscriptions: {
            some: {
              type: { in: ["M1", "M3", "M6", "M12"] },
              startDate: { lte: twoHoursAgo },
            },
          },
        },
        select: { id: true, telegramId: true, chatId: true, accountName: true },
      });

      if (paidNoReminder.length === 0) return;

      let marzbanUsers;
      try {
        marzbanUsers = await fetchMarzbanUsers();
      } catch (e) {
        console.warn("[NO-TRAFFIC REMINDER] Marzban fetch failed:", e.message);
        return;
      }

      const byTg = groupMarzbanByTelegramId(marzbanUsers);
      const noTraffic = telegramIdsWithNoTraffic(byTg);
      const paidByTg = new Map(paidNoReminder.map((u) => [u.telegramId, u]));

      const toSend = [];
      for (const [tgId] of noTraffic) {
        const u = paidByTg.get(tgId);
        if (u) toSend.push(u);
      }

      for (const u of toSend) {
        try {
          await bot.telegram.sendMessage(u.chatId, REMINDER_MESSAGE);
          await prisma.user.update({
            where: { id: u.id },
            data: { noTrafficReminderSentAt: new Date() },
          });
          console.log(`[NO-TRAFFIC REMINDER] Sent to ${u.accountName || u.telegramId} (${u.chatId})`);
        } catch (e) {
          const blocked = e.response?.error_code === 403 && e.response?.description?.includes("bot was blocked by the user");
          if (blocked) {
            console.warn(`[NO-TRAFFIC REMINDER] Blocked by user ${u.chatId}, marking sent`);
            try {
              await prisma.user.update({
                where: { id: u.id },
                data: { noTrafficReminderSentAt: new Date() },
              });
            } catch (_) {}
          } else {
            console.error(`[NO-TRAFFIC REMINDER] Send error for ${u.chatId}:`, e.message);
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    } catch (err) {
      console.error("[NO-TRAFFIC REMINDER] Run error:", err);
    }
  };

  const t = setInterval(run, CHECK_EVERY_MS);
  run();
  console.log(`[NO-TRAFFIC REMINDER] Started (every ${CHECK_EVERY_MS / 60_000} min, ${HOURS_AFTER_PURCHASE}h after purchase)`);
  return () => clearInterval(t);
}

module.exports = { startNoTrafficReminder };
