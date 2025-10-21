// notifier.js
const bus = require("./events");
const { prisma } = require("./db");
const { ruMoney, instructionsMenu, paymentSuccessMenu } = require("./menus");
const { Markup } = require("telegraf");

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

      await bot.telegram.sendMessage(user.chatId, text, paymentSuccessMenu());
      console.log(`[NOTIFY] Success sent to chatId=${user.chatId} for topup=${topupId}`);
    } catch (e) {
      console.error("[NOTIFY] Error sending success:", e);
    }
  });

// Автоистечение (TIMEOUT)
bus.on("topup.timeout", async ({ topupId }) => {
  try {
    const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
    if (!topup) return;

    const user = await prisma.user.findUnique({ where: { id: topup.userId } });
    if (!user?.chatId) return;

    const text =
      `⏳ Счёт на ${ruMoney(topup.amount)} истёк (не оплачен в течение 30 минут).\n\n` +
      `💡 Создайте новый запрос на пополнение или обратитесь в поддержку: @grangym`;

    await bot.telegram.sendMessage(user.chatId, text);
    console.log(`[NOTIFY] Timeout sent to chatId=${user.chatId} for topup=${topupId}`);
  } catch (e) {
    console.error("[NOTIFY] Error sending timeout:", e);
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
        `❌ Оплата отменена или не завершена.\n` +
        `Сумма: ${ruMoney(topup.amount)}\n\n` +
        `💡 Возможные причины:\n` +
        `• Не завершили оплату в приложении банка\n` +
        `• Отменили операцию\n` +
        `• Истекло время ожидания\n\n` +
        `🔄 Попробуйте создать новый счёт или обратитесь в поддержку: @grangym`;

      await bot.telegram.sendMessage(user.chatId, text);
      console.log(`[NOTIFY] Fail sent to chatId=${user.chatId} for topup=${topupId}`);
    } catch (e) {
      console.error("[NOTIFY] Error sending fail:", e);
    }
  });

  console.log("🔔 Notifier attached to payment events");
}

module.exports = { initNotifier };
