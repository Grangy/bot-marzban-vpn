// server.js
const express = require("express");
const bodyParser = require("body-parser");
const { handlePostback, markTopupSuccessAndCredit, markTopupFailed } = require("./payment");

function createServer() {
  const app = express();
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  app.get("/health", (req, res) => {
    res.status(200).send("✅ Payment server is running");
  });

  // Статистика платежей
  app.get("/payment/stats", async (req, res) => {
    try {
      const { prisma } = require("./db");
      
      const stats = await prisma.topUp.groupBy({
        by: ['status'],
        _count: {
          id: true,
        },
        _sum: {
          amount: true,
        },
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // За последние 24 часа
          }
        }
      });

      const totalStats = await prisma.topUp.groupBy({
        by: ['status'],
        _count: {
          id: true,
        },
        _sum: {
          amount: true,
        }
      });

      res.json({
        last24h: stats,
        total: totalStats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error("Stats error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Тестовый endpoint для проверки webhook'ов
  app.post("/test-webhook", (req, res) => {
    console.log("🧪 Test webhook received:", req.body);
    res.status(200).json({ ok: true, received: req.body });
  });

    // === Result URL на /pay/success (postback от платёжки) ===
  app.post("/pay/success", async (req, res) => {
    try {
      console.log("📩 Result postback /pay/success:", req.body);
      await handlePostback(req.body); // меняем статус заказа в БД
      res.status(200).send("OK");
    } catch (e) {
      console.error("❌ Result /pay/success error:", e);
      res.status(500).send("FAIL");
    }
  });


  // Platega callback
  app.post("/payment/postback", async (req, res) => {
    console.log("🔔 Platega webhook received:", {
      headers: req.headers,
      body: req.body,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    try {
      const result = await handlePostback(req);
      console.log("🔔 Webhook processing result:", result);

      if (result.ok) {
        res.status(200).send("OK"); // ⚡ важно — Platega ждёт 200
      } else {
        console.warn("🔔 Webhook failed:", result.reason);
        res.status(400).send(result.reason || "FAIL");
      }
    } catch (e) {
      console.error("❌ Postback error:", e);
      res.status(500).send("FAIL");
    }
  });

  // Фейковый успех
  app.post("/payment/test-success/:id", async (req, res) => {
    const id = Number(req.params.id);
    try {
      const result = await markTopupSuccessAndCredit(id);
      res.json({ ok: true, result });
    } catch (e) {
      console.error("test-success error:", e);
      res.status(500).json({ ok: false });
    }
  });

  // Фейковый провал
  app.post("/payment/test-fail/:id", async (req, res) => {
    const id = Number(req.params.id);
    try {
      const result = await markTopupFailed(id);
      res.json({ ok: true, result });
    } catch (e) {
      console.error("test-fail error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Fallback платежи - ручная обработка
  app.get("/payment/manual/:orderId", (req, res) => {
    const { orderId } = req.params;
    res.send(`
      <html>
        <head>
          <title>Ручная обработка платежа</title>
          <meta charset="utf-8">
        </head>
        <body>
          <h1>Обработка платежа</h1>
          <p><strong>Номер заказа:</strong> ${orderId}</p>
          <p>Платежная система временно недоступна. Обратитесь в поддержку для ручной обработки платежа.</p>
          <p>Техподдержка: <a href="https://t.me/supmaxgroot">@supmaxgroot</a></p>
        </body>
      </html>
    `);
  });

  return app;
}

module.exports = { createServer };
