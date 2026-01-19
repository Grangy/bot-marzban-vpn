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
    await botInstance.telegram.sendMessage(user.chatId, message, {
      parse_mode: options.parseMode || "HTML",
      ...options.keyboard
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

  // Находим активные подписки
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
          telegramId: true,
          accountName: true
        }
      }
    }
  });

  // Уникальные пользователи
  const uniqueUsers = new Map();
  for (const sub of activeSubscriptions) {
    const user = sub.user;
    if (user.chatId && user.chatId === String(user.telegramId)) { // Только ЛС
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
      await botInstance.telegram.sendMessage(user.chatId, message, {
        parse_mode: options.parseMode || "HTML",
        ...options.keyboard
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

  // Находим всех пользователей из ЛС
  const users = await prisma.user.findMany({
    where: {
      chatId: { not: "" }
    },
    select: {
      id: true,
      chatId: true,
      telegramId: true,
      accountName: true
    }
  });

  // Фильтруем только ЛС (chatId === telegramId)
  const privateChatUsers = users.filter(u => u.chatId === String(u.telegramId));

  const results = {
    total: privateChatUsers.length,
    sent: 0,
    failed: 0,
    errors: []
  };

  for (const user of privateChatUsers) {
    try {
      await botInstance.telegram.sendMessage(user.chatId, message, {
        parse_mode: options.parseMode || "HTML",
        ...options.keyboard
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
 * Основная функция рассылки
 */
async function broadcastMessage(params) {
  const { type, message, telegramId, parseMode = "HTML", keyboard } = params;

  const options = {
    parseMode,
    keyboard: keyboard ? { reply_markup: keyboard } : undefined,
    delay: 50 // 50мс между сообщениями
  };

  let results;

  switch (type) {
    case "single":
      if (!telegramId) {
        throw new Error("telegramId обязателен для одиночной рассылки");
      }
      const result = await sendToUser(telegramId, message, options);
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
