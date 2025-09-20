const { Telegraf } = require("telegraf");
const { prisma } = require("./db");
const { SubscriptionType } = require("@prisma/client");
const { mainMenu } = require("./menus");
const { registerActions } = require("./actions");

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

      ctx.dbUser = user;
    }
  } catch (e) {
    console.error("User middleware failed:", e);
  }
  return next();
});

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

module.exports = { bot };
