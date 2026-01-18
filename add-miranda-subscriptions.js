#!/usr/bin/env node
/**
 * Скрипт для добавления второй подписки (Miranda/rus2) всем пользователям
 * у которых есть активная подписка, но нет subscriptionUrl2
 * 
 * Использование:
 *   node add-miranda-subscriptions.js          - показать что будет сделано (dry-run)
 *   node add-miranda-subscriptions.js --run    - выполнить миграцию
 */

require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const prisma = new PrismaClient();

const MARZBAN_API_URL_2 = process.env.MARZBAN_API_URL_2 || "http://51.250.72.185:3033";
const MARZBAN_TOKEN_2 = process.env.MARZBAN_TOKEN_2 || process.env.MARZBAN_TOKEN;

const isDryRun = !process.argv.includes("--run");

/**
 * Преобразует subscription_url от Marzban API в ссылку для rus2 сервера
 */
function convertToRus2Url(originalUrl) {
  if (!originalUrl) return null;
  const match = originalUrl.match(/\/sub\/(.+)$/);
  if (match) {
    const token = match[1];
    return `https://rus2.grangy.ru:8888/sub/${token}`;
  }
  return null;
}

/**
 * Получает информацию о пользователе с основного Marzban сервера
 */
async function getMarzbanUser(username) {
  try {
    const response = await fetch(`${process.env.MARZBAN_API_URL}/users/${username}`, {
      headers: {
        "Authorization": `Bearer ${process.env.MARZBAN_TOKEN}`
      }
    });
    
    if (!response.ok) {
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error(`[ERROR] Failed to get user ${username}:`, error.message);
    return null;
  }
}

/**
 * Создает пользователя на втором сервере (rus2/Miranda)
 */
async function createUserOnRus2(userData) {
  try {
    console.log(`  [Marzban] Creating user ${userData.username} on rus2...`);
    
    // Данные для второго сервера - только VLESS TCP REALITY
    const userDataSecondary = {
      ...userData,
      inbounds: { vless: ["VLESS TCP REALITY"] }
    };
    
    const response = await fetch(`${MARZBAN_API_URL_2}/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MARZBAN_TOKEN_2}`
      },
      body: JSON.stringify(userDataSecondary)
    });

    if (!response.ok) {
      const errorText = await response.text();
      
      // Если пользователь уже существует, пробуем получить его данные
      if (response.status === 409 || errorText.includes("already exists")) {
        console.log(`  [Marzban] User already exists on rus2, getting subscription URL...`);
        
        const getResponse = await fetch(`${MARZBAN_API_URL_2}/users/${userData.username}`, {
          headers: {
            "Authorization": `Bearer ${MARZBAN_TOKEN_2}`
          }
        });
        
        if (getResponse.ok) {
          const existingUser = await getResponse.json();
          return existingUser.subscription_url;
        }
      }
      
      console.error(`  [ERROR] Failed to create user on rus2:`, errorText);
      return null;
    }

    const result = await response.json();
    console.log(`  [Marzban] User created successfully on rus2`);
    return result.subscription_url;
  } catch (error) {
    console.error(`  [ERROR] Error creating user on rus2:`, error.message);
    return null;
  }
}

/**
 * Формирует username для Marzban
 * Формат: {telegramId}_{type}_{subscriptionId}
 */
function buildMarzbanUsername(telegramId, type, subscriptionId) {
  return `${telegramId}_${type}_${subscriptionId}`;
}

async function main() {
  console.log("=".repeat(60));
  console.log("Скрипт добавления Miranda подписок (rus2)");
  console.log("=".repeat(60));
  
  if (isDryRun) {
    console.log("\n⚠️  РЕЖИМ ПРОСМОТРА (dry-run)");
    console.log("Для выполнения запустите: node add-miranda-subscriptions.js --run\n");
  } else {
    console.log("\n🚀 РЕЖИМ ВЫПОЛНЕНИЯ\n");
  }

  // Находим все активные подписки без subscriptionUrl2
  const subscriptions = await prisma.subscription.findMany({
    where: {
      subscriptionUrl: { not: null },  // Есть основная подписка
      subscriptionUrl2: null,           // Нет второй подписки
      endDate: { gt: new Date() },      // Подписка активна
      type: { notIn: ["FREE"] }         // Не бесплатная
    },
    include: {
      user: true
    }
  });

  console.log(`📊 Найдено подписок без Miranda: ${subscriptions.length}\n`);

  if (subscriptions.length === 0) {
    console.log("✅ Все активные подписки уже имеют Miranda ссылку!");
    await prisma.$disconnect();
    return;
  }

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const sub of subscriptions) {
    console.log(`\n[${sub.id}] Пользователь: ${sub.user.accountName || sub.user.telegramId}`);
    console.log(`  Тип: ${sub.type}`);
    console.log(`  Истекает: ${sub.endDate?.toISOString()}`);
    console.log(`  URL1: ${sub.subscriptionUrl}`);

    // Формируем username для Marzban
    const marzbanUsername = buildMarzbanUsername(sub.user.telegramId, sub.type, sub.id);
    console.log(`  Marzban username: ${marzbanUsername}`);

    // Получаем данные пользователя с основного сервера
    const marzbanUser = await getMarzbanUser(marzbanUsername);
    
    if (!marzbanUser) {
      console.log(`  ⚠️ Пользователь не найден на основном сервере, создаём напрямую...`);
      
      // Если пользователь не найден на основном сервере, создаём на rus2 напрямую
      // используя данные из БД
      const expireTimestamp = Math.floor(sub.endDate.getTime() / 1000);
      
      const userData = {
        username: marzbanUsername,
        status: "active",
        expire: expireTimestamp,
        proxies: {
          vless: {
            id: require("crypto").randomUUID(),
            flow: "xtls-rprx-vision"
          }
        },
        note: `Telegram user ${sub.user.accountName || sub.user.telegramId}`,
        data_limit: 0,
        data_limit_reset_strategy: "no_reset"
      };

      if (isDryRun) {
        console.log(`  ✅ [DRY-RUN] Будет создан на rus2 (expire: ${sub.endDate.toISOString()})`);
        successCount++;
        continue;
      }

      const rus2UrlRaw = await createUserOnRus2(userData);
      
      if (!rus2UrlRaw) {
        console.log(`  ❌ Не удалось создать на rus2`);
        errorCount++;
        continue;
      }

      const rus2Url = convertToRus2Url(rus2UrlRaw) || rus2UrlRaw;
      console.log(`  URL2: ${rus2Url}`);

      // Обновляем подписку в БД
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { subscriptionUrl2: rus2Url }
      });

      console.log(`  ✅ Успешно добавлена Miranda подписка`);
      successCount++;
      continue;
    }

    console.log(`  Expire: ${new Date(marzbanUser.expire * 1000).toISOString()}`);

    if (isDryRun) {
      console.log(`  ✅ [DRY-RUN] Будет создан на rus2`);
      successCount++;
      continue;
    }

    // Создаем пользователя на rus2
    const userData = {
      username: marzbanUser.username,
      status: marzbanUser.status || "active",
      expire: marzbanUser.expire,
      proxies: marzbanUser.proxies || {
        vless: {
          id: require("crypto").randomUUID(),
          flow: "xtls-rprx-vision"
        }
      },
      note: marzbanUser.note || `Telegram user ${sub.user.telegramId}`,
      data_limit: marzbanUser.data_limit || 0,
      data_limit_reset_strategy: marzbanUser.data_limit_reset_strategy || "no_reset"
    };

    const rus2UrlRaw = await createUserOnRus2(userData);
    
    if (!rus2UrlRaw) {
      console.log(`  ❌ Не удалось создать на rus2`);
      errorCount++;
      continue;
    }

    const rus2Url = convertToRus2Url(rus2UrlRaw) || rus2UrlRaw;
    console.log(`  URL2: ${rus2Url}`);

    // Обновляем подписку в БД
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { subscriptionUrl2: rus2Url }
    });

    console.log(`  ✅ Успешно добавлена Miranda подписка`);
    successCount++;
  }

  console.log("\n" + "=".repeat(60));
  console.log("ИТОГО:");
  console.log(`  ✅ Успешно: ${successCount}`);
  console.log(`  ❌ Ошибок: ${errorCount}`);
  console.log(`  ⚠️ Пропущено: ${skippedCount}`);
  console.log("=".repeat(60));

  if (isDryRun && successCount > 0) {
    console.log("\n💡 Для выполнения запустите:");
    console.log("   node add-miranda-subscriptions.js --run");
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("❌ Критическая ошибка:", e);
  prisma.$disconnect();
  process.exit(1);
});
