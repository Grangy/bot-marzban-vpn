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

// Функция для извлечения telegramId из note или username пользователя Marzban
function extractTelegramId(marzbanUser) {
  // Пробуем извлечь из note: "Telegram user @username" или "Telegram user 123456789"
  if (marzbanUser.note) {
    const noteMatch = marzbanUser.note.match(/Telegram user\s+(@?\w+|\d+)/);
    if (noteMatch) {
      const idOrUsername = noteMatch[1];
      // Если это не начинается с @, то это может быть telegramId
      if (!idOrUsername.startsWith('@') && /^\d+$/.test(idOrUsername)) {
        return idOrUsername;
      }
    }
  }
  
  // Пробуем извлечь из username: "123456789_TYPE_ID" или "123456789_PROMO_ID"
  if (marzbanUser.username) {
    const usernameMatch = marzbanUser.username.match(/^(\d+)_/);
    if (usernameMatch) {
      return usernameMatch[1];
    }
  }
  
  return null;
}

// Функция для получения всех пользователей из Marzban
async function getAllMarzbanUsers() {
  const headers = {
    "Content-Type": "application/json",
  };
  
  if (MARZBAN_TOKEN) {
    headers["Authorization"] = `Bearer ${MARZBAN_TOKEN}`;
  }

  try {
    // Получаем всех пользователей (большой лимит)
    const response = await fetch(`${MARZBAN_API_URL}/users?limit=10000`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ошибка при получении пользователей: ${errorText}`);
    }

    const data = await response.json();
    return data.users || data || [];
  } catch (error) {
    console.error("❌ Ошибка при получении пользователей из Marzban:", error.message);
    throw error;
  }
}

// Функция для обновления inbounds пользователя в Marzban
async function updateUserInboundsByUsername(username, userData) {
  if (!MARZBAN_API_URL || MARZBAN_API_URL === "your_marzban_api_url") {
    return { success: false, reason: "API_NOT_CONFIGURED" };
  }

  const headers = {
    "Content-Type": "application/json",
  };
  
  if (MARZBAN_TOKEN) {
    headers["Authorization"] = `Bearer ${MARZBAN_TOKEN}`;
  }

  try {
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
      return { success: false, reason: "UPDATE_ERROR", error: errorText };
    }

    return { success: true };
  } catch (error) {
    return { success: false, reason: "EXCEPTION", error: error.message };
  }
}

async function addVisionInbound() {
  try {
    console.log("🔍 Получение всех пользователей из Marzban...");

    if (!MARZBAN_API_URL || MARZBAN_API_URL === "your_marzban_api_url") {
      console.log("⚠️  MARZBAN_API_URL не настроен.");
      return;
    }

    // Получаем всех пользователей из Marzban
    const marzbanUsers = await getAllMarzbanUsers();
    console.log(`📊 Получено пользователей из Marzban: ${marzbanUsers.length}`);

    // Создаем карту: telegramId -> список пользователей Marzban
    const telegramIdToMarzbanUsers = new Map();
    for (const marzbanUser of marzbanUsers) {
      const telegramId = extractTelegramId(marzbanUser);
      if (telegramId) {
        if (!telegramIdToMarzbanUsers.has(telegramId)) {
          telegramIdToMarzbanUsers.set(telegramId, []);
        }
        telegramIdToMarzbanUsers.get(telegramId).push(marzbanUser);
      }
    }

    console.log(`📊 Найдено уникальных telegramId в Marzban: ${telegramIdToMarzbanUsers.size}`);

    // Находим все подписки с subscriptionUrl (не NULL)
    console.log("\n🔍 Поиск подписок в БД...");
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

    console.log(`📊 Найдено подписок в БД: ${subscriptions.length}`);

    if (subscriptions.length === 0) {
      console.log("✅ Нет подписок для обновления");
      return;
    }

    let updated = 0;
    let errors = 0;
    let notFound = 0;

    // Обрабатываем каждую подписку
    for (const sub of subscriptions) {
      try {
        const telegramId = sub.user.telegramId;
        const marzbanUsersForTelegramId = telegramIdToMarzbanUsers.get(telegramId) || [];

        if (marzbanUsersForTelegramId.length === 0) {
          console.log(`⚠️  Подписка ${sub.id}: пользователь с telegramId ${telegramId} не найден в Marzban`);
          notFound++;
          continue;
        }

        // Обновляем всех пользователей Marzban для этого telegramId
        for (const marzbanUser of marzbanUsersForTelegramId) {
          const currentInbounds = marzbanUser.inbounds?.vless || [];
          const hasVision = currentInbounds.includes("VLESS-TCP-REALITY-VISION");

          if (hasVision) {
            console.log(`✓ Подписка ${sub.id}: пользователь ${marzbanUser.username} уже имеет VLESS-TCP-REALITY-VISION`);
            continue;
          }

          console.log(`🔄 Подписка ${sub.id}: обновление пользователя ${marzbanUser.username} (telegramId: ${telegramId})`);

          const result = await updateUserInboundsByUsername(marzbanUser.username, marzbanUser);

          if (result.success) {
            console.log(`✅ Пользователь ${marzbanUser.username} обновлен успешно`);
            updated++;
          } else {
            console.log(`❌ Ошибка при обновлении ${marzbanUser.username}: ${result.reason}`);
            errors++;
          }

          // Небольшая задержка чтобы не перегружать API
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`❌ Исключение при обработке подписки ${sub.id}:`, error.message);
        errors++;
      }
    }

    console.log("\n📈 Итоги миграции:");
    console.log(`   ✅ Обновлено пользователей: ${updated}`);
    console.log(`   ⚠️  Не найдено telegramId в Marzban: ${notFound}`);
    console.log(`   ❌ Ошибок: ${errors}`);
    console.log(`   📊 Всего обработано подписок: ${subscriptions.length}`);

    if (errors === 0 && notFound === 0) {
      console.log("\n✅ Миграция завершена успешно!");
    } else if (errors === 0) {
      console.log("\n✅ Миграция завершена (некоторые пользователи не найдены в Marzban)");
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
    console.log("🔍 Проверка: получение всех пользователей из Marzban...");

    if (!MARZBAN_API_URL || MARZBAN_API_URL === "your_marzban_api_url") {
      console.log("⚠️  MARZBAN_API_URL не настроен. Режим проверки недоступен.");
      return;
    }

    // Получаем всех пользователей из Marzban
    const marzbanUsers = await getAllMarzbanUsers();
    console.log(`📊 Получено пользователей из Marzban: ${marzbanUsers.length}`);

    // Создаем карту: telegramId -> список пользователей Marzban
    const telegramIdToMarzbanUsers = new Map();
    for (const marzbanUser of marzbanUsers) {
      const telegramId = extractTelegramId(marzbanUser);
      if (telegramId) {
        if (!telegramIdToMarzbanUsers.has(telegramId)) {
          telegramIdToMarzbanUsers.set(telegramId, []);
        }
        telegramIdToMarzbanUsers.get(telegramId).push(marzbanUser);
      }
    }

    console.log(`📊 Найдено уникальных telegramId в Marzban: ${telegramIdToMarzbanUsers.size}`);

    // Находим все подписки с subscriptionUrl (не NULL)
    console.log("\n🔍 Поиск подписок в БД...");
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

    console.log(`📊 Найдено подписок в БД: ${subscriptions.length}\n`);

    if (subscriptions.length === 0) {
      console.log("✅ Нет подписок для проверки");
      return;
    }

    let found = 0;
    let notFound = 0;
    let needsUpdate = 0;
    let alreadyHasVision = 0;

    // Проверяем каждую подписку
    for (const sub of subscriptions) {
      try {
        const telegramId = sub.user.telegramId;
        const marzbanUsersForTelegramId = telegramIdToMarzbanUsers.get(telegramId) || [];

        if (marzbanUsersForTelegramId.length === 0) {
          console.log(`⚠️  Подписка ${sub.id}: telegramId ${telegramId} не найден в Marzban`);
          notFound++;
          continue;
        }

        found++;
        // Проверяем всех пользователей Marzban для этого telegramId
        for (const marzbanUser of marzbanUsersForTelegramId) {
          const currentInbounds = marzbanUser.inbounds?.vless || [];
          const hasVision = currentInbounds.includes("VLESS-TCP-REALITY-VISION");
          
          if (hasVision) {
            console.log(`✅ Подписка ${sub.id}: ${marzbanUser.username} уже имеет VLESS-TCP-REALITY-VISION`);
            alreadyHasVision++;
          } else {
            console.log(`⚠️  Подписка ${sub.id}: ${marzbanUser.username} НУЖНО ОБНОВИТЬ (текущие inbounds: ${JSON.stringify(currentInbounds)})`);
            needsUpdate++;
          }
        }
      } catch (error) {
        console.error(`❌ Ошибка при проверке подписки ${sub.id}:`, error.message);
      }
    }

    console.log("\n📈 Итоги проверки:");
    console.log(`   ✅ Найдено telegramId в Marzban: ${found}`);
    console.log(`   ✓ Уже имеют VLESS-TCP-REALITY-VISION: ${alreadyHasVision}`);
    console.log(`   ⚠️  Нужно обновить: ${needsUpdate}`);
    console.log(`   ⚠️  Не найдено telegramId в Marzban: ${notFound}`);
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
