#!/bin/bash
# check-database.sh - Диагностика состояния базы данных

echo "🔍 Диагностика базы данных..."
echo ""

PROJECT_DIR="/opt/bot-marzban-vpn"
cd "$PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")"

# 1. Проверка путей БД
echo "📂 Проверка путей к базе данных:"
POSSIBLE_PATHS=("./dev.db" "./prisma/dev.db")
for path in "${POSSIBLE_PATHS[@]}"; do
    if [ -f "$path" ]; then
        SIZE=$(du -h "$path" | cut -f1)
        echo "✅ Найдена: $path (${SIZE})"
        
        if command -v sqlite3 &> /dev/null; then
            TABLES=$(sqlite3 "$path" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" 2>/dev/null | wc -l)
            USERS=$(sqlite3 "$path" "SELECT COUNT(*) FROM User;" 2>/dev/null || echo "0")
            SUBS=$(sqlite3 "$path" "SELECT COUNT(*) FROM Subscription;" 2>/dev/null || echo "0")
            TOPUPS=$(sqlite3 "$path" "SELECT COUNT(*) FROM TopUp;" 2>/dev/null || echo "0")
            
            echo "   📊 Таблиц: $TABLES"
            echo "   👥 Пользователей: $USERS"
            echo "   📦 Подписок: $SUBS"
            echo "   💳 Пополнений: $TOPUPS"
        fi
    else
        echo "❌ Не найдена: $path"
    fi
done
echo ""

# 2. Проверка .env
echo "📋 Проверка .env:"
if [ -f ".env" ]; then
    if grep -q "DATABASE_URL" .env; then
        DB_URL=$(grep "^DATABASE_URL=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
        echo "   DATABASE_URL: $DB_URL"
        
        # Извлекаем путь из DATABASE_URL
        if [[ "$DB_URL" == file:./dev.db ]]; then
            EXPECTED_PATH="./dev.db"
        elif [[ "$DB_URL" == file:./prisma/dev.db ]]; then
            EXPECTED_PATH="./prisma/dev.db"
        else
            EXPECTED_PATH="неизвестно"
        fi
        echo "   Ожидаемый путь: $EXPECTED_PATH"
        
        if [ -f "$EXPECTED_PATH" ] && [ "$EXPECTED_PATH" != "неизвестно" ]; then
            echo "   ✅ Файл существует по ожидаемому пути"
        else
            echo "   ⚠️  Файл НЕ существует по ожидаемому пути!"
        fi
    else
        echo "   ⚠️  DATABASE_URL не найден в .env"
    fi
else
    echo "   ⚠️  Файл .env не найден"
fi
echo ""

# 3. Проверка бэкапов
echo "💾 Проверка бэкапов:"
BACKUP_DIR="./back"
if [ -d "$BACKUP_DIR" ]; then
    BACKUP_COUNT=$(find "$BACKUP_DIR" -name "*.db" -type f 2>/dev/null | wc -l)
    echo "   Найдено бэкапов: $BACKUP_COUNT"
    
    if [ "$BACKUP_COUNT" -gt "0" ]; then
        echo "   Последние 5 бэкапов:"
        find "$BACKUP_DIR" -name "*.db" -type f -printf "%T@ %p\n" 2>/dev/null | sort -rn | head -5 | while read ts path; do
            SIZE=$(du -h "$path" | cut -f1)
            DATE=$(date -d "@$ts" 2>/dev/null || date -r "$ts" 2>/dev/null || echo "неизвестно")
            echo "   - $(basename "$path") (${SIZE}, $DATE)"
        done
    fi
else
    echo "   ⚠️  Директория бэкапов не найдена: $BACKUP_DIR"
fi
echo ""

# 4. Проверка Prisma
echo "🔧 Проверка Prisma:"
if command -v npx &> /dev/null; then
    echo "   Проверка Prisma Client..."
    if [ -d "node_modules/@prisma/client" ]; then
        echo "   ✅ Prisma Client установлен"
    else
        echo "   ⚠️  Prisma Client не найден (нужно: npx prisma generate)"
    fi
else
    echo "   ⚠️  npx не найден"
fi
echo ""

# 5. Рекомендации
echo "💡 Рекомендации:"
if command -v sqlite3 &> /dev/null; then
    HAS_DATA=false
    for path in "${POSSIBLE_PATHS[@]}"; do
        if [ -f "$path" ]; then
            USERS=$(sqlite3 "$path" "SELECT COUNT(*) FROM User;" 2>/dev/null || echo "0")
            if [ "$USERS" -gt "0" ]; then
                HAS_DATA=true
                echo "   ✅ База данных $path содержит данные ($USERS пользователей)"
                break
            fi
        fi
    done
    
    if [ "$HAS_DATA" = false ]; then
        echo "   ⚠️  Все найденные БД пусты!"
        echo "   🔄 Выполните восстановление из бэкапа:"
        echo "      bash rollback-and-restore-server.sh"
    fi
else
    echo "   ⚠️  sqlite3 не установлен. Установите для детальной диагностики:"
    echo "      apt-get install sqlite3  # или yum install sqlite3"
fi
echo ""
