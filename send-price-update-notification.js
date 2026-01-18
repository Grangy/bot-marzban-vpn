#!/usr/bin/env node
/**
 * Скрипт рассылки уведомления о повышении цен всем пользователям
 * 
 * Использование:
 *   node send-price-update-notification.js          - показать сколько пользователей получат (dry-run)
 *   node send-price-update-notification.js --run    - отправить рассылку
 */

require("dotenv").config();
const { Telegraf } = require("telegraf");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);

const isDryRun = !process.argv.includes("--run");

const MESSAGE = `🔥 <b>Скоро цены вырастут!</b>
20.01.2026 в 23:59, все тарифы повышаются на 50%.  
Успейте оформить или продлить подписку до 23:59, пока действуют старые цены!

⚙️ <b>Что нового в MaxGroot:</b>
• Улучшены сервера, связь стала стабильнее и быстрее.
• В приложении Happ нажмите «Обновить сервера» (жмите на 🔄).
• Обновлён интерфейс и добавлены новые иконки.

📺 <b>MaxGroot теперь доступен на Smart TV!</b>  
Верните себе YouTube — продолжайте просмотр без блокировок прямо на телевизоре!

🌐 <b>Новый сервер для абонентов Миранда уже доступен.</b>  
Зайдите в бота → «Мои подписки» → выберите подписку → скопируйте вторую ссылку на сервера Миранда и добавьте её в приложение.

🚀 Оформите или продлите подписку <b>20.01.2026 до 23:59</b>, пока действуют старые цены.

Следите за новостями, розыгрышами в нашей группе @vpnmax_off (скоро вас ждет что то интересное ☺️)`;

// Задержка между сообщениями (мс) - чтобы не превысить лимиты Telegram
const DELAY_MS = 50;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("=".repeat(60));
  console.log("Рассылка уведомления о повышении цен");
  console.log("=".repeat(60));

  if (isDryRun) {
    console.log("\n⚠️  РЕЖИМ ПРОСМОТРА (dry-run)");
    console.log("Для отправки запустите: node send-price-update-notification.js --run\n");
  } else {
    console.log("\n🚀 РЕЖИМ ОТПРАВКИ\n");
  }

  // Получаем всех пользователей с chatId
  const users = await prisma.user.findMany({
    where: {
      chatId: { not: "" }
    },
    select: {
      id: true,
      telegramId: true,
      chatId: true,
      accountName: true
    }
  });

  // Убираем дубликаты по chatId
  const uniqueChats = new Map();
  for (const user of users) {
    if (user.chatId && !uniqueChats.has(user.chatId)) {
      uniqueChats.set(user.chatId, user);
    }
  }

  const uniqueUsers = Array.from(uniqueChats.values());

  console.log(`📊 Всего пользователей в БД: ${users.length}`);
  console.log(`📊 Уникальных чатов: ${uniqueUsers.length}\n`);

  if (isDryRun) {
    console.log("📝 Текст сообщения:");
    console.log("-".repeat(40));
    console.log(MESSAGE.replace(/<[^>]+>/g, '')); // Убираем HTML теги для превью
    console.log("-".repeat(40));
    console.log(`\n💡 Для отправки запустите:`);
    console.log(`   node send-price-update-notification.js --run`);
    await prisma.$disconnect();
    return;
  }

  let successCount = 0;
  let errorCount = 0;
  let blockedCount = 0;

  for (let i = 0; i < uniqueUsers.length; i++) {
    const user = uniqueUsers[i];
    const progress = `[${i + 1}/${uniqueUsers.length}]`;

    try {
      await bot.telegram.sendMessage(user.chatId, MESSAGE, { 
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
      successCount++;
      console.log(`${progress} ✅ ${user.accountName || user.telegramId}`);
    } catch (error) {
      const errorMsg = error.message || "";
      
      if (errorMsg.includes("bot was blocked") || errorMsg.includes("user is deactivated") || errorMsg.includes("chat not found")) {
        blockedCount++;
        console.log(`${progress} 🚫 ${user.accountName || user.telegramId} - заблокировал бота`);
      } else if (errorMsg.includes("Too Many Requests")) {
        // Если превысили лимит - ждём и пробуем снова
        console.log(`${progress} ⏳ Rate limit, ждём 5 секунд...`);
        await sleep(5000);
        i--; // Повторяем этого пользователя
        continue;
      } else {
        errorCount++;
        console.log(`${progress} ❌ ${user.accountName || user.telegramId} - ${errorMsg}`);
      }
    }

    // Задержка между сообщениями
    if (i < uniqueUsers.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("ИТОГО:");
  console.log(`  ✅ Отправлено: ${successCount}`);
  console.log(`  🚫 Заблокировали бота: ${blockedCount}`);
  console.log(`  ❌ Ошибок: ${errorCount}`);
  console.log("=".repeat(60));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("❌ Критическая ошибка:", e);
  prisma.$disconnect();
  process.exit(1);
});
