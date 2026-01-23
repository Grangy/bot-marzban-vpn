// admin-notifier.js - Уведомления о транзакциях в админ-группу + статистика
const bus = require("./events");
const { prisma } = require("./db");
const { ruMoney } = require("./menus");

// ID группы для уведомлений
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID || "-5184781938";

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

  // Команда /createpromo - создать промокод
  // Варианты:
  //   /createpromo <сумма> - одноразовый промокод на баланс
  //   /createpromo days <дни> [название] [--reusable] - промокод на дни (с опциональным названием и многоразовостью)
  bot.command("createpromo", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    // Проверяем, что команда из админ-группы
    if (chatId !== ADMIN_GROUP_ID) {
      return; // Игнорируем команду из других чатов
    }
    
    const text = ctx.message?.text || "";
    const crypto = require("crypto");
    
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
    
    if (chatId !== ADMIN_GROUP_ID) {
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

  // Команда /topref - топ рефералов (люди, которые пригласили больше всего друзей)
  bot.command("topref", async (ctx) => {
    const chatId = String(ctx.chat.id);
    
    if (chatId !== ADMIN_GROUP_ID) {
      return; // Игнорируем команду из других чатов
    }
    
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

  console.log("📢 Admin notifier initialized (group: " + ADMIN_GROUP_ID + ")");
  console.log("📊 Command /stat available in admin group");
  console.log("🏆 Command /topref available in admin group");
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
