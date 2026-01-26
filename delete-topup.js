#!/usr/bin/env node
/**
 * Безопасное удаление пополнения (TopUp) из БД.
 * Сначала удаляет связанные ReferralBonus (FK topupId), затем сам TopUp.
 *
 * Использование: node delete-topup.js <id>
 * Пример:       node delete-topup.js 42
 */

require("dotenv").config();
const { prisma } = require("./db");

async function main() {
  const id = parseInt(process.argv[2], 10);
  if (!id || Number.isNaN(id)) {
    console.error("Использование: node delete-topup.js <id>");
    process.exit(1);
  }

  const topup = await prisma.topUp.findUnique({ where: { id } });
  if (!topup) {
    console.error(`Пополнение с ID ${id} не найдено.`);
    process.exit(1);
  }

  const bonuses = await prisma.referralBonus.count({ where: { topupId: id } });
  if (bonuses > 0) {
    await prisma.referralBonus.deleteMany({ where: { topupId: id } });
    console.log(`Удалено реферальных бонусов: ${bonuses}`);
  }

  await prisma.topUp.delete({ where: { id } });
  console.log(`Пополнение #${id} (orderId: ${topup.orderId}, ${topup.amount} ₽) удалено.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
