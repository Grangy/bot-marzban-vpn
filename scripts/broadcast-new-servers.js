#!/usr/bin/env node
/**
 * Разовая рассылка активным пользователям (ЛС), включая FREE:
 * активный = есть подписка с endDate == null или endDate > now.
 *
 * Запуск на проде:
 *   cd /opt/bot-marzban-vpn
 *   node scripts/broadcast-new-servers.js
 */
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BOT_TOKEN = process.env.BOT_TOKEN;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tgSendMessage(chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    ...extra,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    const desc = json?.description || `HTTP ${res.status}`;
    const err = new Error(desc);
    err._tg = json;
    throw err;
  }
  return json;
}

async function main() {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");

  const now = new Date();

  // Только пользователи из ЛС (chatId == telegramId)
  const users = await prisma.user.findMany({
    where: {
      chatId: { not: "" },
      subscriptions: {
        some: {
          OR: [{ endDate: null }, { endDate: { gt: now } }],
        },
      },
    },
    select: { id: true, telegramId: true, chatId: true },
  });

  const recipients = users.filter((u) => String(u.chatId) === String(u.telegramId));

  const text =
    `🚀 <b>Обновление серверов MaxGroot</b>\n\n` +
    `Мы обновили сервера и улучшили стабильность.\n\n` +
    `✅ <b>Пожалуйста, обновите подписку</b> в разделе <b>«📦 Мои подписки»</b> в боте\n` +
    `или обновите конфигурацию в приложении Happ.\n\n` +
    `Если что-то не работает — пишите в поддержку: @supmaxgroot 🙌`;

  const keyboard = {
    inline_keyboard: [[{ text: "📦 Мои подписки", callback_data: "my_subs" }]],
  };

  const stats = { total: recipients.length, sent: 0, failed: 0 };

  for (const u of recipients) {
    try {
      await tgSendMessage(u.chatId, text, { parse_mode: "HTML", reply_markup: keyboard });
      stats.sent++;
    } catch (e) {
      stats.failed++;
    }
    // Бережный лимит к Telegram
    await sleep(60);
  }

  console.log(JSON.stringify(stats, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

