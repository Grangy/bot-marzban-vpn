# Remnawave API — туториал для прод‑бота

Этот файл описывает, как подключить Telegram‑бот (`bot-marzban-vpn`) к нашей Remnawave HTTP API, как проверить создание/продление подписок и что делать при ошибках.

## 1) Что где работает

- **Бот (prod)**: `93.123.39.210`, путь `/opt/bot-marzban-vpn`, процесс `pm2` — `bot-marzban-vpn`
- **Remnawave API (наружу)**: `https://api.maxg.ch`
- **Health endpoint**: `GET https://api.maxg.ch/health`

## 2) Ключи и где их взять

В Remnawave API используется **API access key** (не JWT панели).

- **Нужен ключ**: `<API_ACCESS_KEY>`
- **Где лежит на сервере API**: в `.env` деплоя Remnawave (`API_ACCESS_KEY=...`)
- **Важно**: не хранить ключи в Git/markdown — только в `.env` на сервере.

## 3) Настройка `.env` на сервере бота

Файл: `/opt/bot-marzban-vpn/.env`

Открой и отредактируй:

```bash
ssh -i keys/server_key root@93.123.39.210
cd /opt/bot-marzban-vpn
nano .env
```

Минимально для Remnawave:

```env
REMNAWAVE_API_URL=https://api.maxg.ch
# можно указывать любым из двух имён (код читает оба):
REMNAWAVE_API_KEY=<API_ACCESS_KEY>
# или:
API_ACCESS_KEY=<API_ACCESS_KEY>

# optional: basic | russia
REMNAWAVE_SUBSCRIPTION_TYPE=russia
```

### Сервер 2 (rus2)

**Новые ссылки сервера 2 больше не формируются.**  
Старые `subscriptionUrl2` остаются в БД и могут отображаться.

Если когда‑нибудь нужно вернуть (не рекомендуется):

```env
ENABLE_SERVER2=true
MARZBAN_API_URL_2=<URL>
MARZBAN_TOKEN_2=<TOKEN>
```

## 4) Проверка Remnawave API с сервера бота

### Быстрый health‑check

```bash
curl -sS https://api.maxg.ch/health
```

Ожидаемый ответ:

```json
{ "ok": true }
```

### Проверка авторизации и “создать + продлить” через наш скрипт

Скрипт: `scripts/new-api/verify-remnawave.js`

```bash
cd /opt/bot-marzban-vpn

# 1) без изменений данных (health + 404 на отсутствующем юзере)
node scripts/new-api/verify-remnawave.js

# 2) полный тест: создаёт тест‑пользователя и пробует продлить
REMNAWAVE_TEST_USER=prod_verify_$(date +%s) node scripts/new-api/verify-remnawave.js --mutate
```

## 5) Деплой изменений бота на прод

```bash
ssh -i keys/server_key root@93.123.39.210
cd /opt/bot-marzban-vpn

git pull origin main
npm install --omit=dev

npx prisma migrate deploy
npx prisma generate

pm2 restart bot-marzban-vpn
pm2 logs bot-marzban-vpn --lines 200
```

## 6) Типичные проблемы и что делать

### 502 Bad Gateway от `api.maxg.ch`

Обычно это nginx/бэкенд Remnawave. Проверить:

- `curl -v https://api.maxg.ch/health`
- доступность порта/бэкенда на сервере API (pm2/сервис)

### Timeout / `ETIMEDOUT` при запросе к `api.maxg.ch`

Проверить:

- сетевую доступность домена с сервера бота: `curl -v https://api.maxg.ch/health`
- DNS/маршрутизацию/файрвол/внешний доступ

### Продление сразу после создания иногда даёт 404

Это лаг синхронизации. В коде продления уже есть ретраи.  
Если в логах видишь `User not found` при `PATCH /extend`, подожди и повтори — должно пройти.

