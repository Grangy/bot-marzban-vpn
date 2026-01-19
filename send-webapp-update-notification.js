// send-webapp-update-notification.js
// Скрипт для рассылки уведомлений о новом мини-приложении MaxGroot
require("dotenv").config();
const { Telegraf } = require("telegraf");
const { prisma } = require("./db");
const { Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не установлен в переменных окружения");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Текст сообщения
const NOTIFICATION_TEXT = `Сегодня у MaxGroot большое обновление! 🚀

🎉 Новое мини-приложение внутри чат-бота  

Теперь оформление подписки и работа с сервисом стали ещё удобнее.  

Внутри чат-бота появилось полноценное мини-приложение, где:
• можно оформить или продлить подписку в пару нажатий 💳
• есть удобные инструкции по установке на все основные устройства 📲💻

📚 Инструкции доступны для:
• iPhone (iOS) 🍏
• Android 📱
• Smart TV 📺
• macOS 🖥
• Windows 💻

Больше не нужно искать гайды по разным сообщениям — всё собрано в одном месте, прямо внутри бота!

🇷🇺 Возвращение российского сервера  
Сегодня в сервис добавлен обратно российский сервер.  
Он снова доступен, работает стабильно и готов к использованию. ✅

Нужно нажать на эту кнопку 🔄 "Обновить сервера" в приложении HUB!

🛠 Это не последнее обновление  
MaxGroot продолжает развиваться — впереди ещё много новых функций и улучшений.  

Оставайтесь с нами, следите за новостями в канале и делитесь обратной связью 🙌

🔥 Поставьте реакцию, если обновление понравилось!  
Нам важно ваше мнение 👍❤️🎉

Спасибо, что пользуетесь MaxGroot! 💙`;

async function sendWebAppUpdateNotification() {
  try {
    console.log("🔍 Поиск всех пользователей из ЛС...");

    // Находим всех пользователей из ЛС (chatId === telegramId)
    const users = await prisma.user.findMany({
      where: {
        chatId: { not: "" } // Есть chatId
      },
      select: {
        id: true,
        chatId: true,
        telegramId: true,
        accountName: true
      },
      orderBy: {
        id: "asc"
      }
    });

    // Фильтруем только пользователей из ЛС (chatId === telegramId)
    const privateChatUsers = users.filter(u => u.chatId === String(u.telegramId));

    console.log(`📊 Найдено пользователей всего: ${users.length}`);
    console.log(`📊 Пользователей из ЛС: ${privateChatUsers.length}`);

    if (privateChatUsers.length === 0) {
      console.log("✅ Нет пользователей для рассылки");
      return;
    }

    // Кнопка для открытия мини-приложения
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.webApp("📱 Открыть приложение", "https://web.grangy.ru/")]
    ]);

    let sent = 0;
    let errors = 0;
    let skipped = 0;

    for (const user of privateChatUsers) {
      try {
        const chatId = user.chatId;

        if (!chatId) {
          console.log(`⚠️  Пользователь ${user.telegramId} не имеет chatId, пропускаем`);
          skipped++;
          continue;
        }

        console.log(`📤 Отправка сообщения пользователю ${user.telegramId} (@${user.accountName || 'без username'}, chatId: ${chatId})...`);

        await bot.telegram.sendMessage(chatId, NOTIFICATION_TEXT, {
          parse_mode: "HTML",
          ...keyboard
        });

        console.log(`✅ Сообщение отправлено пользователю ${user.telegramId}`);
        sent++;

        // Небольшая задержка чтобы не превысить лимиты API Telegram (30 сообщений в секунду)
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`❌ Ошибка при отправке сообщения пользователю ${user.telegramId}:`, error.message);
        
        // Если пользователь заблокировал бота или чат не найден
        if (error.response?.errorCode === 403 || error.response?.description?.includes("chat not found")) {
          console.log(`⚠️  Пользователь заблокировал бота или чат не найден`);
        }
        
        errors++;
      }
    }

    console.log("\n📈 Итоги рассылки:");
    console.log(`   ✅ Отправлено: ${sent}`);
    console.log(`   ⚠️  Пропущено: ${skipped}`);
    console.log(`   ❌ Ошибок: ${errors}`);
    console.log(`   📊 Всего пользователей из ЛС: ${privateChatUsers.length}`);

    if (errors === 0) {
      console.log("\n✅ Рассылка завершена успешно!");
    } else {
      console.log(`\n⚠️  Рассылка завершена с ${errors} ошибками`);
    }
  } catch (error) {
    console.error("❌ Критическая ошибка при рассылке:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Функция для проверки (dry-run режим)
async function checkWebAppUpdateNotification() {
  try {
    console.log("🔍 Проверка: поиск всех пользователей из ЛС...");

    const users = await prisma.user.findMany({
      where: {
        chatId: { not: "" }
      },
      select: {
        id: true,
        chatId: true,
        telegramId: true,
        accountName: true
      },
      orderBy: {
        id: "asc"
      }
    });

    // Фильтруем только пользователей из ЛС (chatId === telegramId)
    const privateChatUsers = users.filter(u => u.chatId === String(u.telegramId));

    console.log(`📊 Найдено пользователей всего: ${users.length}`);
    console.log(`📊 Пользователей из ЛС (будут получать рассылку): ${privateChatUsers.length}\n`);

    if (privateChatUsers.length === 0) {
      console.log("✅ Нет пользователей для рассылки");
      return;
    }

    // Статистика
    const withUsername = privateChatUsers.filter(u => u.accountName).length;
    const withoutUsername = privateChatUsers.length - withUsername;

    console.log("📋 Статистика:");
    console.log(`   👥 Всего пользователей из ЛС: ${privateChatUsers.length}`);
    console.log(`   ✅ С username: ${withUsername}`);
    console.log(`   ⚠️  Без username: ${withoutUsername}`);
    console.log(`\n📝 Пример сообщения, которое будет отправлено:\n`);
    console.log(NOTIFICATION_TEXT);
    console.log(`\n📱 Кнопка "Открыть приложение" откроет: https://web.grangy.ru/`);
    console.log(`\n💡 Для отправки сообщений запустите: node send-webapp-update-notification.js send`);
    
    // Показываем первые 5 пользователей как пример
    console.log(`\n👤 Примеры получателей (первые 5):`);
    privateChatUsers.slice(0, 5).forEach((user, idx) => {
      console.log(`   ${idx + 1}. ID: ${user.id}, Telegram: ${user.telegramId}, Username: ${user.accountName || 'нет'}, Chat ID: ${user.chatId}`);
    });
    if (privateChatUsers.length > 5) {
      console.log(`   ... и ещё ${privateChatUsers.length - 5} пользователей`);
    }
  } catch (error) {
    console.error("❌ Критическая ошибка при проверке:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Запуск скрипта
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || "check";

  (async () => {
    try {
      if (command === "check") {
        await checkWebAppUpdateNotification();
        console.log("\n👋 Проверка завершена");
        process.exit(0);
      } else if (command === "send") {
        console.log("⚠️  ВНИМАНИЕ: Начинается реальная рассылка сообщений!");
        console.log("   Нажмите Ctrl+C в течение 5 секунд для отмены...\n");
        
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        await sendWebAppUpdateNotification();
        console.log("\n👋 Скрипт завершен");
        process.exit(0);
      } else {
        console.log("Использование:");
        console.log("  node send-webapp-update-notification.js check  - проверить количество получателей (dry-run)");
        console.log("  node send-webapp-update-notification.js send   - выполнить рассылку");
        process.exit(1);
      }
    } catch (error) {
      console.error("💥 Фатальная ошибка:", error);
      process.exit(1);
    } finally {
      await bot.stop();
    }
  })();
}

module.exports = { sendWebAppUpdateNotification, checkWebAppUpdateNotification };
