#!/bin/bash
# apply-promo-migration-safe.sh - Безопасное применение миграции продвинутой системы промокодов

set -e  # Остановка при любой ошибке

echo "🔒 Безопасное применение миграции продвинутой системы промокодов"
echo ""

PROJECT_DIR="/opt/bot-marzban-vpn"
cd "$PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")"

DB_PATH="./prisma/dev.db"
BACKUP_DIR="./back"
NEW_MIGRATION="20260120000000_add_advanced_promo_system"

# 1. Проверка наличия БД
if [ ! -f "$DB_PATH" ]; then
    echo "❌ Ошибка: база данных не найдена: $DB_PATH"
    exit 1
fi

echo "✅ База данных найдена: $DB_PATH"
echo ""

# 2. Создание резервной копии
echo "💾 Создание резервной копии..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/dev.db.backup-before-promo-migration-$TIMESTAMP.db"

mkdir -p "$BACKUP_DIR"
cp "$DB_PATH" "$BACKUP_FILE"
DB_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "✅ Бэкап создан: $BACKUP_FILE (${DB_SIZE})"
echo ""

# 3. Проверка текущей структуры AdminPromo
echo "🔍 Проверка текущей структуры таблицы AdminPromo..."
if command -v sqlite3 &> /dev/null; then
    # Проверяем, есть ли уже новые поля
    HAS_TYPE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('AdminPromo') WHERE name='type';" 2>/dev/null || echo "0")
    HAS_ACTIVATION_TABLE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='AdminPromoActivation';" 2>/dev/null || echo "0")
    
    if [ "$HAS_TYPE" = "1" ] && [ "$HAS_ACTIVATION_TABLE" = "1" ]; then
        echo "✅ Миграция уже применена! Таблица AdminPromo содержит новые поля и AdminPromoActivation существует."
        echo ""
        echo "💡 Если вы хотите применить миграцию заново, сначала откатите её вручную."
        exit 0
    fi
    
    if [ "$HAS_TYPE" = "0" ]; then
        echo "📋 Текущая структура AdminPromo: старый формат (без type, days, isReusable)"
        echo "   Миграция необходима."
    fi
else
    echo "⚠️  sqlite3 не найден, пропускаем проверку структуры"
fi
echo ""

# 4. Baseline существующих миграций
echo "📝 Создание baseline для существующих миграций..."
echo "   Это пометит все существующие миграции как примененные без их выполнения."

# Список всех миграций кроме новой
EXISTING_MIGRATIONS=(
    "20250920090156_init"
    "20250920090822_add_subscription"
    "20250920091722_add_subscription2"
    "20250920092239_add_balance_subs_enum_topups"
    "20250920095543_add_subscription_url"
    "20250920114234_update_topup"
    "20250920115006_update_topup"
    "20250920120742_add_topup_credited_fields"
    "20250922192610_add_promocodes"
    "20250925142719_add_subscription_reminders"
    "20260116192259_add_subscription_url2"
)

for migration in "${EXISTING_MIGRATIONS[@]}"; do
    echo "   Помечаем как примененную: $migration"
    npx prisma migrate resolve --applied "$migration" 2>/dev/null || echo "     ⚠️  Миграция $migration уже помечена или не найдена"
done

echo "✅ Baseline завершен"
echo ""

# 5. Применение новой миграции
echo "🔄 Применение новой миграции: $NEW_MIGRATION"
echo ""

# Проверяем, существует ли файл миграции
if [ ! -f "prisma/migrations/$NEW_MIGRATION/migration.sql" ]; then
    echo "❌ Ошибка: файл миграции не найден: prisma/migrations/$NEW_MIGRATION/migration.sql"
    exit 1
fi

# Применяем миграцию через Prisma
echo "   Выполняю миграцию через Prisma..."
if npx prisma migrate deploy --schema=prisma/schema.prisma; then
    echo "✅ Миграция применена успешно через Prisma"
else
    echo "⚠️  Prisma migrate deploy не сработал, применяю миграцию вручную через sqlite3..."
    
    # Применяем миграцию вручную через sqlite3
    if command -v sqlite3 &> /dev/null; then
        sqlite3 "$DB_PATH" < "prisma/migrations/$NEW_MIGRATION/migration.sql"
        
        # Помечаем миграцию как примененную
        npx prisma migrate resolve --applied "$NEW_MIGRATION"
        
        echo "✅ Миграция применена вручную"
    else
        echo "❌ Ошибка: sqlite3 не найден, не могу применить миграцию вручную"
        echo "   Восстановите БД из бэкапа: cp $BACKUP_FILE $DB_PATH"
        exit 1
    fi
fi

echo ""

# 6. Проверка результата
echo "🔍 Проверка результата миграции..."
if command -v sqlite3 &> /dev/null; then
    # Проверяем новые поля
    HAS_TYPE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('AdminPromo') WHERE name='type';" 2>/dev/null || echo "0")
    HAS_DAYS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('AdminPromo') WHERE name='days';" 2>/dev/null || echo "0")
    HAS_ISREUSABLE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('AdminPromo') WHERE name='isReusable';" 2>/dev/null || echo "0")
    HAS_CUSTOMNAME=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('AdminPromo') WHERE name='customName';" 2>/dev/null || echo "0")
    HAS_ACTIVATION_TABLE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='AdminPromoActivation';" 2>/dev/null || echo "0")
    
    if [ "$HAS_TYPE" = "1" ] && [ "$HAS_DAYS" = "1" ] && [ "$HAS_ISREUSABLE" = "1" ] && [ "$HAS_CUSTOMNAME" = "1" ] && [ "$HAS_ACTIVATION_TABLE" = "1" ]; then
        echo "✅ Все новые поля и таблица созданы успешно!"
        
        # Проверяем данные
        PROMO_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM AdminPromo;" 2>/dev/null || echo "0")
        echo "   📊 Промокодов в БД: $PROMO_COUNT"
        
        if [ "$PROMO_COUNT" -gt "0" ]; then
            # Проверяем, что данные сохранились
            SAMPLE_PROMO=$(sqlite3 "$DB_PATH" "SELECT code, type FROM AdminPromo LIMIT 1;" 2>/dev/null || echo "")
            if [ -n "$SAMPLE_PROMO" ]; then
                echo "   ✅ Данные сохранены. Пример: $SAMPLE_PROMO"
            fi
        fi
    else
        echo "❌ Ошибка: не все поля созданы!"
        echo "   type: $HAS_TYPE, days: $HAS_DAYS, isReusable: $HAS_ISREUSABLE, customName: $HAS_CUSTOMNAME, AdminPromoActivation: $HAS_ACTIVATION_TABLE"
        echo ""
        echo "🔄 Восстанавливаю БД из бэкапа..."
        cp "$BACKUP_FILE" "$DB_PATH"
        echo "✅ БД восстановлена из бэкапа"
        exit 1
    fi
else
    echo "⚠️  sqlite3 не найден, пропускаем проверку"
fi

echo ""

# 7. Генерация Prisma Client
echo "🔨 Генерация Prisma Client..."
npx prisma generate
echo "✅ Prisma Client сгенерирован"
echo ""

# 8. Финальная проверка
echo "✅ Миграция успешно применена!"
echo ""
echo "📝 Информация:"
echo "   - Бэкап сохранен: $BACKUP_FILE"
echo "   - Новая миграция применена: $NEW_MIGRATION"
echo "   - Prisma Client обновлен"
echo ""
echo "💡 Следующие шаги:"
echo "   1. Перезапустите бота: pm2 restart bot-marzban-vpn"
echo "   2. Проверьте логи: pm2 logs bot-marzban-vpn --lines 50"
echo "   3. Протестируйте создание промокода: /createpromo days 7 Тест"
echo ""
