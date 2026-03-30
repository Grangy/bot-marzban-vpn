# Remnawave API Deployment on Panel Server (RZ)

## Server and access

- Panel server: `195.62.49.5`
- SSH user: `admin`
- Connect:
  - `ssh admin@195.62.49.5`

## Deployment path

- Project path on server: `/opt/remnawave-api`
- PM2 process name: `remnawave-api`
- Start command: `npm run start:api`

## Production environment (.env on server)

File: `/opt/remnawave-api/.env`

```env
REMNAWAVE_PANEL_URL=https://panel.maxg.ch
REMNAWAVE_API_TOKEN=<JWT_FROM_PANEL_ENV>
API_ACCESS_KEY=<API_ACCESS_KEY>
API_HOST=0.0.0.0
API_PORT=7070
LOG_LEVEL=info
API_TIMEOUT=30000
CACHE_TTL=60
```

## PM2 setup

Executed:

```bash
cd /opt/remnawave-api
npm install --omit=dev
pm2 start npm --name remnawave-api -- run start:api
pm2 save
```

Useful commands:

```bash
pm2 status
pm2 logs remnawave-api --lines 100
pm2 restart remnawave-api
pm2 stop remnawave-api
pm2 delete remnawave-api
```

## Firewall (UFW)

Сейчас внешний доступ на `7070/tcp` закрыт.
API публикуется только через nginx на `80/443` (домен `api.maxg.ch`).

```bash
sudo ufw status
```

## API addresses

- From server (local): `http://127.0.0.1:7070/v1`
- External direct access: `https://api.maxg.ch/v1`
- Health endpoint: `https://api.maxg.ch/health`

## Authorization for Telegram bot

Use one of headers:

- `x-api-key: <API_ACCESS_KEY>`
- `Authorization: Bearer <API_ACCESS_KEY>`

## Check commands

### On server

```bash
curl -sS http://127.0.0.1:7070/health
curl -sS -H "x-api-key: <API_ACCESS_KEY>" \
  http://127.0.0.1:7070/v1/users/nonexistent-user
```

### From local machine

```bash
curl -sS https://api.maxg.ch/health
```

## Telegram bot quick examples

Create user:

```bash
curl -X POST "https://api.maxg.ch/v1/users" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_ACCESS_KEY>" \
  -d '{"username":"tg_user_1","days":30,"gb":50,"subscriptionType":"russia","deviceLimit":3}'
```

Extend:

```bash
curl -X PATCH "https://api.maxg.ch/v1/users/<uuid>/extend" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_ACCESS_KEY>" \
  -d '{"days":7}'
```

## Все HTTP-запросы (для Telegram-бота)

Базовый URL:

- `https://api.maxg.ch`
- `http://127.0.0.1:7070` (если бот/скрипт запущен на этом же сервере)

Авторизация (для всех эндпоинтов кроме `/health`):

- `x-api-key: <API_ACCESS_KEY>` или `Authorization: Bearer <API_ACCESS_KEY>`

### Health

`GET /health` (без ключа)

```bash
curl -sS https://api.maxg.ch/health
```

Ответ (200):

```json
{ "ok": true }
```

### Создать пользователя (создать подписку)

`POST /v1/users`

Тело (JSON):

- `username` (строка)
- `days` (число, необязательное, по умолчанию `365`)
- `gb` (число, необязательное, по умолчанию `0`)
- `subscriptionType` (необязательное: `basic` или `russia`)
- `deviceLimit` (необязательное: число >= 0 или `null`; если не задавать, будет fallback из Panel)

Пример:

```bash
curl -X POST "https://api.maxg.ch/v1/users" \
  -H "Content-Type: application/json" \
  -H "x-api-key: 7b72c3cbf19a88d3466f5169d1a8cd5906499546b7227be3ecf4076da188aeef" \
  -d '{"username":"tg_user_1","days":30,"gb":50,"subscriptionType":"russia","deviceLimit":3}'
```

Ответ (201):

```json
{ "ok": true, "user": { "...": "..." } }
```

### Получить пользователя

`GET /v1/users/:idOrUsername` где `:idOrUsername` может быть:

- `uuid`
- `username`

Пример:

```bash
curl -sS \
  -H "x-api-key: <API_ACCESS_KEY>" \
  "https://api.maxg.ch/v1/users/<uuid-or-username>"
```

Ответ (200):

```json
{ "ok": true, "user": { "...": "..." } }
```

Если пользователя нет (404):

```json
{ "ok": false, "error": "User not found: <idOrUsername>" }
```

### Продлить подписку

`PATCH /v1/users/:id/extend`

Тело:

- `days` (число, обязательное)

Пример:

```bash
curl -X PATCH "https://api.maxg.ch/v1/users/<uuid>/extend" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_ACCESS_KEY>" \
  -d '{"days":7}'
```

Ответ (200):

```json
{ "ok": true, "user": { "...": "..." } }
```

### Сменить subscriptionType

`PATCH /v1/users/:id/subscription-type`

Тело:

- `subscriptionType` (`basic` или `russia`, обязательное)

Пример:

```bash
curl -X PATCH "https://api.maxg.ch/v1/users/<uuid>/subscription-type" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_ACCESS_KEY>" \
  -d '{"subscriptionType":"basic"}'
```

### Сменить device limit

`PATCH /v1/users/:id/device-limit`

Тело:

- `deviceLimit` (число >= 0 или `null`)

Важно:

- чтобы вернуть режим “unlimited/fallback” — отправляй `deviceLimit: null`
- если отправить `0`, то это будет лимит 0 устройств (не unlimited)

Пример (вернуть fallback/unlimited):

```bash
curl -X PATCH "https://api.maxg.ch/v1/users/<uuid>/device-limit" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_ACCESS_KEY>" \
  -d '{"deviceLimit":null}'
```

Пример (поставить лимит 3):

```bash
curl -X PATCH "https://api.maxg.ch/v1/users/<uuid>/device-limit" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_ACCESS_KEY>" \
  -d '{"deviceLimit":3}'
```

### Удалить пользователя

`DELETE /v1/users/:id`

Пример:

```bash
curl -X DELETE "https://api.maxg.ch/v1/users/<uuid>" \
  -H "x-api-key: <API_ACCESS_KEY>"
```

Ответ (200):

```json
{ "ok": true, "deleted": true }
```

### Ошибки авторизации/маршрута

- `401 Unauthorized` (если ключ не передан/не верный): `{"ok": false, "error": "Unauthorized", "hint": "Use x-api-key header or Authorization: Bearer <API_ACCESS_KEY>"}`
- `404 Not found` (если endpoint не существует): `{"ok": false, "error": "Not found"}`

## Что можно делать с Marzban (реально существующие возможности)

Текущий HTTP API (`server.js`) предназначен для управления **Users/подписками** через Remnawave Panel.
Команды, которые реально трогают ноды/Marzban, доступны **через CLI**, а не через HTTP.

На панели (SSH):

```bash
ssh admin@195.62.49.5
cd /opt/remnawave-api
```

1) Показать ноды (включая ту, где работает Marzban):

```bash
node src/cli.js nodes:list
```

2) Перезапустить конкретную ноду (в Panel дернется действие restart node; на практике это затрагивает Marzban-процесс на ноде):

```bash
node src/cli.js nodes:restart <uuid>
```

3) Подготовить/создать internal squads (один раз при разворачивании):

```bash
node src/cli.js squads:setup
```

## Update/redeploy procedure

```bash
# Local machine
rsync -az --delete --exclude node_modules --exclude .env /Users/maksim/servers/api/ admin@195.62.49.5:/opt/remnawave-api/

# Server
ssh admin@195.62.49.5
cd /opt/remnawave-api
npm install --omit=dev
pm2 restart remnawave-api
pm2 save
```

---

## Telegram-бот (`bot-marzban-vpn`)

Если заданы **оба** параметра, создание и продление идут через Remnawave вместо основного Marzban (`MARZBAN_API_URL`):

```env
REMNAWAVE_API_URL=https://api.maxg.ch
REMNAWAVE_API_KEY=<API_ACCESS_KEY из .env remnawave-api, не JWT>
REMNAWAVE_SUBSCRIPTION_TYPE=russia
# опционально: REMNAWAVE_DEVICE_LIMIT=3
```

Второй сервер (rus2 / `MARZBAN_API_URL_2`) при необходимости по-прежнему создаётся через Marzban.

После обновления кода на сервере бота применить миграцию Prisma (поле `Subscription.remnawaveUuid` — UUID для `PATCH /v1/users/:uuid/extend`; lookup `GET /v1/users/:username` на API может быть недоступен).

```bash
cd /opt/bot-marzban-vpn && npx prisma migrate deploy
```

Проверка API с машины разработчика:

```bash
node scripts/new-api/verify-remnawave.js
# полный цикл create+extend (создаёт тестового пользователя):
REMNAWAVE_TEST_USER=my_test_user node scripts/new-api/verify-remnawave.js --mutate
```

