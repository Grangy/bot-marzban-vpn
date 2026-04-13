#!/usr/bin/env node
/**
 * Personal -20% on M12 for 3 days. Audience: private chats with active short subscription.
 * Sets user.yearRenewalDiscountEndsAt before send.
 *
 *   DELAY_MS=80 node scripts/broadcast-year-renewal-discount.js
 *   ONLY_TELEGRAM_ID=123 ...
 *   DRY_RUN=1 ...
 */
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { getPlanPrice, ruMoney, PERSONAL_YEAR_RENEW_PERCENT, PLANS } = require("../menus");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = (process.env.ADMIN_GROUP_ID || "").split(",")[0]?.trim();
const DELAY_MS = Math.max(30, Number(process.env.DELAY_MS || 80));
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const ONLY_TELEGRAM_ID = process.env.ONLY_TELEGRAM_ID ? String(process.env.ONLY_TELEGRAM_ID).trim() : null;

const SHORT_TYPES = ["FREE", "D7", "M1", "PROMO_10D"];
const DURATION_MS = 3 * 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPrivateChatUser(u) {
  return String(u.chatId) === String(u.telegramId);
}

function fmtEndMsk(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function tgSendMessage(chatId, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
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

async function sendAdminReport(html) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.warn("[BROADCAST-YR] ADMIN report skipped: BOT_TOKEN or ADMIN_GROUP_ID");
    return;
  }
  await tgSendMessage(ADMIN_CHAT_ID, html);
}

function buildMessage(until) {
  const fakeUser = { yearRenewalDiscountEndsAt: until };
  const salePrice = getPlanPrice("M12", fakeUser);
  const basePrice = PLANS.M12.price;
  const endLine = fmtEndMsk(until);
  const minus = "\u2212";

  return (
    "\u2728 <b>\u041f\u0435\u0440\u0441\u043e\u043d\u0430\u043b\u044c\u043d\u0430\u044f \u0430\u043a\u0446\u0438\u044f</b>\n\n" +
    `\u0412\u044b \u043d\u0430 \u043a\u043e\u0440\u043e\u0442\u043a\u043e\u043c \u0442\u0430\u0440\u0438\u0444\u0435 (\u0434\u043e \u043c\u0435\u0441\u044f\u0446\u0430) \u2014 \u0434\u0430\u0440\u0438\u043c <b>${minus}${PERSONAL_YEAR_RENEW_PERCENT}%</b> ` +
    `\u043d\u0430 \u043e\u043f\u043b\u0430\u0442\u0443 <b>\u0433\u043e\u0434\u0430</b> (12 \u043c\u0435\u0441\u044f\u0446\u0435\u0432).\n\n` +
    `\uD83D\uDCB0 <b>\u0412\u0430\u0448\u0430 \u0446\u0435\u043d\u0430 \u043d\u0430 \u0433\u043e\u0434:</b> ${ruMoney(salePrice)} <i>\u0432\u043c\u0435\u0441\u0442\u043e</i> ${ruMoney(basePrice)}\n\n` +
    `\u23F0 <b>\u0410\u043a\u0446\u0438\u044f 3 \u0434\u043d\u044f</b> (\u0434\u043e <b>${endLine} \u041c\u0421\u041a</b>). ` +
    `\u0421\u043a\u0438\u0434\u043a\u0430 \u0442\u043e\u043b\u044c\u043a\u043e \u0434\u043b\u044f <b>\u0432\u0430\u0448\u0435\u0433\u043e \u0430\u043a\u043a\u0430\u0443\u043d\u0442\u0430</b> \u0438 \u0442\u043e\u043b\u044c\u043a\u043e \u043d\u0430 \u00AB12 \u043c\u0435\u0441\u044f\u0446\u0435\u0432\u00BB.\n\n` +
    "\u2728 \u041e\u0442\u043a\u0440\u043e\u0439\u0442\u0435 \u00AB\u041a\u0443\u043f\u0438\u0442\u044c \u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0443\u00BB \u2014 \u0441\u0442\u0440\u043e\u043a\u0430 \u00AB12 \u043c\u0435\u0441\u044f\u0446\u0435\u0432\u00BB \u0443\u0436\u0435 \u0441 \u0432\u0430\u0448\u0435\u0439 \u0446\u0435\u043d\u043e\u0439. " +
    "\u0418\u043b\u0438 \u00AB\u041c\u043e\u0438 \u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0438\u00BB \u2192 \u00AB\u041f\u0440\u043e\u0434\u043b\u0438\u0442\u044c\u00BB \u0438 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0433\u043e\u0434."
  );
}

function buildKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "\uD83D\uDCB3 \u041a\u0443\u043f\u0438\u0442\u044c \u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0443",
          callback_data: "buy",
        },
      ],
      [
        {
          text: "\uD83D\uDCE6 \u041c\u043e\u0438 \u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0438",
          callback_data: "my_subs",
        },
      ],
    ],
  };
}

async function main() {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

  const now = new Date();
  const until = new Date(now.getTime() + DURATION_MS);
  const messageText = buildMessage(until);

  const whereSubs = {
    subscriptions: {
      some: {
        type: { in: SHORT_TYPES },
        OR: [{ endDate: null }, { endDate: { gt: now } }],
      },
    },
  };

  const users = await prisma.user.findMany({
    where: ONLY_TELEGRAM_ID
      ? { ...whereSubs, telegramId: ONLY_TELEGRAM_ID }
      : { chatId: { not: "" }, ...whereSubs },
    select: { id: true, telegramId: true, chatId: true },
  });

  const recipients = users.filter(isPrivateChatUser);
  const stats = {
    dryRun: DRY_RUN,
    onlyTelegramId: ONLY_TELEGRAM_ID,
    candidates: users.length,
    recipients: recipients.length,
    updated: 0,
    sent: 0,
    failed: 0,
    untilIso: until.toISOString(),
  };

  console.log(JSON.stringify({ started: true, ...stats, delayMs: DELAY_MS }, null, 2));

  if (!DRY_RUN && recipients.length > 0) {
    const upd = await prisma.user.updateMany({
      where: { id: { in: recipients.map((r) => r.id) } },
      data: { yearRenewalDiscountEndsAt: until },
    });
    stats.updated = upd.count;
  }

  for (let i = 0; i < recipients.length; i++) {
    const u = recipients[i];
    if (DRY_RUN) {
      await sleep(DELAY_MS);
      continue;
    }
    try {
      await tgSendMessage(u.chatId, messageText, buildKeyboard());
      stats.sent++;
    } catch (e) {
      stats.failed++;
      console.warn(`[BROADCAST-YR] fail userId=${u.id} tg=${u.telegramId}:`, e.message);
    }
    if ((i + 1) % 25 === 0 || i + 1 === recipients.length) {
      console.log(JSON.stringify({ progress: i + 1, ...stats }, null, 2));
    }
    await sleep(DELAY_MS);
  }

  const report =
    "\uD83D\uDCCA <b>\u0420\u0430\u0441\u0441\u044b\u043b\u043a\u0430: \u0441\u043a\u0438\u0434\u043a\u0430 \u043d\u0430 \u0433\u043e\u0434</b>\n\n" +
    `\u2212${PERSONAL_YEAR_RENEW_PERCENT}% \u043d\u0430 M12, \u0441\u0440\u043e\u043a 3 \u0434\u043d\u044f (\u0434\u043e <code>${until.toISOString()}</code>)\n\n` +
    `\u041a\u0430\u043d\u0434\u0438\u0434\u0430\u0442\u043e\u0432: <b>${stats.candidates}</b>\n` +
    `\u041b\u0421-\u043f\u043e\u043b\u0443\u0447\u0430\u0442\u0435\u043b\u0435\u0439: <b>${stats.recipients}</b>\n` +
    `\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u043e: <b>${stats.updated}</b>\n` +
    `\u041e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e: <b>${stats.sent}</b>\n` +
    `\u041e\u0448\u0438\u0431\u043e\u043a: <b>${stats.failed}</b>\n` +
    `DRY_RUN: <b>${stats.dryRun ? "\u0434\u0430" : "\u043d\u0435\u0442"}</b>\n` +
    (stats.onlyTelegramId ? `ONLY_TELEGRAM_ID: <code>${stats.onlyTelegramId}</code>\n` : "");

  await sendAdminReport(report);
  console.log(JSON.stringify({ finished: true, ...stats }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
