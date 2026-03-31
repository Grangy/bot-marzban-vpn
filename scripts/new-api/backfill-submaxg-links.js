#!/usr/bin/env node
/**
 * Backfill: заменить старые ссылки подписок на актуальные Remnawave sub.maxg.ch
 * для всех Subscription где есть remnawaveUuid.
 *
 * Запуск на проде:
 *   cd /opt/bot-marzban-vpn
 *   node scripts/new-api/backfill-submaxg-links.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const { remnawaveGetUser } = require("../../marzban-utils");

function isSubMaxg(url) {
  return typeof url === "string" && url.startsWith("https://sub.maxg.ch/");
}

async function main() {
  const subs = await prisma.subscription.findMany({
    where: { remnawaveUuid: { not: null } },
    select: { id: true, remnawaveUuid: true, subscriptionUrl: true, subscriptionUrl2: true },
  });

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const s of subs) {
    if (isSubMaxg(s.subscriptionUrl) && !s.subscriptionUrl2) {
      skipped++;
      continue;
    }
    try {
      const info = await remnawaveGetUser(s.remnawaveUuid);
      if (!info?.subscriptionUrl) {
        failed++;
        continue;
      }
      await prisma.subscription.update({
        where: { id: s.id },
        data: { subscriptionUrl: info.subscriptionUrl, subscriptionUrl2: null },
      });
      updated++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(JSON.stringify({ total: subs.length, updated, skipped, failed }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

