// webapp-api.js - API для Telegram Web App
const crypto = require("crypto");
const { prisma } = require("./db");
const { createInvoice } = require("./payment");
const { createMarzbanUserOnBothServers } = require("./marzban-utils");
const {
  PLANS,
  getPlanPrice,
  getDiscountBanner,
  isDiscountActive,
  getTopupAmountsForUser,
  TOPUP_DURATION_HINT,
  hasActiveYearRenewalDiscount,
} = require("./menus");
const { withMergedYearRenewalDiscount } = require("./pricing-user");
const { getOrCreateUserForLead, findUserByLead } = require("./lead-identity");

// Секретный ключ для API (должен быть в .env)
const WEBAPP_SECRET = process.env.WEBAPP_SECRET || "maxgroot_webapp_secret_key_2026";

/**
 * Middleware для проверки авторизации Web App
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers["x-webapp-secret"];
  const telegramInitData = req.headers["x-telegram-init-data"];
  
  // Проверяем секретный ключ
  if (authHeader !== WEBAPP_SECRET) {
    console.warn("[WEBAPP] Unauthorized request - invalid secret");
    return res.status(401).json({ 
      ok: false, 
      error: "UNAUTHORIZED",
      message: "Invalid API secret" 
    });
  }
  
  // Если есть Telegram Init Data - валидируем
  if (telegramInitData) {
    const validation = validateTelegramInitData(telegramInitData);
    if (!validation.valid) {
      console.warn("[WEBAPP] Invalid Telegram init data");
      return res.status(401).json({ 
        ok: false, 
        error: "INVALID_INIT_DATA",
        message: "Invalid Telegram init data" 
      });
    }
    req.telegramUser = validation.user;
  }
  
  next();
}

/**
 * Валидация Telegram Web App Init Data
 */
function validateTelegramInitData(initData) {
  try {
    const botToken = process.env.BOT_TOKEN;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    
    // Сортируем параметры
    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    
    // Создаем секретный ключ
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    
    // Вычисляем хеш
    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(sortedParams)
      .digest("hex");
    
    if (calculatedHash !== hash) {
      return { valid: false };
    }
    
    // Извлекаем данные пользователя
    const userParam = params.get("user");
    const user = userParam ? JSON.parse(userParam) : null;
    
    return { valid: true, user };
  } catch (error) {
    console.error("[WEBAPP] Init data validation error:", error);
    return { valid: false };
  }
}

/**
 * Telegram ID для персональных цен: query ?telegramId=… или user из валидного X-Telegram-Init-Data.
 */
function resolveWebAppTelegramId(req) {
  const q = req.query?.telegramId;
  if (q != null && String(q).trim() !== "") return String(q).trim();
  const id = req.telegramUser?.id;
  if (id != null) return String(id);
  return null;
}

function setNoStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Vary", "X-Telegram-Init-Data");
}

/**
 * Регистрация Web App API endpoints
 */
function registerWebAppAPI(app) {
  // Применяем middleware ко всем /api/* маршрутам
  app.use("/api", authMiddleware);

  // ==========================================
  // ПОЛЬЗОВАТЕЛЬ
  // ==========================================

  /**
   * Вспомогательная функция для получения правильного пользователя
   * Ищет пользователя только из личных сообщений (chatId === telegramId)
   * Игнорирует пользователей из групп и каналов
   */
  async function getMainUser(telegramId) {
    const telegramIdStr = String(telegramId);
    
    // Ищем пользователя только из личных сообщений (chatId === telegramId)
    // В ЛС chat.id всегда равен user.id (telegramId)
    const user = await prisma.user.findFirst({
      where: { 
        telegramId: telegramIdStr,
        chatId: telegramIdStr // Только ЛС, не группы
      },
      include: {
        subscriptions: { select: { id: true } },
        topUps: { select: { id: true } }
      },
      orderBy: { id: "asc" } // Самый старый - основной
    });

    if (user) {
      return withMergedYearRenewalDiscount(prisma, user);
    }

    // Если не нашли пользователя из ЛС, ищем вообще всех (fallback для диагностики)
    const allUsers = await prisma.user.findMany({
      where: { telegramId: telegramIdStr },
      include: {
        subscriptions: { select: { id: true } },
        topUps: { select: { id: true } }
      },
      orderBy: { id: "asc" }
    });

    if (allUsers.length === 0) {
      return null;
    }

    // Если нашли пользователей, но не из ЛС - предупреждаем
    const nonPrivateUsers = allUsers.filter(u => u.chatId !== telegramIdStr);
    if (nonPrivateUsers.length > 0) {
      console.warn(`[WEBAPP] Пользователь ${telegramId} найден только в группах/чатах, не в ЛС. Chat IDs: ${nonPrivateUsers.map(u => u.chatId).join(", ")}`);
    }

    // Fallback: выбираем того, у кого больше активности
    const usersWithActivity = allUsers.map(user => ({
      user,
      activity: user.balance + (user.subscriptions.length * 10) + user.topUps.length
    }));

    usersWithActivity.sort((a, b) => {
      if (b.activity !== a.activity) {
        return b.activity - a.activity;
      }
      return a.user.id - b.user.id;
    });

    return withMergedYearRenewalDiscount(prisma, usersWithActivity[0].user);
  }

  /**
   * GET /api/user/:telegramId
   * Получить ВСЕ данные пользователя из БД (полный личный кабинет)
   */
  app.get("/api/user/:telegramId", async (req, res) => {
    try {
      const { telegramId } = req.params;
      
      // Получаем правильного пользователя (с учетом дубликатов)
      const mainUser = await getMainUser(telegramId);
      if (!mainUser) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND",
          message: "Пользователь не найден" 
        });
      }

      // Получаем пользователя со ВСЕМИ связанными данными
      const user = await prisma.user.findUnique({
        where: { id: mainUser.id },
        include: {
          // ВСЕ подписки (включая истекшие и FREE)
          subscriptions: {
            orderBy: { endDate: "desc" }
          },
          // ВСЕ пополнения
          topUps: {
            orderBy: { createdAt: "desc" }
          },
          // Промокоды пользователя
          promoActivationsAsOwner: {
            include: {
              activator: {
                select: {
                  id: true,
                  telegramId: true,
                  accountName: true
                }
              }
            },
            orderBy: { createdAt: "desc" }
          },
          // Активация промокода пользователем
          promoActivationAsUser: {
            include: {
              codeOwner: {
                select: {
                  id: true,
                  telegramId: true,
                  accountName: true
                }
              }
            }
          }
        }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND",
          message: "Пользователь не найден" 
        });
      }

      // Статистика по подпискам
      const activeSubscriptions = user.subscriptions.filter(sub => 
        sub.endDate && sub.endDate > new Date() && sub.type !== "FREE"
      );
      const expiredSubscriptions = user.subscriptions.filter(sub => 
        sub.endDate && sub.endDate <= new Date()
      );

      // Статистика по пополнениям
      const successfulTopups = user.topUps.filter(t => t.status === "SUCCESS" && t.credited);
      const totalTopupAmount = successfulTopups.reduce((sum, t) => sum + t.amount, 0);

      // Получаем актуальный баланс повторным запросом (для проверки кеширования)
      const userFresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: { balance: true, updatedAt: true }
      });

      // Вычисляем баланс из транзакций для проверки
      const paidSubscriptions = user.subscriptions.filter(s => ["D7", "M1", "M3", "M6", "M12"].includes(s.type));
      const totalSpent = paidSubscriptions.reduce((sum, sub) => {
        const plan = PLANS[sub.type];
        return sum + (plan ? plan.price : 0);
      }, 0);

      const referralBonuses = await prisma.referralBonus.findMany({
        where: { codeOwnerId: user.id, credited: true },
        select: { bonusAmount: true }
      });
      const promoBonusReceived = referralBonuses.reduce((sum, b) => sum + b.bonusAmount, 0);
      const adminPromos = await prisma.adminPromo.findMany({
        where: { usedById: user.id },
        select: { amount: true }
      });
      const adminPromoBonus = adminPromos.reduce((sum, p) => sum + p.amount, 0);
      const calculatedBalance = totalTopupAmount + promoBonusReceived + adminPromoBonus - totalSpent;

      // Форматируем данные для ответа
      const response = {
        ok: true,
        data: {
          // Основные данные пользователя
          id: user.id,
          telegramId: user.telegramId,
          chatId: user.chatId,
          username: user.accountName,
          balance: Number(user.balance),
          balanceFresh: userFresh ? Number(userFresh.balance) : null,
          balanceLastUpdated: userFresh?.updatedAt || user.updatedAt,
          balanceCalculated: calculatedBalance,
          balanceMatches: Number(user.balance) === calculatedBalance,
          promoCode: user.promoCode,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          
          // Статистика
          stats: {
            totalSubscriptions: user.subscriptions.length,
            activeSubscriptions: activeSubscriptions.length,
            expiredSubscriptions: expiredSubscriptions.length,
            totalTopups: user.topUps.length,
            successfulTopups: successfulTopups.length,
            totalTopupAmount: totalTopupAmount,
            totalSpentOnSubscriptions: totalSpent,
            totalSpent: totalTopupAmount - Number(user.balance),
            calculatedBalance: calculatedBalance,
            balanceDiscrepancy: Number(user.balance) - calculatedBalance,
            promoCodeGiven: user.promoCode ? 1 : 0,
            promoActivationsReceived: user.promoActivationsAsOwner.length,
            promoActivated: user.promoActivationAsUser ? 1 : 0
          },
          
          // ВСЕ подписки
          subscriptions: user.subscriptions.map(sub => ({
            id: sub.id,
            type: sub.type,
            startDate: sub.startDate,
            endDate: sub.endDate,
            subscriptionUrl: sub.subscriptionUrl,
            subscriptionUrl2: sub.subscriptionUrl2,
            notified3Days: sub.notified3Days,
            notified1Day: sub.notified1Day,
            lastExpiredReminderAt: sub.lastExpiredReminderAt,
            isActive: sub.endDate ? sub.endDate > new Date() : false,
            daysLeft: sub.endDate 
              ? Math.ceil((new Date(sub.endDate) - new Date()) / (1000 * 60 * 60 * 24)) 
              : null,
            isExpired: sub.endDate ? sub.endDate <= new Date() : false
          })),
          
          // ВСЕ пополнения
          topups: user.topUps.map(topup => ({
            id: topup.id,
            orderId: topup.orderId,
            billId: topup.billId,
            amount: topup.amount,
            status: topup.status,
            credited: topup.credited,
            createdAt: topup.createdAt,
            creditedAt: topup.creditedAt,
            updatedAt: topup.updatedAt
          })),
          
          // Промокоды (где пользователь - владелец; реф. бонусы в ReferralBonus)
          promoActivationsReceived: user.promoActivationsAsOwner.map(activation => ({
            id: activation.id,
            createdAt: activation.createdAt,
            activator: {
              id: activation.activator.id,
              telegramId: activation.activator.telegramId,
              username: activation.activator.accountName
            }
          })),
          
          // Активация промокода (если пользователь использовал промокод)
          promoActivation: user.promoActivationAsUser ? {
            id: user.promoActivationAsUser.id,
            createdAt: user.promoActivationAsUser.createdAt,
            codeOwner: {
              id: user.promoActivationAsUser.codeOwner.id,
              telegramId: user.promoActivationAsUser.codeOwner.telegramId,
              username: user.promoActivationAsUser.codeOwner.accountName
            }
          } : null
        }
      };

      res.json(response);
    } catch (error) {
      console.error("[WEBAPP] Get user error:", error);
      res.status(500).json({ 
        ok: false, 
        error: "SERVER_ERROR",
        message: error.message 
      });
    }
  });

  /**
   * GET /api/user/:telegramId/balance
   * Получить баланс пользователя (с проверкой через транзакции)
   */
  app.get("/api/user/:telegramId/balance", async (req, res) => {
    try {
      const { telegramId } = req.params;
      
      // Получаем правильного пользователя (с учетом дубликатов)
      const mainUser = await getMainUser(telegramId);
      if (!mainUser) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: mainUser.id },
        select: { id: true, balance: true, telegramId: true }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      // Проверяем баланс через транзакции для диагностики
      const successfulTopups = await prisma.topUp.findMany({
        where: { 
          userId: user.id, 
          status: "SUCCESS",
          credited: true
        },
        select: { amount: true, createdAt: true }
      });

      const totalTopupAmount = successfulTopups.reduce((sum, t) => sum + t.amount, 0);

      // Получаем все покупки подписок для расчета потраченных средств
      const paidSubscriptions = await prisma.subscription.findMany({
        where: { 
          userId: user.id,
          type: { in: ["D7", "M1", "M3", "M6", "M12"] }
        },
        select: { type: true }
      });

      // Считаем сколько потрачено на подписки
      const PLANS = require("./menus").PLANS;
      const totalSpent = paidSubscriptions.reduce((sum, sub) => {
        const plan = PLANS[sub.type];
        return sum + (plan ? plan.price : 0);
      }, 0);

      // Реферальные бонусы (20% от пополнений активаторов) — только зачисленные
      const referralBonuses = await prisma.referralBonus.findMany({
        where: { codeOwnerId: user.id, credited: true },
        select: { bonusAmount: true }
      });
      const promoBonusReceived = referralBonuses.reduce((sum, b) => sum + b.bonusAmount, 0);

      // Получаем админские промокоды (если использовал)
      const adminPromos = await prisma.adminPromo.findMany({
        where: { usedById: user.id },
        select: { amount: true }
      });
      const adminPromoBonus = adminPromos.reduce((sum, p) => sum + p.amount, 0);

      // Получаем актуальный баланс повторным запросом для проверки кеширования
      const userFresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: { balance: true }
      });

      // Вычисляем баланс из транзакций (для проверки)
      const calculatedBalance = totalTopupAmount + promoBonusReceived + adminPromoBonus - totalSpent;

      const totalBalance = Number(user.balance);
      const balanceReferralAmount = promoBonusReceived;
      const balanceMain = totalBalance - balanceReferralAmount;

      res.json({
        ok: true,
        data: {
          balance: balanceMain,
          balanceReferral: balanceReferralAmount,
          totalBalance,
          balanceFresh: userFresh ? Number(userFresh.balance) : null,
          diagnostics: {
            totalTopupsCredited: totalTopupAmount,
            successfulTopupsCount: successfulTopups.length,
            totalSpentOnSubscriptions: totalSpent,
            promoBonusReceived: promoBonusReceived,
            adminPromoBonus: adminPromoBonus,
            calculatedBalance: calculatedBalance,
            balanceMatchesCalculation: Number(user.balance) === calculatedBalance,
            balanceMatchesFresh: Number(user.balance) === Number(userFresh?.balance || 0)
          }
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Get balance error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR", message: error.message });
    }
  });

  /**
   * GET /api/user/:telegramId/subscriptions
   * Получить ВСЕ подписки пользователя
   */
  app.get("/api/user/:telegramId/subscriptions", async (req, res) => {
    try {
      const { telegramId } = req.params;
      const { active, expired, type } = req.query; // ?active=true - только активные, ?expired=true - только истекшие, ?type=M1 - по типу
      
      const mainUser = await getMainUser(telegramId);
      if (!mainUser) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: mainUser.id }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const whereClause = { userId: user.id };

      // Фильтры
      if (active === "true") {
        whereClause.endDate = { gt: new Date() };
        whereClause.type = { not: "FREE" };
      } else if (expired === "true") {
        whereClause.endDate = { lte: new Date() };
      }

      if (type && ["D7", "M1", "M3", "M6", "M12", "PROMO_10D", "FREE"].includes(type)) {
        whereClause.type = type;
      }

      const subscriptions = await prisma.subscription.findMany({
        where: whereClause,
        orderBy: { endDate: "desc" }
      });

      res.json({
        ok: true,
        data: subscriptions.map(sub => ({
          id: sub.id,
          type: sub.type,
          startDate: sub.startDate,
          endDate: sub.endDate,
          subscriptionUrl: sub.subscriptionUrl,
          subscriptionUrl2: sub.subscriptionUrl2,
          notified3Days: sub.notified3Days,
          notified1Day: sub.notified1Day,
          lastExpiredReminderAt: sub.lastExpiredReminderAt,
          isActive: sub.endDate ? sub.endDate > new Date() : false,
          isExpired: sub.endDate ? sub.endDate <= new Date() : false,
          daysLeft: sub.endDate ? Math.ceil((new Date(sub.endDate) - new Date()) / (1000 * 60 * 60 * 24)) : null
        })),
        total: subscriptions.length
      });
    } catch (error) {
      console.error("[WEBAPP] Get subscriptions error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  /**
   * GET /api/user/:telegramId/stats
   * Полная статистика пользователя
   */
  app.get("/api/user/:telegramId/stats", async (req, res) => {
    try {
      const { telegramId } = req.params;
      
      const mainUser = await getMainUser(telegramId);
      if (!mainUser) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: mainUser.id },
        include: {
          subscriptions: true,
          topUps: true,
          promoActivationsAsOwner: true,
          promoActivationAsUser: true
        }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const referralBonuses = await prisma.referralBonus.findMany({
        where: { codeOwnerId: user.id, credited: true },
        select: { bonusAmount: true }
      });
      const totalReferralBonus = referralBonuses.reduce((sum, b) => sum + b.bonusAmount, 0);

      // Подписки
      const activeSubs = user.subscriptions.filter(s => s.endDate && s.endDate > new Date() && s.type !== "FREE");
      const expiredSubs = user.subscriptions.filter(s => s.endDate && s.endDate <= new Date());
      const subTypes = user.subscriptions.reduce((acc, s) => {
        acc[s.type] = (acc[s.type] || 0) + 1;
        return acc;
      }, {});

      // Пополнения
      const successfulTopups = user.topUps.filter(t => t.status === "SUCCESS" && t.credited);
      const totalTopupAmount = successfulTopups.reduce((sum, t) => sum + t.amount, 0);
      const topupStatuses = user.topUps.reduce((acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      }, {});

      res.json({
        ok: true,
        data: {
          user: {
            id: user.id,
            telegramId: user.telegramId,
            username: user.accountName,
            balance: user.balance,
            promoCode: user.promoCode,
            createdAt: user.createdAt
          },
          subscriptions: {
            total: user.subscriptions.length,
            active: activeSubs.length,
            expired: expiredSubs.length,
            byType: subTypes
          },
          topups: {
            total: user.topUps.length,
            successful: successfulTopups.length,
            totalAmount: totalTopupAmount,
            byStatus: topupStatuses
          },
          promo: {
            hasPromoCode: !!user.promoCode,
            activationsReceived: user.promoActivationsAsOwner.length,
            totalReceivedAmount: totalReferralBonus,
            hasActivated: !!user.promoActivationAsUser,
            activatedAmount: 0
          },
          financial: {
            totalTopupAmount: totalTopupAmount,
            currentBalance: user.balance,
            totalSpent: totalTopupAmount - user.balance
          }
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Get stats error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  /**
   * GET /api/user/:telegramId/promo
   * Информация о промокоде пользователя
   */
  app.get("/api/user/:telegramId/promo", async (req, res) => {
    try {
      const { telegramId } = req.params;
      
      const mainUser = await getMainUser(telegramId);
      if (!mainUser) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: mainUser.id },
        include: {
          promoActivationsAsOwner: {
            include: {
              activator: {
                select: {
                  id: true,
                  telegramId: true,
                  accountName: true
                }
              }
            },
            orderBy: { createdAt: "desc" }
          },
          promoActivationAsUser: {
            include: {
              codeOwner: {
                select: {
                  id: true,
                  telegramId: true,
                  accountName: true,
                  promoCode: true
                }
              }
            }
          }
        }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const referralBonuses = await prisma.referralBonus.findMany({
        where: { codeOwnerId: user.id, credited: true },
        select: { bonusAmount: true }
      });
      const totalReferralBonus = referralBonuses.reduce((sum, b) => sum + b.bonusAmount, 0);

      res.json({
        ok: true,
        data: {
          promoCode: user.promoCode,
          hasPromoCode: !!user.promoCode,
          activations: {
            count: user.promoActivationsAsOwner.length,
            totalAmount: totalReferralBonus,
            list: user.promoActivationsAsOwner.map(a => ({
              id: a.id,
              createdAt: a.createdAt,
              activator: {
                id: a.activator.id,
                telegramId: a.activator.telegramId,
                username: a.activator.accountName
              }
            }))
          },
          activated: user.promoActivationAsUser ? {
            createdAt: user.promoActivationAsUser.createdAt,
            codeOwner: {
              id: user.promoActivationAsUser.codeOwner.id,
              telegramId: user.promoActivationAsUser.codeOwner.telegramId,
              username: user.promoActivationAsUser.codeOwner.accountName,
              promoCode: user.promoActivationAsUser.codeOwner.promoCode
            }
          } : null
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Get promo error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  // ==========================================
  // ПЛАТЕЖИ
  // ==========================================

  /**
   * GET /api/plans
   * Получить список тарифов.
   * buyUrl — ссылка на бота для кнопки «Приобрести» (t.me/BOT?start=plan_M1…).
   */
  app.get("/api/plans", async (req, res) => {
    setNoStore(res);
    const botUsername = process.env.BOT_USERNAME || "maxvpn_offbot";
    const baseUrl = `https://t.me/${botUsername}`;

    let pricingUser = null;
    const tid = resolveWebAppTelegramId(req);
    if (tid) {
      try {
        pricingUser = await getMainUser(tid);
      } catch (_) {
        pricingUser = null;
      }
    }

    const hasPersonalYearDiscount = hasActiveYearRenewalDiscount(pricingUser);
    const plans = Object.entries(PLANS)
      .filter(([key]) => key !== "PROMO_10D" && key !== "FREE")
      .map(([key, plan]) => {
        const price = getPlanPrice(key, pricingUser);
        const months = plan.months || (plan.days ? plan.days / 30 : null);
        return {
          id: key,
          label: plan.label,
          price,
          months: months,
          days: plan.days,
          pricePerMonth: months ? Math.round(price / months) : null,
          buyUrl: `${baseUrl}?start=plan_${key}`,
          discountBanner: getDiscountBanner(),
        };
      });

    res.json({
      ok: true,
      data: plans,
      discountBanner: getDiscountBanner(),
      meta: {
        pricingResolvedBy: tid ? "user" : "fallback",
        hasPersonalYearDiscount,
      },
    });
  });

  /**
   * GET /api/topup/presets?telegramId=
   * Суммы кнопок пополнения как в боте (глобальная + персональная −20% на год).
   */
  app.get("/api/topup/presets", async (req, res) => {
    try {
      setNoStore(res);
      const tid = resolveWebAppTelegramId(req);
      let pricingUser = null;
      if (tid) {
        try {
          pricingUser = await getMainUser(tid);
        } catch (_) {
          pricingUser = null;
        }
      }
      const amounts = getTopupAmountsForUser(pricingUser);
      const hasPersonalYearDiscount = hasActiveYearRenewalDiscount(pricingUser);
      const presets = amounts.map((amount, idx) => ({
        amount,
        hint:
          idx === 4 && hasPersonalYearDiscount
            ? "12 мес. −20%"
            : TOPUP_DURATION_HINT[idx],
      }));
      res.json({
        ok: true,
        data: { presets, discountBanner: getDiscountBanner() },
        meta: {
          pricingResolvedBy: tid ? "user" : "fallback",
          hasPersonalYearDiscount,
        },
      });
    } catch (e) {
      console.error("[WEBAPP] topup/presets error:", e);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  /**
   * POST /api/topup/create
   * Создать счёт на пополнение баланса.
   * Тело: { telegramId, amount } как раньше, или { lead_type, lead_code, amount } — код ровно 7 символов A–Z/a–z/0–9.
   * Если переданы и telegramId, и lead_* — используется только telegramId.
   */
  app.post("/api/topup/create", async (req, res) => {
    try {
      const { telegramId, amount, lead_type, lead_code } = req.body || {};

      const hasTg = telegramId != null && String(telegramId).trim() !== "";
      const hasLead =
        lead_type != null &&
        String(lead_type).trim() !== "" &&
        lead_code != null &&
        String(lead_code).trim() !== "";

      if ((!hasTg && !hasLead) || amount == null || amount === "") {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PARAMS",
          message:
            "Нужны amount и либо telegramId, либо пара lead_type + lead_code (код 7 символов A–Z, 0–9)",
        });
      }

      const amountNum = Number(amount);
      if (!Number.isFinite(amountNum) || amountNum < 1 || amountNum > 100000) {
        return res.status(400).json({ 
          ok: false, 
          error: "INVALID_AMOUNT",
          message: "Сумма должна быть от 1 до 100000 ₽" 
        });
      }

      let user = null;
      /** @type {{ leadType: string, leadCode: string, leadUserCreated: boolean } | null} */
      let leadInfo = null;

      if (hasTg) {
        const mainUser = await getMainUser(telegramId);
        if (!mainUser) {
          return res.status(404).json({ 
            ok: false, 
            error: "USER_NOT_FOUND" 
          });
        }
        user = await prisma.user.findUnique({
          where: { id: mainUser.id }
        });
        if (!user) {
          return res.status(404).json({ 
            ok: false, 
            error: "USER_NOT_FOUND" 
          });
        }
      } else {
        try {
          const r = await getOrCreateUserForLead(prisma, lead_type, lead_code);
          user = r.user;
          leadInfo = {
            leadType: r.leadType,
            leadCode: r.leadCode,
            leadUserCreated: r.created,
          };
        } catch (e) {
          if (e.code === "INVALID_LEAD_TYPE") {
            return res.status(400).json({
              ok: false,
              error: "INVALID_LEAD_TYPE",
              message: "lead_type: 1–32 символа, латиница/цифры/_",
            });
          }
          if (e.code === "INVALID_LEAD_CODE") {
            return res.status(400).json({
              ok: false,
              error: "INVALID_LEAD_CODE",
              message: "lead_code: ровно 7 символов (A–Z, a–z, 0–9)",
            });
          }
          throw e;
        }
      }

      // Создаем счёт через Platega
      const result = await createInvoice(user.id, amountNum, "Пополнение баланса");

      res.json({
        ok: true,
        data: {
          topupId: result.topup.id,
          orderId: result.topup.orderId,
          amount: amountNum,
          paymentUrl: result.link,
          isFallback: result.isFallback || false,
          userId: user.id,
          /** Передайте в POST /api/subscription/buy как telegramId после успешной оплаты (в т.ч. для лидов `lead:...`). */
          billingTelegramId: user.telegramId,
          ...(leadInfo ? { lead: leadInfo } : {}),
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Create topup error:", error);
      res.status(500).json({ 
        ok: false, 
        error: "SERVER_ERROR",
        message: error.message 
      });
    }
  });

  /**
   * GET /api/topup/:orderId/status
   * Проверить статус платежа
   */
  app.get("/api/topup/:orderId/status", async (req, res) => {
    try {
      const { orderId } = req.params;

      const topup = await prisma.topUp.findUnique({
        where: { orderId }
      });

      if (!topup) {
        return res.status(404).json({ 
          ok: false, 
          error: "TOPUP_NOT_FOUND" 
        });
      }

      res.json({
        ok: true,
        data: {
          id: topup.id,
          orderId: topup.orderId,
          amount: topup.amount,
          status: topup.status,
          credited: topup.credited,
          createdAt: topup.createdAt,
          creditedAt: topup.creditedAt
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Get topup status error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  /**
   * GET /api/user/:telegramId/topups
   * Получить ВСЕ пополнения пользователя
   */
  app.get("/api/user/:telegramId/topups", async (req, res) => {
    try {
      const { telegramId } = req.params;
      const { limit, status, credited } = req.query; // ?status=SUCCESS, ?credited=true

      const mainUser = await getMainUser(telegramId);
      if (!mainUser) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: mainUser.id }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const whereClause = { userId: user.id };

      if (status) {
        whereClause.status = status.toUpperCase();
      }

      if (credited === "true") {
        whereClause.credited = true;
      } else if (credited === "false") {
        whereClause.credited = false;
      }

      const topups = await prisma.topUp.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
        take: limit ? Number(limit) : undefined
      });

      // Статистика
      const successfulTopups = topups.filter(t => t.status === "SUCCESS" && t.credited);
      const totalAmount = successfulTopups.reduce((sum, t) => sum + t.amount, 0);

      res.json({
        ok: true,
        data: topups.map(t => ({
          id: t.id,
          orderId: t.orderId,
          billId: t.billId,
          amount: t.amount,
          status: t.status,
          credited: t.credited,
          createdAt: t.createdAt,
          creditedAt: t.creditedAt,
          updatedAt: t.updatedAt
        })),
        stats: {
          total: topups.length,
          successful: successfulTopups.length,
          totalAmount: totalAmount
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Get topups error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  // ==========================================
  // ПОДПИСКИ
  // ==========================================

  /**
   * POST /api/subscription/buy
   * Купить подписку (списать с баланса).
   * Тело: { telegramId, planId } или { lead_type, lead_code, planId } — лид должен уже существовать (после topup/create).
   * Если переданы и telegramId, и lead_* — используется telegramId.
   */
  app.post("/api/subscription/buy", async (req, res) => {
    try {
      const { telegramId, planId, lead_type, lead_code } = req.body || {};

      const hasTg = telegramId != null && String(telegramId).trim() !== "";
      const hasLead =
        lead_type != null &&
        String(lead_type).trim() !== "" &&
        lead_code != null &&
        String(lead_code).trim() !== "";

      if ((!hasTg && !hasLead) || !planId) {
        return res.status(400).json({ 
          ok: false, 
          error: "INVALID_PARAMS",
          message: "Нужны planId и либо telegramId, либо пара lead_type + lead_code" 
        });
      }

      const plan = PLANS[planId];
      if (!plan || planId === "FREE" || planId === "PROMO_10D") {
        return res.status(400).json({ 
          ok: false, 
          error: "INVALID_PLAN",
          message: "Недопустимый тариф" 
        });
      }

      let mainUser;
      if (hasTg) {
        mainUser = await getMainUser(telegramId);
      } else {
        const leadUser = await findUserByLead(prisma, lead_type, lead_code);
        if (!leadUser) {
          return res.status(404).json({
            ok: false,
            error: "LEAD_NOT_FOUND",
            message:
              "Лид не найден. Сначала вызовите POST /api/topup/create с теми же lead_type и lead_code (или проверьте код).",
          });
        }
        mainUser = await withMergedYearRenewalDiscount(prisma, leadUser);
      }

      if (!mainUser) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: mainUser.id }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      // mainUser уже с merge yearRenewalDiscountEndsAt по telegramId; сырой user из БД — нет
      const price = getPlanPrice(planId, mainUser);

      if (user.balance < price) {
        return res.status(400).json({ 
          ok: false, 
          error: "INSUFFICIENT_BALANCE",
          message: "Недостаточно средств на балансе",
          data: {
            balance: user.balance,
            required: price,
            shortage: price - user.balance
          }
        });
      }

      // Транзакция: списываем баланс + создаем подписку (с учётом скидки)
      const result = await prisma.$transaction(async (tx) => {
        // Списываем баланс
        await tx.user.update({
          where: { id: user.id },
          data: { balance: { decrement: price } }
        });

        // Вычисляем дату окончания
        const endDate = new Date();
        if (plan.days) {
          endDate.setDate(endDate.getDate() + plan.days);
        } else {
          endDate.setMonth(endDate.getMonth() + plan.months);
        }

        // Создаем подписку
        const subscription = await tx.subscription.create({
          data: {
            userId: user.id,
            type: planId,
            startDate: new Date(),
            endDate
          }
        });

        return subscription;
      });

      // Создаем пользователя в Marzban / Remnawave
      const tgKey = String(mainUser.telegramId);
      const username = `${tgKey}_${planId}_${result.id}`;
      const expireSeconds = plan.days
        ? plan.days * 24 * 60 * 60
        : plan.months * 30 * 24 * 60 * 60;
      const expire = Math.floor(Date.now() / 1000) + expireSeconds;

      const userData = {
        username,
        status: "active",
        expire,
        proxies: {
          vless: {
            id: crypto.randomUUID(),
            flow: "xtls-rprx-vision"
          }
        },
        inbounds: { vless: ["VLESS TCP REALITY", "VLESS-TCP-REALITY-VISION"] },
        note: `Telegram user ${user.accountName || tgKey}`,
        data_limit: 0,
        data_limit_reset_strategy: "no_reset"
      };

      const { url1, url2, remnawaveUuid } = await createMarzbanUserOnBothServers(userData);

      if (!url1) {
        // Fail-safe: если ссылка не получена, откатываем покупку полностью
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: { balance: { increment: price } },
          });
          await tx.subscription.deleteMany({ where: { id: result.id } });
        });
        return res.status(502).json({
          ok: false,
          error: "SUBSCRIPTION_PROVISION_FAILED",
          message: "VPN API не вернул ссылку подписки. Списание отменено, попробуйте позже.",
        });
      }

      // Обновляем подписку с URL и uuid Remnawave
      const updatedSub = await prisma.subscription.update({
        where: { id: result.id },
        data: {
          subscriptionUrl: url1,
          subscriptionUrl2: url2,
          ...(remnawaveUuid ? { remnawaveUuid } : {}),
        },
      });

      // Получаем обновленный баланс
      const updatedUser = await prisma.user.findUnique({
        where: { id: user.id }
      });

      res.json({
        ok: true,
        data: {
          subscription: {
            id: updatedSub.id,
            type: updatedSub.type,
            startDate: updatedSub.startDate,
            endDate: updatedSub.endDate,
            subscriptionUrl: updatedSub.subscriptionUrl,
            subscriptionUrl2: updatedSub.subscriptionUrl2
          },
          newBalance: updatedUser.balance,
          charged: price
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Buy subscription error:", error);
      res.status(500).json({ 
        ok: false, 
        error: "SERVER_ERROR",
        message: error.message 
      });
    }
  });

  /**
   * GET /api/subscription/:id
   * Получить информацию о подписке
   */
  app.get("/api/subscription/:id", async (req, res) => {
    try {
      const { id } = req.params;

      const subscription = await prisma.subscription.findUnique({
        where: { id: Number(id) },
        include: { user: true }
      });

      if (!subscription) {
        return res.status(404).json({ 
          ok: false, 
          error: "SUBSCRIPTION_NOT_FOUND" 
        });
      }

      res.json({
        ok: true,
        data: {
          id: subscription.id,
          type: subscription.type,
          startDate: subscription.startDate,
          endDate: subscription.endDate,
          subscriptionUrl: subscription.subscriptionUrl,
          subscriptionUrl2: subscription.subscriptionUrl2,
          isActive: subscription.endDate > new Date(),
          daysLeft: subscription.endDate 
            ? Math.ceil((new Date(subscription.endDate) - new Date()) / (1000 * 60 * 60 * 24)) 
            : null,
          user: {
            telegramId: subscription.user.telegramId,
            username: subscription.user.accountName
          }
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Get subscription error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  /**
   * GET /api/user/:telegramId/duplicates
   * Проверка дубликатов пользователя
   */
  app.get("/api/user/:telegramId/duplicates", async (req, res) => {
    try {
      const { telegramId } = req.params;
      const telegramIdStr = String(telegramId);
      
      // Ищем всех пользователей
      const allUsers = await prisma.user.findMany({
        where: { telegramId: telegramIdStr },
        include: {
          subscriptions: { select: { id: true } },
          topUps: { select: { id: true } }
        },
        orderBy: { id: "asc" }
      });

      // Фильтруем только пользователей из ЛС (chatId === telegramId)
      const users = allUsers.filter(u => u.chatId === telegramIdStr);
      const groupUsers = allUsers.filter(u => u.chatId !== telegramIdStr);

      if (users.length === 0 && allUsers.length === 0) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      if (users.length === 0 && groupUsers.length > 0) {
        return res.status(404).json({
          ok: false,
          error: "USER_NOT_FOUND_IN_PRIVATE",
          message: "Пользователь найден только в группах/чатах, не в личных сообщениях",
          data: {
            groupUsers: groupUsers.length,
            totalUsers: allUsers.length
          }
        });
      }

      const usersData = users.map(user => ({
        id: user.id,
        chatId: user.chatId,
        username: user.accountName,
        balance: user.balance,
        promoCode: user.promoCode,
        subscriptionsCount: user.subscriptions.length,
        topupsCount: user.topUps.length,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        activity: user.balance + (user.subscriptions.length * 10) + user.topUps.length
      }));

      // Определяем основного пользователя
      const mainUser = usersData.reduce((prev, curr) => 
        curr.activity > prev.activity ? curr : prev
      );

      res.json({
        ok: true,
        data: {
          totalUsers: users.length,
          totalGroupUsers: groupUsers.length,
          hasDuplicates: users.length > 1,
          mainUser: mainUser,
          allUsers: usersData,
          groupUsers: groupUsers.map(u => ({
            id: u.id,
            chatId: u.chatId,
            username: u.accountName,
            balance: u.balance,
            subscriptionsCount: u.subscriptions.length,
            topupsCount: u.topUps.length
          })),
          recommendation: users.length > 1 
            ? "Обнаружены дубликаты пользователя в ЛС. Рекомендуется объединить данные."
            : groupUsers.length > 0
            ? `Пользователь найден в ${groupUsers.length} группе(ах), но не в ЛС. Записи из групп игнорируются.`
            : "Дубликатов не найдено."
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Check duplicates error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR", message: error.message });
    }
  });

  /**
   * GET /api/user/:telegramId/balance/debug
   * Диагностика баланса (детальная информация)
   */
  app.get("/api/user/:telegramId/balance/debug", async (req, res) => {
    try {
      const { telegramId } = req.params;
      
      const mainUser = await getMainUser(telegramId);
      if (!mainUser) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: mainUser.id },
        select: { 
          id: true, 
          balance: true, 
          telegramId: true,
          accountName: true,
          updatedAt: true
        }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      // Все успешные пополнения
      const topups = await prisma.topUp.findMany({
        where: { 
          userId: user.id,
          status: "SUCCESS",
          credited: true
        },
        orderBy: { creditedAt: "desc" }
      });

      // Все подписки (платные)
      const subscriptions = await prisma.subscription.findMany({
        where: { 
          userId: user.id,
          type: { in: ["D7", "M1", "M3", "M6", "M12"] }
        },
        orderBy: { startDate: "desc" }
      });

      // Реферальные бонусы (20% от пополнений активаторов)
      const referralBonuses = await prisma.referralBonus.findMany({
        where: { codeOwnerId: user.id },
        include: {
          activator: {
            select: { telegramId: true, accountName: true }
          }
        },
        orderBy: { createdAt: "desc" }
      });

      // Админские промокоды использованные
      const adminPromos = await prisma.adminPromo.findMany({
        where: { usedById: user.id },
        orderBy: { usedAt: "desc" }
      });

      // Расчет баланса
      const totalTopups = topups.reduce((sum, t) => sum + t.amount, 0);
      const totalSpent = subscriptions.reduce((sum, s) => {
        const plan = PLANS[s.type];
        return sum + (plan ? plan.price : 0);
      }, 0);
      const promoBonus = referralBonuses.filter(b => b.credited).reduce((sum, b) => sum + b.bonusAmount, 0);
      const adminBonus = adminPromos.reduce((sum, p) => sum + (p.amount || 0), 0);
      const calculatedBalance = totalTopups + promoBonus + adminBonus - totalSpent;

      res.json({
        ok: true,
        data: {
          user: {
            id: user.id,
            telegramId: user.telegramId,
            username: user.accountName,
            currentBalance: Number(user.balance),
            calculatedBalance: calculatedBalance,
            discrepancy: Number(user.balance) - calculatedBalance,
            lastUpdated: user.updatedAt
          },
          transactions: {
            topups: topups.map(t => ({
              id: t.id,
              amount: t.amount,
              creditedAt: t.creditedAt,
              orderId: t.orderId
            })),
            subscriptions: subscriptions.map(s => ({
              id: s.id,
              type: s.type,
              price: PLANS[s.type]?.price || 0,
              startDate: s.startDate
            })),
            referralBonuses: referralBonuses.map(b => ({
              id: b.id,
              bonusAmount: b.bonusAmount,
              amount: b.amount,
              credited: b.credited,
              createdAt: b.createdAt,
              activator: b.activator
            })),
            adminPromos: adminPromos.map(p => ({
              id: p.id,
              code: p.code,
              amount: p.amount,
              usedAt: p.usedAt
            }))
          },
          summary: {
            totalTopups: totalTopups,
            totalSpent: totalSpent,
            promoBonus: promoBonus,
            adminBonus: adminBonus,
            calculatedBalance: calculatedBalance,
            currentBalance: Number(user.balance),
            balanceMatches: Number(user.balance) === calculatedBalance
          }
        }
      });
    } catch (error) {
      console.error("[WEBAPP] Balance debug error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR", message: error.message });
    }
  });

  // ==========================================
  // WEBHOOKS (для уведомлений Web App)
  // ==========================================

  /**
   * POST /api/webhook/register
   * Зарегистрировать webhook для получения уведомлений
   */
  app.post("/api/webhook/register", async (req, res) => {
    try {
      const { telegramId, webhookUrl, events } = req.body;

      // Здесь можно сохранить webhook в БД для отправки уведомлений
      // Пока просто возвращаем успех
      console.log("[WEBAPP] Webhook registered:", { telegramId, webhookUrl, events });

      res.json({
        ok: true,
        message: "Webhook зарегистрирован",
        data: { telegramId, webhookUrl, events }
      });
    } catch (error) {
      console.error("[WEBAPP] Register webhook error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  console.log("🌐 Web App API endpoints registered");
}

module.exports = { registerWebAppAPI, WEBAPP_SECRET };
