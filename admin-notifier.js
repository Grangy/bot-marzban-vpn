// admin-notifier.js - Уведомления о транзакциях в админ-группу + статистика
const bus = require("./events");
const { prisma } = require("./db");
const { ruMoney } = require("./menus");

// ID группы для уведомлений
const ADMIN_GROUP_ID = "-5184781938";

let botInstance = null;

/**
 * Форматирование даты
 */
function formatDate(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
async function getSubscriptionStats(startDate, endDate) {
  // Подписки созданные за период (только платные: M1, M3, M6, M12)
  const subscriptions = await prisma.subscription.findMany({
    where: {
      type: { in: ["M1", "M3", "M6", "M12"] },
      createdAt: {
        gte: startDate,
        lte: endDate,
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
 * Получить статистику подписок за неделю
 */
async function getWeekSubscriptionStats() {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - 7);
  startOfWeek.setHours(0, 0, 0, 0);
  
  return getSubscriptionStats(startOfWeek, now);
}

/**
 * Сформировать красивый текст статистики
 */
async function generateStatsMessage() {
  const todayStats = await getTodayStats();
  const weekStats = await getWeekStats();
  const monthStats = await getMonthStats();
  const userStats = await getUserStats();
  const weekSubStats = await getWeekSubscriptionStats();

  const text = `📊 <b>Статистика MaxGroot VPN</b>

━━━━━━━━━━━━━━━━━━━━

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

━━━━━━━━━━━━━━━━━━━━

👥 <b>ПОЛЬЗОВАТЕЛИ</b>

├ 👤 Всего: <b>${userStats.totalUsers}</b>
├ 🆕 Новых сегодня: ${userStats.newUsersToday}
├ 📆 Новых за неделю: ${userStats.newUsersWeek}
├ 💳 С балансом: ${userStats.usersWithBalance}
├ 💰 Общий баланс: ${ruMoney(userStats.totalBalance)}
└ ✅ Активных подписок: ${userStats.activeSubscriptions}

━━━━━━━━━━━━━━━━━━━━

📦 <b>Купленные подписки (7 дней):</b>
├ 📅 1 месяц: ${weekSubStats.distribution.M1}
├ 📆 3 месяца: ${weekSubStats.distribution.M3}
├ 🗓 6 месяцев: ${weekSubStats.distribution.M6}
├ 📅 12 месяцев: ${weekSubStats.distribution.M12}
└ 📊 Всего: <b>${weekSubStats.total}</b>

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
