#!/bin/bash
# update-server.sh - Скрипт для обновления бота на сервере

echo "🚀 Обновление бота на сервере..."

# Остановить PM2 процесс
echo "⏹️ Остановка бота..."
pm2 stop bot-marzban-vpn

# Перейти в директорию проекта
cd /opt/bot-marzban-vpn

# Получить последние изменения
echo "📥 Получение обновлений..."
git pull origin main

# Перезапустить бота
echo "🔄 Перезапуск бота..."
pm2 start index.js --name "bot-marzban-vpn"

# Показать статус
echo "📊 Статус бота:"
pm2 status

echo "✅ Обновление завершено!"
