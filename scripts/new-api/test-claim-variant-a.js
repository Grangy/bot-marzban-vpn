#!/usr/bin/env node
/**
 * Интеграционный тест Variant A:
 * - создаёт временного пользователя в Remnawave
 * - резолвит его через GET /v1/users/:username (через наш marzban-utils)
 * - "привязывает" подписку в БД бота (создаёт Subscription для userId из ENV)
 * - удаляет тестового пользователя в Remnawave
 *
 * Запуск на проде:
 *   cd /opt/bot-marzban-vpn
 *   TEST_BIND_USER_ID=1 node scripts/new-api/test-claim-variant-a.js
 */
const crypto = require("crypto");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const { remnawaveGetUser } = require("../../marzban-utils");

const BASE = (process.env.REMNAWAVE_API_URL || "").replace(/\/$/, "");
const KEY = process.env.REMNAWAVE_API_KEY || process.env.API_ACCESS_KEY || "";

function headers() {
  return {
    "Content-Type": "application/json",
    "x-api-key": KEY,
  };
}

async function main() {
  if (!BASE || !KEY) throw new Error("Missing REMNAWAVE_API_URL/REMNAWAVE_API_KEY");

  const userId = Number(process.env.TEST_BIND_USER_ID || "");
  if (!Number.isFinite(userId) || userId <= 0) throw new Error("Set TEST_BIND_USER_ID to existing User.id");

  const username = `trial_test_${crypto.randomBytes(6).toString("hex")}`;
  console.log("TEST username:", username);

  const create = await fetch(`${BASE}/v1/users`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      username,
      days: 1,
      gb: 0,
      subscriptionType: process.env.REMNAWAVE_SUBSCRIPTION_TYPE || "russia",
    }),
  });
  const createText = await create.text();
  console.log("POST /v1/users:", create.status, createText.slice(0, 200));
  if (!create.ok) process.exit(1);

  const info = await remnawaveGetUser(username);
  if (!info?.uuid) throw new Error("remnawaveGetUser() did not return uuid");
  console.log("Resolved uuid:", info.uuid);
  console.log("Resolved subscriptionUrl:", info.subscriptionUrl || "(none)");

  const exists = await prisma.subscription.findFirst({
    where: { userId, remnawaveUuid: info.uuid },
  });
  if (!exists) {
    await prisma.subscription.create({
      data: {
        userId,
        type: "FREE",
        remnawaveUuid: info.uuid,
        subscriptionUrl: info.subscriptionUrl,
        endDate: info.expireAt ? new Date(info.expireAt) : null,
      },
    });
    console.log("DB bind: created Subscription");
  } else {
    console.log("DB bind: already exists");
  }

  const del = await fetch(`${BASE}/v1/users/${encodeURIComponent(info.uuid)}`, {
    method: "DELETE",
    headers: { "x-api-key": KEY },
  });
  const delText = await del.text();
  console.log("DELETE /v1/users/:id:", del.status, delText.slice(0, 200));

  console.log("ALL OK");
}

main()
  .catch((e) => {
    console.error("TEST FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

