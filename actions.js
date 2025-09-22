  const { prisma } = require("./db");
  const { SubscriptionType } = require("@prisma/client");
  const { createInvoice, applyCreditIfNeeded } = require("./payment");
  const path = require("path");
  const { Markup } = require("telegraf");
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
    getDisplayLabel, // 👈 добавляем
    infoMenu,
    instructionsMenu,
  } = require("./menus");
  const MARZBAN_API_URL = process.env.MARZBAN_API_URL;


  /* Утилита: безопасное редактирование сообщения */
  async function editOrAnswer(ctx, text, keyboard) {
    try {
      const currentText = ctx.callbackQuery?.message?.text;
      const currentKb = JSON.stringify(
        ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || []
      );
      const nextKb = JSON.stringify(keyboard?.reply_markup?.inline_keyboard || []);

      if (currentText === text && currentKb === nextKb) {
        await ctx.answerCbQuery("Актуально");
        return;
      }
      await ctx.editMessageText(text, keyboard);
    } catch (err) {
      const desc = err?.response?.description || err?.message || "";
      if (desc.includes("message is not modified")) {
        await ctx.answerCbQuery("Актуально");
        return;
      }
      if (desc.includes("message can't be edited")) {
        await ctx.reply(text, keyboard);
        return;
      }
      console.error("editOrAnswer error:", desc);
    }
  }

  /* Регистрируем все действия */
  function registerActions(bot) {
    // Информация — баланс и подписки
bot.action("instructions", async (ctx) => {
  await ctx.answerCbQuery();
  await editOrAnswer(ctx, "📖 Выберите платформу:", instructionsMenu());
});

// Утилита для чтения файлов с инструкцией
function getText(fileName) {
  const filePath = path.join(__dirname, "texts", fileName);
  return fs.readFileSync(filePath, "utf-8");
}

// iOS / macOS
bot.action("guide_ios", async (ctx) => {
  await ctx.answerCbQuery();
  const text = getText("ios-macos.txt");
  await editOrAnswer(ctx, text, instructionsMenu());
});

// Android
bot.action("guide_android", async (ctx) => {
  await ctx.answerCbQuery();
  const text = getText("android.txt");
  await editOrAnswer(ctx, text, instructionsMenu());
});

// Windows
bot.action("guide_windows", async (ctx) => {
  await ctx.answerCbQuery();
  const text = getText("windows.txt");
  await editOrAnswer(ctx, text, instructionsMenu());
});
    // Купить подписку — вывод планов
    bot.action("buy", async (ctx) => {
      await ctx.answerCbQuery();
      await editOrAnswer(ctx, "Выберите подписку:", buyMenu());
    });

    // Покупка конкретного плана
  const fetch = require("node-fetch"); // нужен npm i node-fetch@2

  // Информация — теперь открывает подменю
bot.action("info", async (ctx) => {
  await ctx.answerCbQuery();
  await editOrAnswer(ctx, "ℹ️ Информация:", infoMenu(ctx.dbUser.balance));
});


// Пользовательское соглашение
bot.action("tos", async (ctx) => {
  await ctx.answerCbQuery();
  const text = fs.readFileSync("texts/tos.txt", "utf8");
  await editOrAnswer(ctx, text, infoMenu(ctx.dbUser.balance));
});

// Политика конфиденциальности
bot.action("privacy", async (ctx) => {
  await ctx.answerCbQuery();
  const text = fs.readFileSync("texts/privacy.txt", "utf8");
  await editOrAnswer(ctx, text, infoMenu(ctx.dbUser.balance));
});

  // внутри registerActions(bot)
  bot.action(/^buy_(M1|M3|M6|M12)$/, async (ctx) => {
    await ctx.answerCbQuery();
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
        await editOrAnswer(
          ctx,
          `❌ Недостаточно средств для покупки: ${plan.label} за ${ruMoney(plan.price)}.\nПополните баланс в меню «Баланс».`,
          buyMenu()
        );
        return;
      }

      // 🔥 ВЫЗОВ MARZBAN API
      const expireSeconds = plan.months === 12 ? 365*24*60*60 : plan.months*30*24*60*60;
      const expire = Math.floor(Date.now() / 1000) + expireSeconds;

      const username = `${ctx.dbUser.telegramId}_${plan.type}_${result.sub.id}`;

      const apiResponse = await fetch(`${MARZBAN_API_URL}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
          username, // 🔥 теперь имя = telegramId_срок_idПодписки
          status: "active",
          expire,
          proxies: { vless: {} },
          note: `Telegram user ${ctx.dbUser.accountName || ctx.dbUser.telegramId}`,
      }),
      });


      if (!apiResponse.ok) {
        console.error("Marzban API error", await apiResponse.text());
      } else {
        const apiUser = await apiResponse.json();

        // допустим, в ответе Marzban есть subscription_url
        const subscriptionUrl = apiUser?.subscription_url || null;

        // сохраняем в БД
        await prisma.subscription.update({
          where: { id: result.sub.id },
          data: { subscriptionUrl },
        });
      }

let successText = `✅ Подписка оформлена: ${plan.label}
Действует до: ${formatDate(result.sub.endDate)}

Текущий баланс: ${ruMoney(result.balance)}

ℹ️ Чтобы установить подписку на ваше устройство, перейдите в раздел «Инструкции».`;

// если в ответе от API пришла ссылка и мы её сохранили
const lastSub = await prisma.subscription.findUnique({ where: { id: result.sub.id } });
if (lastSub.subscriptionUrl) {
  successText += `\n\n🔗 Ваша ссылка: ${lastSub.subscriptionUrl}`;
}

// Добавляем кнопку "Инструкции" в меню
const keyboard = Markup.inlineKeyboard([
  [Markup.button.callback("📖 Инструкции", "instructions")],
  [Markup.button.callback("⬅️ В меню", "back")]
]);

await editOrAnswer(ctx, successText, keyboard);


    } catch (e) {
      console.error("buy error:", e);
      await editOrAnswer(ctx, "Произошла ошибка. Попробуйте позже.", buyMenu());
    }
  });


    // Баланс — показать и пополнить
    bot.action("balance", async (ctx) => {
      await ctx.answerCbQuery();
      const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
      const text = `💼 Баланс: ${ruMoney(user.balance)}\nВыберите сумму пополнения:`;
      await editOrAnswer(ctx, text, topupMenu());
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
    await ctx.answerCbQuery();
    const amount = parseInt(ctx.match[1], 10);
    if (isNaN(amount) || amount <= 0) {
      console.warn(`[TOPUP] Invalid amount: "${ctx.match[1]}"`);
      return ctx.reply("Некорректная сумма пополнения.", topupMenu());
    }

    console.log(`[TOPUP] User ${ctx.dbUser.id} requested topup for ${amount} ₽`);
    try {
      const { link, topup } = await createInvoice(ctx.dbUser.id, amount);
      console.log(`[TOPUP] Created invoice: id=${topup.id}, orderId=${topup.orderId}, amount=${topup.amount}`);

      await ctx.reply(
        `💳 Для пополнения на ${ruMoney(amount)} перейдите по ссылке:\n${link}\n\nПосле оплаты вернитесь сюда и нажмите "Проверить оплату".`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Проверить оплату", `check_topup_${topup.id}`)],
          [Markup.button.callback("⬅️ Назад", "back")],
        ])
      );
    } catch (e) {
      console.error("[TOPUP] Error creating invoice:", e);
      await ctx.reply("Ошибка при создании счёта. Попробуйте позже.", topupMenu());
    }
  });

  bot.action(/^check_topup_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1], 10);
    if (isNaN(id)) {
      console.warn(`[CHECK] Invalid topup id: "${ctx.match[1]}"`);
      return ctx.reply("Некорректный запрос проверки оплаты.");
    }

    console.log(`[CHECK] User ${ctx.dbUser.id} is checking topup id=${id}`);

    try {
      const topup = await prisma.topUp.findUnique({ where: { id } });
      if (!topup || topup.userId !== ctx.dbUser.id) {
        console.warn(`[CHECK] Topup not found or another user. id=${id}, userId=${ctx.dbUser.id}`);
        return ctx.reply("Пополнение не найдено.");
      }

      console.log(`[CHECK] Found topup: id=${topup.id}, amount=${topup.amount}, status=${topup.status}, orderId=${topup.orderId}, credited=${topup.credited}`);

      if (topup.status === "SUCCESS") {
        // ✅ Пытаемся зачислить (идемпотентно)
        const creditRes = await applyCreditIfNeeded(topup.id);
        console.log("[CHECK] applyCreditIfNeeded:", creditRes);

        const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
        return ctx.reply(`✅ Оплата подтверждена!\nБаланс: ${ruMoney(user.balance)}`);
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
      await ctx.answerCbQuery();

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
      await ctx.answerCbQuery();
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

      const buttons = [[Markup.button.callback("⬅️ Назад", "my_subs")]];

      // Только для платных подписок (M1, M3, M6, M12) добавим кнопку продления
      if (s.type !== "FREE") {
        buttons.unshift([Markup.button.callback("🔄 Продлить", `extend_choose_${s.id}`)]);
      }

      await editOrAnswer(ctx, text, Markup.inlineKeyboard(buttons));
    });

  // Меню выбора срока продления
  bot.action(/extend_choose_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
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
      await editOrAnswer(
        ctx,
        `❌ Недостаточно средств для продления (${plan.label} за ${ruMoney(plan.price)}).\nПополните баланс.`,
        mainMenu(user.balance)
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
          data: { endDate: newEndDate },
        });
      });

      // 🔥 вызов Marzban API extend
      try {
        const username = `${ctx.dbUser.telegramId}_${sub.type}_${sub.id}`;
        const days = plan.months * 30;

        const apiResponse = await fetch(
          `${MARZBAN_API_URL}/users/${username}/extend?days=${days}`,
          { method: "POST" }
        );

        if (!apiResponse.ok) {
          console.error("Marzban extend error:", await apiResponse.text());
        }
      } catch (err) {
        console.error("Ошибка при вызове extend:", err);
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

    // Назад — главное меню
    bot.action("back", async (ctx) => {
      await ctx.answerCbQuery();
      const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
      await editOrAnswer(ctx, "Выберите действие:", mainMenu(user.balance));
    });
  }

  module.exports = { registerActions };
