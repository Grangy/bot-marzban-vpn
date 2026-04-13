/**
 * Проверка lead_type + lead_code → один и тот же User.
 * Запуск: npx prisma migrate deploy && node scripts/test-lead-topup-create.js
 */
const { prisma } = require("../db");
const { getOrCreateUserForLead } = require("../lead-identity");

async function main() {
  const suffix = String(Date.now()).slice(-6);
  const leadType = `tst_${suffix}`.slice(0, 32);
  const leadCode = "A1b2C3d";

  const r1 = await getOrCreateUserForLead(prisma, leadType, leadCode);
  const r2 = await getOrCreateUserForLead(prisma, leadType, leadCode.toLowerCase());
  if (!r1.created || r2.created) {
    throw new Error("expected first created=true, second created=false");
  }
  if (r1.user.id !== r2.user.id) {
    throw new Error("same lead should resolve to same user");
  }
  console.log("OK lead user id=%s telegramId=%s", r1.user.id, r1.user.telegramId);

  await prisma.topUp.deleteMany({ where: { userId: r1.user.id } });
  await prisma.leadIdentity.delete({ where: { userId: r1.user.id } });
  await prisma.user.delete({ where: { id: r1.user.id } });
  console.log("OK cleanup");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
