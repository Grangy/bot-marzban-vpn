// marzban-utils.js
// Утилиты для работы с Marzban API (основной и резервный сервер)

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const MARZBAN_API_URL = process.env.MARZBAN_API_URL;
const MARZBAN_API_URL_2 = process.env.MARZBAN_API_URL_2 || "http://51.250.72.185:3033";
const MARZBAN_TOKEN = process.env.MARZBAN_TOKEN;
const MARZBAN_TOKEN_2 = process.env.MARZBAN_TOKEN_2 || process.env.MARZBAN_TOKEN; // Если не указан, используем основной токен

/**
 * Преобразует subscription_url от Marzban API в ссылку для rus2 сервера
 * @param {string} originalUrl - Оригинальная subscription_url от API (например, http://51.250.72.185:3033/sub/...)
 * @returns {string} - Преобразованная ссылка для rus2 (https://rus2.grangy.ru:8888/sub/...)
 */
function convertToRus2Url(originalUrl) {
  if (!originalUrl) return null;
  
  // Извлекаем путь после /sub/ из оригинальной ссылки
  const match = originalUrl.match(/\/sub\/(.+)$/);
  if (match) {
    const token = match[1];
    return `https://rus2.grangy.ru:8888/sub/${token}`;
  }
  
  return null;
}

/**
 * Создает пользователя на одном Marzban API сервере
 * @param {string} apiUrl - URL API сервера
 * @param {string} token - Токен доступа
 * @param {object} userData - Данные пользователя для создания
 * @returns {Promise<string|null>} - subscription_url или null при ошибке
 */
async function createUserOnMarzbanServer(apiUrl, token, userData) {
  try {
    console.log(`[Marzban] Creating user on ${apiUrl}`);
    
    const response = await fetch(`${apiUrl}/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "Authorization": `Bearer ${token}` } : {})
      },
      body: JSON.stringify(userData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Marzban] Failed to create user on ${apiUrl}:`, errorText);
      return null;
    }

    const result = await response.json();
    const subscriptionUrl = result.subscription_url || null;
    console.log(`[Marzban] User created successfully on ${apiUrl}`);
    return subscriptionUrl;
  } catch (error) {
    console.error(`[Marzban] Error creating user on ${apiUrl}:`, error);
    return null;
  }
}

/**
 * Создает пользователя на обоих Marzban серверах
 * @param {object} userData - Данные пользователя
 * @param {string} userData.username - Имя пользователя
 * @param {number} userData.expire - Unix timestamp истечения
 * @param {object} userData.proxies - Настройки прокси
 * @param {object} userData.inbounds - Настройки inbounds
 * @param {string} userData.note - Примечание
 * @returns {Promise<{url1: string|null, url2: string|null}>} - Обе ссылки подписки
 */
async function createMarzbanUserOnBothServers(userData) {
  const results = { url1: null, url2: null };

  // Проверяем, настроен ли основной API
  if (!MARZBAN_API_URL || MARZBAN_API_URL === "your_marzban_api_url") {
    console.log("[Marzban] Primary API not configured, skipping");
    results.url1 = `https://fake-vpn.local/subscription/${userData.username}`;
  } else {
    // Создаем на основном сервере
    results.url1 = await createUserOnMarzbanServer(MARZBAN_API_URL, MARZBAN_TOKEN, userData);
  }

  // Создаем на втором сервере (rus2)
  if (!MARZBAN_API_URL_2) {
    console.log("[Marzban] Secondary API not configured, skipping");
  } else {
    const url2Raw = await createUserOnMarzbanServer(MARZBAN_API_URL_2, MARZBAN_TOKEN_2, userData);
    // Преобразуем ссылку для rus2 сервера
    results.url2 = convertToRus2Url(url2Raw) || url2Raw;
  }

  return results;
}

module.exports = {
  createMarzbanUserOnBothServers,
  createUserOnMarzbanServer,
  convertToRus2Url
};
