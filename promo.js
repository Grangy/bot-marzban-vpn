// promo.js - Telegram Bot интерфейс для работы с промокодами
// Использует promo-manager.js для логики активации
const { prisma } = require("./db");
const { Markup } = require("telegraf");
const { promoMenu, ruMoney, instructionsMenu, mainMenu } = require("./menus");
const { activatePromoCode, getUserPromoStats, PROMO_TYPES } = require("./promo-manager");
const { getReferralStats } = require("./referral-bonus");

// Хранилище пользователей, ожидающих ввода промокода (chatId -> true)
const waitingForPromoCode = new Set();

// Функция для активации промокода (обертка для Telegram контекста)
async function activatePromoCodeForUser(ctx, inputCode) {
  try {
    // Проверяем, что пользователь инициализирован
    if (!ctx.dbUser || !ctx.dbUser.id) {
      console.error("[PROMO] ctx.dbUser is undefined");
      return { ok: false, message: "❌ Ошибка инициализации. Попробуйте еще раз." };
    }
    
    // Используем новый модуль для активации
    const result = await activatePromoCode(ctx.dbUser.id, inputCode);
    
    // Если это реферальный промокод, оповещаем владельца
    if (result.ok && result.type === "referral") {
      try {
        const owner = await prisma.user.findFirst({
          where: { promoCode: inputCode.toUpperCase() }
        });
        
        if (owner && owner.chatId) {
          await ctx.telegram.sendMessage(
            owner.chatId,
            `🎉 Ваш промокод активирован пользователем ${ctx.dbUser.accountName || ctx.dbUser.telegramId}`
          );
        }
      } catch (e) {
        // Молча игнорируем ошибки отправки уведомления
      }
    }
    
    return result;
  } catch (e) {
    console.error("[PROMO] Activation error:", e);
    return { ok: false, message: "❌ Ошибка при активации промокода. Попробуйте позже." };
  }
}

// Кросс-платформенная функция для создания ссылки поделиться (работает на компе и мобильном)
function shareLink(text) {
  // Для отправки текста используем формат с пустым url параметром
  // Это работает на всех платформах (компьютер, мобильный, веб)
  const base = "https://t.me/share/url";
  return `${base}?url=&text=${encodeURIComponent(text)}`;
}


function registerPromo(bot) {
  // Middleware для очистки состояния ожидания при нажатии других кнопок
  // Должен быть зарегистрирован ПЕРВЫМ, чтобы очищать состояние до обработки
  bot.use(async (ctx, next) => {
    // Если это callback query и не "promo_activate", очищаем состояние
    if (ctx.callbackQuery && ctx.callbackQuery.data !== "promo_activate" && !ctx.callbackQuery.data?.startsWith("promo_copy_")) {
      const chatId = String(ctx.chat?.id || ctx.from?.id);
      waitingForPromoCode.delete(chatId);
    }
    return next();
  });

  // Экран промокода
  bot.action("promo", async (ctx) => {
    await ctx.answerCbQuery();
    
    // Проверяем, что пользователь инициализирован
    if (!ctx.dbUser || !ctx.dbUser.id) {
      console.error("[PROMO] ctx.dbUser is undefined in promo action");
      return ctx.reply("❌ Ошибка инициализации. Попробуйте еще раз.");
    }
    
    // Убираем пользователя из ожидающих промокод (если был)
    const chatId = String(ctx.chat?.id || ctx.from?.id);
    waitingForPromoCode.delete(chatId);
    
    // Получаем пользователя из БД для доступа к promoCode
    const me = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
    
    if (!me) {
      return ctx.reply("❌ Пользователь не найден. Попробуйте еще раз.");
    }
    
    if (!me.promoCode) {
      return ctx.reply("❌ Промокод не найден. Попробуйте перезапустить бота командой /start");
    }
    
    // Получаем статистику промокода
    const stats = await getUserPromoStats(ctx.dbUser.id);
    
    // Получаем статистику реферальных бонусов
    const referralStats = await getReferralStats(ctx.dbUser.id);

    // Получаем username бота
    let botUsername = null;
    try {
      const botInfo = await ctx.telegram.getMe();
      botUsername = botInfo.username;
    } catch (e) {
      console.error("[PROMO] Error getting bot info:", e);
    }

    // Формируем ссылку на бота в формате @username
    const botLink = botUsername ? `@${botUsername}` : "@maxvpn_offbot";

    const msg =
`🎁 Ваш реферальный промокод: \`${me.promoCode}\`

📊 Статистика:
✅ Активаций вашего промокода: ${stats.activations}
💰 Реферальных бонусов получено: ${ruMoney(referralStats.totalBonusAmount)}
📈 Всего пополнений рефералами: ${ruMoney(referralStats.totalTopupsAmount)}

💎 Как работает система:
• Пользователь активирует ваш промокод → получает VPN на 3 дня
• Когда этот пользователь пополняет баланс → вам начисляется 20% от суммы
• Чем больше друзей используют ваш промокод, тем больше бонусов!

💵 Бонусы можно использовать для покупки подписки или вывести в будущем.`;

    // Создаем информативное сообщение для пересылки
    const shareMessage = `💎 Заработай вместе с MaxGroot!

🎁 Реферальный промокод: ${me.promoCode}

✨ Что получает друг:
• 3 дня бесплатного VPN с обходом блокировок мобильной связи
• Быстрое и стабильное соединение

💰 Что получаете вы:
• 20% от всех пополнений баланса вашего друга
• Бонусы начисляются автоматически
• Можно использовать для покупки подписки или вывести

📱 Как активировать:
1. Откройте бота ${botLink}
2. Нажмите «🎁 Промокод» в меню
3. Выберите «🎁 Активировать чужой промокод»
4. Введите: ${me.promoCode}

💎 Начните зарабатывать вместе с MaxGroot!`;

    // Кросс-платформенная ссылка для поделиться (работает на компе и мобильном)
    const shareUrl = shareLink(shareMessage);

    const kb = Markup.inlineKeyboard([
      [Markup.button.url("🔗 Поделиться промокодом", shareUrl)],
      [Markup.button.callback(`📋 Показать код для копирования`, `promo_copy_${me.promoCode}`)],
      [Markup.button.callback("🎁 Активировать чужой промокод", "promo_activate")],
      [Markup.button.callback("⬅️ Назад", "back")],
    ]);

    await ctx.replyWithMarkdown(msg, kb);
  });

  // Действие для показа промокода для копирования
  bot.action(/^promo_copy_(.+)$/, async (ctx) => {
    const code = ctx.match[1];
    await ctx.answerCbQuery();
    const copyMsg = `📋 Ваш промокод для копирования:

\`${code}\`

💡 Используйте команду: \`/promo ${code}\`

Или поделитесь кнопкой "🔗 Поделиться промокодом" выше.`;
    await ctx.replyWithMarkdown(copyMsg, promoMenu());
  });

  // Подсказка по активации
  bot.action("promo_activate", async (ctx) => {
    await ctx.answerCbQuery();
    // Добавляем пользователя в ожидающие промокод
    const chatId = String(ctx.chat?.id || ctx.from?.id);
    waitingForPromoCode.add(chatId);
    
    const text =
`✍️ Введите промокод в чат:

Вы можете ввести:
• Просто промокод: \`010BA823\`
• Или команду: \`/promo 010BA823\`

Например: \`010BA823\` или \`A1B2C3D4\``;
    await ctx.replyWithMarkdown(text, promoMenu());
  });

  // Обработчик текстовых сообщений для активации промокода (без команды)
  // Должен быть зарегистрирован ПОСЛЕ других обработчиков (actions, commands)
  // чтобы не мешать им
  bot.on("text", async (ctx, next) => {
    // Пропускаем команды (они обрабатываются отдельно через bot.command)
    if (ctx.message?.text?.startsWith("/")) {
      return next();
    }

    const chatId = String(ctx.chat?.id || ctx.from?.id);
    
    // Проверяем, ожидается ли промокод от этого пользователя
    if (!waitingForPromoCode.has(chatId)) {
      return next(); // Не ожидаем промокод, передаем дальше
    }

    const text = ctx.message?.text?.trim() || "";
    
    // Проверяем формат промокода: только A-Z0-9 и дефис, длина от 1 символа (для админских может быть любой)
    // Убираем пробелы для обработки вариантов типа "010BA823" или "010 BA 823" или "444"
    const cleanText = text.replace(/\s+/g, "");
    // Минимум 1 символ, максимум 100 (для админских промокодов может быть любой)
    const promoMatch = cleanText.match(/^([A-Z0-9-]{1,100})$/i);
    
    if (!promoMatch) {
      // Если текст не похож на промокод, удаляем из ожидания
      waitingForPromoCode.delete(chatId);
      return next();
    }
    
    // Удаляем пользователя из ожидающих
    waitingForPromoCode.delete(chatId);

    const inputCode = promoMatch[1].toUpperCase();

    // Пытаемся активировать промокод
    const result = await activatePromoCodeForUser(ctx, inputCode);

    if (result.ok) {
      const buttons = [];
      
      if (result.subscriptionUrl || result.subscriptionUrl2) {
        if (result.subscriptionUrl) {
          buttons.push([Markup.button.url("🔗 Подключить", result.subscriptionUrl)]);
        }
        if (result.subscriptionUrl2) {
          buttons.push([Markup.button.url("🔗 Подключить 2 (МТС, Миранда)", result.subscriptionUrl2)]);
        }
      }
      
      if (result.type === PROMO_TYPES.ADMIN_BALANCE) {
        buttons.push([Markup.button.callback("🛒 Купить подписку", "buy")]);
      }
      
      buttons.push(
        [Markup.button.callback("📦 Мои подписки", "my_subs")],
        [Markup.button.callback("📖 Инструкции", "instructions")],
        [Markup.button.callback("⬅️ В меню", "back")]
      );
      
      const keyboard = Markup.inlineKeyboard(buttons);
      await ctx.reply(result.message, keyboard);
      // Не вызываем next(), так как мы обработали сообщение
    } else {
      await ctx.reply(result.message);
      // Предлагаем попробовать снова (если ошибка не критическая)
      if (result.message.includes("не найден")) {
        waitingForPromoCode.add(chatId);
      }
      // Не вызываем next(), так как мы обработали сообщение
    }
  });


  // Команда активации: /promo ABCD1234
  bot.command("promo", async (ctx) => {
    // Удаляем пользователя из ожидающих (если был)
    const chatId = String(ctx.chat?.id || ctx.from?.id);
    waitingForPromoCode.delete(chatId);

    const raw = ctx.message?.text || "";
    // Минимум 1 символ для поддержки админских промокодов любой длины (например "444")
    const match = raw.trim().match(/^\/promo(?:@\w+)?\s+([A-Z0-9-]{1,100})$/i);

    if (!match) {
      // Если команда без кода, добавляем в ожидающие
      waitingForPromoCode.add(chatId);
      return ctx.reply("✍️ Введите промокод:\n\nВы можете ввести:\n• Просто промокод: `010BA823` или `444`\n• Или команду: `/promo 010BA823` или `/promo 444`");
    }

    const inputCode = match[1].toUpperCase();
    const result = await activatePromoCodeForUser(ctx, inputCode);

    if (result.ok) {
      const buttons = [];
      
      if (result.subscriptionUrl || result.subscriptionUrl2) {
        if (result.subscriptionUrl) {
          buttons.push([Markup.button.url("🔗 Подключить", result.subscriptionUrl)]);
        }
        if (result.subscriptionUrl2) {
          buttons.push([Markup.button.url("🔗 Подключить 2 (МТС, Миранда)", result.subscriptionUrl2)]);
        }
      }
      
      if (result.type === PROMO_TYPES.ADMIN_BALANCE) {
        buttons.push([Markup.button.callback("🛒 Купить подписку", "buy")]);
      }
      
      buttons.push(
        [Markup.button.callback("📦 Мои подписки", "my_subs")],
        [Markup.button.callback("📖 Инструкции", "instructions")],
        [Markup.button.callback("⬅️ В меню", "back")]
      );
      
      const keyboard = Markup.inlineKeyboard(buttons);
      return ctx.reply(result.message, keyboard);
    } else {
      return ctx.reply(result.message);
    }
  });
}

// Экспортируем функцию для очистки состояния ожидания (можно использовать из других модулей)
function clearWaitingState(chatId) {
  waitingForPromoCode.delete(String(chatId));
}

module.exports = { registerPromo, clearWaitingState };
