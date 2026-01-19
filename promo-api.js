// promo-api.js - API для работы с промокодами
const { prisma } = require("./db");
const { ruMoney } = require("./menus");
const { ADMIN_BROADCAST_SECRET } = require("./broadcast-api");

/**
 * Middleware для проверки админ-доступа
 */
function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers["x-admin-secret"];
  
  if (authHeader !== ADMIN_BROADCAST_SECRET) {
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

      // Проверяем, админский ли это промокод (GIFT...)
      if (upperCode.startsWith("GIFT")) {
        const result = await activateAdminPromoAPI(user.id, upperCode);
        
        if (!result.ok) {
          return res.status(400).json({
            ok: false,
            error: result.error,
            message: result.message
          });
        }

        // Получаем обновленный баланс
        const updatedUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { balance: true }
        });

        return res.json({
          ok: true,
          data: {
            type: "admin",
            amount: result.amount,
            balance: updatedUser.balance,
            message: `🎉 Промокод активирован! Начислено: ${ruMoney(result.amount)}. Ваш баланс: ${ruMoney(updatedUser.balance)}`
          }
        });
      }

      // Клиентский промокод
      const result = await activateClientPromoAPI(user.id, upperCode);

      if (!result.ok) {
        return res.status(400).json({
          ok: false,
          error: result.error,
          message: result.message
        });
      }

      return res.json({
        ok: true,
        data: {
          type: "client",
          amount: result.amount || 0,
          message: result.message
        }
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

      const promos = await prisma.adminPromo.findMany({
        where: {
          usedById: null // Только неиспользованные
        },
        orderBy: {
          createdAt: "desc"
        },
        take: Number(limit),
        skip: Number(offset),
        include: {
          // Информация о создателе (если есть)
        }
      });

      const total = await prisma.adminPromo.count({
        where: {
          usedById: null
        }
      });

      res.json({
        ok: true,
        data: {
          promos: promos.map(p => ({
            id: p.id,
            code: p.code,
            amount: p.amount,
            createdAt: p.createdAt,
            createdBy: p.createdBy,
            isUsed: false
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
          accountName: true,
          promoCode: true,
          createdAt: true,
          ...(withActivations === "true" && {
            promoActivationsAsOwner: {
              select: {
                id: true,
                amount: true,
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
                totalAmount: u.promoActivationsAsOwner?.reduce((sum, a) => sum + a.amount, 0) || 0,
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

      // Админские промокоды
      const adminPromos = await prisma.adminPromo.findMany({
        where: {
          usedById: null
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
              amount: p.amount,
              createdAt: p.createdAt,
              createdBy: p.createdBy,
              type: "admin"
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

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

/**
 * Активация админского промокода
 */
async function activateAdminPromoAPI(userId, code) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const promo = await tx.adminPromo.findUnique({
        where: { code }
      });

      if (!promo) {
        return { ok: false, error: "NOT_FOUND", message: "Промокод не найден" };
      }

      if (promo.usedById) {
        return { ok: false, error: "ALREADY_USED", message: "Промокод уже использован" };
      }

      await tx.adminPromo.update({
        where: { id: promo.id },
        data: {
          usedById: userId,
          usedAt: new Date()
        }
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          balance: { increment: promo.amount }
        }
      });

      return { ok: true, amount: promo.amount };
    });

    return result;
  } catch (error) {
    console.error("[PROMO API] Admin promo activation error:", error);
    return { ok: false, error: "SERVER_ERROR", message: error.message };
  }
}

/**
 * Активация клиентского промокода
 */
async function activateClientPromoAPI(userId, code) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const me = await tx.user.findUnique({ where: { id: userId } });
      if (!me) {
        return { ok: false, error: "USER_NOT_FOUND", message: "Пользователь не найден" };
      }

      const owner = await tx.user.findUnique({
        where: { promoCode: code }
      });

      if (!owner) {
        return { ok: false, error: "NOT_FOUND", message: "Промокод не найден" };
      }

      if (owner.id === me.id) {
        return { ok: false, error: "SELF_ACTIVATION", message: "Нельзя активировать свой промокод" };
      }

      const already = await tx.promoActivation.findUnique({
        where: { activatorId: me.id }
      });

      if (already) {
        return { ok: false, error: "ALREADY_ACTIVATED", message: "Вы уже активировали промокод ранее" };
      }

      // Создаем активацию
      await tx.promoActivation.create({
        data: {
          codeOwnerId: owner.id,
          activatorId: me.id,
          amount: 100 // Стандартный бонус для клиентского промокода
        }
      });

      // Возвращаем успех - создание подписки вынесем за транзакцию
      return {
        ok: true,
        userId: me.id,
        telegramId: me.telegramId
      };
    });

    // Создаем промо-подписку на 10 дней (вне транзакции)
    if (result.ok) {
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 10);

      const { createMarzbanUserOnBothServers } = require("./marzban-utils");
      const crypto = require("crypto");
      const username = `${result.telegramId}_PROMO_10D_${Date.now()}`;
      const expire = Math.floor(endDate.getTime() / 1000);

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
        note: `Promo user ${result.telegramId}`,
        data_limit: 0,
        data_limit_reset_strategy: "no_reset"
      };

      const { url1, url2 } = await createMarzbanUserOnBothServers(userData);

      await prisma.subscription.create({
        data: {
          userId: result.userId,
          type: "PROMO_10D",
          startDate: new Date(),
          endDate,
          subscriptionUrl: url1,
          subscriptionUrl2: url2
        }
      });

      return {
        ok: true,
        message: "🎉 Промокод активирован! Вам начислена бесплатная подписка на 10 дней."
      };
    }

    return result;
  } catch (error) {
    console.error("[PROMO API] Client promo activation error:", error);
    return { ok: false, error: "SERVER_ERROR", message: error.message };
  }
}

module.exports = { registerPromoAPI };
