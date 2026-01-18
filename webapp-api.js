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
   * GET /api/user/:telegramId
   * Получить данные пользователя (личный кабинет)
   */
  app.get("/api/user/:telegramId", async (req, res) => {
    try {
      const { telegramId } = req.params;
      
      const user = await prisma.user.findFirst({
        where: { telegramId: String(telegramId) },
        include: {
          subscriptions: {
            where: {
              type: { not: "FREE" },
              endDate: { gt: new Date() }
            },
            orderBy: { endDate: "desc" }
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

      // Форматируем данные для ответа
      const response = {
        ok: true,
        data: {
          id: user.id,
          telegramId: user.telegramId,
          username: user.accountName,
          balance: user.balance,
          createdAt: user.createdAt,
          subscriptions: user.subscriptions.map(sub => ({
            id: sub.id,
            type: sub.type,
            startDate: sub.startDate,
            endDate: sub.endDate,
            subscriptionUrl: sub.subscriptionUrl,
            subscriptionUrl2: sub.subscriptionUrl2,
            isActive: sub.endDate > new Date(),
            daysLeft: Math.ceil((new Date(sub.endDate) - new Date()) / (1000 * 60 * 60 * 24))
          }))
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
   * Получить баланс пользователя
   */
  app.get("/api/user/:telegramId/balance", async (req, res) => {
    try {
      const { telegramId } = req.params;
      
      const user = await prisma.user.findFirst({
        where: { telegramId: String(telegramId) },
        select: { id: true, balance: true }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      res.json({
        ok: true,
        data: { balance: user.balance }
      });
    } catch (error) {
      console.error("[WEBAPP] Get balance error:", error);
      res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  });

  /**
   * GET /api/user/:telegramId/subscriptions
   * Получить подписки пользователя
   */
  app.get("/api/user/:telegramId/subscriptions", async (req, res) => {
    try {
      const { telegramId } = req.params;
      const { active } = req.query; // ?active=true - только активные
      
      const user = await prisma.user.findFirst({
        where: { telegramId: String(telegramId) }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const whereClause = {
        userId: user.id,
        type: { not: "FREE" }
      };

      if (active === "true") {
        whereClause.endDate = { gt: new Date() };
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
          isActive: sub.endDate > new Date(),
          daysLeft: sub.endDate ? Math.ceil((new Date(sub.endDate) - new Date()) / (1000 * 60 * 60 * 24)) : null
        }))
      });
    } catch (error) {
      console.error("[WEBAPP] Get subscriptions error:", error);
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

      const user = await prisma.user.findFirst({
        where: { telegramId: String(telegramId) }
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
   * История пополнений пользователя
   */
  app.get("/api/user/:telegramId/topups", async (req, res) => {
    try {
      const { telegramId } = req.params;
      const { limit = 20 } = req.query;

      const user = await prisma.user.findFirst({
        where: { telegramId: String(telegramId) }
      });

      if (!user) {
        return res.status(404).json({ 
          ok: false, 
          error: "USER_NOT_FOUND" 
        });
      }

      const topups = await prisma.topUp.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: Number(limit)
      });

      res.json({
        ok: true,
        data: topups.map(t => ({
          id: t.id,
          orderId: t.orderId,
          amount: t.amount,
          status: t.status,
          credited: t.credited,
          createdAt: t.createdAt
        }))
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

      const user = await prisma.user.findFirst({
        where: { telegramId: String(telegramId) }
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
