#!/usr/bin/env node
/**
 * Миграция: для всех активных подписок (endDate > now) создать нового Remnawave user
 * и заменить ссылки/uuid в БД, сохранив тот же срок окончания.
 *
 * Примечание: ограничиваем параллельность, чтобы не положить API.
 *
 * Запуск на проде:
 *   cd /opt/bot-marzban-vpn
 *   CONCURRENCY=8 node scripts/new-api/migrate-all-active-subs-to-remnawave.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const crypto = require("crypto");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BASE = (process.env.REMNAWAVE_API_URL || "").replace(/\/$/, "");
const KEY = process.env.REMNAWAVE_API_KEY || process.env.API_ACCESS_KEY || "";
const SUB_TYPE = process.env.REMNAWAVE_SUBSCRIPTION_TYPE || "russia";
const CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.CONCURRENCY || 8)));

function headers() {
  return { "content-type": "application/json", "x-api-key": KEY };
}

function isSubMaxg(url) {
  return typeof url === "string" && url.startsWith("https://sub.maxg.ch/");
}

function daysUntil(endDate) {
  const ms = new Date(endDate).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 86400000));
}

async function createRwUser(username, days) {
  const res = await fetch(`${BASE}/v1/users`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ username, days, gb: 0, subscriptionType: SUB_TYPE }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RW_CREATE_FAILED ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  const u = j.user && j.user.response ? j.user.response : j.user;
  return {
    uuid: u.uuid,
    status: u.status,
    subscriptionUrl: u.subscriptionUrl || u.subscription_url || null,
  };
}

async function getRw(id) {
  const res = await fetch(`${BASE}/v1/users/${encodeURIComponent(id)}`, {
    headers: { "x-api-key": KEY },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RW_GET_FAILED ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return j.user && j.user.response ? j.user.response : j.user;
}

async function pool(items, worker, concurrency) {
  let idx = 0;
  const results = [];
  const runners = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  if (!BASE || !KEY) throw new Error("Missing REMNAWAVE_API_URL/REMNAWAVE_API_KEY");

  const now = new Date();
  const subs = await prisma.subscription.findMany({
    where: { endDate: { not: null, gt: now } },
    include: { user: { select: { telegramId: true } } },
    orderBy: [{ id: "asc" }],
  });

  const targets = subs.filter((s) => {
    if (!s.endDate) return false;
    if (s.remnawaveUuid && isSubMaxg(s.subscriptionUrl) && !s.subscriptionUrl2) return false;
    return true;
  });

  console.log(
    JSON.stringify(
      { totalActive: subs.length, toMigrate: targets.length, concurrency: CONCURRENCY },
      null,
      2
    )
  );

  let ok = 0;
  let fail = 0;

  await pool(
    targets,
    async (s) => {
      try {
        const tg = s.user?.telegramId || "unknown";
        const days = daysUntil(s.endDate);
        const rand = crypto.randomBytes(3).toString("hex");
        const username = `${tg}_${s.type}_${s.id}_m${rand}`;

        const created = await createRwUser(username, days);
        const rw = await getRw(created.uuid);
        if (rw.status !== "ACTIVE") throw new Error(`RW_NOT_ACTIVE ${rw.status || "?"}`);
        const url = created.subscriptionUrl || rw.subscriptionUrl || rw.subscription_url;
        if (!url) throw new Error("RW_NO_URL");

        await prisma.subscription.update({
          where: { id: s.id },
          data: { remnawaveUuid: created.uuid, subscriptionUrl: url, subscriptionUrl2: null },
        });
        ok++;
        if (ok % 50 === 0) console.log(`progress ok=${ok} fail=${fail}`);
        return { id: s.id, ok: true };
      } catch (e) {
        fail++;
        return { id: s.id, ok: false, err: String(e?.message || e).slice(0, 300) };
      }
    },
    CONCURRENCY
  );

  console.log(JSON.stringify({ done: true, ok, fail }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

