#!/usr/bin/env node
/**
 * Безопасное удаление админского промокода (AdminPromo) из БД.
 * Сначала удаляет связанные AdminPromoActivation (FK promoId), затем сам AdminPromo.
 *
 * Использование: node delete-promo.js <id> [id2 id3 ...]
 * Пример:        node delete-promo.js 1
 * Пример:        node delete-promo.js 1 2 3
 */

require("dotenv").config();
const { prisma } = require("./db");

async function main() {
  const ids = process.argv.slice(2).map((s) => parseInt(s, 10)).filter((n) => n && !Number.isNaN(n));
  if (ids.length === 0) {
    console.error("Использование: node delete-promo.js <id> [id2 id3 ...]");
    process.exit(1);
  }

  for (const id of ids) {
    const promo = await prisma.adminPromo.findUnique({ where: { id } });
    if (!promo) {
      console.error(`Промокод с ID ${id} не найден.`);
      continue;
    }

    const activations = await prisma.adminPromoActivation.count({ where: { promoId: id } });
    if (activations > 0) {
      await prisma.adminPromoActivation.deleteMany({ where: { promoId: id } });
      console.log(`  Удалено активаций: ${activations}`);
    }

    await prisma.adminPromo.delete({ where: { id } });
    console.log(`Промокод #${id} (${promo.code}) удалён.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
