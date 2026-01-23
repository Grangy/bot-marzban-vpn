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

    const username = user?.accountName || "";
    const greeting = username ? `Привет, ${username}! 👋` : `Привет! 👋`;

    const text = `${greeting}

Видел, что ты интересовался подпиской на MaxGroot, но в итоге не оформил.
Всё ли в порядке? 🤔

Возникли технические сложности при оплате? 💳❌  
Не подошли тарифы или условия? 💰📉  
Нужна помощь с выбором или инструкцией? 📖🆘

Напиши, в чём дело — помогу разобраться за 2 минуты! ⚡

Напоминаю: 20.01.2026 в 23:59 все тарифы вырастут на 50%! ⏰💸  
Успей оформить по старой цене! 🚀

@supmaxgroot

Жду ответа! 😊`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("💳 Пополнить баланс", "balance_topup")],
      [Markup.button.callback("🛒 Купить подписку", "buy")],
      [Markup.button.callback("📖 Инструкции", "instructions")]
    ]);

    await bot.telegram.sendMessage(user.chatId, text, keyboard);
    console.log(`[NOTIFY] Timeout reminder sent to chatId=${user.chatId} for topup=${topupId}`);
  } catch (e) {
    console.error("[NOTIFY] Error sending timeout:", e);
  }
});


  // Неуспешная оплата
  bus.on("topup.failed", async ({ topupId }) => {
    try {
      const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
      if (!topup) return;

      const user = await prisma.user.findUnique({ where: { id: topup.userId } });
      if (!user?.chatId) return;

      const username = user?.accountName || "";
      const greeting = username ? `Привет, ${username}! 👋` : `Привет! 👋`;

      const text = `${greeting}

Видел, что ты интересовался подпиской на MaxGroot, но в итоге не оформил.
Всё ли в порядке? 🤔

Возникли технические сложности при оплате? 💳❌  
Не подошли тарифы или условия? 💰📉  
Нужна помощь с выбором или инструкцией? 📖🆘

Напиши, в чём дело — помогу разобраться за 2 минуты! ⚡

Напоминаю: 20.01.2026 в 23:59 все тарифы вырастут на 50%! ⏰💸  
Успей оформить по старой цене! 🚀

@supmaxgroot

Жду ответа! 😊`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("💳 Пополнить баланс", "balance_topup")],
        [Markup.button.callback("🛒 Купить подписку", "buy")],
        [Markup.button.callback("📖 Инструкции", "instructions")]
      ]);

      await bot.telegram.sendMessage(user.chatId, text, keyboard);
      console.log(`[NOTIFY] Failed reminder sent to chatId=${user.chatId} for topup=${topupId}`);
    } catch (e) {
      console.error("[NOTIFY] Error sending fail:", e);
    }
  });

  console.log("🔔 Notifier attached to payment events");
}

module.exports = { initNotifier };
