# Инструкция по откату на сервере до коммита 4780058

## ⚠️ ВНИМАНИЕ
Все изменения после коммита `4780058` будут удалены!

## Способ 1: Использование скрипта (рекомендуется)

1. **Подключитесь к серверу:**
   ```bash
   ssh root@your-server
   ```

2. **Перейдите в директорию проекта:**
   ```bash
   cd /opt/bot-marzban-vpn
   ```

3. **Скачайте скрипт (если его нет):**
   ```bash
   # Скрипт должен быть в репозитории, просто выполните:
   git pull
   chmod +x rollback-to-4780058.sh
   ```

4. **Запустите скрипт:**
   ```bash
   ./rollback-to-4780058.sh
   ```

Скрипт автоматически:
- Остановит бота
- Создаст бэкап БД
- Откатит код до коммита 4780058
- Обновит зависимости
- Применит миграции
- Запустит бота

---

## Способ 2: Ручной откат

Если скрипт не работает, выполните команды вручную:

```bash
# 1. Перейдите в директорию проекта
cd /opt/bot-marzban-vpn

# 2. Остановите бота
pm2 stop bot-marzban-vpn

# 3. Создайте бэкап БД
mkdir -p /opt/bot-marzban-vpn/back
cp prisma/dev.db /opt/bot-marzban-vpn/back/dev.db.backup-rollback-$(date +%Y-%m-%dT%H-%M-%S).db
# Или если БД в корне:
# cp dev.db /opt/bot-marzban-vpn/back/dev.db.backup-rollback-$(date +%Y-%m-%dT%H-%M-%S).db

# 4. Получите последние изменения
git fetch origin

# 5. Откатитесь до коммита 4780058
git reset --hard 4780058c973e5bb6cad2f41d2544f0b7f528fe6a

# 6. Проверьте, что откат прошел
git log --oneline -1
# Должен показать: 4780058 Add Instructions and Menu buttons after promo activation

# 7. Обновите зависимости
npm install

# 8. Примените миграции БД
npx prisma generate
npx prisma migrate deploy

# 9. Запустите бота
pm2 restart bot-marzban-vpn
# Или если бот не был запущен:
# pm2 start index.js --name bot-marzban-vpn

# 10. Проверьте статус
pm2 status bot-marzban-vpn
pm2 logs bot-marzban-vpn --lines 50
```

---

## Проверка после отката

1. **Проверьте коммит:**
   ```bash
   git log --oneline -1
   ```
   Должен быть: `4780058 Add Instructions and Menu buttons after promo activation`

2. **Проверьте логи бота:**
   ```bash
   pm2 logs bot-marzban-vpn --lines 50
   ```

3. **Проверьте, что бот работает:**
   - Отправьте команду `/start` боту
   - Проверьте, что все функции работают

---

## Откат изменений (если что-то пошло не так)

Если нужно вернуться к состоянию до отката:

```bash
cd /opt/bot-marzban-vpn

# Восстановите БД из бэкапа
cp /opt/bot-marzban-vpn/back/dev.db.backup-rollback-*.db prisma/dev.db
# Или:
# cp /opt/bot-marzban-vpn/back/dev.db.backup-rollback-*.db dev.db

# Верните код (если знаете коммит)
git reset --hard <commit-hash>
```

---

## Что было удалено

После отката до `4780058` удалены следующие коммиты:
- `a89b9ff` - Remove fallback payment system, replace maxvpn.live with grangy.ru
- `1413201` - Fix bot freezing on invoice creation: add 8s fetch timeout
- `d8205a2` - Fix callback query timeout errors: add safeAnswerCbQuery
- `01cecbf` - Fix bot crash in groups: use URL button instead of WebApp

Все эти изменения будут удалены из истории Git.
