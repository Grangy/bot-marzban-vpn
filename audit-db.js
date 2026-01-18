// audit-db.js - Аудит базы данных для проверки баланса и промокодов
const { PrismaClient } = require("@prisma/client");
const { PLANS } = require("./menus");

const prisma = new PrismaClient();

async function auditUser(telegramId) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`🔍 АУДИТ ПОЛЬЗОВАТЕЛЯ: ${telegramId}`);
  console.log("=".repeat(80));

  try {
    // 1. Проверяем сколько пользователей с таким telegramId
    const users = await prisma.user.findMany({
      where: { telegramId: String(telegramId) },
      orderBy: { id: "asc" }
    });

    console.log(`\n📊 НАЙДЕНО ПОЛЬЗОВАТЕЛЕЙ С telegramId ${telegramId}: ${users.length}`);

    if (users.length === 0) {
      console.log("❌ Пользователь не найден в БД!");
      return;
    }

    if (users.length > 1) {
      console.log(`⚠️  ВНИМАНИЕ: Найдено ${users.length} пользователей с одним telegramId!`);
      console.log("Это может быть причиной проблем с балансом.");
    }

    // 2. Проверяем каждого пользователя
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      console.log(`\n${"-".repeat(80)}`);
      console.log(`👤 ПОЛЬЗОВАТЕЛЬ #${i + 1} (ID: ${user.id})`);
      console.log("-".repeat(80));
      console.log(`  ID в БД: ${user.id}`);
      console.log(`  Telegram ID: ${user.telegramId}`);
      console.log(`  Chat ID: ${user.chatId}`);
      console.log(`  Username: ${user.accountName || "не указан"}`);
      console.log(`  Промокод: ${user.promoCode || "не создан"}`);
      console.log(`  Баланс в БД: ${user.balance} ₽`);
      console.log(`  Создан: ${user.createdAt}`);
      console.log(`  Обновлен: ${user.updatedAt}`);

      // 3. Проверяем пополнения
      const topups = await prisma.topUp.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" }
      });

      console.log(`\n💰 ПОПОЛНЕНИЯ (всего: ${topups.length}):`);
      if (topups.length === 0) {
        console.log("  Нет пополнений");
      } else {
        const successfulTopups = topups.filter(t => t.status === "SUCCESS" && t.credited);
        const totalTopupAmount = successfulTopups.reduce((sum, t) => sum + t.amount, 0);
        
        console.log(`  Успешных и зачисленных: ${successfulTopups.length}`);
        console.log(`  Общая сумма успешных пополнений: ${totalTopupAmount} ₽`);
        console.log(`  Детали пополнений:`);
        
        topups.forEach((topup, idx) => {
          console.log(`    ${idx + 1}. ID: ${topup.id}, Сумма: ${topup.amount} ₽, Статус: ${topup.status}, Зачислено: ${topup.credited ? "✅" : "❌"}, Дата: ${topup.createdAt}`);
          if (topup.orderId) console.log(`       Order ID: ${topup.orderId}`);
        });
      }

      // 4. Проверяем подписки
      const subscriptions = await prisma.subscription.findMany({
        where: { userId: user.id },
        orderBy: { startDate: "desc" }
      });

      console.log(`\n📦 ПОДПИСКИ (всего: ${subscriptions.length}):`);
      if (subscriptions.length === 0) {
        console.log("  Нет подписок");
      } else {
        const paidSubscriptions = subscriptions.filter(s => ["M1", "M3", "M6", "M12"].includes(s.type));
        const totalSpent = paidSubscriptions.reduce((sum, sub) => {
          const plan = PLANS[sub.type];
          return sum + (plan ? plan.price : 0);
        }, 0);

        console.log(`  Платных подписок: ${paidSubscriptions.length}`);
        console.log(`  Общая сумма потрачена на подписки: ${totalSpent} ₽`);
        console.log(`  Детали подписок:`);

        subscriptions.forEach((sub, idx) => {
          const isActive = sub.endDate && sub.endDate > new Date();
          const plan = PLANS[sub.type];
          const price = plan ? plan.price : 0;
          console.log(`    ${idx + 1}. ID: ${sub.id}, Тип: ${sub.type}, Цена: ${price} ₽, ${isActive ? "✅ Активна" : "❌ Истекла"}, Дата окончания: ${sub.endDate || "не указана"}`);
        });
      }

      // 5. Проверяем промо-активации (где пользователь владелец)
      const promoActivationsAsOwner = await prisma.promoActivation.findMany({
        where: { codeOwnerId: user.id },
        include: {
          activator: {
            select: { telegramId: true, accountName: true }
          }
        },
        orderBy: { createdAt: "desc" }
      });

      console.log(`\n🎁 ПРОМОКОД - ПОЛУЧЕННЫЕ АКТИВАЦИИ (где пользователь владелец):`);
      if (promoActivationsAsOwner.length === 0) {
        console.log("  Нет активаций промокода пользователя");
      } else {
        const totalBonus = promoActivationsAsOwner.reduce((sum, a) => sum + a.amount, 0);
        console.log(`  Всего активаций: ${promoActivationsAsOwner.length}`);
        console.log(`  Общий бонус получен: ${totalBonus} ₽`);
        promoActivationsAsOwner.forEach((activation, idx) => {
          console.log(`    ${idx + 1}. Бонус: ${activation.amount} ₽, Активатор: ${activation.activator.accountName || activation.activator.telegramId}, Дата: ${activation.createdAt}`);
        });
      }

      // 6. Проверяем промо-активацию (где пользователь активировал чужой промокод)
      const promoActivationAsUser = await prisma.promoActivation.findUnique({
        where: { activatorId: user.id },
        include: {
          codeOwner: {
            select: { telegramId: true, accountName: true, promoCode: true }
          }
        }
      });

      console.log(`\n🎫 ПРОМОКОД - АКТИВАЦИЯ (где пользователь использовал чужой промокод):`);
      if (!promoActivationAsUser) {
        console.log("  Пользователь не активировал промокоды других");
      } else {
        console.log(`  Активировал промокод: ${promoActivationAsUser.codeOwner.promoCode || "неизвестен"}`);
        console.log(`  Бонус получен: ${promoActivationAsUser.amount} ₽`);
        console.log(`  Владелец промокода: ${promoActivationAsUser.codeOwner.accountName || promoActivationAsUser.codeOwner.telegramId}`);
        console.log(`  Дата активации: ${promoActivationAsUser.createdAt}`);
      }

      // 7. Проверяем админские промокоды
      const adminPromos = await prisma.adminPromo.findMany({
        where: { usedById: user.id },
        orderBy: { usedAt: "desc" }
      });

      console.log(`\n🎁 АДМИНСКИЕ ПРОМОКОДЫ:`);
      if (adminPromos.length === 0) {
        console.log("  Пользователь не использовал админские промокоды");
      } else {
        const totalAdminBonus = adminPromos.reduce((sum, p) => sum + p.amount, 0);
        console.log(`  Всего использовано: ${adminPromos.length}`);
        console.log(`  Общий бонус: ${totalAdminBonus} ₽`);
        adminPromos.forEach((promo, idx) => {
          console.log(`    ${idx + 1}. Код: ${promo.code}, Сумма: ${promo.amount} ₽, Дата: ${promo.usedAt}`);
        });
      }

      // 8. РАСЧЕТ БАЛАНСА
      console.log(`\n${"=".repeat(80)}`);
      console.log(`🧮 РАСЧЕТ БАЛАНСА ДЛЯ ПОЛЬЗОВАТЕЛЯ #${i + 1}:`);
      console.log("=".repeat(80));

      const successfulTopups = topups.filter(t => t.status === "SUCCESS" && t.credited);
      const totalTopupAmount = successfulTopups.reduce((sum, t) => sum + t.amount, 0);
      
      const paidSubscriptions = subscriptions.filter(s => ["M1", "M3", "M6", "M12"].includes(s.type));
      const totalSpent = paidSubscriptions.reduce((sum, sub) => {
        const plan = PLANS[sub.type];
        return sum + (plan ? plan.price : 0);
      }, 0);

      const promoBonusReceived = promoActivationsAsOwner.reduce((sum, a) => sum + a.amount, 0);
      const adminPromoBonus = adminPromos.reduce((sum, p) => sum + p.amount, 0);

      const calculatedBalance = totalTopupAmount + promoBonusReceived + adminPromoBonus - totalSpent;

      console.log(`  Пополнения (успешные): +${totalTopupAmount} ₽`);
      console.log(`  Бонусы от промокодов: +${promoBonusReceived} ₽`);
      console.log(`  Бонусы от админ-промокодов: +${adminPromoBonus} ₽`);
      console.log(`  Потрачено на подписки: -${totalSpent} ₽`);
      console.log(`  ─────────────────────────────────`);
      console.log(`  РАСЧЕТНЫЙ БАЛАНС: ${calculatedBalance} ₽`);
      console.log(`  БАЛАНС В БД: ${user.balance} ₽`);
      console.log(`  ─────────────────────────────────`);
      
      const discrepancy = user.balance - calculatedBalance;
      if (discrepancy === 0) {
        console.log(`  ✅ Баланс совпадает с расчетом`);
      } else {
        console.log(`  ⚠️  РАСХОЖДЕНИЕ: ${discrepancy > 0 ? "+" : ""}${discrepancy} ₽`);
        if (discrepancy > 0) {
          console.log(`     Баланс в БД больше расчетного на ${discrepancy} ₽`);
        } else {
          console.log(`     Баланс в БД меньше расчетного на ${Math.abs(discrepancy)} ₽`);
        }
      }
    }

    // 9. ИТОГОВЫЙ АНАЛИЗ
    console.log(`\n${"=".repeat(80)}`);
    console.log(`📋 ИТОГОВЫЙ АНАЛИЗ:`);
    console.log("=".repeat(80));

    if (users.length > 1) {
      console.log(`⚠️  ПРОБЛЕМА: Найдено ${users.length} пользователей с одним telegramId!`);
      console.log(`   Это может быть причиной неправильного отображения баланса.`);
      console.log(`   Рекомендуется:`);
      console.log(`   1. Проверить логику создания пользователей`);
      console.log(`   2. Объединить данные пользователей`);
      console.log(`   3. Удалить дубликаты`);
    } else {
      const user = users[0];
      const topups = await prisma.topUp.findMany({ where: { userId: user.id } });
      const successfulTopups = topups.filter(t => t.status === "SUCCESS" && t.credited);
      const totalTopupAmount = successfulTopups.reduce((sum, t) => sum + t.amount, 0);
      
      const subscriptions = await prisma.subscription.findMany({ where: { userId: user.id } });
      const paidSubscriptions = subscriptions.filter(s => ["M1", "M3", "M6", "M12"].includes(s.type));
      const totalSpent = paidSubscriptions.reduce((sum, sub) => {
        const plan = PLANS[sub.type];
        return sum + (plan ? plan.price : 0);
      }, 0);

      const promoActivationsAsOwner = await prisma.promoActivation.findMany({ where: { codeOwnerId: user.id } });
      const promoBonusReceived = promoActivationsAsOwner.reduce((sum, a) => sum + a.amount, 0);
      const adminPromos = await prisma.adminPromo.findMany({ where: { usedById: user.id } });
      const adminPromoBonus = adminPromos.reduce((sum, p) => sum + p.amount, 0);

      const calculatedBalance = totalTopupAmount + promoBonusReceived + adminPromoBonus - totalSpent;

      if (user.balance !== calculatedBalance) {
        console.log(`⚠️  ПРОБЛЕМА: Баланс в БД (${user.balance} ₽) не совпадает с расчетным (${calculatedBalance} ₽)`);
        console.log(`   Разница: ${user.balance - calculatedBalance} ₽`);
        console.log(`   Рекомендуется исправить баланс в БД.`);
      } else {
        console.log(`✅ Баланс корректен: ${user.balance} ₽`);
      }

      // Проверка промокода
      if (telegramId === "683203214" && user.promoCode !== "47202601") {
        console.log(`⚠️  ПРОБЛЕМА: Промокод в БД (${user.promoCode || "нет"}) не совпадает с ожидаемым (47202601)`);
        console.log(`   Рекомендуется обновить промокод в БД.`);
      }
    }

  } catch (error) {
    console.error("❌ Ошибка при аудите:", error);
    throw error;
  }
}

async function main() {
  const telegramId = process.argv[2];
  
  if (!telegramId) {
    console.error("Использование: node audit-db.js <telegramId>");
    console.error("Пример: node audit-db.js 683203214");
    process.exit(1);
  }

  try {
    await auditUser(telegramId);
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

module.exports = { auditUser };
