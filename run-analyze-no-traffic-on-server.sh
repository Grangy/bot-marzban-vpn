#!/bin/bash
# Запуск analyze-no-traffic.js на сервере (анализ + рассылка).
# Использование: ./run-analyze-no-traffic-on-server.sh [user@host]
# Если хост не передан — используется DEPLOY_HOST.

set -e
TARGET="${1:-${DEPLOY_HOST:-}}"
DIR="${DEPLOY_DIR:-/opt/bot-marzban-vpn}"

if [ -z "$TARGET" ]; then
  echo "Укажите хост: $0 user@host"
  echo "Либо: DEPLOY_HOST=user@host $0"
  exit 1
fi

echo "▶ Запуск на $TARGET (директория $DIR)..."
ssh "$TARGET" "cd $DIR && git pull origin main && node analyze-no-traffic.js --send"
