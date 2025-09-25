require("dotenv").config();
const { bot } = require("./bot");
const { prepareSqliteForLoad, prisma } = require("./db");
const { createServer } = require("./server");
const { initNotifier } = require("./notifier");
const { startTopupCleaner } = require("./topupCleaner");
const { startSubExpiryNotifier } = require("./subExpiryNotifier");


const PORT = process.env.PAYMENT_PORT || 4000;

(async () => {
  try {
    console.log("⚙️  Preparing database...");
    await prepareSqliteForLoad();
    startTopupCleaner(); // 👈 запускаем автоистечение
    startSubExpiryNotifier(bot);   // запускаем сканер подписок
    // Сервер поднимаем сразу
    console.log("🌐 Starting payment server...");
    const app = createServer();
    app.listen(PORT, () => {
      console.log(`✅ Payment server listening on http://localhost:${PORT}`);
    });

    // Подключаем нотификатор к событиям оплаты
    initNotifier(bot);

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

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
