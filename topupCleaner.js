const bus = require("./events");
const { prisma } = require("./db");

function startTopupCleaner() {
  const EXPIRATION_MS = 3 * 60 * 1000;

  setInterval(async () => {
    const threshold = new Date(Date.now() - EXPIRATION_MS);

    // Находим все PENDING, которые устарели
    const expired = await prisma.topUp.findMany({
      where: { status: "PENDING", createdAt: { lt: threshold } },
    });

    if (expired.length > 0) {
      for (const t of expired) {
        await prisma.topUp.update({
          where: { id: t.id },
          data: { status: "TIMEOUT" },
        });

        // шлём событие для notifier
        bus.emit("topup.timeout", { topupId: t.id });
      }

      console.log(`⏳ Closed and notified ${expired.length} expired topups`);
    }
  }, 60 * 1000); // проверка раз в минуту
}

module.exports = { startTopupCleaner };
