// payment.js
const { prisma } = require("./db");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");
const bus = require("./events");

const API_URL   = process.env.PAYMENT_API_URL   || "https://pal24.pro/api/v1";
const API_TOKEN = process.env.PAYMENT_API_TOKEN || "FAKE";
const SHOP_ID   = process.env.PAYMENT_SHOP_ID   || "FAKE";

async function createInvoice(userId, amount, description = "Пополнение") {
  const orderId = `order_${uuidv4()}`;

  const topup = await prisma.topUp.create({
    data: { userId, amount, status: "PENDING", orderId },
  });

  if (API_TOKEN === "FAKE") {
    return {
      link: `https://fakepay.local/invoice/${orderId}`,
      topup,
    };
  }

  const formData = new URLSearchParams();
  formData.append("amount", amount);
  formData.append("order_id", orderId);
  formData.append("description", description);
  formData.append("type", "normal");
  formData.append("shop_id", SHOP_ID);
  formData.append("currency_in", "RUB");
  formData.append("custom", String(userId));
  formData.append("payer_pays_commission", "1");
  formData.append("name", "Пополнение");

  const response = await fetch(`${API_URL}/bill/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    body: formData,
  });

  const data = await response.json();

  if (!response.ok || !data.link_page_url) {
    throw new Error("Не удалось создать счёт: " + JSON.stringify(data));
  }

  await prisma.topUp.update({
    where: { id: topup.id },
    data: { billId: data.bill_id },
  });

  return { link: data.link_page_url, topup };
}

/** Идемпотентное зачисление. */
async function applyCreditIfNeeded(topupId) {
  return prisma.$transaction(async (tx) => {
    const t = await tx.topUp.findUnique({ where: { id: topupId } });
    if (!t) return { ok: false, reason: "NOT_FOUND" };
    if (t.status !== "SUCCESS") return { ok: false, reason: "NOT_SUCCESS", status: t.status };

    const upd = await tx.topUp.updateMany({
      where: { id: t.id, credited: false },
      data: { credited: true, creditedAt: new Date() },
    });

    if (upd.count === 0) {
      return { ok: true, alreadyCredited: true };
    }

    await tx.user.update({
      where: { id: t.userId },
      data: { balance: { increment: t.amount } },
    });

    return { ok: true, credited: true, amount: t.amount };
  });
}

/** Пометить успех + зачислить + сгенерировать событие для уведомления. */
async function markTopupSuccessAndCredit(topupId) {
  const t = await prisma.topUp.findUnique({ where: { id: topupId } });
  if (!t) return { ok: false, reason: "NOT_FOUND" };

  if (t.status !== "SUCCESS") {
    await prisma.topUp.update({ where: { id: t.id }, data: { status: "SUCCESS" } });
  }

  const res = await applyCreditIfNeeded(t.id);

  // Уведомляем только когда реально было зачисление (чтобы не дублировать)
  if (res.credited) {
    bus.emit("topup.success", { topupId: t.id });
  }

  return { ok: true, ...res };
}

/** Пометить провал + сгенерировать событие. */
async function markTopupFailed(topupId) {
  const t = await prisma.topUp.findUnique({ where: { id: topupId } });
  if (!t) return { ok: false, reason: "NOT_FOUND" };

  if (t.status !== "FAILED") {
    await prisma.topUp.update({ where: { id: t.id }, data: { status: "FAILED" } });
  }

  bus.emit("topup.failed", { topupId: t.id });
  return { ok: true };
}

/** Postback от платёжки (InvId = наш orderId) */
async function handlePostback(body) {
  const { Status, InvId } = body;
  console.log("[POSTBACK] body:", body);

  const t = await prisma.topUp.findUnique({ where: { orderId: InvId } });
  if (!t) {
    console.warn("[POSTBACK] Topup by orderId not found:", InvId);
    return;
  }

  if (Status === "SUCCESS") {
    const res = await markTopupSuccessAndCredit(t.id);
    console.log("[POSTBACK] success handled:", res);
  } else {
    const res = await markTopupFailed(t.id);
    console.log("[POSTBACK] failed handled:", res);
  }
}

module.exports = {
  createInvoice,
  applyCreditIfNeeded,
  handlePostback,
  markTopupSuccessAndCredit,
  markTopupFailed,
};
