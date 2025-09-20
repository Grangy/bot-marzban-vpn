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

  app.post("/payment/postback", async (req, res) => {
    try {
      await handlePostback(req.body);
      console.log("📩 Postback received:", req.body);
      res.status(200).send("OK");
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

  return app;
}

module.exports = { createServer };
