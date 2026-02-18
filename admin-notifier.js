// admin-notifier.js - Уведомления о транзакциях в админ-группу + статистика
const bus = require("./events");
const { prisma } = require("./db");
const { ruMoney, cb } = require("./menus");
const { markTopupSuccessAndCredit } = require("./payment");
const { Markup } = require("telegraf");
const crypto = require("crypto");
const XLSX = require("xlsx");
const discount = require("./discount");

// ID группы для уведомлений (можно через запятую: -123,-100123 для супергруппы)
const ADMIN_GROUP_IDS = (process.env.ADMIN_GROUP_ID || "-5184781938")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Проверка: чат — админская группа (учитываем старый и супергрупповой ID) */
function isAdminGroup(chatId) {
  if (!chatId) return false;
  const id = String(chatId);
  if (ADMIN_GROUP_IDS.includes(id)) return true;
  // Супергруппа: -5184781938 → -1005184781938 (только для старого формата)
  for (const cfg of ADMIN_GROUP_IDS) {
    if (cfg.startsWith("-100")) continue;
    const n = cfg.replace(/^-/, "");
    if (id === `-100${n}`) return true;
  }
  return false;
}

/** Нормализованный список ID для отправки (включая супергруппы) */
function getAdminChatIdsForSend() {
  const ids = new Set();
  for (const cfg of ADMIN_GROUP_IDS) {
    ids.add(cfg);
    if (!cfg.startsWith("-100")) {
      const n = cfg.replace(/^-/, "");
      ids.add(`-100${n}`);
    }
  }
  return [...ids];
}

const ADMIN_GROUP_ID = ADMIN_GROUP_IDS[0] || "-5184781938"; // для отправки сообщений

let botInstance = null;

/** Состояние "ожидание ввода" для админ-меню: chatId -> { action, fromId? } */
const admState = new Map();

function getAdmMainMenu() {
  return Markup.inlineKeyboard([
    [cb("📊 Статистика", "adm_stat", "primary")],
    [cb("🎁 Промокоды", "adm_promos", "primary"), cb("💳 Пополнения", "adm_payments", "primary")],
    [cb("💰 Скидка", "adm_discount"), cb("📈 Топ рефералов", "adm_topref")],
    [cb("📋 Справка", "adm_help")],
  ]);
}

function getAdmPromosMenu() {
  return Markup.inlineKeyboard([
    [cb("➕ На баланс", "adm_create_balance", "success"), cb("➕ На дни", "adm_create_days", "success")],
    [cb("📋 Список промокодов", "adm_promos_list", "primary")],
    [cb("⬅️ Назад", "adm_back")],
  ]);
}

function getAdmPaymentMenu() {
  return Markup.inlineKeyboard([
    [cb("📋 5 последних", "adm_payment_list", "primary"), cb("📥 Выгрузка .xlsx", "adm_export_topups", "primary")],
    [cb("✅ Одобрить по ID", "adm_payment_approve", "success"), cb("🗑 Удалить по ID", "adm_delpayment", "danger")],
    [cb("⬅️ Назад", "adm_back")],
  ]);
}

function admCancelKeyboard() {
  return Markup.inlineKeyboard([[cb("❌ Отмена", "adm_cancel", "danger")]]);
}

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
 * Сформировать .xlsx со всеми успешными пополнениями. Возвращает { buffer, filename }.
 */
async function buildTopupsXlsx() {
  const topups = await prisma.topUp.findMany({
    where: { status: "SUCCESS" },
    include: { user: { select: { telegramId: true, accountName: true } } },
    orderBy: { createdAt: "desc" },
  });

  const fmtDate = (d) => {
    if (!d) return "";
    const x = new Date(d);
    return x.toISOString().replace("T", " ").slice(0, 19);
  };

  const rows = topups.map((t) => ({
    ID: t.id,
    "User ID": t.userId,
    "Telegram ID": t.user?.telegramId ?? "",
    Имя: t.user?.accountName ?? "",
    "Сумма (₽)": t.amount,
    "Order ID": t.orderId,
    "Bill ID": t.billId ?? "",
    "Дата создания": fmtDate(t.createdAt),
    "Дата зачисления": fmtDate(t.creditedAt),
    "Зачислено": t.credited ? "да" : "нет",
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Пополнения");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const filename = `topups-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return { buffer, filename };
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
  // Подписки созданные за период (только платные: D7, M1, M3, M6, M12)
  const subscriptions = await prisma.subscription.findMany({
    where: {
      type: { in: ["D7", "M1", "M3", "M6", "M12"] },
      startDate: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
  });

  // Распределение по типам подписок
  const distribution = {
    D7: subscriptions.filter(s => s.type === "D7").length,
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
 * Считаем уникальных по telegramId (один человек = один пользователь)
 */
async function getUserStats() {
  const uniqueUsers = await prisma.user.groupBy({
    by: ["telegramId"],
    _count: { id: true },
  });
  const totalUsers = uniqueUsers.length;
  
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
├ 📅 7 дней: ${allTimeSubStats.distribution?.D7 ?? 0}
├ 📅 1 месяц: ${allTimeSubStats.distribution?.M1 ?? 0}
├ 📆 3 месяца: ${allTimeSubStats.distribution?.M3 ?? 0}
├ 🗓 6 месяцев: ${allTimeSubStats.distribution?.M6 ?? 0}
├ 📅 12 месяцев: ${allTimeSubStats.distribution?.M12 ?? 0}
└ 📊 Всего: <b>${allTimeSubStats.total ?? 0}</b>

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

/** Админ-команды для логирования */
const ADMIN_CMDS = ["stat", "admhelp", "admmenu", "createpromo", "promos", "payment", "delpayment", "discount", "exporttopups", "topref"];

/**
 * Инициализация админ-нотификатора
 */
function initAdminNotifier(bot) {
  botInstance = bot;

  // Middleware: логируем админ-команды из групп (для отладки)
  bot.use((ctx, next) => {
    const cmd = ctx.message?.text?.match(/^\/(\w+)(@\w+)?/)?.[1]?.toLowerCase();
    if (cmd && ADMIN_CMDS.includes(cmd) && ctx.chat?.type?.match(/group|supergroup/)) {
      const cid = ctx.chat?.id;
      const ok = isAdminGroup(cid);
      console.log(`[ADMIN] /${cmd} chatId=${cid} isAdmin=${ok} configured=${ADMIN_GROUP_IDS.join(",")}`);
      if (!ok) {
        console.log(`[ADMIN] ⚠️ Чат ${cid} не в списке. Добавь в .env: ADMIN_GROUP_ID=${cid}`);
      }
    }
    return next();
  });

  // Команда /admhelp — справка по всем админ-командам
  bot.command("admhelp", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;

    const msg = `📋 <b>Админ-команды</b>\n\n` +
      `<code>/chatid</code> — ID чата (для .env ADMIN_GROUP_ID)\n\n` +
      `<code>/stat</code> — статистика (день/неделя, подписки, пополнения)\n\n` +
      `<code>/createpromo</code> <i>сумма</i> — промокод на баланс (одноразовый)\n` +
      `<code>/createpromo days</code> <i>дни</i> [название] [--reusable] — промокод на дни\n\n` +
      `<code>/promos</code> — список активных промокодов\n\n` +
      `<code>/payment</code> — 5 последних пополнений\n` +
      `<code>/payment</code> <i>id</i> — одобрить пополнение и зачислить баланс\n` +
      `<code>/exporttopups</code> — выгрузка успешных пополнений в .xlsx\n\n` +
      `<code>/delpayment</code> <i>id</i> — удалить пополнение из БД\n\n` +
      `<code>/topref</code> — топ рефералов\n\n` +
      `<code>/discount</code> — скидка (статус / off / % дата)\n\n` +
      `<code>/admmenu</code> — админ-меню с кнопками`;
    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  // Команда /admmenu — админ-меню с кнопками
  bot.command("admmenu", async (ctx) => {
    const chatId = String(ctx.chat?.id || "");
    if (!isAdminGroup(chatId)) return;
    admState.delete(chatId);
    await ctx.reply("🔧 <b>Админ-меню</b>", { parse_mode: "HTML", ...getAdmMainMenu() });
  });

  // Обработчики кнопок админ-меню
  bot.action("adm_stat", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      await ctx.reply("⏳ Собираю статистику...");
      await sendStats(ctx.chat?.id || ADMIN_GROUP_ID);
    } catch (e) {
      console.error("[ADMIN] adm_stat:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_promos", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      await ctx.editMessageText("🎁 <b>Промокоды</b>", { parse_mode: "HTML", ...getAdmPromosMenu() });
    } catch (e) {
      console.error("[ADMIN] adm_promos:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_payments", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      await ctx.editMessageText("💳 <b>Пополнения</b>", { parse_mode: "HTML", ...getAdmPaymentMenu() });
    } catch (e) {
      console.error("[ADMIN] adm_payments:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_discount", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      const cfg = discount.getConfig();
      const active = discount.isDiscountActive();
      const end = new Date(cfg.endAt);
      const d = String(end.getDate()).padStart(2, "0");
      const m = String(end.getMonth() + 1).padStart(2, "0");
      let msg = `💰 <b>Скидка</b>\n\n`;
      msg += `Статус: ${active ? "✅ включена" : "❌ выключена"}\n`;
      msg += `Процент: ${cfg.percent}%\n`;
      msg += `До: 23:59 ${d}.${m}\n\n`;
      msg += `<code>/discount off</code> — выключить\n`;
      msg += `<code>/discount 20 11.02</code> — 20% до 23:59 11 февраля`;
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (e) {
      console.error("[ADMIN] adm_discount:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_back", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      await ctx.editMessageText("🔧 <b>Админ-меню</b>", { parse_mode: "HTML", ...getAdmMainMenu() });
    } catch (e) {
      console.error("[ADMIN] adm_back:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_help", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      const msg = `📋 <b>Админ-команды</b>\n\n` +
        `<code>/stat</code> — статистика\n` +
        `<code>/createpromo</code> <i>сумма</i> / <code>days</code> <i>дни</i> …\n` +
        `<code>/promos</code> — список промокодов\n` +
        `<code>/payment</code> [id] — пополнения\n` +
        `<code>/exporttopups</code> — выгрузка в .xlsx\n` +
        `<code>/delpayment</code> <i>id</i> — удалить пополнение\n` +
        `<code>/topref</code> — топ рефералов\n` +
        `<code>/discount</code> — скидка\n` +
        `<code>/admmenu</code> — это меню`;
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (e) {
      console.error("[ADMIN] adm_help:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_promos_list", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      const promos = await prisma.adminPromo.findMany({
        where: {
          OR: [
            { usedById: null, isReusable: false },
            { isReusable: true },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      });
      if (promos.length === 0) {
        await ctx.reply("📭 Нет активных промокодов");
        return;
      }
      let msg = "🎁 <b>Активные промокоды:</b>\n\n";
      for (const p of promos) {
        if (p.type === "BALANCE") {
          const status = p.isReusable ? `🔄 (использований: ${p.useCount})` : (p.usedById ? "❌ использован" : "✅ активен");
          msg += `<code>${p.code}</code> — 💵 ${ruMoney(p.amount || 0)} ${status}\n`;
        } else {
          const status = p.isReusable ? `🔄 многораз. (${p.useCount})` : (p.usedById ? "❌ использован" : "✅ активен");
          const nameText = p.customName ? ` "${p.customName}"` : "";
          msg += `<code>${p.code}</code>${nameText} — 📅 ${p.days || 0} дн. ${status}\n`;
        }
      }
      const balancePromos = promos.filter(p => p.type === "BALANCE" && (!p.isReusable ? !p.usedById : true)).length;
      const daysPromos = promos.filter(p => p.type === "DAYS" && (!p.isReusable ? !p.usedById : true)).length;
      msg += `\n📊 Всего: ${promos.length} (💵 ${balancePromos}, 📅 ${daysPromos})`;
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (e) {
      console.error("[ADMIN] adm_promos_list:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
      await ctx.reply("❌ Ошибка: " + (e.message || String(e))).catch(() => {});
    }
  });

  bot.action("adm_create_balance", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      const chatId = String(ctx.chat.id);
      admState.set(chatId, { action: "create_balance", fromId: ctx.from?.id });
      await ctx.reply("💵 Введите сумму (руб):", admCancelKeyboard());
    } catch (e) {
      console.error("[ADMIN] adm_create_balance:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_create_days", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      const chatId = String(ctx.chat.id);
      admState.set(chatId, { action: "create_days", fromId: ctx.from?.id });
      await ctx.reply(
        "📅 Введите: <code>дни [название] [--reusable]</code>\nПример: <code>7 Блогер --reusable</code>",
        { parse_mode: "HTML", ...admCancelKeyboard() }
      );
    } catch (e) {
      console.error("[ADMIN] adm_create_days:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_payment_list", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      const topups = await prisma.topUp.findMany({
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { user: { select: { accountName: true, telegramId: true } } },
      });
      if (topups.length === 0) {
        await ctx.reply("📭 Нет пополнений в базе");
        return;
      }
      let msg = "📋 <b>Последние 5 пополнений:</b>\n\n";
      for (const t of topups) {
        const un = t.user?.accountName || "Без username";
        const tid = t.user?.telegramId || "N/A";
        const em = t.status === "SUCCESS" ? "✅" : t.status === "FAILED" ? "❌" : t.status === "TIMEOUT" ? "⏳" : "⏸️";
        const cr = t.credited ? "💰" : "";
        msg += `${em} <b>#${t.id}</b> ${cr}\n   👤 ${un} (<code>${tid}</code>)\n   💵 ${ruMoney(t.amount)}\n   📊 ${t.status}${t.credited ? " (зачислено)" : ""}\n   📅 ${formatDate(t.createdAt)}\n   📋 Order: <code>${t.orderId}</code>\n\n`;
      }
      msg += `💡 <code>/payment &lt;id&gt;</code> — одобрить`;
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (e) {
      console.error("[ADMIN] adm_payment_list:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
      await ctx.reply("❌ Ошибка: " + (e.message || String(e))).catch(() => {});
    }
  });

  bot.action("adm_payment_approve", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      const chatId = String(ctx.chat.id);
      admState.set(chatId, { action: "payment_approve", fromId: ctx.from?.id });
      await ctx.reply("✅ Введите ID пополнения для одобрения:", admCancelKeyboard());
    } catch (e) {
      console.error("[ADMIN] adm_payment_approve:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_delpayment", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      const chatId = String(ctx.chat.id);
      admState.set(chatId, { action: "delpayment", fromId: ctx.from?.id });
      await ctx.reply("🗑 Введите ID пополнения для удаления:", admCancelKeyboard());
    } catch (e) {
      console.error("[ADMIN] adm_delpayment:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  bot.action("adm_topref", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      await ctx.reply("⏳ Собираю статистику по рефералам...");
      const usersWithReferrals = await prisma.user.findMany({
        where: { promoCode: { not: null } },
        include: {
          promoActivationsAsOwner: { select: { id: true, activatorId: true, createdAt: true, activator: { select: { accountName: true, telegramId: true } } } },
          referralBonusesAsOwner: { select: { bonusAmount: true, credited: true } },
        },
      });
      const stats = usersWithReferrals.map(user => ({
        user,
        referralCount: user.promoActivationsAsOwner.length,
        totalBonus: user.referralBonusesAsOwner.reduce((s, b) => s + b.bonusAmount, 0),
        creditedBonus: user.referralBonusesAsOwner.filter(b => b.credited).reduce((s, b) => s + b.bonusAmount, 0),
      }));
      stats.sort((a, b) => b.referralCount - a.referralCount);
      const top = stats.slice(0, 20);
      if (top.length === 0) {
        await ctx.reply("📭 Нет пользователей с рефералами");
        return;
      }
      let msg = "🏆 <b>Топ рефералов</b>\n\n";
      top.forEach((st, i) => {
        const u = st.user;
        const name = u.accountName || `ID: ${u.telegramId}`;
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        msg += `${medal} <b>${name}</b>\n   📋 <code>${u.promoCode || "N/A"}</code>\n   👥 ${st.referralCount}\n`;
        if (st.creditedBonus > 0) msg += `   💰 ${ruMoney(st.creditedBonus)}\n`;
        if (st.totalBonus > st.creditedBonus) msg += `   ⏳ Ожидает: ${ruMoney(st.totalBonus - st.creditedBonus)}\n`;
        msg += "\n";
      });
      const tr = stats.reduce((s, x) => s + x.referralCount, 0);
      const tu = stats.filter(s => s.referralCount > 0).length;
      const tb = stats.reduce((s, x) => s + x.creditedBonus, 0);
      msg += `\n📊 Всего рефералов: <b>${tr}</b>, пользователей: <b>${tu}</b>`;
      if (tb > 0) msg += `, бонусов: <b>${ruMoney(tb)}</b>`;
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (e) {
      console.error("[ADMIN] adm_topref:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
      await ctx.reply("❌ Ошибка: " + (e.message || String(e))).catch(() => {});
    }
  });

  bot.action("adm_cancel", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      admState.delete(String(ctx.chat.id));
      await ctx.reply("❌ Отменено.");
    } catch (e) {
      console.error("[ADMIN] adm_cancel:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
    }
  });

  // Обработка ввода при действиях из админ-меню (create_balance, create_days, payment_approve, delpayment)
  bot.on("text", async (ctx, next) => {
    const chatId = String(ctx.chat?.id || "");
    if (!isAdminGroup(chatId)) return next();
    const state = admState.get(chatId);
    if (!state) return next();
    const raw = ctx.message?.text || "";
    if (raw.startsWith("/")) return next();

    admState.delete(chatId);
    const text = raw.trim();
    const fromId = String(state.fromId || ctx.from?.id || "unknown");

    try {
      if (state.action === "create_balance") {
        const amount = parseInt(text, 10);
        if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
          await ctx.reply("❌ Сумма от 1 до 100000 ₽");
          return;
        }
        const code = "GIFT" + crypto.randomBytes(4).toString("hex").toUpperCase();
        await prisma.adminPromo.create({
          data: { code, type: "BALANCE", amount, isReusable: false, createdBy: fromId },
        });
        await ctx.reply(
          `✅ <b>Промокод создан!</b>\n\n🎁 Код: <code>${code}</code>\n💵 ${ruMoney(amount)}\n\n<code>/promo ${code}</code>`,
          { parse_mode: "HTML" }
        );
      } else if (state.action === "create_days") {
        const daysMatch = text.match(/^(\d+)(?:\s+(.+))?$/);
        if (!daysMatch) {
          await ctx.reply("❌ Формат: дни [название] [--reusable]");
          return;
        }
        const days = parseInt(daysMatch[1], 10);
        if (days < 1 || days > 365) {
          await ctx.reply("❌ Дни от 1 до 365");
          return;
        }
        let rest = (daysMatch[2] || "").trim();
        const isReusable = /\b--reusable\b/i.test(rest);
        const parts = rest.split(/\s+/).filter(p => p.toLowerCase() !== "--reusable" && p.toLowerCase() !== "reusable");
        const customName = parts.length ? parts.join(" ").trim() : null;
        if (customName && customName.length > 100) {
          await ctx.reply("❌ Название до 100 символов");
          return;
        }
        let code;
        if (customName) {
          code = customName.toUpperCase().replace(/\s+/g, "");
          if (!code || !/^[A-Z0-9-]+$/.test(code)) {
            await ctx.reply("❌ Название: только A–Z, 0–9, дефис");
            return;
          }
          const existing = await prisma.adminPromo.findUnique({ where: { code } });
          if (existing) {
            await ctx.reply(`❌ Промокод <code>${code}</code> уже есть`, { parse_mode: "HTML" });
            return;
          }
          const existingUser = await prisma.user.findUnique({ where: { promoCode: code } });
          if (existingUser) {
            await ctx.reply(`❌ Код <code>${code}</code> — реферальный`, { parse_mode: "HTML" });
            return;
          }
        } else {
          let attempts = 0;
          while (attempts < 5) {
            code = "GIFT" + crypto.randomBytes(4).toString("hex").toUpperCase();
            const ex = await prisma.adminPromo.findUnique({ where: { code } });
            if (!ex) break;
            attempts++;
          }
          if (attempts >= 5) {
            await ctx.reply("❌ Не удалось создать уникальный код");
            return;
          }
        }
        await prisma.adminPromo.create({
          data: { code, type: "DAYS", days, isReusable, customName: customName || null, createdBy: fromId },
        });
        const reuse = isReusable ? "🔄 Многоразовый" : "⚠️ Одноразовый";
        await ctx.reply(
          `✅ <b>Промокод создан!</b>\n\n🎁 <code>${code}</code>${customName ? ` "${customName}"` : ""}\n📅 ${days} дн. ${reuse}\n\n<code>/promo ${code}</code>`,
          { parse_mode: "HTML" }
        );
      } else if (state.action === "payment_approve") {
        const id = parseInt(text, 10);
        if (!Number.isFinite(id)) {
          await ctx.reply("❌ Введите ID пополнения (число)");
          return;
        }
        const topup = await prisma.topUp.findUnique({ where: { id } });
        if (!topup) {
          await ctx.reply(`❌ Пополнение #${id} не найдено`);
          return;
        }
        if (topup.status === "SUCCESS" && topup.credited) {
          await ctx.reply(`✅ #${id} уже одобрено и зачислено`);
          return;
        }
        const result = await markTopupSuccessAndCredit(id);
        if (!result.ok) {
          await ctx.reply(`❌ ${result.reason || "Ошибка"}`);
          return;
        }
        const user = await prisma.user.findUnique({ where: { id: topup.userId } });
        await ctx.reply(
          `✅ <b>Пополнение одобрено</b>\n\n📋 #${id} | 👤 ${user?.accountName || "?"} | 💵 ${ruMoney(topup.amount)}\n💳 Баланс зачислен`,
          { parse_mode: "HTML" }
        );
      } else if (state.action === "delpayment") {
        const id = parseInt(text, 10);
        if (!Number.isFinite(id)) {
          await ctx.reply("❌ Введите ID пополнения (число)");
          return;
        }
        const topup = await prisma.topUp.findUnique({ where: { id } });
        if (!topup) {
          await ctx.reply(`❌ Пополнение #${id} не найдено`);
          return;
        }
        const bc = await prisma.referralBonus.count({ where: { topupId: id } });
        if (bc) await prisma.referralBonus.deleteMany({ where: { topupId: id } });
        await prisma.topUp.delete({ where: { id } });
        await ctx.reply(`🗑 Пополнение #${id} удалено${bc ? ` (реф. бонусов: ${bc})` : ""}`);
      }
    } catch (e) {
      console.error("[ADMIN] adm state handler:", e);
      await ctx.reply("❌ Ошибка: " + (e.message || String(e))).catch(() => {});
    }
  });

  // Команда /stat в админ-группе
  bot.command("stat", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    // Проверяем, что команда из админ-группы
    if (!isAdminGroup(chatId)) return;
    
    await ctx.reply("⏳ Собираю статистику...");
    await sendStats(chatId);
  });

  // Команда /createpromo - создать промокод
  // Варианты:
  //   /createpromo <сумма> - одноразовый промокод на баланс
  //   /createpromo days <дни> [название] [--reusable] - промокод на дни (с опциональным названием и многоразовостью)
  bot.command("createpromo", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    // Проверяем, что команда из админ-группы
    if (!isAdminGroup(chatId)) return;
    
    const text = ctx.message?.text || "";
    
    // Проверяем формат для дней: /createpromo days <число> [название] [--reusable]
    const daysMatch = text.match(/^\/createpromo\s+days\s+(\d+)(?:\s+(.+))?\s*$/i);
    
    if (daysMatch) {
      // Создаем промокод на дни
      const days = parseInt(daysMatch[1], 10);
      const restOfText = (daysMatch[2] || "").trim();
      const isReusable = restOfText.toLowerCase().includes('--reusable');
      
      // Извлекаем кастомное название (убираем --reusable если он есть)
      let customName = null;
      if (restOfText) {
        const parts = restOfText.split(/\s+/).filter(p => {
          const lower = p.toLowerCase();
          return lower !== '--reusable' && lower !== 'reusable';
        });
        if (parts.length > 0) {
          customName = parts.join(' ').trim();
          if (!customName || customName.length === 0) {
            customName = null;
          }
        }
      }
      
      if (days < 1 || days > 365) {
        return ctx.reply("❌ Количество дней должно быть от 1 до 365");
      }
      
      // Валидация кастомного названия (если указано)
      if (customName && customName.length > 100) {
        return ctx.reply("❌ Название промокода не должно превышать 100 символов");
      }
      
      try {
        // Если указано название, используем его как код промокода
        let code;
        if (customName) {
          // Используем название как код (нормализуем: убираем пробелы, верхний регистр)
          code = customName.toUpperCase().replace(/\s+/g, '');
          
          // Валидация кода (должен содержать только буквы, цифры и дефисы, минимум 1 символ)
          if (code.length === 0) {
            return ctx.reply("❌ Название промокода не может быть пустым.");
          }
          
          if (code.length > 100) {
            return ctx.reply("❌ Код промокода не должен превышать 100 символов.");
          }
          
          if (!/^[A-Z0-9-]+$/.test(code)) {
            return ctx.reply("❌ Код промокода может содержать только буквы (A-Z), цифры (0-9) и дефисы (-).");
          }
          
          // Проверяем уникальность
          const existing = await prisma.adminPromo.findUnique({
            where: { code }
          });
          
          if (existing) {
            return ctx.reply(`❌ Промокод с кодом <code>${code}</code> уже существует.`, { parse_mode: "HTML" });
          }
          
          // Проверяем, не используется ли код как реферальный
          const existingUser = await prisma.user.findUnique({
            where: { promoCode: code }
          });
          
          if (existingUser) {
            return ctx.reply(`❌ Код <code>${code}</code> уже используется как реферальный промокод.`, { parse_mode: "HTML" });
          }
        } else {
          // Если название не указано, генерируем автоматически
          let attempts = 0;
          while (attempts < 5) {
            code = "GIFT" + crypto.randomBytes(4).toString("hex").toUpperCase();
            
            // Проверяем уникальность
            const existing = await prisma.adminPromo.findUnique({
              where: { code }
            });
            
            if (!existing) {
              break;
            }
            
            attempts++;
          }
          
          if (attempts >= 5) {
            return ctx.reply("❌ Не удалось создать уникальный код. Попробуйте еще раз.");
          }
        }
        
        await prisma.adminPromo.create({
          data: {
            code,
            type: "DAYS",
            days,
            isReusable,
            customName: customName || null, // Сохраняем оригинальное название для отображения
            createdBy: String(ctx.from?.id || "unknown"),
          },
        });
        
        const reusableText = isReusable ? "🔄 Многоразовый" : "⚠️ Одноразовый";
        // Если название использовалось как код, показываем его как название, иначе показываем отдельно
        const nameText = customName && code === customName.toUpperCase().replace(/\s+/g, '') 
          ? `\n📝 Название: <b>${customName}</b>` 
          : (customName ? `\n📝 Название: <b>${customName}</b>` : "");
        
        const msg = `✅ <b>Промокод создан!</b>

🎁 Код: <code>${code}</code>${nameText}
📅 Дней подписки: <b>${days}</b>
${reusableText}

📋 Для активации пользователь должен ввести:
<code>/promo ${code}</code>

${isReusable ? "✅ Промокод многоразовый - можно использовать несколько раз разными пользователями!" : "⚠️ Код одноразовый, после использования станет недействительным."}`;
        
        await ctx.reply(msg, { parse_mode: "HTML" });
        console.log(`[ADMIN] Created promo code ${code} for ${days} days (reusable: ${isReusable}, customName: ${customName || 'none'}) by ${ctx.from?.id}`);
      } catch (err) {
        console.error("[ADMIN] Error creating promo:", err);
        if (err.code === 'P2002') {
          await ctx.reply(`❌ Промокод с таким кодом уже существует`, { parse_mode: "HTML" });
        } else {
          await ctx.reply("❌ Ошибка создания промокода: " + err.message);
        }
      }
      return;
    }
    
    // Проверяем формат для баланса: /createpromo <сумма>
    const balanceMatch = text.match(/^\/createpromo\s+(\d+)$/);
    
    if (balanceMatch) {
      const amount = parseInt(balanceMatch[1], 10);
      
      if (amount < 1 || amount > 100000) {
        return ctx.reply("❌ Сумма должна быть от 1 до 100000 ₽");
      }
      
      try {
        const code = "GIFT" + crypto.randomBytes(4).toString("hex").toUpperCase();
        
        await prisma.adminPromo.create({
          data: {
            code,
            type: "BALANCE",
            amount,
            isReusable: false,
            createdBy: String(ctx.from?.id || "unknown"),
          },
        });
        
        const msg = `✅ <b>Промокод создан!</b>

🎁 Код: <code>${code}</code>
💵 Номинал: <b>${ruMoney(amount)}</b>
🔄 Тип: Одноразовый (на баланс)

📋 Для активации пользователь должен ввести:
<code>/promo ${code}</code>

⚠️ Код одноразовый, после использования станет недействительным.`;
        
        await ctx.reply(msg, { parse_mode: "HTML" });
        console.log(`[ADMIN] Created promo code ${code} for ${amount}₽ by ${ctx.from?.id}`);
      } catch (err) {
        console.error("[ADMIN] Error creating promo:", err);
        await ctx.reply("❌ Ошибка создания промокода: " + err.message);
      }
      return;
    }
    
    // Если формат не распознан
    return ctx.reply(`❌ Неверный формат команды.

📋 Использование:
• <code>/createpromo &lt;сумма&gt;</code> - промокод на баланс
   Пример: <code>/createpromo 500</code>

• <code>/createpromo days &lt;дни&gt;</code> - одноразовый промокод на дни
   Пример: <code>/createpromo days 7</code>

• <code>/createpromo days &lt;дни&gt; &lt;название&gt;</code> - промокод на дни с названием
   Пример: <code>/createpromo days 30 Новогодний</code>

• <code>/createpromo days &lt;дни&gt; --reusable</code> - многоразовый промокод на дни
   Пример: <code>/createpromo days 30 --reusable</code>

• <code>/createpromo days &lt;дни&gt; &lt;название&gt; --reusable</code> - многоразовый с названием
   Пример: <code>/createpromo days 30 Блогер2024 --reusable</code>

💡 Название промокода: до 100 символов, отображается при активации`, { parse_mode: "HTML" });
  });

  // Команда /promos - список активных промокодов
  bot.command("promos", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    if (!isAdminGroup(chatId)) {
      return;
    }
    
    try {
      // Получаем активные промокоды (неиспользованные одноразовые + многоразовые)
      const promos = await prisma.adminPromo.findMany({
        where: {
          OR: [
            { usedById: null, isReusable: false }, // Одноразовые неиспользованные
            { isReusable: true } // Все многоразовые
          ]
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      });
      
      if (promos.length === 0) {
        return ctx.reply("📭 Нет активных промокодов");
      }
      
      let msg = "🎁 <b>Активные промокоды:</b>\n\n";
      
      for (const p of promos) {
        if (p.type === "BALANCE") {
          const status = p.isReusable ? `🔄 (использований: ${p.useCount})` : (p.usedById ? "❌ использован" : "✅ активен");
          msg += `<code>${p.code}</code> — 💵 ${ruMoney(p.amount || 0)} ${status}\n`;
        } else if (p.type === "DAYS") {
          const status = p.isReusable ? `🔄 многоразовый (использований: ${p.useCount})` : (p.usedById ? "❌ использован" : "✅ активен");
          const nameText = p.customName ? ` "${p.customName}"` : "";
          msg += `<code>${p.code}</code>${nameText} — 📅 ${p.days || 0} ${p.days === 1 ? 'день' : p.days && p.days < 5 ? 'дня' : 'дней'} ${status}\n`;
        }
      }
      
      const balancePromos = promos.filter(p => p.type === "BALANCE" && (!p.isReusable ? !p.usedById : true)).length;
      const daysPromos = promos.filter(p => p.type === "DAYS" && (!p.isReusable ? !p.usedById : true)).length;
      
      msg += `\n📊 Всего: ${promos.length} (💵 на баланс: ${balancePromos}, 📅 на дни: ${daysPromos})`;
      
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (err) {
      console.error("[ADMIN] Error listing promos:", err);
      await ctx.reply("❌ Ошибка: " + err.message);
    }
  });

  // Команда /payment - управление пополнениями
  // /payment [id] - одобрить пополнение по ID
  // /payment - показать 5 последних пополнений
  bot.command("payment", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    if (!isAdminGroup(chatId)) {
      return;
    }
    
    try {
      const text = ctx.message?.text || "";
      const match = text.match(/^\/payment(?:\s+(\d+))?$/);
      
      if (!match) {
        return ctx.reply("Использование: /payment [id] - одобрить пополнение по ID\n/payment - показать 5 последних пополнений");
      }
      
      const topupId = match[1] ? parseInt(match[1], 10) : null;
      
      if (topupId) {
        // Одобрить пополнение по ID
        const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
        if (!topup) {
          return ctx.reply(`❌ Пополнение с ID ${topupId} не найдено`);
        }
        
        if (topup.status === "SUCCESS" && topup.credited) {
          return ctx.reply(`✅ Пополнение #${topupId} уже успешно и зачислено`);
        }
        
        const result = await markTopupSuccessAndCredit(topupId);
        
        if (result.ok) {
          const user = await prisma.user.findUnique({ where: { id: topup.userId } });
          const username = user?.accountName || "Без username";
          const telegramId = user?.telegramId || "N/A";
          
          let msg = `✅ <b>Пополнение одобрено и зачислено!</b>\n\n`;
          msg += `📋 ID: <code>${topupId}</code>\n`;
          msg += `👤 Пользователь: ${username}\n`;
          msg += `🆔 Telegram ID: <code>${telegramId}</code>\n`;
          msg += `💵 Сумма: <b>${ruMoney(topup.amount)}</b>\n`;
          msg += `💳 Новый баланс: ${ruMoney(user?.balance || 0)}\n`;
          msg += `📋 Order ID: <code>${topup.orderId}</code>\n`;
          
          if (result.alreadyCredited) {
            msg += `\n⚠️ Баланс уже был зачислен ранее`;
          } else if (result.credited) {
            msg += `\n✅ Баланс зачислен`;
          }
          
          await ctx.reply(msg, { parse_mode: "HTML" });
        } else {
          await ctx.reply(`❌ Ошибка: ${result.reason || "Неизвестная ошибка"}`);
        }
      } else {
        // Показать 5 последних пополнений
        const topups = await prisma.topUp.findMany({
          take: 5,
          orderBy: { createdAt: "desc" },
          include: {
            user: {
              select: {
                accountName: true,
                telegramId: true
              }
            }
          }
        });
        
        if (topups.length === 0) {
          return ctx.reply("📭 Нет пополнений в базе");
        }
        
        let msg = `📋 <b>Последние 5 пополнений:</b>\n\n`;
        
        for (const t of topups) {
          const username = t.user?.accountName || "Без username";
          const telegramId = t.user?.telegramId || "N/A";
          const statusEmoji = t.status === "SUCCESS" ? "✅" : t.status === "FAILED" ? "❌" : t.status === "TIMEOUT" ? "⏳" : "⏸️";
          const creditedMark = t.credited ? "💰" : "";
          
          msg += `${statusEmoji} <b>#${t.id}</b> ${creditedMark}\n`;
          msg += `   👤 ${username} (<code>${telegramId}</code>)\n`;
          msg += `   💵 ${ruMoney(t.amount)}\n`;
          msg += `   📊 ${t.status}${t.credited ? " (зачислено)" : ""}\n`;
          msg += `   📅 ${formatDate(t.createdAt)}\n`;
          msg += `   📋 Order: <code>${t.orderId}</code>\n\n`;
        }
        
        msg += `💡 Используйте <code>/payment &lt;id&gt;</code> для одобрения пополнения`;
        
        await ctx.reply(msg, { parse_mode: "HTML" });
      }
    } catch (err) {
      console.error("[ADMIN] Error in /payment command:", err);
      await ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  });

  // Команда /delpayment <id> — удалить пополнение из БД (сначала реферальные бонусы, затем TopUp)
  bot.command("delpayment", async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAdminGroup(chatId)) return;

    try {
      const text = ctx.message?.text || "";
      const match = text.match(/^\/delpayment\s+(\d+)$/);
      if (!match) {
        return ctx.reply("Использование: /delpayment <id>\nПример: /delpayment 42");
      }

      const topupId = parseInt(match[1], 10);
      const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
      if (!topup) {
        return ctx.reply(`❌ Пополнение с ID ${topupId} не найдено`);
      }

      const bonusesCount = await prisma.referralBonus.count({ where: { topupId } });
      if (bonusesCount > 0) {
        await prisma.referralBonus.deleteMany({ where: { topupId } });
      }
      await prisma.topUp.delete({ where: { id: topupId } });

      let msg = `🗑 <b>Пополнение удалено</b>\n\n`;
      msg += `📋 ID: <code>${topupId}</code>\n`;
      msg += `📋 Order: <code>${topup.orderId}</code>\n`;
      msg += `💵 Сумма: ${ruMoney(topup.amount)}\n`;
      if (bonusesCount > 0) msg += `📎 Удалено реферальных бонусов: ${bonusesCount}\n`;
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (err) {
      console.error("[ADMIN] Error in /delpayment command:", err);
      await ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  });

  // Команда /discount — просмотр, выключение или настройка скидки
  bot.command("discount", async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAdminGroup(chatId)) return;

    const text = (ctx.message?.text || "").trim();
    const parts = text.split(/\s+/).slice(1);

    try {
      if (parts.length === 0) {
        const cfg = discount.getConfig();
        const active = discount.isDiscountActive();
        const end = new Date(cfg.endAt);
        const d = String(end.getDate()).padStart(2, "0");
        const m = String(end.getMonth() + 1).padStart(2, "0");
        let msg = `💰 <b>Скидка</b>\n\n`;
        msg += `Статус: ${active ? "✅ включена" : "❌ выключена"}\n`;
        msg += `Процент: ${cfg.percent}%\n`;
        msg += `До: 23:59 ${d}.${m}\n\n`;
        msg += `Использование:\n`;
        msg += `<code>/discount off</code> — выключить\n`;
        msg += `<code>/discount 20 11.02</code> — 20% до 23:59 11 февраля`;
        return ctx.reply(msg, { parse_mode: "HTML" });
      }

      if (parts[0].toLowerCase() === "off") {
        discount.setConfig({ active: false });
        return ctx.reply("✅ Скидка выключена.");
      }

      const percent = parseInt(parts[0], 10);
      if (isNaN(percent) || percent < 0 || percent > 99) {
        return ctx.reply("❌ Укажите процент 0–99: /discount 20 11.02");
      }

      const dateStr = parts[1];
      if (!dateStr || !/^\d{1,2}\.\d{1,2}$/.test(dateStr)) {
        return ctx.reply("❌ Укажите дату в формате ДД.ММ: /discount 20 11.02");
      }

      const [dd, mm] = dateStr.split(".").map((n) => parseInt(n, 10));
      const now = new Date();
      let year = now.getFullYear();
      const endDate = new Date(year, mm - 1, dd, 23, 59, 0);
      if (endDate <= now) year += 1;
      const iso = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}T23:59:00+03:00`;
      discount.setConfig({ active: true, percent, endAt: iso });
      const d = String(dd).padStart(2, "0");
      const m = String(mm).padStart(2, "0");
      await ctx.reply(`✅ Скидка -${percent}% до 23:59 ${d}.${m}`);
    } catch (err) {
      console.error("[ADMIN] Error in /discount:", err);
      await ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  });

  // Команда /exporttopups — выгрузка всех успешных пополнений в .xlsx
  bot.command("exporttopups", async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAdminGroup(chatId)) return;

    try {
      const progressMsg = await ctx.reply("⏳ Формирую выгрузку пополнений...");
      const { buffer, filename } = await buildTopupsXlsx();
      await ctx.telegram.sendDocument(chatId, { source: buffer, filename });
      await ctx.telegram.deleteMessage(chatId, progressMsg.message_id).catch(() => {});
    } catch (err) {
      console.error("[ADMIN] Error in /exporttopups:", err);
      await ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  });

  // Кнопка "Выгрузка .xlsx" в меню пополнений
  bot.action("adm_export_topups", async (ctx) => {
    if (!isAdminGroup(ctx.chat?.id)) return;
    try {
      await ctx.answerCbQuery();
      const chatId = String(ctx.chat.id);
      const progressMsg = await ctx.reply("⏳ Формирую выгрузку пополнений...");
      const { buffer, filename } = await buildTopupsXlsx();
      await ctx.telegram.sendDocument(chatId, { source: buffer, filename });
      await ctx.telegram.deleteMessage(chatId, progressMsg.message_id).catch(() => {});
    } catch (e) {
      console.error("[ADMIN] adm_export_topups:", e);
      await ctx.answerCbQuery("❌ Ошибка").catch(() => {});
      await ctx.reply("❌ Ошибка: " + (e.message || String(e))).catch(() => {});
    }
  });

  // Команда /topref - топ рефералов (люди, которые пригласили больше всего друзей)
  bot.command("topref", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    if (!isAdminGroup(chatId)) return;
    
    try {
      await ctx.reply("⏳ Собираю статистику по рефералам...");
      
      // Получаем всех пользователей с их активациями промокодов
      const usersWithReferrals = await prisma.user.findMany({
        where: {
          promoCode: { not: null }, // Только пользователи с промокодом
        },
        include: {
          promoActivationsAsOwner: {
            select: {
              id: true,
              activatorId: true,
              createdAt: true,
              activator: {
                select: {
                  accountName: true,
                  telegramId: true,
                }
              }
            }
          },
          referralBonusesAsOwner: {
            select: {
              bonusAmount: true,
              credited: true,
            }
          }
        }
      });
      
      // Подсчитываем статистику для каждого пользователя
      const stats = usersWithReferrals.map(user => {
        const referralCount = user.promoActivationsAsOwner.length;
        const totalBonus = user.referralBonusesAsOwner.reduce((sum, bonus) => sum + bonus.bonusAmount, 0);
        const creditedBonus = user.referralBonusesAsOwner.filter(b => b.credited).reduce((sum, bonus) => sum + bonus.bonusAmount, 0);
        
        return {
          user,
          referralCount,
          totalBonus,
          creditedBonus,
        };
      });
      
      // Сортируем по количеству рефералов (по убыванию)
      stats.sort((a, b) => b.referralCount - a.referralCount);
      
      // Берем топ-20
      const topStats = stats.slice(0, 20);
      
      if (topStats.length === 0) {
        return ctx.reply("📭 Нет пользователей с рефералами");
      }
      
      let msg = "🏆 <b>Топ рефералов</b> (по количеству приглашенных друзей)\n\n";
      
      topStats.forEach((stat, index) => {
        const user = stat.user;
        const username = user.accountName || `ID: ${user.telegramId}`;
        const promoCode = user.promoCode || "N/A";
        const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
        
        msg += `${medal} <b>${username}</b>\n`;
        msg += `   📋 Промокод: <code>${promoCode}</code>\n`;
        msg += `   👥 Рефералов: <b>${stat.referralCount}</b>\n`;
        
        if (stat.creditedBonus > 0) {
          msg += `   💰 Заработано бонусов: <b>${ruMoney(stat.creditedBonus)}</b>\n`;
        }
        
        if (stat.totalBonus > stat.creditedBonus) {
          msg += `   ⏳ Ожидает зачисления: ${ruMoney(stat.totalBonus - stat.creditedBonus)}\n`;
        }
        
        msg += "\n";
      });
      
      // Общая статистика
      const totalReferrals = stats.reduce((sum, s) => sum + s.referralCount, 0);
      const totalUsersWithReferrals = stats.filter(s => s.referralCount > 0).length;
      const totalBonusEarned = stats.reduce((sum, s) => sum + s.creditedBonus, 0);
      
      msg += `\n📊 <b>Общая статистика:</b>\n`;
      msg += `   👥 Всего рефералов: <b>${totalReferrals}</b>\n`;
      msg += `   👤 Пользователей с рефералами: <b>${totalUsersWithReferrals}</b>\n`;
      if (totalBonusEarned > 0) {
        msg += `   💰 Всего заработано бонусов: <b>${ruMoney(totalBonusEarned)}</b>\n`;
      }
      
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (err) {
      console.error("[ADMIN] Error getting top referrals:", err);
      await ctx.reply("❌ Ошибка при получении статистики рефералов");
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

  // Уведомление о неуспешном пополнении (FAILED)
  bus.on("topup.failed", async ({ topupId }) => {
    try {
      const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
      if (!topup) return;

      const user = await prisma.user.findUnique({ where: { id: topup.userId } });

      const username = user?.accountName || "Без username";
      const telegramId = user?.telegramId || "N/A";

      const text = `❌ <b>Неоплаченный заказ</b>

👤 Пользователь: ${username}
🆔 Telegram ID: <code>${telegramId}</code>
💵 Сумма: <b>${ruMoney(topup.amount)}</b>
📋 ID заказа: <code>${topup.orderId}</code>
📅 Создан: ${formatDate(topup.createdAt)}
⏰ Обновлен: ${formatDate(topup.updatedAt)}

🚫 Статус: <b>Отменен</b>
💡 Причина: Пользователь отменил оплату или не завершил транзакцию`;

      await sendToAdminGroup(text);
      console.log(`[ADMIN] Failed topup notification sent for topup=${topupId}`);
    } catch (err) {
      console.error("[ADMIN] Ошибка уведомления о неуспешном пополнении:", err.message);
    }
  });

  // Уведомление о просроченном пополнении (TIMEOUT)
  bus.on("topup.timeout", async ({ topupId }) => {
    try {
      const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
      if (!topup) return;

      const user = await prisma.user.findUnique({ where: { id: topup.userId } });

      const username = user?.accountName || "Без username";
      const telegramId = user?.telegramId || "N/A";

      const text = `⏳ <b>Просроченный заказ</b>

👤 Пользователь: ${username}
🆔 Telegram ID: <code>${telegramId}</code>
💵 Сумма: <b>${ruMoney(topup.amount)}</b>
📋 ID заказа: <code>${topup.orderId}</code>
📅 Создан: ${formatDate(topup.createdAt)}
⏰ Истек: ${formatDate(new Date())}

🚫 Статус: <b>Истек срок оплаты</b>
💡 Причина: Заказ не был оплачен в течение 30 минут`;

      await sendToAdminGroup(text);
      console.log(`[ADMIN] Timeout topup notification sent for topup=${topupId}`);
    } catch (err) {
      console.error("[ADMIN] Ошибка уведомления о просроченном пополнении:", err.message);
    }
  });

  // Запуск ежедневной статистики в 20:00
  scheduleDaily(20, 0, () => sendStats());

  console.log("📢 Admin notifier initialized (group: " + ADMIN_GROUP_IDS.join(", ") + ")");
  console.log("📊 Command /stat available in admin group");
  console.log("🏆 Command /topref available in admin group");
  console.log("💳 Command /payment available in admin group");
  console.log("🗑 Command /delpayment available in admin group");
  console.log("📥 Command /exporttopups available in admin group");
  console.log("💰 Command /discount available in admin group");
  console.log("📋 Command /admhelp available in admin group");
  console.log("🔧 Command /admmenu available in admin group");
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
