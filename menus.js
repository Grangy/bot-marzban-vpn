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

function getPlanPrice(planKey) {
  const plan = PLANS[planKey];
  if (!plan || !plan.price) return 0;
  if (!isDiscountActive()) return plan.price;
  const cfg = discount.getConfig();
  const raw = plan.price * (1 - cfg.percent / 100);
  return discount.roundTo5(raw);
}

function getTopupAmounts() {
  if (!isDiscountActive()) return TOPUP_AMOUNTS;
  const cfg = discount.getConfig();
  return TOPUP_AMOUNTS.map((a) => discount.roundTo5(a * (1 - cfg.percent / 100)));
}

const PLANS = {
  M1: {
    label: "1 месяц",
    price: 120,
    months: 1,
    type: "M1"
  },
  M3: {
    label: "3 месяца",
    price: 330,
    months: 3,
    type: "M3"
  },
  M6: {
    label: "6 месяцев",
    price: 570,
    months: 6,
    type: "M6"
  },
  M12: {
    label: "12 месяцев",
    price: 1140,
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
const TOPUP_AMOUNTS = [120, 330, 570, 1140];

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

function getDisplayLabel(sub) {
  if (sub.type === "FREE") return "Free";
  if (sub.type === "PROMO_10D") return "10 дней (промо)";

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


function buyMenu() {
  const p1 = getPlanPrice("M1");
  const p3 = getPlanPrice("M3");
  const p6 = getPlanPrice("M6");
  const p12 = getPlanPrice("M12");
  return Markup.inlineKeyboard([
    [cb(`${PLANS.M1.label} — ${ruMoney(p1)}`, "buy_M1", "primary")],
    [cb(`${PLANS.M3.label} — ${ruMoney(p3)}`, "buy_M3", "primary")],
    [cb(`${PLANS.M6.label} — ${ruMoney(p6)}`, "buy_M6", "primary")],
    [cb(`${PLANS.M12.label} — ${ruMoney(p12)}`, "buy_M12", "primary")],
    [cb("⬅️ Назад", "back")],
  ]);
}

/** Клавиатура для deep link ?start=plan_M1: выбран план — «Приобрести» и «В меню» */
function planSelectedMenu(planKey) {
  const plan = PLANS[planKey];
  if (!plan) return mainMenu(0);
  const price = getPlanPrice(planKey);
  return Markup.inlineKeyboard([
    [cb(`🛒 Приобрести — ${ruMoney(price)}`, `buy_${planKey}`, "primary")],
    [cb("📋 Другие тарифы", "buy")],
    [cb("⬅️ В меню", "back")],
  ]);
}

function balanceMenu(balanceRub = 0) {
  return Markup.inlineKeyboard([
    [cb(`💼 Баланс: ${ruMoney(balanceRub)}`, "balance_refresh")],
    [cb("➕ Пополнить", "balance_topup", "primary"), cb("🎁 Промокод", "promo")],
    [cb("⬅️ Назад", "back")],
  ]);
}


function topupMenu(requiredAmount = null) {
  const buttons = [];
  const amounts = getTopupAmounts();

  // Если указана нужная сумма и её нет в стандартных - добавляем кнопку с нужной суммой
  if (requiredAmount && requiredAmount > 0 && !amounts.includes(requiredAmount)) {
    buttons.push([cb(`💰 Пополнить на ${ruMoney(requiredAmount)}`, `topup_${requiredAmount}`, "primary")]);
  }

  amounts.forEach((amount) => {
    buttons.push([cb(`+ ${ruMoney(amount)}`, `topup_${amount}`, "primary")]);
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
  getTopupAmounts,
  ruMoney,
  formatDate,
  calcEndDate,
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
