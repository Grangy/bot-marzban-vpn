// broadcast-api.js - API для веб-интерфейса рассылок
const { broadcastMessage } = require("./broadcast");
const { Markup } = require("telegraf");

// Секретный ключ для авторизации админ-панели
const ADMIN_BROADCAST_SECRET = process.env.ADMIN_BROADCAST_SECRET || "maxgroot_admin_broadcast_2026";

/**
 * Middleware для проверки авторизации админа
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
 * Регистрация API endpoints для рассылок
 */
function registerBroadcastAPI(app) {
  // Применяем middleware ко всем /admin/broadcast/* маршрутам
  app.use("/admin/broadcast", adminAuthMiddleware);

  /**
   * POST /admin/broadcast/send
   * Запустить рассылку
   */
  app.post("/admin/broadcast/send", async (req, res) => {
    try {
      const { type, message, telegramId, parseMode, hasWebAppButton, photos: photosBase64 } = req.body;

      if (!type) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PARAMS",
          message: "type обязателен"
        });
      }

      const hasPhotos = Array.isArray(photosBase64) && photosBase64.length > 0;
      if (!hasPhotos && !message) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PARAMS",
          message: "Укажите текст сообщения и/или приложите картинки"
        });
      }

      if (!["single", "active", "all", "all_except_active"].includes(type)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_TYPE",
          message: "type должен быть: single, active, all или all_except_active"
        });
      }

      if (type === "single" && !telegramId) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PARAMS",
          message: "telegramId обязателен для типа 'single'"
        });
      }

      let photos = [];
      if (hasPhotos) {
        for (let i = 0; i < photosBase64.length; i++) {
          const b64 = photosBase64[i];
          const data = typeof b64 === "string" ? b64.replace(/^data:image\/\w+;base64,/, "") : b64;
          try {
            photos.push(Buffer.from(data, "base64"));
          } catch (e) {
            return res.status(400).json({
              ok: false,
              error: "INVALID_PHOTO",
              message: `Неверные данные картинки #${i + 1}`
            });
          }
        }
      }

      let keyboard = null;
      if (hasWebAppButton) {
        keyboard = Markup.inlineKeyboard([
          [Markup.button.webApp("📱 Открыть приложение", "https://web.grangy.ru/")]
        ]).reply_markup;
      }

      const results = await broadcastMessage({
        type,
        message: (message || "").trim(),
        telegramId,
        parseMode: parseMode || "HTML",
        keyboard: keyboard ? { reply_markup: keyboard } : undefined,
        photos
      });

      res.json({
        ok: true,
        results: {
          total: results.total,
          sent: results.sent,
          failed: results.failed,
          errors: results.errors.slice(0, 10)
        }
      });
    } catch (error) {
      console.error("[BROADCAST] Error:", error);
      res.status(500).json({
        ok: false,
        error: "SERVER_ERROR",
        message: error.message
      });
    }
  });

  /**
   * GET /admin/broadcast/stats
   * Получить статистику пользователей
   */
  app.get("/admin/broadcast/stats", async (req, res) => {
    try {
      const { prisma } = require("./db");
      const now = new Date();

      // Все пользователи из ЛС
      const allUsers = await prisma.user.findMany({
        where: {
          chatId: { not: "" }
        }
      });

      const privateChatUsers = allUsers.filter(u => u.chatId === String(u.telegramId));

      // Активные подписки
      const activeSubscriptions = await prisma.subscription.findMany({
        where: {
          endDate: { gt: now },
          type: { not: "FREE" }
        },
        include: {
          user: {
            select: {
              id: true,
              chatId: true,
              telegramId: true
            }
          }
        }
      });

      const activeUsers = new Set();
      for (const sub of activeSubscriptions) {
        const user = sub.user;
        if (user.chatId && user.chatId === String(user.telegramId)) {
          activeUsers.add(user.id);
        }
      }

      res.json({
        ok: true,
        stats: {
          totalUsers: privateChatUsers.length,
          activeUsers: activeUsers.size,
          totalActiveSubscriptions: activeSubscriptions.length
        }
      });
    } catch (error) {
      console.error("[BROADCAST] Stats error:", error);
      res.status(500).json({
        ok: false,
        error: "SERVER_ERROR",
        message: error.message
      });
    }
  });

  console.log("📢 Broadcast API endpoints registered");
}

module.exports = { registerBroadcastAPI, ADMIN_BROADCAST_SECRET };
