// migrate-subscription-urls.js
// Скрипт для замены старых ссылок vpn.maxvpn.live на vpn.grangy.ru
require("dotenv").config();
const { prisma } = require("./db");

async function migrateSubscriptionUrls() {
  try {
    console.log("🔍 Поиск подписок со старыми ссылками...");

    // Находим все подписки с subscriptionUrl, содержащим старый домен или новый без https://
    const subscriptions = await prisma.subscription.findMany({
      where: {
        OR: [
          {
            subscriptionUrl: {
              contains: "vpn.maxvpn.live",
            },
          },
          {
            subscriptionUrl: {
              startsWith: "vpn.grangy.ru/",
            },
          },
        ],
      },
      select: {
        id: true,
        subscriptionUrl: true,
      },
    });

    console.log(`📊 Найдено подписок для обновления: ${subscriptions.length}`);

    if (subscriptions.length === 0) {
      console.log("✅ Нет подписок для обновления");
      return;
    }

    let updated = 0;
    let errors = 0;

    for (const sub of subscriptions) {
      try {
        const oldUrl = sub.subscriptionUrl;
        let newUrl = oldUrl;
        
        // Заменяем https://vpn.maxvpn.live/sub/ на https://vpn.grangy.ru/
        if (oldUrl.includes("vpn.maxvpn.live")) {
          newUrl = oldUrl.replace(
            /https?:\/\/vpn\.maxvpn\.live\/sub\//,
            "https://vpn.grangy.ru/"
          );
        }
        // Исправляем ссылки vpn.grangy.ru/... на https://vpn.grangy.ru/...
        else if (oldUrl.startsWith("vpn.grangy.ru/")) {
          newUrl = "https://" + oldUrl;
        }

        if (oldUrl === newUrl) {
          console.log(`⚠️  Подписка ${sub.id}: ссылка не изменилась, пропускаем`);
          continue;
        }

        await prisma.subscription.update({
          where: { id: sub.id },
          data: { subscriptionUrl: newUrl },
        });

        console.log(`✅ Подписка ${sub.id}:`);
        console.log(`   Было: ${oldUrl}`);
        console.log(`   Стало: ${newUrl}`);
        updated++;
      } catch (error) {
        console.error(`❌ Ошибка при обновлении подписки ${sub.id}:`, error.message);
        errors++;
      }
    }

    console.log("\n📈 Итоги миграции:");
    console.log(`   Обновлено: ${updated}`);
    console.log(`   Ошибок: ${errors}`);
    console.log(`   Всего найдено: ${subscriptions.length}`);

    if (errors === 0) {
      console.log("\n✅ Миграция завершена успешно!");
    } else {
      console.log(`\n⚠️  Миграция завершена с ${errors} ошибками`);
    }
  } catch (error) {
    console.error("❌ Критическая ошибка при миграции:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Запускаем миграцию
if (require.main === module) {
  migrateSubscriptionUrls()
    .then(() => {
      console.log("👋 Скрипт завершен");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Фатальная ошибка:", error);
      process.exit(1);
    });
}

module.exports = { migrateSubscriptionUrls };

