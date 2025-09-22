// promo.js
const { prisma } = require("./db");
const { Markup } = require("telegraf");
const { ruMoney, promoMenu } = require("./menus");

const PROMO_BONUS = 100;

function shareLink(text) {
  const base = "https://t.me/share/url";
  return `${base}?text=${encodeURIComponent(text)}`;
}

function registerPromo(bot) {
  // Экран промокода
  bot.action("promo", async (ctx) => {
    await ctx.answerCbQuery();
    const me = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });

    const activations = await prisma.promoActivation.count({
      where: { codeOwnerId: me.id },
    });

    const msg =
`🎁 Ваш промокод: \`${me.promoCode}\`
Активаций: ${activations}

Подарок: любой пользователь, который введёт ваш код, получит +${ruMoney(PROMO_BONUS)}. 
Вы сами можете активировать только ЧУЖОЙ код один раз (команда ниже).`;

    const shareText = `Мой промокод ${me.promoCode} — бонус +${PROMO_BONUS}₽`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.url("🔗 Поделиться кодом", shareLink(shareText))],
      [Markup.button.callback("🎁 Активировать чужой промокод", "promo_activate")],
      [Markup.button.callback("⬅️ Назад", "back")],
    ]);

    await ctx.replyWithMarkdown(msg, kb);
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

        // создаём запись и зачисляем бонус
        await tx.promoActivation.create({
          data: {
            codeOwnerId: owner.id,
            activatorId: me.id,
            amount: PROMO_BONUS,
          },
        });

        await tx.user.update({
          where: { id: me.id },
          data: { balance: { increment: PROMO_BONUS } },
        });

        return { ok: true, owner };
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

      // покажем новый баланс
      const meAfter = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
      return ctx.reply(`✅ Промокод применён! Бонус: +${ruMoney(PROMO_BONUS)}\nНовый баланс: ${ruMoney(meAfter.balance)}`);
    } catch (e) {
      console.error("[PROMO] error:", e);
      return ctx.reply("Ошибка при активации промокода. Попробуйте позже.");
    }
  });
}

module.exports = { registerPromo };
