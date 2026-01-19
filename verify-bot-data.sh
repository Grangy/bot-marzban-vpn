#!/bin/bash
# verify-bot-data.sh - Проверка, видит ли бот данные из БД

echo "🔍 Проверка видимости данных ботом..."
echo ""

PROJECT_DIR="/opt/bot-marzban-vpn"
cd "$PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")"

# 1. Проверка статуса бота
echo "🤖 Статус бота:"
if command -v pm2 &> /dev/null; then
    pm2 status bot-marzban-vpn 2>/dev/null || echo "   ⚠️  Бот не запущен через pm2"
else
    echo "   ⚠️  pm2 не найден"
fi
echo ""

# 2. Проверка Prisma Client синхронизации
echo "🔧 Проверка Prisma Client:"
if [ -f "prisma/schema.prisma" ]; then
    echo "   ✅ schema.prisma найден"
    
    # Проверяем, нужно ли регенерировать клиент
    if [ -d "node_modules/@prisma/client" ]; then
        echo "   ✅ Prisma Client установлен"
        echo "   🔄 Регенерируем Prisma Client для синхронизации..."
        npx prisma generate 2>&1 | head -5
        echo ""
    else
        echo "   ⚠️  Prisma Client не найден, генерируем..."
        npx prisma generate
    fi
else
    echo "   ❌ schema.prisma не найден!"
fi
echo ""

# 3. Проверка данных через Prisma напрямую
echo "📊 Проверка данных через Node.js (как видит бот):"
cat > /tmp/check-prisma-data.js << 'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const userCount = await prisma.user.count();
    const subCount = await prisma.subscription.count();
    const topupCount = await prisma.topUp.count();
    
    console.log(`   👥 Пользователей: ${userCount}`);
    console.log(`   📦 Подписок: ${subCount}`);
    console.log(`   💳 Пополнений: ${topupCount}`);
    
    if (userCount > 0) {
      const sampleUser = await prisma.user.findFirst({
        select: { id: true, telegramId: true, balance: true, accountName: true }
      });
      console.log(`   📋 Пример пользователя: ID=${sampleUser.id}, telegramId=${sampleUser.telegramId}, balance=${sampleUser.balance}₽`);
    }
    
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error('   ❌ Ошибка:', err.message);
    await prisma.$disconnect();
    process.exit(1);
  }
})();
EOF

node /tmp/check-prisma-data.js
rm -f /tmp/check-prisma-data.js
echo ""

# 4. Проверка логов бота на ошибки
echo "📋 Последние ошибки в логах бота:"
if command -v pm2 &> /dev/null; then
    pm2 logs bot-marzban-vpn --lines 20 --nostream --err 2>/dev/null | tail -10 || echo "   ⚠️  Не удалось получить логи"
else
    echo "   ⚠️  pm2 не найден"
fi
echo ""

# 5. Рекомендации
echo "💡 Рекомендации:"
echo "   1. Если Prisma видит данные, но бот не работает:"
echo "      pm2 restart bot-marzban-vpn"
echo ""
echo "   2. Если Prisma НЕ видит данные, но БД не пустая:"
echo "      npx prisma generate"
echo "      pm2 restart bot-marzban-vpn"
echo ""
echo "   3. Для проверки через Prisma Studio:"
echo "      npx prisma studio"
echo ""
