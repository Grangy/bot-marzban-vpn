// admin-notifier.js - Уведомления о транзакциях в админ-группу + статистика
const bus = require("./events");
const { prisma } = require("./db");
const { ruMoney } = require("./menus");

// ID группы для уведомлений
const ADMIN_GROUP_ID = "-5184781938";

let botInstance = null;

/**
 * Форматирование даты (МСК)
 */
function formatDate(date) {
  // Конвертируем в московское время (UTC+3)
  const mskDate = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(mskDate.getUTCDate())}.${pad(mskDate.getUTCMonth() + 1)}.${mskDate.getUTCFullYear()} ${pad(mskDate.getUTCHours())}:${pad(mskDate.getUTCMinutes())} МСК`;
}

/**
 * Отправить сообщение в админ-группу
 */
async function sendToAdminGroup(text) {
  if (!botInstance) {
    console.warn("[ADMIN] Bot instance not initialized");
    return;
  }
  
  try {
    await botInstance.telegram.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[ADMIN] Ошибка отправки в группу:", err.message);
  }
}

/**
 * Получить расширенную статистику за период
 */
async function getExtendedStats(startDate, endDate) {
  // Успешные пополнения
  const topups = await prisma.topUp.findMany({
    where: {
      status: "SUCCESS",
      credited: true,
      creditedAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: { user: true },
  });

  const totalAmount = topups.reduce((sum, t) => sum + t.amount, 0);
  const count = topups.length;
  const avgAmount = count > 0 ? Math.round(totalAmount / count) : 0;
  
  // Уникальные пользователи, которые пополняли
  const uniqueUsers = new Set(topups.map(t => t.userId)).size;

  return { 
    count, 
    totalAmount, 
    avgAmount, 
    uniqueUsers,
  };
}

/**
 * Получить статистику купленных подписок за период
 */
async function getSubscriptionStats(periodStart, periodEnd) {
  // Подписки созданные за период (только платные: M1, M3, M6, M12)
  const subscriptions = await prisma.subscription.findMany({
    where: {
      type: { in: ["M1", "M3", "M6", "M12"] },
      startDate: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
  });

  // Распределение по типам подписок
  const distribution = {
    M1: subscriptions.filter(s => s.type === "M1").length,
    M3: subscriptions.filter(s => s.type === "M3").length,
    M6: subscriptions.filter(s => s.type === "M6").length,
    M12: subscriptions.filter(s => s.type === "M12").length,
  };

  const total = subscriptions.length;

  return { distribution, total };
}

/**
 * Получить статистику пользователей
 */
async function getUserStats() {
  const totalUsers = await prisma.user.count();
  
  // Пользователи с балансом > 0
  const usersWithBalance = await prisma.user.count({
    where: { balance: { gt: 0 } },
  });
  
  // Общий баланс всех пользователей
  const balanceSum = await prisma.user.aggregate({
    _sum: { balance: true },
  });
  
  // Активные подписки (не FREE и не истекшие)
  const activeSubscriptions = await prisma.subscription.count({
    where: {
      type: { not: "FREE" },
      endDate: { gt: new Date() },
    },
  });
  
  // Новые пользователи за сегодня
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  const newUsersToday = await prisma.user.count({
    where: { createdAt: { gte: startOfDay } },
  });
  
  // Новые пользователи за неделю
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const newUsersWeek = await prisma.user.count({
    where: { createdAt: { gte: weekAgo } },
  });

  return {
    totalUsers,
    usersWithBalance,
    totalBalance: balanceSum._sum.balance || 0,
    activeSubscriptions,
    newUsersToday,
    newUsersWeek,
  };
}

/**
 * Получить статистику за сегодня
 */
async function getTodayStats() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  
  return getExtendedStats(startOfDay, endOfDay);
}

/**
 * Получить статистику за неделю
 */
async function getWeekStats() {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - 7);
  startOfWeek.setHours(0, 0, 0, 0);
  
  return getExtendedStats(startOfWeek, now);
}

/**
 * Получить статистику за месяц
 */
async function getMonthStats() {
  const now = new Date();
  const startOfMonth = new Date(now);
  startOfMonth.setDate(now.getDate() - 30);
  startOfMonth.setHours(0, 0, 0, 0);
  
  return getExtendedStats(startOfMonth, now);
}

/**
 * Получить статистику подписок за всё время
 */
async function getAllTimeSubscriptionStats() {
  // Начало времён - 2020 год
  const startDate = new Date(2020, 0, 1);
  const now = new Date();
  
  return getSubscriptionStats(startDate, now);
}

/**
 * Сформировать красивый текст статистики
 */
async function generateStatsMessage() {
  const todayStats = await getTodayStats();
  const weekStats = await getWeekStats();
  const monthStats = await getMonthStats();
  const userStats = await getUserStats();
  const allTimeSubStats = await getAllTimeSubscriptionStats();

  const text = `📊 <b>Статистика MaxGroot VPN</b>

━━━━━━━━━━

💰 <b>ПОПОЛНЕНИЯ</b>

📅 <b>Сегодня:</b>
├ 💵 Сумма: <b>${ruMoney(todayStats.totalAmount)}</b>
├ 📝 Транзакций: ${todayStats.count}
├ 👥 Уникальных: ${todayStats.uniqueUsers}
└ 📈 Средний чек: ${ruMoney(todayStats.avgAmount)}

📆 <b>За 7 дней:</b>
├ 💵 Сумма: <b>${ruMoney(weekStats.totalAmount)}</b>
├ 📝 Транзакций: ${weekStats.count}
├ 👥 Уникальных: ${weekStats.uniqueUsers}
└ 📈 Средний чек: ${ruMoney(weekStats.avgAmount)}

📅 <b>За 30 дней:</b>
├ 💵 Сумма: <b>${ruMoney(monthStats.totalAmount)}</b>
├ 📝 Транзакций: ${monthStats.count}
├ 👥 Уникальных: ${monthStats.uniqueUsers}
└ 📈 Средний чек: ${ruMoney(monthStats.avgAmount)}

━━━━━━━━━━

👥 <b>ПОЛЬЗОВАТЕЛИ</b>

├ 👤 Всего: <b>${userStats.totalUsers}</b>
├ 🆕 Новых сегодня: ${userStats.newUsersToday}
├ 📆 Новых за неделю: ${userStats.newUsersWeek}
├ 💳 С балансом: ${userStats.usersWithBalance}
├ 💰 Общий баланс: ${ruMoney(userStats.totalBalance)}
└ ✅ Активных подписок: ${userStats.activeSubscriptions}

━━━━━━━━━━

📦 <b>Купленные подписки:</b>
├ 📅 1 месяц: ${allTimeSubStats.distribution.M1}
├ 📆 3 месяца: ${allTimeSubStats.distribution.M3}
├ 🗓 6 месяцев: ${allTimeSubStats.distribution.M6}
├ 📅 12 месяцев: ${allTimeSubStats.distribution.M12}
└ 📊 Всего: <b>${allTimeSubStats.total}</b>

⏰ <i>${formatDate(new Date())}</i>`;

  return text;
}

/**
 * Отправить статистику (по команде или по расписанию)
 */
async function sendStats(chatId = null) {
  try {
    const text = await generateStatsMessage();
    
    if (chatId) {
      // Отправляем в конкретный чат (по команде)
      await botInstance.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
    } else {
      // Отправляем в админ-группу (по расписанию)
      await sendToAdminGroup(text);
    }
    
    console.log("[ADMIN] Stats sent");
  } catch (err) {
    console.error("[ADMIN] Ошибка отправки статистики:", err.message);
  }
}

/**
 * Инициализация админ-нотификатора
 */
function initAdminNotifier(bot) {
  botInstance = bot;

  // Команда /stat в админ-группе
  bot.command("stat", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    // Проверяем, что команда из админ-группы
    if (chatId !== ADMIN_GROUP_ID) {
      return; // Игнорируем команду из других чатов
    }
    
    await ctx.reply("⏳ Собираю статистику...");
    await sendStats(chatId);
  });

  // Команда /createpromo <сумма> - создать промокод на баланс
  bot.command("createpromo", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    // Проверяем, что команда из админ-группы
    if (chatId !== ADMIN_GROUP_ID) {
      return; // Игнорируем команду из других чатов
    }
    
    const text = ctx.message?.text || "";
    const match = text.match(/^\/createpromo\s+(\d+)$/);
    
    if (!match) {
      return ctx.reply("❌ Использование: /createpromo <сумма>\n\nПример: /createpromo 500");
    }
    
    const amount = parseInt(match[1], 10);
    
    if (amount < 1 || amount > 100000) {
      return ctx.reply("❌ Сумма должна быть от 1 до 100000 ₽");
    }
    
    try {
      // Генерируем уникальный код
      const crypto = require("crypto");
      const code = "GIFT" + crypto.randomBytes(4).toString("hex").toUpperCase();
      
      // Создаём промокод в БД
      await prisma.adminPromo.create({
        data: {
          code,
          amount,
          createdBy: String(ctx.from?.id || "unknown"),
        },
      });
      
      const msg = `✅ <b>Промокод создан!</b>

🎁 Код: <code>${code}</code>
💵 Номинал: <b>${ruMoney(amount)}</b>

📋 Для активации пользователь должен ввести:
<code>/promo ${code}</code>

⚠️ Код одноразовый, после использования станет недействительным.`;
      
      await ctx.reply(msg, { parse_mode: "HTML" });
      console.log(`[ADMIN] Created promo code ${code} for ${amount}₽ by ${ctx.from?.id}`);
    } catch (err) {
      console.error("[ADMIN] Error creating promo:", err);
      await ctx.reply("❌ Ошибка создания промокода: " + err.message);
    }
  });

  // Команда /promos - список активных промокодов
  bot.command("promos", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    if (chatId !== ADMIN_GROUP_ID) {
      return;
    }
    
    try {
      const promos = await prisma.adminPromo.findMany({
        where: { usedById: null },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      
      if (promos.length === 0) {
        return ctx.reply("📭 Нет активных промокодов");
      }
      
      let msg = "🎁 <b>Активные промокоды:</b>\n\n";
      
      for (const p of promos) {
        msg += `<code>${p.code}</code> — ${ruMoney(p.amount)}\n`;
      }
      
      msg += `\n📊 Всего: ${promos.length}`;
      
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (err) {
      console.error("[ADMIN] Error listing promos:", err);
      await ctx.reply("❌ Ошибка: " + err.message);
    }
  });

  // Уведомление о успешном пополнении
  bus.on("topup.success", async ({ topupId }) => {
    try {
      const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
      if (!topup) return;

      const user = await prisma.user.findUnique({ where: { id: topup.userId } });

      const username = user?.accountName || "Без username";
      const telegramId = user?.telegramId || "N/A";

      const text = `💰 <b>Успешное пополнение!</b>

👤 Пользователь: ${username}
🆔 Telegram ID: <code>${telegramId}</code>
💵 Сумма: <b>${ruMoney(topup.amount)}</b>
💳 Новый баланс: ${ruMoney(user?.balance || 0)}
🕐 Время: ${formatDate(new Date())}
📋 Order ID: <code>${topup.orderId}</code>`;

      await sendToAdminGroup(text);
      console.log(`[ADMIN] Success notification sent for topup=${topupId}`);
    } catch (err) {
      console.error("[ADMIN] Ошибка уведомления о пополнении:", err.message);
    }
  });

  // Запуск ежедневной статистики в 20:00
  scheduleDaily(20, 0, () => sendStats());

  console.log("📢 Admin notifier initialized (group: " + ADMIN_GROUP_ID + ")");
  console.log("📊 Command /stat available in admin group");
}

/**
 * Планировщик ежедневной задачи
 */
function scheduleDaily(hour, minute, callback) {
  const now = new Date();
  let scheduledTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
  
  // Если время уже прошло сегодня, планируем на завтра
  if (scheduledTime <= now) {
    scheduledTime.setDate(scheduledTime.getDate() + 1);
  }
  
  const delay = scheduledTime - now;
  
  setTimeout(() => {
    callback();
    // Повторяем каждые 24 часа
    setInterval(callback, 24 * 60 * 60 * 1000);
  }, delay);
  
  console.log(`📅 Daily stats scheduled at ${hour}:${String(minute).padStart(2, "0")}`);
}

module.exports = {
  initAdminNotifier,
  sendStats,
  getTodayStats,
  getWeekStats,
  getMonthStats,
  getUserStats,
  sendToAdminGroup,
  ADMIN_GROUP_ID,
};
