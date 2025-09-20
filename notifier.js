// notifier.js
const bus = require("./events");
const { prisma } = require("./db");
const { ruMoney } = require("./menus");

/**
 * Подключает слушателей к событиям оплаты и шлёт сообщения пользователю.
 * Важно: сюда передаём bot снаружи (никаких require('./bot') ➜ нет циклов).
 */
function initNotifier(bot) {
  // Успешная оплата
  bus.on("topup.success", async ({ topupId }) => {
    try {
      const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
      if (!topup) return;

      const user = await prisma.user.findUnique({ where: { id: topup.userId } });
      if (!user?.chatId) {
        console.warn(`[NOTIFY] No chatId for user ${user?.id}`);
        return;
      }

      const text =
        `✅ Оплата подтверждена!\n` +
        `Сумма: ${ruMoney(topup.amount)}\n` +
        `Новый баланс: ${ruMoney(user.balance)}`;

      await bot.telegram.sendMessage(user.chatId, text);
      console.log(`[NOTIFY] Success sent to chatId=${user.chatId} for topup=${topupId}`);
    } catch (e) {
      console.error("[NOTIFY] Error sending success:", e);
    }
  });

  // Неуспешная оплата (опционально — полезно иметь)
  bus.on("topup.failed", async ({ topupId }) => {
    try {
      const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
      if (!topup) return;

      const user = await prisma.user.findUnique({ where: { id: topup.userId } });
      if (!user?.chatId) return;

      const text =
        `❌ Оплата не прошла.\n` +
        `Сумма: ${ruMoney(topup.amount)}\n` +
        `Если это ошибка — попробуйте ещё раз.`;

      await bot.telegram.sendMessage(user.chatId, text);
      console.log(`[NOTIFY] Fail sent to chatId=${user.chatId} for topup=${topupId}`);
    } catch (e) {
      console.error("[NOTIFY] Error sending fail:", e);
    }
  });

  console.log("🔔 Notifier attached to payment events");
}

module.exports = { initNotifier };
