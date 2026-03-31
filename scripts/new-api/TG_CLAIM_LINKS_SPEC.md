# ТЗ для сайта: Telegram‑ссылки для привязки trial (Variant A)

## Цель
Сайт должен выдавать пользователю ссылку, по которой Telegram‑бот сможет **найти подписку в Remnawave по username** и привязать её к Telegram ID.

## 1) Требование к username
- Сайт при выдаче trial **создаёт пользователя в Remnawave**.
- `username` должен быть:
  - **уникальным**
  - **непредсказуемым** (включать достаточную случайность/энтропию), чтобы по нему нельзя было угадать чужую подписку.

Рекомендуемый формат:
- `trial_<random>` где `<random>` — минимум 12–16 символов base32/base64url/hex.
  - пример: `trial_dd3f4f2251f2`

## 2) Генерация TG deep link
Сайт формирует ссылку:

`https://t.me/maxvpn_offbot?start=hp_claim_<USERNAME>`

Где `<USERNAME>` — **ровно тот же username**, который был создан в Remnawave.

Пример:
- Remnawave username: `trial_dd3f4f2251f2`
- Telegram link: `https://t.me/maxvpn_offbot?start=hp_claim_trial_dd3f4f2251f2`

## 3) Поведение со стороны бота (для справки)
Бот при открытии ссылки:
- делает `GET https://api.maxg.ch/v1/users/<USERNAME>` (с ретраями)
- берёт `uuid`
- делает `PATCH /v1/users/<uuid>/telegram` (telegramId + username)
- делает `PATCH /v1/users/<uuid>/traffic-bonus` (+1GB)

## 4) UX‑текст на сайте (рекомендация)
Достаточно одной инструкции:
- «Нажмите кнопку “Открыть в Telegram”, чтобы привязать подписку и получить бонус».

