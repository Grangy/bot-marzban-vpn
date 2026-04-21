#!/usr/bin/env node
/**
 * Fix orphaned relations where rows reference missing User ids.
 *
 * Strategy:
 * - Find orphan userIds in Subscription (and TopUp/ReferralBonus/PromoActivation).
 * - For each orphan userId, try infer telegramId from legacy Marzban subscriptionUrl/subscriptionUrl2 token:
 *      https://vpn.grangy.ru/sub/<base64...>
 *   The token starts with Base64 of "<telegramId>_<TYPE>_<subId>,...".
 * - If inferred telegramId maps to an existing User → move all related rows to that User.
 * - Else create a new User (telegramId=chatId=<telegramId>) and move rows to it.
 *
 * NOTE: Orphans that have no decodable subscription URL are reported and skipped.
 *
 * Usage:
 *   node scripts/fix-orphan-users.js
 *   DRY_RUN=1 node scripts/fix-orphan-users.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DRY_RUN = String(process.env.DRY_RUN || "") === "1";
const REMNAWAVE_API_URL = String(process.env.REMNAWAVE_API_URL || "").replace(/\/$/, "");
const REMNAWAVE_API_KEY = String(process.env.REMNAWAVE_API_KEY || process.env.API_ACCESS_KEY || "");
const CAN_USE_REMNAWAVE = Boolean(REMNAWAVE_API_URL && REMNAWAVE_API_KEY);
const fetchFn =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

function uniq(arr) {
  return [...new Set(arr)];
}

function tokenFromSubUrl(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/\/sub\/([^/?#]+)/);
  return m ? m[1] : null;
}

function tryDecodeTelegramIdFromToken(token) {
  if (!token) return null;
  // Token itself is URL-safe base64-ish but in practice works with standard base64 decode
  // for our legacy Marzban links where it begins with base64("<tgId>_<...>").
  try {
    let t = String(token);
    // support base64url and missing padding
    t = t.replace(/-/g, "+").replace(/_/g, "/");
    const pad = t.length % 4;
    if (pad) t += "=".repeat(4 - pad);
    const buf = Buffer.from(t, "base64");
    const s = buf.toString("utf8");
    const tg = s.split("_", 1)[0];
    if (/^\d{5,20}$/.test(tg)) return tg;
    return null;
  } catch (_) {
    return null;
  }
}

async function userExistsById(id) {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  return Boolean(u);
}

async function getOrphanUserIds() {
  const [subs, topups, refOwner, promo] = await Promise.all([
    prisma.subscription.findMany({ select: { userId: true } }),
    prisma.topUp.findMany({ select: { userId: true } }),
    prisma.referralBonus.findMany({ select: { codeOwnerId: true, activatorId: true } }),
    prisma.promoActivation
      .findMany({ select: { codeOwnerId: true, activatorId: true } })
      .catch(() => []),
  ]);

  const candidateIds = uniq([
    ...subs.map((s) => s.userId),
    ...topups.map((t) => t.userId),
    ...refOwner.map((r) => r.codeOwnerId),
    ...refOwner.map((r) => r.activatorId),
    ...promo.map((p) => p.codeOwnerId),
    ...promo.map((p) => p.activatorId),
  ].filter((x) => Number.isFinite(Number(x))));

  const existing = await prisma.user.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true },
  });
  const existingSet = new Set(existing.map((u) => u.id));
  return candidateIds.filter((id) => !existingSet.has(id));
}

async function inferTelegramIdForOrphanUserId(orphanUserId) {
  const subs = await prisma.subscription.findMany({
    where: { userId: orphanUserId },
    select: { subscriptionUrl: true, subscriptionUrl2: true, remnawaveUuid: true },
    take: 50,
  });

  for (const s of subs) {
    for (const u of [s.subscriptionUrl, s.subscriptionUrl2]) {
      const token = tokenFromSubUrl(u);
      const tg = tryDecodeTelegramIdFromToken(token);
      if (tg) return tg;
    }
  }

  // Remnawave fallback: try resolve user by uuid and parse telegramId from username/fields.
  if (CAN_USE_REMNAWAVE) {
    for (const s of subs) {
      const uuid = s.remnawaveUuid;
      if (!uuid) continue;
      const tg = await tryResolveTelegramIdFromRemnawave(uuid);
      if (tg) return tg;
    }
  }

  return null;
}

async function tryResolveTelegramIdFromRemnawave(remnawaveUuid) {
  const id = String(remnawaveUuid || "").trim();
  if (!id) return null;
  try {
    const r = await fetchFn(`${REMNAWAVE_API_URL}/v1/users/${encodeURIComponent(id)}`, {
      headers: { "x-api-key": REMNAWAVE_API_KEY },
    });
    const text = await r.text();
    if (!r.ok) return null;
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    const u = json?.user?.response && typeof json.user.response === "object" ? json.user.response : json?.user;
    const direct = u?.telegramId || u?.telegram_id || u?.telegram || null;
    if (direct != null && /^\d{5,20}$/.test(String(direct))) return String(direct);
    const username = u?.username;
    if (typeof username === "string") {
      const tg = username.split("_", 1)[0];
      if (/^\d{5,20}$/.test(tg)) return tg;
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function ensureUserByTelegramId(telegramId) {
  let user = await prisma.user.findFirst({ where: { telegramId } });
  if (user) return { user, created: false };
  if (DRY_RUN) {
    return { user: { id: -1, telegramId }, created: true };
  }
  user = await prisma.user.create({
    data: {
      telegramId,
      chatId: telegramId,
      accountName: null,
      balance: 0,
    },
  });
  return { user, created: true };
}

async function moveAllRelations(fromUserId, toUserId) {
  const moved = {};
  const tx = async (txp) => {
    moved.subscriptions = (await txp.subscription.updateMany({ where: { userId: fromUserId }, data: { userId: toUserId } })).count;
    moved.topups = (await txp.topUp.updateMany({ where: { userId: fromUserId }, data: { userId: toUserId } })).count;
    moved.refOwner = (await txp.referralBonus.updateMany({ where: { codeOwnerId: fromUserId }, data: { codeOwnerId: toUserId } })).count;
    moved.refAct = (await txp.referralBonus.updateMany({ where: { activatorId: fromUserId }, data: { activatorId: toUserId } })).count;
    moved.promoOwner = (await txp.promoActivation?.updateMany
      ? (await txp.promoActivation.updateMany({ where: { codeOwnerId: fromUserId }, data: { codeOwnerId: toUserId } })).count
      : 0);
    moved.promoAct = (await txp.promoActivation?.updateMany
      ? (await txp.promoActivation.updateMany({ where: { activatorId: fromUserId }, data: { activatorId: toUserId } })).count
      : 0);
  };

  if (DRY_RUN) return moved;
  await prisma.$transaction(tx);
  return moved;
}

async function main() {
  console.log(`[orphan-fix] dryRun=${DRY_RUN}`);
  const orphanIds = await getOrphanUserIds();
  console.log(`[orphan-fix] orphan userIds: ${orphanIds.length}`);

  const report = {
    processed: 0,
    fixed: 0,
    skipped: 0,
    details: [],
  };

  for (const orphanUserId of orphanIds) {
    report.processed++;
    const tg = await inferTelegramIdForOrphanUserId(orphanUserId);
    if (!tg) {
      report.skipped++;
      report.details.push({ orphanUserId, status: "SKIPPED_NO_TELEGRAMID" });
      continue;
    }
    const { user: targetUser, created } = await ensureUserByTelegramId(tg);
    const moved = await moveAllRelations(orphanUserId, targetUser.id);
    report.fixed++;
    report.details.push({
      orphanUserId,
      telegramId: tg,
      targetUserId: targetUser.id,
      targetCreated: created,
      moved,
    });
  }

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((e) => {
    console.error("[orphan-fix] error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

