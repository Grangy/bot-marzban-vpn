// broadcast.js - Модуль для массовой рассылки сообщений
const { prisma } = require("./db");

let botInstance = null;

/**
 * Инициализация модуля рассылки
 */
function initBroadcast(bot) {
  botInstance = bot;
}

/**
 * Отправка фото/медиа-группы или текста пользователю
 */
async function sendContent(chatId, message, options = {}) {
  const { photos = [], parseMode = "HTML", keyboard } = options;
  const extra = {
    parse_mode: parseMode,
    caption: (message || "").trim() || undefined,
    ...(keyboard || {})
  };

  if (photos.length === 1) {
    await botInstance.telegram.sendPhoto(chatId, { source: photos[0] }, extra);
  } else if (photos.length > 1) {
    const media = photos.map((buf, i) => ({
      type: "photo",
      media: { source: buf },
      caption: i === 0 ? ((message || "").trim() || undefined) : undefined,
      parse_mode: i === 0 ? parseMode : undefined
    }));
    await botInstance.telegram.sendMediaGroup(chatId, media);
    if (keyboard?.reply_markup) {
      await botInstance.telegram.sendMessage(chatId, "📱", { reply_markup: keyboard.reply_markup });
    }
  } else {
    await botInstance.telegram.sendMessage(chatId, message, extra);
  }
}

/**
 * Отправка сообщения конкретному пользователю
 */
async function sendToUser(telegramId, message, options = {}) {
  if (!botInstance) {
    throw new Error("Bot instance not initialized");
  }

  const user = await prisma.user.findFirst({
    where: {
      telegramId: String(telegramId),
      chatId: String(telegramId) // Только из ЛС
    }
  });

  if (!user) {
    return {
      success: false,
      error: "USER_NOT_FOUND",
      message: `Пользователь ${telegramId} не найден`
    };
  }

  try {
    await sendContent(user.chatId, message, {
      photos: options.photos,
      parseMode: options.parseMode || "HTML",
      keyboard: options.keyboard
    });

    return {
      success: true,
      telegramId: user.telegramId,
      chatId: user.chatId
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.errorCode || "UNKNOWN",
      message: error.message,
      telegramId: user.telegramId
    };
  }
}

/**
 * Рассылка активным пользователям (с активной подпиской)
 */
async function broadcastToActiveUsers(message, options = {}) {
  if (!botInstance) {
    throw new Error("Bot instance not initialized");
  }

  const now = new Date();

  // IMPORTANT: do not include required `user` relation — prod DB can contain orphaned userId rows.
  const activeSubscriptions = await prisma.subscription.findMany({
    where: {
      endDate: { gt: now },
      type: { not: "FREE" }
    },
    select: { id: true, userId: true }
  });

  const userIds = [...new Set(activeSubscriptions.map((s) => s.userId))];
  const userRows =
    userIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, chatId: true, telegramId: true, accountName: true },
        });
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const uniqueUsers = new Map();
  for (const sub of activeSubscriptions) {
    const user = userById.get(sub.userId);
    if (user.chatId && user.chatId === String(user.telegramId)) {
      uniqueUsers.set(user.id, user);
    }
  }

  const users = Array.from(uniqueUsers.values());
  const results = {
    total: users.length,
    sent: 0,
    failed: 0,
    errors: []
  };

  for (const user of users) {
    try {
      await sendContent(user.chatId, message, {
        photos: options.photos,
        parseMode: options.parseMode || "HTML",
        keyboard: options.keyboard
      });

      results.sent++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        telegramId: user.telegramId,
        error: error.response?.errorCode || "UNKNOWN",
        message: error.message
      });
    }

    // Задержка между сообщениями
    if (options.delay) {
      await new Promise(resolve => setTimeout(resolve, options.delay));
    } else {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  return results;
}

/**
 * Рассылка всем пользователям из ЛС
 */
async function broadcastToAllUsers(message, options = {}) {
  if (!botInstance) {
    throw new Error("Bot instance not initialized");
  }

  const privateChatUsers = await getPrivateChatUsers();

  const results = {
    total: privateChatUsers.length,
    sent: 0,
    failed: 0,
    errors: []
  };

  for (const user of privateChatUsers) {
    try {
      await sendContent(user.chatId, message, {
        photos: options.photos,
        parseMode: options.parseMode || "HTML",
        keyboard: options.keyboard
      });

      results.sent++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        telegramId: user.telegramId,
        error: error.response?.errorCode || "UNKNOWN",
        message: error.message
      });
    }

    // Задержка между сообщениями
    if (options.delay) {
      await new Promise(resolve => setTimeout(resolve, options.delay));
    } else {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  return results;
}

/**
 * Все пользователи из ЛС (chatId === telegramId)
 */
async function getPrivateChatUsers() {
  const users = await prisma.user.findMany({
    where: { chatId: { not: "" } },
    select: { id: true, chatId: true, telegramId: true, accountName: true }
  });
  return users.filter(u => u.chatId === String(u.telegramId));
}

/**
 * Рассылка всем, кроме активных (ЛС без активной подписки)
 */
async function broadcastToAllExceptActive(message, options = {}) {
  if (!botInstance) {
    throw new Error("Bot instance not initialized");
  }

  const now = new Date();
  const allPrivate = await getPrivateChatUsers();

  const activeSubs = await prisma.subscription.findMany({
    where: {
      endDate: { gt: now },
      type: { not: "FREE" }
    },
    include: { user: { select: { id: true } } }
  });
  const activeUserIds = new Set(activeSubs.map(s => s.user.id));
  const users = allPrivate.filter(u => !activeUserIds.has(u.id));

  const results = { total: users.length, sent: 0, failed: 0, errors: [] };

  for (const user of users) {
    try {
      await sendContent(user.chatId, message, {
        photos: options.photos,
        parseMode: options.parseMode || "HTML",
        keyboard: options.keyboard
      });
      results.sent++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        telegramId: user.telegramId,
        error: error.response?.errorCode || "UNKNOWN",
        message: error.message
      });
    }
    await new Promise(r => setTimeout(r, options.delay || 50));
  }

  return results;
}

/**
 * Основная функция рассылки
 */
async function broadcastMessage(params) {
  const { type, message, telegramId, parseMode = "HTML", keyboard, photos } = params;

  const options = {
    parseMode,
    keyboard: keyboard || undefined,
    photos: photos || [],
    delay: 50
  };

  let results;

  switch (type) {
    case "single":
      if (!telegramId) {
        throw new Error("telegramId обязателен для одиночной рассылки");
      }
      const result = await sendToUser(telegramId, message || "", options);
      results = {
        total: 1,
        sent: result.success ? 1 : 0,
        failed: result.success ? 0 : 1,
        errors: result.success ? [] : [result]
      };
      break;

    case "active":
      results = await broadcastToActiveUsers(message, options);
      break;

    case "all":
      results = await broadcastToAllUsers(message, options);
      break;

    case "all_except_active":
      results = await broadcastToAllExceptActive(message, options);
      break;

    default:
      throw new Error(`Неизвестный тип рассылки: ${type}`);
  }

  return results;
}

module.exports = {
  initBroadcast,
  broadcastMessage,
  sendToUser,
  broadcastToActiveUsers,
  broadcastToAllUsers
};
