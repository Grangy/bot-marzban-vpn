# Защита сервера Marzban VPN

## Что сделано

### 1. Anti-malware
- **`/usr/local/bin/anti-malware.sh`** — запускается каждую минуту по cron
- Убивает процессы, обращающиеся к 91.92.243.113 (C2 малвари)
- Удаляет файлы: logic.sh, .b_*, .x, *.kok
- Проверяет crontab на наличие малвари

### 2. Сетевой экран
- **iptables** блокирует 91.92.243.113 (входящие и исходящие)
- Правила сохраняются через `netfilter-persistent`

### 3. SSH
- `PermitRootLogin prohibit-password` — только ключи
- `PasswordAuthentication no`
- `MaxAuthTries 3`
- `X11Forwarding no`

### 4. Fail2ban
- Блокировка на 24ч после 3 неудачных попыток SSH
- Backend: systemd (чтение journal)

### 5. Cron
- Очищен от малвари (x86_64.kok, .update)
- Рабочие задачи: backup, reboot-all, ensure-marzban, anti-malware

---

## Источник заражения — НАЙДЕН

### CVE-2025-66478: RCE в Next.js 15.5.4

**Приложение:** maxvpn-next (Next.js, порт 3000)  
**Версия:** Next.js 15.5.4 — **уязвима**  
**Вектор:** React Server Components (App Router) — crafted HTTP-запросы дают выполнение кода на сервере

**Цепочка:**
1. Злоумышленник отправляет специальный запрос на grangy.ru (Next.js)
2. Уязвимость в RSC позволяет выполнить произвольный код
3. Код качает logic.sh с 91.92.243.113 и запускает майнер
4. next-server (PID 1079) порождает `/bin/sh` → node/curl → малварь

**Подтверждение:** `ps -ef` показывает десятки процессов `sh`, все с PPID=1079 (next-server)

### СРОЧНОЕ исправление

```bash
cd /opt/maxvpn-next
npm install next@15.5.9
pm2 restart maxvpn-next
```

Или использовать `npx fix-react2shell-next` (официальный инструмент Vercel).

После обновления — сменить все секреты (TELEGRAM_BOT_TOKEN, API keys и т.д.).

---

## Profile / .bashrc — заражение

Малварь добавляла в `/etc/profile` и `/root/.bashrc` строки запуска x86_64.kok. Это вызывало ошибки при входе по SSH. Очищено. Anti-malware теперь проверяет эти файлы.

## Защита от возрождения малвари

1. **anti-malware.sh** — каждую минуту (cron) + каждые 30 сек (systemd timer)
2. **iptables** — C2 (91.92.243.113) и сканеры (204.76.203.18, 102.244.97.183) заблокированы
3. **Crontab backup** — `/root/.crontab.good` — при появлении малвари в cron восстанавливается чистый
4. **Next.js 15.5.9** — RCE закрыта, новый вход невозможен

## Команды для проверки

```bash
# Малварь ещё работает?
ps aux | grep 91.92 | grep -v grep   # пусто = ок
ls /tmp/.b* 2>/dev/null              # пусто = ок

# Защита включена?
systemctl is-active anti-malware.timer   # active
crontab -l | grep anti-malware           # есть
iptables -L -n | grep 91.92              # DROP

# Docker и Marzban
systemctl status docker
ss -tlnp | grep 8888

# Лог anti-malware (если срабатывал)
tail /var/log/anti-malware.log
```

---

## Отчёт по пополнениям

**Скрипт:** `scripts/topup-report.js`

**Локально (локальная БД):**
```bash
node scripts/topup-report.js
```

**С прода (свежие данные):**
```bash
ssh -i keys/server_key root@93.123.39.210 "cd /opt/bot-marzban-vpn && node scripts/topup-report.js"
```

### Последний отчёт (локальная БД, данные на 18.01.2026)

| Показатель | Значение |
|------------|----------|
| Успешных пополнений | 44 |
| Общая сумма | 11 320 ₽ |
| FAILED | 55 шт. (16 670 ₽) |
| TIMEOUT | 4 шт. (400 ₽) |

*Для актуальных данных запусти скрипт на проде.*

---

## Доступы (ключи SSH)

| Ключ | Назначение |
|------|------------|
| `keys/server_key` | Основной сервер 93.123.39.210 (grangy.ru) |
| `~/.ssh/ru-1_key` | ru-1 (возможно Yandex Cloud / РФ) |
| `~/.ssh/shared_server_key` | Shared server |

**Эстония:** В проекте и конфигах SSH не найдено упоминаний Эстонии, эстонских хостов или ключей с суффиксом `est`/`ee`. Серверы в коде: 93.123.39.210, 51.250.72.185 (Yandex Cloud), rus2.grangy.ru. Если доступы от Эстонии хранятся отдельно — проверь парольный менеджер, заметки или другие проекты.

---

## Подключение к серверу

```bash
ssh -i keys/server_key root@93.123.39.210
```
