// subExpiryNotifier.js
const { prisma } = require("./db");
const { Markup } = require("telegraf");
const { formatDate, getDisplayLabel, cb } = require("./menus");

function daysDiffCeil(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function startSubExpiryNotifier(bot) {
  const CHECK_EVERY_MS = 60 * 60 * 1000; // раз в час

  setInterval(async () => {
    try {
      const now = new Date();

      // Do not include required `user` relation — prod DB can contain orphaned userId rows.
      const subs = await prisma.subscription.findMany({
        where: {
          endDate: { not: null },
          type: { not: "FREE" },
        },
        select: {
          id: true,
          userId: true,
          type: true,
          startDate: true,
          endDate: true,
          notified3Days: true,
        },
      });

      if (subs.length === 0) return;

      const userIds = [...new Set(subs.map((s) => s.userId))];
      const users =
        userIds.length === 0
          ? []
          : await prisma.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, chatId: true, telegramId: true },
            });
      const userById = new Map(users.map((u) => [u.id, u]));

      for (const s of subs) {
        const chatId = userById.get(s.userId)?.chatId;
        if (!chatId) continue;

        const end = new Date(s.endDate);
        const daysLeft = daysDiffCeil(now, end);

        // Напоминание за 3 дня до окончания
        if (daysLeft === 3 && !s.notified3Days) {
          // пробуем атомарно пометить — чтобы избежать дублей
          const upd = await prisma.subscription.updateMany({
            where: { id: s.id, notified3Days: false },
            data: { notified3Days: true },
          });
          if (upd.count === 1) {
            const text =
              `⏰ Через 3 дня заканчивается подписка (${getDisplayLabel(s)} до ${formatDate(end)}).\n` +
              `Продлите, чтобы не потерять доступ.`;
            const kb = Markup.inlineKeyboard([[cb("🔄 Продлить", `extend_choose_${s.id}`, "success")]]);
            try {
              await bot.telegram.sendMessage(chatId, text, kb);
            } catch (error) {
              // Игнорируем ошибку, если бот заблокирован пользователем
              if (
                error.response?.error_code === 403 &&
                error.response?.description?.includes("bot was blocked by the user")
              ) {
                console.warn(`[SUB NOTIFIER] Bot blocked by user ${chatId}, skipping notification`);
                continue;
              }
              console.error(`[SUB NOTIFIER] Error sending notification to ${chatId}:`, error.message);
            }
          }
        }
      }
    } catch (e) {
      console.error("[SUB NOTIFIER] tick error:", e);
    }
  }, CHECK_EVERY_MS);

  console.log("⏱️ Subscription expiry notifier started");
}

module.exports = { startSubExpiryNotifier };
