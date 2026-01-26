  const { prisma } = require("./db");
  const { SubscriptionType } = require("@prisma/client");
  const { createInvoice, applyCreditIfNeeded } = require("./payment");
  const path = require("path");
  const { Markup } = require("telegraf");
  const { balanceMenu } = require("./menus"); // 👈 импортируем

  const fs = require("fs");


  const {
    PLANS,
    TOPUP_AMOUNTS,
    ruMoney,
    formatDate,
    calcEndDate,
    mainMenu,
    buyMenu,
    topupMenu,
    paymentSuccessMenu, // 👈 новая функция
    getDisplayLabel, // 👈 добавляем
    infoMenu,
    instructionsMenu,
  } = require("./menus");
  const MARZBAN_API_URL = process.env.MARZBAN_API_URL;
  const { createMarzbanUserOnBothServers, extendMarzbanUserOnBothServers } = require("./marzban-utils");

  // Хранилище состояний настройки после покупки: chatId -> { subscriptionId, step, device }
  const setupStates = new Map();

  /* Утилита: безопасный ответ на callback query (игнорирует ошибки устаревших запросов) */
  async function safeAnswerCbQuery(ctx, text = null) {
    try {
      if (text) {
        await ctx.answerCbQuery(text);
      } else {
        await ctx.answerCbQuery();
      }
    } catch (error) {
      // Игнорируем ошибки устаревших callback query
      if (error.response?.error_code === 400 && 
          (error.response?.description?.includes("query is too old") || 
           error.response?.description?.includes("query ID is invalid"))) {
        // Это нормально - запрос устарел, просто игнорируем
        return;
      }
      // Другие ошибки логируем, но не падаем
      console.warn("[ACTIONS] answerCbQuery error:", error.message);
    }
  }

  /* Утилита: проверка ctx.dbUser */
  function ensureDbUser(ctx) {
    if (!ctx.dbUser || !ctx.dbUser.id) {
      console.error("[ACTIONS] ctx.dbUser is undefined for user:", ctx.from?.id);
      throw new Error("User not initialized. Please try again.");
    }
    return ctx.dbUser;
  }

  /* Утилита: безопасное редактирование сообщения */
  async function editOrAnswer(ctx, text, keyboard) {
    try {
      const currentText = ctx.callbackQuery?.message?.text;
      const currentKb = JSON.stringify(
        ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || []
      );
      const nextKb = JSON.stringify(keyboard?.reply_markup?.inline_keyboard || []);

      if (currentText === text && currentKb === nextKb) {
        await safeAnswerCbQuery(ctx, "Актуально");
        return;
      }
      await ctx.editMessageText(text, keyboard);
    } catch (err) {
      const desc = err?.response?.description || err?.message || "";
      if (desc.includes("message is not modified")) {
        await safeAnswerCbQuery(ctx, "Актуально");
        return;
      }
      if (desc.includes("message can't be edited") || desc.includes("there is no text in the message to edit")) {
        await ctx.reply(text, keyboard);
        return;
      }
      console.error("editOrAnswer error:", desc);
    }
  }

  /* Регистрируем все действия */
  function registerActions(bot) {
    // Middleware для безопасной обработки ошибок в действиях
    bot.use(async (ctx, next) => {
      if (ctx.callbackQuery) {
        try {
          return await next();
        } catch (error) {
          console.error("[ACTIONS] Error in action handler:", error.message);
          console.error("[ACTIONS] Action:", ctx.callbackQuery?.data);
          console.error("[ACTIONS] Stack:", error.stack);
          // Пытаемся безопасно ответить на callback query
          await safeAnswerCbQuery(ctx);
          // Не отправляем сообщение об ошибке - это может вызвать еще больше проблем
          return;
        }
      }
      return next();
    });
    // Назад — главное меню (регистрируем первым)
    bot.action("back", async (ctx) => {
      await safeAnswerCbQuery(ctx);
      try {
        ensureDbUser(ctx);
      } catch (e) {
        return ctx.reply("❌ Ошибка инициализации. Попробуйте еще раз.");
      }
      const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
      
      try {
        // Сначала пытаемся отредактировать сообщение
        await editOrAnswer(ctx, "Выберите действие:", mainMenu(user.balance));
      } catch (error) {
        // Если не получается отредактировать (например, после видео), отправляем новое сообщение
        console.log("[DEBUG] Cannot edit message, sending new one:", error.message);
        await ctx.reply("Выберите действие:", mainMenu(user.balance));
      }
    });

    // Информация — баланс и подписки
bot.action("instructions", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await editOrAnswer(ctx, "📖 Выберите платформу:", instructionsMenu());
});

// Утилита для чтения файлов с инструкцией
function getText(fileName) {
  const filePath = path.join(__dirname, "texts", fileName);
  return fs.readFileSync(filePath, "utf-8");
}

// Функция для получения текста инструкции (без ссылок подписки) - эталон из этапа покупки
function getInstructionTextForDevice(deviceType) {
  // Специальная инструкция для Android TV
  if (deviceType === 'android_tv') {
    return getAndroidTVInstructionText();
  }
  
  const deviceNames = {
    ios: { name: "iPhone", title: "Пошаговая настройка для iPhone:" },
    android: { name: "вашем устройстве", title: "Пошаговая настройка для Android:" },
    windows: { name: "вашем компьютере", title: "Пошаговая настройка для Windows:" },
    macos: { name: "вашем Mac", title: "Пошаговая настройка для macOS:" }
  };
  
  const device = deviceNames[deviceType];
  
  let text = `📱 ${device.title}\n\n`;
  text += `1) Откройте приложение Happ на ${device.name}\n\n`;
  text += `2) Нажмите кнопку "+" в правом верхнем углу\n\n`;
  text += `3) Скопируйте ссылку из раздела «Мои подписки»\n\n`;
  text += `💡Если у вас оператор МТС, Миранда или другой, используйте вторую ссылку из подписки\n\n`;
  text += `4) Выберите "вставить из буфера обмена"\n\n`;
  text += `5) Нажмите кнопку "разрешить вставку"\n\n`;
  text += `6) Нажмите "Import"\n\n`;
  text += `7) После импорта нажмите на созданную конфигурацию\n\n`;
  text += `8) Включите VPN-подключение кнопкой "Connect"\n\n`;
  text += `✅ Готово! Ваш интернет работает через VPN.`;
  
  return text;
}

// Специальная инструкция для Android TV
function getAndroidTVInstructionText() {
  let text = `📺 Пошаговая настройка для Android TV:\n\n`;
  text += `Приложение Happ на Android TV не отличается от мобильного приложения и устанавливается с помощью APK или через Google Play.\n\n`;
  text += `📱 Способ 1: Через QR-код (рекомендуется)\n`;
  text += `При первом запуске приложение предложит добавить подписку по локальной сети через QR-код. Просто отсканируйте QR-код в мобильном приложении Happ для iOS или Android, после чего телефон попытается передать выбранные серверы или подписку на телевизор.\n\n`;
  text += `🌐 Способ 2: Через сайт tv.happ.su\n`;
  text += `На телевизоре выберите пункт «Web Import» и введите отображённый код либо отсканируйте QR-код и откройте ссылку в браузере телефона.\n\n`;
  text += `💡 Если у вас оператор МТС, Миранда или другой, используйте вторую ссылку из раздела «Мои подписки»\n\n`;
  text += `✅ Готово! Ваш интернет работает через VPN.`;
  
  return text;
}

// Функция для получения видео файла по устройству
function getVideoFileForDevice(deviceType) {
  // Android и Android TV используют IMG_1021.mp4
  if (deviceType === 'android' || deviceType === 'android_tv') {
    return 'IMG_1021.mp4';
  }
  // iOS использует IMG_1020.mp4
  if (deviceType === 'ios') {
    return 'IMG_1020.mp4';
  }
  // macOS использует IMG_1023.MOV
  if (deviceType === 'macos') {
    return 'IMG_1023.MOV';
  }
  // Windows использует IMG_1024.mp4
  if (deviceType === 'windows') {
    return 'IMG_1024.mp4';
  }
  // По умолчанию IMG_1019.mp4
  return 'IMG_1019.mp4';
}

// Ссылки для скачивания приложений
const APP_DOWNLOAD_LINKS = {
  ios: "https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973",
  android: "https://play.google.com/store/apps/details?id=com.happproxy",
  android_tv_play: "https://play.google.com/store/apps/details?id=com.happproxy",
  android_tv_apk: "https://github.com/Happ-proxy/happ-android/releases/latest/download/Happ.apk",
  windows: "https://github.com/Happ-proxy/happ-desktop/releases/latest/download/setup-Happ.x64.exe",
  macos: "https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973"
};

// Функция для создания меню внутри инструкции устройства (с ссылками на приложения)
function deviceInstructionMenu(deviceType) {
  const buttons = [];
  
  // Ссылка на скачивание приложения
  if (deviceType === 'android_tv') {
    // Для Android TV две ссылки
    buttons.push([Markup.button.url("📥 Скачать Happ (Google Play)", APP_DOWNLOAD_LINKS.android_tv_play)]);
    buttons.push([Markup.button.url("📥 Скачать Happ (APK)", APP_DOWNLOAD_LINKS.android_tv_apk)]);
  } else {
    buttons.push([Markup.button.url("📥 Скачать Happ", APP_DOWNLOAD_LINKS[deviceType])]);
  }
  
  buttons.push([Markup.button.callback("📹 Видео-инструкция", `guide_video_${deviceType}`)]);
  buttons.push([Markup.button.callback("⬅️ Назад к выбору устройства", "instructions")]);
  buttons.push([Markup.button.callback("⬅️ В меню", "back")]);
  
  return Markup.inlineKeyboard(buttons);
}

// iOS / macOS
bot.action("guide_ios", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const text = getInstructionTextForDevice("ios");
  await editOrAnswer(ctx, text, deviceInstructionMenu("ios"));
});

// Android
bot.action("guide_android", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const text = getInstructionTextForDevice("android");
  await editOrAnswer(ctx, text, deviceInstructionMenu("android"));
});

// Android TV (с картинками)
bot.action("guide_android_tv", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const text = getInstructionTextForDevice("android_tv");
  
  // Отправляем картинки с инструкцией
  try {
    // Отправляем медиагруппу с двумя картинками
    await ctx.sendMediaGroup([
      { type: 'photo', media: { source: 'image2.png' }, caption: '📱 QR-код для сканирования через Happ' },
      { type: 'photo', media: { source: 'image.png' }, caption: '🌐 Web Import через tv.happ.su' }
    ]);
  } catch (e) {
    console.error("Error sending Android TV images:", e);
  }
  
  // Отправляем текст инструкции с кнопками
  await ctx.reply(text, deviceInstructionMenu("android_tv"));
});

// Windows
bot.action("guide_windows", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const text = getInstructionTextForDevice("windows");
  await editOrAnswer(ctx, text, deviceInstructionMenu("windows"));
});

// macOS (отдельный обработчик для возврата из видео)
bot.action("guide_macos", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const text = getInstructionTextForDevice("macos");
  await editOrAnswer(ctx, text, deviceInstructionMenu("macos"));
});

// Динамическая видео-инструкция для каждого устройства
bot.action(/^guide_video_(ios|android|android_tv|windows|macos)$/, async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const deviceType = ctx.match[1];
  const videoFile = getVideoFileForDevice(deviceType);
  
  const deviceNames = {
    ios: "iPhone/macOS",
    android: "Android",
    android_tv: "Android TV",
    windows: "Windows",
    macos: "macOS"
  };
  
  if (!fs.existsSync(videoFile)) {
    console.warn(`Video file ${videoFile} not found`);
    await ctx.reply(`❌ Видео-файл не найден на сервере. Используйте текстовые инструкции.`);
    return;
  }
  
  try {
    await ctx.sendVideo(
      { source: videoFile },
      {
        caption: `📹 Видео-инструкция для ${deviceNames[deviceType]}\n\nСмотрите подробное видео по настройке VPN.`,
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Назад к инструкции", `guide_${deviceType}`)],
          [Markup.button.callback("⬅️ В меню", "back")]
        ]).reply_markup
      }
    );
  } catch (e) {
    console.error("Error sending video:", e);
    await ctx.reply("❌ Ошибка отправки видео. Используйте текстовые инструкции.");
  }
});
    // Купить подписку — если нет средств, сразу ведём в пополнение
    bot.action("buy", async (ctx) => {
      await safeAnswerCbQuery(ctx);

      const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });

      // Минимальная стоимость платного тарифа (M1/M3/M6/M12)
      const paidPrices = Object.values(PLANS)
        .map((p) => p?.price)
        .filter((p) => typeof p === "number" && p > 0);
      const minPaidPrice = paidPrices.length ? Math.min(...paidPrices) : 0;

      // Если баланс меньше минимального тарифа — сразу предлагаем пополнение
      if ((user?.balance || 0) < minPaidPrice) {
        return editOrAnswer(
          ctx,
          `💳 Для покупки подписки нужно пополнить баланс.\n\nТекущий баланс: ${ruMoney(user?.balance || 0)}\nМинимальная подписка: ${ruMoney(minPaidPrice)}\n\nВыберите сумму пополнения:`,
          topupMenu()
        );
      }

      return editOrAnswer(ctx, "Выберите подписку:", buyMenu());
    });

    // Покупка конкретного плана
  const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

  // Информация — теперь открывает подменю
bot.action("info", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await editOrAnswer(ctx, "ℹ️ Информация:", infoMenu(ctx.dbUser.balance));
});


// Пользовательское соглашение
bot.action("tos", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const text = fs.readFileSync("texts/tos.txt", "utf8");
  await editOrAnswer(ctx, text, infoMenu(ctx.dbUser.balance));
});

// Политика конфиденциальности
bot.action("privacy", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const text = fs.readFileSync("texts/privacy.txt", "utf8");
  await editOrAnswer(ctx, text, infoMenu(ctx.dbUser.balance));
});

bot.action("balance_topup", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const text = "Выберите сумму пополнения:";
  await editOrAnswer(ctx, text, topupMenu());
});

bot.action("balance_refresh", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
  const text =
`💼 Баланс: ${ruMoney(user.balance)}

Ваш промокод: \`${user.promoCode}\``;
  await editOrAnswer(ctx, text, balanceMenu(user.balance));
});

  // внутри registerActions(bot)
  bot.action(/^buy_(M1|M3|M6|M12)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const planKey = ctx.match[1];
    const plan = PLANS[planKey];

    try {
      const result = await prisma.$transaction(async (tx) => {
        // 1) списание денег
        const dec = await tx.user.updateMany({
          where: { id: ctx.dbUser.id, balance: { gte: plan.price } },
          data: { balance: { decrement: plan.price } },
        });
        if (dec.count === 0) {
          return { ok: false, reason: "Недостаточно средств" };
        }

        // 2) создаём подписку (пока без ссылки)
        const sub = await tx.subscription.create({
          data: {
            userId: ctx.dbUser.id,
            type: SubscriptionType[plan.type],
            startDate: new Date(),
            endDate: calcEndDate(plan.months),
          },
        });

        // 3) текущий баланс
        const user = await tx.user.findUnique({ where: { id: ctx.dbUser.id } });
        return { ok: true, sub, balance: user.balance };
      });

      if (!result.ok) {
        // Получаем актуальный баланс пользователя
        const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
        const currentBalance = user?.balance || 0;
        const requiredAmount = plan.price - currentBalance;
        
        await editOrAnswer(
          ctx,
          `💳 Для покупки подписки нужно пополнить баланс.\n\nТекущий баланс: ${ruMoney(currentBalance)}\nСтоимость подписки: ${ruMoney(plan.price)}\nНеобходимо пополнить: ${ruMoney(requiredAmount)}\n\nВыберите сумму пополнения:`,
          topupMenu(requiredAmount)
        );
        return;
      }

      // 🔥 ВЫЗОВ MARZBAN API (создаем пользователя на обоих серверах)
      const expireSeconds = plan.months === 12 ? 365*24*60*60 : plan.months*30*24*60*60;
      const expire = Math.floor(Date.now() / 1000) + expireSeconds;

      const username = `${ctx.dbUser.telegramId}_${plan.type}_${result.sub.id}`;

      const userData = {
        username,
        status: "active",
        expire,
        proxies: { vless: {} },
        inbounds: { vless: ["VLESS TCP REALITY", "VLESS-TCP-REALITY-VISION"] },
        note: `Telegram user ${ctx.dbUser.accountName || ctx.dbUser.telegramId}`,
      };

      // Создаем пользователя на обоих серверах
      const { url1: subscriptionUrl, url2: subscriptionUrl2 } = await createMarzbanUserOnBothServers(userData);

      // Сохраняем обе ссылки в БД
      await prisma.subscription.update({
        where: { id: result.sub.id },
        data: { 
          subscriptionUrl,
          subscriptionUrl2
        },
      });

// Получаем обе ссылки из БД
const lastSub = await prisma.subscription.findUnique({ where: { id: result.sub.id } });

// Сообщение о успешной покупке
let successText = `✅ Подписка оформлена: ${plan.label}
Действует до: ${formatDate(result.sub.endDate)}

Текущий баланс: ${ruMoney(result.balance)}`;

// Кнопка для начала настройки
const keyboard = Markup.inlineKeyboard([
  [Markup.button.callback("📱 Выберите устройство для настройки", `setup_device_${result.sub.id}`)],
  [Markup.button.callback("⬅️ В меню", "back")]
]);

await editOrAnswer(ctx, successText, keyboard);

// Сохраняем состояние настройки (начинаем с выбора устройства)
const chatId = String(ctx.chat?.id || ctx.from?.id);
setupStates.set(chatId, { subscriptionId: result.sub.id, step: 'device_select' });


    } catch (e) {
      console.error("buy error:", e);
      await editOrAnswer(ctx, "Произошла ошибка. Попробуйте позже.", buyMenu());
    }
  });



bot.action("balance", async (ctx) => {
  await safeAnswerCbQuery(ctx);
  const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });

  const text =
`💼 Баланс: ${ruMoney(user.balance)}

Ваш промокод: \`${user.promoCode}\`
(Активировать чужой код: /promo КОД)`;

  await editOrAnswer(ctx, text, balanceMenu(user.balance));
});


  const { createInvoice } = require("./payment");

  // ✅ Middleware для логирования callback_data
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
      console.log(`[CALLBACK] from user=${ctx.dbUser?.id}, data="${ctx.callbackQuery.data}"`);
    }
    return next();
  });

bot.action(/^topup_(\d+)$/, async (ctx) => {
  // Сразу отвечаем на callback query чтобы избежать timeout
  await safeAnswerCbQuery(ctx, "⏳ Создаём счёт...");
  
  const amount = parseInt(ctx.match[1], 10);

  // Проверка лимита
  const pendingCount = await prisma.topUp.count({
    where: { userId: ctx.dbUser.id, status: "PENDING" }
  });

  if (pendingCount >= 3) {
    return ctx.reply("❌ У вас уже есть 3 неоплаченных счета.\nЗакройте их или дождитесь истечения срока.");
  }

  if (isNaN(amount) || amount <= 0) {
    console.warn(`[TOPUP] Invalid amount: "${ctx.match[1]}"`);
    return ctx.reply("Некорректная сумма пополнения.", topupMenu());
  }

  console.log(`[TOPUP] User ${ctx.dbUser.id} requested topup for ${amount} ₽`);

  try {
    const result = await createInvoice(ctx.dbUser.id, amount);
    const { link, topup, isFallback } = result;
    console.log(`[TOPUP] Created invoice: id=${topup.id}, orderId=${topup.orderId}, amount=${topup.amount}, isFallback=${isFallback}`);

    let messageText = `💳 Для пополнения на ${ruMoney(amount)} нажмите «Оплата».\n\nПосле завершения вернитесь и нажмите «Проверить оплату».`;
    
    if (isFallback) {
      messageText = `⚠️ Платежная система временно недоступна.\n\n💳 Для пополнения на ${ruMoney(amount)} перейдите по ссылке ниже для ручной обработки.\n\nПосле оплаты обратитесь в поддержку: @supmaxgroot`;
    }

    await ctx.reply(
      messageText,
      Markup.inlineKeyboard([
        [Markup.button.url("🔗 НАЖМИТЕ ДЛЯ ОПЛАТЫ", link)], // 👈 ссылка сразу
        [Markup.button.callback("🔄 Проверить оплату", `check_topup_${topup.id}`)],
        [Markup.button.callback("⬅️ Назад", "back")],
      ])
    );
  } catch (e) {
    console.error("[TOPUP] Error creating invoice:", e);
    
    // Более информативное сообщение об ошибке
    let errorMessage = "Ошибка при создании счёта.";
    
    if (e.message.includes("API")) {
      errorMessage = "Временная ошибка платежной системы. Попробуйте позже или обратитесь в поддержку.";
    } else if (e.message.includes("сеть") || e.message.includes("Network")) {
      errorMessage = "Проблемы с сетью. Попробуйте позже.";
    } else if (e.message.includes("авторизации")) {
      errorMessage = "Ошибка конфигурации платежной системы. Обратитесь в поддержку.";
    }
    
    await ctx.reply(`${errorMessage}\n\nЕсли проблема повторяется, обратитесь в поддержку: @supmaxgroot`, topupMenu());
  }
});


  bot.action(/^check_topup_(\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const id = parseInt(ctx.match[1], 10);
    if (isNaN(id)) {
      console.warn(`[CHECK] Invalid topup id: "${ctx.match[1]}"`);
      return ctx.reply("Некорректный запрос проверки оплаты.");
    }

    console.log(`[CHECK] User ${ctx.dbUser.id} is checking topup id=${id}`);

    try {
      const topup = await prisma.topUp.findUnique({ where: { id } });
      if (!topup) {
        console.warn(`[CHECK] Topup not found. id=${id}, userId=${ctx.dbUser.id}`);
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("💳 Пополнить баланс", "balance_topup")],
          [Markup.button.callback("⬅️ В меню", "back")]
        ]);
        return ctx.reply("❌ Пополнение не найдено. Возможно, оно было удалено или истекло.\n\nСоздайте новый запрос на пополнение.", keyboard);
      }
      
      if (topup.userId !== ctx.dbUser.id) {
        console.warn(`[CHECK] Topup belongs to another user. id=${id}, topupUserId=${topup.userId}, currentUserId=${ctx.dbUser.id}`);
        return ctx.reply("❌ Это пополнение принадлежит другому пользователю.");
      }

      console.log(`[CHECK] Found topup: id=${topup.id}, amount=${topup.amount}, status=${topup.status}, orderId=${topup.orderId}, credited=${topup.credited}`);

      if (topup.status === "SUCCESS") {
        // ✅ Пытаемся зачислить (идемпотентно)
        const creditRes = await applyCreditIfNeeded(topup.id);
        console.log("[CHECK] applyCreditIfNeeded:", creditRes);

        const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
        
        const text = `✅ Оплата подтверждена!\nБаланс: ${ruMoney(user.balance)}`;
        
        return ctx.reply(text, paymentSuccessMenu());
      } else if (topup.status === "FAILED" || topup.status === "TIMEOUT") {
        return ctx.reply("❌ Оплата не прошла.");
      } else if (topup.status === "PENDING") {
        return ctx.reply("⏳ Оплата ещё в обработке. Попробуйте позже.");
      } else {
        console.error(`[CHECK] Unknown status "${topup.status}" for topup id=${id}`);
        return ctx.reply("Неизвестный статус платежа. Обратитесь в поддержку.");
      }
    } catch (err) {
      console.error(`[CHECK] Error while checking topup id=${id}:`, err);
      return ctx.reply("Ошибка при проверке оплаты.");
    }
  });



    // Мои подписки — список
    bot.action("my_subs", async (ctx) => {
      await safeAnswerCbQuery(ctx);

      const subs = await prisma.subscription.findMany({
        where: { userId: ctx.dbUser.id },
        orderBy: [
          { startDate: "desc" },
          { id: "desc" }
        ],
      });

      if (subs.length === 0) {
        await editOrAnswer(ctx, "У вас пока нет подписок.", mainMenu());
        return;
      }

  const buttons = subs.map((s) => {
    const label = getDisplayLabel(s);
    const suffix = s.endDate ? `до ${formatDate(s.endDate)}` : "∞";
    return [Markup.button.callback(`${label} ${suffix}`, `sub_${s.id}`)];
  });


      buttons.push([Markup.button.callback("⬅️ Назад", "back")]);

      await editOrAnswer(
        ctx,
        "📦 Ваши подписки:",
        Markup.inlineKeyboard(buttons)
      );
    });

    // Подробности подписки
    bot.action(/sub_(\d+)/, async (ctx) => {
      await safeAnswerCbQuery(ctx);
      const id = parseInt(ctx.match[1], 10);
      const s = await prisma.subscription.findUnique({ where: { id } });

      if (!s || s.userId !== ctx.dbUser.id) {
        await editOrAnswer(ctx, "Подписка не найдена.", mainMenu());
        return;
      }

  const label = getDisplayLabel(s);
  let text = `📦 Подписка: ${label}
  Начало: ${formatDate(s.startDate)}
  Окончание: ${formatDate(s.endDate)}`;


      if (s.subscriptionUrl) {
        text += `\n\n🔗 Ваша ссылка: ${s.subscriptionUrl}`;
      }
      if (s.subscriptionUrl2) {
        text += `\n\n🔗 Ссылка для операторов МТС, Миранда и других: ${s.subscriptionUrl2}`;
      }

      const buttons = [[Markup.button.callback("⬅️ Назад", "my_subs")]];

      // Только для платных подписок (M1, M3, M6, M12) добавим кнопку продления
      if (s.type !== "FREE") {
        buttons.unshift([Markup.button.callback("🔄 Продлить", `extend_choose_${s.id}`)]);
      }

      await editOrAnswer(ctx, text, Markup.inlineKeyboard(buttons));
    });

  // Меню выбора срока продления
  bot.action(/extend_choose_(\d+)/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const id = parseInt(ctx.match[1], 10);
    const sub = await prisma.subscription.findUnique({ where: { id } });

    if (!sub || sub.userId !== ctx.dbUser.id) {
      await editOrAnswer(ctx, "Подписка не найдена.", mainMenu());
      return;
    }

    const buttons = Object.values(PLANS).map((plan) => {
      return [Markup.button.callback(`${plan.label} — ${ruMoney(plan.price)}`, `extend_${id}_${plan.type}`)];
    });

    buttons.push([Markup.button.callback("⬅️ Назад", `sub_${id}`)]);

    await editOrAnswer(ctx, "Выберите срок продления:", Markup.inlineKeyboard(buttons));
  });

  // Продление подписки на выбранный срок
  bot.action(/extend_(\d+)_(M1|M3|M6|M12)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const id = parseInt(ctx.match[1], 10);
    const planKey = ctx.match[2];
    const plan = PLANS[planKey];

    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub || sub.userId !== ctx.dbUser.id) {
      await editOrAnswer(ctx, "Подписка не найдена.", mainMenu());
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
    if (user.balance < plan.price) {
      const requiredAmount = plan.price - user.balance;
      await editOrAnswer(
        ctx,
        `💳 Для продления подписки нужно пополнить баланс.\n\nТекущий баланс: ${ruMoney(user.balance)}\nСтоимость продления: ${ruMoney(plan.price)}\nНеобходимо пополнить: ${ruMoney(requiredAmount)}\n\nВыберите сумму пополнения:`,
        topupMenu(requiredAmount)
      );
      return;
    }

    try {
      // списываем деньги и двигаем дату окончания
      const newEndDate = sub.endDate ? new Date(sub.endDate) : new Date();
      newEndDate.setMonth(newEndDate.getMonth() + plan.months);

      const updated = await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: ctx.dbUser.id },
          data: { balance: { decrement: plan.price } },
        });
return tx.subscription.update({
  where: { id },
  data: {
    endDate: newEndDate,
    // 👇 сброс напоминаний
    notified3Days: false,
    notified1Day: false,
    lastExpiredReminderAt: null,
  },
});

      });

      // 🔥 продление на обоих Marzban серверах (если есть ссылки)
      if (sub.subscriptionUrl || sub.subscriptionUrl2) {
        try {
          const username = `${ctx.dbUser.telegramId}_${sub.type}_${sub.id}`;
          const days = plan.months * 30;

          // Продлеваем на обоих серверах
          const extendResults = await extendMarzbanUserOnBothServers(username, days);
          
          if (!extendResults.success1 && sub.subscriptionUrl) {
            console.warn(`[Extend] Failed to extend on primary server for ${username}`);
          }
          if (!extendResults.success2 && sub.subscriptionUrl2) {
            console.warn(`[Extend] Failed to extend on secondary server for ${username}`);
          }
        } catch (err) {
          console.error("Ошибка при продлении на Marzban серверах:", err);
        }
      }

      const newBalance = user.balance - plan.price;

      await editOrAnswer(
        ctx,
        `✅ Подписка продлена на ${plan.label}
  Новая дата окончания: ${formatDate(updated.endDate)}

  Текущий баланс: ${ruMoney(newBalance)}`,
        mainMenu(newBalance)
      );
    } catch (err) {
      console.error("extend error:", err);
      await editOrAnswer(ctx, "Ошибка при продлении. Попробуйте позже.", mainMenu(user.balance));
    }
  });

  // ========== ИНТЕРАКТИВНАЯ НАСТРОЙКА ПОСЛЕ ПОКУПКИ ==========
  
  // Шаг 1: Выбор устройства
  bot.action(/^setup_device_(\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const subscriptionId = parseInt(ctx.match[1], 10);
    const chatId = String(ctx.chat?.id || ctx.from?.id);
    
    // Проверяем, что подписка принадлежит пользователю
    const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub || sub.userId !== ctx.dbUser.id) {
      return ctx.reply("Подписка не найдена.");
    }

    // Сохраняем состояние
    setupStates.set(chatId, { subscriptionId, step: 'device_select', device: null });

    const text = `📱 Выберите устройство, на которое вы будете устанавливать подписку:`;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🍎 iPhone (iOS)", `setup_choose_ios_${subscriptionId}`)],
      [Markup.button.callback("📱 Android", `setup_choose_android_${subscriptionId}`)],
      [Markup.button.callback("📺 Android TV", `setup_choose_android_tv_${subscriptionId}`)],
      [Markup.button.callback("💻 Windows", `setup_choose_windows_${subscriptionId}`)],
      [Markup.button.callback("🖥️ macOS", `setup_choose_macos_${subscriptionId}`)],
      [Markup.button.callback("⬅️ Назад", "back")]
    ]);

    await editOrAnswer(ctx, text, keyboard);
  });

  // Шаг 2: После выбора устройства - скачать приложение
  bot.action(/^setup_choose_(ios|android|android_tv|windows|macos)_(\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const device = ctx.match[1];
    const subscriptionId = parseInt(ctx.match[2], 10);
    const chatId = String(ctx.chat?.id || ctx.from?.id);

    // Проверяем подписку
    const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub || sub.userId !== ctx.dbUser.id) {
      return ctx.reply("Подписка не найдена.");
    }

    const deviceNames = {
      ios: "iPhone (iOS)",
      android: "Android",
      android_tv: "Android TV",
      windows: "Windows",
      macos: "macOS"
    };

    // Сохраняем состояние
    setupStates.set(chatId, { subscriptionId, step: 'download_app', device });

    const text = `📥 Скачайте приложение Happ для ${deviceNames[device]}:

Нажмите кнопку ниже, чтобы перейти в магазин приложений.`;

    // Формируем кнопки в зависимости от устройства
    const buttons = [];
    
    if (device === 'android_tv') {
      // Для Android TV две ссылки
      buttons.push([Markup.button.url("📥 Скачать Happ (Google Play)", APP_DOWNLOAD_LINKS.android_tv_play)]);
      buttons.push([Markup.button.url("📥 Скачать Happ (APK)", APP_DOWNLOAD_LINKS.android_tv_apk)]);
    } else {
      buttons.push([Markup.button.url("📥 Скачать Happ", APP_DOWNLOAD_LINKS[device])]);
    }
    
    buttons.push([Markup.button.callback("✅ Я скачал приложение", `setup_downloaded_${device}_${subscriptionId}`)]);
    buttons.push([Markup.button.callback("⬅️ Назад", `setup_device_${subscriptionId}`)]);

    const keyboard = Markup.inlineKeyboard(buttons);

    await editOrAnswer(ctx, text, keyboard);
  });

  // Шаг 3: После скачивания - пошаговая инструкция
  bot.action(/^setup_downloaded_(ios|android|android_tv|windows|macos)_(\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const device = ctx.match[1];
    const subscriptionId = parseInt(ctx.match[2], 10);
    const chatId = String(ctx.chat?.id || ctx.from?.id);

    // Проверяем подписку и получаем ссылки
    const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub || sub.userId !== ctx.dbUser.id) {
      return ctx.reply("Подписка не найдена.");
    }

    const subscriptionUrl = sub.subscriptionUrl;
    const subscriptionUrl2 = sub.subscriptionUrl2;
    
    if (!subscriptionUrl && !subscriptionUrl2) {
      return ctx.reply("❌ Ссылки подписки не найдены. Обратитесь в поддержку.");
    }
    
    // Формируем текст инструкции со ссылками для каждого устройства
    const getInstructionText = (deviceType, url1, url2) => {
      // Специальная инструкция для Android TV
      if (deviceType === 'android_tv') {
        return getAndroidTVInstructionTextWithLinks(url1, url2);
      }
      
      const deviceNames = {
        ios: { name: "iPhone", title: "Пошаговая настройка для iPhone:" },
        android: { name: "вашем устройстве", title: "Пошаговая настройка для Android:" },
        windows: { name: "вашем компьютере", title: "Пошаговая настройка для Windows:" },
        macos: { name: "вашем Mac", title: "Пошаговая настройка для macOS:" }
      };
      
      const device = deviceNames[deviceType];
      
      let text = `📱 ${device.title}\n\n`;
      text += `1) Откройте приложение Happ на ${device.name}\n\n`;
      text += `2) Нажмите кнопку "+" в правом верхнем углу\n\n`;
      text += `3) Скопируйте ссылку:\n`;
      
      if (url1) {
        text += `${url1}\n\n`;
      }
      
      if (url2) {
        text += `💡Если у вас оператор МТС, Миранда или другой, то скопировать нужно:\n`;
        text += `${url2}\n\n`;
      }
      
      text += `4) Выберите "вставить из буфера обмена"\n\n`;
      text += `5) Нажмите кнопку "разрешить вставку"\n\n`;
      text += `6) Нажмите "Import"\n\n`;
      text += `7) После импорта нажмите на созданную конфигурацию\n\n`;
      text += `8) Включите VPN-подключение кнопкой "Connect"\n\n`;
      text += `✅ Готово! Ваш интернет работает через VPN.`;
      
      return text;
    };
    
    // Специальная инструкция для Android TV с ссылками
    const getAndroidTVInstructionTextWithLinks = (url1, url2) => {
      let text = `📺 Пошаговая настройка для Android TV:\n\n`;
      text += `Приложение Happ на Android TV не отличается от мобильного приложения и устанавливается с помощью APK или через Google Play.\n\n`;
      text += `📱 Способ 1: Через QR-код (рекомендуется)\n`;
      text += `При первом запуске приложение предложит добавить подписку по локальной сети через QR-код. Просто отсканируйте QR-код в мобильном приложении Happ для iOS или Android, после чего телефон попытается передать выбранные серверы или подписку на телевизор.\n\n`;
      text += `🌐 Способ 2: Через сайт tv.happ.su\n`;
      text += `На телевизоре выберите пункт «Web Import» и введите отображённый код либо отсканируйте QR-код и откройте ссылку в браузере телефона.\n\n`;
      
      text += `🔗 Ваши ссылки подписки:\n`;
      if (url1) {
        text += `${url1}\n\n`;
      }
      if (url2) {
        text += `💡Если у вас оператор МТС, Миранда или другой:\n`;
        text += `${url2}\n\n`;
      }
      
      text += `✅ Готово! Ваш интернет работает через VPN.`;
      
      return text;
    };

    // Формируем полное сообщение с инструкцией
    const fullMessage = getInstructionText(device, subscriptionUrl, subscriptionUrl2);

    // Кнопки для инструкции (с учетом устройства для видео)
    const buttons = [
      [Markup.button.callback("✅ Я настроил VPN", `setup_complete_${subscriptionId}`)],
      [Markup.button.callback("📹 Видео-инструкция", `setup_video_${device}_${subscriptionId}`)],
      [Markup.button.callback("⬅️ В меню", "back")]
    ];

    // Для Android TV отправляем картинки
    if (device === 'android_tv') {
      try {
        await ctx.sendMediaGroup([
          { type: 'photo', media: { source: 'image2.png' }, caption: '📱 QR-код для сканирования через Happ' },
          { type: 'photo', media: { source: 'image.png' }, caption: '🌐 Web Import через tv.happ.su' }
        ]);
      } catch (e) {
        console.error("Error sending Android TV images:", e);
      }
    }

    await editOrAnswer(ctx, fullMessage, Markup.inlineKeyboard(buttons));

    // Сохраняем состояние
    setupStates.set(chatId, { subscriptionId, step: 'instructions', device, subscriptionUrl });
  });

  // Обработчик для кнопки "Видео-инструкция" на этапе настройки (с учетом устройства)
  bot.action(/^setup_video_(ios|android|android_tv|windows|macos)_(\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const deviceType = ctx.match[1];
    const subscriptionId = parseInt(ctx.match[2], 10);

    // Проверяем подписку
    const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub || sub.userId !== ctx.dbUser.id) {
      return ctx.reply("Подписка не найдена.");
    }

    // Выбираем видео файл в зависимости от устройства
    let videoFile;
    if (deviceType === 'android' || deviceType === 'android_tv') {
      videoFile = 'IMG_1021.mp4';
    } else if (deviceType === 'ios') {
      videoFile = 'IMG_1020.mp4';
    } else if (deviceType === 'macos') {
      videoFile = 'IMG_1023.MOV';
    } else {
      videoFile = 'IMG_1019.mp4';
    }
    
    const deviceNames = {
      ios: "iPhone",
      android: "Android",
      android_tv: "Android TV",
      windows: "Windows",
      macos: "macOS"
    };

    // Проверяем существование файла видео
    if (!fs.existsSync(videoFile)) {
      console.warn(`Video file ${videoFile} not found`);
      await ctx.reply("❌ Видео-файл не найден на сервере. Используйте текстовые инструкции.");
      return;
    }

    try {
      // Отправляем видео с инструкцией
      await ctx.sendVideo(
        { source: videoFile },
        {
          caption: `📹 Видео-инструкция для ${deviceNames[deviceType]}\n\nСмотрите подробное видео по настройке VPN.`,
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("✅ Я настроил VPN", `setup_complete_${subscriptionId}`)],
            [Markup.button.callback("⬅️ В меню", "back")]
          ]).reply_markup
        }
      );
    } catch (e) {
      console.error("Error sending video:", e);
      await ctx.reply("❌ Ошибка отправки видео. Используйте текстовые инструкции выше.");
    }
  });



  // Завершение настройки
  bot.action(/^setup_complete_(\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const subscriptionId = parseInt(ctx.match[1], 10);
    const chatId = String(ctx.chat?.id || ctx.from?.id);

    // Очищаем состояние
    setupStates.delete(chatId);

    // Ссылка на канал с отзывами
    const reviewsChannelUrl = process.env.REVIEWS_CHANNEL_URL || "https://t.me/vpnmax_off/8";
    
    await editOrAnswer(
      ctx,
      `✅ Отлично! Ваш VPN настроен и готов к работе.

Если у вас возникнут вопросы, используйте раздел «📖 Инструкции» в главном меню.

💬 Мы будем рады вашему отзыву!`,
      Markup.inlineKeyboard([
        [Markup.button.url("💬 Оставить отзыв", reviewsChannelUrl)],
        [Markup.button.callback("⬅️ В меню", "back")]
      ])
    );
  });

  // Очистка состояния при других действиях
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery && !ctx.callbackQuery.data?.startsWith("setup_")) {
      const chatId = String(ctx.chat?.id || ctx.from?.id);
      setupStates.delete(chatId);
    }
    return next();
  });

  }

  module.exports = { registerActions };
