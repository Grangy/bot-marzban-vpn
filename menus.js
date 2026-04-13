const { Markup } = require("telegraf");
const discount = require("./discount");

/** Bot API 9.4: кнопки со стилями (primary=синий, success=зелёный, danger=красный) */
function cb(text, data, style) {
  const b = Markup.button.callback(text, data);
  return style ? { ...b, style } : b;
}
function urlBtn(text, url, style) {
  const b = Markup.button.url(text, url);
  return style ? { ...b, style } : b;
}
function webAppBtn(text, url, style) {
  const b = Markup.button.webApp(text, url);
  return style ? { ...b, style } : b;
}

function isDiscountActive() {
  return discount.isDiscountActive();
}

function getDiscountBanner() {
  return discount.getDiscountBanner();
}

/** Персональная акция: −20% на год (M12) для отдельных пользователей (см. yearRenewalDiscountEndsAt). */
const PERSONAL_YEAR_RENEW_PERCENT = 20;

function hasActiveYearRenewalDiscount(pricingUser) {
  if (!pricingUser || !pricingUser.yearRenewalDiscountEndsAt) return false;
  return new Date(pricingUser.yearRenewalDiscountEndsAt) > new Date();
}

/**
 * @param {string} planKey
 * @param {null|{ yearRenewalDiscountEndsAt?: Date|string|null }} [pricingUser] — для M12 учитывает персональную акцию
 */
function getPlanPrice(planKey, pricingUser = null) {
  const plan = PLANS[planKey];
  if (!plan || !plan.price) return 0;

  if (planKey === "M12" && hasActiveYearRenewalDiscount(pricingUser)) {
    const raw = plan.price * (1 - PERSONAL_YEAR_RENEW_PERCENT / 100);
    return discount.roundTo5(raw);
  }

  if (!isDiscountActive()) return plan.price;
  const cfg = discount.getConfig();
  const raw = plan.price * (1 - cfg.percent / 100);
  return discount.roundTo5(raw);
}

/** Базовые суммы пополнения: только глобальная скидка из discount-config (как раньше). */
function getTopupAmounts() {
  if (!isDiscountActive()) return TOPUP_AMOUNTS;
  const cfg = discount.getConfig();
  return TOPUP_AMOUNTS.map((a) => discount.roundTo5(a * (1 - cfg.percent / 100)));
}

/** Для персональной акции на год подменяет в сетке последнюю сумму (12 мес.) на цену M12 для этого пользователя. */
function getTopupAmountsForUser(pricingUser) {
  const amounts = [...getTopupAmounts()];
  if (hasActiveYearRenewalDiscount(pricingUser)) {
    amounts[4] = getPlanPrice("M12", pricingUser);
  }
  return amounts;
}

const PLANS = {
  D7: {
    label: "7 дней",
    price: 99,
    days: 7,
    type: "D7"
  },
  M1: {
    label: "1 месяц",
    price: 199,
    months: 1,
    type: "M1"
  },
  M3: {
    label: "3 месяца",
    price: 499,
    months: 3,
    type: "M3"
  },
  M6: {
    label: "6 месяцев",
    price: 799,
    months: 6,
    type: "M6"
  },
  M12: {
    label: "12 месяцев",
    price: 1499,
    months: 12,
    type: "M12"
  },
  PROMO_10D: {
    label: "10 дней (промо)",
    price: 0,
    days: 10,
    type: "PROMO_10D"
  },
};
const TOPUP_AMOUNTS = [99, 199, 499, 799, 1499];

/** Подсказка срока для кнопок пополнения (тот же порядок, что у TOPUP_AMOUNTS) */
const TOPUP_DURATION_HINT = ["1 неделя", "1 мес.", "3 мес.", "6 мес.", "12 мес."];

/** Краткая подпись срока для кнопок «Купить» / deep link (например «1 неделя», «3 мес.») */
function getPlanDurationHint(planKey) {
  const p = PLANS[planKey];
  if (!p) return "";
  if (planKey === "D7") return "1 неделя";
  if (p.months) return `${p.months} мес.`;
  return "";
}

/** Сумма пополнения «год со скидкой −20%» (только при активной персональной акции). */
function getPersonalYearTopupRubles(pricingUser) {
  if (!hasActiveYearRenewalDiscount(pricingUser)) return null;
  return getPlanPrice("M12", pricingUser);
}

/** Подсказка для нестандартной суммы пополнения (совпадение с тарифом со скидкой и т.п.) */
function hintForTopupRubles(amount, amountsList, pricingUser = null) {
  if (pricingUser && hasActiveYearRenewalDiscount(pricingUser)) {
    const y = getPlanPrice("M12", pricingUser);
    if (amount === y) return "12 мес. −20%";
  }
  const i = amountsList.indexOf(amount);
  if (i >= 0 && TOPUP_DURATION_HINT[i]) return TOPUP_DURATION_HINT[i];
  const planKeys = ["D7", "M1", "M3", "M6", "M12"];
  for (let j = 0; j < planKeys.length; j++) {
    if (getPlanPrice(planKeys[j], pricingUser) === amount) return TOPUP_DURATION_HINT[j];
  }
  return null;
}

function ruMoney(v) {
  return `${v} ₽`;
}

function formatDate(d) {
  return d ? new Date(d).toLocaleDateString("ru-RU") : "∞";
}

function calcEndDate(months) {
  const now = new Date();
  const dt = new Date(now);
  dt.setMonth(dt.getMonth() + months);
  return dt;
}

function calcEndDateFromDays(days) {
  const now = new Date();
  const dt = new Date(now);
  dt.setDate(dt.getDate() + days);
  return dt;
}

function getDisplayLabel(sub) {
  if (sub.type === "FREE") return "Free";
  if (sub.type === "PROMO_10D") return "10 дней (промо)";
  if (sub.type === "D7") return "7 дней";

  if (sub.startDate && sub.endDate) {
    const start = new Date(sub.startDate);
    const end = new Date(sub.endDate);

    // разница в днях
    const diffDays = Math.round((end - start) / (1000 * 60 * 60 * 24));

    // переводим в месяцы (приблизительно по 30 дней)
    const months = Math.round(diffDays / 30);

    return `${months} мес.`;
  }

return PLANS[sub.type]?.label || sub.type;

}


function infoMenu(balanceRub = 0) {
  return Markup.inlineKeyboard([
    [cb("📄 Пользовательское соглашение", "tos")],
    [cb("🔒 Политика конфиденциальности", "privacy")],
    [cb("⬅️ Назад", "back")],
  ]);
}

function instructionsMenu() {
  return Markup.inlineKeyboard([
    [cb("🍎 iPhone (iOS)", "guide_ios", "primary")],
    [cb("📱 Android", "guide_android", "primary")],
    [cb("📺 Android TV", "guide_android_tv")],
    [cb("💻 Windows", "guide_windows", "primary")],
    [cb("🖥️ macOS", "guide_macos", "primary")],
    [cb("⬅️ Назад", "back")],
  ]);
}

function promoMenu() {
  return Markup.inlineKeyboard([
    [cb("🎁 Активировать чужой промокод", "promo_activate", "primary")],
    [cb("⬅️ Назад", "back")],
  ]);
}

function mainMenu(balanceRub = 0) {
  return Markup.inlineKeyboard([
    [webAppBtn("📱 Открыть приложение", "https://web.grangy.ru/", "primary")],
    [cb("📦 Мои подписки", "my_subs"), cb("💳 Купить подписку", "buy", "primary")],
    [cb(`💼 Баланс: ${ruMoney(balanceRub)}`, "balance"), cb("🎁 Промокод", "promo")],
    [cb("📖 Инструкции", "instructions"), cb("📋 Информация", "info")],
    [urlBtn("🛠 Тех.поддержка", "https://t.me/supmaxgroot", "primary")],
  ]);
}


function buyMenu(pricingUser = null) {
  const p7d = getPlanPrice("D7", pricingUser);
  const p1 = getPlanPrice("M1", pricingUser);
  const p3 = getPlanPrice("M3", pricingUser);
  const p6 = getPlanPrice("M6", pricingUser);
  const p12 = getPlanPrice("M12", pricingUser);
  const m12Hint = hasActiveYearRenewalDiscount(pricingUser)
    ? "12 мес. −20%"
    : getPlanDurationHint("M12");
  const rows = [
    [cb(`${PLANS.D7.label} — ${ruMoney(p7d)} (${getPlanDurationHint("D7")})`, "buy_D7", "primary")],
    [cb(`${PLANS.M1.label} — ${ruMoney(p1)} (${getPlanDurationHint("M1")})`, "buy_M1", "primary")],
    [cb(`${PLANS.M3.label} — ${ruMoney(p3)} (${getPlanDurationHint("M3")})`, "buy_M3", "primary")],
    [cb(`${PLANS.M6.label} — ${ruMoney(p6)} (${getPlanDurationHint("M6")})`, "buy_M6", "primary")],
    [cb(`${PLANS.M12.label} — ${ruMoney(p12)} (${m12Hint})`, "buy_M12", "primary")],
  ];
  rows.push([cb("⬅️ Назад", "back")]);
  return Markup.inlineKeyboard(rows);
}

/** Клавиатура для deep link ?start=plan_M1: выбран план — «Приобрести» и «В меню» */
function planSelectedMenu(planKey, pricingUser = null) {
  const plan = PLANS[planKey];
  if (!plan) return mainMenu(0);
   const price = getPlanPrice(planKey, pricingUser);
  const durHint =
    planKey === "M12" && hasActiveYearRenewalDiscount(pricingUser)
      ? "12 мес. −20%"
      : getPlanDurationHint(planKey);
  return Markup.inlineKeyboard([
    [cb(`🛒 Приобрести — ${ruMoney(price)} (${durHint})`, `buy_${planKey}`, "primary")],
    [cb("📋 Другие тарифы", "buy")],
    [cb("⬅️ В меню", "back")],
  ]);
}

function balanceMenu(balanceRub = 0, _pricingUser = null) {
  return Markup.inlineKeyboard([
    [cb(`💼 Баланс: ${ruMoney(balanceRub)}`, "balance_refresh")],
    [cb("➕ Пополнить", "balance_topup", "primary"), cb("🎁 Промокод", "promo")],
    [cb("⬅️ Назад", "back")],
  ]);
}


function topupMenu(requiredAmount = null, pricingUser = null) {
  const buttons = [];
  const amounts = getTopupAmountsForUser(pricingUser);

  // Если указана нужная сумма и её нет в стандартных - добавляем кнопку с нужной суммой
  if (requiredAmount && requiredAmount > 0 && !amounts.includes(requiredAmount)) {
    const extraHint = hintForTopupRubles(requiredAmount, amounts, pricingUser);
    const extraLabel = extraHint
      ? `💰 Пополнить на ${ruMoney(requiredAmount)} (${extraHint})`
      : `💰 Пополнить на ${ruMoney(requiredAmount)}`;
    buttons.push([cb(extraLabel, `topup_${requiredAmount}`, "primary")]);
  }

  amounts.forEach((amount, idx) => {
    const baseHint = TOPUP_DURATION_HINT[idx];
    const hint =
      idx === 4 && hasActiveYearRenewalDiscount(pricingUser) ? "12 мес. −20%" : baseHint;
    const label = hint ? `+ ${ruMoney(amount)} (${hint})` : `+ ${ruMoney(amount)}`;
    buttons.push([cb(label, `topup_${amount}`, "primary")]);
  });

  buttons.push([cb("⬅️ Назад", "back")]);

  return Markup.inlineKeyboard(buttons);
}

function paymentSuccessMenu() {
  return Markup.inlineKeyboard([
    [cb("🚀 Активировать VPN", "buy", "success"), cb("📖 Инструкции по настройке", "instructions", "primary")],
  ]);
}

module.exports = {
  cb,
  urlBtn,
  webAppBtn,
  PLANS,
  TOPUP_AMOUNTS,
  isDiscountActive,
  getDiscountBanner,
  getPlanPrice,
  hasActiveYearRenewalDiscount,
  getPersonalYearTopupRubles,
  PERSONAL_YEAR_RENEW_PERCENT,
  getTopupAmounts,
  getTopupAmountsForUser,
  getPlanDurationHint,
  ruMoney,
  formatDate,
  calcEndDate,
  calcEndDateFromDays,
  mainMenu,
  balanceMenu,
  buyMenu,
  topupMenu,
  planSelectedMenu,
  paymentSuccessMenu,
  getDisplayLabel,
  infoMenu,
  instructionsMenu,
  promoMenu,
};
