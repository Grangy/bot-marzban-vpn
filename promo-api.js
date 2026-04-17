// promo-api.js - API для работы с промокодами
const { prisma } = require("./db");
const { ruMoney } = require("./menus");
const { ADMIN_BROADCAST_SECRET, adminSecretMatches } = require("./broadcast-api");
const { activatePromoCode, detectPromoType, PROMO_TYPES } = require("./promo-manager");
const { getReferralStats } = require("./referral-bonus");

/**
 * Middleware для проверки админ-доступа
 */
function adminAuthMiddleware(req, res, next) {
  if (!adminSecretMatches(req.headers["x-admin-secret"])) {
    return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED",
      message: "Invalid admin secret"
    });
  }

  next();
}

/**
 * Регистрация API endpoints для промокодов
 */
function registerPromoAPI(app) {
  // Применяем middleware только к админским endpoints
  app.use("/api/promo/admin", adminAuthMiddleware);
  // ==========================================
  // АКТИВАЦИЯ ПРОМОКОДА
  // ==========================================

  /**
   * POST /api/promo/activate
   * Активировать промокод (клиентский или админский)
   */
  app.post("/api/promo/activate", async (req, res) => {
    try {
      const { telegramId, code } = req.body;

      if (!telegramId || !code) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PARAMS",
          message: "telegramId и code обязательны"
        });
      }

      const upperCode = code.toUpperCase().trim();

      // Получаем пользователя
      const user = await prisma.user.findFirst({
        where: {
          telegramId: String(telegramId),
          chatId: String(telegramId) // Только из ЛС
        }
      });

      if (!user) {
        return res.status(404).json({
          ok: false,
          error: "USER_NOT_FOUND",
          message: "Пользователь не найден"
        });
      }

      // Автоматически определяем тип промокода и активируем через новый модуль
      const result = await activatePromoCode(user.id, upperCode);

      if (!result.ok) {
        return res.status(400).json({
          ok: false,
          error: "ACTIVATION_FAILED",
          message: result.message
        });
      }

      // Формируем детальный ответ в зависимости от типа промокода
      const responseData = {
        promoType: result.type, // Тип промокода: "referral", "admin_balance", "admin_days"
        promoCategory: result.type === PROMO_TYPES.ADMIN_BALANCE ? "money" : 
                      (result.type === PROMO_TYPES.ADMIN_DAYS ? "days" : "referral"), // Категория: "money", "days", "referral"
        message: result.message,
        code: upperCode
      };

      // Для промокодов на баланс (деньги)
      if (result.type === PROMO_TYPES.ADMIN_BALANCE && result.data?.amount) {
        const updatedUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { balance: true }
        });
        responseData.reward = {
          type: "balance",
          amount: result.data.amount,
          currency: "RUB"
        };
        responseData.balance = {
          current: updatedUser.balance,
          currency: "RUB"
        };
      }

      // Для промокодов на дни (подписка)
      if (result.type === PROMO_TYPES.ADMIN_DAYS || result.type === PROMO_TYPES.REFERRAL) {
        if (result.data?.subscriptionId) {
          const subscription = await prisma.subscription.findUnique({
            where: { id: result.data.subscriptionId },
            select: { 
              subscriptionUrl: true, 
              subscriptionUrl2: true, 
              endDate: true,
              startDate: true
            }
          });
          
          responseData.reward = {
            type: "subscription",
            days: result.data.days || (result.type === PROMO_TYPES.REFERRAL ? 3 : null),
            startDate: subscription?.startDate,
            endDate: subscription?.endDate
          };
          
          responseData.subscription = {
            id: result.data.subscriptionId,
            subscriptionUrl: subscription?.subscriptionUrl,
            subscriptionUrl2: subscription?.subscriptionUrl2,
            startDate: subscription?.startDate,
            endDate: subscription?.endDate
          };
        }
      }

      return res.json({
        ok: true,
        data: responseData
      });
    } catch (error) {
      console.error("[PROMO API] Activate error:", error);
      res.status(500).json({
        ok: false,
        error: "SERVER_ERROR",
        message: error.message
      });
    }
  });

  /**
   * GET /api/user/:telegramId/promo
   * Получить промокод пользователя
   */
  app.get("/api/user/:telegramId/promo", async (req, res) => {
    try {
      const { telegramId } = req.params;

      const user = await prisma.user.findFirst({
        where: {
          telegramId: String(telegramId),
          chatId: String(telegramId) // Только из ЛС
        },
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

      // Получаем статистику реферальных бонусов
      const referralStats = await getReferralStats(user.id);

      res.json({
        ok: true,
        data: {
          promoCode: user.promoCode,
          hasPromoCode: !!user.promoCode,
          activations: {
            count: user.promoActivationsAsOwner.length,
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
          referralStats: {
            totalBonusAmount: referralStats.totalBonusAmount,
            totalTopupsAmount: referralStats.totalTopupsAmount,
            bonusesCount: referralStats.bonuses.length
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
      console.error("[PROMO API] Get user promo error:", error);
      res.status(500).json({
        ok: false,
        error: "SERVER_ERROR",
        message: error.message
      });
    }
  });

  // ==========================================
  // СПИСКИ ПРОМОКОДОВ
  // ==========================================

  /**
   * GET /api/promo/admin/list
   * Получить список актуальных админских промокодов (неиспользованных)
   */
  app.get("/api/promo/admin/list", async (req, res) => {
    try {
      const { limit = 50, offset = 0 } = req.query;

      // Получаем активные промокоды (неиспользованные одноразовые + многоразовые)
      const promos = await prisma.adminPromo.findMany({
        where: {
          OR: [
            { usedById: null, isReusable: false }, // Одноразовые неиспользованные
            { isReusable: true } // Все многоразовые
          ]
        },
        orderBy: {
          createdAt: "desc"
        },
        take: Number(limit),
        skip: Number(offset)
      });

      const total = await prisma.adminPromo.count({
        where: {
          OR: [
            { usedById: null, isReusable: false },
            { isReusable: true }
          ]
        }
      });

      res.json({
        ok: true,
        data: {
          promos: promos.map(p => ({
            id: p.id,
            code: p.code,
            type: p.type,
            amount: p.amount,
            days: p.days,
            isReusable: p.isReusable,
            customName: p.customName,
            useCount: p.useCount,
            createdAt: p.createdAt,
            createdBy: p.createdBy,
            isUsed: !p.isReusable && !!p.usedById
          })),
          total,
          limit: Number(limit),
          offset: Number(offset)
        }
      });
    } catch (error) {
      console.error("[PROMO API] Admin list error:", error);
      res.status(500).json({
        ok: false,
        error: "SERVER_ERROR",
        message: error.message
      });
    }
  });

  /**
   * GET /api/promo/client/list
   * Получить список клиентских промокодов (пользователей с промокодами)
   */
  app.get("/api/promo/client/list", async (req, res) => {
    try {
      const { limit = 50, offset = 0, withActivations = false } = req.query;

      // Получаем всех пользователей с промокодами
      const allUsers = await prisma.user.findMany({
        where: {
          promoCode: { not: null }
        },
        select: {
          id: true,
          telegramId: true,
          chatId: true,
          accountName: true,
          promoCode: true,
          createdAt: true,
          ...(withActivations === "true" && {
            promoActivationsAsOwner: {
              select: {
                id: true,
                createdAt: true,
                activator: {
                  select: {
                    telegramId: true,
                    accountName: true
                  }
                }
              },
              orderBy: { createdAt: "desc" }
            }
          })
        },
        orderBy: {
          createdAt: "desc"
        },
        take: Number(limit),
        skip: Number(offset)
      });

      // Фильтруем только пользователей из ЛС (chatId === telegramId)
      const privateChatUsers = allUsers.filter(u => {
        return u.promoCode && String(u.chatId) === String(u.telegramId);
      });

      const totalUsers = await prisma.user.findMany({
        where: {
          promoCode: { not: null }
        }
      });
      const total = totalUsers.filter(u => String(u.chatId) === String(u.telegramId)).length;

      res.json({
        ok: true,
        data: {
          promos: privateChatUsers.map(u => ({
            userId: u.id,
            telegramId: u.telegramId,
            username: u.accountName,
            promoCode: u.promoCode,
            createdAt: u.createdAt,
            ...(withActivations === "true" && {
              activations: {
                count: u.promoActivationsAsOwner?.length || 0,
                list: u.promoActivationsAsOwner || []
              }
            })
          })),
          total,
          limit: Number(limit),
          offset: Number(offset)
        }
      });
    } catch (error) {
      console.error("[PROMO API] Client list error:", error);
      res.status(500).json({
        ok: false,
        error: "SERVER_ERROR",
        message: error.message
      });
    }
  });

  /**
   * GET /api/promo/list
   * Получить список всех актуальных промокодов (админские + клиентские)
   */
  app.get("/api/promo/list", async (req, res) => {
    try {
      const { adminLimit = 20, clientLimit = 20 } = req.query;

      // Админские промокоды (активные)
      const adminPromos = await prisma.adminPromo.findMany({
        where: {
          OR: [
            { usedById: null, isReusable: false },
            { isReusable: true }
          ]
        },
        orderBy: {
          createdAt: "desc"
        },
        take: Number(adminLimit)
      });

      // Клиентские промокоды
      const allClientUsers = await prisma.user.findMany({
        where: {
          promoCode: { not: null }
        },
        select: {
          telegramId: true,
          chatId: true,
          accountName: true,
          promoCode: true,
          createdAt: true,
          promoActivationsAsOwner: {
            select: {
              id: true
            }
          }
        },
        orderBy: {
          createdAt: "desc"
        }
      });

      // Фильтруем только пользователей из ЛС (chatId === telegramId)
      const privateChatUsers = allClientUsers
        .filter(u => u.promoCode && String(u.chatId) === String(u.telegramId))
        .slice(0, Number(clientLimit));

      res.json({
        ok: true,
        data: {
          admin: {
            promos: adminPromos.map(p => ({
              code: p.code,
              type: p.type,
              amount: p.amount,
              days: p.days,
              isReusable: p.isReusable,
              customName: p.customName,
              useCount: p.useCount,
              createdAt: p.createdAt,
              createdBy: p.createdBy,
              promoType: "admin"
            })),
            total: adminPromos.length
          },
          client: {
            promos: privateChatUsers.map(u => ({
              code: u.promoCode,
              username: u.accountName,
              telegramId: u.telegramId,
              activationsCount: u.promoActivationsAsOwner.length,
              createdAt: u.createdAt,
              type: "client"
            })),
            total: privateChatUsers.length
          }
        }
      });
    } catch (error) {
      console.error("[PROMO API] List error:", error);
      res.status(500).json({
        ok: false,
        error: "SERVER_ERROR",
        message: error.message
      });
    }
  });

  console.log("🎁 Promo API endpoints registered");
}

// Старые функции удалены - теперь используется promo-manager.js

module.exports = { registerPromoAPI };
