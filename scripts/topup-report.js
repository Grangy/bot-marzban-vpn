#!/usr/bin/env node
/**
 * Отчёт по пополнениям (TopUp)
 * Использование:
 *   Локально:  node scripts/topup-report.js
 *   С прода:   ssh -i keys/server_key root@93.123.39.210 "cd /opt/bot-marzban-vpn && node scripts/topup-report.js"
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function ruMoney(v) {
  return `${v} ₽`;
}

async function main() {
  const topups = await prisma.topUp.findMany({
    where: { status: "SUCCESS" },
    include: { user: { select: { telegramId: true, accountName: true } } },
    orderBy: { createdAt: "desc" },
  });

  const byStatus = await prisma.topUp.groupBy({
    by: ["status"],
    _count: { id: true },
    _sum: { amount: true },
  });

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(now);
  monthStart.setDate(monthStart.getDate() - 30);

  const todayTopups = topups.filter((t) => new Date(t.createdAt) >= todayStart);
  const weekTopups = topups.filter((t) => new Date(t.createdAt) >= weekStart);
  const monthTopups = topups.filter((t) => new Date(t.createdAt) >= monthStart);

  const totalSum = topups.reduce((s, t) => s + t.amount, 0);
  const totalCredited = topups.filter((t) => t.credited).reduce((s, t) => s + t.amount, 0);

  console.log(`
═══════════════════════════════════════════════════════════════
              ОТЧЁТ ПО ПОПОЛНЕНИЯМ MaxGroot VPN
              ${now.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} МСК
═══════════════════════════════════════════════════════════════

📊 СВОДКА
───────────────────────────────────────────────────────────────
  Всего успешных пополнений:    ${topups.length}
  Общая сумма:                  ${ruMoney(totalSum)}
  Зачислено на баланс:          ${ruMoney(totalCredited)}

  Сегодня:    ${todayTopups.length} шт.  |  ${ruMoney(todayTopups.reduce((s, t) => s + t.amount, 0))}
  За 7 дней:  ${weekTopups.length} шт.  |  ${ruMoney(weekTopups.reduce((s, t) => s + t.amount, 0))}
  За 30 дней: ${monthTopups.length} шт.  |  ${ruMoney(monthTopups.reduce((s, t) => s + t.amount, 0))}

📈 ПО СТАТУСАМ
───────────────────────────────────────────────────────────────`);
  byStatus.forEach((s) => {
    console.log(`  ${s.status}: ${s._count.id} шт. | ${ruMoney(s._sum.amount || 0)}`);
  });

  console.log(`
📋 СПИСОК УСПЕШНЫХ ПОПОЛНЕНИЙ (от новых к старым)
───────────────────────────────────────────────────────────────
  ID  |  Сумма   |  Дата (МСК)           |  Пользователь
───────────────────────────────────────────────────────────────`);

  topups.forEach((t) => {
    const dt = new Date(t.createdAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
    const user = t.user?.accountName || t.user?.telegramId || "—";
    const sumStr = ruMoney(t.amount);
    console.log(`  ${String(t.id).padStart(3)} | ${sumStr.padStart(9)} | ${dt.padEnd(21)} | ${user}`);
  });

  console.log(`
═══════════════════════════════════════════════════════════════
`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
