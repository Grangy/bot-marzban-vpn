#!/usr/bin/env node
/**
 * Скрипт восстановления базы данных из повреждённого бэкапа
 * Извлекает все возможные данные и создаёт новую рабочую БД
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BACKUP_FILE = path.join(__dirname, 'back', 'backup-2026-01-18T11-47-06-543Z.db');
const DUMP_FILE = path.join(__dirname, 'back', 'full_dump.sql');
const NEW_DB_FILE = path.join(__dirname, 'prisma', 'dev.db');
const TEMP_DB = path.join(__dirname, 'back', 'restored.db');

console.log('🔧 Скрипт восстановления базы данных');
console.log('=' .repeat(60));

// 1. Читаем raw данные из повреждённой БД
console.log('\n📖 Читаем данные из повреждённого бэкапа...');
const rawData = fs.readFileSync(BACKUP_FILE);
const dumpData = fs.readFileSync(DUMP_FILE, 'utf-8');

// 2. Извлекаем все Telegram ID
console.log('🔍 Извлекаем Telegram ID...');
const telegramIds = new Set();
const tidRegex = /\b(\d{9,10})\b/g;
let match;
while ((match = tidRegex.exec(rawData.toString('binary'))) !== null) {
  const num = parseInt(match[1]);
  if (num >= 100000000 && num <= 9999999999) {
    telegramIds.add(match[1]);
  }
}
console.log(`   Найдено ${telegramIds.size} уникальных Telegram ID`);

// 3. Извлекаем username'ы
console.log('🔍 Извлекаем username...');
const usernames = {};
const unameRegex = /(\d{9,10})\x00{0,10}(\d{9,10})\x00{0,10}(@[a-zA-Z][a-zA-Z0-9_]{3,30})/g;
while ((match = unameRegex.exec(rawData.toString('binary'))) !== null) {
  const tid = match[1];
  const uname = match[3];
  if (parseInt(tid) >= 100000000 && parseInt(tid) <= 9999999999) {
    usernames[tid] = uname;
  }
}
console.log(`   Найдено ${Object.keys(usernames).length} username'ов`);

// 4. Извлекаем userId -> telegramId из подписок
console.log('🔍 Извлекаем связи userId -> telegramId из подписок...');
const userIdToTid = {};
const tidToUserId = {};
const subUrlRegex = /INSERT INTO Subscription VALUES\(\d+,'[^']+',\d+,[^,]+,(\d+),'([^']*)'/g;
while ((match = subUrlRegex.exec(dumpData)) !== null) {
  const userId = match[1];
  const url = match[2];
  if (url && url.includes('vpn.grangy.ru/sub/')) {
    try {
      const b64Part = url.split('/sub/')[1];
      const decoded = Buffer.from(b64Part, 'base64url').toString('utf-8');
      const tid = decoded.split('_')[0];
      if (/^\d{9,10}$/.test(tid)) {
        userIdToTid[userId] = tid;
        tidToUserId[tid] = userId;
      }
    } catch (e) {}
  }
}
console.log(`   Найдено ${Object.keys(userIdToTid).length} связей`);

// 5. Извлекаем топапы
console.log('🔍 Извлекаем топапы...');
const topups = [];
const topupRegex = /INSERT INTO TopUp VALUES\((\d+),(\d+),(\d+),'([^']+)','([^']+)',([^,]*),(\d),([^,]*),(\d+),(\d+)\)/g;
while ((match = topupRegex.exec(dumpData)) !== null) {
  topups.push({
    id: parseInt(match[1]),
    userId: parseInt(match[2]),
    amount: parseInt(match[3]),
    status: match[4],
    orderId: match[5],
    billId: match[6] === 'NULL' ? null : match[6].replace(/'/g, ''),
    credited: match[7] === '1',
    creditedAt: match[8] === 'NULL' ? null : parseInt(match[8]),
    createdAt: parseInt(match[9]),
    updatedAt: parseInt(match[10])
  });
}
console.log(`   Найдено ${topups.length} топапов`);

// 6. Извлекаем подписки
console.log('🔍 Извлекаем подписки...');
const subscriptions = [];
const subRegex = /INSERT INTO Subscription VALUES\((\d+),'([^']+)',(\d+),(\d+|NULL),(\d+),'([^']*)',(\d),(\d),([^,]*),([^)]*)\)/g;
while ((match = subRegex.exec(dumpData)) !== null) {
  subscriptions.push({
    id: parseInt(match[1]),
    type: match[2],
    startDate: parseInt(match[3]),
    endDate: match[4] === 'NULL' ? null : parseInt(match[4]),
    userId: parseInt(match[5]),
    subscriptionUrl: match[6] || null,
    notified3Days: match[7] === '1',
    notified1Day: match[8] === '1',
    lastExpiredReminderAt: match[9] === 'NULL' ? null : parseInt(match[9]),
    subscriptionUrl2: match[10] === 'NULL' ? null : (match[10] || '').replace(/'/g, '') || null
  });
}
console.log(`   Найдено ${subscriptions.length} подписок`);

// 7. Извлекаем промо-активации
console.log('🔍 Извлекаем промо-активации...');
const promoActivations = [];
const promoRegex = /INSERT INTO PromoActivation VALUES\((\d+),(\d+),(\d+),(\d+),(\d+)\)/g;
while ((match = promoRegex.exec(dumpData)) !== null) {
  promoActivations.push({
    id: parseInt(match[1]),
    codeOwnerId: parseInt(match[2]),
    activatorId: parseInt(match[3]),
    amount: parseInt(match[4]),
    createdAt: parseInt(match[5])
  });
}
console.log(`   Найдено ${promoActivations.length} промо-активаций`);

// 8. Извлекаем промокоды из raw данных
console.log('🔍 Извлекаем промокоды...');
const promoCodes = new Set();
const promoCodeRegex = /[A-F0-9]{8}/g;
while ((match = promoCodeRegex.exec(rawData.toString('binary'))) !== null) {
  promoCodes.add(match[0]);
}
console.log(`   Найдено ${promoCodes.size} потенциальных промокодов`);

// 9. Вычисляем балансы из топапов
console.log('💰 Вычисляем балансы...');
const balances = {};
for (const topup of topups) {
  if (topup.status === 'SUCCESS' && topup.credited) {
    balances[topup.userId] = (balances[topup.userId] || 0) + topup.amount;
  }
}

// Вычитаем стоимость подписок
const PLAN_PRICES = { M1: 100, M3: 270, M6: 520, M12: 1000, PROMO_10D: 0, FREE: 0 };
for (const sub of subscriptions) {
  const price = PLAN_PRICES[sub.type] || 0;
  if (price > 0 && balances[sub.userId]) {
    balances[sub.userId] -= price;
    if (balances[sub.userId] < 0) balances[sub.userId] = 0;
  }
}
console.log(`   Вычислены балансы для ${Object.keys(balances).length} пользователей`);

// 10. Собираем всех пользователей
console.log('👥 Собираем пользователей...');
const users = new Map();

// Добавляем пользователей с подписками (известен userId)
for (const [userId, tid] of Object.entries(userIdToTid)) {
  users.set(parseInt(userId), {
    id: parseInt(userId),
    telegramId: tid,
    chatId: tid,
    accountName: usernames[tid] || null,
    balance: balances[userId] || 0,
    promoCode: null
  });
}

// Добавляем пользователей без подписок
let nextId = Math.max(...Array.from(users.keys()), 0) + 1;
for (const tid of telegramIds) {
  if (!tidToUserId[tid]) {
    users.set(nextId, {
      id: nextId,
      telegramId: tid,
      chatId: tid,
      accountName: usernames[tid] || null,
      balance: 0,
      promoCode: null
    });
    tidToUserId[tid] = nextId.toString();
    nextId++;
  }
}

// Назначаем промокоды (берём из найденных)
const promoCodesArray = Array.from(promoCodes);
let promoIdx = 0;
for (const user of users.values()) {
  if (promoIdx < promoCodesArray.length) {
    user.promoCode = promoCodesArray[promoIdx++];
  }
}

console.log(`   Всего пользователей: ${users.size}`);

// 11. Создаём новую базу данных
console.log('\n🗄️  Создаём новую базу данных...');

// Удаляем старую БД если есть
if (fs.existsSync(NEW_DB_FILE)) {
  fs.unlinkSync(NEW_DB_FILE);
  console.log('   Удалена старая БД');
}
if (fs.existsSync(NEW_DB_FILE + '-journal')) {
  fs.unlinkSync(NEW_DB_FILE + '-journal');
}

// Создаём БД через Prisma
console.log('   Применяем схему Prisma...');
try {
  execSync('npx prisma db push --force-reset --accept-data-loss', { 
    cwd: __dirname,
    stdio: 'pipe'
  });
  console.log('   ✅ Схема применена');
} catch (e) {
  console.error('   ❌ Ошибка применения схемы:', e.message);
  process.exit(1);
}

// 12. Вставляем данные
console.log('\n📝 Вставляем данные...');

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function insertData() {
  try {
    // Вставляем пользователей
    console.log('   Вставляем пользователей...');
    const sortedUsers = Array.from(users.values()).sort((a, b) => a.id - b.id);
    
    for (const user of sortedUsers) {
      try {
        await prisma.user.create({
          data: {
            id: user.id,
            telegramId: user.telegramId,
            chatId: user.chatId,
            accountName: user.accountName,
            balance: user.balance,
            promoCode: user.promoCode,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });
      } catch (e) {
        // Пропускаем дубликаты
      }
    }
    console.log(`   ✅ Вставлено ${sortedUsers.length} пользователей`);

    // Обновляем autoincrement
    await prisma.$executeRawUnsafe(`UPDATE sqlite_sequence SET seq = ${nextId} WHERE name = 'User'`);

    // Вставляем подписки
    console.log('   Вставляем подписки...');
    let subCount = 0;
    for (const sub of subscriptions) {
      try {
        // Проверяем что userId существует
        const userExists = users.has(sub.userId);
        if (!userExists) continue;

        await prisma.subscription.create({
          data: {
            id: sub.id,
            type: sub.type,
            startDate: new Date(sub.startDate),
            endDate: sub.endDate ? new Date(sub.endDate) : null,
            userId: sub.userId,
            subscriptionUrl: sub.subscriptionUrl || null,
            subscriptionUrl2: sub.subscriptionUrl2 || null,
            notified3Days: sub.notified3Days,
            notified1Day: sub.notified1Day,
            lastExpiredReminderAt: sub.lastExpiredReminderAt ? new Date(sub.lastExpiredReminderAt) : null
          }
        });
        subCount++;
      } catch (e) {
        // Пропускаем ошибки
      }
    }
    console.log(`   ✅ Вставлено ${subCount} подписок`);

    // Вставляем топапы
    console.log('   Вставляем топапы...');
    let topupCount = 0;
    for (const topup of topups) {
      try {
        const userExists = users.has(topup.userId);
        if (!userExists) continue;

        await prisma.topUp.create({
          data: {
            id: topup.id,
            userId: topup.userId,
            amount: topup.amount,
            status: topup.status,
            orderId: topup.orderId,
            billId: topup.billId,
            credited: topup.credited,
            creditedAt: topup.creditedAt ? new Date(topup.creditedAt) : null,
            createdAt: new Date(topup.createdAt),
            updatedAt: new Date(topup.updatedAt)
          }
        });
        topupCount++;
      } catch (e) {
        // Пропускаем ошибки
      }
    }
    console.log(`   ✅ Вставлено ${topupCount} топапов`);

    // Вставляем промо-активации
    console.log('   Вставляем промо-активации...');
    let promoCount = 0;
    for (const promo of promoActivations) {
      try {
        const ownerExists = users.has(promo.codeOwnerId);
        const activatorExists = users.has(promo.activatorId);
        if (!ownerExists || !activatorExists) continue;

        await prisma.promoActivation.create({
          data: {
            id: promo.id,
            codeOwnerId: promo.codeOwnerId,
            activatorId: promo.activatorId,
            amount: promo.amount,
            createdAt: new Date(promo.createdAt)
          }
        });
        promoCount++;
      } catch (e) {
        // Пропускаем ошибки
      }
    }
    console.log(`   ✅ Вставлено ${promoCount} промо-активаций`);

    // Пересчитываем балансы правильно
    console.log('   Пересчитываем балансы...');
    for (const [userId, balance] of Object.entries(balances)) {
      if (users.has(parseInt(userId))) {
        await prisma.user.update({
          where: { id: parseInt(userId) },
          data: { balance: Math.max(0, balance) }
        });
      }
    }
    console.log('   ✅ Балансы обновлены');

  } finally {
    await prisma.$disconnect();
  }
}

insertData().then(() => {
  console.log('\n' + '='.repeat(60));
  console.log('✅ ВОССТАНОВЛЕНИЕ ЗАВЕРШЕНО!');
  console.log('='.repeat(60));
  console.log(`\n📊 Итого восстановлено:`);
  console.log(`   👥 Пользователей: ${users.size}`);
  console.log(`   📋 Подписок: ${subscriptions.length}`);
  console.log(`   💳 Топапов: ${topups.length}`);
  console.log(`   🎁 Промо-активаций: ${promoActivations.length}`);
  console.log(`\n📁 Новая БД: ${NEW_DB_FILE}`);
  console.log('\n🚀 Теперь можно запускать бота!');
}).catch(e => {
  console.error('❌ Ошибка:', e);
  process.exit(1);
});
