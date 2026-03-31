const { Telegraf } = require("telegraf");
const { prisma } = require("./db");
const { SubscriptionType } = require("@prisma/client");
const { mainMenu, planSelectedMenu, PLANS, ruMoney, getPlanPrice, getDiscountBanner, isDiscountActive } = require("./menus");
const { registerActions } = require("./actions");
const { registerPromo } = require("./promo");
const { redeemClaim } = require("./hp-claim");
const { remnawaveGetUser, remnawaveResolveUuidByUsername } = require("./marzban-utils");
const crypto = require("crypto");


const bot = new Telegraf(process.env.BOT_TOKEN);

/* Логирование входящих апдейтов (группы/каналы) — чтобы понять, доходят ли сообщения из админ-чата */
const ADMIN_GROUP_ID_ENV = (process.env.ADMIN_GROUP_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
bot.use((ctx, next) => {
  const chat = ctx.chat;
  const chatId = chat?.id;
  const chatType = chat?.type;
  const isGroupOrChannel = chatType === "group" || chatType === "supergroup" || chatType === "channel";
  if (isGroupOrChannel && chatId != null) {
    const updateType = ctx.updateType;
    const msg = ctx.message || ctx.editedMessage || ctx.channelPost || ctx.editedChannelPost;
    const text = msg?.text || msg?.caption || ctx.callbackQuery?.data || "";
    const from = ctx.from?.id || ctx.channelPost?.sender_chat?.id || ctx.callbackQuery?.from?.id || "?";
    console.log(`[BOT] ← update=${updateType} chatId=${chatId} from=${from} text=${String(text).slice(0, 80) || "[пусто]"}`);
    if (updateType === "message" && !text && msg) {
      const keys = Object.keys(msg).filter((k) => k !== "from" && k !== "chat");
      console.log(`[BOT] message без text: keys=${keys.join(",")}`);
    }
  }
  return next();
});

/* Middleware: учёт пользователя */
bot.use(async (ctx, next) => {

  try {
    const from = ctx.from;
    const chat = ctx.chat;
    if (from && chat) {
      const telegramId = String(from.id);
      const chatId = String(chat.id);
      const accountName = from.username ? `@${from.username}` : null;

      const user = await prisma.user.upsert({
        where: { telegramId_chatId: { telegramId, chatId } },
        update: { accountName },
        create: { telegramId, chatId, accountName, balance: 0 },
      });

      const freeExists = await prisma.subscription.findFirst({
        where: { userId: user.id, type: SubscriptionType.FREE },
      });
      if (!freeExists) {
        await prisma.subscription.create({
          data: { userId: user.id, type: SubscriptionType.FREE, endDate: null },
        });
      }
      // 👇 добавляем
if (!user.promoCode) {
  // несколько попыток на случай коллизии уникального индекса
  let code = null, attempts = 0;
  while (!code && attempts < 5) {
    const candidate = genPromo();
    try {
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { promoCode: candidate },
      });
      code = updated.promoCode;
    } catch (e) {
      if (e.code === "P2002") { // unique violation
        attempts++;
      } else {
        throw e;
      }
    }
  }
}

      ctx.dbUser = user;
    }
  } catch (e) {
    console.error("User middleware failed:", e);
  }
  return next();
});

// простой генератор кода: 8 символов HEX
function genPromo() {
  return crypto.randomBytes(4).toString("hex").toUpperCase(); // напр. 'A1B2C3D4'
}

/* Команды */
bot.start(async (ctx) => {
  if (!ctx.dbUser || !ctx.dbUser.id) {
    console.error("[BOT] ctx.dbUser is undefined in /start command");
    return ctx.reply("❌ Ошибка инициализации. Попробуйте еще раз.");
  }

  const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
  if (!user) {
    console.error("[BOT] User not found in database:", ctx.dbUser.id);
    return ctx.reply("❌ Пользователь не найден. Попробуйте еще раз.");
  }

  const raw = (ctx.message?.text || "").trim();

  // /start hp_claim_<username>  (новый flow: token == username Remnawave)
  // fallback: если по username не нашли — пробуем legacy redeem на сайте
  const claimMatch = raw.match(/^\/start(?:@\w+)?\s+(hp_claim_[A-Za-z0-9._~-]+)$/i);
  if (claimMatch) {
    const arg = claimMatch[1];
    const claimArg = arg.startsWith("hp_claim_") ? arg.slice("hp_claim_".length) : "";
    if (!claimArg) {
      await ctx.reply("❌ Некорректный параметр. Откройте ссылку из сайта заново.");
      return;
    }

    try {
      await ctx.reply("⏳ Привязываю подписку к Telegram...");

      const telegramId = Number(ctx.from?.id);
      const username = ctx.from?.username || null;

      // Variant A: claimArg == Remnawave username (например: trial_dd3f4f2251f2)
      // Привязка делается В БД БОТА (без PATCH в Remnawave)
      const rwUser = await remnawaveGetUser(claimArg);
      let remnawaveUuid = rwUser?.uuid || null;
      let usedName = rwUser?.username || claimArg;
      let subscriptionUrl = rwUser?.subscriptionUrl || null;
      let endDate = null;
      if (rwUser?.expireAt) {
        const d = new Date(rwUser.expireAt);
        if (!Number.isNaN(d.getTime())) endDate = d;
      }

      // Fallback: legacy redeem (Variant B) — если username не найден
      if (!remnawaveUuid) {
        const redeemed = await redeemClaim({ token: claimArg, telegramId, username });
        if (!redeemed.ok) {
          if (redeemed.status === 409) {
            await ctx.reply("✅ Бонус уже получали ранее.", mainMenu(user.balance));
            return;
          }
          if (redeemed.status === 410) {
            await ctx.reply("⏳ Токен истёк. Вернитесь на сайт и получите новый.", mainMenu(user.balance));
            return;
          }
          if (redeemed.status === 404) {
            await ctx.reply("❌ Не найдено. Проверьте ссылку и попробуйте снова.", mainMenu(user.balance));
            return;
          }
          if (redeemed.status === 401) {
            await ctx.reply("❌ Ошибка конфигурации (ключ сайта не совпадает). Сообщите администратору.", mainMenu(user.balance));
            return;
          }
          throw new Error(`redeem failed: ${redeemed.status} ${String(redeemed.text || "").slice(0, 200)}`);
        }

        const body = redeemed.data || {};
        const subscriptionUuid = body.subscriptionUuid;
        const trialUsername = body.trialUsername;
        bonusGb = body.bonusGb ?? 1;
        console.log("[CLAIM] redeem ok:", {
          subscriptionUuidPreview: typeof subscriptionUuid === "string" ? subscriptionUuid.slice(0, 32) : null,
          trialUsername: trialUsername || null,
          bonusGb,
        });

        const candidates = [trialUsername, subscriptionUuid].filter((s) => typeof s === "string" && s.trim());
        for (const c of candidates) {
          const info = await remnawaveGetUser(c);
          if (!info?.uuid) continue;
          remnawaveUuid = info.uuid;
          usedName = info.username || c;
          subscriptionUrl = info.subscriptionUrl || subscriptionUrl;
          if (info.expireAt) {
            const d = new Date(info.expireAt);
            if (!Number.isNaN(d.getTime())) endDate = d;
          }
          break;
        }
      }

      if (!remnawaveUuid) throw new Error("Cannot resolve Remnawave uuid for claim");

      // Привязываем подписку к пользователю в нашей БД:
      // создаём запись Subscription, если её ещё нет у этого пользователя
      const already = await prisma.subscription.findFirst({
        where: { userId: user.id, remnawaveUuid },
      });
      if (!already) {
        await prisma.subscription.create({
          data: {
            userId: user.id,
            type: "FREE",
            remnawaveUuid,
            subscriptionUrl: subscriptionUrl,
            endDate: endDate,
          },
        });
      }

      const nameLine = usedName ? `\n👤 Подписка: ${usedName}` : "";
      await ctx.reply(
        `✅ Подписка привязана к Telegram.\n${nameLine}\n\nОткройте «Мои подписки» и нажмите «Подключить».`,
        mainMenu(user.balance)
      );
      return;
    } catch (e) {
      console.error("[CLAIM] /start hp_claim error:", e);
      const msg = String(e?.message || e || "");
      const extra =
        msg.includes("REMNAWAVE_TELEGRAM_FAILED 404") || msg.includes("REMNAWAVE_TRAFFIC_FAILED 404")
          ? "\n\nПохоже, Remnawave ещё не видит созданную подписку. Подождите 10–20 секунд и нажмите ссылку ещё раз."
          : "";
      await ctx.reply(`❌ Не удалось активировать токен.\n${msg}${extra}`, mainMenu(user.balance));
      return;
    }
  }

  const planMatch = raw.match(/^\/start(?:@\w+)?\s+plan_(D7|M1|M3|M6|M12)$/i);

  if (planMatch) {
    const planKey = planMatch[1].toUpperCase();
    const plan = PLANS[planKey];
    if (!plan) {
      await ctx.reply("❌ Неизвестный план. Выберите действие:", mainMenu(user.balance));
      return;
    }

    const price = getPlanPrice(planKey);
    const banner = getDiscountBanner();
    const discountLine = banner ? `\n\n${banner}\n` : "";
    const planText = `🛒 Выбран тариф: **${plan.label}** — ${ruMoney(price)}${discountLine}Оплата производится с баланса в боте. Если средств не хватает — пополните баланс, затем нажмите «Приобрести».

Выберите действие:`;

    await ctx.replyWithMarkdown(planText, planSelectedMenu(planKey));
    return;
  }

  const welcomeText = `👋 Вас приветствует MaxGroot!

Этот сервис для защиты вашего интернета.

📌 Все новости и обновления
@vpnmax_off

Выберите действие:`;

  await ctx.reply(welcomeText, mainMenu(user.balance));
});

// Команда /chatid — показать ID чата (для настройки ADMIN_GROUP_ID)
bot.command("chatid", async (ctx) => {
  const c = ctx.chat;
  const id = c ? String(c.id) : "?";
  const type = c?.type || "?";
  await ctx.reply(`🆔 Chat ID: \`${id}\`\nТип: ${type}\n\nДобавь в .env:\nADMIN_GROUP_ID=${id}`, { parse_mode: "Markdown" });
});

bot.command("menu", async (ctx) => {
  // Проверяем, что пользователь был создан в middleware
  if (!ctx.dbUser || !ctx.dbUser.id) {
    console.error("[BOT] ctx.dbUser is undefined in /menu command");
    return ctx.reply("❌ Ошибка инициализации. Попробуйте еще раз.");
  }
  
  const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
  
  if (!user) {
    console.error("[BOT] User not found in database:", ctx.dbUser.id);
    return ctx.reply("❌ Пользователь не найден. Попробуйте еще раз.");
  }
  
  await ctx.reply("Меню:", mainMenu(user.balance));
});

/* Глобальный обработчик ошибок для бота */
bot.catch((err, ctx) => {
  // Игнорируем ошибки устаревших callback query
  if (err.response?.error_code === 400 && 
      (err.response?.description?.includes("query is too old") || 
       err.response?.description?.includes("query ID is invalid"))) {
    // Это нормально - запрос устарел, просто логируем и игнорируем
    console.warn("[BOT] Expired callback query ignored:", ctx.callbackQuery?.data || "unknown");
    return;
  }
  
  // Логируем другие ошибки
  console.error("[BOT] Global error handler:", err.message || err);
  console.error("[BOT] Update type:", ctx.updateType);
  console.error("[BOT] Update ID:", ctx.update?.update_id);
  
  // Не пытаемся отправлять сообщение об ошибке - это может вызвать еще больше ошибок
  // Просто логируем и продолжаем работу
});

/* 👇 Обязательно регистрируем действия ДО экспорта */
registerActions(bot);
registerPromo(bot);

module.exports = { bot };
