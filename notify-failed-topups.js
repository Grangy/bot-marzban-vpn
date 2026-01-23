#!/usr/bin/env node
// Скрипт для уведомления пользователей с неудачными пополнениями за последний час
// Использование: node notify-failed-topups.js [--send]

require("dotenv").config();
const { Telegraf } = require("telegraf");
const { prisma } = require("./db");
const { Markup } = require("telegraf");

const DRY_RUN = !process.argv.includes("--send");

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// Сообщение для отправки
const MESSAGE = `✅ Платежная система снова работает!

Мы исправили проблему, и теперь вы можете пополнить баланс.

💳 Попробуйте снова:
• Нажмите «💼 Баланс» в меню
• Выберите «➕ Пополнить»
• Выберите нужную сумму

Если возникнут вопросы — обращайтесь в поддержку: @supmaxgroot`;

async function main() {
  try {
    console.log("🔍 Поиск пользователей с неудачными пополнениями за последний час...\n");

    // Время: последний час
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const now = new Date();

    // Находим все пополнения за последний час со статусом FAILED или TIMEOUT
    const failedTopups = await prisma.topUp.findMany({
      where: {
        status: {
          in: ["FAILED", "TIMEOUT"]
        },
        createdAt: {
          gte: oneHourAgo,
          lte: now
        }
      },
      include: {
        user: {
          select: {
            id: true,
            telegramId: true,
            chatId: true,
            accountName: true
          }
        }
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    if (failedTopups.length === 0) {
      console.log("✅ Не найдено пополнений с ошибками за последний час.");
      return;
    }

    console.log(`📊 Найдено пополнений с ошибками: ${failedTopups.length}\n`);

    // Получаем уникальных пользователей (только из ЛС: chatId === telegramId)
    const uniqueUsers = new Map();
    const topupsByUser = new Map();

    for (const topup of failedTopups) {
      const user = topup.user;
      // Только пользователи из личных сообщений
      if (user && user.chatId === String(user.telegramId)) {
        if (!uniqueUsers.has(user.id)) {
          uniqueUsers.set(user.id, user);
          topupsByUser.set(user.id, []);
        }
        topupsByUser.get(user.id).push(topup);
      }
    }

    const users = Array.from(uniqueUsers.values());

    if (users.length === 0) {
      console.log("⚠️  Не найдено пользователей из личных сообщений с ошибками пополнения.");
      return;
    }

    // Показываем список пользователей
    console.log("=".repeat(60));
    console.log(`📋 СПИСОК ПОЛЬЗОВАТЕЛЕЙ ДЛЯ УВЕДОМЛЕНИЯ (${users.length}):`);
    console.log("=".repeat(60));

    users.forEach((user, index) => {
      const topups = topupsByUser.get(user.id);
      const lastTopup = topups[0]; // Самый последний
      const status = lastTopup.status === "FAILED" ? "❌ Ошибка" : "⏱️ Таймаут";
      const amount = lastTopup.amount;
      const time = new Date(lastTopup.createdAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });

      console.log(`${index + 1}. ${user.accountName || `ID: ${user.telegramId}`}`);
      console.log(`   Telegram ID: ${user.telegramId}`);
      console.log(`   Последняя попытка: ${status}, ${amount} ₽, ${time}`);
      console.log(`   Всего попыток: ${topups.length}`);
      console.log("");
    });

    console.log("=".repeat(60));
    console.log(`📝 Текст сообщения:`);
    console.log("-".repeat(60));
    console.log(MESSAGE);
    console.log("-".repeat(60));
    console.log("");

    if (DRY_RUN) {
      console.log("🔍 РЕЖИМ ПРЕДПРОСМОТРА (dry-run)");
      console.log("Для отправки сообщений запустите скрипт с флагом --send:");
      console.log("   node notify-failed-topups.js --send\n");
      return;
    }

    // Запрашиваем подтверждение
    console.log("⚠️  ВНИМАНИЕ: Будет отправлено сообщений: " + users.length);
    console.log("Для продолжения нажмите Ctrl+C для отмены или подождите 5 секунд...\n");
    
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log("🚀 Начинаем отправку сообщений...\n");

    // Запускаем бота (только для отправки сообщений)
    await bot.telegram.getMe();
    console.log("✅ Бот инициализирован\n");

    const results = {
      total: users.length,
      sent: 0,
      failed: 0,
      errors: []
    };

    // Отправляем сообщения
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const topups = topupsByUser.get(user.id);
      
      try {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("💼 Баланс", "balance"), Markup.button.callback("💳 Пополнить", "balance_topup")]
        ]);

        await bot.telegram.sendMessage(user.chatId, MESSAGE, {
          parse_mode: "HTML",
          reply_markup: keyboard.reply_markup
        });

        results.sent++;
        console.log(`✅ [${i + 1}/${users.length}] Отправлено: ${user.accountName || user.telegramId}`);

        // Задержка между сообщениями (50мс)
        if (i < users.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (error) {
        results.failed++;
        const errorCode = error.response?.errorCode || "UNKNOWN";
        results.errors.push({
          telegramId: user.telegramId,
          username: user.accountName,
          error: errorCode,
          message: error.message
        });
        console.log(`❌ [${i + 1}/${users.length}] Ошибка для ${user.accountName || user.telegramId}: ${errorCode}`);
      }
    }

    // Итоговая статистика
    console.log("\n" + "=".repeat(60));
    console.log("📊 ИТОГИ РАССЫЛКИ:");
    console.log("=".repeat(60));
    console.log(`Всего пользователей: ${results.total}`);
    console.log(`✅ Отправлено: ${results.sent}`);
    console.log(`❌ Ошибок: ${results.failed}`);

    if (results.errors.length > 0) {
      console.log("\n❌ Ошибки:");
      results.errors.forEach(err => {
        console.log(`   • ${err.username || err.telegramId}: ${err.error} - ${err.message}`);
      });
    }

    console.log("=".repeat(60));

  } catch (error) {
    console.error("❌ Критическая ошибка:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

main();
