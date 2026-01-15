// promo.js
const { prisma } = require("./db");
const { Markup } = require("telegraf");
const { ruMoney, promoMenu, PLANS } = require("./menus");
const { SubscriptionType } = require("@prisma/client");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const MARZBAN_API_URL = process.env.MARZBAN_API_URL;

// Кросс-платформенная функция для создания ссылки поделиться (работает на компе и мобильном)
function shareLink(text) {
  // Для отправки текста используем формат с пустым url параметром
  // Это работает на всех платформах (компьютер, мобильный, веб)
  const base = "https://t.me/share/url";
  return `${base}?url=&text=${encodeURIComponent(text)}`;
}

// Функция для создания пользователя в Marzban API
async function createMarzbanUser(telegramId, subscriptionId) {
  console.log("[DEBUG] MARZBAN_API_URL:", MARZBAN_API_URL);
  
  if (!MARZBAN_API_URL || MARZBAN_API_URL === "your_marzban_api_url") {
    console.log("[DEBUG] Using fake URL - API not configured");
    // Если API не настроен, возвращаем фейковую ссылку
    return `https://fake-vpn.local/subscription/${subscriptionId}`;
  }

  const username = `${telegramId}_PROMO_${subscriptionId}`;
  const expireSeconds = 3 * 24 * 60 * 60; // 3 дня в секундах
  const expire = Math.floor(Date.now() / 1000) + expireSeconds;

  const userData = {
    username: username,
    proxies: {
      vless: {
        id: require("crypto").randomUUID(),
        flow: "xtls-rprx-vision"
      }
    },
    inbounds: { vless: ["VLESS TCP REALITY", "VLESS-TCP-REALITY-VISION"] },
    expire: expire,
    data_limit: 0, // без ограничений
    data_limit_reset_strategy: "no_reset"
  };

  try {
    console.log("[DEBUG] Sending request to Marzban API:", `${MARZBAN_API_URL}/users`);
    console.log("[DEBUG] User data:", JSON.stringify(userData, null, 2));
    
    const response = await fetch(`${MARZBAN_API_URL}/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MARZBAN_TOKEN || "fake_token"}`
      },
      body: JSON.stringify(userData)
    });

    console.log("[DEBUG] Response status:", response.status);
    console.log("[DEBUG] Response headers:", response.headers);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Marzban] Failed to create user:", errorText);
      return `https://fake-vpn.local/subscription/${subscriptionId}`;
    }

    const result = await response.json();
    console.log("[DEBUG] Marzban response:", JSON.stringify(result, null, 2));
    return result.subscription_url || `https://fake-vpn.local/subscription/${subscriptionId}`;
  } catch (error) {
    console.error("[Marzban] Error creating user:", error);
    return `https://fake-vpn.local/subscription/${subscriptionId}`;
  }
}

function registerPromo(bot) {
  // Экран промокода
  bot.action("promo", async (ctx) => {
    await ctx.answerCbQuery();
    const me = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });

    // Получаем статистику активаций
    const activations = await prisma.promoActivation.count({
      where: { codeOwnerId: me.id },
    });

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
`🎁 Ваш промокод: \`${me.promoCode}\`

📊 Статистика:
✅ Активаций: ${activations}

🎯 Подарок: любой пользователь, который активирует ваш код, получит VPN на 3 дня с обходом блокировок мобильной связи. 

💡 Вы сами можете активировать только ЧУЖОЙ промокод один раз.`;

    // Создаем информативное сообщение для пересылки
    // Используем полную ссылку https://t.me/... для корректного распознавания как ссылки
    const shareMessage = `🎁 Промокод на VPN с обходом блокировок мобильной связи!

🔑 Промокод: ${me.promoCode}

✨ Подарок: VPN на 3 дня с белыми IP адресами для обхода блокировок мобильных операторов.

📱 Как активировать:
1. Перейдите в бота: ${botLink}
2. Нажмите кнопку "🎁 Промокод" в главном меню
3. Выберите "🎁 Активировать чужой промокод"
4. Введите команду: /promo ${me.promoCode}

⚡ После активации вы получите ссылку на подписку и инструкции по настройке.

🔓 Используйте VPN даже там, где оператор блокирует VPN-сервисы!`;

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
    const text =
`✍️ Введите команду в чат:
\`/promo ВАШ_КОД\`

Например: \`/promo A1B2C3D4\``;
    await ctx.replyWithMarkdown(text, promoMenu());
  });

  // Команда активации: /promo ABCD1234
  bot.command("promo", async (ctx) => {
    const raw = ctx.message?.text || "";
    const match = raw.trim().match(/^\/promo(?:@\w+)?\s+([A-Z0-9-]{4,32})$/i);

    if (!match) {
      return ctx.reply("Укажите код: /promo ВАШ_КОД");
    }

    const inputCode = match[1].toUpperCase();

    try {
      const result = await prisma.$transaction(async (tx) => {
        const me = await tx.user.findUnique({ where: { id: ctx.dbUser.id } });

        // код должен существовать
        const owner = await tx.user.findUnique({
          where: { promoCode: inputCode },
        });
        if (!owner) return { ok: false, reason: "NOT_FOUND" };

        // нельзя активировать свой
        if (owner.id === me.id) return { ok: false, reason: "SELF" };

        // уже активировал раньше любой код?
        const already = await tx.promoActivation.findUnique({
          where: { activatorId: me.id },
        });
        if (already) return { ok: false, reason: "ALREADY" };

        // создаём запись активации
        await tx.promoActivation.create({
          data: {
            codeOwnerId: owner.id,
            activatorId: me.id,
            amount: 0, // больше не начисляем деньги
          },
        });

        // создаём подписку на 3 дня
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 3);
        
        const sub = await tx.subscription.create({
          data: {
            userId: me.id,
            type: SubscriptionType.PROMO_10D,
            startDate: new Date(),
            endDate: endDate,
          },
        });

        return { ok: true, owner, sub };
      });

      if (!result.ok) {
        if (result.reason === "NOT_FOUND")
          return ctx.reply("❌ Такой промокод не найден.");
        if (result.reason === "SELF")
          return ctx.reply("❌ Нельзя активировать свой промокод.");
        if (result.reason === "ALREADY")
          return ctx.reply("❌ Вы уже активировали промокод ранее.");
        return ctx.reply("❌ Не удалось активировать промокод.");
      }

      // создаём VPN пользователя в Marzban и получаем ссылку
      const subscriptionUrl = await createMarzbanUser(ctx.dbUser.telegramId, result.sub.id);
      
      // обновляем подписку с полученной ссылкой
      await prisma.subscription.update({
        where: { id: result.sub.id },
        data: { subscriptionUrl }
      });

      // оповестим владельца кода (если возможен DM)
      try {
        const owner = result.owner;
        if (owner.chatId) {
          await ctx.telegram.sendMessage(
            owner.chatId,
            `🎉 Ваш промокод активирован пользователем ${ctx.dbUser.accountName || ctx.dbUser.telegramId}`
          );
        }
      } catch (e) {
        // молча игнорируем
      }

      // показываем успешную активацию с ссылкой на VPN
      const successMessage = `✅ Промокод применён! Вы получили VPN на 3 дня с обходом блокировок мобильной связи.

🔗 Ссылка на подписку: ${subscriptionUrl}

📱 Как использовать:
1. Скопируйте ссылку выше
2. Откройте приложение Happ на вашем устройстве
3. Нажмите "+" → "Import from URL"
4. Вставьте ссылку и нажмите "Import"
5. Включите VPN кнопкой "Connect"

🔓 Теперь вы можете использовать VPN даже там, где оператор блокирует VPN-сервисы!

💡 Если нужна помощь, смотрите инструкции в разделе "📖 Инструкции"`;

      return ctx.reply(successMessage);
    } catch (e) {
      console.error("[PROMO] error:", e);
      return ctx.reply("Ошибка при активации промокода. Попробуйте позже.");
    }
  });
}

module.exports = { registerPromo };
