// fix-user-duplicates.js - Объединение дубликатов пользователей
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/**
 * Объединяет все пользователей с одним telegramId в одного
 */
async function mergeUsersByTelegramId(telegramId) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`🔧 ОБЪЕДИНЕНИЕ ПОЛЬЗОВАТЕЛЕЙ С telegramId: ${telegramId}`);
  console.log("=".repeat(80));

  const isDryRun = process.argv.includes("--dry-run");

  if (isDryRun) {
    console.log("🔍 РЕЖИМ ПРОСМОТРА (dry-run) - изменения не будут применены\n");
  } else {
    console.log("⚠️  РЕЖИМ ИЗМЕНЕНИЙ - изменения будут применены!\n");
  }

  try {
    // 1. Находим всех пользователей с таким telegramId
    const users = await prisma.user.findMany({
      where: { telegramId: String(telegramId) },
      include: {
        subscriptions: true,
        topUps: true,
        promoActivationsAsOwner: true,
        promoActivationAsUser: true
      },
      orderBy: { id: "asc" } // Самый старый будет основным
    });

    if (users.length === 0) {
      console.log("❌ Пользователь не найден");
      return;
    }

    if (users.length === 1) {
      console.log("✅ Найден только один пользователь, объединение не требуется");
      return;
    }

    console.log(`📊 Найдено пользователей: ${users.length}`);
    console.log(`\nИнформация о пользователях:`);
    
    users.forEach((user, idx) => {
      console.log(`\n  ${idx + 1}. ID: ${user.id}, Chat ID: ${user.chatId}, Username: ${user.accountName || "нет"}, Баланс: ${user.balance} ₽, Промокод: ${user.promoCode || "нет"}`);
      console.log(`     Подписок: ${user.subscriptions.length}, Пополнений: ${user.topUps.length}`);
      console.log(`     Создан: ${user.createdAt}, Обновлен: ${user.updatedAt}`);
    });

    // 2. Выбираем основного пользователя (первый - самый старый)
    const mainUser = users[0];
    const duplicateUsers = users.slice(1);

    console.log(`\n✅ Основной пользователь: ID ${mainUser.id}`);
    console.log(`📋 Пользователи для объединения: ${duplicateUsers.map(u => u.id).join(", ")}`);

    // 3. Собираем все данные для объединения
    let totalBalance = mainUser.balance;
    let mainPromoCode = mainUser.promoCode;
    let mainAccountName = mainUser.accountName;

    // Проверяем баланс и выбираем максимальный
    for (const user of duplicateUsers) {
      if (user.balance > totalBalance) {
        totalBalance = user.balance;
      }
      if (!mainPromoCode && user.promoCode) {
        mainPromoCode = user.promoCode;
      }
      if (!mainAccountName && user.accountName) {
        mainAccountName = user.accountName;
      }
    }

    console.log(`\n💰 Итоговый баланс после объединения: ${totalBalance} ₽`);
    if (mainPromoCode) {
      console.log(`🎁 Итоговый промокод: ${mainPromoCode}`);
    }

    // 4. Подсчитываем, что будет перемещено
    let totalSubscriptions = mainUser.subscriptions.length;
    let totalTopups = mainUser.topUps.length;

    for (const user of duplicateUsers) {
      totalSubscriptions += user.subscriptions.length;
      totalTopups += user.topUps.length;
    }

    console.log(`\n📊 Данные для объединения:`);
    console.log(`   Подписок: ${totalSubscriptions}`);
    console.log(`   Пополнений: ${totalTopups}`);

    if (isDryRun) {
      console.log(`\n🔍 DRY-RUN: Ничего не изменено. Для применения запустите без --dry-run`);
      return;
    }

    // 5. Объединяем данные
    console.log(`\n🔄 Начинаем объединение...`);

    await prisma.$transaction(async (tx) => {
      // Обновляем основного пользователя
      await tx.user.update({
        where: { id: mainUser.id },
        data: {
          balance: totalBalance,
          promoCode: mainPromoCode || undefined,
          accountName: mainAccountName || undefined
        }
      });

      // Переносим подписки
      for (const user of duplicateUsers) {
        for (const subscription of user.subscriptions) {
          try {
            await tx.subscription.update({
              where: { id: subscription.id },
              data: { userId: mainUser.id }
            });
            console.log(`  ✅ Подписка ${subscription.id} перенесена`);
          } catch (e) {
            console.log(`  ⚠️  Подписка ${subscription.id} не перенесена: ${e.message}`);
          }
        }
      }

      // Переносим пополнения
      for (const user of duplicateUsers) {
        for (const topup of user.topUps) {
          try {
            await tx.topUp.update({
              where: { id: topup.id },
              data: { userId: mainUser.id }
            });
            console.log(`  ✅ Пополнение ${topup.id} перенесено`);
          } catch (e) {
            console.log(`  ⚠️  Пополнение ${topup.id} не перенесено: ${e.message}`);
          }
        }
      }

      // Переносим промо-активации (где пользователь владелец)
      for (const user of duplicateUsers) {
        const activations = await tx.promoActivation.findMany({
          where: { codeOwnerId: user.id }
        });
        for (const activation of activations) {
          try {
            await tx.promoActivation.update({
              where: { id: activation.id },
              data: { codeOwnerId: mainUser.id }
            });
            console.log(`  ✅ Промо-активация ${activation.id} перенесена`);
          } catch (e) {
            console.log(`  ⚠️  Промо-активация ${activation.id} не перенесена: ${e.message}`);
          }
        }
      }

      // Переносим промо-активации (где пользователь активатор)
      for (const user of duplicateUsers) {
        const activation = await tx.promoActivation.findUnique({
          where: { activatorId: user.id }
        });
        if (activation) {
          // Проверяем, нет ли уже активации у основного пользователя
          const mainActivation = await tx.promoActivation.findUnique({
            where: { activatorId: mainUser.id }
          });
          if (!mainActivation) {
            try {
              await tx.promoActivation.update({
                where: { id: activation.id },
                data: { activatorId: mainUser.id }
              });
              console.log(`  ✅ Промо-активация активатора ${activation.id} перенесена`);
            } catch (e) {
              console.log(`  ⚠️  Промо-активация активатора ${activation.id} не перенесена: ${e.message}`);
            }
          } else {
            // Удаляем дубликат активации
            await tx.promoActivation.delete({
              where: { id: activation.id }
            });
            console.log(`  🗑️  Дубликат промо-активации ${activation.id} удален`);
          }
        }
      }

      // Обновляем админские промокоды
      for (const user of duplicateUsers) {
        const adminPromos = await tx.adminPromo.findMany({
          where: { usedById: user.id }
        });
        for (const promo of adminPromos) {
          try {
            await tx.adminPromo.update({
              where: { id: promo.id },
              data: { usedById: mainUser.id }
            });
            console.log(`  ✅ Админский промокод ${promo.id} перенесен`);
          } catch (e) {
            console.log(`  ⚠️  Админский промокод ${promo.id} не перенесен: ${e.message}`);
          }
        }
      }

      // Удаляем дубликаты пользователей
      for (const user of duplicateUsers) {
        await tx.user.delete({
          where: { id: user.id }
        });
        console.log(`  🗑️  Пользователь ${user.id} удален`);
      }
    });

    console.log(`\n✅ Объединение завершено!`);
    console.log(`   Основной пользователь: ID ${mainUser.id}, Баланс: ${totalBalance} ₽`);

    // 6. Проверяем результат
    const finalUser = await prisma.user.findFirst({
      where: { telegramId: String(telegramId) },
      include: {
        subscriptions: true,
        topUps: true
      }
    });

    if (finalUser) {
      console.log(`\n✅ Финальная проверка:`);
      console.log(`   ID: ${finalUser.id}`);
      console.log(`   Баланс: ${finalUser.balance} ₽`);
      console.log(`   Промокод: ${finalUser.promoCode || "нет"}`);
      console.log(`   Подписок: ${finalUser.subscriptions.length}`);
      console.log(`   Пополнений: ${finalUser.topUps.length}`);
    }

  } catch (error) {
    console.error("\n❌ Ошибка при объединении:", error);
    throw error;
  }
}

async function main() {
  const telegramId = process.argv.find(arg => !arg.startsWith("--") && arg !== "fix-user-duplicates.js");
  
  if (!telegramId) {
    console.error("Использование: node fix-user-duplicates.js <telegramId> [--dry-run]");
    console.error("Пример: node fix-user-duplicates.js 683203214 --dry-run");
    process.exit(1);
  }

  try {
    await mergeUsersByTelegramId(telegramId);
  } catch (error) {
    console.error("❌ Критическая ошибка:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main();
}

module.exports = { mergeUsersByTelegramId };
