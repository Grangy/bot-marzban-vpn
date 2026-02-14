// google-sheets.js - Модуль для записи транзакций в Google Sheets
const path = require("path");
const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || "1ysYdpyercsaJ2OgtEYiFskU7caGSQ93jJSTfXzUiJ38";
// В Google Sheets название листа зависит от локали: "Sheet1" (EN) или "Лист1" (RU). Укажите GOOGLE_SHEETS_SHEET_NAME если не подходит.
const SHEET_NAME = process.env.GOOGLE_SHEETS_SHEET_NAME || "Sheet1";
const KEYFILE_PATH = path.resolve(__dirname, "table-484713-7d2b62fb7e2e.json");

let sheetsClient = null;

/**
 * Инициализация клиента Google Sheets
 */
async function initSheetsClient() {
  if (sheetsClient) return sheetsClient;

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: KEYFILE_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    sheetsClient = google.sheets({ version: "v4", auth });
    console.log("✅ Google Sheets клиент инициализирован");
    return sheetsClient;
  } catch (err) {
    console.error("❌ Ошибка инициализации Google Sheets:", err.message);
    return null;
  }
}

/**
 * Форматирование даты и времени
 */
function formatDateTime() {
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const dateTime = `${date} ${time}`;
  
  return { date, time, dateTime };
}

/**
 * Добавить запись о пополнении в Google Sheets
 * @param {Object} params - Параметры транзакции
 * @param {string} params.txId - ID транзакции (orderId)
 * @param {string} params.operation - Тип операции
 * @param {string} params.description - Описание
 * @param {string} params.status - Статус (OK, FAILED, etc.)
 * @param {number} params.amount - Сумма
 * @param {string} params.currency - Валюта
 * @param {string} params.username - Telegram username
 * @param {string} params.telegramId - Telegram ID
 */
async function appendTopupRow(params) {
  try {
    const sheets = await initSheetsClient();
    if (!sheets) {
      console.warn("⚠️ Google Sheets недоступен, пропускаю запись");
      return { success: false, error: "Sheets client not initialized" };
    }

    const { date, time, dateTime } = formatDateTime();

    const row = [
      params.txId || "",           // TxID
      params.operation || "TOPUP", // Операция
      params.description || "",    // Описание
      params.status || "OK",       // Статус
      String(params.amount || 0),  // Сумма
      params.currency || "RUB",    // Валюта
      date,                        // Дата
      time,                        // Время
      dateTime,                    // ДатаВремя
      params.username || "",       // Пользователь TG
      params.telegramId || "",     // TG ID
    ];

    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:K`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [row],
      },
    });

    console.log(`📊 Запись добавлена в Google Sheets: ${params.txId}`);
    return { success: true, updatedRange: res.data.updates?.updatedRange };
  } catch (err) {
    console.error("❌ Ошибка записи в Google Sheets:", err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Записать успешное пополнение
 */
async function logSuccessfulTopup(topup, user) {
  return appendTopupRow({
    txId: topup.orderId,
    operation: "TOPUP_SUCCESS",
    description: `Пополнение баланса`,
    status: "OK",
    amount: topup.amount,
    currency: "RUB",
    username: user?.accountName || "",
    telegramId: user?.telegramId || "",
  });
}

/**
 * Записать неуспешное пополнение
 */
async function logFailedTopup(topup, user) {
  return appendTopupRow({
    txId: topup.orderId,
    operation: "TOPUP_FAILED",
    description: `Пополнение отменено`,
    status: "FAILED",
    amount: topup.amount,
    currency: "RUB",
    username: user?.accountName || "",
    telegramId: user?.telegramId || "",
  });
}

module.exports = {
  initSheetsClient,
  appendTopupRow,
  logSuccessfulTopup,
  logFailedTopup,
};
