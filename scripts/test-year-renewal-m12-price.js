#!/usr/bin/env node
/**
 * Проверка персональной цены M12 по TELEGRAM_ID (ЛС-пользователь).
 *   TELEGRAM_ID=683203214 node scripts/test-year-renewal-m12-price.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { getPlanPrice, ruMoney, PLANS } = require("../menus");

const tid = process.env.TELEGRAM_ID || process.env.ONLY_TELEGRAM_ID;
if (!tid) {
  console.error("Укажите TELEGRAM_ID=...");
  process.exit(1);
}

(async () => {
  const user = await prisma.user.findFirst({
    where: { telegramId: String(tid), chatId: String(tid) },
  });
  if (!user) {
    console.error("User not found (ЛС)");
    process.exit(1);
  }
  const base = PLANS.M12.price;
  const withUser = getPlanPrice("M12", user);
  const without = getPlanPrice("M12", null);
  console.log(
    JSON.stringify(
      {
        telegramId: user.telegramId,
        yearRenewalDiscountEndsAt: user.yearRenewalDiscountEndsAt,
        m12Base: base,
        m12NoPersonal: without,
        m12WithPersonal: withUser,
        display: { base: ruMoney(base), personal: ruMoney(withUser), standard: ruMoney(without) },
      },
      null,
      2
    )
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
