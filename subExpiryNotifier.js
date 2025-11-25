// subExpiryNotifier.js
const { prisma } = require("./db");
const { Markup } = require("telegraf");
const { formatDate, getDisplayLabel } = require("./menus");

function daysDiffCeil(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function startSubExpiryNotifier(bot) {
  const CHECK_EVERY_MS = 60 * 60 * 1000; // раз в час

  setInterval(async () => {
    const now = new Date();

    // Берём все платные подписки с датой окончания
    const subs = await prisma.subscription.findMany({
      where: {
        endDate: { not: null },
        type: { not: "FREE" },
      },
      include: {
        user: { select: { chatId: true } },
      },
    });

    for (const s of subs) {
      const chatId = s.user?.chatId;
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
          const kb = Markup.inlineKeyboard([
            [Markup.button.callback("🔄 Продлить", `extend_choose_${s.id}`)],
          ]);
          await bot.telegram.sendMessage(chatId, text, kb);
        }
      }
    }
  }, CHECK_EVERY_MS);

  console.log("⏱️ Subscription expiry notifier started");
}

module.exports = { startSubExpiryNotifier };
