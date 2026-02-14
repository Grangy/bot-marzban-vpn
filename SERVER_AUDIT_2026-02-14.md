# Аудит сервера 93.123.39.210 (14.02.2026)

## Ошибки из логов

### 1. [WEBAPP] Unauthorized request - invalid secret
**Причина:** Web App (web.grangy.ru) отправляет заголовок `X-Webapp-Secret`, который не совпадает с `WEBAPP_SECRET` в `.env` бота.

**Решение:** Убедиться, что в Web App (maxvpn-next / web.grangy.ru) переменная `NEXT_PUBLIC_WEBAPP_SECRET` или аналог совпадает с `WEBAPP_SECRET` в `/opt/bot-marzban-vpn/.env`. Сейчас на боте: `WEBAPP_SECRET=maxgroot_webapp_secret_key_2026`.

---

### 2. [Marzban] Failed to create user — ECONNREFUSED 93.123.39.210:8888
**Причина:** 
- Docker daemon не был запущен → контейнер Marzban не работал
- api-marzban-for-bot использовал внешний IP `https://93.123.39.210:8888` вместо localhost

**Исправлено на сервере:**
1. `systemctl start docker` — запуск Docker
2. `cd /opt/marzban && docker compose up -d` — запуск Marzban
3. В `/opt/api-marzban-for-bot/.env`: `MARZBAN_URL=https://127.0.0.1:8888` (было 93.123.39.210:8888)
4. `pm2 restart api-marzban-for-bot`

**Важно:** Docker может останавливаться при перезагрузке. Проверить:
```bash
systemctl enable docker   # автозапуск
systemctl status docker
docker ps                 # Marzban должен быть running
```

---

### 3. [NO-TRAFFIC REMINDER] Marzban fetch failed
**Причина:** Следствие пункта 2 — Marzban API был недоступен. После запуска Docker и Marzban должно работать.

---

### 4. Google Sheets: Unable to parse range: Лист1!A:K
**Причина:** Название листа в таблице может быть "Sheet1" (английская локаль), а в коде было захардкожено "Лист1".

**Исправлено в коде:** Добавлена переменная `GOOGLE_SHEETS_SHEET_NAME` (по умолчанию "Sheet1").

**На сервере:** Добавить в `.env`:
```
GOOGLE_SHEETS_SHEET_NAME=Sheet1
```
Или если лист называется "Лист1":
```
GOOGLE_SHEETS_SHEET_NAME=Лист1
```

---

## Рекомендации

1. **Docker + Marzban при перезагрузке:**
   ```bash
   systemctl enable docker
   # Добавить в crontab -e или systemd: запуск marzban после docker
   ```

2. **Проверка состояния:**
   ```bash
   pm2 status
   docker ps
   curl -s http://127.0.0.1:3033/ping
   curl -sk https://127.0.0.1:8888/docs | head -5
   ```

3. **WEBAPP_SECRET:** Синхронизировать значение между ботом и Web App.
