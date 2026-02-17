/**
 * Конфигурация скидки на тарифы. Читается из discount-config.json.
 * Админ может менять через /discount в группе.
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "discount-config.json");

const DEFAULTS = {
  active: true,
  percent: 20,
  endAt: "2026-02-11T23:59:00+03:00",
};

function getConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const data = JSON.parse(raw);
    return {
      active: data.active !== false,
      percent: typeof data.percent === "number" ? Math.min(99, Math.max(0, data.percent)) : DEFAULTS.percent,
      endAt: data.endAt || DEFAULTS.endAt,
    };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function setConfig(updates) {
  const current = getConfig();
  const next = { ...current, ...updates };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function isDiscountActive() {
  const { active, endAt } = getConfig();
  if (!active) return false;
  return new Date() < new Date(endAt);
}

function getDiscountBanner() {
  return null; // сообщение о скидке отключено
}

/** Округляет до кратного 5 руб */
function roundTo5(value) {
  return Math.round(value / 5) * 5;
}

module.exports = {
  getConfig,
  setConfig,
  isDiscountActive,
  getDiscountBanner,
  roundTo5,
};
