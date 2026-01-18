// webapp-api.js - API для Telegram Web App
const crypto = require("crypto");
const { prisma } = require("./db");
const { createInvoice } = require("./payment");
const { createMarzbanUserOnBothServers } = require("./marzban-utils");
const { PLANS } = require("./menus");

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
   * Если есть дубликаты - выбирает того, у кого больше активности
   */
  async function getMainUser(telegramId) {
    const users = await prisma.user.findMany({
      where: { telegramId: String(telegramId) },
      include: {
        subscriptions: { select: { id: true } },
        topUps: { select: { id: true } }
      },
      orderBy: { id: "asc" } // Самый старый - основной
    });

    if (users.length === 0) {
      return null;
    }

    if (users.length === 1) {
      return users[0];
    }

    // Если есть дубликаты - выбираем того, у кого больше активности
    // Подсчитываем активность: баланс + количество подписок + количество пополнений
    const usersWithActivity = users.map(user => ({
      user,
      activity: user.balance + (user.subscriptions.length * 10) + user.topUps.length
    }));

    // Сортируем по активности (по убыванию), затем по ID (по возрастанию - самый старый)
    usersWithActivity.sort((a, b) => {
      if (b.activity !== a.activity) {
        return b.activity - a.activity;
      }
      return a.user.id - b.user.id;
    });

    const mainUser = usersWithActivity[0].user;

    // Логируем предупреждение если есть дубликаты
    if (users.length > 1) {
      console.warn(`[WEBAPP] Найдено ${users.length} пользователей с telegramId ${telegramId}, используется ID ${mainUser.id}`);
    }

    return mainUser;
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
      const paidSubscriptions = user.subscriptions.filter(s => ["M1", "M3", "M6", "M12"].includes(s.type));
      const totalSpent = paidSubscriptions.reduce((sum, sub) => {
        const plan = PLANS[sub.type];
        return sum + (plan ? plan.price : 0);
      }, 0);

      const promoBonusReceived = user.promoActivationsAsOwner.reduce((sum, a) => sum + a.amount, 0);
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
          
          // Промокоды (где пользователь - владелец)
          promoActivationsReceived: user.promoActivationsAsOwner.map(activation => ({
            id: activation.id,
            amount: activation.amount,
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
            amount: user.promoActivationAsUser.amount,
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
          type: { in: ["M1", "M3", "M6", "M12"] }
        },
        select: { type: true }
      });

      // Считаем сколько потрачено на подписки
      const PLANS = require("./menus").PLANS;
      const totalSpent = paidSubscriptions.reduce((sum, sub) => {
        const plan = PLANS[sub.type];
        return sum + (plan ? plan.price : 0);
      }, 0);

      // Получаем промо-активации (если пользователь получил бонус от своих промокодов)
      const promoActivations = await prisma.promoActivation.findMany({
        where: { codeOwnerId: user.id },
        select: { amount: true }
      });
      const promoBonusReceived = promoActivations.reduce((sum, a) => sum + a.amount, 0);

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

      res.json({
        ok: true,
        data: { 
          balance: Number(user.balance),
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

      if (type && ["M1", "M3", "M6", "M12", "PROMO_10D", "FREE"].includes(type)) {
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
            totalReceivedAmount: user.promoActivationsAsOwner.reduce((sum, a) => sum + a.amount, 0),
            hasActivated: !!user.promoActivationAsUser,
            activatedAmount: user.promoActivationAsUser?.amount || 0
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

      res.json({
        ok: true,
        data: {
          promoCode: user.promoCode,
          hasPromoCode: !!user.promoCode,
          activations: {
            count: user.promoActivationsAsOwner.length,
            totalAmount: user.promoActivationsAsOwner.reduce((sum, a) => sum + a.amount, 0),
            list: user.promoActivationsAsOwner.map(a => ({
              id: a.id,
              amount: a.amount,
              createdAt: a.createdAt,
              activator: {
                id: a.activator.id,
                telegramId: a.activator.telegramId,
                username: a.activator.accountName
              }
            }))
          },
          activated: user.promoActivationAsUser ? {
            amount: user.promoActivationAsUser.amount,
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
   * Получить список тарифов
   */
  app.get("/api/plans", (req, res) => {
    const plans = Object.entries(PLANS)
      .filter(([key]) => key !== "PROMO_10D" && key !== "FREE")
      .map(([key, plan]) => ({
        id: key,
        label: plan.label,
        price: plan.price,
        months: plan.months,
        pricePerMonth: Math.round(plan.price / plan.months)
      }));

    res.json({
      ok: true,
      data: plans
    });
  });

  /**
   * POST /api/topup/create
   * Создать счёт на пополнение баланса
   */
  app.post("/api/topup/create", async (req, res) => {
    try {
      const { telegramId, amount } = req.body;

      if (!telegramId || !amount) {
        return res.status(400).json({ 
          ok: false, 
          error: "INVALID_PARAMS",
          message: "telegramId и amount обязательны" 
        });
      }

      const amountNum = Number(amount);
      if (amountNum < 50 || amountNum > 100000) {
        return res.status(400).json({ 
          ok: false, 
          error: "INVALID_AMOUNT",
          message: "Сумма должна быть от 50 до 100000 ₽" 
        });
      }

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

      // Создаем счёт через Platega
      const result = await createInvoice(user.id, amountNum, "Пополнение баланса");

      res.json({
        ok: true,
        data: {
          topupId: result.topup.id,
          orderId: result.topup.orderId,
          amount: amountNum,
          paymentUrl: result.link,
          isFallback: result.isFallback || false
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
   * Купить подписку (списать с баланса)
   */
  app.post("/api/subscription/buy", async (req, res) => {
    try {
      const { telegramId, planId } = req.body;

      if (!telegramId || !planId) {
        return res.status(400).json({ 
          ok: false, 
          error: "INVALID_PARAMS",
          message: "telegramId и planId обязательны" 
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

      if (user.balance < plan.price) {
        return res.status(400).json({ 
          ok: false, 
          error: "INSUFFICIENT_BALANCE",
          message: "Недостаточно средств на балансе",
          data: {
            balance: user.balance,
            required: plan.price,
            shortage: plan.price - user.balance
          }
        });
      }

      // Транзакция: списываем баланс + создаем подписку
      const result = await prisma.$transaction(async (tx) => {
        // Списываем баланс
        await tx.user.update({
          where: { id: user.id },
          data: { balance: { decrement: plan.price } }
        });

        // Вычисляем дату окончания
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + plan.months);

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

      // Создаем пользователя в Marzban
      const username = `${telegramId}_${planId}_${result.id}`;
      const expireSeconds = plan.months * 30 * 24 * 60 * 60;
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
        note: `Telegram user ${user.accountName || telegramId}`,
        data_limit: 0,
        data_limit_reset_strategy: "no_reset"
      };

      const { url1, url2 } = await createMarzbanUserOnBothServers(userData);

      // Обновляем подписку с URL
      const updatedSub = await prisma.subscription.update({
        where: { id: result.id },
        data: {
          subscriptionUrl: url1,
          subscriptionUrl2: url2
        }
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
          charged: plan.price
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
      
      const users = await prisma.user.findMany({
        where: { telegramId: String(telegramId) },
        include: {
          subscriptions: { select: { id: true } },
          topUps: { select: { id: true } }
        },
        orderBy: { id: "asc" }
      });

      if (users.length === 0) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
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
          hasDuplicates: users.length > 1,
          mainUser: mainUser,
          allUsers: usersData,
          recommendation: users.length > 1 
            ? "Обнаружены дубликаты пользователя. Рекомендуется объединить данные."
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
          type: { in: ["M1", "M3", "M6", "M12"] }
        },
        orderBy: { startDate: "desc" }
      });

      // Промо-бонусы полученные
      const promoActivations = await prisma.promoActivation.findMany({
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
      const promoBonus = promoActivations.reduce((sum, a) => sum + a.amount, 0);
      const adminBonus = adminPromos.reduce((sum, p) => sum + p.amount, 0);
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
            promoActivations: promoActivations.map(a => ({
              id: a.id,
              amount: a.amount,
              createdAt: a.createdAt,
              activator: a.activator
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
