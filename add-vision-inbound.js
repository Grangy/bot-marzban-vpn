// add-vision-inbound.js
// Скрипт для добавления inbound "VLESS-TCP-REALITY-VISION" всем существующим пользователям в Marzban
require("dotenv").config();
const { prisma } = require("./db");
const { SubscriptionType } = require("@prisma/client");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const MARZBAN_API_URL = process.env.MARZBAN_API_URL;
const MARZBAN_TOKEN = process.env.MARZBAN_TOKEN;

// Функция для формирования username из подписки
function getUsername(user, subscription) {
  if (subscription.type === SubscriptionType.PROMO_10D) {
    return `${user.telegramId}_PROMO_${subscription.id}`;
  }
  return `${user.telegramId}_${subscription.type}_${subscription.id}`;
}

// Функция для обновления inbounds пользователя в Marzban
async function updateUserInbounds(username) {
  if (!MARZBAN_API_URL || MARZBAN_API_URL === "your_marzban_api_url") {
    console.log(`⚠️  MARZBAN_API_URL не настроен, пропускаем пользователя ${username}`);
    return { success: false, reason: "API_NOT_CONFIGURED" };
  }

  const headers = {
    "Content-Type": "application/json",
  };
  
  if (MARZBAN_TOKEN) {
    headers["Authorization"] = `Bearer ${MARZBAN_TOKEN}`;
  }

  try {
    // Сначала получаем текущие данные пользователя
    const getResponse = await fetch(`${MARZBAN_API_URL}/users/${username}`, {
      method: "GET",
      headers,
    });

    if (!getResponse.ok) {
      if (getResponse.status === 404) {
        return { success: false, reason: "USER_NOT_FOUND" };
      }
      const errorText = await getResponse.text();
      console.error(`❌ Ошибка при получении пользователя ${username}:`, errorText);
      return { success: false, reason: "GET_ERROR", error: errorText };
    }

    const userData = await getResponse.json();

    // Обновляем inbounds - добавляем оба inbounds для vless
    const updatedUserData = {
      ...userData,
      inbounds: {
        ...userData.inbounds,
        vless: ["VLESS TCP REALITY", "VLESS-TCP-REALITY-VISION"]
      }
    };

    // Отправляем обновление
    const putResponse = await fetch(`${MARZBAN_API_URL}/users/${username}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(updatedUserData),
    });

    if (!putResponse.ok) {
      const errorText = await putResponse.text();
      console.error(`❌ Ошибка при обновлении пользователя ${username}:`, errorText);
      return { success: false, reason: "UPDATE_ERROR", error: errorText };
    }

    return { success: true };
  } catch (error) {
    console.error(`❌ Исключение при обновлении пользователя ${username}:`, error.message);
    return { success: false, reason: "EXCEPTION", error: error.message };
  }
}

async function addVisionInbound() {
  try {
    console.log("🔍 Поиск подписок с subscriptionUrl...");

    // Находим все подписки с subscriptionUrl (не NULL)
    const subscriptions = await prisma.subscription.findMany({
      where: {
        subscriptionUrl: {
          not: null,
        },
      },
      include: {
        user: true,
      },
      orderBy: {
        id: "asc",
      },
    });

    console.log(`📊 Найдено подписок для обновления: ${subscriptions.length}`);

    if (subscriptions.length === 0) {
      console.log("✅ Нет подписок для обновления");
      return;
    }

    if (!MARZBAN_API_URL || MARZBAN_API_URL === "your_marzban_api_url") {
      console.log("⚠️  MARZBAN_API_URL не настроен. Проверка будет пропущена.");
      console.log("📝 Будут показаны только username'ы, которые нужно обновить:");
      subscriptions.forEach((sub) => {
        const username = getUsername(sub.user, sub);
        console.log(`   - ${username} (подписка ${sub.id}, тип ${sub.type})`);
      });
      return;
    }

    let updated = 0;
    let errors = 0;
    let notFound = 0;
    let skipped = 0;

    for (const sub of subscriptions) {
      try {
        const username = getUsername(sub.user, sub);
        console.log(`\n🔄 Обработка подписки ${sub.id}: ${username}`);

        const result = await updateUserInbounds(username);

        if (result.success) {
          console.log(`✅ Пользователь ${username} обновлен успешно`);
          updated++;
        } else if (result.reason === "USER_NOT_FOUND") {
          console.log(`⚠️  Пользователь ${username} не найден в Marzban`);
          notFound++;
        } else if (result.reason === "API_NOT_CONFIGURED") {
          console.log(`⚠️  API не настроен, пропуск`);
          skipped++;
        } else {
          console.log(`❌ Ошибка при обновлении ${username}: ${result.reason}`);
          errors++;
        }

        // Небольшая задержка чтобы не перегружать API
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`❌ Исключение при обработке подписки ${sub.id}:`, error.message);
        errors++;
      }
    }

    console.log("\n📈 Итоги миграции:");
    console.log(`   ✅ Обновлено: ${updated}`);
    console.log(`   ⚠️  Не найдено в Marzban: ${notFound}`);
    console.log(`   ⚠️  Пропущено: ${skipped}`);
    console.log(`   ❌ Ошибок: ${errors}`);
    console.log(`   📊 Всего обработано: ${subscriptions.length}`);

    if (errors === 0 && notFound === 0) {
      console.log("\n✅ Миграция завершена успешно!");
    } else if (errors === 0) {
      console.log("\n✅ Миграция завершена (некоторые пользователи не найдены в Marzban, это нормально)");
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

// Функция для проверки (dry-run режим)
async function checkVisionInbound() {
  try {
    console.log("🔍 Проверка: поиск подписок для обновления...");

    const subscriptions = await prisma.subscription.findMany({
      where: {
        subscriptionUrl: {
          not: null,
        },
      },
      include: {
        user: true,
      },
      orderBy: {
        id: "asc",
      },
    });

    console.log(`📊 Найдено подписок: ${subscriptions.length}\n`);

    if (subscriptions.length === 0) {
      console.log("✅ Нет подписок для обновления");
      return;
    }

    if (!MARZBAN_API_URL || MARZBAN_API_URL === "your_marzban_api_url") {
      console.log("⚠️  MARZBAN_API_URL не настроен. Режим проверки недоступен.");
      console.log("📝 Найденные подписки:");
      subscriptions.forEach((sub) => {
        const username = getUsername(sub.user, sub);
        console.log(`   - ${username} (подписка ${sub.id}, тип ${sub.type})`);
      });
      return;
    }

    const headers = {
      "Content-Type": "application/json",
    };
    
    if (MARZBAN_TOKEN) {
      headers["Authorization"] = `Bearer ${MARZBAN_TOKEN}`;
    }

    let found = 0;
    let notFound = 0;
    let errors = 0;

    for (const sub of subscriptions) {
      try {
        const username = getUsername(sub.user, sub);
        const getResponse = await fetch(`${MARZBAN_API_URL}/users/${username}`, {
          method: "GET",
          headers,
        });

        if (getResponse.ok) {
          const userData = await getResponse.json();
          const currentInbounds = userData.inbounds?.vless || [];
          const hasVision = currentInbounds.includes("VLESS-TCP-REALITY-VISION");
          
          if (hasVision) {
            console.log(`✅ ${username}: уже имеет VLESS-TCP-REALITY-VISION`);
          } else {
            console.log(`⚠️  ${username}: НУЖНО ОБНОВИТЬ (текущие inbounds: ${JSON.stringify(currentInbounds)})`);
          }
          found++;
        } else if (getResponse.status === 404) {
          console.log(`⚠️  ${username}: не найден в Marzban`);
          notFound++;
        } else {
          const errorText = await getResponse.text();
          console.log(`❌ ${username}: ошибка проверки - ${errorText}`);
          errors++;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`❌ Ошибка при проверке подписки ${sub.id}:`, error.message);
        errors++;
      }
    }

    console.log("\n📈 Итоги проверки:");
    console.log(`   ✅ Найдено в Marzban: ${found}`);
    console.log(`   ⚠️  Не найдено: ${notFound}`);
    console.log(`   ❌ Ошибок: ${errors}`);
  } catch (error) {
    console.error("❌ Критическая ошибка при проверке:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Запуск скрипта
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || "update";

  if (command === "check") {
    checkVisionInbound()
      .then(() => {
        console.log("\n👋 Проверка завершена");
        process.exit(0);
      })
      .catch((error) => {
        console.error("💥 Фатальная ошибка:", error);
        process.exit(1);
      });
  } else if (command === "update") {
    addVisionInbound()
      .then(() => {
        console.log("\n👋 Скрипт завершен");
        process.exit(0);
      })
      .catch((error) => {
        console.error("💥 Фатальная ошибка:", error);
        process.exit(1);
      });
  } else {
    console.log("Использование:");
    console.log("  node add-vision-inbound.js check   - проверить статус (dry-run)");
    console.log("  node add-vision-inbound.js update  - выполнить обновление");
    process.exit(1);
  }
}

module.exports = { addVisionInbound, checkVisionInbound };
