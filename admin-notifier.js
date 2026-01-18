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
 * Получить статистику за период
 */
async function getStats(startDate, endDate) {
  const topups = await prisma.topUp.findMany({
    where: {
      status: "SUCCESS",
      credited: true,
      creditedAt: {
        gte: startDate,
        lte: endDate,
      },
    },
  });

  const totalAmount = topups.reduce((sum, t) => sum + t.amount, 0);
  const count = topups.length;

  return { count, totalAmount };
}

/**
 * Получить статистику за сегодня
 */
async function getTodayStats() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  
  return getStats(startOfDay, endOfDay);
}

/**
 * Получить статистику за неделю
 */
async function getWeekStats() {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - 7);
  startOfWeek.setHours(0, 0, 0, 0);
  
  return getStats(startOfWeek, now);
}

/**
 * Отправить ежедневную статистику
 */
async function sendDailyStats() {
  try {
    const todayStats = await getTodayStats();
    const weekStats = await getWeekStats();

    const text = `📊 <b>Статистика пополнений</b>

📅 <b>Сегодня:</b>
• Транзакций: ${todayStats.count}
• Сумма: ${ruMoney(todayStats.totalAmount)}

📆 <b>За 7 дней:</b>
• Транзакций: ${weekStats.count}
• Сумма: ${ruMoney(weekStats.totalAmount)}

⏰ ${formatDate(new Date())}`;

    await sendToAdminGroup(text);
    console.log("[ADMIN] Daily stats sent");
  } catch (err) {
    console.error("[ADMIN] Ошибка отправки статистики:", err.message);
  }
}

/**
 * Инициализация админ-нотификатора
 */
function initAdminNotifier(bot) {
  botInstance = bot;

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
  scheduleDaily(20, 0, sendDailyStats);

  console.log("📢 Admin notifier initialized (group: " + ADMIN_GROUP_ID + ")");
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
  sendDailyStats,
  getTodayStats,
  getWeekStats,
  sendToAdminGroup,
};
