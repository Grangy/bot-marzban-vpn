const { prisma } = require("./db");
const { PLANS, calcEndDate, calcEndDateFromDays, formatDate, ruMoney } = require("./menus");
const { createMarzbanUserOnBothServers } = require("./marzban-utils");

const AUTO_PLAN_KEYS = ["D7", "M1", "M3", "M6", "M12"];

function pickAutoPlan(amount) {
  const matches = AUTO_PLAN_KEYS.map((k) => ({ key: k, plan: PLANS[k] }))
    .filter((x) => Number.isFinite(x.plan?.price) && x.plan.price > 0 && amount % x.plan.price === 0)
    .sort((a, b) => b.plan.price - a.plan.price);
  if (matches.length === 0) return null;
  const chosen = matches[0];
  return {
    key: chosen.key,
    plan: chosen.plan,
    multiplier: Math.max(1, Math.floor(amount / chosen.plan.price)),
  };
}

function formatPlanLabel(plan, multiplier) {
  if (multiplier <= 1) return plan.label;
  return `${plan.label} x${multiplier}`;
}

async function tryAutoActivateFromTopup(topupId) {
  const topup = await prisma.topUp.findUnique({ where: { id: topupId } });
  if (!topup || topup.status !== "SUCCESS" || !topup.credited) return { activated: false, reason: "TOPUP_NOT_READY" };

  const picked = pickAutoPlan(topup.amount);
  if (!picked) return { activated: false, reason: "AMOUNT_NOT_MATCHED" };

  const { key, plan, multiplier } = picked;

  const txResult = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: topup.userId } });
    if (!user) return { ok: false, reason: "USER_NOT_FOUND" };
    if (user.balance < topup.amount) return { ok: false, reason: "INSUFFICIENT_BALANCE" };

    await tx.user.update({
      where: { id: topup.userId },
      data: { balance: { decrement: topup.amount } },
    });

    const endDate = plan.days ? calcEndDateFromDays(plan.days * multiplier) : calcEndDate(plan.months * multiplier);
    const sub = await tx.subscription.create({
      data: {
        userId: topup.userId,
        type: plan.type,
        startDate: new Date(),
        endDate,
      },
    });

    const newUser = await tx.user.findUnique({ where: { id: topup.userId } });
    return { ok: true, sub, user, newBalance: newUser?.balance ?? 0 };
  });

  if (!txResult.ok) return { activated: false, reason: txResult.reason || "TX_FAILED" };

  const baseUser = txResult.user;
  const sub = txResult.sub;
  const expireSeconds = plan.days
    ? plan.days * multiplier * 24 * 60 * 60
    : plan.months === 12
      ? 365 * multiplier * 24 * 60 * 60
      : plan.months * multiplier * 30 * 24 * 60 * 60;
  const expire = Math.floor(Date.now() / 1000) + expireSeconds;
  const username = `${baseUser.telegramId}_${plan.type}_${sub.id}`;

  const userData = {
    username,
    status: "active",
    expire,
    proxies: { vless: {} },
    inbounds: { vless: ["VLESS TCP REALITY", "VLESS-TCP-REALITY-VISION"] },
    note: `Telegram user ${baseUser.accountName || baseUser.telegramId}`,
  };

  const { url1, url2, remnawaveUuid } = await createMarzbanUserOnBothServers(userData);

  if (!url1) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: baseUser.id }, data: { balance: { increment: topup.amount } } });
      await tx.subscription.deleteMany({ where: { id: sub.id } });
    });
    return { activated: false, reason: "PROVISION_FAILED" };
  }

  const updatedSub = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      subscriptionUrl: url1,
      subscriptionUrl2: url2,
      ...(remnawaveUuid ? { remnawaveUuid } : {}),
    },
  });

  return {
    activated: true,
    planKey: key,
    planLabel: formatPlanLabel(plan, multiplier),
    multiplier,
    charged: topup.amount,
    newBalance: txResult.newBalance,
    subscription: updatedSub,
    message: `✅ Оплата подтверждена и подписка активирована автоматически: ${formatPlanLabel(plan, multiplier)}\nДействует до: ${formatDate(updatedSub.endDate)}\nСписано: ${ruMoney(topup.amount)}\nТекущий баланс: ${ruMoney(txResult.newBalance)}\n\n🔗 Ссылка: ${updatedSub.subscriptionUrl}`,
  };
}

module.exports = { tryAutoActivateFromTopup };
