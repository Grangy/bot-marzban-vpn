// promo-manager.js - Продвинутый модуль управления промокодами
// Поддерживает: реферальные промокоды, админские промокоды (баланс/дни), многоразовые промокоды

const { prisma } = require("./db");
const { SubscriptionType } = require("@prisma/client");
const { createMarzbanUserOnBothServers } = require("./marzban-utils");
const { ruMoney } = require("./menus");
const crypto = require("crypto");

// УЛУЧШЕНИЕ #1: Кеш для быстрого определения типа промокода (TTL 5 минут)
const promoTypeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

function getCachedPromoType(code) {
  const cached = promoTypeCache.get(code);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCachedPromoType(code, data) {
  promoTypeCache.set(code, {
    data,
    timestamp: Date.now()
  });
}

// УЛУЧШЕНИЕ #2: Логирование всех активаций промокодов
async function logPromoActivation(userId, promoType, promoId, code, success, error = null) {
  try {
    const logData = {
      userId,
      promoType,
      promoId,
      code,
      success,
      timestamp: new Date(),
      error: error ? error.message : null
    };
    console.log(`[PROMO LOG] ${success ? '✅' : '❌'} User ${userId} ${success ? 'activated' : 'failed to activate'} ${promoType} promo ${code}`, logData);
    // В будущем можно добавить сохранение в БД для аналитики
  } catch (e) {
    console.error("[PROMO LOG] Error logging activation:", e);
  }
}

// УЛУЧШЕНИЕ #3: Валидация промокода перед активацией
// Для админских промокодов валидация мягкая (любая длина от 1 символа)
// Для реферальных промокодов - строгая (4-32 символа)
function validatePromoCode(code, strict = false) {
  if (!code || typeof code !== 'string') {
    return { valid: false, reason: "INVALID_FORMAT" };
  }
  
  const upperCode = code.toUpperCase().trim();
  
  // Минимальная длина - 1 символ для админских, 4 для реферальных
  const minLength = strict ? 4 : 1;
  const maxLength = 100; // Увеличиваем максимум для админских промокодов
  
  if (upperCode.length < minLength || upperCode.length > maxLength) {
    return { valid: false, reason: "INVALID_LENGTH" };
  }
  
  // Для админских промокодов разрешаем любые символы (кроме пробелов)
  // Для реферальных - только A-Z0-9-
  if (strict && !/^[A-Z0-9-]+$/.test(upperCode)) {
    return { valid: false, reason: "INVALID_CHARACTERS" };
  }
  
  // Убираем пробелы и нормализуем
  const normalizedCode = upperCode.replace(/\s+/g, '');
  
  if (normalizedCode.length < minLength) {
    return { valid: false, reason: "INVALID_LENGTH" };
  }
  
  return { valid: true, normalizedCode };
}

// УЛУЧШЕНИЕ #4: Получение статистики по промокоду
async function getPromoStats(promoId, promoType) {
  try {
    if (promoType === PROMO_TYPES.ADMIN_BALANCE || promoType === PROMO_TYPES.ADMIN_DAYS) {
      const promo = await prisma.adminPromo.findUnique({
        where: { id: promoId },
        include: {
          activations: {
            select: { id: true, userId: true, activatedAt: true }
          }
        }
      });
      
      if (!promo) return null;
      
      return {
        code: promo.code,
        type: promo.type,
        totalActivations: promo.isReusable ? promo.activations.length : (promo.usedById ? 1 : 0),
        useCount: promo.useCount,
        isReusable: promo.isReusable,
        createdAt: promo.createdAt
      };
    } else if (promoType === PROMO_TYPES.REFERRAL) {
      const user = await prisma.user.findUnique({
        where: { id: promoId },
        include: {
          promoActivationsAsOwner: {
            select: { id: true, createdAt: true }
          }
        }
      });
      
      if (!user) return null;
      
      return {
        code: user.promoCode,
        type: "referral",
        totalActivations: user.promoActivationsAsOwner.length,
        createdAt: user.createdAt
      };
    }
    
    return null;
  } catch (error) {
    console.error("[PROMO STATS] Error getting stats:", error);
    return null;
  }
}

// УЛУЧШЕНИЕ #5: Автоматическое уведомление владельцев промокодов (для реферальных)
async function notifyPromoOwner(ownerId, activatorInfo, promoType) {
  try {
    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { chatId: true, accountName: true }
    });
    
    if (!owner || !owner.chatId) {
      return false;
    }
    
    // Пытаемся отправить уведомление (если есть bot instance)
    // Это будет вызвано из promo.js, где есть доступ к ctx.telegram
    return { owner, activatorInfo, promoType };
  } catch (error) {
    console.error("[PROMO NOTIFY] Error preparing notification:", error);
    return false;
  }
}

/**
 * Типы промокодов
 */
const PROMO_TYPES = {
  REFERRAL: "referral",    // Реферальный промокод пользователя
  ADMIN_BALANCE: "admin_balance",  // Админский промокод на баланс
  ADMIN_DAYS: "admin_days"        // Админский промокод на дни
};

/**
 * Определяет тип промокода по коду (с кешированием)
 * @param {string} code - Код промокода
 * @returns {Promise<{type: string, promo: any}>}
 */
async function detectPromoType(code) {
  // УЛУЧШЕНИЕ #1: Проверяем кеш
  const cached = getCachedPromoType(code);
  if (cached) {
    return cached;
  }
  
  // Мягкая валидация (для админских промокодов может быть любая длина)
  const validation = validatePromoCode(code, false);
  if (!validation.valid) {
    return { type: null, promo: null };
  }
  
  const upperCode = validation.normalizedCode;
  
  // Сначала проверяем админские промокоды (все, не только GIFT)
  const adminPromo = await prisma.adminPromo.findUnique({
    where: { code: upperCode }
  });
  
  if (adminPromo) {
    let result;
    if (adminPromo.type === "BALANCE") {
      result = { type: PROMO_TYPES.ADMIN_BALANCE, promo: adminPromo };
    } else if (adminPromo.type === "DAYS") {
      result = { type: PROMO_TYPES.ADMIN_DAYS, promo: adminPromo };
    } else {
      result = { type: null, promo: null };
    }
    
    // Кешируем результат
    setCachedPromoType(code, result);
    return result;
  }
  
  // Проверяем реферальный промокод
  const referralOwner = await prisma.user.findUnique({
    where: { promoCode: upperCode }
  });
  
  if (referralOwner) {
    const result = { type: PROMO_TYPES.REFERRAL, promo: referralOwner };
    // Кешируем результат
    setCachedPromoType(code, result);
    return result;
  }
  
  const result = { type: null, promo: null };
  // Кешируем даже отрицательный результат (чтобы не искать снова)
  setCachedPromoType(code, result);
  return result;
}

/**
 * Проверяет, может ли пользователь активировать промокод
 * @param {number} userId - ID пользователя
 * @param {string} promoType - Тип промокода
 * @param {any} promo - Объект промокода
 * @returns {Promise<{canActivate: boolean, reason?: string}>}
 */
async function canUserActivatePromo(userId, promoType, promo) {
  // Для реферальных промокодов: пользователь может активировать только 1 реферальный промокод
  if (promoType === PROMO_TYPES.REFERRAL) {
    const existingActivation = await prisma.promoActivation.findUnique({
      where: { activatorId: userId }
    });
    
    if (existingActivation) {
      return { canActivate: false, reason: "ALREADY_ACTIVATED_REFERRAL" };
    }
    
    // Нельзя активировать свой промокод
    if (promo.id === userId) {
      return { canActivate: false, reason: "SELF_ACTIVATION" };
    }
    
    return { canActivate: true };
  }
  
  // Для админских промокодов: проверяем, активировал ли пользователь этот конкретный промокод
  if (promoType === PROMO_TYPES.ADMIN_BALANCE || promoType === PROMO_TYPES.ADMIN_DAYS) {
    // Для многоразовых промокодов проверяем через AdminPromoActivation
    if (promo.isReusable) {
      const existingActivation = await prisma.adminPromoActivation.findUnique({
        where: {
          promoId_userId: {
            promoId: promo.id,
            userId: userId
          }
        }
      });
      
      if (existingActivation) {
        return { canActivate: false, reason: "ALREADY_ACTIVATED_THIS_PROMO" };
      }
      
      return { canActivate: true };
    } else {
      // Для одноразовых промокодов проверяем usedById
      if (promo.usedById) {
        if (promo.usedById === userId) {
          return { canActivate: false, reason: "ALREADY_ACTIVATED_THIS_PROMO" };
        } else {
          return { canActivate: false, reason: "PROMO_ALREADY_USED" };
        }
      }
      
      return { canActivate: true };
    }
  }
  
  return { canActivate: false, reason: "UNKNOWN_TYPE" };
}

/**
 * Активирует реферальный промокод
 * @param {number} userId - ID пользователя, активирующего промокод
 * @param {any} owner - Владелец промокода
 * @returns {Promise<{ok: boolean, message?: string, subscriptionId?: number}>}
 */
async function activateReferralPromo(userId, owner) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const me = await tx.user.findUnique({ where: { id: userId } });
      
      if (!me) {
        return { ok: false, reason: "USER_NOT_FOUND" };
      }
      
      // Проверяем, не активировал ли уже реферальный промокод
      const existing = await tx.promoActivation.findUnique({
        where: { activatorId: userId }
      });
      
      if (existing) {
        return { ok: false, reason: "ALREADY_ACTIVATED" };
      }
      
      // Создаем запись активации (amount больше не используется)
      await tx.promoActivation.create({
        data: {
          codeOwnerId: owner.id,
          activatorId: userId
        }
      });
      
      // Создаем подписку на 3 дня
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 3);
      
      const sub = await tx.subscription.create({
        data: {
          userId: userId,
          type: SubscriptionType.PROMO_10D,
          startDate: new Date(),
          endDate: endDate
        }
      });
      
      return { ok: true, subscriptionId: sub.id, owner };
    });
    
    if (!result.ok) {
      if (result.reason === "ALREADY_ACTIVATED") {
        return { ok: false, message: "❌ Вы уже активировали реферальный промокод ранее." };
      }
      return { ok: false, message: "❌ Ошибка активации промокода." };
    }
    
    // Создаем VPN пользователя в Marzban
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const username = `${user.telegramId}_REFERRAL_${result.subscriptionId}`;
    const expireSeconds = 3 * 24 * 60 * 60;
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
      note: `Referral promo user ${user.accountName || user.telegramId}`,
      data_limit: 0,
      data_limit_reset_strategy: "no_reset"
    };
    
    const { url1: subscriptionUrl, url2: subscriptionUrl2, remnawaveUuid } =
      await createMarzbanUserOnBothServers(userData);

    await prisma.subscription.update({
      where: { id: result.subscriptionId },
      data: {
        subscriptionUrl,
        subscriptionUrl2,
        ...(remnawaveUuid ? { remnawaveUuid } : {}),
      },
    });

    const updatedSub = await prisma.subscription.findUnique({ where: { id: result.subscriptionId } });

    let message = `✅ Реферальный промокод активирован!\n\n🎁 Вы получили VPN на 3 дня с обходом блокировок мобильной связи.\n\n📱 Ссылки на подписки в разделе «Мои подписки».`;
    
    return { 
      ok: true, 
      message, 
      subscriptionId: result.subscriptionId,
      subscriptionUrl: updatedSub.subscriptionUrl,
      subscriptionUrl2: updatedSub.subscriptionUrl2
    };
  } catch (error) {
    console.error("[PROMO MANAGER] Referral activation error:", error);
    return { ok: false, message: "❌ Ошибка при активации промокода. Попробуйте позже." };
  }
}

/**
 * Активирует админский промокод на баланс
 * @param {number} userId - ID пользователя
 * @param {any} promo - Объект промокода
 * @returns {Promise<{ok: boolean, message?: string, amount?: number}>}
 */
async function activateAdminBalancePromo(userId, promo) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Для многоразовых промокодов создаем запись активации
      if (promo.isReusable) {
        await tx.adminPromoActivation.create({
          data: {
            promoId: promo.id,
            userId: userId
          }
        });
        
        // Увеличиваем счетчик использований
        await tx.adminPromo.update({
          where: { id: promo.id },
          data: {
            useCount: { increment: 1 }
          }
        });
      } else {
        // Для одноразовых помечаем как использованный
        await tx.adminPromo.update({
          where: { id: promo.id },
          data: {
            usedById: userId,
            usedAt: new Date()
          }
        });
      }
      
      // Начисляем баланс
      await tx.user.update({
        where: { id: userId },
        data: {
          balance: { increment: promo.amount }
        }
      });
      
      return { ok: true, amount: promo.amount };
    });
    
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    return {
      ok: true,
      message: `🎉 Промокод активирован!\n\n💵 Начислено: ${ruMoney(result.amount)}\n💳 Ваш баланс: ${ruMoney(user.balance)}\n\nТеперь вы можете купить подписку в разделе "🛒 Купить подписку"`,
      amount: result.amount
    };
  } catch (error) {
    console.error("[PROMO MANAGER] Admin balance activation error:", error);
    if (error.code === "P2002") {
      return { ok: false, message: "❌ Вы уже активировали этот промокод ранее." };
    }
    return { ok: false, message: "❌ Ошибка при активации промокода. Попробуйте позже." };
  }
}

/**
 * Активирует админский промокод на дни
 * @param {number} userId - ID пользователя
 * @param {any} promo - Объект промокода
 * @returns {Promise<{ok: boolean, message?: string, subscriptionId?: number}>}
 */
async function activateAdminDaysPromo(userId, promo) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Для многоразовых промокодов создаем запись активации
      if (promo.isReusable) {
        await tx.adminPromoActivation.create({
          data: {
            promoId: promo.id,
            userId: userId
          }
        });
        
        // Увеличиваем счетчик использований
        await tx.adminPromo.update({
          where: { id: promo.id },
          data: {
            useCount: { increment: 1 }
          }
        });
      } else {
        // Для одноразовых помечаем как использованный
        await tx.adminPromo.update({
          where: { id: promo.id },
          data: {
            usedById: userId,
            usedAt: new Date()
          }
        });
      }
      
      // Создаем подписку на указанное количество дней
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + promo.days);
      
      const sub = await tx.subscription.create({
        data: {
          userId: userId,
          type: SubscriptionType.PROMO_10D,
          startDate: new Date(),
          endDate: endDate
        }
      });
      
      return { ok: true, subscriptionId: sub.id, days: promo.days };
    });
    
    // Создаем VPN пользователя в Marzban
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const username = `${user.telegramId}_ADMIN_DAYS_${result.subscriptionId}`;
    const expireSeconds = result.days * 24 * 60 * 60;
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
      note: `Admin promo (${promo.customName || promo.code}) user ${user.accountName || user.telegramId}`,
      data_limit: 0,
      data_limit_reset_strategy: "no_reset"
    };
    
    const { url1: subscriptionUrl, url2: subscriptionUrl2, remnawaveUuid } =
      await createMarzbanUserOnBothServers(userData);

    await prisma.subscription.update({
      where: { id: result.subscriptionId },
      data: {
        subscriptionUrl,
        subscriptionUrl2,
        ...(remnawaveUuid ? { remnawaveUuid } : {}),
      },
    });

    const updatedSub = await prisma.subscription.findUnique({ where: { id: result.subscriptionId } });

    const promoName = promo.customName ? `"${promo.customName}"` : "промокод";
    let message = `🎉 ${promoName} активирован!\n\n✅ Вам начислена подписка на ${result.days} ${result.days === 1 ? 'день' : result.days < 5 ? 'дня' : 'дней'}\n\n📱 Ссылки на подписки в разделе «Мои подписки».`;
    
    return { 
      ok: true, 
      message, 
      subscriptionId: result.subscriptionId,
      subscriptionUrl: updatedSub.subscriptionUrl,
      subscriptionUrl2: updatedSub.subscriptionUrl2
    };
  } catch (error) {
    console.error("[PROMO MANAGER] Admin days activation error:", error);
    if (error.code === "P2002") {
      return { ok: false, message: "❌ Вы уже активировали этот промокод ранее." };
    }
    return { ok: false, message: "❌ Ошибка при активации промокода. Попробуйте позже." };
  }
}

/**
 * Главная функция активации промокода (автоматически определяет тип)
 * @param {number} userId - ID пользователя
 * @param {string} code - Код промокода
 * @returns {Promise<{ok: boolean, message?: string, type?: string, data?: any}>}
 */
async function activatePromoCode(userId, code) {
  let promoId = null;
  let promoType = null;
  
  try {
    // Мягкая валидация (для админских промокодов может быть любая длина)
    const validation = validatePromoCode(code, false);
    if (!validation.valid) {
      await logPromoActivation(userId, "unknown", null, code, false, new Error("Invalid promo code format"));
      return { ok: false, message: "❌ Неверный формат промокода." };
    }
    
    // Определяем тип промокода (сначала пробуем найти в БД без строгой валидации)
    const { type, promo } = await detectPromoType(validation.normalizedCode);
    
    if (!type || !promo) {
      await logPromoActivation(userId, "unknown", null, code, false, new Error("Promo not found"));
      return { ok: false, message: "❌ Такой промокод не найден." };
    }
    
    promoId = promo.id;
    promoType = type;
    
    // Проверяем, может ли пользователь активировать промокод
    const { canActivate, reason } = await canUserActivatePromo(userId, type, promo);
    
    if (!canActivate) {
      await logPromoActivation(userId, type, promoId, code, false, new Error(reason));
      
      switch (reason) {
        case "ALREADY_ACTIVATED_REFERRAL":
          return { ok: false, message: "❌ Вы уже активировали реферальный промокод ранее. Можно активировать только один реферальный промокод." };
        case "ALREADY_ACTIVATED_THIS_PROMO":
          return { ok: false, message: "❌ Вы уже активировали этот промокод ранее." };
        case "PROMO_ALREADY_USED":
          return { ok: false, message: "❌ Этот промокод уже был использован другим пользователем." };
        case "SELF_ACTIVATION":
          return { ok: false, message: "❌ Нельзя активировать свой промокод." };
        default:
          return { ok: false, message: "❌ Не удалось активировать промокод." };
      }
    }
    
    // Активируем промокод в зависимости от типа
    let result;
    if (type === PROMO_TYPES.REFERRAL) {
      result = await activateReferralPromo(userId, promo);
    } else if (type === PROMO_TYPES.ADMIN_BALANCE) {
      result = await activateAdminBalancePromo(userId, promo);
    } else if (type === PROMO_TYPES.ADMIN_DAYS) {
      result = await activateAdminDaysPromo(userId, promo);
    } else {
      await logPromoActivation(userId, type, promoId, code, false, new Error("Unknown promo type"));
      return { ok: false, message: "❌ Неизвестный тип промокода." };
    }
    
    if (result.ok) {
      // УЛУЧШЕНИЕ #2: Логируем успешную активацию
      await logPromoActivation(userId, type, promoId, code, true);
      
      return {
        ok: true,
        message: result.message,
        type: type,
        data: {
          amount: result.amount,
          subscriptionId: result.subscriptionId,
          days: result.days
        }
      };
    }
    
    await logPromoActivation(userId, type, promoId, code, false, new Error(result.message || "Activation failed"));
    return result;
  } catch (error) {
    console.error("[PROMO MANAGER] Activation error:", error);
    await logPromoActivation(userId, promoType, promoId, code, false, error);
    return { ok: false, message: "❌ Ошибка при активации промокода. Попробуйте позже." };
  }
}

/**
 * Получает статистику промокода пользователя
 * @param {number} userId - ID пользователя
 * @returns {Promise<{promoCode: string, activations: number}>}
 */
async function getUserPromoStats(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      promoActivationsAsOwner: {
        select: { id: true }
      }
    }
  });
  
  if (!user) {
    return { promoCode: null, activations: 0 };
  }
  
  return {
    promoCode: user.promoCode,
    activations: user.promoActivationsAsOwner.length
  };
}

module.exports = {
  activatePromoCode,
  detectPromoType,
  canUserActivatePromo,
  activateReferralPromo,
  activateAdminBalancePromo,
  activateAdminDaysPromo,
  getUserPromoStats,
  getPromoStats,
  validatePromoCode,
  notifyPromoOwner,
  PROMO_TYPES
};
