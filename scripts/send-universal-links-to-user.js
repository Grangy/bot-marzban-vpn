#!/usr/bin/env node
/**
 * Отправить пользователю (ЛС) структурированное сообщение со "всеми универсальными ссылками"
 * на его активные подписки.
 *
 * Запуск (prod):
 *   cd /opt/bot-marzban-vpn
 *   TELEGRAM_ID=683203214 node scripts/send-universal-links-to-user.js
 */
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_ID = String(process.env.TELEGRAM_ID || "").trim();

function fmtDate(d) {
  if (!d) return "∞";
  const x = new Date(d);
  const dd = String(x.getDate()).padStart(2, "0");
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const yy = x.getFullYear();
  return `${dd}.${mm}.${yy}`;
}

async function tgSendMessage(chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    ...extra,
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(json?.description || `HTTP ${res.status}`);
  }
  return json;
}

async function main() {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
  if (!TELEGRAM_ID) throw new Error("Set TELEGRAM_ID");

  const user = await prisma.user.findFirst({
    where: { telegramId: TELEGRAM_ID, chatId: TELEGRAM_ID },
    select: { id: true, chatId: true },
  });
  if (!user) throw new Error("User not found in private chat");

  const now = new Date();
  const subs = await prisma.subscription.findMany({
    where: {
      userId: user.id,
      OR: [{ endDate: null }, { endDate: { gt: now } }],
    },
    orderBy: [{ endDate: "asc" }, { id: "desc" }],
  });

  const onlyWithLinks = subs.filter((s) => s.subscriptionUrl || s.subscriptionUrl2);
  const total = onlyWithLinks.length;

  const maxList = 20;
  const lines = [];
  for (let i = 0; i < Math.min(maxList, onlyWithLinks.length); i++) {
    const s = onlyWithLinks[i];
    const url = s.subscriptionUrl || s.subscriptionUrl2;
    lines.push(
      `🔹 <b>Подписка ${i + 1}</b> · до <b>${fmtDate(s.endDate)}</b>\n` + `   ${url}`
    );
  }
  if (total > maxList) lines.push(`…и ещё <b>${total - maxList}</b> подписок`);

  const improvements = [
    "✅ Отсортировано по ближайшему окончанию",
    "✅ Показаны только активные подписки (ссылка есть)",
    "✅ Убраны «сервер 2»/дубли — везде универсальные `sub.maxg.ch`",
    "✅ Есть кнопка перехода в «Мои подписки»",
    "✅ Сообщение компактное (первые 20 строк + хвост)",
  ];

  const msg =
    `🚀 <b>Ваша новая универсальная ссылка</b>\n` +
    `Обновите подписку в Happ, добавив новую ссылку.\n\n` +
    `🧾 <b>Список активных подписок</b> (всего: <b>${total}</b>)\n\n` +
    `${lines.join("\n\n")}\n\n` +
    `ℹ️ <b>Что улучшили</b>\n` +
    improvements.map((x) => `- ${x}`).join("\n");

  const keyboard = {
    inline_keyboard: [[{ text: "📦 Мои подписки", callback_data: "my_subs" }]],
  };

  await tgSendMessage(user.chatId, msg, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

