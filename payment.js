// payment.js
const { prisma } = require("./db");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { v4: uuidv4 } = require("uuid");
const bus = require("./events");
const { logSuccessfulTopup, logFailedTopup } = require("./google-sheets");

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

  // Валидация данных перед отправкой
  if (!orderId || !amount || !description) {
    throw new Error("Некорректные данные для создания платежа");
  }

  const body = {
    paymentMethod: DEFAULT_METHOD, // 2 = QR/СБП
    id: orderId, // UUID транзакции
    paymentDetails: {
      amount: Number(amount), // Убеждаемся что это число
      currency: "RUB",
    },
    description: String(description), // Убеждаемся что это строка
    return: RETURN_URL,
    failedUrl: FAIL_URL,
    callbackUrl: `${process.env.PAYMENT_CALLBACK_URL || "https://maxvpn.live"}/payment/postback`,
    payload: String(userId), // полезно для связи
  };

  // Дополнительная валидация
  if (!body.paymentDetails.amount || body.paymentDetails.amount <= 0) {
    throw new Error("Некорректная сумма платежа");
  }

  if (!body.id || !body.description) {
    throw new Error("Некорректные параметры платежа");
  }

  // Функция для создания платежа с повторными попытками
  async function createPaymentWithRetry(maxRetries = 2) {
    // Таймаут для запроса: 30 секунд (увеличен)
    const TIMEOUT_MS = 30000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[TOPUP] Attempt ${attempt}/${maxRetries} to create payment for orderId: ${orderId}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        
        // Если это таймаут или сетевая ошибка, пробуем еще раз
        if (fetchError.name === 'AbortError' || fetchError.type === 'aborted') {
          console.warn(`[TOPUP] Request timeout (${TIMEOUT_MS}ms) on attempt ${attempt}/${maxRetries}`);
          if (attempt < maxRetries) {
            // Ждем перед следующей попыткой
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          throw new Error(`Таймаут запроса к платежной системе после ${maxRetries} попыток. Попробуйте еще раз.`);
        }
        
        console.error("[Platega] Network error:", fetchError);
        
        // Если сеть недоступна, пробуем еще раз
        if (fetchError.code === 'ENOTFOUND' || fetchError.code === 'ECONNREFUSED' || fetchError.code === 'ETIMEDOUT') {
          console.warn(`[TOPUP] Network error on attempt ${attempt}/${maxRetries}`);
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          throw new Error("Ошибка сети при обращении к платежной системе");
        }
        
        throw new Error("Ошибка сети при обращении к платежной системе");
      }

      let data;
      try {
        data = await response.json();
      } catch (parseError) {
        console.error("[Platega] Failed to parse response:", parseError);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        const responseText = await response.text();
        console.error("[Platega] Raw response:", responseText);
        throw new Error("Неверный ответ от платежной системы");
      }

      console.log(`[TOPUP] Platega response (attempt ${attempt}):`, { status: response.status, data });

      if (!response.ok) {
        console.error("[Platega] API error:", {
          status: response.status,
          statusText: response.statusText,
          data: data,
          requestBody: body
        });
        
        // Для некоторых ошибок пробуем еще раз
        if (response.status >= 500 && attempt < maxRetries) {
          console.warn(`[TOPUP] Server error on attempt ${attempt}/${maxRetries}, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        
        // Детальная обработка ошибок
        if (response.status === 400) {
          if (data?.Message) {
            throw new Error(`Ошибка API: ${data.Message}`);
          } else {
            throw new Error("Ошибка запроса к платежной системе");
          }
        } else if (response.status === 401) {
          throw new Error("Ошибка авторизации в платежной системе");
        } else if (response.status === 403) {
          throw new Error("Доступ к платежной системе запрещен");
        } else {
          throw new Error(`Ошибка платежной системы (статус: ${response.status})`);
        }
      }

      if (!data.redirect) {
        console.error("[Platega] Missing redirect in response:", data);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        throw new Error("Платежная система не вернула ссылку для оплаты");
      }

      // Успешно получили ссылку
      return { link: data.redirect, topup };
    }
    
    // Если дошли сюда, все попытки исчерпаны
    throw new Error("Не удалось создать ссылку для оплаты после нескольких попыток");
  }

  console.log(`[TOPUP] Sending request to Platega:`, {
    url: API_URL,
    merchantId: MERCHANT_ID,
    body: body
  });

  // Создаем платеж с повторными попытками
  return await createPaymentWithRetry(2);
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
    
    // Логируем в Google Sheets
    try {
      const user = await prisma.user.findUnique({ where: { id: t.userId } });
      await logSuccessfulTopup(t, user);
    } catch (err) {
      console.error("[SHEETS] Ошибка логирования успешного пополнения:", err.message);
    }
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
  
  // Логируем в Google Sheets
  try {
    const user = await prisma.user.findUnique({ where: { id: t.userId } });
    await logFailedTopup(t, user);
  } catch (err) {
    console.error("[SHEETS] Ошибка логирования неуспешного пополнения:", err.message);
  }
  
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
    console.log(`[POSTBACK] Payment confirmed for topup ${t.id} (orderId: ${id})`);
    await markTopupSuccessAndCredit(t.id);
    return { ok: true, status: "SUCCESS" };
  } else if (status === "CANCELED") {
    console.log(`[POSTBACK] Payment canceled for topup ${t.id} (orderId: ${id})`);
    console.log(`[POSTBACK] Cancel details:`, { 
      topupId: t.id, 
      orderId: id, 
      amount: body.amount, 
      userId: t.userId,
      createdAt: t.createdAt 
    });
    await markTopupFailed(t.id);
    return { ok: true, status: "FAILED" };
  } else {
    console.warn("[POSTBACK] Unknown status:", status, "for orderId:", id);
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
