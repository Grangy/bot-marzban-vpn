#!/usr/bin/env node
/**
 * Проверка Remnawave API (health, авторизация, опционально create + extend тестового пользователя).
 *
 *   node scripts/new-api/verify-remnawave.js
 *   REMNAWAVE_TEST_USER=test_rz_$(date +%s) node scripts/new-api/verify-remnawave.js --mutate
 *
 * Переменные (.env в корне проекта):
 *   REMNAWAVE_API_URL=https://api.maxg.ch
 *   REMNAWAVE_API_KEY=<API_ACCESS_KEY>
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const BASE = (process.env.REMNAWAVE_API_URL || "").replace(/\/$/, "");
const KEY = process.env.REMNAWAVE_API_KEY || "";
const mutate = process.argv.includes("--mutate");
const testUser =
  process.env.REMNAWAVE_TEST_USER || `rz_verify_${Date.now().toString(36)}`;

function headers() {
  return {
    "Content-Type": "application/json",
    "x-api-key": KEY,
  };
}

function innerUser(u) {
  if (!u || typeof u !== "object") return null;
  return u.response && typeof u.response === "object" ? u.response : u;
}

function pickUrl(body) {
  const u = innerUser(body?.user);
  if (!u) return null;
  return u.subscriptionUrl || u.subscription_url || null;
}

function pickUuid(body) {
  const u = innerUser(body?.user);
  return u?.uuid || null;
}

async function main() {
  if (!BASE || !KEY) {
    console.error("Задайте REMNAWAVE_API_URL и REMNAWAVE_API_KEY в .env");
    process.exit(1);
  }

  const healthUrl = BASE.replace(/\/v1$/, "") + "/health";
  const h = await fetch(healthUrl);
  const ht = await h.text();
  console.log("GET /health", h.status, ht);

  const notFound = await fetch(`${BASE}/v1/users/__definitely_missing_user__`, {
    headers: { "x-api-key": KEY },
  });
  const nft = await notFound.text();
  console.log("GET /v1/users/missing (ожидаем 404)", notFound.status, nft.slice(0, 200));

  if (!mutate) {
    console.log("\nOK (без --mutate). Для полного теста создания/продления: --mutate");
    return;
  }

  const days = 3;
  const createRes = await fetch(`${BASE}/v1/users`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      username: testUser,
      days,
      gb: 0,
      subscriptionType: process.env.REMNAWAVE_SUBSCRIPTION_TYPE || "russia",
    }),
  });
  const crText = await createRes.text();
  console.log("\nPOST /v1/users", createRes.status, crText.slice(0, 800));
  if (!createRes.ok) {
    process.exit(1);
  }
  let crJson;
  try {
    crJson = JSON.parse(crText);
  } catch {
    console.error("Некорректный JSON ответа");
    process.exit(1);
  }
  const subUrl = pickUrl(crJson);
  const uuid = pickUuid(crJson);
  console.log("subscription URL:", subUrl || "(нет)");
  console.log("uuid:", uuid || "(нет)");

  if (!uuid) {
    console.error("Нет uuid — продление не проверить");
    process.exit(1);
  }

  const extUrl = `${BASE}/v1/users/${encodeURIComponent(uuid)}/extend`;
  const extBody = JSON.stringify({ days: 1 });
  let extOk = false;
  let extStatus = 0;
  let extText = "";
  for (let attempt = 1; attempt <= 25; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 3000));
    const ext = await fetch(extUrl, {
      method: "PATCH",
      headers: headers(),
      body: extBody,
    });
    extStatus = ext.status;
    extText = await ext.text();
    if (ext.ok) {
      extOk = true;
      break;
    }
    if (extStatus !== 404 || !extText.includes("User not found")) break;
  }
  console.log("\nPATCH /v1/users/.../extend", extStatus, extText.slice(0, 500));
  process.exit(extOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
