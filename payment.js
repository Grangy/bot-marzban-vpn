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

  // Функция для создания fallback платежа
  async function createFallbackPayment() {
    console.warn("[TOPUP] Using fallback payment system due to API issues");
    console.warn("[TOPUP] Fallback details:", { orderId, amount, userId });
    
    // Помечаем topup как fallback
    await prisma.topUp.update({
      where: { id: topup.id },
      data: { 
        status: "PENDING",
        billId: `fallback-${orderId}` // Отмечаем как fallback
      }
    });

    // Создаем простую ссылку для ручной оплаты
    const fallbackLink = `${process.env.PAYMENT_CALLBACK_URL || "https://maxvpn.live"}/payment/manual/${orderId}`;
    
    console.warn("[TOPUP] Fallback payment created:", { orderId, fallbackLink });
    
    return {
      link: fallbackLink,
      topup: { ...topup, billId: `fallback-${orderId}` },
      isFallback: true
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

  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MerchantId": MERCHANT_ID,
        "X-Secret": SECRET_KEY,
      },
      body: JSON.stringify(body),
      timeout: 10000, // 10 секунд таймаут
    });
  } catch (fetchError) {
    console.error("[Platega] Network error:", fetchError);
    
    // Если сеть недоступна, используем fallback
    if (fetchError.code === 'ENOTFOUND' || fetchError.code === 'ECONNREFUSED' || fetchError.code === 'ETIMEDOUT') {
      console.warn("[TOPUP] Network error, using fallback payment system");
      return await createFallbackPayment();
    }
    
    throw new Error("Ошибка сети при обращении к платежной системе");
  }

  let data;
  try {
    data = await response.json();
  } catch (parseError) {
    console.error("[Platega] Failed to parse response:", parseError);
    const responseText = await response.text();
    console.error("[Platega] Raw response:", responseText);
    throw new Error("Неверный ответ от платежной системы");
  }

  console.log(`[TOPUP] Platega response:`, { status: response.status, data });

  if (!response.ok) {
    console.error("[Platega] API error:", {
      status: response.status,
      statusText: response.statusText,
      data: data,
      requestBody: body
    });
    
    // Детальная обработка ошибок
    if (response.status === 400) {
      if (data?.Message) {
        console.error(`[Platega] 400 Error: ${data.Message}`);
        
        // Если это критическая ошибка API, используем fallback
        if (data.Message.includes("Object reference not set") || 
            data.Message.includes("not set to an instance")) {
          console.warn("[TOPUP] Critical API error, using fallback payment system");
          return await createFallbackPayment();
        }
        
        throw new Error(`Ошибка API: ${data.Message}`);
      } else {
        console.warn("[TOPUP] Unknown 400 error, using fallback payment system");
        return await createFallbackPayment();
      }
    } else if (response.status === 401) {
      throw new Error("Ошибка авторизации в платежной системе");
    } else if (response.status === 403) {
      throw new Error("Доступ к платежной системе запрещен");
    } else if (response.status >= 500) {
      console.warn("[TOPUP] Server error, using fallback payment system");
      return await createFallbackPayment();
    } else {
      console.warn("[TOPUP] Unknown error, using fallback payment system");
      return await createFallbackPayment();
    }
  }

  if (!data.redirect) {
    console.error("[Platega] Missing redirect in response:", data);
    throw new Error("Платежная система не вернула ссылку для оплаты");
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
