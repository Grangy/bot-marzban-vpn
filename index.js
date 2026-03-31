require("dotenv").config();
const { bot } = require("./bot");
const { prepareSqliteForLoad, prisma } = require("./db");
const { createServer } = require("./server");
const { initNotifier } = require("./notifier");
const { startTopupCleaner } = require("./topupCleaner");
const { startSubExpiryNotifier } = require("./subExpiryNotifier");
const { startBackupScheduler } = require("./backup");
const { startNoTrafficReminder } = require("./no-traffic-reminder");
const { startExtendReminder12h } = require("./extend-reminder-12h");
const { initAdminNotifier } = require("./admin-notifier");
const { initBroadcast } = require("./broadcast");


const PORT = process.env.PAYMENT_PORT || 4000;

(async () => {
  try {
    console.log("⚙️  Preparing database...");
    await prepareSqliteForLoad();
    startTopupCleaner(); // 👈 запускаем автоистечение
    startSubExpiryNotifier(bot);   // запускаем сканер подписок
    startBackupScheduler(); // 👈 запускаем планировщик бэкапов
    startNoTrafficReminder(bot);   // 👈 через 2ч после покупки, если нет трафика — напоминание
    startExtendReminder12h(bot);   // 👈 через 12ч после привязки FREE/trial — напоминание о продлении
    // Сервер поднимаем сразу
    console.log("🌐 Starting payment server...");
    const app = createServer();
    app.listen(PORT, () => {
      console.log(`✅ Payment server listening on http://localhost:${PORT}`);
    });

    // Подключаем нотификатор к событиям оплаты
    initNotifier(bot);
    
    // Подключаем админ-нотификатор (уведомления в группу)
    initAdminNotifier(bot);
    
    // Инициализируем систему реферальных бонусов
    const { initReferralBonus } = require("./referral-bonus");
    initReferralBonus(bot);

    // Инициализируем модуль рассылок СРАЗУ (бот уже создан, просто еще не запущен)
    initBroadcast(bot);
    console.log("✅ Broadcast module initialized");

    // Бот — асинхронно с таймаутом
    console.log("🤖 Launching Telegram bot...");
(async () => {
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log("✅ Bot started and polling updates");
  } catch (err) {
    console.error("❌ Bot launch failed:", err.message);
  }
})();

    console.log("🚀 All systems initialization triggered!");
  } catch (err) {
    console.error("❌ Failed to start app:", err);
    process.exit(1);
  }
})();

const shutdown = async (signal) => {
  try {
    console.log(`🛑 Stopping on ${signal}...`);
    await bot.stop(signal);
    await prisma.$disconnect();
    console.log("✅ Graceful shutdown complete");
    process.exit(0);
  } catch (e) {
    console.error("❌ Shutdown error:", e);
    process.exit(1);
  }
};

// Глобальная обработка необработанных ошибок
process.on("unhandledRejection", (reason, promise) => {
  console.error("[UNHANDLED REJECTION] Unhandled Promise Rejection:", reason);
  console.error("[UNHANDLED REJECTION] Promise:", promise);
  // Не завершаем процесс - продолжаем работу
});

process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT EXCEPTION] Uncaught Exception:", error);
  console.error("[UNCAUGHT EXCEPTION] Stack:", error.stack);
  // Не завершаем процесс - продолжаем работу
  // В критических случаях можно перезапустить через PM2
});

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
