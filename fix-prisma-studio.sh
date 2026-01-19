#!/bin/bash
# fix-prisma-studio.sh - Диагностика и исправление проблемы с Prisma Studio

echo "🔍 Диагностика Prisma Studio..."
echo ""

PROJECT_DIR="/opt/bot-marzban-vpn"
cd "$PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")"

# 1. Проверка DATABASE_URL в .env
echo "📋 Проверка DATABASE_URL:"
if [ -f ".env" ]; then
    DB_URL=$(grep "^DATABASE_URL=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'" | tr -d ' ')
    echo "   DATABASE_URL: $DB_URL"
    
    # Извлекаем путь
    if [[ "$DB_URL" == file:./dev.db ]]; then
        EXPECTED_DB="./dev.db"
    elif [[ "$DB_URL" == file:./prisma/dev.db ]]; then
        EXPECTED_DB="./prisma/dev.db"
    elif [[ "$DB_URL" == file:dev.db ]]; then
        EXPECTED_DB="./dev.db"
    elif [[ "$DB_URL" == file:prisma/dev.db ]]; then
        EXPECTED_DB="./prisma/dev.db"
    else
        EXPECTED_DB="неизвестно"
    fi
    echo "   Ожидаемый путь: $EXPECTED_DB"
else
    echo "   ❌ Файл .env не найден!"
    exit 1
fi
echo ""

# 2. Проверка реальных файлов БД
echo "📂 Проверка реальных файлов БД:"
POSSIBLE_PATHS=("./dev.db" "./prisma/dev.db")
FOUND_DB=""
for path in "${POSSIBLE_PATHS[@]}"; do
    if [ -f "$path" ]; then
        SIZE=$(du -h "$path" | cut -f1)
        echo "   ✅ Найдена: $path (${SIZE})"
        
        if command -v sqlite3 &> /dev/null; then
            USER_COUNT=$(sqlite3 "$path" "SELECT COUNT(*) FROM User;" 2>/dev/null || echo "0")
            SUB_COUNT=$(sqlite3 "$path" "SELECT COUNT(*) FROM Subscription;" 2>/dev/null || echo "0")
            echo "      👥 Пользователей: $USER_COUNT"
            echo "      📦 Подписок: $SUB_COUNT"
            
            if [ "$USER_COUNT" -gt "0" ]; then
                FOUND_DB="$path"
            fi
        fi
    else
        echo "   ❌ Не найдена: $path"
    fi
done
echo ""

# 3. Проверка соответствия путей
if [ "$EXPECTED_DB" != "неизвестно" ] && [ -n "$FOUND_DB" ]; then
    if [ "$EXPECTED_DB" != "$FOUND_DB" ]; then
        echo "⚠️  НЕСООТВЕТСТВИЕ ПУТЕЙ!"
        echo "   .env указывает на: $EXPECTED_DB"
        echo "   Данные находятся в: $FOUND_DB"
        echo ""
        echo "🔧 Исправление..."
        
        # Обновляем .env
        if [ -f ".env" ]; then
            # Создаем бэкап .env
            cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
            
            # Обновляем DATABASE_URL
            if [ "$FOUND_DB" == "./prisma/dev.db" ]; then
                NEW_DB_URL="file:./prisma/dev.db"
            else
                NEW_DB_URL="file:./dev.db"
            fi
            
            # Заменяем DATABASE_URL в .env
            if grep -q "^DATABASE_URL=" .env; then
                sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"$NEW_DB_URL\"|" .env
                echo "   ✅ Обновлен .env: DATABASE_URL=\"$NEW_DB_URL\""
            else
                echo "DATABASE_URL=\"$NEW_DB_URL\"" >> .env
                echo "   ✅ Добавлен DATABASE_URL в .env"
            fi
        fi
    else
        echo "✅ Пути соответствуют: $EXPECTED_DB"
    fi
fi
echo ""

# 4. Очистка кеша Prisma
echo "🧹 Очистка кеша Prisma..."
rm -rf node_modules/.prisma 2>/dev/null
rm -rf node_modules/@prisma/client 2>/dev/null
echo "   ✅ Кеш очищен"
echo ""

# 5. Регенерация Prisma Client
echo "🔨 Регенерация Prisma Client..."
npx prisma generate
echo ""

# 6. Проверка через Node.js
echo "📊 Проверка данных через Prisma Client:"
cat > /tmp/test-prisma-data.js << 'EOF'
const path = require('path');
process.chdir(process.argv[2] || process.cwd());

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('   Подключение к БД...');
    const userCount = await prisma.user.count();
    const subCount = await prisma.subscription.count();
    const topupCount = await prisma.topUp.count();
    
    console.log(`   ✅ Пользователей: ${userCount}`);
    console.log(`   ✅ Подписок: ${subCount}`);
    console.log(`   ✅ Пополнений: ${topupCount}`);
    
    if (userCount > 0) {
      const sampleUser = await prisma.user.findFirst({
        select: { id: true, telegramId: true, balance: true, accountName: true }
      });
      console.log(`   📋 Пример: ID=${sampleUser.id}, telegramId=${sampleUser.telegramId}, balance=${sampleUser.balance}₽`);
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

node /tmp/test-prisma-data.js "$PROJECT_DIR"
rm -f /tmp/test-prisma-data.js
echo ""

# 7. Инструкции
echo "💡 Инструкции для запуска Prisma Studio:"
echo ""
echo "   1. Убедитесь, что .env указывает на правильный путь:"
echo "      grep DATABASE_URL .env"
echo ""
echo "   2. Запустите Prisma Studio:"
echo "      npx prisma studio"
echo ""
echo "   3. Если данные все еще пустые, проверьте:"
echo "      - Что Prisma Studio запущен из правильной директории"
echo "      - Что в браузере открыт правильный порт (обычно http://localhost:5555)"
echo "      - Попробуйте перезапустить: Ctrl+C и снова npx prisma studio"
echo ""
echo "   4. Альтернатива - проверьте данные напрямую через sqlite3:"
if [ -n "$FOUND_DB" ]; then
    echo "      sqlite3 $FOUND_DB \"SELECT COUNT(*) FROM User;\""
fi
echo ""
