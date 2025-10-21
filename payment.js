// payment.js
const { prisma } = require("./db");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { v4: uuidv4 } = require("uuid");
const bus = require("./events");

const API_URL        = process.env.PAYMENT_API_URL || "https://app.platega.io/transaction/process";
const MERCHANT_ID    = process.env.PAYMENT_MERCHANT_ID || "FAKE";
const SECRET_KEY     = process.env.PAYMENT_SECRET || "FAKE";
const RETURN_URL     = process.env.PAYMENT_RETURN_URL || "https://example.com/success";
const FAIL_URL       = process.env.PAYMENT_FAIL_URL || "https://example.com/fail";

// Метод по умолчанию — QR / СБП
const DEFAULT_METHOD = 2;

/**
 * Создание счёта (Platega).
 */
async function createInvoice(userId, amount, description = "Пополнение") {
  const orderId = uuidv4();

  // сохраняем в БД
  const topup = await prisma.topUp.create({
    data: { userId, amount, status: "PENDING", orderId },
  });

  // Если нет реальных ключей — возвращаем фейковую ссылку
  if (MERCHANT_ID === "FAKE" || SECRET_KEY === "FAKE") {
    return {
      link: `https://fakepay.local/invoice/${orderId}`,
      topup,
    };
  }

  const body = {
    paymentMethod: DEFAULT_METHOD, // 2 = QR/СБП
    id: orderId, // UUID транзакции
    paymentDetails: {
      amount,
      currency: "RUB",
    },
    description,
    return: RETURN_URL,
    failedUrl: FAIL_URL,
    callbackUrl: `${process.env.PAYMENT_CALLBACK_URL || "https://maxvpn.live"}/payment/postback`,
    payload: String(userId), // полезно для связи
  };

  console.log(`[TOPUP] Sending request to Platega:`, {
    url: API_URL,
    merchantId: MERCHANT_ID,
    body: body
  });

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MerchantId": MERCHANT_ID,
      "X-Secret": SECRET_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  console.log(`[TOPUP] Platega response:`, { status: response.status, data });

  if (!response.ok || !data.redirect) {
    console.error("[Platega] error response:", data);
    throw new Error("Не удалось создать счёт в Platega");
  }

  return { link: data.redirect, topup };
}

/** Идемпотентное зачисление */
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

/** Пометить успех + зачислить + сгенерировать событие */
async function markTopupSuccessAndCredit(topupId) {
  const t = await prisma.topUp.findUnique({ where: { id: topupId } });
  if (!t) return { ok: false, reason: "NOT_FOUND" };

  if (t.status !== "SUCCESS") {
    await prisma.topUp.update({ where: { id: t.id }, data: { status: "SUCCESS" } });
  }

  const res = await applyCreditIfNeeded(t.id);

  if (res.credited) {
    bus.emit("topup.success", { topupId: t.id });
  }

  return { ok: true, ...res };
}

/** Пометить провал */
async function markTopupFailed(topupId) {
  const t = await prisma.topUp.findUnique({ where: { id: topupId } });
  if (!t) return { ok: false, reason: "NOT_FOUND" };

  if (t.status !== "FAILED") {
    await prisma.topUp.update({ where: { id: t.id }, data: { status: "FAILED" } });
  }

  bus.emit("topup.failed", { topupId: t.id });
  return { ok: true };
}

/** Postback от Platega */
async function handlePostback(req) {
  const headers = req.headers;
  const body = req.body;

  console.log("[POSTBACK] headers:", headers);
  console.log("[POSTBACK] body:", body);

  // Проверяем заголовки безопасности
  if (
    headers["x-merchantid"] !== (process.env.PAYMENT_MERCHANT_ID || "") ||
    headers["x-secret"] !== (process.env.PAYMENT_SECRET || "")
  ) {
    console.warn("[POSTBACK] Unauthorized callback attempt");
    return { ok: false, reason: "UNAUTHORIZED" };
  }

  const { id, status } = body;

  const t = await prisma.topUp.findUnique({ where: { orderId: id } });
  if (!t) {
    console.warn("[POSTBACK] Topup not found by id:", id);
    return { ok: false, reason: "NOT_FOUND" };
  }

  if (status === "CONFIRMED") {
    await markTopupSuccessAndCredit(t.id);
    return { ok: true, status: "SUCCESS" };
  } else if (status === "CANCELED") {
    await markTopupFailed(t.id);
    return { ok: true, status: "FAILED" };
  } else {
    console.warn("[POSTBACK] Unknown status:", status);
    return { ok: false, reason: "UNKNOWN_STATUS" };
  }
}


module.exports = {
  createInvoice,
  applyCreditIfNeeded,
  handlePostback,
  markTopupSuccessAndCredit,
  markTopupFailed,
};
