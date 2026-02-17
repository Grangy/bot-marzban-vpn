#!/bin/bash
# update-server.sh - Безопасный скрипт для обновления бота на сервере с сохранением данных

set -e  # Остановка при любой ошибке

echo "🚀 Безопасное обновление бота на сервере..."
echo ""

# Путь к директории проекта (измените если нужно)
PROJECT_DIR="/opt/bot-marzban-vpn"
DB_PATH="./prisma/dev.db"

# Проверяем, что директория проекта существует
if [ ! -d "$PROJECT_DIR" ]; then
    echo "❌ Ошибка: директория проекта не найдена: $PROJECT_DIR"
    exit 1
fi

# Переходим в директорию проекта
cd "$PROJECT_DIR"

# 1. Остановить PM2 процесс
echo "⏹️  Остановка бота..."
pm2 stop bot-marzban-vpn || echo "⚠️  Бот не был запущен"
echo ""

# 2. Создание резервной копии базы данных
echo "💾 Создание резервной копии базы данных..."

BACKUP_DIR="./back"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="backup_pre_deploy_${TIMESTAMP}.db"

# Создаем директорию для бэкапов если её нет
mkdir -p "$BACKUP_DIR"

# Проверяем существование БД
if [ -f "$DB_PATH" ]; then
    cp "$DB_PATH" "$BACKUP_DIR/$BACKUP_FILE"
    DB_SIZE=$(du -h "$BACKUP_DIR/$BACKUP_FILE" | cut -f1)
    echo "✅ Бэкап создан: $BACKUP_DIR/$BACKUP_FILE (${DB_SIZE})"
else
    echo "⚠️  База данных не найдена: $DB_PATH (это нормально для первого запуска)"
fi
echo ""

# 3. Получение обновлений из Git
echo "📥 Получение обновлений из Git..."
git pull origin main
echo ""

# 4. Установка зависимостей (если нужно)
echo "📦 Проверка зависимостей..."
if [ -f "package.json" ]; then
    npm install
fi
echo ""

# 4b. Удаление дубликата schema.prisma в корне (если есть — мешает prisma generate)
if [ -f "./schema.prisma" ] && [ -f "./prisma/schema.prisma" ]; then
    rm -f ./schema.prisma
    echo "🗑️  Удалён дубликат schema.prisma из корня"
fi

# 5. Применение миграций базы данных
echo "🔄 Применение миграций базы данных..."
if [ -f "$DB_PATH" ]; then
    # Используем migrate deploy для продакшена (безопасно)
    npx prisma migrate deploy
    echo "✅ Миграции применены успешно"
else
    echo "⚠️  База данных не найдена, миграции будут применены при первом запуске"
fi
echo ""

# 6. Генерация Prisma Client (явный путь — чтобы не подхватить дубликат в корне)
echo "🔨 Генерация Prisma Client..."
npx prisma generate --schema=./prisma/schema.prisma
echo ""

# 7. Перезапуск бота
echo "🔄 Запуск бота..."
pm2 start index.js --name "bot-marzban-vpn" || pm2 restart bot-marzban-vpn
echo ""

# 8. Показать статус
echo "📊 Статус бота:"
pm2 status
echo ""

# 9. Показать последние логи
echo "📋 Последние строки логов (для проверки):"
pm2 logs bot-marzban-vpn --lines 10 --nostream || echo "⚠️  Не удалось получить логи"
echo ""

echo "✅ Обновление завершено успешно!"
echo ""
echo "📝 Важно:"
echo "   - Бэкап сохранен в: $BACKUP_DIR/$BACKUP_FILE"
echo "   - Для просмотра логов: pm2 logs bot-marzban-vpn"
echo "   - Для проверки статуса: pm2 status"
echo ""
echo "💡 Если что-то пошло не так, вы можете:"
echo "   1. Остановить бота: pm2 stop bot-marzban-vpn"
echo "   2. Восстановить БД: cp $BACKUP_DIR/$BACKUP_FILE $DB_PATH"
echo "   3. Откатить код: git reset --hard HEAD~1"
echo "   4. Перезапустить: pm2 start bot-marzban-vpn"
