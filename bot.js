const { Telegraf } = require("telegraf");
const { prisma } = require("./db");
const { SubscriptionType } = require("@prisma/client");
const { mainMenu } = require("./menus");
const { registerActions } = require("./actions");
const { registerPromo } = require("./promo");  // 👈
const crypto = require("crypto");


const bot = new Telegraf(process.env.BOT_TOKEN);

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
  const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
  await ctx.reply("Добро пожаловать! 👋\nВыберите действие:", mainMenu(user.balance));
});

bot.command("menu", async (ctx) => {
  const user = await prisma.user.findUnique({ where: { id: ctx.dbUser.id } });
  await ctx.reply("Меню:", mainMenu(user.balance));
});

/* 👇 Обязательно регистрируем действия ДО экспорта */
registerActions(bot);
registerPromo(bot);

module.exports = { bot };
