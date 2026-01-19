// referral-bonus.js - Система реферальных бонусов (20% от пополнений)
const { prisma } = require("./db");
const { ruMoney } = require("./menus");
const bus = require("./events");

/**
 * Обрабатывает реферальный бонус при успешном пополнении
 * @param {number} topupId - ID пополнения
 * @returns {Promise<{ok: boolean, bonus?: any}>}
 */
async function processReferralBonus(topupId) {
  try {
    // Получаем информацию о пополнении
    const topup = await prisma.topUp.findUnique({
      where: { id: topupId },
      include: {
        user: {
          select: { id: true, accountName: true, telegramId: true }
        }
      }
    });

    if (!topup || topup.status !== "SUCCESS" || !topup.credited) {
      return { ok: false, reason: "TOPUP_NOT_ELIGIBLE" };
    }

    // Проверяем, активировал ли пользователь реферальный промокод
    const activation = await prisma.promoActivation.findUnique({
      where: { activatorId: topup.userId },
      include: {
        codeOwner: {
          select: {
            id: true,
            chatId: true,
            accountName: true,
            telegramId: true,
            promoCode: true
          }
        }
      }
    });

    if (!activation) {
      // Пользователь не активировал реферальный промокод
      return { ok: false, reason: "NO_REFERRAL_ACTIVATION" };
    }

    // Проверяем, не был ли бонус уже начислен за это пополнение
    const existingBonus = await prisma.referralBonus.findFirst({
      where: {
        topupId: topupId,
        codeOwnerId: activation.codeOwnerId,
        activatorId: topup.userId
      }
    });

    if (existingBonus) {
      // Бонус уже начислен
      return { ok: false, reason: "BONUS_ALREADY_PROCESSED" };
    }

    // Рассчитываем бонус (20% от суммы пополнения)
    const bonusAmount = Math.floor(topup.amount * 0.2);

    if (bonusAmount === 0) {
      return { ok: false, reason: "BONUS_TOO_SMALL" };
    }

    // Создаем запись о бонусе в БД
    const bonus = await prisma.referralBonus.create({
      data: {
        codeOwnerId: activation.codeOwnerId,
        activatorId: topup.userId,
        topupId: topupId,
        amount: topup.amount,
        bonusAmount: bonusAmount,
        credited: false // Пока не зачислен
      }
    });

    // Начисляем бонус на баланс владельцу промокода
    await prisma.$transaction(async (tx) => {
      // Зачисляем бонус
      await tx.user.update({
        where: { id: activation.codeOwnerId },
        data: {
          balance: { increment: bonusAmount }
        }
      });

      // Помечаем бонус как зачисленный
      await tx.referralBonus.update({
        where: { id: bonus.id },
        data: {
          credited: true,
          creditedAt: new Date()
        }
      });
    });

    // Отправляем уведомление владельцу промокода
    const owner = await prisma.user.findUnique({
      where: { id: activation.codeOwnerId }
    });

    if (owner && owner.chatId) {
      try {
        const activatorName = topup.user.accountName || topup.user.telegramId;
        const message = `💰 Реферальный бонус!\n\n` +
          `Пользователь ${activatorName} пополнил баланс на ${ruMoney(topup.amount)}.\n\n` +
          `💵 Вам начислено 20%: ${ruMoney(bonusAmount)}\n` +
          `💳 Ваш баланс: ${ruMoney(owner.balance + bonusAmount)}\n\n` +
          `💎 Бонусы можно использовать для покупки подписки или вывести в будущем.`;

        // Отправим уведомление через событие (bot будет передан извне)
        bus.emit("referral.bonus.credited", {
          ownerId: owner.id,
          activatorId: topup.userId,
          topupId: topupId,
          amount: topup.amount,
          bonusAmount: bonusAmount,
          message: message
        });
      } catch (e) {
        console.error("[REFERRAL BONUS] Error preparing notification:", e);
      }
    }

    console.log(`[REFERRAL BONUS] Bonus credited: owner=${activation.codeOwnerId}, activator=${topup.userId}, amount=${topup.amount}, bonus=${bonusAmount}`);

    return {
      ok: true,
      bonus: {
        id: bonus.id,
        codeOwnerId: activation.codeOwnerId,
        activatorId: topup.userId,
        amount: topup.amount,
        bonusAmount: bonusAmount
      }
    };
  } catch (error) {
    console.error("[REFERRAL BONUS] Error processing bonus:", error);
    return { ok: false, error: error.message };
  }
}

/**
 * Получает статистику реферальных бонусов для пользователя
 * @param {number} userId - ID пользователя (владельца промокода)
 * @returns {Promise<{totalBonusAmount: number, totalTopupsAmount: number, bonuses: any[]}>}
 */
async function getReferralStats(userId) {
  try {
    const bonuses = await prisma.referralBonus.findMany({
      where: { codeOwnerId: userId },
      include: {
        activator: {
          select: {
            id: true,
            telegramId: true,
            accountName: true
          }
        },
        topup: {
          select: {
            id: true,
            amount: true,
            createdAt: true
          }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    const totalBonusAmount = bonuses.reduce((sum, b) => sum + b.bonusAmount, 0);
    const totalTopupsAmount = bonuses.reduce((sum, b) => sum + b.amount, 0);

    return {
      totalBonusAmount,
      totalTopupsAmount,
      bonuses: bonuses.map(b => ({
        id: b.id,
        activator: b.activator,
        topupAmount: b.amount,
        bonusAmount: b.bonusAmount,
        credited: b.credited,
        createdAt: b.createdAt
      }))
    };
  } catch (error) {
    console.error("[REFERRAL BONUS] Error getting stats:", error);
    return { totalBonusAmount: 0, totalTopupsAmount: 0, bonuses: [] };
  }
}

/**
 * Инициализация системы реферальных бонусов
 * Подключается к событиям пополнений
 * @param {object} bot - Экземпляр бота Telegraf
 */
function initReferralBonus(bot) {
  // Обработчик успешного пополнения
  bus.on("topup.success", async ({ topupId }) => {
    // Небольшая задержка, чтобы баланс успел обновиться
    setTimeout(async () => {
      try {
        const result = await processReferralBonus(topupId);
        if (result.ok && result.bonus) {
          // Уведомление владельцу будет отправлено внутри processReferralBonus
        }
      } catch (error) {
        console.error("[REFERRAL BONUS] Error in topup.success handler:", error);
      }
    }, 1000); // 1 секунда задержки
  });

  // Обработчик уведомления о зачисленном бонусе
  bus.on("referral.bonus.credited", async ({ ownerId, message }) => {
    try {
      const owner = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { chatId: true }
      });

      if (owner && owner.chatId && bot) {
        await bot.telegram.sendMessage(owner.chatId, message);
        console.log(`[REFERRAL BONUS] Notification sent to owner ${ownerId}`);
      }
    } catch (error) {
      console.error("[REFERRAL BONUS] Error sending notification:", error);
    }
  });

  console.log("💰 Referral bonus system initialized");
}

module.exports = {
  initReferralBonus,
  processReferralBonus,
  getReferralStats
};
