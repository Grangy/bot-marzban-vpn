#!/bin/bash
# test-prisma-paths.sh - Тестирование разных форматов путей для Prisma

echo "🔍 Тестирование разных форматов путей для Prisma..."
echo ""

PROJECT_DIR="/opt/bot-marzban-vpn"
cd "$PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")"

# Текущий путь из .env
CURRENT_PATH=$(grep "^DATABASE_URL=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
echo "📋 Текущий путь в .env: $CURRENT_PATH"
echo ""

# Варианты путей для тестирования
PATHS=(
    "file:./prisma/dev.db"
    "file:./dev.db"
    "file:prisma/dev.db"
    "file:dev.db"
)

# Абсолютный путь
ABSOLUTE_PATH="file:$(realpath prisma/dev.db 2>/dev/null || echo "$PROJECT_DIR/prisma/dev.db")"
PATHS+=("$ABSOLUTE_PATH")

echo "🧪 Тестирование путей:"
echo ""

for path in "${PATHS[@]}"; do
    echo "   Тестирую: $path"
    
    # Создаем временный .env для теста
    cp .env .env.backup.test
    
    # Обновляем DATABASE_URL
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"$path\"|" .env
    
    # Пытаемся подключиться через Prisma
    cat > /tmp/test-prisma-path.js << EOF
const path = require('path');
process.chdir('$PROJECT_DIR');

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const userCount = await prisma.user.count();
    console.log('      ✅ Успешно! Пользователей: ' + userCount);
    await prisma.\$disconnect();
    process.exit(0);
  } catch (err) {
    console.log('      ❌ Ошибка: ' + err.message.split('\\n')[0]);
    await prisma.\$disconnect();
    process.exit(1);
  }
})();
EOF
    
    if node /tmp/test-prisma-path.js 2>/dev/null; then
        echo "      ✅ Этот путь работает!"
        echo ""
        echo "💡 Рекомендуемый путь: $path"
        echo ""
        
        # Восстанавливаем .env
        mv .env.backup.test .env
        rm -f /tmp/test-prisma-path.js
        
        # Предлагаем обновить .env
        read -p "   Обновить .env на этот путь? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"$path\"|" .env
            echo "   ✅ .env обновлен!"
            echo ""
            echo "🔄 Регенерируем Prisma Client..."
            npx prisma generate
            echo ""
            echo "✅ Готово! Теперь попробуйте запустить: npx prisma studio"
        else
            echo "   ⏭️  Пропущено"
        fi
        break
    else
        echo "      ❌ Не работает"
    fi
    
    # Восстанавливаем .env
    mv .env.backup.test .env
    rm -f /tmp/test-prisma-path.js
done

echo ""
echo "💡 Альтернативное решение:"
echo "   Если относительные пути не работают, используйте абсолютный:"
echo "   DATABASE_URL=\"file:$PROJECT_DIR/prisma/dev.db\""
echo ""
