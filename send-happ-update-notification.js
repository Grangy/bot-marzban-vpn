// send-happ-update-notification.js
// Скрипт для рассылки уведомлений активным пользователям об обновлении подписки в Happ
require("dotenv").config();
const { Telegraf } = require("telegraf");
const { prisma } = require("./db");
const { SubscriptionType } = require("@prisma/client");
const { Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не установлен в переменных окружения");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Текст сообщения с эмодзи
const NOTIFICATION_TEXT = `🔄 Обновите подписку в приложении Happ

✨ У нас отличная новость! Мы добавили серверы с белыми IP адресами для обхода блокировок мобильного интернета.

📱 Чтобы получить доступ к новым серверам, нажмите кнопку "Обновить" в приложении Happ и обновите вашу подписку.

⚠️ Если у вас еще не установлено приложение Happ, мы рекомендуем сменить приложение и добавить вашу подписку снова из раздела "Подписки".

🔓 Теперь вы сможете использовать VPN даже на мобильных операторах, которые блокируют VPN-сервисы.

⚡ Не упустите возможность улучшить качество соединения!

💡 Если у вас возникнут вопросы, обращайтесь в поддержку: @grangym`;

const IMAGE_PATH = path.join(__dirname, "instruction.png");

async function sendHappUpdateNotification() {
  try {
    console.log("🔍 Поиск всех подписок...");

    // Находим все подписки (включая FREE)
    const activeSubscriptions = await prisma.subscription.findMany({
      where: {},
      include: {
        user: {
          select: {
            id: true,
            chatId: true,
            telegramId: true,
            accountName: true,
          },
        },
      },
      orderBy: {
        id: "asc",
      },
    });

    console.log(`📊 Найдено подписок: ${activeSubscriptions.length}`);

    if (activeSubscriptions.length === 0) {
      console.log("✅ Нет подписок для рассылки");
      return;
    }

    // Кнопки не нужны, обновление делается в самом приложении Happ
    const keyboard = null;

    let sent = 0;
    let errors = 0;
    let skipped = 0;

    // Уникальные пользователи (на случай нескольких активных подписок у одного пользователя)
    const sentToUsers = new Set();

    for (const sub of activeSubscriptions) {
      try {
        const user = sub.user;
        const chatId = user?.chatId;

        if (!chatId) {
          console.log(`⚠️  Подписка ${sub.id}: пользователь ${user?.telegramId || '?'} не имеет chatId, пропускаем`);
          skipped++;
          continue;
        }

        // Пропускаем если уже отправили этому пользователю
        if (sentToUsers.has(user.id)) {
          console.log(`✓ Подписка ${sub.id}: пользователю ${user.telegramId} уже отправлено сообщение, пропускаем`);
          continue;
        }

        console.log(`📤 Отправка сообщения пользователю ${user.telegramId} (chatId: ${chatId})...`);

        // Отправляем изображение с текстом, если файл существует
        if (fs.existsSync(IMAGE_PATH)) {
          try {
            await bot.telegram.sendPhoto(chatId, { source: IMAGE_PATH }, {
              caption: NOTIFICATION_TEXT
            });
            console.log(`✅ Сообщение с изображением отправлено пользователю ${user.telegramId}`);
          } catch (photoError) {
            // Если не удалось отправить фото, отправляем текстовое сообщение
            console.log(`⚠️  Ошибка отправки изображения, отправляем текстовое сообщение: ${photoError.message}`);
            await bot.telegram.sendMessage(chatId, NOTIFICATION_TEXT, keyboard);
            console.log(`✅ Текстовое сообщение отправлено пользователю ${user.telegramId}`);
          }
        } else {
          // Если файла изображения нет, отправляем только текст
          await bot.telegram.sendMessage(chatId, NOTIFICATION_TEXT, keyboard);
          console.log(`✅ Сообщение отправлено пользователю ${user.telegramId} (изображение не найдено)`);
        }
        
        sentToUsers.add(user.id);
        sent++;

        // Небольшая задержка чтобы не превысить лимиты API Telegram
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`❌ Ошибка при отправке сообщения для подписки ${sub.id}:`, error.message);
        
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
    console.log(`   📊 Всего подписок: ${activeSubscriptions.length}`);
    console.log(`   👥 Уникальных получателей: ${sentToUsers.size}`);

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
async function checkHappUpdateNotification() {
  try {
    console.log("🔍 Проверка: поиск всех подписок...");

    const activeSubscriptions = await prisma.subscription.findMany({
      where: {},
      include: {
        user: {
          select: {
            id: true,
            chatId: true,
            telegramId: true,
            accountName: true,
          },
        },
      },
      orderBy: {
        id: "asc",
      },
    });

    console.log(`📊 Найдено подписок: ${activeSubscriptions.length}\n`);

    if (activeSubscriptions.length === 0) {
      console.log("✅ Нет подписок для рассылки");
      return;
    }

    const uniqueUsers = new Set();
    let withChatId = 0;
    let withoutChatId = 0;

    for (const sub of activeSubscriptions) {
      const user = sub.user;
      if (user.chatId) {
        uniqueUsers.add(user.id);
        withChatId++;
      } else {
        withoutChatId++;
      }
    }

    console.log("📋 Статистика:");
    console.log(`   👥 Уникальных пользователей с подписками: ${uniqueUsers.size}`);
    console.log(`   ✅ Пользователей с chatId: ${withChatId}`);
    console.log(`   ⚠️  Пользователей без chatId: ${withoutChatId}`);
    console.log(`\n📝 Пример сообщения, которое будет отправлено:\n`);
    console.log(NOTIFICATION_TEXT);
    console.log(`\n💡 Для отправки сообщений запустите: node send-happ-update-notification.js send`);
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
        await checkHappUpdateNotification();
        console.log("\n👋 Проверка завершена");
        process.exit(0);
      } else if (command === "send") {
        await sendHappUpdateNotification();
        console.log("\n👋 Скрипт завершен");
        process.exit(0);
      } else {
        console.log("Использование:");
        console.log("  node send-happ-update-notification.js check  - проверить количество получателей (dry-run)");
        console.log("  node send-happ-update-notification.js send   - выполнить рассылку");
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

module.exports = { sendHappUpdateNotification, checkHappUpdateNotification };
