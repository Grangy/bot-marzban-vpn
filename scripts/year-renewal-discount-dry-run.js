#!/usr/bin/env node
/**
 * Срок персональной скидки на год (M12 −20%): в боте она активна, пока yearRenewalDiscountEndsAt > now.
 * После истечения даты цены сами обычные; поле в БД остаётся, пока его не обнулить отдельно.
 *
 * Статистика (по умолчанию):
 *   node scripts/year-renewal-discount-dry-run.js
 *
 * «Как будто сейчас» другая дата (проверка «что будет после акции»):
 *   FAKE_NOW_ISO=2026-04-20T12:00:00Z node scripts/year-renewal-discount-dry-run.js
 *
 * Dry-run: сколько записей обнулили бы как просроченные (endsAt <= now):
 *   DRY_RUN=1 node scripts/year-renewal-discount-dry-run.js clear
 *
 * Реально обнулить только просроченные (endsAt <= now, поле станет NULL):
 *   DRY_RUN=0 node scripts/year-renewal-discount-dry-run.js clear
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function clock() {
  const raw = process.env.FAKE_NOW_ISO;
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    console.error("Invalid FAKE_NOW_ISO:", raw);
    process.exit(1);
  }
  return d;
}

async function stats() {
  const now = clock();
  const totalUsers = await prisma.user.count();
  const withEndsAt = await prisma.user.count({
    where: { yearRenewalDiscountEndsAt: { not: null } },
  });
  const active = await prisma.user.count({
    where: { yearRenewalDiscountEndsAt: { gt: now } },
  });
  const expired = await prisma.user.count({
    where: {
      yearRenewalDiscountEndsAt: { not: null, lte: now },
    },
  });

  console.log(
    JSON.stringify(
      {
        explanation:
          "Скидка в UI/ценах отключается сама, когда endsAt <= now. Очистка БД (clear) — опционально.",
        simulatedNow: process.env.FAKE_NOW_ISO ? now.toISOString() : now.toISOString(),
        fakeNow: Boolean(process.env.FAKE_NOW_ISO),
        totalUsers,
        rowsWithYearRenewalEndsAt: withEndsAt,
        discountActiveForPricing: active,
        discountExpiredButFieldStillSet: expired,
      },
      null,
      2
    )
  );
}

async function clearExpired() {
  const now = clock();
  const dry =
    process.env.DRY_RUN === "1" ||
    process.env.DRY_RUN === "true" ||
    process.argv.includes("--dry");

  const where = {
    yearRenewalDiscountEndsAt: { not: null, lte: now },
  };
  const count = await prisma.user.count({ where });

  if (dry) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          wouldSetNull: count,
          thresholdLte: now.toISOString(),
          hint: "Запустите без DRY_RUN=1 и с DRY_RUN=0 для реального обнуления просроченных.",
        },
        null,
        2
      )
    );
    return;
  }

  const r = await prisma.user.updateMany({
    where,
    data: { yearRenewalDiscountEndsAt: null },
  });
  console.log(
    JSON.stringify(
      {
        dryRun: false,
        nulledRows: r.count,
        thresholdLte: now.toISOString(),
      },
      null,
      2
    )
  );
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "clear") await clearExpired();
  else await stats();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
