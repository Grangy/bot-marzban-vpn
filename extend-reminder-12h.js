/**
 * Триггер: через 12 часов после привязки FREE/trial подписки
 * отправляем напоминание о продлении (кнопка "Продлить") и помечаем в БД.
 */
const { prisma } = require("./db");
const { Markup } = require("telegraf");
const { cb } = require("./menus");

const CHECK_EVERY_MS = 15 * 60 * 1000; // каждые 15 минут
const HOURS_AFTER_BIND = 12;

function startExtendReminder12h(bot) {
  const run = async () => {
    try {
      const threshold = new Date(Date.now() - HOURS_AFTER_BIND * 60 * 60 * 1000);

      const subs = await prisma.subscription.findMany({
        where: {
          type: "FREE",
          endDate: { not: null },
          startDate: { lte: threshold },
          remindExtend12hSentAt: null,
        },
        // Don't include required relation: orphaned userId rows exist in prod DB.
        // We'll batch-load users separately and gracefully handle missing users.
        select: { id: true, userId: true },
        orderBy: { startDate: "asc" },
        take: 200,
      });

      if (subs.length === 0) return;

      const userIds = [...new Set(subs.map((s) => s.userId))];
      const users =
        userIds.length === 0
          ? []
          : await prisma.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, chatId: true },
            });
      const byId = new Map(users.map((u) => [u.id, u]));

      for (const s of subs) {
        const chatId = byId.get(s.userId)?.chatId;
        if (!chatId) {
          await prisma.subscription.update({
            where: { id: s.id },
            data: { remindExtend12hSentAt: new Date() },
          });
          continue;
        }

        // атомарно помечаем, чтобы не было дублей при параллельных тиках
        const upd = await prisma.subscription.updateMany({
          where: { id: s.id, remindExtend12hSentAt: null },
          data: { remindExtend12hSentAt: new Date() },
        });
        if (upd.count !== 1) continue;

        const text =
          "⏰ Напоминание: ваша пробная подписка скоро закончится.\n\n" +
          "Хотите продлить доступ? Нажмите «Продлить».\n\n" +
          "📦 Все ваши подписки — в разделе «Мои подписки».";
        const kb = Markup.inlineKeyboard([[cb("🔄 Продлить", `extend_choose_${s.id}`, "success")]]);
        try {
          await bot.telegram.sendMessage(chatId, text, kb);
        } catch (e) {
          const blocked =
            e.response?.error_code === 403 && e.response?.description?.includes("bot was blocked by the user");
          if (!blocked) {
            console.error(`[EXTEND 12H] Send error for ${chatId}:`, e.message);
          }
        }

        await new Promise((r) => setTimeout(r, 50));
      }
    } catch (err) {
      console.error("[EXTEND 12H] Run error:", err);
    }
  };

  const t = setInterval(run, CHECK_EVERY_MS);
  run();
  console.log(
    `[EXTEND 12H] Started (every ${CHECK_EVERY_MS / 60_000} min, ${HOURS_AFTER_BIND}h after bind)`
  );
  return () => clearInterval(t);
}

module.exports = { startExtendReminder12h };

