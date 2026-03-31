#!/usr/bin/env node
/**
 * Массовая рассылка: персональные "универсальные ссылки" всем активным пользователям (ЛС).
 *
 * Активный пользователь = есть хотя бы 1 подписка:
 *   - endDate == null (∞) ИЛИ
 *   - endDate > now
 *
 * По пользователю берём только ЛС (chatId === telegramId).
 *
 * Запуск на проде:
 *   cd /opt/bot-marzban-vpn
 *   DELAY_MS=60 MAX_LIST=20 node scripts/broadcast-universal-links-to-active.js
 */
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BOT_TOKEN = process.env.BOT_TOKEN;
const DELAY_MS = Math.max(20, Number(process.env.DELAY_MS || 60));
const MAX_LIST = Math.max(5, Math.min(30, Number(process.env.MAX_LIST || 20)));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtDate(d) {
  if (!d) return "∞";
  const x = new Date(d);
  const dd = String(x.getDate()).padStart(2, "0");
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const yy = x.getFullYear();
  return `${dd}.${mm}.${yy}`;
}

function isPrivateChatUser(u) {
  return String(u.chatId) === String(u.telegramId);
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

function buildMessage(subs) {
  const withLinks = subs.filter((s) => s.subscriptionUrl || s.subscriptionUrl2);
  const total = withLinks.length;

  // сортировка как в "Мои подписки": ∞ наверху, дальше дальние даты выше
  const now = Date.now();
  const sorted = [...withLinks].sort((a, b) => {
    const aEnd = a.endDate ? new Date(a.endDate).getTime() : Number.POSITIVE_INFINITY;
    const bEnd = b.endDate ? new Date(b.endDate).getTime() : Number.POSITIVE_INFINITY;
    if (aEnd !== bEnd) return bEnd - aEnd;
    return (b.id || 0) - (a.id || 0);
  });

  const lines = [];
  for (let i = 0; i < Math.min(MAX_LIST, sorted.length); i++) {
    const s = sorted[i];
    const url = s.subscriptionUrl || s.subscriptionUrl2;
    const active = !s.endDate || new Date(s.endDate).getTime() > now;
    const statusEmoji = active ? "🟢" : "🔴";
    lines.push(
      `${statusEmoji} <b>Подписка ${i + 1}</b> · до <b>${fmtDate(s.endDate)}</b>\n` + `   ${url}`
    );
  }
  if (total > MAX_LIST) lines.push(`…и ещё <b>${total - MAX_LIST}</b> подписок`);

  const msg =
    `🚀 <b>Ваша новая универсальная ссылка</b>\n` +
    `Обновите подписку в Happ, добавив новую ссылку.\n\n` +
    `🧾 <b>Список активных подписок</b> (всего: <b>${total}</b>)\n\n` +
    `${lines.join("\n\n")}`;

  return { msg, total };
}

async function main() {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

  const now = new Date();
  const users = await prisma.user.findMany({
    where: {
      chatId: { not: "" },
      subscriptions: { some: { OR: [{ endDate: null }, { endDate: { gt: now } }] } },
    },
    select: { id: true, telegramId: true, chatId: true },
  });
  const recipients = users.filter(isPrivateChatUser);

  const keyboard = {
    inline_keyboard: [[{ text: "📦 Мои подписки", callback_data: "my_subs" }]],
  };

  const startedAt = Date.now();
  const stats = { total: recipients.length, sent: 0, failed: 0, skipped: 0 };

  console.log(JSON.stringify({ started: true, ...stats, delayMs: DELAY_MS, maxList: MAX_LIST }, null, 2));

  for (let idx = 0; idx < recipients.length; idx++) {
    const u = recipients[idx];
    try {
      const subs = await prisma.subscription.findMany({
        where: {
          userId: u.id,
          OR: [{ endDate: null }, { endDate: { gt: now } }],
        },
        orderBy: [{ endDate: "asc" }, { id: "desc" }],
      });

      const { msg, total } = buildMessage(subs);
      if (!total) {
        stats.skipped++;
      } else {
        await tgSendMessage(u.chatId, msg, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: keyboard,
        });
        stats.sent++;
      }
    } catch (e) {
      stats.failed++;
    }

    const done = idx + 1;
    if (done % 50 === 0 || done === stats.total) {
      const elapsedMs = Date.now() - startedAt;
      const perSec = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0;
      const remaining = stats.total - done;
      const etaSec = perSec > 0 ? Math.round(remaining / perSec) : null;
      console.log(
        JSON.stringify(
          {
            progress: done,
            ...stats,
            perSec: Number(perSec.toFixed(2)),
            etaSec,
          },
          null,
          2
        )
      );
    }

    await sleep(DELAY_MS);
  }

  console.log(JSON.stringify({ finished: true, ...stats, elapsedSec: Math.round((Date.now() - startedAt) / 1000) }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

